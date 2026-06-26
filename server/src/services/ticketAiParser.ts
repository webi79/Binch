/**
 * AI-basierter Ticket-Parser via Claude Haiku 4.5.
 *
 * Erhält den rohen Text einer PDF-Ticket-Seite (oder mehrerer Seiten,
 * concat'ed) und extrahiert strukturierte Felder. Robust gegen verschiedene
 * Ticket-Formate (DB, SNCF, Lufthansa, FlixBus, AIDA, etc.) ohne pro
 * Format eigene Regex-Patterns pflegen zu müssen.
 *
 * Fallback: wenn ANTHROPIC_API_KEY fehlt oder die API failed, gibt
 * `parseTicketWithAi` null zurück und der Caller fällt auf den Regex-
 * basierten Parser zurück.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { ParsedTicket } from "./ticketParser.js";

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You are a precise transit-ticket data extractor.

Given the raw text of a ticket PDF (flight, train, bus, or cruise — any operator, any country), extract structured fields and return ONLY a JSON object. No prose, no markdown, no explanation. Just the JSON.

JSON schema (use null for any field you cannot extract with high confidence):
{
  "mode": "FLIGHT" | "TRAIN" | "BUS" | "CRUISE",
  "carrier": string | null,
  "flightNumber": string | null,
  "fromCity": string | null,
  "fromCode": string | null,
  "fromStation": string | null,
  "toCity": string | null,
  "toCode": string | null,
  "toStation": string | null,
  "departTime": string | null,
  "arriveTime": string | null,
  "passenger": string | null,
  "seat": string | null,
  "wagon": string | null,
  "travelClass": string | null,
  "bookingRef": string | null
}

Rules:
- fromCity / toCity = the bare city name only (e.g. "Erfurt", not "Erfurt Hbf").
- fromStation / toStation = the full station name (e.g. "Erfurt Hbf", "Wrocław Główny", "Frankfurt Flughafen"). If the city has no separate station label, leave the station fields null.
- fromCode / toCode = the IATA airport code for flights (e.g. "BER"), or any short operator-specific station code if available. Leave null otherwise.
- departTime / arriveTime = ISO datetime "YYYY-MM-DDTHH:MM:00" (no timezone suffix). Use the REAL journey times, NOT validity periods or booking timestamps. For multi-leg trips: first departure of the whole journey and last arrival.
  - German train tickets prefix journey times with "ab" (departure) and "an" (arrival). Use those.
  - Ignore "Gültigkeit", "Valid from/until", "Booked at" timestamps.
- passenger = the actual human name (e.g. "Jona Skrubel"). Skip quantity labels like "1 Person", "2 Adults", "1 Erwachsener", and skip irrelevant words near the name like "Zangenabdruck" or watermark text. If multiple names appear, pick the primary traveler.
- bookingRef = the order reference / Auftragsnummer / PNR / booking code (typically 6-15 alphanumeric chars).
- flightNumber = the train/flight/coach number (e.g. "RB 27", "LH 401", "TGV 9580").
- wagon / seat = car/wagon number and seat designation if explicitly reserved. Many regional train tickets have no reservation — return null then.
- mode: detect from context (Boarding pass/Flug=FLIGHT, Gleis/RB/IC/ICE=TRAIN, FlixBus/Coach=BUS, Cabin/Schiff=CRUISE).

Return ONLY the JSON, no other text.`;

interface AiTicketJson {
  mode?: string | null;
  carrier?: string | null;
  flightNumber?: string | null;
  fromCity?: string | null;
  fromCode?: string | null;
  fromStation?: string | null;
  toCity?: string | null;
  toCode?: string | null;
  toStation?: string | null;
  departTime?: string | null;
  arriveTime?: string | null;
  passenger?: string | null;
  seat?: string | null;
  wagon?: string | null;
  travelClass?: string | null;
  bookingRef?: string | null;
}

function tidy(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t === "null" || t === "—") return undefined;
  return t;
}

function tidyMode(v: unknown): ParsedTicket["mode"] {
  const s = tidy(v);
  if (s === "FLIGHT" || s === "TRAIN" || s === "BUS" || s === "CRUISE") return s;
  return undefined;
}

function tidyDuration(depart?: string, arrive?: string): number | undefined {
  if (!depart || !arrive) return undefined;
  const d = Date.parse(depart);
  const a = Date.parse(arrive);
  if (!Number.isFinite(d) || !Number.isFinite(a)) return undefined;
  const diff = Math.round((a - d) / 60000);
  return diff > 0 && diff < 60 * 48 ? diff : undefined;
}

/**
 * Extrahiert Felder aus dem Text via Claude. Wirft NICHT — bei jedem Fehler
 * (kein API-Key, Netzwerk, JSON-Parse-Fehler, etc.) wird null zurückgegeben
 * und der Caller fällt auf den Regex-Parser zurück.
 */
