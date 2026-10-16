/**
 * /api/chat/* — Bo-Travel-Agent: der SSE-Turn plus der serverseitige Verlauf.
 *
 * Protokoll von /api/chat/stream:
 *   - POST application/json mit { history: [{role, content}], locale, currency,
 *     today, conversationId? }
 *   - Response: text/event-stream mit folgenden Event-Typen (alle als plain
 *     `data: <json>` Frames, ein blank-line getrennt):
 *
 *     {"type":"conversation","id":"<uuid>"}      (IMMER zuerst, s.u.)
 *     {"type":"mood","mood":"thinking|talking|happy|error|idle"}
 *     {"type":"text","delta":"Hallo"}            (Text-Chunk vom Modell)
 *     {"type":"tool_use","name":"search_journey"}  (Tool wird ausgeführt)
 *     {"type":"search_result","result":{...}}     (Top-Trip nach search_journey)
 *     {"type":"usage","input":..., "output":..., "cacheRead":..., "cacheWrite":...}
 *     {"type":"error","message":"..."}
 *     {"type":"done"}                             (Turn fertig, Client schließt)
 *
 * Wir verwenden POST statt GET damit die History (kann mehrere KB sein)
 * im Body landet statt in der URL. SSE braucht eigentlich kein GET — das ist
 * eine Konvention, kein Spec-Zwang. Fetch+ReadableStream auf Client-Seite
 * funktioniert genauso mit POST.
 *
 * VERLAUF (chat_conversations / chat_messages): Der Server schreibt jeden Turn
 * mit, damit ein Gerätewechsel oder ein geleerter App-Speicher die Gespräche
 * nicht mehr mitnimmt. Additiv gebaut: Ein Client, der weder `conversationId`
 * schickt noch das `conversation`-Event kennt, merkt davon nichts — er bekommt
 * exakt den Stream von vorher, und im Hintergrund entsteht pro Turn eine neue
 * Unterhaltung. Die Historie schickt weiterhin der CLIENT im Body; der Server
 * liest sie nicht aus der DB (der Agent bleibt für den Turn selbst stateless).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import {
  isChatAvailable,
  runChatTurn,
  type ChatEvent,
  type ChatMessage,
} from "../services/chatAgent.js";
import { db } from "../db/client.js";
import {
  chatConversations,
  chatMessages,
  type ChatMessageKind,
  type ChatMessageRole,
} from "../db/schema.js";
import { requireUser, type SessionUser } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";

/** Pro Konto: 30 Bo-Turns pro Stunde. Großzügig für echte Unterhaltungen
 *  (jede Nachricht = 1 Turn), stoppt aber Token-Abuse über ein Konto. */
const CHAT_TURNS_PER_HOUR = 30;

/** Titel und Vorschau sind reine Anzeige-Felder — die Längen spiegeln die
 *  varchar-Grenzen im Schema. Wer hier hochgeht, muss dort mit. */
const TITLE_MAX_CHARS = 120;
const PREVIEW_MAX_CHARS = 200;

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
  /** Optional: in welche Unterhaltung dieser Turn gehört. Fehlt sie, legen
   *  wir eine neue an und nennen ihre ID im ersten SSE-Event. */
  conversationId: z.string().uuid().optional(),
});

const idParamsSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Opaker Keyset-Cursor aus einer vorherigen Antwort (siehe encodeCursor). */
  cursor: z.string().min(1).max(256).optional(),
  /**
   * `1` liefert AUSSCHLIESSLICH die archivierten. Ohne den Schalter kommen
   * ausschließlich die nicht archivierten — Archivieren soll aus der Liste
   * verschwinden lassen, nicht bloß nach unten schieben.
   */
  archived: z.coerce.number().int().min(0).max(1).default(0),
});

const messagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Seq-Grenze für „ältere laden": liefert die Nachrichten VOR dieser Nummer. */
  before: z.coerce.number().int().min(1).optional(),
});

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(TITLE_MAX_CHARS).optional(),
});

