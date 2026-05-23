/**
 * Departure-/Arrival-Lookup aus den importierten GTFS-Schedule-Tabellen.
 *
 * Für Länder ohne HAFAS-Profile (NL/FR/IT/ES/CZ/etc.) ist das unser einziger
 * Weg an Fahrplandaten — wir importieren die offiziellen GTFS-Feeds (open
 * data) und beantworten Anfragen via SQL-JOIN.
 *
 * Trade-off vs. HAFAS: keine Live-Verspätungen, dafür komplette Coverage und
 * kein API-Rate-Limit. Für ÖPNV-Use-Case ist „planmäßig" meistens gut genug.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import type { StopBoard, StopBoardItem, StopBoardResponse } from "./stopInfoService.js";

/** Feed-Id pro Land. Was Wertelisten haben sollen, muss zur `feed_id`-Wert im
 *  GTFS-Importer passen (`GTFS_FEED_ID` env var beim Import). */
export const FEED_ID_BY_COUNTRY: Record<string, string> = {
  Netherlands: "nl-ovapi",
  France: "fr-transport",
  Italy: "it-gtfs",
  Spain: "es-gtfs",
  "Czech Republic": "cz-gtfs",
  Belgium: "be-gtfs",
  Hungary: "hu-gtfs",
  Slovakia: "sk-gtfs",
  "United Kingdom": "gb-gtfs",
  Portugal: "pt-gtfs",
};

/** Prüft ob für diesen Stop ein GTFS-Schedule-Feed in der DB liegt. Schneller
 *  als COUNT(*) — wir gucken nur ob mindestens ein stop_time-Eintrag für die
 *  feed_id existiert. */
const feedReadyCache = new Map<string, { ready: boolean; expiresAt: number }>();
const FEED_READY_TTL_MS = 5 * 60_000;

export async function isFeedImported(feedId: string): Promise<boolean> {
  const cached = feedReadyCache.get(feedId);
  if (cached && cached.expiresAt > Date.now()) return cached.ready;
  const rows = (await db.execute(
    sql`SELECT 1 FROM gtfs_stop_times WHERE feed_id = ${feedId} LIMIT 1`,
  )) as unknown as { rows: unknown[] } | unknown[];
  const list = Array.isArray(rows) ? rows : rows.rows;
  const ready = list.length > 0;
  feedReadyCache.set(feedId, { ready, expiresAt: Date.now() + FEED_READY_TTL_MS });
  return ready;
}

/** GTFS-Route-Type → unser Product-String (gleiche Konvention wie HAFAS).
 *  0=tram, 1=metro, 2=rail, 3=bus, 4=ferry, 5=cable-car, 6=gondola, 7=funicular */
function routeTypeToProduct(t: number): string {
  if (t === 0) return "tram";
  if (t === 1) return "subway";
  if (t === 2) return "regional";
  if (t === 3) return "bus";
  if (t === 4) return "ferry";
  if (t === 5 || t === 6 || t === 7) return "cable";
  // Extended GTFS-Route-Types (100s = rail, 200s = coach, 700s = bus, 900s = tram)
  if (t >= 100 && t <= 199) return "regional";
  if (t >= 200 && t <= 299) return "coach";
  if (t >= 400 && t <= 499) return "subway";
  if (t >= 700 && t <= 799) return "bus";
  if (t >= 900 && t <= 999) return "tram";
  if (t >= 1000 && t <= 1099) return "ferry";
  return "bus";
}

/** Macht aus dem `locations.code` (z.B. `gtfs:nl:stoparea:525388`) die nackte
 *  GTFS-stop_id (`stoparea:525388`) — das wird im GTFS-Feed verwendet. */
function gtfsStopIdFromCode(code: string): string | null {
  // gtfs:<country>:<rest>
  const m = code.match(/^gtfs:[a-z]{2,3}:(.+)$/i);
  return m && m[1] ? m[1] : null;
}

