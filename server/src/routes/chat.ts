/**
 * /api/chat/stream — Server-Sent-Events Endpoint für den Bo-Travel-Agent.
 *
 * Protokoll:
 *   - POST application/json mit { history: [{role, content}], locale, currency, today }
 *   - Response: text/event-stream mit folgenden Event-Typen (alle als plain
 *     `data: <json>` Frames, ein blank-line getrennt):
 *
 *     {"type":"mood","mood":"thinking|talking|happy|error|idle"}
 *     {"type":"text","delta":"Hallo"}            (Text-Chunk vom Modell)
 *     {"type":"tool_use","name":"find_location"}  (Tool wird ausgeführt)
 *     {"type":"search_result","result":{...}}     (Top-Trip nach search_journey)
 *     {"type":"usage","input":..., "output":..., "cacheRead":..., "cacheWrite":...}
 *     {"type":"error","message":"..."}
 *     {"type":"done"}                             (Turn fertig, Client schließt)
 *
 * Wir verwenden POST statt GET damit die History (kann mehrere KB sein)
 * im Body landet statt in der URL. SSE braucht eigentlich kein GET — das ist
 * eine Konvention, kein Spec-Zwang. Fetch+ReadableStream auf Client-Seite
 * funktioniert genauso mit POST.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  isChatAvailable,
  runChatTurn,
  type ChatEvent,
  type ChatMessage,
} from "../services/chatAgent.js";
import { requireUser } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";

/** Pro Konto: 30 Bo-Turns pro Stunde. Großzügig für echte Unterhaltungen
 *  (jede Nachricht = 1 Turn), stoppt aber Token-Abuse über ein Konto. */
const CHAT_TURNS_PER_HOUR = 30;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(10_000),
});

const lastSearchSchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  originLabel: z.string().min(1),
  destLabel: z.string().min(1),
  mode: z.enum(["FLIGHT", "TRAIN", "BUS", "CRUISE"]),
  departDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  passengers: z.number().int().min(1).max(9),
  currency: z.string().min(3).max(3),
});

const bodySchema = z.object({
  // Cap: 30 Turns Verlauf reicht für sehr lange Conversations. Limitiert auch
  // den Token-Verbrauch falls ein Client ungebremst History anhäuft.
  history: z.array(messageSchema).min(1).max(60),
  locale: z.enum(["en", "de", "fr", "es"]).default("de"),
  currency: z.string().min(3).max(3).default("EUR"),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "today must be yyyy-MM-dd"),
  /** Optional: letzte Such-Params aus einem früheren Turn. Client trackt das
   *  und sendet's zurück damit Tools wie open_all_results über Turns hinweg
   *  funktionieren. */
  lastSearch: lastSearchSchema.optional(),
});

function writeSse(reply: FastifyReply, event: ChatEvent): void {
  // `as { raw: ... }`-Path benutzt das rohe Node-Response-Objekt — Fastify's
  // High-Level-Reply-API würde sonst versuchen JSON-Headers zu setzen.
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

export async function chatRoutes(app: FastifyInstance) {
  app.post("/api/chat/stream", async (req, reply) => {
    if (!isChatAvailable()) {
      return reply
        .code(503)
        .send({ error: "Chat unavailable — ANTHROPIC_API_KEY not configured" });
    }

    // Bo ist kontogebunden: jeder Turn kostet echte Claude-Tokens. Ohne
    // Session → 401, der Client öffnet dann den Login-Screen. Das Budget
    // hängt am User-Konto (nicht an der IP) — Gerätewechsel/geteiltes WLAN
    // ändern nichts am Limit.
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const rl = rateLimit("chat", user.id, CHAT_TURNS_PER_HOUR, 60 * 60 * 1000);
    if (!rl.allowed) {
      return reply
        .code(429)
        .header("Retry-After", rl.retryAfterSec)
        .send({ error: "Rate limit reached", retryAfterSec: rl.retryAfterSec });
    }

    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }

    // hijack() MUSS vor den raw-Writes laufen — sonst hält Fastify die Response
    // zurück und der Client sieht den Stream erst nach dem ersten Flush (oder
    // gar nicht, weil der Body-Timeout vorher zuschlägt).
    reply.hijack();

    // Nagle's Algorithm aus: ohne das coalesced der TCP-Stack kleine SSE-Frames
    // (z.B. mood-Events ohne Text) und hält sie zurück bis ein größerer Write
    // kommt — der Client sieht dann minutenlang nichts. Mit setNoDelay(true)
    // wird jeder raw.write sofort gesendet.
    req.socket.setNoDelay(true);
    // Socket-Timeout deaktivieren — der Stream kann mehrere Minuten laufen
    // (Multi-Tool-Cycles, lange Antworten), default ist 0 aber wir setzen es
    // explizit für den Fall dass irgendwer einen Reverse-Proxy davorhängt.
    reply.raw.socket?.setTimeout(0);

    // SSE-Headers manuell schreiben. Fastify's reply.send() würde den Stream
    // nach dem ersten write() schließen, das wollen wir hier nicht.
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // X-Accel-Buffering: no — falls hinter Nginx → kein Buffer, sofort flush.
      "X-Accel-Buffering": "no",
    });
    // Node-http hält Headers zurück bis genug Body gepuffert wurde (Nagle).
    // flushHeaders() schiebt sie sofort raus → Client weiß die Connection ist
    // offen und akzeptiert SSE statt auf den Body-Timeout zu rennen.
    reply.raw.flushHeaders();
    // Initial-Heartbeat damit der Client das Body-Streaming sofort sieht und
    // nicht auf das erste echte Event warten muss (Claude-Latency ~500ms).
    reply.raw.write(": connected\n\n");

    // Heartbeat alle 15s — verhindert dass Proxies eine Idle-Connection
    // killen. Comment-Lines werden vom EventSource-Protokoll ignoriert.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": keepalive\n\n");
      } catch {
        /* Connection closed — wird unten via 'close'-Listener aufgeräumt. */
      }
    }, 15_000);

    // ‼️ Wichtig: `req.raw.on("close")` feuert wenn der POST-Body fertig
    // empfangen ist — NICHT wenn der Client die TCP-Connection schließt. Für
    // SSE wollen wir die echte Disconnect-Erkennung über reply.raw, dessen
    // close-Event nur bei TCP-Close fired.
    let clientGone = false;
    reply.raw.on("close", () => {
      clientGone = true;
      clearInterval(heartbeat);
    });

    const history: ChatMessage[] = parsed.data.history;
    const ip = req.ip;

    try {
      await runChatTurn(
        {
          history,
          locale: parsed.data.locale,
          currency: parsed.data.currency,
          today: parsed.data.today,
          lastSearch: parsed.data.lastSearch,
        },
        { ip },
        (event) => {
          if (clientGone) return;
          writeSse(reply, event);
        },
      );
    } catch (err) {
      // Defensive — runChatTurn fängt schon alles, aber falls doch was leakt:
      if (!clientGone) {
        const message = err instanceof Error ? err.message : String(err);
        writeSse(reply, { type: "error", message });
        writeSse(reply, { type: "done" });
      }
    } finally {
      clearInterval(heartbeat);
      if (!clientGone) {
        reply.raw.end();
      }
    }
  });
}