/**
 * Alle drei Felder optional, aber mindestens eines verlangt.
 *
 * Ein leerer Rumpf wäre sonst ein erfolgreiches PATCH, das nichts tut — und
 * genau das versteckt Tippfehler im Feldnamen auf der Client-Seite.
 */
const patchConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(TITLE_MAX_CHARS).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.pinned !== undefined || v.archived !== undefined,
    { message: "Nothing to update" },
  );

/** Neben den Agent-Events schickt die Route ein eigenes: die ID der
 *  Unterhaltung. Es steht bewusst NICHT in ChatEvent — der Agent kennt keine
 *  Unterhaltungen, das ist Transport-/Persistenz-Sache dieser Datei. */
type StreamEvent = ChatEvent | { type: "conversation"; id: string };

function writeSse(reply: FastifyReply, event: StreamEvent): void {
  // `as { raw: ... }`-Path benutzt das rohe Node-Response-Objekt — Fastify's
  // High-Level-Reply-API würde sonst versuchen JSON-Headers zu setzen.
  reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---------------------------------------------------------------------------
// Verlauf: Hilfsfunktionen
// ---------------------------------------------------------------------------

/** Transaktions-Handle von drizzle. Es gibt dafür keinen exportierten Typ,
 *  also leiten wir ihn aus der Signatur ab. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ConversationRow = typeof chatConversations.$inferSelect;

interface PendingMessage {
  role: ChatMessageRole;
  kind: ChatMessageKind;
  content: string | null;
  payload: Record<string, unknown> | null;
}

/** Titel aus der ersten Nutzer-Nachricht: an der Wortgrenze gekürzt, nicht
 *  mitten im Wort. Leerer Rest → null, dann zeigt der Client seinen eigenen
 *  Platzhalter statt einer leeren Zeile. */
function deriveTitle(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length === 0) return null;
  if (text.length <= TITLE_MAX_CHARS) return text;
  const window = text.slice(0, TITLE_MAX_CHARS + 1);
  const lastSpace = window.lastIndexOf(" ");
  // Ein einziges überlanges Wort hat keine Wortgrenze — dann hart schneiden,
  // sonst käme ein leerer Titel raus.
  const cut = lastSpace > 0 ? window.slice(0, lastSpace) : text.slice(0, TITLE_MAX_CHARS);
  return cut.trimEnd() || null;
}

/** Vorschauzeile für die Liste: eine Zeile, hart auf die Spaltenbreite. */
function toPreview(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  return text.length === 0 ? null : text.slice(0, PREVIEW_MAX_CHARS);
}

/**
 * Keyset-Cursor: `<lastMessageAt ISO>|<id>`, base64url. Base64url statt base64,
 * weil das Ding als Query-Param zurückkommt und `+`/`/`/`=` dort nur Ärger
 * machen. Opak für den Client — Inhalt und Format sind Server-Sache.
 */
/**
 * Der Cursor trägt den vollständigen SORTIERSCHLÜSSEL, nicht bloß den Zeitpunkt.
 *
 * Seit angeheftete Unterhaltungen vorgezogen werden, ist die Ordnung
 * dreiteilig: erst „angeheftet ja/nein", dann der maßgebliche Zeitpunkt (bei
 * angehefteten der des Anheftens, sonst der der letzten Nachricht), dann die
 * Kennung als Gleichstand-Entscheider. Ein Cursor über nur zwei Teile wäre an
 * der Grenze zwischen angehefteten und normalen Zeilen mehrdeutig — dort würde
 * die zweite Seite Zeilen überspringen oder wiederholen.
 *
 * Genau dieselben drei Ausdrücke stehen in `ORDER BY` und in der
 * Keyset-Bedingung. Wer einen davon ändert, muss alle drei ändern.
 */