/** Liefert die in Europe/<Local> kalkulierte Mitternachts-Zeit von „heute"
 *  als UTC-ms. Für die GTFS-Departure-Sekunden müssen wir wissen ab wann
 *  „seconds since midnight" zählen.
 *  Vereinfachung: wir nutzen die Server-Local-Zeit, da unser Stack eh in
 *  Europe/Berlin läuft. Für strikte Per-Country-Zeit-Genauigkeit müssten wir
 *  das pro Land in der jeweiligen TZ rechnen — für jetzt akzeptabel weil
 *  Europe nur 1h Unterschied hat. */
function localMidnightMs(now: Date): number {
  const local = new Date(now);
  local.setHours(0, 0, 0, 0);
  return local.getTime();
}

/** Wochentag-Spalte für gtfs_calendar als String. Day 0 = Sonntag, 1 = Montag,
 *  ..., 6 = Samstag. */
function weekdayColumn(d: Date): string {
  const idx = d.getDay();
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][idx]!;
}

/** Holt die Service-IDs die heute (für `feed_id`) aktiv sind. Berücksichtigt
 *  calendar (Default-Wochenmuster) UND calendar_dates (Ausnahmen: hinzugefügt
 *  oder entfernt). Cache hier — der Service-Set ändert sich nur einmal pro
 *  Tag. */
const serviceIdsCache = new Map<string, { ids: Set<string>; expiresAt: number }>();

async function activeServiceIds(feedId: string, now: Date): Promise<Set<string>> {
  const dateStr = now.toISOString().slice(0, 10);
  const cacheKey = `${feedId}:${dateStr}`;
  const cached = serviceIdsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  const weekday = weekdayColumn(now);
  // Inline-SQL für Wochentag-Spalte — Drizzle hat hier keine elegante
  // Lösung weil die Spalte dynamisch ist. weekday ist hardcoded aus 7
  // bekannten Werten, daher safe gegen Injection.
  const weekdayCol = sql.raw(weekday);
  const calRows = (await db.execute(sql`
    SELECT service_id FROM gtfs_calendar
    WHERE feed_id = ${feedId}
      AND start_date <= ${dateStr}::date
      AND end_date >= ${dateStr}::date
      AND ${weekdayCol} = true
  `)) as unknown as { rows: Array<{ service_id: string }> };
  const exRows = (await db.execute(sql`
    SELECT service_id, exception_type FROM gtfs_calendar_dates
    WHERE feed_id = ${feedId} AND date = ${dateStr}::date
  `)) as unknown as { rows: Array<{ service_id: string; exception_type: number }> };

  const ids = new Set<string>();
  for (const r of calRows.rows ?? []) ids.add(r.service_id);
  for (const r of exRows.rows ?? []) {
    if (r.exception_type === 1) ids.add(r.service_id);
    else if (r.exception_type === 2) ids.delete(r.service_id);
  }
  serviceIdsCache.set(cacheKey, { ids, expiresAt: Date.now() + 60 * 60_000 });
  return ids;
}

interface DepartureRow {
  trip_id: string;
  departure_seconds: number;
  arrival_seconds: number;
  headsign: string | null;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
}

const MAX_RESULTS = 20;
const WINDOW_MINUTES = 120; // wie weit nach vorne schauen für departures

/** Liefert Departures/Arrivals für einen Stop via lokale GTFS-Schedule-DB.
 *  Returns null wenn der Feed für dieses Land nicht importiert ist (Caller
 *  fällt dann auf HAFAS/empty zurück). */
