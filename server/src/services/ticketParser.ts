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
  fromStation?: string;
  toCode?: string;
  toCity?: string;
  toStation?: string;
  departTime?: string; // ISO yyyy-mm-ddThh:mm:00 (no tz)
  arriveTime?: string;
  durationMinutes?: number;
  passenger?: string;
  seat?: string;
  wagon?: string;
  travelClass?: string;
  bookingRef?: string;
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

const RX_PASSENGER = /(?:Passagier|Passenger|Pasajero|Passager|Holder|PAX)\s*[:.]?\s*([A-ZÄÖÜ][\p{L}'.\- ]+(?:\s+[\p{L}'.\- ]+){0,3})/u;
// "Jona Skrubel Auftragsnummer:" — der Passagier-Name steht in DB-Tickets
// DIREKT vor dem "Auftragsnummer:" Label. Höchste Priorität für DB.
const RX_PASS_BEFORE_AUFTRAG = /\b([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+){1,2})\s+Auftragsnummer/u;
const RX_SEAT = /(?:Sitz(?:platz)?|Platz|Seat|Place|Asiento|Posto)\s*[:.]?\s*(\d{1,3}\s?[A-Z]?)\b/i;
const RX_WAGON = /(?:Wagen|Wg\.?|Coach|Car|Voiture|Carro|Carrozza|Vagón|Vagon)\s*[:.]?\s*(\d{1,3}[A-Z]?)\b/i;
const RX_CLASS = /\b(Economy|Eco|Premium Economy|Business|First|2\.?\s?Klasse|1\.?\s?Klasse|Standard|Comfort|1ère|2ème|1st|2nd)\b/i;
const RX_BOOKING_REF = /(?:Auftragsnummer|Buchungscode|Buchungsnummer|Buchungsref|Bestellnummer|Booking(?:\s*(?:code|number|reference|ref))?|Reference|Réservation|PNR|Ticket\s*(?:no|nr|number|#))\s*[:.#]?\s*([A-Z0-9][A-Z0-9-]{4,15})\b/i;
// DB-spezifisch: "Einfache Fahrt: Kölleda → Erfurt Hbf" — höchste Priorität,
// da das Pattern eindeutig die Reise-Route markiert. Stops bei common breakers
// (Via:, Klasse, Reisender, etc.) damit nicht greedy in andere Sektionen
// reingelaufen wird.
const RX_DB_ROUTE = /Einfache\s+Fahrt[:\s]+([\p{L}\-' ]{2,40}?)\s*(?:→|—|–|->|\bnach\b)\s*([\p{L}\-' ]{2,40}?)(?=\s+(?:Via|Klasse|Reisender|Eine|Gesamtpreis|Auftrags|Datum|Halt)\b|\s*$|[.,;:])/iu;
// "Hin-/Rückfahrt" Variante für DB:
const RX_DB_HINFAHRT = /(?:Hin|Rück)fahrt[:\s]+([\p{L}\-' ]{2,40}?)\s*(?:→|—|–|->|\bnach\b)\s*([\p{L}\-' ]{2,40}?)(?=\s+(?:Via|Klasse|Reisender|Eine|Gesamtpreis|Auftrags|Datum|Halt)\b|\s*$|[.,;:])/iu;
// Stations mit Suffix — KEINE Parens/Dots/Digits im Prefix (sonst greedy
// über Tabellen-Inhalt). Stops am Suffix-Wort.
const RX_STATION_KEYWORDS = /\b([A-ZÄÖÜ][\p{L}\-' ]{1,28}?)\s+(Hbf\.?|Hauptbahnhof|Hauptbf\.?|Główny|Centrale|Termini|Centraal|Bahnhof|Stazione|Station|Flughafen|Airport)\b/gu;
// Arrow-separierte Routen (generisch, niedrige Priorität) — gleiches Pattern
// wie zuvor aber mit common-breaker-Lookahead damit's nicht in benachbarte
// Sektionen läuft. Keine Parens, keine Dots im City-Match.
const RX_ROUTE_ARROW = /\b([A-ZÄÖÜ][\p{L}\-' ]{1,30}?)\s*(?:→|—|–|->|\bnach\b|\bvers\b|\bto\b)\s+([A-ZÄÖÜ][\p{L}\-' ]{1,30}?)(?=\s+(?:Via|Klasse|Reisender|Datum|Halt|Auftrags)\b|\s*$|[.,;])/iu;
// DB-Zeiten in der Reise-Tabelle: "ab HH:MM" (Abfahrt) / "an HH:MM" (Ankunft).
// Generisch erste freie HH:MM nur als Fallback wenn keine ab/an Pattern matchen.
const RX_DEPART_AB = /\bab\s+(\d{1,2}):(\d{2})\b/g;
const RX_ARRIVE_AN = /\ban\s+(\d{1,2}):(\d{2})\b/g;

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

  // Route — Versuch 1: DB-spezifisches "Einfache Fahrt: X → Y" (höchste
  // Priorität, eindeutig die Reise-Route, nicht irgendein Text-Fragment).
  const dbRoute = RX_DB_ROUTE.exec(collapsed) ?? RX_DB_HINFAHRT.exec(collapsed);
  if (dbRoute) {
    out.fromCity = dbRoute[1]!.trim();
    out.toCity = dbRoute[2]!.trim();
  }

  // Route — Versuch 2: IATA-Airport-Codes (für Flug-Tickets)
  if (!out.fromCity || !out.toCity) {
    const { from, to } = findIataPair(collapsed);
    if (from) {
      if (!out.fromCode) out.fromCode = from;
      const ap = AIRPORT_BY_IATA.get(from);
      if (ap && !out.fromCity) out.fromCity = ap.city;
    }
    if (to) {
      if (!out.toCode) out.toCode = to;
      const ap = AIRPORT_BY_IATA.get(to);
      if (ap && !out.toCity) out.toCity = ap.city;
    }
  }

  // Route — Versuch 3: Stations-Keywords (für Zug/Bus-Tickets ohne IATA-Codes
  // und ohne explizites "Einfache Fahrt"-Label). Sammelt alle Strings die auf
  // Bahnhof-Suffixe enden.
  if (!out.fromStation || !out.toStation || !out.fromCity || !out.toCity) {
    const stations: string[] = [];
    let sm: RegExpExecArray | null;
    RX_STATION_KEYWORDS.lastIndex = 0;
    while ((sm = RX_STATION_KEYWORDS.exec(collapsed)) !== null && stations.length < 4) {
      const full = `${sm[1]!.trim()} ${sm[2]!.trim()}`;
      if (!stations.includes(full)) stations.push(full);
    }
    if (stations.length >= 2) {
      if (!out.fromStation) out.fromStation = stations[0];
      if (!out.toStation) out.toStation = stations[1];
      const cityFromStation = (s: string) =>
        s.replace(/\s+(Hbf\.?|Hauptbahnhof|Hauptbf\.?|Główny|Centrale|Termini|Centraal|Bahnhof|Stazione|Station|Flughafen|Airport)\s*$/u, "").trim();
      if (!out.fromCity) out.fromCity = cityFromStation(stations[0]!);
      if (!out.toCity) out.toCity = cityFromStation(stations[1]!);
    }
  }

  // Route — Versuch 4: Generic Arrow-Route ("X → Y" ohne DB-Prefix).
  if (!out.fromCity || !out.toCity) {
    const arrow = RX_ROUTE_ARROW.exec(collapsed);
    if (arrow) {
      if (!out.fromCity) out.fromCity = arrow[1]!.trim();
      if (!out.toCity) out.toCity = arrow[2]!.trim();
    }
  }

  // Post-Processing: wenn fromCity/toCity einen Station-Suffix enthält
  // (z.B. "Erfurt Hbf" aus dem DB-Route-Match), trennen wir City + Station
  // damit die UI-Titel-Zeile sauber "Erfurt" zeigt und die Subtitle-Zeile
  // "Erfurt Hbf". Stationen die schon eigenständig erkannt wurden behalten
  // wir.
  const stripStationSuffix = (s: string): { city: string; station?: string } => {
    const m = s.match(/^(.+?)\s+(Hbf\.?|Hauptbahnhof|Hauptbf\.?|Główny|Centrale|Termini|Centraal|Bahnhof|Stazione|Station|Flughafen|Airport)\s*$/u);
    if (m) return { city: m[1]!.trim(), station: s.trim() };
    return { city: s.trim() };
  };
  if (out.fromCity) {
    const split = stripStationSuffix(out.fromCity);
    out.fromCity = split.city;
    if (split.station && !out.fromStation) out.fromStation = split.station;
  }
  if (out.toCity) {
    const split = stripStationSuffix(out.toCity);
    out.toCity = split.city;
    if (split.station && !out.toStation) out.toStation = split.station;
  }

  // Date + times
  const date = parseFirstDate(collapsed);

  // Times — Versuch 1: DB-Tabellen-Pattern "ab HH:MM" / "an HH:MM" (echte
  // Reise-Zeiten, NICHT die Gültigkeits-Periode "Gültigkeit: ... 00:00 ...
  // bis ... 03:00 ..."). Erste "ab" = echte Abfahrt, LETZTE "an" = finale
  // Ankunft (bei Multi-Leg-Trips: z.B. Kölleda ab 11:16 → Sömmerda an 11:25
  // → Sömmerda ab 11:31 → Erfurt an 11:51 = wir wollen 11:16/11:51).
  const abMatches: string[] = [];
  let am: RegExpExecArray | null;
  RX_DEPART_AB.lastIndex = 0;
  while ((am = RX_DEPART_AB.exec(collapsed)) !== null) {
    abMatches.push(`${am[1]!.padStart(2, "0")}:${am[2]}`);
  }
  const anMatches: string[] = [];
  let nm: RegExpExecArray | null;
  RX_ARRIVE_AN.lastIndex = 0;
  while ((nm = RX_ARRIVE_AN.exec(collapsed)) !== null) {
    anMatches.push(`${nm[1]!.padStart(2, "0")}:${nm[2]}`);
  }

  let t1: string | undefined;
  let t2: string | undefined;
  if (abMatches.length > 0 && anMatches.length > 0) {
    t1 = abMatches[0];
    t2 = anMatches[anMatches.length - 1];
  } else {
    // Times — Versuch 2 (Fallback): erste zwei HH:MM im Text (Flug-Tickets
    // haben kein "ab"/"an"-Prefix, sondern z.B. "07:25 STR → 09:35 BER").
    const found = findFirstTwoTimes(collapsed);
    t1 = found.t1;
    t2 = found.t2;
  }

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

  // Passenger — Versuch 1: DB-Pattern "Vorname Nachname Auftragsnummer:"
  // (der echte Name steht direkt vor dem Auftragsnummer-Label).
  const paxBeforeAuftrag = RX_PASS_BEFORE_AUFTRAG.exec(collapsed);
  if (paxBeforeAuftrag) out.passenger = paxBeforeAuftrag[1]!.trim();

  // Passenger — Versuch 2: explizite "Passenger:" / "Pasajero:" Labels.
  // Bewusst ohne "Name|Reisender" weil das auch "1 Person" matchen würde.
  if (!out.passenger) {
    const pax = RX_PASSENGER.exec(collapsed);
    if (pax) out.passenger = pax[1]!.trim();
  }

  const seat = RX_SEAT.exec(collapsed);
  if (seat) out.seat = seat[1]!.replace(/\s+/g, "").toUpperCase();

  const wagon = RX_WAGON.exec(collapsed);
  if (wagon) out.wagon = wagon[1]!.toUpperCase();

  const cls = RX_CLASS.exec(collapsed);
  if (cls) out.travelClass = cls[1]!.trim();

  const ref = RX_BOOKING_REF.exec(collapsed);
  if (ref) out.bookingRef = ref[1]!.trim();

  return out;
}