function sortKey(row: { id: string; lastMessageAt: Date; pinnedAt: Date | null }) {
  return {
    pinned: row.pinnedAt !== null,
    at: row.pinnedAt ?? row.lastMessageAt,
    id: row.id,
  };
}

function encodeCursor(row: { id: string; lastMessageAt: Date; pinnedAt: Date | null }): string {
  const k = sortKey(row);
  return Buffer.from(`${k.pinned ? "1" : "0"}|${k.at.toISOString()}|${k.id}`, "utf8").toString(
    "base64url",
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodeCursor(raw: string): { pinned: boolean; at: Date; id: string } | null {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  if (parts.length !== 3) return null;
  const [pinned, iso, id] = parts;
  if (!iso || !id || !UUID_RE.test(id)) return null;
  if (pinned !== "0" && pinned !== "1") return null;
  const at = new Date(iso);
  // Ungültige ID/Zeit hier abfangen, nicht erst in Postgres: ein kaputter
  // Cursor soll 400 geben, kein 500 aus dem uuid-Cast.
  if (Number.isNaN(at.getTime())) return null;
  return { pinned: pinned === "1", at, id };
}

/**
 * Was von einem Treffer im Verlauf stehen bleibt.
 *
 * Eine ERLAUBNIS-Liste, keine Verbotsliste — das ist der Punkt: Kommt beim
 * nächsten Provider ein Feld dazu, wächst eine Verbotsliste stillschweigend
 * wieder mit, eine Erlaubnis-Liste nicht.
 *
 * Es sind genau die Felder, die `components/results/ResultCard.tsx` liest,
 * plus die kleinen Zusatzangaben derselben Karte. Weggelassen wird `legs` —
 * die Bein-für-Bein-Aufschlüsselung einer mehrteiligen Reise mit allen
 * Zwischenhalten. Sie ist das mit Abstand schwerste Feld eines Treffers, und
 * im Chat rendert niemand sie: Die Karte dort hat kein Antippen und öffnet
 * keine Detailansicht (AssistantScreen rendert `<ResultCard result={...} />`
 * ohne Handler). Gespart wird das doppelt — auf der Platte UND im Mobilfunk,
 * wenn eine Unterhaltung wieder geöffnet wird.
 *
 * `deepLink` fehlt bewusst: Der ist server-seitig und wird ohnehin durch
 * `redirectToken` ersetzt, bevor etwas den Server verlässt.
 */
const RESULT_KEEP = [
  "id",
  "mode",
  "direction",
  "provider",
  "providerLogo",
  "origin",
  "destination",
  "originLabel",
  "destLabel",
  "departTime",
  "arriveTime",
  "departDelayMinutes",
  "arriveDelayMinutes",
  "originTz",
  "destinationTz",
  "dateOnly",
  "durationMinutes",
  "stops",
  "stopLabels",
  "price",
  "currency",
  "redirectToken",
  "bookingToken",
  "isRefundable",
  "baggageIncluded",
  "flightNumber",
  "operatedBy",
  // Gefährdet/fällt aus — ohne legs wäre sie aus dem Rest nicht mehr ableitbar.
  "warning",
] as const;

function slimResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const src = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RESULT_KEEP) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

function toConversationDto(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    locale: row.locale,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    messageCount: row.messageCount,
    lastSearch: row.lastSearch ?? null,
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Hängt Nachrichten ans Ende einer Unterhaltung und zieht die denormalisierten
 * Listen-Spalten nach.
 *
 * Die `seq`-Vergabe passiert IN der Transaktion aus MAX(seq)+1 — nie aus einem
 * vorher gelesenen Wert. Davor wird die Unterhaltungs-Zeile per FOR UPDATE
 * gesperrt: Zwei gleichzeitige Turns derselben Unterhaltung (zweites Gerät,
 * Doppel-Tap) läsen sonst beide dasselbe Maximum, und der eindeutige Index
 * (conversation_id, seq) ließe einen von beiden auflaufen. Mit der Sperre
 * warten sie hintereinander.
 *
 * `messageCount` wird neu gezählt statt hochgezählt: Bricht ein Turn zwischen
 * Nutzer-Nachricht und Antwort ab, heilt der nächste Schreibvorgang den Zähler
 * von selbst. Die Zählung läuft über den Index (conversation_id, seq) und
 * betrifft nur die Zeilen dieser einen Unterhaltung.
 */
async function appendMessages(
  conversationId: string,
  rows: PendingMessage[],
  patch: { preview?: string | null; lastSearch?: Record<string, unknown> } = {},
): Promise<void> {
  if (rows.length === 0 && patch.preview === undefined && patch.lastSearch === undefined) return;

  await db.transaction(async (tx: Tx) => {
    await tx
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .for("update");

    const [stats] = await tx
      .select({
        nextSeq: sql<number>`coalesce(max(${chatMessages.seq}), 0) + 1`,
        total: sql<number>`count(*)::int`,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId));

    const firstSeq = stats?.nextSeq ?? 1;
    const total = (stats?.total ?? 0) + rows.length;

    if (rows.length > 0) {
      await tx.insert(chatMessages).values(
        rows.map((row, i) => ({
          conversationId,
          role: row.role,
          kind: row.kind,
          content: row.content,
          payload: row.payload,
          seq: firstSeq + i,
        })),
      );
    }

    const now = new Date();
    await tx
      .update(chatConversations)
      .set({
        lastMessageAt: now,
        updatedAt: now,
        messageCount: total,
        // undefined lässt drizzle die Spalte in Ruhe — null würde sie leeren.
        ...(patch.preview !== undefined ? { lastMessagePreview: patch.preview } : {}),
        ...(patch.lastSearch !== undefined ? { lastSearch: patch.lastSearch } : {}),
      })
      .where(eq(chatConversations.id, conversationId));
  });
}

export async function chatRoutes(app: FastifyInstance) {
  /**
   * Lädt eine Unterhaltung des angemeldeten Nutzers — oder beantwortet den
   * Request selbst und gibt null zurück.
   *
   * Bewusst ein lokaler Helfer und KEIN Fastify-Hook / kein decorateRequest:
   * dieselbe Instanz trägt die anonymen Routen (search, locations, stops,
   * surroundings, trips), die würden von einem globalen Hook mit in den
   * Auth-Pfad gezogen.
   *
   * Eigentum und Existenz werden in EINER Query geprüft (`id = ? AND
   * user_id = ?`), und eine fremde ID bekommt dieselbe 404 wie eine
   * ausgedachte. Ein 403 wäre ein Existenz-Orakel: Wer IDs durchprobiert,
   * könnte an der Antwort ablesen, welche es gibt.
   *
   * `known`: Wer die Session schon aufgelöst hat (der Stream-Handler braucht
   * sie fürs Rate-Limit), reicht sie durch und spart den zweiten Lookup.
   */
  async function loadOwnedConversation(
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    known?: SessionUser,
  ): Promise<ConversationRow | null> {
    const user = known ?? (await requireUser(req));
    if (!user) {
      reply.code(401).send({ error: "Login required" });
      return null;
    }
    const [row] = await db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.id, id), eq(chatConversations.userId, user.id)))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: "Conversation not found" });
      return null;
    }
    return row;
  }

  /**
   * Liste der Unterhaltungen, neueste zuerst.
   *
   * Keyset statt OFFSET: Der Cursor trägt (last_message_at, id) der letzten
   * gelieferten Zeile, die Folgeseite fragt strikt danach. Das bleibt auch bei
   * Seite 40 ein Index-Zugriff — und es überspringt keine Zeile, wenn zwischen
   * zwei Seitenabrufen eine Unterhaltung nach oben rutscht (genau das passiert
   * hier ständig, die Sortierung ist ja die Aktivität).
   *
   * chat_messages wird NICHT angefasst und weder content noch payload
   * selektiert — die Liste soll billig bleiben.
   */
  app.get("/api/chat/conversations", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const { limit } = parsed.data;
    const wantArchived = parsed.data.archived === 1;
    let cursor: { pinned: boolean; at: Date; id: string } | null = null;
    if (parsed.data.cursor) {
      cursor = decodeCursor(parsed.data.cursor);
      if (!cursor) {
        return reply.code(400).send({ error: "Bad cursor" });
      }
    }

    /**
     * Der Sortierschlüssel als SQL — einmal geschrieben, dreimal gebraucht
     * (Sortierung, Keyset-Bedingung, und beim Bauen des nächsten Cursors,
     * dort über `encodeCursor`). Genau deshalb steht er hier als Konstante:
     * Laufen die Ausdrücke auseinander, blättert die Liste falsch, ohne dass
     * irgendwo ein Fehler entsteht.
     */
    const isPinned = sql`(${chatConversations.pinnedAt} is not null)`;
    const sortAt = sql`coalesce(${chatConversations.pinnedAt}, ${chatConversations.lastMessageAt})`;

    const scope = and(
      eq(chatConversations.userId, user.id),
      wantArchived
        ? sql`${chatConversations.archivedAt} is not null`
        : sql`${chatConversations.archivedAt} is null`,
    );

    const rows = await db
      .select({
        id: chatConversations.id,
        title: chatConversations.title,
        lastMessagePreview: chatConversations.lastMessagePreview,
        lastMessageAt: chatConversations.lastMessageAt,
        messageCount: chatConversations.messageCount,
        pinnedAt: chatConversations.pinnedAt,
        archivedAt: chatConversations.archivedAt,
      })
      .from(chatConversations)
      .where(
        cursor
          ? and(
              scope,
              // Zeilen-Vergleich statt dreier OR-Zweige: `(a, b, c) < (x, y, z)`
              // ist genau die Ordnung, nach der auch sortiert wird. `false`
              // sortiert in Postgres vor `true`, absteigend steht „angeheftet"
              // damit oben.
              sql`(${isPinned}, ${sortAt}, ${chatConversations.id}) < (${cursor.pinned}::boolean, ${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
            )
          : scope,
      )
      // id als letzter Entscheider: Zwei Unterhaltungen können dieselbe
      // Millisekunde tragen, und ohne stabile Spalte wäre der Cursor mehrdeutig.
      .orderBy(sql`${isPinned} desc`, sql`${sortAt} desc`, desc(chatConversations.id))
      // Eine Zeile mehr als angefragt — nur um zu wissen, ob es weitergeht.
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        title: row.title,
        lastMessagePreview: row.lastMessagePreview,
        lastMessageAt: row.lastMessageAt.toISOString(),
        messageCount: row.messageCount,
        pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
        archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
    };
  });

  /**
   * Eine Unterhaltung mit ihren Nachrichten. Geblättert wird rückwärts: Die
   * jüngsten zuerst holen (`seq < before`, DESC, LIMIT n), zurückgegeben wird
   * aufsteigend — so wie der Client rendert.
   */
  app.get<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Bad request", issues: params.error.flatten() });
    }
    const query = messagesQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Bad request", issues: query.error.flatten() });
    }
    const conversation = await loadOwnedConversation(req, reply, params.data.id);
    if (!conversation) return reply;

    const { limit, before } = query.data;
    const rows = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        kind: chatMessages.kind,
        content: chatMessages.content,
        payload: chatMessages.payload,
        seq: chatMessages.seq,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        before === undefined
          ? eq(chatMessages.conversationId, conversation.id)
          : and(eq(chatMessages.conversationId, conversation.id), lt(chatMessages.seq, before)),
      )
      .orderBy(desc(chatMessages.seq))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return {
      conversation: toConversationDto(conversation),
      messages: page.map((row) => ({
        id: row.id,
        role: row.role,
        kind: row.kind,
        content: row.content,
        payload: row.payload ?? null,
        seq: row.seq,
        createdAt: row.createdAt.toISOString(),
      })),
      hasMore,
    };
  });

  /** Leere Unterhaltung anlegen. Braucht der Client nur, wenn er einen
   *  „Neuer Chat"-Eintrag vor der ersten Nachricht sehen will — der
   *  Stream-Endpoint legt sich seine Unterhaltung sonst selbst an. */
  app.post("/api/chat/conversations", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const parsed = createConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const [created] = await db
      .insert(chatConversations)
      .values({ userId: user.id, title: parsed.data.title ?? null })
      .returning();
    // `returning()` ist typseitig ein Array — nach einem insert mit genau
    // einem Wert kann es nicht leer sein, TypeScript weiß das nur nicht.
    if (!created) throw new Error("Unterhaltung konnte nicht angelegt werden");
    return { conversation: toConversationDto(created) };
  });

  /** Umbenennen. Ein Trigger für updated_at existiert nicht — die Spalte wird
   *  hier von Hand gesetzt. */
  app.patch<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Bad request", issues: params.error.flatten() });
    }
    const parsed = patchConversationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const now = new Date();
    const patch: Partial<typeof chatConversations.$inferInsert> = { updatedAt: now };
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    // Anheften/Archivieren setzen den Zeitpunkt, Lösen setzt ihn auf NULL —
    // deshalb `undefined` (nicht anfassen) und `null` (löschen) auseinander-
    // halten und nur die Felder schreiben, die im Rumpf standen.
    if (parsed.data.pinned !== undefined) patch.pinnedAt = parsed.data.pinned ? now : null;
    if (parsed.data.archived !== undefined) patch.archivedAt = parsed.data.archived ? now : null;
    // Eigentum steckt in der WHERE-Bedingung, nicht in einem Vorab-Lesen:
    // ein Statement, und fremde IDs sehen aus wie nicht existierende.
    const [updated] = await db
      .update(chatConversations)
      .set(patch)
      .where(
        and(eq(chatConversations.id, params.data.id), eq(chatConversations.userId, user.id)),
      )
      .returning();
    if (!updated) {
      return reply.code(404).send({ error: "Conversation not found" });
    }
    return { conversation: toConversationDto(updated) };
  });

  /** Löschen. Die Nachrichten nimmt der Fremdschlüssel (ON DELETE cascade) mit. */
  app.delete<{ Params: { id: string } }>("/api/chat/conversations/:id", async (req, reply) => {
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const params = idParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Bad request", issues: params.error.flatten() });
    }
    const [deleted] = await db
      .delete(chatConversations)
      .where(
        and(eq(chatConversations.id, params.data.id), eq(chatConversations.userId, user.id)),
      )
      .returning({ id: chatConversations.id });
    if (!deleted) {
      return reply.code(404).send({ error: "Conversation not found" });
    }
    return reply.code(204).send();
  });

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

    const history: ChatMessage[] = parsed.data.history;
    // Die NEUE Nachricht ist das letzte Element — alles davor steht schon in
    // der DB. Der Client schickt weiterhin den ganzen Verlauf mit (der Agent
    // braucht ihn), gespeichert wird davon aber genau diese eine Zeile.
    const lastTurn = history[history.length - 1];
    const userText = lastTurn?.role === "user" ? lastTurn.content : null;

    // Unterhaltung auflösen, solange noch ein sauberer HTTP-Status möglich
    // ist: Nach reply.hijack() gäbe es für eine fremde ID keine 404 mehr,
    // nur noch einen abgebrochenen Stream.
    let conversation: ConversationRow;
    if (parsed.data.conversationId) {
      const owned = await loadOwnedConversation(req, reply, parsed.data.conversationId, user);
      if (!owned) return reply;
      conversation = owned;
    } else {
      const [created] = await db
        .insert(chatConversations)
        .values({
          userId: user.id,
          title: userText ? deriveTitle(userText) : null,
          locale: parsed.data.locale,
        })
        .returning();
      if (!created) throw new Error("Unterhaltung konnte nicht angelegt werden");
      conversation = created;
    }

    if (userText) {
      // Vor dem Stream, nicht danach: Bricht der Turn ab (Modell-Fehler,
      // Neustart, Netz), steht die Frage trotzdem im Verlauf — und die
      // Antwort bekommt dadurch automatisch die höhere seq.
      //
      // Fehler hier dürfen den Chat NICHT verhindern: Bo lief bisher ganz
      // ohne Verlauf, und ein Schreibfehler soll daraus keinen 500 machen.
      await appendMessages(conversation.id, [
        { role: "user", kind: "text", content: userText, payload: null },
      ]).catch((err) => {
        req.log.error(
          { err, conversationId: conversation.id },
          "Nutzer-Nachricht konnte nicht gespeichert werden",
        );
      });
    } else {
      req.log.warn(
        { conversationId: conversation.id, role: lastTurn?.role },
        "Chat-Turn ohne abschließende Nutzer-Nachricht — nichts gespeichert",
      );
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

    // Erstes echtes Event: die ID der Unterhaltung. Muss vor allem anderen
    // raus, weil der Client sie bei einer neu angelegten Unterhaltung sonst
    // nirgends her bekommt — und sie ab dem nächsten Turn mitschicken soll.
    writeSse(reply, { type: "conversation", id: conversation.id });

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

    const ip = req.ip;

    // Mitschrift dieses Turns. Text sammeln wir in einem Puffer statt pro
    // Token zu schreiben; die Anhänge (Treffer, Tafel, Aktion) merken wir uns
    // in der Reihenfolge ihres Eintreffens.
    let assistantText = "";
    const attachments: PendingMessage[] = [];
    let lastSearch: Record<string, unknown> | undefined;

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
          // Mitgeschrieben wird IMMER, auch wenn der Client schon weg ist —
          // sonst fehlte im Verlauf ausgerechnet die Antwort, die der Nutzer
          // nicht mehr gesehen hat.
          switch (event.type) {
            case "text":
              assistantText += event.delta;
              break;
            case "search_result":
              attachments.push({
                role: "assistant",
                kind: "result",
                content: null,
                payload: {
                  result: slimResult(event.result),
                  params: event.params,
                  isMain: event.isMain,
                },
              });
              // `isMain` fehlt bei der einfachen Suche und heißt dort trotzdem
              // „das ist der Treffer"; nur ein explizites false ist ein
              // Neben-Bein einer mehrteiligen Reise. Der Client wertet es
              // genauso aus (AssistantScreen: `event.isMain !== false`).
              if (event.isMain !== false) lastSearch = { ...event.params };
              break;
            case "stop_board":
              attachments.push({
                role: "assistant",
                kind: "board",
                content: null,
                payload: { stop: event.stop, board: event.board },
              });
              break;
            case "action":
              attachments.push({
                role: "assistant",
                kind: "action",
                content: null,
                payload: { action: event.action, payload: event.payload },
              });
              break;
            case "usage":
              // Je API-Aufruf eine Zeile: Damit lassen sich Bos echte Kosten
              // (Modell, Cache-Treffer, Länge) aus dem Log nachrechnen, statt
              // sie zu schätzen. Der Client bekommt das Ereignis ohnehin.
              req.log.info(
                {
                  boUsage: {
                    model: event.model,
                    input: event.input,
                    output: event.output,
                    cacheRead: event.cacheRead,
                    cacheWrite: event.cacheWrite,
                    ...(event.trimmed ? { trimmed: event.trimmed } : {}),
                  },
                },
                "bo usage",
              );
              break;
            default:
              break;
          }
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

    // Erst jetzt schreiben: ein Vorgang pro Turn statt einem pro Token, und
    // die DB-Latenz liegt hinter dem letzten Byte statt mitten im Stream.
    //
    // Reihenfolge ist nicht kosmetisch: Der Client rendert Karten und
    // Aktions-Knöpfe als eigene Nachrichten NACH dem Text. Eine falsche seq
    // ließe beim Wiederöffnen den Knopf über den Treffern stehen.
    const answer = assistantText.trim();
    const rows: PendingMessage[] = [];
    if (answer) {
      rows.push({ role: "assistant", kind: "text", content: answer, payload: null });
    }
    rows.push(...attachments);

    // Eigenes .catch: Nach reply.hijack() fängt Fastifys Fehlerpfad nichts
    // mehr ab — eine unbehandelte Ablehnung risse den Prozess-Handler mit.
    await appendMessages(conversation.id, rows, {
      preview: answer ? toPreview(answer) : undefined,
      lastSearch,
    }).catch((err) => {
      req.log.error(
        { err, conversationId: conversation.id },
        "Chat-Antwort konnte nicht gespeichert werden",
      );
    });
  });

  /**
   * Aufräumen — sonst wächst der Verlauf monoton.
   *
   * Nichts an einem Chat läuft je ab: Jede Antwort legt Zeilen nach, die
   * Treffer-Nutzlasten sind mehrere Kilobyte, und niemand löscht. Nach dem
   * Muster der abgelaufenen Sitzungen in `auth.ts` läuft die Bereinigung
   * deshalb einmal beim Start und danach täglich.
   *
   * ANGEHEFTETE Unterhaltungen sind von beiden Regeln ausgenommen — Anheften
   * ist genau die Ansage „die will ich behalten". Ohne diese Ausnahme wäre der
   * Knopf eine Falle.
   */
  await pruneConversations(app).catch((err) =>
    app.log.error({ err }, "Chat-Aufräumen beim Start fehlgeschlagen"),
  );
  const timer = setInterval(
    () => void pruneConversations(app).catch((err) =>
      app.log.error({ err }, "Chat-Aufräumen fehlgeschlagen"),
    ),
    PRUNE_INTERVAL_MS,
  );
  // `unref`, damit der Zeitgeber das Herunterfahren nicht aufhält.
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}

/** Wie lange eine unangeheftete Unterhaltung ohne neue Nachricht überlebt. */
const RETENTION_MONTHS = 6;
/** Und wie viele unangeheftete ein Konto höchstens behält. */
const MAX_CONVERSATIONS_PER_USER = 200;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function pruneConversations(app: FastifyInstance): Promise<void> {
  // Die Nachrichten nimmt der Fremdschlüssel (ON DELETE cascade) jeweils mit.
  const stale = await db.execute(sql`
    delete from chat_conversations
    where pinned_at is null
      and last_message_at < now() - ${sql.raw(`interval '${RETENTION_MONTHS} months'`)}
  `);
  /**
   * Der Deckel je Konto in EINEM Statement.
   *
   * Die Fensterfunktion nummeriert die unangehefteten Unterhaltungen pro
   * Nutzer nach Aktualität durch; alles jenseits des Deckels fällt weg. Pro
   * Nutzer einzeln zu zählen wäre eine Abfrage je Konto — bei wachsender
   * Nutzerzahl genau die Art Aufräum-Job, die selbst zum Problem wird.
   */
  const capped = await db.execute(sql`
    delete from chat_conversations c
    using (
      select id, row_number() over (
        partition by user_id order by last_message_at desc, id desc
      ) as rn
      from chat_conversations
      where pinned_at is null
    ) ranked
    where c.id = ranked.id and ranked.rn > ${MAX_CONVERSATIONS_PER_USER}
  `);
  const removed = (stale.rowCount ?? 0) + (capped.rowCount ?? 0);
  if (removed > 0) {
    app.log.info(
      { stale: stale.rowCount ?? 0, capped: capped.rowCount ?? 0 },
      "Chat-Unterhaltungen aufgeräumt",
    );
  }
}
