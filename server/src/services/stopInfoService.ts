/**
 * Fetcht aktuelle Abfahrten/Ankünfte zu einer Station per db-rest (self-hosted,
 * HAFAS-Wrapper unter DBREST_BASE_URL). Bietet zwei Optimierungen:
 *
 *   1. In-Memory-Cache (60 s TTL): selbe Station wird bei wiederholter Anfrage
 *      nicht erneut gegen HAFAS gefeuert. Wir können das, weil Echtzeit-
 *      Departures sowieso nur alle ~30 s vom Operator aktualisiert werden.
 *
 *   2. Request-Coalescing: laufen 100 User gleichzeitig auf denselben Stop,
 *      starten wir nicht 100 db-rest-Calls — der erste Caller setzt eine
 *      Promise in `inflight`, alle weiteren warten auf dieselbe. Verhindert
 *      Thundering-Herd-Belastung von HAFAS bei viralen Stops (z.B. Berlin Hbf
 *      nach News-Bericht).
 *
 * db-rest ist bei uns self-hosted via Docker (kein externes Rate-Limit), aber
 * HAFAS hinter db-rest hat eigene Limits — daher der Cache.
 */
import { config } from "../config.js";
import {
  claimUserBudget,
  claimBackgroundBudget,
  enqueueRefresh,
  dbVendoBudgetUsed,
} from "./dbVendoQueue.js";
import {
  fetchDepartures as multiFetchDepartures,
  fetchArrivals as multiFetchArrivals,
  resolveStationByCoord as multiResolveStation,
} from "./multiHafas.js";
import type { HafasProfileKey, MultiHafasProfileKey } from "./countryProfile.js";
import { getScheduledStopBoard } from "./gtfsSchedule.js";

export type StopBoard = "departures" | "arrivals";

export interface StopBoardItem {
  /** Trip-ID, falls vom Provider geliefert — sonst stable hash. */
  id: string;
  /** Soll-Abfahrt/Ankunft als ISO-UTC. */
  plannedTime: string;
  /** Tatsächliche (mit Verspätung) Zeit als ISO-UTC. Wenn === plannedTime,
   *  ist's pünktlich. */
  actualTime: string | null;
  /** Verspätung in Minuten, kann negativ sein (zu früh). null = keine Info. */
  delayMinutes: number | null;
  /** Linien-Kürzel, z.B. „ICE 622", „RE 1", „U5", „123". */
  line: string;
  /** Linien-Typ aus dem Provider (suburban, bus, regional, …) — wird im
   *  Frontend zum Farbcodieren genutzt. */
  product: string | null;
  /** Wohin geht's (bei departures) / wo kommt's her (bei arrivals). */
  direction: string;
  /** Gleis/Bahnsteig, falls bekannt. */
  platform: string | null;
  /** Hat der Stop einen Anschluss erwischt / die Fahrt fährt überhaupt? */
  cancelled: boolean;
}

export interface StopBoardResponse {
  results: StopBoardItem[];
  /** Frische der Daten — wann wurde der HAFAS-Roundtrip gemacht. */
  fetchedAt: string;
  /** ISO-UTC der serverseitigen Cache-Gültigkeit. */
  validUntil: string;
}

// ============================================================================
// Cache + Rate-Limit-Strategie
// ============================================================================
// Wir balancieren zwischen Datenfrische und db-vendo-Quota (60 req/min/IPv4):
//
//   - HOT_TTL (5min) für oft-genutzte Stops: User sehen max. 5min alte Daten,
//     SWR triggert ab 2.5min im Hintergrund einen Refresh.
//   - COLD_TTL (10min) für Long-Tail-Stops (provinzielle Bushaltestellen):
//     selten erneut getappt → längerer Cache spart Quota.
//   - Outbound-Throttle: maximal 50 db-vendo-Calls / 60s. Bei Erreichen
//     liefern wir nur noch Cache-Hits aus, neue Stops bekommen leere Boards.
//     Headroom zu DB's 60-Limit puffert Clock-Skew + interne Retries.
//   - HOT_THRESHOLD = ein Stop ist „hot" wenn er in der letzten Stunde
//     mindestens 5× angefragt wurde.
const HOT_TTL_MS = 5 * 60_000; // 5 min — hot stops
const COLD_TTL_MS = 10 * 60_000; // 10 min — cold stops
const SWR_REFRESH_AT_MS = HOT_TTL_MS / 2; // 2.5 min — Background-Refresh ab
const HARD_MAX_AGE_MS = 15 * 60_000; // 15 min — über dem wir Cache komplett verwerfen
const HOT_THRESHOLD = 5; // ≥5 Zugriffe in 1h = hot
const ACCESS_TRACK_WINDOW_MS = 60 * 60_000; // 1h
const MAX_RESULTS = 6;

