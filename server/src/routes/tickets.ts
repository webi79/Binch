import type { FastifyInstance } from "fastify";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderPdf } from "../services/pdfRender.js";
import { parseTicketText, type ParsedTicket } from "../services/ticketParser.js";
import {
  parseTicketWithAi,
  isAiTicketParserAvailable,
  detectCodeRegion,
} from "../services/ticketAiParser.js";
import { requireUser } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

/** Pro Konto: 20 Ticket-Parses pro Tag. Jeder Parse rendert ein PDF und
 *  feuert zwei Claude-Vision/Text-Calls — mehr als ~5/Tag braucht kein
 *  echter User, 20 lässt Luft für Fehlversuche. */
const PARSES_PER_DAY = 20;

/**
 * Croppt eine Bounding-Box (% Werte) aus dem Page-Image und gibt das Ergebnis
 * als data-URL PNG zurück. Pixel-genau — wir re-encoden NICHT (gleiche
 * schwarze/weiße Pixel die im Original-PDF stehen). Damit bleibt der QR/
 * Barcode scanbar.
 */
async function cropImageRegion(
  pageImageBase64: string,
  xPct: number,
  yPct: number,
  widthPct: number,
  heightPct: number,
): Promise<string | null> {
  try {
    const raw = pageImageBase64.replace(/^data:image\/[^;]+;base64,/, "");
    const img = await loadImage(Buffer.from(raw, "base64"));
    const fullW = img.width;
    const fullH = img.height;
    const sx = Math.max(0, Math.floor((fullW * xPct) / 100));
    const sy = Math.max(0, Math.floor((fullH * yPct) / 100));
    const sw = Math.min(fullW - sx, Math.ceil((fullW * widthPct) / 100));
    const sh = Math.min(fullH - sy, Math.ceil((fullH * heightPct) / 100));
    if (sw < 4 || sh < 4) return null;
    const canvas = createCanvas(sw, sh);
    const ctx = canvas.getContext("2d");
    // Weißer Hintergrund — falls die Source-Region irgendwo transparent ist.
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, sw, sh);
    ctx.drawImage(img as unknown as Parameters<typeof ctx.drawImage>[0], sx, sy, sw, sh, 0, 0, sw, sh);
    return `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`;
  } catch {
    return null;
  }
}

/** Merge: ai-Felder bevorzugt, regex-Felder als Fallback wo ai null/undefined ist. */
function mergeFields(ai: ParsedTicket | null, regex: ParsedTicket): ParsedTicket {
  if (!ai) return regex;
  const pick = <K extends keyof ParsedTicket>(key: K): ParsedTicket[K] =>
    ai[key] ?? regex[key];
  return {
    mode: pick("mode"),
    carrier: pick("carrier"),
    flightNumber: pick("flightNumber"),
    fromCode: pick("fromCode"),
    fromCity: pick("fromCity"),
    fromStation: pick("fromStation"),
    toCode: pick("toCode"),
    toCity: pick("toCity"),
    toStation: pick("toStation"),
    departTime: pick("departTime"),
    arriveTime: pick("arriveTime"),
    durationMinutes: pick("durationMinutes"),
    passenger: pick("passenger"),
    seat: pick("seat"),
    wagon: pick("wagon"),
    travelClass: pick("travelClass"),
    bookingRef: pick("bookingRef"),
  };
}

export async function ticketsRoutes(app: FastifyInstance) {
  app.post("/api/tickets/parse", async (req, reply) => {
    // Kontogebunden — Parse kostet PDF-Rendering + Claude-Calls. Ohne
    // Session → 401, der Client öffnet den Login-Screen.
    const user = await requireUser(req);
    if (!user) {
      return reply.code(401).send({ error: "Login required" });
    }
    const rl = rateLimit("ticket-parse", user.id, PARSES_PER_DAY, 24 * 60 * 60 * 1000);
    if (!rl.allowed) {
      return reply
        .code(429)
        .header("Retry-After", rl.retryAfterSec)
        .send({ error: "Rate limit reached", retryAfterSec: rl.retryAfterSec });
    }

    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return reply.code(413).send({ error: "File too large" });
    }
    if (file.mimetype !== "application/pdf") {
      return reply.code(415).send({ error: "Only PDF is supported" });
    }

    try {
      const rendered = await renderPdf(buffer);
      // Text-Parser (Regex baseline + AI overlay) + Vision-Code-Detection
      // parallel feuern — beide brauchen das gerenderte PDF. Spart eine
      // Latenz-Runde (sonst sequenziell ~3-5s, parallel ~2s).
      const regexFields = parseTicketText(rendered.text);
      const aiAvailable = isAiTicketParserAvailable();
      const [aiFields, codeRegion] = await Promise.all([
        aiAvailable ? parseTicketWithAi(rendered.text) : Promise.resolve(null),
        aiAvailable ? detectCodeRegion(rendered.pageImageBase64) : Promise.resolve(null),
      ]);
      const fields = mergeFields(aiFields, regexFields);

      // Wenn Vision den Code lokalisiert hat → cropp die Region aus dem
      // Original-PNG pixel-genau. KEIN Re-Encoding — gleiche Pixel wie im
      // PDF, also bleibt der Code scanbar.
      let codeImage: string | null = null;
      let codeType: "qr" | "barcode" | null = null;
      if (codeRegion) {
        const cropped = await cropImageRegion(
          rendered.pageImageBase64,
          codeRegion.xPct,
          codeRegion.yPct,
          codeRegion.widthPct,
          codeRegion.heightPct,
        );
        if (cropped) {
          codeImage = cropped;
          codeType = codeRegion.type;
        }
      }

      return {
        fields,
        pageImage: rendered.pageImageBase64,
        pageWidth: rendered.pageWidth,
        pageHeight: rendered.pageHeight,
        pageCount: rendered.pageCount,
        originalName: file.filename,
        codeImage,
        codeType,
      };
    } catch (err) {
      app.log.error({ err }, "Failed to parse ticket PDF");
      return reply.code(500).send({ error: "Failed to parse PDF" });
    }
  });
}