export async function getScheduledStopBoard(args: {
  stopCode: string;
  country: string | null;
  board: StopBoard;
  /** Lat/Lon des Stops aus `locations` — nötig für OSM-Stops, damit wir
   *  per Coord den nächsten GTFS-Stop finden können. */
  latitude?: number | null;
  longitude?: number | null;
}): Promise<StopBoardResponse | null> {
  if (!args.country) return null;
  const feedId = FEED_ID_BY_COUNTRY[args.country];
  if (!feedId) return null;
  if (!(await isFeedImported(feedId))) return null;

  // Wege um den Stop in den GTFS-Tabellen zu finden:
  //   A) `gtfs:<country>:<id>` — Code-Präfix → direkter ID-Mapping
  //   B) `osm:<id>` — OSM-Marker → Coord-Lookup nächster GTFS-Stop
  //   C) `sta:<uic>` o.ä. — wenn auch keine Coords, kein Treffer
  let allStopIds: string[] = [];
  const directStopId = gtfsStopIdFromCode(args.stopCode);
  if (directStopId) {
    // Direkter ID-Path: Stoparea → alle Platform-Children auflösen.
    const stopIdRows = (await db.execute(sql`
      SELECT stop_id FROM gtfs_stops
      WHERE feed_id = ${feedId} AND (stop_id = ${directStopId} OR parent_station = ${directStopId})
    `)) as unknown as { rows: Array<{ stop_id: string }> };
    allStopIds = (stopIdRows.rows ?? []).map((r) => r.stop_id);
    if (allStopIds.length === 0) allStopIds.push(directStopId);
  } else if (args.latitude != null && args.longitude != null) {
    // OSM-Stop oder anderer Coord-only-Path: nächstgelegenen gtfs-Stop binnen
    // ~80m suchen. Box-Filter zuerst (Index-Hit), dann Distanz-Approximation
    // (cos für lon-Skalierung). 0.001° ≈ 100m bei 50°N — eng genug damit's
    // nicht den Stop auf der anderen Straßenseite oder einen entfernten Bus-
    // halt verwechselt.
    const lat = args.latitude;
    const lon = args.longitude;
    const dLat = 0.0009; // ~100m
    const dLon = 0.0009 / Math.cos((lat * Math.PI) / 180);
    const nearbyRows = (await db.execute(sql`
      SELECT stop_id, parent_station, latitude, longitude
      FROM gtfs_stops
      WHERE feed_id = ${feedId}
        AND latitude BETWEEN ${lat - dLat} AND ${lat + dLat}
        AND longitude BETWEEN ${lon - dLon} AND ${lon + dLon}
      ORDER BY (latitude - ${lat}) * (latitude - ${lat}) + (longitude - ${lon}) * (longitude - ${lon})
      LIMIT 5
    `)) as unknown as { rows: Array<{ stop_id: string; parent_station: string | null }> };
    if ((nearbyRows.rows ?? []).length === 0) return emptyResponse();
    // Wenn der nächste Stop ein Child ist (parent_station gesetzt), nimm
    // ALLE Stops mit demselben parent — sonst nur den selbst plus mögliche
    // Children unter dem Stop selbst.
    const first = nearbyRows.rows[0]!;
    const parentOrSelf = first.parent_station ?? first.stop_id;
    const idsRows = (await db.execute(sql`
      SELECT stop_id FROM gtfs_stops
      WHERE feed_id = ${feedId} AND (stop_id = ${parentOrSelf} OR parent_station = ${parentOrSelf})
    `)) as unknown as { rows: Array<{ stop_id: string }> };
    allStopIds = (idsRows.rows ?? []).map((r) => r.stop_id);
    if (allStopIds.length === 0) allStopIds.push(first.stop_id);
  } else {
    return null;
  }

  if (allStopIds.length === 0) return emptyResponse();

  const now = new Date();
  const services = await activeServiceIds(feedId, now);
  if (services.size === 0) return emptyResponse();

  const midnightMs = localMidnightMs(now);
  const nowSec = Math.floor((now.getTime() - midnightMs) / 1000);
  // Window: vorwärts (departures) bzw. rückwärts (arrivals) ~2h.
  const fromSec = args.board === "departures" ? nowSec - 5 * 60 : nowSec - WINDOW_MINUTES * 60;
  const toSec = args.board === "departures" ? nowSec + WINDOW_MINUTES * 60 : nowSec + 5 * 60;

  // Service-ID-IN-Liste — Postgres-array-Param. Drizzle/postgres-js akzeptieren
  // Arrays direkt als Bind-Param.
  const serviceList = Array.from(services);

  // Inner CTEs nutzen `st` (gtfs_stop_times); das äußere SELECT iteriert
  // über `combined c` und muss den `c`-Alias verwenden, sonst "missing
  // FROM-clause entry for table st".
  const timeCol = args.board === "departures" ? sql`st.departure_seconds` : sql`st.arrival_seconds`;
  const orderCol = args.board === "departures" ? sql`c.departure_seconds` : sql`c.arrival_seconds`;

  // Auch das nächste Tagessegment (Service-IDs von gestern, deren Trips über
  // Mitternacht hinauslaufen — GTFS erlaubt seconds > 86400). Wenn unsere
  // current `nowSec` knapp nach Mitternacht ist (z.B. 00:30 = 1800s), könnte
  // ein Trip von gestern mit `departure_seconds=88200` (= 24:30 = 0:30 next
  // day) für uns relevant sein. Wir prüfen das durch ein zweites Window
  // verschoben um +86400.
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
  const yesterdayServices = await activeServiceIds(feedId, yesterday);
  const ySvcList = Array.from(yesterdayServices);

  const rows = (await db.execute(sql`
    WITH today_trips AS (
      SELECT trip_id, route_id, headsign
      FROM gtfs_trips
      WHERE feed_id = ${feedId} AND service_id = ANY(${sql.raw(`ARRAY[${serviceList.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    ),
    today_stops AS (
      SELECT st.trip_id, st.departure_seconds, st.arrival_seconds, tt.headsign, tt.route_id
      FROM gtfs_stop_times st
      INNER JOIN today_trips tt ON tt.trip_id = st.trip_id
      WHERE st.feed_id = ${feedId}
        AND st.stop_id = ANY(${sql.raw(`ARRAY[${allStopIds.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
        AND ${timeCol} >= ${fromSec}
        AND ${timeCol} <= ${toSec}
    ),
    -- Trips von gestern die über Mitternacht hinauslaufen (sec > 86400).
    yesterday_trips AS (
      SELECT trip_id, route_id, headsign
      FROM gtfs_trips
      WHERE feed_id = ${feedId} AND service_id = ANY(${sql.raw(`ARRAY[${ySvcList.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
    ),
    yesterday_stops AS (
      SELECT st.trip_id,
             st.departure_seconds - 86400 AS departure_seconds,
             st.arrival_seconds - 86400 AS arrival_seconds,
             yt.headsign, yt.route_id
      FROM gtfs_stop_times st
      INNER JOIN yesterday_trips yt ON yt.trip_id = st.trip_id
      WHERE st.feed_id = ${feedId}
        AND st.stop_id = ANY(${sql.raw(`ARRAY[${allStopIds.map((s) => `'${s.replace(/'/g, "''")}'`).join(",")}]::text[]`)})
        AND ${timeCol} >= 86400
        AND ${timeCol} - 86400 >= ${fromSec}
        AND ${timeCol} - 86400 <= ${toSec}
    ),
    combined AS (
      SELECT * FROM today_stops
      UNION ALL
      SELECT * FROM yesterday_stops
    )
    SELECT c.trip_id, c.departure_seconds, c.arrival_seconds, c.headsign,
           r.short_name AS route_short_name,
           r.long_name AS route_long_name,
           r.type AS route_type
    FROM combined c
    LEFT JOIN gtfs_routes r ON r.feed_id = ${feedId} AND r.route_id = c.route_id
    ORDER BY ${orderCol}
    LIMIT ${MAX_RESULTS}
  `)) as unknown as { rows: DepartureRow[] };

  const items: StopBoardItem[] = [];
  for (const r of rows.rows ?? []) {
    const timeSec = args.board === "departures" ? r.departure_seconds : r.arrival_seconds;
    const ts = new Date(midnightMs + timeSec * 1000);
    items.push({
      id: r.trip_id,
      plannedTime: ts.toISOString(),
      actualTime: ts.toISOString(),
      delayMinutes: null,
      line: (r.route_short_name ?? r.route_long_name ?? "—").trim() || "—",
      product: routeTypeToProduct(r.route_type),
      direction: (r.headsign ?? "").trim(),
      platform: null,
      cancelled: false,
    });
  }

  return {
    results: items,
    fetchedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60_000).toISOString(),
  };
}

function emptyResponse(): StopBoardResponse {
  const now = new Date();
  return {
    results: [],
    fetchedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60_000).toISOString(),
  };
}
