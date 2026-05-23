/**
 * Holt Flug-Abfahrten/-Ankünfte für einen Airport via AeroDataBox (RapidAPI).
 *
 * Pattern parallel zu stopInfoService:
 *   - In-Memory-Cache (60 min TTL) — Flugpläne sind tagestabil, kein Bedarf
 *     für minütliche Refreshs. Reduziert API-Calls drastisch.
 *   - Request-Coalescing: laufende Anfrage wird geshared, kein Thundering Herd.
 *
 * AeroDataBox-Endpoint:
 *   GET /flights/airports/icao/{ICAO}/{from}/{to}
 *   ODER (was wir nutzen, weil unsere AIRPORT_PINS IATA-Codes haben):
 *   GET /flights/airports/iata/{IATA}/{from}/{to}
 *
 * Zeitfenster: jetzt → in 12 Stunden. AeroDataBox erlaubt max 12h pro Call.
 */
import { config } from "../config.js";
import type { StopBoard, StopBoardItem, StopBoardResponse } from "./stopInfoService.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min — Flugpläne sind stabil
const MAX_RESULTS = 6;

interface CacheEntry {
  data: StopBoardResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StopBoardResponse>>();

function cacheKey(iata: string, board: StopBoard): string {
  return `${board}:${iata.toUpperCase()}`;
}

interface AdbTimePoint {
  scheduledTime?: { local?: string; utc?: string };
  revisedTime?: { local?: string; utc?: string };
  runwayTime?: { local?: string; utc?: string };
  predictedTime?: { local?: string; utc?: string };
  actualTime?: { local?: string; utc?: string };
  terminal?: string;
  gate?: string;
  checkInDesk?: string;
  quality?: string[];
  airport?: { iata?: string; icao?: string; name?: string };
}

interface AdbFlight {
  /** Diese Seite (= „dieser Airport") — bei Departures-Request der Start,
   *  bei Arrivals-Request das Ziel. Enthält scheduledTime + Gate + Terminal. */
  departure?: AdbTimePoint;
  arrival?: AdbTimePoint;
  number?: string;
  callSign?: string;
  airline?: { name?: string; iata?: string };
  aircraft?: { model?: string };
  status?: string;
  isCargo?: boolean;
}

interface AdbResponse {
  departures?: AdbFlight[];
  arrivals?: AdbFlight[];
}

function toIso(s: string | undefined): string | null {
  if (!s) return null;
  // AeroDataBox liefert UTC als „2026-05-17 15:20Z" (Space statt T) — die
  // Standard-Date.parse-Implementierung in Node akzeptiert das, aber sicher
  // ist sicher: wir normalisieren auf strikten ISO mit T.
  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalize(m: AdbFlight, board: StopBoard, idx: number): StopBoardItem | null {
  // Bei Departures-Request: m.departure = unser Airport (mit Gate/Time),
  //                         m.arrival   = Ziel-Airport.
  // Bei Arrivals-Request:   m.arrival   = unser Airport,
  //                         m.departure = Herkunfts-Airport.
  const here = board === "departures" ? m.departure : m.arrival;
  const otherAirport = board === "departures" ? m.arrival : m.departure;

  const planned = toIso(here?.scheduledTime?.utc);
  const actual =
    toIso(here?.actualTime?.utc) ??
    toIso(here?.runwayTime?.utc) ??
    toIso(here?.revisedTime?.utc) ??
    toIso(here?.predictedTime?.utc);
  if (!planned) return null;
  const delay =
    actual ? Math.round((Date.parse(actual) - Date.parse(planned)) / 60000) : null;
  const flightNumber = (m.number ?? m.callSign ?? "").trim();
  const airline = m.airline?.name?.trim();
  const otherName = otherAirport?.airport?.name?.trim();
  const otherIata = otherAirport?.airport?.iata;
  const direction = otherName ? `${otherName}${otherIata ? ` (${otherIata})` : ""}` : (otherIata ?? "—");
  const cancelled = typeof m.status === "string" && /cancel/i.test(m.status);
  return {
    id: `${planned}|${flightNumber}|${idx}`,
    plannedTime: planned,
    actualTime: actual,
    delayMinutes: delay,
    // Linie = „Flugnummer" — z.B. „LH 400". Airline-Name wäre redundant.
    line: flightNumber || airline || "—",
    product: "flight",
    direction,
    platform: here?.gate ?? here?.terminal ?? null,
    cancelled,
  };
}

function formatWindow(): { from: string; to: string } {
  // AeroDataBox erwartet Localtime-Format „YYYY-MM-DDTHH:mm" (max 12h Fenster).
  // Wir benutzen UTC und schicken das im erwarteten Format mit.
  const now = new Date();
  const later = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  function fmt(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }
  return { from: fmt(now), to: fmt(later) };
}

async function fetchFromAeroDataBox(iata: string, board: StopBoard): Promise<StopBoardResponse> {
  if (!config.AERODATABOX_KEY) {
    throw new Error("AERODATABOX_KEY not configured");
  }
  const { from, to } = formatWindow();
  const url = new URL(
    `https://${config.AERODATABOX_RAPIDAPI_HOST}/flights/airports/iata/${encodeURIComponent(iata.toUpperCase())}/${from}/${to}`,
  );
  url.searchParams.set("withLeg", "true");
  url.searchParams.set("withCancelled", "true");
  url.searchParams.set("withCodeshared", "false");
  url.searchParams.set("withCargo", "false");
  url.searchParams.set("withPrivate", "false");
  url.searchParams.set("withLocation", "false");
  // Nur die Richtung holen die wir brauchen — spart Bandwidth + Quota.
  url.searchParams.set("direction", board === "departures" ? "Departure" : "Arrival");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "x-rapidapi-host": config.AERODATABOX_RAPIDAPI_HOST,
        "x-rapidapi-key": config.AERODATABOX_KEY,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AeroDataBox ${res.status}`);
    const data = (await res.json()) as AdbResponse;
    const list = board === "departures" ? (data.departures ?? []) : (data.arrivals ?? []);
    const results = list
      .map((m, i) => normalize(m, board, i))
      .filter((r): r is StopBoardItem => r !== null)
      // Schon vom Provider sortiert, aber zur Sicherheit nach planned aufsteigend
      .sort((a, b) => a.plannedTime.localeCompare(b.plannedTime))
      .slice(0, MAX_RESULTS);
    const fetchedAt = new Date().toISOString();
    return {
      results,
      fetchedAt,
      validUntil: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Holt Flughafen-Departures/-Arrivals mit Cache + Coalescing.
 *
 * @param iata IATA-Code des Airports (z.B. „FRA", „MUC")
 * @param board "departures" | "arrivals"
 */
export async function getFlightBoard(iata: string, board: StopBoard): Promise<StopBoardResponse> {
  const key = cacheKey(iata, board);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = fetchFromAeroDataBox(iata, board)
    .then((data) => {
      cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}