export async function parseTicketWithAi(text: string): Promise<ParsedTicket | null> {
  const client = getClient();
  if (!client) return null;

  // Text-Cap: Haiku akzeptiert viel mehr aber für ein typisches 1-2-Seiten-
  // Ticket reichen ~8000 Zeichen locker. Schützt vor Edge-Cases mit
  // pathologisch großen PDFs (z.B. AGB-Seiten mit Floskeln).
  const trimmed = text.length > 8000 ? text.slice(0, 8000) : text;

  let raw: string;
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Extract structured ticket data from this PDF text:\n\n<ticket_text>\n${trimmed}\n</ticket_text>`,
        },
      ],
    });

    const block = resp.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    raw = block.text;
  } catch {
    return null;
  }

  // Robustes JSON-Extracting: nimm den ersten { bis zum passenden } im
  // Response. Claude sollte purely JSON liefern, aber falls Markdown-Fences
  // dazwischen rutschen schneiden wir's raus.
  const startIdx = raw.indexOf("{");
  const endIdx = raw.lastIndexOf("}");
  if (startIdx < 0 || endIdx <= startIdx) return null;
  let parsed: AiTicketJson;
  try {
    parsed = JSON.parse(raw.slice(startIdx, endIdx + 1)) as AiTicketJson;
  } catch {
    return null;
  }

  const departTime = tidy(parsed.departTime);
  const arriveTime = tidy(parsed.arriveTime);

  const out: ParsedTicket = {
    mode: tidyMode(parsed.mode),
    carrier: tidy(parsed.carrier),
    flightNumber: tidy(parsed.flightNumber),
    fromCity: tidy(parsed.fromCity),
    fromCode: tidy(parsed.fromCode),
    fromStation: tidy(parsed.fromStation),
    toCity: tidy(parsed.toCity),
    toCode: tidy(parsed.toCode),
    toStation: tidy(parsed.toStation),
    departTime,
    arriveTime,
    durationMinutes: tidyDuration(departTime, arriveTime),
    passenger: tidy(parsed.passenger),
    seat: tidy(parsed.seat),
    wagon: tidy(parsed.wagon),
    travelClass: tidy(parsed.travelClass),
    bookingRef: tidy(parsed.bookingRef),
  };
  return out;
}

export function isAiTicketParserAvailable(): boolean {
  return Boolean(config.ANTHROPIC_API_KEY);
}

// ---------------------------------------------------------------------------
// Code-Detection (QR / Aztec / Data-Matrix / 1D-Barcode) via Claude Vision.
// ---------------------------------------------------------------------------

const CODE_DETECT_PROMPT = `You are a precise visual region detector for transit-ticket boarding codes.

Find THE boarding code in this ticket image. It can be:
- "qr" = any 2D matrix code (QR Code, Aztec Code, Data Matrix) — typically square
- "barcode" = 1D linear barcode (Code128, PDF417, etc.) — typically wide horizontal stripes

Return ONLY a JSON object with the bounding box as percentages (0-100) of image width/height:
{
  "type": "qr" | "barcode" | null,
  "x": number,
  "y": number,
  "width": number,
  "height": number
}

Rules:
- "x"/"y" = top-left corner of the bounding box, as percent of image width/height
- "width"/"height" = box size, as percent of image width/height
- Add ~4% padding around the code so it's not cut at the edges
- If multiple codes appear, pick the LARGEST and MOST PROMINENT one (usually near the top of the ticket)
- IGNORE the small watermark "Zangenabdruck" patterns, decorative logos, or text — only return REAL machine-readable codes
- If no scannable code is visible, return {"type": null, "x": 0, "y": 0, "width": 0, "height": 0}

Return ONLY the JSON, no other text.`;

interface CodeRegionJson {
  type?: "qr" | "barcode" | null;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface DetectedCodeRegion {
  type: "qr" | "barcode";
  /** Top-left x in % of image width (0-100). */
  xPct: number;
  /** Top-left y in % of image height (0-100). */
  yPct: number;
  /** Box width in % of image width (0-100). */
  widthPct: number;
  /** Box height in % of image height (0-100). */
  heightPct: number;
}

/**
 * Erkennt QR/Aztec/Data-Matrix/Barcode im Ticket-Image via Claude Haiku
 * Vision und gibt die Bounding-Box als Prozent-Werte (0-100) zurück.
 *
 * Wirft NICHT — bei jedem Fehler (kein API-Key, Netzwerk, ungültiges JSON,
 * type=null) returns null. Caller croppt dann nichts und der Client zeigt
 * eine Fallback-Message.
 *
 * `pageImageBase64` darf mit ODER ohne `data:image/png;base64,` Präfix
 * übergeben werden — die Funktion strippt es bei Bedarf.
 */
export async function detectCodeRegion(
  pageImageBase64: string,
): Promise<DetectedCodeRegion | null> {
  const client = getClient();
  if (!client) return null;

  const base64 = pageImageBase64.replace(/^data:image\/[^;]+;base64,/, "");

  let raw: string;
  try {
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: base64 },
            },
            { type: "text", text: CODE_DETECT_PROMPT },
          ],
        },
      ],
    });
    const block = resp.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    raw = block.text;
  } catch {
    return null;
  }

  const startIdx = raw.indexOf("{");
  const endIdx = raw.lastIndexOf("}");
  if (startIdx < 0 || endIdx <= startIdx) return null;
  let parsed: CodeRegionJson;
  try {
    parsed = JSON.parse(raw.slice(startIdx, endIdx + 1)) as CodeRegionJson;
  } catch {
    return null;
  }

  if (parsed.type !== "qr" && parsed.type !== "barcode") return null;
  if (
    typeof parsed.x !== "number" ||
    typeof parsed.y !== "number" ||
    typeof parsed.width !== "number" ||
    typeof parsed.height !== "number"
  ) {
    return null;
  }
  // Sanity-Check: Box muss eine sinnvolle Größe haben (mindestens 2% Breite/
  // Höhe, sonst war's wohl ein false-positive auf einem Logo o.ä.).
  if (parsed.width < 2 || parsed.height < 2 || parsed.width > 100 || parsed.height > 100) {
    return null;
  }

  return {
    type: parsed.type,
    xPct: Math.max(0, Math.min(100, parsed.x)),
    yPct: Math.max(0, Math.min(100, parsed.y)),
    widthPct: Math.max(0, Math.min(100, parsed.width)),
    heightPct: Math.max(0, Math.min(100, parsed.height)),
  };
}
