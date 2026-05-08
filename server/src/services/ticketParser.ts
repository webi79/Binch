/**
 * Heuristic ticket-text parser.
 *
 * Inputs the raw text extracted from a PDF page and returns a partial
 * structured ticket. Every field is best-effort — when a pattern doesn't
 * match, the field is simply omitted (no fabrication).
 */

import { AIRPORTS } from "../data/airports.js";

export type TravelMode = "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";

export interface ParsedTicket {
  mode?: TravelMode;
  carrier?: string;
  flightNumber?: string;
  fromCode?: string;
  fromCity?: string;
  toCode?: string;
  toCity?: string;
  departTime?: string; // ISO yyyy-mm-ddThh:mm:00 (no tz)
  arriveTime?: string;
  durationMinutes?: number;
  passenger?: string;
  seat?: string;
  travelClass?: string;
}

// === carriers ====================================================
interface CarrierDef {
  pattern: RegExp;
  name: string;
  mode: TravelMode;
}

const CARRIERS: CarrierDef[] = [
  { pattern: /\blufthansa\b/i, name: "Lufthansa", mode: "FLIGHT" },
  { pattern: /\beurowings\b/i, name: "Eurowings", mode: "FLIGHT" },
  { pattern: /\bryanair\b/i, name: "Ryanair", mode: "FLIGHT" },
  { pattern: /\beasyjet\b/i, name: "easyJet", mode: "FLIGHT" },
  { pattern: /\bbritish airways\b/i, name: "British Airways", mode: "FLIGHT" },
  { pattern: /\bair france\b/i, name: "Air France", mode: "FLIGHT" },
  { pattern: /\bklm\b/i, name: "KLM", mode: "FLIGHT" },
  { pattern: /\biberia\b/i, name: "Iberia", mode: "FLIGHT" },
  { pattern: /\bswiss\b/i, name: "SWISS", mode: "FLIGHT" },
  { pattern: /\bturkish airlines\b/i, name: "Turkish Airlines", mode: "FLIGHT" },
  { pattern: /\bemirates\b/i, name: "Emirates", mode: "FLIGHT" },
  { pattern: /\bcondor\b/i, name: "Condor", mode: "FLIGHT" },
  { pattern: /\btui\b/i, name: "TUI fly", mode: "FLIGHT" },

  { pattern: /\bdeutsche bahn\b/i, name: "Deutsche Bahn", mode: "TRAIN" },
  { pattern: /\bdb fernverkehr\b/i, name: "Deutsche Bahn", mode: "TRAIN" },
  { pattern: /\bsncf\b/i, name: "SNCF", mode: "TRAIN" },
  { pattern: /\btrenitalia\b/i, name: "Trenitalia", mode: "TRAIN" },
  { pattern: /\brenfe\b/i, name: "Renfe", mode: "TRAIN" },
  { pattern: /\böbb\b/i, name: "ÖBB", mode: "TRAIN" },
  { pattern: /\bsbb\b/i, name: "SBB", mode: "TRAIN" },
  { pattern: /\bnsb\b/i, name: "Vy", mode: "TRAIN" },
  { pattern: /\beurostar\b/i, name: "Eurostar", mode: "TRAIN" },
  { pattern: /\bthalys\b/i, name: "Thalys", mode: "TRAIN" },

  { pattern: /\bflixbus\b/i, name: "FlixBus", mode: "BUS" },
  { pattern: /\bbusbud\b/i, name: "Busbud", mode: "BUS" },
  { pattern: /\bblablacar\b/i, name: "BlaBlaCar Bus", mode: "BUS" },
  { pattern: /\beurolines\b/i, name: "Eurolines", mode: "BUS" },

  { pattern: /\baida\b/i, name: "AIDA", mode: "CRUISE" },
  { pattern: /\bmsc cruises\b/i, name: "MSC Cruises", mode: "CRUISE" },
  { pattern: /\bcosta\b/i, name: "Costa", mode: "CRUISE" },
  { pattern: /\btui cruises\b/i, name: "TUI Cruises", mode: "CRUISE" },
];

// === regex helpers ==============================================
const RX_TIME = /(?<![:\d])([01]\d|2[0-3]):([0-5]\d)(?!\d)/g;
const RX_FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d)\s?(\d{1,4}[A-Z]?)\b/;
const RX_TRAIN_NO = /\b(ICE|IC|EC|TGV|RJ|S\d{1,2}|RB|RE|EN|NJ)\s?(\d{1,4})\b/;
const RX_DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const RX_DATE_DOT = /\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})\b/;
const RX_DATE_MONTHNAME =
  /\b(\d{1,2})\s+(Jan|Feb|Mar|Mär|Apr|May|Mai|Jun|Jul|Aug|Sep|Sept|Oct|Okt|Nov|Dec|Dez)[a-zäöü.]*\s+(\d{2,4})\b/i;

const RX_PASSENGER = /(?:Passagier|Passenger|Pasajero|Passager|Name|PAX)\s*[:.]?\s*([A-ZÄÖÜ][\p{L}'.\- ]+(?:\s+[A-ZÄÖÜ][\p{L}'.\- ]+){0,3})/u;
const RX_SEAT = /(?:Sitz(?:platz)?|Seat|Place|Asiento|Posto)\s*[:.]?\s*(\d{1,3}\s?[A-Z]?)\b/i;
const RX_CLASS = /\b(Economy|Eco|Premium Economy|Business|First|2\.?\s?Klasse|1\.?\s?Klasse|Standard|Comfort)\b/i;

