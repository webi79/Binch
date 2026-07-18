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
  //   B) `osm:<id>` / `sta:<uic>` — Coord-Lookup nächster GTFS-Stop
  //
  // Beide Pfade landen am Ende mit derselben Coord-Fallback-Logik wenn die
  // direkte ID-Suche keine echten Children findet (kommt in NL/FR vor wo
  // manche stoparea-Parents keine parent_station-Pointer von ihren Platforms
  // bekommen → SELECT findet nur die Parent-Row aber stop_times referenzieren
  // nur Platforms → leere Antwort obwohl Daten da wären).
  async function coordLookup(lat: number, lon: number): Promise<string[]> {
    // Großzügiger als beim OSM-Marker (~250m) weil StaDa-Coords manchmal
    // 100-200m vom GTFS-stoparea-Zentrum abweichen (StaDa zeigt aufs
    // Bahnhofs-Gebäude, GTFS auf den Bahnsteig-Mitte).
    const radiusM = 250;
    const dLat = radiusM / 111_000;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const nearbyRows = (await db.execute(sql`
      SELECT stop_id, parent_station, location_type
      FROM gtfs_stops
      WHERE feed_id = ${feedId}
        AND latitude BETWEEN ${lat - dLat} AND ${lat + dLat}
        AND longitude BETWEEN ${lon - dLon} AND ${lon + dLon}
      ORDER BY
        -- Bevorzuge location_type=1 (Stations) vor 0 (Platforms) — die
        -- Station ist meist im Zentrum und hat alle Plattformen als Kinder.
        CASE WHEN location_type = 1 THEN 0 ELSE 1 END,
        (latitude - ${lat}) * (latitude - ${lat}) + (longitude - ${lon}) * (longitude - ${lon})
      LIMIT 10
    `)) as unknown as {
      rows: Array<{ stop_id: string; parent_station: string | null; location_type: number | null }>;
    };
    const list = nearbyRows.rows ?? [];
    if (list.length === 0) return [];
    const first = list[0]!;
    const parentOrSelf = first.parent_station ?? first.stop_id;
    const idsRows = (await db.execute(sql`
      SELECT stop_id FROM gtfs_stops
      WHERE feed_id = ${feedId} AND (stop_id = ${parentOrSelf} OR parent_station = ${parentOrSelf})
    `)) as unknown as { rows: Array<{ stop_id: string }> };
    const ids = (idsRows.rows ?? []).map((r) => r.stop_id);
    if (ids.length > 0) return ids;
    return [first.stop_id];
  }

  let allStopIds: string[] = [];
  const directStopId = gtfsStopIdFromCode(args.stopCode);
  if (directStopId) {
    // Direkter ID-Path: Stoparea → alle Platform-Children auflösen.
    const stopIdRows = (await db.execute(sql`
      SELECT stop_id FROM gtfs_stops
      WHERE feed_id = ${feedId} AND (stop_id = ${directStopId} OR parent_station = ${directStopId})
    `)) as unknown as { rows: Array<{ stop_id: string }> };
    allStopIds = (stopIdRows.rows ?? []).map((r) => r.stop_id);

    // Edge-Case: nur die Parent-Row gefunden, keine Children. Heißt: das
    // Feed listet zwar die stoparea als gtfs_stops-Eintrag, aber die
    // Plattformen darunter haben kein parent_station gesetzt das auf uns
    // zeigt. Dann findet auch das stop_times-Query nichts (stop_times
    // referenziert nur Plattformen, nicht Stopareas). → Coord-Fallback.
    const onlyParent = allStopIds.length === 1 && allStopIds[0] === directStopId;
    if ((allStopIds.length === 0 || onlyParent) && args.latitude != null && args.longitude != null) {
      const fallback = await coordLookup(args.latitude, args.longitude);
      if (fallback.length > 0) allStopIds = fallback;
    }
    if (allStopIds.length === 0) allStopIds.push(directStopId);
  } else if (args.latitude != null && args.longitude != null) {
    allStopIds = await coordLookup(args.latitude, args.longitude);
  } else {
    return null;
  }

  // WICHTIG: null, nicht emptyResponse. Hierher kommt man nur, wenn der
  // Coord-Lookup im lokalen Feed NICHTS im 250-m-Radius fand — der Stop
  // liegt dann außerhalb der Coverage dieses Feeds (fr-transport hat z.B.
  // nur ~350 Stops, be-gtfs nur Bahn). Ein leeres Board hätte in stops.ts
  // den MOTIS-Fallback abgewürgt: praktisch jede französische/belgische
  // Bus-Haltestelle zeigte „keine Abfahrten", obwohl Transitous die Daten
  // hat. null → Aufrufer probiert HAFAS/MOTIS. Leer bleibt nur, wenn der
  // Feed den Stop KENNT und wirklich nichts fährt.
  if (allStopIds.length === 0) return null;

  const now = new Date();
  const services = await activeServiceIds(feedId, now);
  // Auch hier null statt leer: 0 aktive Service-IDs heißt praktisch immer
  // „Feed-Kalender abgelaufen" (Feed nicht refresht), nicht „heute fährt im
  // ganzen Land nichts". Ein leeres Board würde den MOTIS-Fallback blocken —
  // ein stale Feed macht sonst still sämtliche Tafeln des Landes leer.
  if (services.size === 0) return null;

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
      WHERE feed_id = ${feedId} AND service_id = ANY(${sql.param(serviceList)}::text[])
    ),
    today_stops AS (
      SELECT st.trip_id, st.departure_seconds, st.arrival_seconds, tt.headsign, tt.route_id
      FROM gtfs_stop_times st
      INNER JOIN today_trips tt ON tt.trip_id = st.trip_id
      WHERE st.feed_id = ${feedId}
        AND st.stop_id = ANY(${sql.param(allStopIds)}::text[])
        AND ${timeCol} >= ${fromSec}
        AND ${timeCol} <= ${toSec}
    ),
    -- Trips von gestern die über Mitternacht hinauslaufen (sec > 86400).
    yesterday_trips AS (
      SELECT trip_id, route_id, headsign
      FROM gtfs_trips
      WHERE feed_id = ${feedId} AND service_id = ANY(${sql.param(ySvcList)}::text[])
    ),
    yesterday_stops AS (
      SELECT st.trip_id,
             st.departure_seconds - 86400 AS departure_seconds,
             st.arrival_seconds - 86400 AS arrival_seconds,
             yt.headsign, yt.route_id
      FROM gtfs_stop_times st
      INNER JOIN yesterday_trips yt ON yt.trip_id = st.trip_id
      WHERE st.feed_id = ${feedId}
        AND st.stop_id = ANY(${sql.param(allStopIds)}::text[])
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

export interface ScheduledTripStop {
  stopId: string;
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  arrival: string;
  departure: string;
  sequence: number;
}

/**
 * Holt ALLE Halte eines GTFS-Trips (für Trip-Detail in der Schedule-Search).
 *
 * Wir wissen den `tripId` aus dem Stop-Board und den User-Origin (`originTime`
 * + `originStopCode`). Daraus leiten wir die base-midnight ab (statt mit
 * Server-Now zu raten — der Trip könnte auch ein Yesterday-Trip sein der
 * über Mitternacht hinausläuft).
 *
 * Liefert ALLE Stops ab Origin (= Slice, nicht der volle Verlauf von der
 * Endstation an). Damit kriegt die UI eine bündige „Du steigst hier ein,
 * Bahn fährt zu A, B, C, Endstation"-Sicht.
 */
export async function getScheduledTripStops(args: {
  country: string;
  tripId: string;
  originStopCode: string;
  originLatitude: number | null;
  originLongitude: number | null;
  originTime: string;
}): Promise<ScheduledTripStop[] | null> {
  const feedId = FEED_ID_BY_COUNTRY[args.country];
  if (!feedId) return null;
  if (!(await isFeedImported(feedId))) return null;

  // Alle Stops des Trips holen, chronologisch.
  const result = (await db.execute(sql`
    SELECT st.stop_id, st.stop_sequence, st.arrival_seconds, st.departure_seconds,
           s.name AS stop_name, s.latitude, s.longitude, s.parent_station
    FROM gtfs_stop_times st
    LEFT JOIN gtfs_stops s ON s.feed_id = ${feedId} AND s.stop_id = st.stop_id
    WHERE st.feed_id = ${feedId} AND st.trip_id = ${args.tripId}
    ORDER BY st.stop_sequence ASC
  `)) as unknown as {
    rows: Array<{
      stop_id: string;
      stop_sequence: number;
      arrival_seconds: number;
      departure_seconds: number;
      stop_name: string | null;
      latitude: number | null;
      longitude: number | null;
      parent_station: string | null;
    }>;
  };
  const rows = result.rows ?? [];
  if (rows.length === 0) return null;

  // Origin im Trip finden. 3 Strategien (in Reihenfolge):
  //   A) Direkter ID-Match — wenn der User-Stop ein GTFS-Code ist
  //      (gtfs:nl:stoparea:502651), matcht die nackte stop_id.
  //   B) Parent-Station-Match — manche Trips haben stop_id=platform-Code,
  //      während unser User-Stop die übergeordnete StopArea ist.
  //   C) Coord-Match — wenn der User-Stop ein OSM-Stop ist, finden wir den
  //      nahesten Trip-Stop in ~150m.
  const directId = gtfsStopIdFromCode(args.originStopCode);
  let originIdx = -1;
  if (directId) {
    originIdx = rows.findIndex((r) => r.stop_id === directId || r.parent_station === directId);
  }
  if (originIdx < 0 && args.originLatitude != null && args.originLongitude != null) {
    const lat = args.originLatitude;
    const lon = args.originLongitude;
    const dLat = 0.0014; // ~150m
    const dLon = 0.0014 / Math.cos((lat * Math.PI) / 180);
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.latitude == null || r.longitude == null) continue;
      if (Math.abs(r.latitude - lat) > dLat) continue;
      if (Math.abs(r.longitude - lon) > dLon) continue;
      const dist =
        (r.latitude - lat) * (r.latitude - lat) +
        (r.longitude - lon) * (r.longitude - lon);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) originIdx = bestIdx;
  }
  if (originIdx < 0) return null;

  // Base-Midnight aus User-Origin-Time ableiten. Damit haben wir den richtigen
  // Tag — auch wenn der Trip ein Yesterday-Trip ist der über Mitternacht
  // hinausläuft (seconds > 86400).
  const originSec = rows[originIdx]!.departure_seconds;
  const baseMs = Date.parse(args.originTime) - originSec * 1000;
  if (!Number.isFinite(baseMs)) return null;

  return rows.slice(originIdx).map((r) => ({
    stopId: r.stop_id,
    name: r.stop_name,
    latitude: r.latitude,
    longitude: r.longitude,
    arrival: new Date(baseMs + r.arrival_seconds * 1000).toISOString(),
    departure: new Date(baseMs + r.departure_seconds * 1000).toISOString(),
    sequence: r.stop_sequence,
  }));
}