// Throttle + Background-Queue leben jetzt in dbVendoQueue.ts — shared zwischen
// allen db-vendo-Consumern (Stop-Boards, Train-Searches, Pre-Cache). Damit
// kann ein Train-Search-Spike nicht mehr unbemerkt die 60/min reissen während
// Stop-Boards „grünes Budget" sehen.

interface CacheEntry {
  data: StopBoardResponse;
  cachedAt: number;
  ttlMs: number;
  /** True solange ein Background-Refresh für diesen Key läuft. */
  refreshing: boolean;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StopBoardResponse>>();
/** Pro Cache-Key: Timestamps der letzten Zugriffe in der Tracking-Window. */
const accessLog = new Map<string, number[]>();

function trackAccess(key: string): void {
  const now = Date.now();
  const log = accessLog.get(key) ?? [];
  // Alte Einträge aus der Tracking-Window rausschneiden, damit Map nicht wächst.
  while (log.length > 0 && log[0]! < now - ACCESS_TRACK_WINDOW_MS) log.shift();
  log.push(now);
  accessLog.set(key, log);
}

function isHot(key: string): boolean {
  const log = accessLog.get(key);
  if (!log) return false;
  const cutoff = Date.now() - ACCESS_TRACK_WINDOW_MS;
  let count = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i]! < cutoff) break;
    count++;
  }
  return count >= HOT_THRESHOLD;
}

/** Aktueller Outbound-Druck — Re-Export aus dem Shared-Throttle für Pre-Cache. */
export function currentOutboundBudgetUsed(): number {
  return dbVendoBudgetUsed();
}

function cacheKey(hafasId: string, board: StopBoard, profile: HafasProfileKey): string {
  // Profile in den Key, damit ein AT-Stop mit numerischer ID nicht versehentlich
  // einen DE-Cache-Eintrag mit gleicher ID überschreibt (HAFAS-IDs sind nicht
  // global eindeutig zwischen Profilen).
  return `${profile}:${board}:${hafasId}`;
}

interface DbRestDeparture {
  tripId?: string;
  stop?: { name?: string };
  when?: string | null; // actual (mit Verspätung)
  plannedWhen?: string | null; // soll
  delay?: number | null; // Sekunden
  platform?: string | null;
  plannedPlatform?: string | null;
  direction?: string | null;
  provenance?: string | null;
  line?: {
    name?: string;
    product?: string;
    mode?: string;
  };
  cancelled?: boolean;
}

function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalize(raw: DbRestDeparture, board: StopBoard, idx: number): StopBoardItem | null {
  const planned = toIso(raw.plannedWhen) ?? toIso(raw.when);
  const actual = toIso(raw.when);
  if (!planned) return null;
  const lineName = raw.line?.name?.trim() ?? "";
  const product = raw.line?.product ?? raw.line?.mode ?? null;
  // Anruf-Sammeltaxi / Rufbus rausfiltern: HAFAS markiert die als product=taxi
  // mit Linien-Namen wie „RUF Helmo" oder „ALT 399". Sind on-demand, müssen
  // vorher telefonisch gebucht werden — im normalen Departures-Board nutzlos
  // und für den User verwirrend („was bedeutet RUF Helmo?"). Wir verstecken
  // sie komplett. Falls jemand sie doch will, lässt sich das später per
  // optionalem Query-Param wieder einblenden.
  if (product === "taxi") return null;
  // direction = Endhaltestelle bei Abfahrten, provenance = Startbahnhof bei Ankünften.
  const direction = (board === "departures" ? raw.direction : raw.provenance)?.trim() ?? "";
  const delay = typeof raw.delay === "number" ? Math.round(raw.delay / 60) : null;
  return {
    id: raw.tripId ?? `${planned}|${lineName}|${idx}`,
    plannedTime: planned,
    actualTime: actual,
    delayMinutes: delay,
    line: lineName || "—",
    product,
    direction,
    platform: raw.platform ?? raw.plannedPlatform ?? null,
    cancelled: raw.cancelled === true,
  };
}