const MONTH_MAP: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, mär: 3, apr: 4, may: 5, mai: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
};

// === airports lookup ============================================
const AIRPORT_BY_IATA = new Map(AIRPORTS.map((a) => [a.iata, a]));

// === parsers ====================================================
function detectCarrier(text: string): { name: string; mode: TravelMode } | undefined {
  for (const c of CARRIERS) {
    if (c.pattern.test(text)) return { name: c.name, mode: c.mode };
  }
  return undefined;
}

function detectMode(text: string): TravelMode | undefined {
  if (/\bboarding pass\b|\bgate\b|\bflug\b|\bflight\b/i.test(text)) return "FLIGHT";
  if (/\bICE\b|\bbahn\b|\btrain\b|\bgleis\b|\bplatform\b|\btrack\b/i.test(text)) return "TRAIN";
  if (/\bbus\b|\bcoach\b|\bhaltestelle\b/i.test(text)) return "BUS";
  if (/\bcruise\b|\bkreuzfahrt\b|\bschiff\b|\bport\b|\bcabin\b|\bkabine\b/i.test(text)) return "CRUISE";
  return undefined;
}

function findIataPair(text: string): { from?: string; to?: string } {
  const candidates: { code: string; pos: number }[] = [];
  const rx = /\b([A-Z]{3})\b/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text)) !== null) {
    const code = m[1]!;
    if (AIRPORT_BY_IATA.has(code)) {
      candidates.push({ code, pos: m.index });
    }
  }
  // Pick first two distinct in document order
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of candidates) {
    if (!seen.has(c.code)) {
      seen.add(c.code);
      ordered.push(c.code);
      if (ordered.length === 2) break;
    }
  }
  return { from: ordered[0], to: ordered[1] };
}

function parseFirstDate(text: string): { y: number; mo: number; d: number } | undefined {
  const iso = RX_DATE_ISO.exec(text);
  if (iso) return { y: +iso[1]!, mo: +iso[2]!, d: +iso[3]! };
  const dot = RX_DATE_DOT.exec(text);
  if (dot) {
    let y = +dot[3]!;
    if (y < 100) y += 2000;
    return { y, mo: +dot[2]!, d: +dot[1]! };
  }
  const mon = RX_DATE_MONTHNAME.exec(text);
  if (mon) {
    const monthKey = mon[2]!.toLowerCase();
    const mo = MONTH_MAP[monthKey];
    let y = +mon[3]!;
    if (y < 100) y += 2000;
    if (mo) return { y, mo, d: +mon[1]! };
  }
  return undefined;
}

function findFirstTwoTimes(text: string): { t1?: string; t2?: string } {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  RX_TIME.lastIndex = 0;
  while ((m = RX_TIME.exec(text)) !== null && found.length < 2) {
    found.push(`${m[1]}:${m[2]}`);
  }
  return { t1: found[0], t2: found[1] };
}

function isoDateTime(date: { y: number; mo: number; d: number }, time: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.y}-${pad(date.mo)}-${pad(date.d)}T${time}:00`;
}

export function parseTicketText(text: string): ParsedTicket {
  const out: ParsedTicket = {};
  const collapsed = text.replace(/\s+/g, " ");

  // mode + carrier
  const carrier = detectCarrier(collapsed);
  if (carrier) {
    out.carrier = carrier.name;
    out.mode = carrier.mode;
  } else {
    const m = detectMode(collapsed);
    if (m) out.mode = m;
  }

  // Number
  if (out.mode === "TRAIN") {
    const tn = RX_TRAIN_NO.exec(collapsed);
    if (tn) out.flightNumber = `${tn[1]} ${tn[2]}`;
  } else {
    const fn = RX_FLIGHT_NO.exec(collapsed);
    if (fn) out.flightNumber = `${fn[1]} ${fn[2]}`;
  }

  // Route
  const { from, to } = findIataPair(collapsed);
  if (from) {
    out.fromCode = from;
    const ap = AIRPORT_BY_IATA.get(from);
    if (ap) out.fromCity = ap.city;
  }
  if (to) {
    out.toCode = to;
    const ap = AIRPORT_BY_IATA.get(to);
    if (ap) out.toCity = ap.city;
  }

  // Date + times
  const date = parseFirstDate(collapsed);
  const { t1, t2 } = findFirstTwoTimes(collapsed);
  if (date && t1) out.departTime = isoDateTime(date, t1);
  if (date && t2) {
    let arr = isoDateTime(date, t2);
    if (out.departTime) {
      const dep = new Date(out.departTime);
      const arrD = new Date(arr);
      if (arrD.getTime() <= dep.getTime()) {
        arrD.setDate(arrD.getDate() + 1);
        const pad = (n: number) => String(n).padStart(2, "0");
        arr = `${arrD.getFullYear()}-${pad(arrD.getMonth() + 1)}-${pad(
          arrD.getDate()
        )}T${pad(arrD.getHours())}:${pad(arrD.getMinutes())}:00`;
      }
      out.durationMinutes = Math.round((new Date(arr).getTime() - dep.getTime()) / 60000);
    }
    out.arriveTime = arr;
  }

  // Passenger / seat / class
  const pax = RX_PASSENGER.exec(collapsed);
  if (pax) out.passenger = pax[1]!.trim();

  const seat = RX_SEAT.exec(collapsed);
  if (seat) out.seat = seat[1]!.replace(/\s+/g, "").toUpperCase();

  const cls = RX_CLASS.exec(collapsed);
  if (cls) out.travelClass = cls[1]!.trim();

  return out;
}