/** Single db-rest-Call mit optionalem `when`-Anker. Liefert leeres Array bei
 *  Provider-Fehler (für die Retry-Schleife oben). */
async function dbRestCall(
  hafasId: string,
  board: StopBoard,
  whenIso?: string,
): Promise<DbRestDeparture[]> {
  const url = new URL(`${config.DBREST_BASE_URL}/stops/${encodeURIComponent(hafasId)}/${board}`);
  url.searchParams.set("duration", "720");
  url.searchParams.set("results", "20");
  url.searchParams.set("stopovers", "false");
  url.searchParams.set("remarks", "false");
  url.searchParams.set("language", "de");
  if (whenIso) url.searchParams.set("when", whenIso);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`db-rest ${res.status} for ${url}`);
    const data = (await res.json()) as { departures?: DbRestDeparture[]; arrivals?: DbRestDeparture[] } | DbRestDeparture[];
    return Array.isArray(data)
      ? data
      : board === "departures"
        ? (data.departures ?? [])
        : (data.arrivals ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/** Kollabiert identische Departures: gleiche Planzeit + Linie + Richtung →
 *  ein Eintrag. HAFAS liefert manchmal dasselbe Trip-Item doppelt (z.B. wenn
 *  eine Linie als verschiedene Produkte/Operator-Codes registriert ist). User
 *  soll im StopBoard nicht „3× Bus 245 → Krefeld um 18:08" sehen. */
function dedupeStopItems(items: StopBoardItem[]): StopBoardItem[] {
  const seen = new Set<string>();
  const out: StopBoardItem[] = [];
  for (const it of items) {
    // Normalisierung: Linien-Name lowercase + Whitespace raus, Direction
    // case-insensitive. Zeit ist schon ISO → direkt vergleichbar.
    const lineKey = it.line.toLowerCase().replace(/\s+/g, "");
    const dirKey = it.direction.toLowerCase().trim();
    const key = `${it.plannedTime}|${lineKey}|${dirKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Multi-Hafas-Pfad für AT/PL/LU/DK. Nutzt hafas-client npm in-process
 *  (kein extra Docker-Container). Kein Budget-Throttling — die Backends haben
 *  eigene Rate-Limits, die wir per Profil monitoring könnten falls's wichtig
 *  wird. Aktuell „best effort": Fehler → leeres Result, sicher cache-bar. */
async function fetchFromMultiHafas(
  hafasId: string,
  board: StopBoard,
  profile: MultiHafasProfileKey,
): Promise<StopBoardResponse> {
  const fetchFn = board === "departures" ? multiFetchDepartures : multiFetchArrivals;
  let raw: Awaited<ReturnType<typeof fetchFn>> = [];
  try {
    raw = await fetchFn(profile, hafasId, { results: 25, duration: 180 });
  } catch {
    // Profil-Fehler / Timeout / unbekannter Stop — leere Liste statt 500.
    raw = [];
  }
  // hafas-client `Alternative` ist strukturell identisch zu DbRestDeparture
  // (gleiche Library-Vorlage). Cast ist sauber, weil normalize() nur die
  // Schnittmenge an Feldern liest.
  const normalized = (raw as DbRestDeparture[])
    .map((r, i) => normalize(r, board, i))
    .filter((r): r is StopBoardItem => r !== null);
  const results = dedupeStopItems(normalized).slice(0, MAX_RESULTS);
  const fetchedAt = new Date().toISOString();
  return {
    results,
    fetchedAt,
    validUntil: new Date(Date.now() + HOT_TTL_MS).toISOString(),
  };
}

async function fetchFromDbRest(
  hafasId: string,
  board: StopBoard,
  priority: "user" | "background",
): Promise<StopBoardResponse> {
  // HAFAS-Quirk: bei sparsam bedienten Stationen (z.B. Werl 02:00 nachts)
  // antwortet db-vendo mit `[]` auch wenn der nächste Zug in 5 h fährt —
  // HAFAS hat einen internen Lookahead-Cut der die Suche bei Off-Peak vorzeitig
  // abbricht. Workaround: wenn die erste Anfrage leer kommt, fragen wir mit
  // verschobenem `when` weiter (+4 h, +8 h, +12 h). Erste nicht-leere Antwort
  // gewinnt. Tagsüber an einer normalen Station feuert nur 1 Call.
  //
  // Jeder Retry verbraucht einen Slot aus dem entsprechenden Budget-Topf:
  //   - priority="user"       → claimUserBudget (bis 50/min Hard-Cap)
  //   - priority="background" → claimBackgroundBudget (bis 38/min, User-Reserve frei)
  // Wenn das jeweilige Budget alle ist, brechen wir den Retry-Versuch ab —
  // bei Background-Tasks bedeutet das im Worst Case „Refresh schlägt fehl,
  // Cache bleibt stale" (next access enqueued neu).
  const claim = priority === "user" ? claimUserBudget : claimBackgroundBudget;
  const offsetsH = [0, 4, 8, 12];
  let list: DbRestDeparture[] = [];
  for (const offset of offsetsH) {
    if (!claim()) break;
    const whenIso = offset === 0 ? undefined : new Date(Date.now() + offset * 3_600_000).toISOString();
    list = await dbRestCall(hafasId, board, whenIso);
    if (list.length > 0) break;
  }
  // Dedupe BEVOR slice — sonst kicken Duplikate echte unique Einträge aus dem
  // Top-N. HAFAS doppelt manchmal (Operator-/Produkt-Aliase) und das sahen wir
  // im DE-Pfad bisher auch.
  const normalized = list
    .map((r, i) => normalize(r, board, i))
    .filter((r): r is StopBoardItem => r !== null);
  const results = dedupeStopItems(normalized).slice(0, MAX_RESULTS);
  const fetchedAt = new Date().toISOString();
  return {
    results,
    fetchedAt,
    validUntil: new Date(Date.now() + HOT_TTL_MS).toISOString(),
  };
}

/**
 * Holt Departures/Arrivals für eine HAFAS-Station-ID.
 *
 * Cache-Strategie (Stale-While-Revalidate):
 *   - Cache <2.5min alt → instant return, kein Refresh
 *   - 2.5–5min alt + hot stop → instant return + Background-Refresh
 *   - 5–10min alt + cold stop → instant return + Background-Refresh
 *   - >15min alt → Cache verworfen, synchroner Fetch
 *   - Inflight-Coalescing: 100 parallele Anfragen für denselben Stop → 1 Call
 *   - Outbound-Throttle: hard cap 50/min, danach Cache-only Mode
 *
 * `internal: true` markiert Pre-Cache-Calls — die dürfen synchronen Fetch
 * machen ohne als „nutzer-getriggert" gezählt zu werden (Hot/Cold-Tracking).
 */
export async function getStopBoard(
  hafasId: string,
  board: StopBoard,
  profile: HafasProfileKey = "db",
  opts: { internal?: boolean } = {},
): Promise<StopBoardResponse> {
  const key = cacheKey(hafasId, board, profile);
  if (!opts.internal) trackAccess(key);

  const cached = cache.get(key);
  const now = Date.now();

  if (cached) {
    const age = now - cached.cachedAt;
    const ttl = isHot(key) ? HOT_TTL_MS : COLD_TTL_MS;
    if (age < ttl) {
      // Fresh enough. Trigger Background-Refresh wenn wir über SWR-Schwelle.
      if (age >= SWR_REFRESH_AT_MS && !cached.refreshing) {
        triggerBackgroundRefresh(hafasId, board, profile, key);
      }
      return cached.data;
    }
    // Stale aber unter Hard-Limit → SWR fires synchronously below if no inflight
    if (age < HARD_MAX_AGE_MS) {
      const existing = inflight.get(key);
      if (existing) {
        // Refresh läuft schon → wir liefern den stale Cache aus.
        return cached.data;
      }
      // Wir feuern jetzt synchron — Caller wartet auf frisches Ergebnis.
    }
  }

  const existing = inflight.get(key);
  if (existing) return existing;

  // Synchroner User-Fetch. Bei DE läuft das durch fetchFromDbRest mit
  // Budget-Claim; bei Multi-Hafas-Profilen (AT/PL/LU/DK) direkt durch
  // hafas-client in-process. Kein Background-Queue für Non-DE — wir refreshen
  // dort nur on-demand, der dbVendoQueue ist DB-spezifisch.
  const promise = fetchBoard(hafasId, board, profile, "user")
    .then((data) => {
      cache.set(key, { data, cachedAt: Date.now(), ttlMs: HOT_TTL_MS, refreshing: false });
      return data;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Dispatcher: routet pro Profil entweder an den DE-spezifischen
 *  dbrest-Container oder an hafas-client npm in-process. Beide Pfade liefern
 *  die selbe `StopBoardResponse`-Shape; die normalize() + dedup-Schritte sind
 *  identisch. */
async function fetchBoard(
  hafasId: string,
  board: StopBoard,
  profile: HafasProfileKey,
  priority: "user" | "background",
): Promise<StopBoardResponse> {
  if (profile === "db") {
    return fetchFromDbRest(hafasId, board, priority);
  }
  return fetchFromMultiHafas(hafasId, board, profile);
}

/** Stellt einen Background-Refresh in die geteilte db-vendo-Queue. Der
 *  Worker arbeitet sie ab, sobald Background-Budget frei ist. Caller
 *  bekommt sofort den stale Cache — frische Daten landen für nachfolgende
 *  Caller in der Map.
 *
 *  Nur für `profile === "db"` aktiv — die dbVendoQueue ist DB-spezifisch
 *  (Budget-System hängt am dbrest-Container). Für AT/PL/LU/DK gibt's keinen
 *  Background-Refresh; der Cache wird bei nächstem Access neu gefüllt. */
function triggerBackgroundRefresh(
  hafasId: string,
  board: StopBoard,
  profile: HafasProfileKey,
  key: string,
): void {
  if (profile !== "db") return;
  const entry = cache.get(key);
  if (entry) entry.refreshing = true;
  enqueueRefresh({
    key: `stopBoard:${key}`,
    priority: isHot(key) ? 10 : 1,
    // Stop-Board-Daten älter als 3 min wären beim Abarbeiten kaum noch
    // relevant — Departures wandern minütlich. Lieber den Task verfallen
    // lassen und beim nächsten Access neu enqueuen.
    maxAgeMs: 3 * 60_000,
    execute: async () => {
      try {
        const data = await fetchFromDbRest(hafasId, board, "background");
        cache.set(key, { data, cachedAt: Date.now(), ttlMs: HOT_TTL_MS, refreshing: false });
      } catch {
        const e = cache.get(key);
        if (e) e.refreshing = false;
      }
    },
  });
}

/** Räumt abgelaufene Cache-Entries weg — wird periodisch vom Server-Lifecycle
 *  aufgerufen, damit der Cache nicht ewig wächst. Hard-Limit ist 15min Alter:
 *  alles darüber ist sowieso unbrauchbar (Daten wären zu stale für Live-Use). */
export function evictExpiredStopBoards(): number {
  const now = Date.now();
  let evicted = 0;
  for (const [k, v] of cache) {
    if (now - v.cachedAt > HARD_MAX_AGE_MS) {
      cache.delete(k);
      evicted++;
    }
  }
  // Access-Log Aufräumarbeit: Stops die in der Track-Window keinen Zugriff
  // mehr hatten → komplett aus dem accessLog raus.
  for (const [k, log] of accessLog) {
    while (log.length > 0 && log[0]! < now - ACCESS_TRACK_WINDOW_MS) log.shift();
    if (log.length === 0) accessLog.delete(k);
  }
  return evicted;
}

/** Liefert die Top-N Cache-Keys nach Zugriffs-Frequenz in der letzten Stunde.
 *  Wird vom Pre-Cache-Job genutzt um die heißesten Stops im Hintergrund zu
 *  refreshen, bevor User-Requests sie aus dem Cache verdrängen. */
export function getHottestKeys(limit: number): { hafasId: string; board: StopBoard }[] {
  const cutoff = Date.now() - ACCESS_TRACK_WINDOW_MS;
  const ranked: { key: string; count: number }[] = [];
  for (const [k, log] of accessLog) {
    let count = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]! < cutoff) break;
      count++;
    }
    if (count > 0) ranked.push({ key: k, count });
  }
  ranked.sort((a, b) => b.count - a.count);
  const out: { hafasId: string; board: StopBoard }[] = [];
  for (const { key } of ranked.slice(0, limit)) {
    const [board, hafasId] = key.split(":", 2);
    if (!board || !hafasId) continue;
    out.push({ hafasId, board: board as StopBoard });
  }
  return out;
}

/**
 * Löst Coords zu einer HAFAS-Station-ID auf. Nötig für Stops in unserer DB
 * die keine 7-stellige HAFAS-ID haben (GTFS-Bus-Stops, GTFS-Subway-Plattformen).
 * db-rest's `/locations/nearby` liefert für jede Coord-Position die nächst-
 * gelegenen Stops mit ihren HAFAS-IDs (auch 6-stellige für Subway/Bus).
 *
 * Cache: 24h pro (lat, lng, label) — Mapping ist stabil. Resolver ist im
 * Pfad „User klickt Marker → API muss schnell antworten" → Cache zwingend.
 */
interface ResolveEntry {
  hafasId: string | null;
  expiresAt: number;
}
const resolveCache = new Map<string, ResolveEntry>();
const resolveInflight = new Map<string, Promise<string | null>>();
const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;

interface DbRestNearby {
  id?: string;
  name?: string;
  type?: string;
  location?: { latitude?: number; longitude?: number };
  distance?: number;
  products?: Record<string, boolean>;
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[(),.;:/\-]/g, " ")
    .replace(/\bbahnhof\b|\bhbf\.?\b|\bbf\.?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function resolveHafasByCoord(
  lat: number,
  lng: number,
  label: string,
  profile: HafasProfileKey = "db",
  /** Erwarteter Stop-Typ aus unserer DB. Wenn gesetzt, filtert der Resolver
   *  HAFAS-Treffer nach passenden Produkten:
   *    - BUS   → nur Stops mit `products.bus=true`, OHNE national/regional
   *              (so wird ein direkt benachbarter Bahnhof nicht fälschlich
   *              die Bus-Departures eines Bus-Stops liefern)
   *    - TRAIN → nur Stops mit national/regional/suburban, kein reiner Bus
   *  Ohne expectedType (oder ALL): kein Filter (z.B. Stadt-Lookup). */
  expectedType?: "BUS" | "TRAIN" | "ALL" | null,
): Promise<string | null> {
  // Profile + expectedType im Cache-Key — sonst würde ein vorheriger TRAIN-
  // Resolve den BUS-Resolve mit der Train-Station beantworten.
  const key = `${profile}|${expectedType ?? ""}|${lat.toFixed(5)}|${lng.toFixed(5)}|${label.toLowerCase()}`;

  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.hafasId;

  const existing = resolveInflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<string | null> => {
    // Non-DE Profile: hafas-client npm direkt — kein dbrest-Container hat
    // diese Daten.
    if (profile !== "db") {
      return multiResolveStation(profile, lat, lng, label);
    }
    const url = new URL(`${config.DBREST_BASE_URL}/locations/nearby`);
    url.searchParams.set("latitude", String(lat));
    url.searchParams.set("longitude", String(lng));
    url.searchParams.set("distance", "300");
    url.searchParams.set("results", "8");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const listRaw = (await res.json()) as DbRestNearby[];
      if (!Array.isArray(listRaw) || listRaw.length === 0) return null;

      // Type-Filter: Stops mit dem passenden Verkehrsmittel auswählen.
      // Bus-Filter: nur `bus=true` verlangen — Multi-Modal-Stops (z.B.
      // „Berlin Staaken Bhf" mit Regional+Bus) müssen weiterhin als Match
      // möglich sein. Würden wir wie früher national/regional ausschließen,
      // landen wir auf einem entfernteren reinen Bus-Stop statt am echten
      // Bahnhofs-Vorplatz. Die Mixed-Departures bekommen wir nachher via
      // Product-Filter in routes/stops.ts auf Bus-only gefiltert.
      // Train-Filter: muss mindestens ein Schienen-Produkt haben (sonst
      // landen wir auf einem Bus-Stop nebenan).
      const matchesType = (x: DbRestNearby): boolean => {
        if (!expectedType || expectedType === "ALL") return true;
        const p = x.products ?? {};
        if (expectedType === "BUS") return !!p.bus;
        if (expectedType === "TRAIN") {
          return !!(p.national || p.regional || p.regionalExpress || p.suburban || p.subway || p.tram);
        }
        return true;
      };
      const filtered = listRaw.filter(matchesType);
      // Wenn der Filter alles wegfiltert → benutze die unfiltered Liste
      // (Fallback: lieber irgendwas als nichts).
      const list = filtered.length > 0 ? filtered : listRaw;

      // Token-Set-Matching ist primär: zerlegt Label + HAFAS-Namen in Wort-
      // Tokens, scort nach Overlap. Order-unabhängig (HAFAS dreht oft Word-
      // Reihenfolge: „Hamm, Westtünnen/Dambergstr." in DB vs „Westtünnen/
      // Dambergstr., Hamm (Westf)" in HAFAS).
      // Stop-Words (bahnhof/westf/…) raus weil sie zu generisch sind. ABER:
      // „Hbf"/„Hauptbahnhof" BEHALTEN — sie sind distinkt (Berlin Hbf vs
      // Berlin Mahlsdorf). Über den Alias unifizieren wir die zwei
      // Schreibweisen damit „Berlin Hbf" und „Berlin Hauptbahnhof" matchen.
      // „Bhf" / „bf" sind Kurzformen → auf „hbf" alias-normalisieren falls
      // sie als Bahnhofs-Marker funktionieren sollen (statt Stop-Word zu sein).
      const RESOLVER_STOP_WORDS = new Set([
        "bahnhof", "bahnhst", "stop", "halt",
        "haltestelle", "station", "westf", "westfalen", "westfälisch",
      ]);
      const RESOLVER_ALIASES: Record<string, string> = {
        hauptbahnhof: "hbf",
        bhf: "hbf",
        bf: "hbf",
      };
      const tokenize = (s: string): Set<string> => {
        const cleaned = s.toLowerCase().replace(/[(),.;:/\-]/g, " ").replace(/\s+/g, " ").trim();
        const out = new Set<string>();
        for (const w of cleaned.split(" ")) {
          if (w.length <= 2) continue;
          const mapped = RESOLVER_ALIASES[w] ?? w;
          if (!RESOLVER_STOP_WORDS.has(mapped)) out.add(mapped);
        }
        return out;
      };
      const targetTokens = tokenize(label);

      let bestId: string | null = null;
      let bestOverlap = 0;
      for (const x of list) {
        if (!x.id || !x.name) continue;
        const cTokens = tokenize(x.name);
        let overlap = 0;
        for (const t of cTokens) if (targetTokens.has(t)) overlap++;
        // > statt >= damit bei Gleichstand der ERSTE (= nächstgelegene)
        // Treffer gewinnt; db-vendo sortiert nach Distance.
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestId = x.id;
        }
      }
      // Mindestens 1 Token muss matchen — sonst Fallback auf nächstgelegen.
      if (bestId && bestOverlap >= 1) return bestId;

      // Fallback ohne Token-Match: nur für TRAIN bevorzugen wir station-Type
      // (Train-Aggregations-Stops liefern alle Plattformen auf einmal).
      // Für BUS/ALL keinen station-Bias — der pickt sonst entfernte Bahnhöfe
      // statt nahe Bus-Haltestellen.
      if (expectedType === "TRAIN" || !expectedType) {
        const station = list.find((x) => x.id && x.type === "station");
        if (station?.id) return station.id;
      }

      return list[0]?.id ?? null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().then((id) => {
    resolveCache.set(key, { hafasId: id, expiresAt: Date.now() + RESOLVE_TTL_MS });
    return id;
  }).finally(() => {
    resolveInflight.delete(key);
  });

  resolveInflight.set(key, promise);
  return promise;
}
