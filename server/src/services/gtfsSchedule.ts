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
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db } from "../db/client.js";
import type { StopBoard, StopBoardItem, StopBoardResponse } from "./stopInfoService.js";
import { timetableStopName } from "../util/stopDisplayName.js";
import { BoundedTtlCache } from "../util/boundedCache.js";

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

/**
 * Die Zeitzone je Feed — GTFS zählt alle Zeiten in der ORTSZEIT des Betreibers.
 *
 * Hier stand die Ortszeit des Servers, mit der Annahme „läuft eh in
 * Europe/Berlin". Der Container läuft aber in UTC: Die Tafeln in den
 * Niederlanden, Belgien und Tschechien zeigten um 10:00 Uhr die Züge, die
 * zwischen 7:55 und 10:00 GEFAHREN waren — beschriftet mit 9:55 bis 12:00.
 * Und Großbritannien liegt ohnehin eine Stunde neben Berlin.
 */
const FEED_TZ: Record<string, string> = {
  "nl-ovapi": "Europe/Amsterdam",
  "fr-transport": "Europe/Paris",
  "it-gtfs": "Europe/Rome",
  "es-gtfs": "Europe/Madrid",
  "cz-gtfs": "Europe/Prague",
  "be-gtfs": "Europe/Brussels",
  "hu-gtfs": "Europe/Budapest",
  "sk-gtfs": "Europe/Bratislava",
  "gb-gtfs": "Europe/London",
  "pt-gtfs": "Europe/Lisbon",
};

function feedTz(feedId: string): string {
  return FEED_TZ[feedId] ?? "Europe/Berlin";
}

/** Der Betriebstag (`yyyy-MM-dd`) in der Zeitzone des Feeds. */
function serviceDate(now: Date, tz: string): string {
  return formatInTimeZone(now, tz, "yyyy-MM-dd");
}

/** Der Tag davor, als `yyyy-MM-dd` — reine Kalenderrechnung. */
function previousDate(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Der Nullpunkt der GTFS-Zeiten eines Betriebstags als UTC-ms: 12:00 Ortszeit
 * minus 12 Stunden — so steht es in der GTFS-Spezifikation. An den Tagen der
 * Zeitumstellung ist das NICHT Mitternacht, sondern eine Stunde daneben.
 */
function serviceDayBaseMs(date: string, tz: string): number {
  return fromZonedTime(`${date}T12:00:00`, tz).getTime() - 12 * 3_600_000;
}

/** Wochentag-Spalte für gtfs_calendar — der Wochentag des KALENDERTAGS. */
function weekdayColumn(date: string): string {
  const idx = new Date(`${date}T12:00:00Z`).getUTCDay();
  return ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][idx]!;
}

/** Holt die Service-IDs die heute (für `feed_id`) aktiv sind. Berücksichtigt
 *  calendar (Default-Wochenmuster) UND calendar_dates (Ausnahmen: hinzugefügt
 *  oder entfernt). Cache hier — der Service-Set ändert sich nur einmal pro
 *  Tag. */
/**
 * Gedeckelt: Der Schlüssel enthält das DATUM — jeden Tag kamen je Feed neue
 * Einträge dazu, abgelaufene blieben liegen (nur beim Lesen geprüft, nie
 * gelöscht). Jeder hält alle Service-IDs eines Feed-Tages, beim britischen
 * Feed Zehntausende: ein langsames Leck über Wochen Laufzeit.
 */
const serviceIdsCache = new BoundedTtlCache<Set<string>>(64, 10 * 60_000);

async function activeServiceIds(feedId: string, dateStr: string): Promise<Set<string>> {
  const cacheKey = `${feedId}:${dateStr}`;
  const cached = serviceIdsCache.get(cacheKey);
  if (cached) return cached;

  const weekday = weekdayColumn(dateStr);
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
  // Zehn Minuten, nicht eine Stunde: Nach dem wöchentlichen Neuimport können
  // die Service-IDs anders heißen. Mit den alten fände die Tafel eine Stunde
  // lang nichts — und eine LEERE Tafel (statt keiner) blockt den MOTIS-Ersatz.
  serviceIdsCache.set(cacheKey, ids);
  return ids;
}

interface DepartureRow {
  trip_id: string;
  departure_seconds: number;
  arrival_seconds: number;
  headsign: string | null;
  /** Erster Halt der Fahrt — die Richtungsangabe einer ANKUNFTSTAFEL. */
  origin_name: string | null;
  /** Letzter Halt — nur gesetzt, wenn das Kopfschild fehlt oder nichts sagt (siehe `destSel`). */
  dest_name: string | null;
  route_short_name: string | null;
  route_long_name: string | null;
  route_type: number;
}

const MAX_RESULTS = 20;
const WINDOW_MINUTES = 120; // wie weit nach vorne schauen für departures

/**
 * Kopfschilder, die nichts sagen: Im britischen Feed fahren 17 700 Fahrten
 * nach „Bus Station", 770 nach „Terminus", 420 nach „Terminal" — welche,
 * steht nur im letzten Halt. Dort, und wo das Kopfschild ganz fehlt, nimmt
 * die Tafel den Namen des letzten Halts (sofern der selbst etwas sagt).
 */
const GENERIC_HEADSIGNS = ["terminus", "terminal", "bus station", "station", "city centre", "town centre", "centre"];

function directionOf(headsign: string | null, lastStop: string | null): string {
  const h = headsign?.trim() ?? "";
  const l = lastStop?.trim() ?? "";
  const generic = (v: string) => GENERIC_HEADSIGNS.includes(v.toLowerCase());
  if (h && !generic(h)) return h;
  if (l && !generic(l)) return l;
  return h || l;
}

/**
 * Verkehrsmittel-FAMILIE — die Ebene, auf der eine Haltestelle und ein
 * GTFS-Halt zusammenpassen müssen: Bus, Eisenbahn, Stadtschiene (U-Bahn/Tram/
 * Stadtbahn) oder Fähre.
 *
 * Stadtschiene bewusst grob: Wie Stadtbahnen eingestuft werden, regelt jede
 * Quelle anders — Metrolink ist in OSM ein Tram-Halt, die DLR im britischen
 * Feed „Eisenbahn" (route_type 2), Tyne & Wear „U-Bahn". Darum darf ein
 * Tram-/U-Bahn-Halt auch Eisenbahn-Halte nehmen, ein BAHNHOF aber nur
 * Eisenbahn: Sonst bekam London Euston die Northern Line als Abfahrtstafel
 * (der britische Feed hat keine Fernbahn, MOTIS schon).
 */
type ModeFamily = "bus" | "train" | "metro" | "ferry";

/** Familie eines GTFS-`route_type` (Basis- und erweiterte Typen). */
const ROUTE_FAMILY_SQL = (col: ReturnType<typeof sql>) => sql`CASE
    WHEN ${col} = 2 OR ${col} BETWEEN 100 AND 199 OR ${col} BETWEEN 300 AND 399 THEN 'train'
    WHEN ${col} IN (0, 1, 5, 6, 7, 12) OR ${col} BETWEEN 400 AND 499 OR ${col} BETWEEN 900 AND 999
         OR ${col} BETWEEN 1300 AND 1499 THEN 'metro'
    WHEN ${col} = 4 OR ${col} = 1200 OR ${col} BETWEEN 1000 AND 1099 THEN 'ferry'
    ELSE 'bus' END`;

/**
 * Welche Familien an UNSERER Haltestelle verkehren dürfen — aus `kinds`, sonst
 * aus der Art. `null` heißt „unbekannt": dann wird nicht gefiltert (lieber zu
 * viel als eine leere Tafel).
 */
function wantedFamilies(kinds: readonly string[] | null | undefined, type: string | null | undefined): Set<ModeFamily> | null {
  const out = new Set<ModeFamily>();
  for (const k of kinds ?? []) {
    if (k === "bus") out.add("bus");
    else if (k === "train") out.add("train");
    else if (k === "subway" || k === "tram") {
      out.add("metro");
      out.add("train");
    } else if (k === "ferry") out.add("ferry");
  }
  if (out.size > 0) return out;
  if (type === "BUS") return new Set(["bus"]);
  if (type === "TRAIN") return new Set(["train", "metro"]);
  return null;
}

/** Namen vergleichbar machen: klein, ohne Akzente und Satzzeichen. */
function foldStopName(v: string): string {
  return v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Derselbe Halt dem Namen nach? Gleich, oder einer steckt im anderen — OSM
 * schreibt „Welgate Road, opp" oder „Princes Street (west)", der britische Feed
 * nur „Welgate Road" bzw. „Princes Street". Mindestens vier Zeichen, sonst
 * passt „A" in alles.
 */
function sameStopName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = foldStopName(a);
  const y = foldStopName(b);
  if (x.length < 4 || y.length < 4) return x === y && x.length > 0;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/**
 * Die GTFS-Halte, deren Fahrten die Tafel unserer Haltestelle zeigt — leer,
 * wenn der Feed keinen passenden kennt (die Tafel fällt dann auf MOTIS/HAFAS
 * zurück). Eigene Funktion, damit die Vollprüfung aller Haltestellen
 * (scripts/audit-boards.ts) GENAU diese Zuordnung prüft und keine Nachbildung.
 */
export async function boardStopIds(
  feedId: string,
  args: {
    stopCode: string;
    latitude?: number | null;
    longitude?: number | null;
    label?: string | null;
    type?: string | null;
    kinds?: readonly string[] | null;
    /**
     * Ein einzelner Bus-Steig einer Station (scripts/lib/gtfsStands.ts): nur
     * der GTFS-Halt genau dort, nicht seine ganze Station — sonst zeigte der
     * Mast auf der einen Straßenseite auch die Busse der anderen.
     */
    standOnly?: boolean;
  },
): Promise<string[]> {
  const wanted = wantedFamilies(args.kinds, args.type);

  // Wege um den Stop in den GTFS-Tabellen zu finden:
  //   A) `gtfs:<country>:<id>` — Code-Präfix → direkter ID-Mapping
  //   B) `osm:<id>` / `sta:<uic>` — Coord-Lookup nächster GTFS-Stop
  //
  // Beide Pfade landen am Ende mit derselben Coord-Fallback-Logik wenn die
  // direkte ID-Suche keine echten Children findet (kommt in NL/FR vor wo
  // manche stoparea-Parents keine parent_station-Pointer von ihren Platforms
  // bekommen → SELECT findet nur die Parent-Row aber stop_times referenzieren
  // nur Platforms → leere Antwort obwohl Daten da wären).
  /**
   * Der GTFS-Halt zu einer Koordinate — PASSEND zum Verkehrsmittel und, wenn
   * möglich, zum Namen.
   *
   * Hier stand: „Station (location_type 1) vor Bahnsteig, dann der nächste im
   * 250-m-Kasten". Nachgezählt am britischen Feed (Okt. 2026):
   *
   *  - Rund 7 000 Bushaltestellen liegen keine 250 m neben einer „Station" —
   *    U-Bahn, DLR, Metrolink, Busbahnhof. Ihre Tafel zeigte die Station:
   *    an der Bushaltestelle in Clapham die Northern Line, an der Straße vor
   *    dem Busbahnhof Halifax alle 18 Steige.
   *  - Der britische Feed enthält KEINE Eisenbahn. Ein Bahnhof bekam deshalb
   *    die Busse vom Vorplatz als Abfahrten, und der MOTIS-Ersatz, der die Züge
   *    kennt, kam nie zum Zug (die Tafel war ja nicht leer).
   *  - Belgien: Der Feed ist nur die Bahn (NMBS). Jede Bushaltestelle in
   *    Bahnhofsnähe zeigte Züge.
   *
   * Jetzt:
   *  1. Kandidaten im 250-m-Kasten, der Nähe nach (Stationen nicht mehr vorab).
   *  2. Je Kandidat die Familien, die dort WIRKLICH fahren — Stichprobe aus
   *     `gtfs_stop_times` (bei einer Station über ihre Bahnsteige).
   *  3. Nur Kandidaten, deren Familie zu unserer Haltestelle passt. Passt
   *     keiner: leer → der Aufrufer liefert null → MOTIS/HAFAS versuchen es.
   *  4. Gleicher Name schlägt Nähe (150 m Vorsprung) — OSM setzt die Haltestelle
   *     oft auf die andere Straßenseite als der Feed. Bahn-Stationen behalten
   *     einen kleinen Vorsprung (StaDa-Lage = Empfangsgebäude, 100–200 m neben
   *     der Bahnsteigmitte).
   *  5. Ohne Namensgleichheit höchstens 150 m bei Bus/Fähre — weiter weg ist
   *     es meist eine ANDERE Haltestelle, deren Tafel hier falsch wäre.
   */
  async function coordLookup(lat: number, lon: number): Promise<string[]> {
    const radiusM = 250;
    const dLat = radiusM / 111_000;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const dLon = dLat / cosLat;
    const familyExpr = ROUTE_FAMILY_SQL(sql`r.type`);
    const nearbyRows = (await db.execute(sql`
      WITH cand AS (
        SELECT stop_id, parent_station, location_type, name, latitude::float8 AS lat, longitude::float8 AS lon,
               (latitude::float8 - ${lat}) * (latitude::float8 - ${lat})
                 + ((longitude::float8 - ${lon}) * ${cosLat}) * ((longitude::float8 - ${lon}) * ${cosLat}) AS d2
        FROM gtfs_stops
        WHERE feed_id = ${feedId}
          AND latitude BETWEEN ${lat - dLat} AND ${lat + dLat}
          AND longitude BETWEEN ${lon - dLon} AND ${lon + dLon}
          AND coalesce(location_type, 0) IN (0, 1)
        ORDER BY d2
        LIMIT 12
      )
      SELECT c.stop_id, c.parent_station, c.location_type, c.name, c.lat, c.lon, c.d2,
        ARRAY(
          SELECT DISTINCT ${familyExpr}
          FROM (
            SELECT st.trip_id
            FROM gtfs_stops m
            CROSS JOIN LATERAL (
              SELECT trip_id FROM gtfs_stop_times st
              WHERE st.feed_id = ${feedId} AND st.stop_id = m.stop_id
              LIMIT 15
            ) st
            WHERE m.feed_id = ${feedId}
              AND (m.stop_id = c.stop_id OR (c.location_type = 1 AND m.parent_station = c.stop_id))
            LIMIT 60
          ) x
          JOIN gtfs_trips t ON t.feed_id = ${feedId} AND t.trip_id = x.trip_id
          JOIN gtfs_routes r ON r.feed_id = ${feedId} AND r.route_id = t.route_id
        ) AS families
      FROM cand c
      ORDER BY c.d2
    `)) as unknown as {
      rows: Array<{
        stop_id: string;
        parent_station: string | null;
        location_type: number | null;
        name: string | null;
        lat: number;
        lon: number;
        d2: number;
        families: string[] | null;
      }>;
    };
    const wantsRail = (wanted?.has("train") || wanted?.has("metro")) ?? false;
    let best: { stopId: string; parent: string | null; score: number; lat: number; lon: number } | null = null;
    /** Passende Halte mit Lage — für den Steig-Modus (alle am selben Punkt). */
    const fitting: Array<{ stopId: string; lat: number; lon: number; locType: number | null }> = [];
    for (const c of nearbyRows.rows ?? []) {
      const fams = c.families ?? [];
      // Ohne eine einzige Fahrt ergäbe der Halt nur eine leere Tafel.
      if (fams.length === 0) continue;
      if (wanted && !fams.some((f) => wanted.has(f as ModeFamily))) continue;
      const distM = Math.sqrt(Number(c.d2)) * 111_000;
      const nameMatch = sameStopName(args.label, c.name);
      const limitM = nameMatch || wantsRail ? radiusM : 150;
      if (distM > limitM) continue;
      fitting.push({ stopId: c.stop_id, lat: Number(c.lat), lon: Number(c.lon), locType: c.location_type });
      let score = distM;
      if (nameMatch) score -= 150;
      if (wantsRail && c.location_type === 1) score -= 60;
      if (!best || score < best.score) {
        best = { stopId: c.stop_id, parent: c.parent_station, score, lat: Number(c.lat), lon: Number(c.lon) };
      }
    }
    if (!best) return [];
    /**
     * Steig-Modus: alle Bahnsteig-Halte bis 5 m um den gewählten — Feeds führen
     * dieselbe Bucht mehrfach (Abbekerk Busstation, Steig B: zwei Kennungen
     * auf demselben Punkt, eine mit 14, eine mit 321 Fahrten); der Import fasst
     * sie ebenso zu EINEM Steig zusammen (STAND_MERGE_M in gtfsStands.ts).
     */
    if (args.standOnly) {
      const b = best;
      const near = fitting
        .filter((f) => f.locType !== 1 && 111_000 * Math.hypot(f.lat - b.lat, (f.lon - b.lon) * cosLat) <= 5)
        .map((f) => f.stopId);
      return near.length > 0 ? near : [b.stopId];
    }
    const parentOrSelf = best.parent ?? best.stopId;
    const idsRows = (await db.execute(sql`
      SELECT stop_id FROM gtfs_stops
      WHERE feed_id = ${feedId} AND (stop_id = ${parentOrSelf} OR parent_station = ${parentOrSelf})
    `)) as unknown as { rows: Array<{ stop_id: string }> };
    const ids = (idsRows.rows ?? []).map((r) => r.stop_id);
    if (ids.length > 0) return ids;
    return [best.stopId];
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
    if (allStopIds.length === 0 || onlyParent) {
      /**
       * Die eigene Kennung nur, wenn der Feed unter ihr etwas FAHREN lässt.
       *
       * Hier wurde sie als letzter Ausweg auch dann eingesetzt, wenn es sie im
       * Feed gar nicht gibt (bzw. nur als Elternstation ohne Bahnsteige) — die
       * Abfrage fand dann nichts, und die LEERE Tafel blockte den MOTIS-Ersatz.
       * Betroffen waren alle Halte mit Kennungen aus einem anderen Feed als dem
       * Fahrplan des Landes: in Belgien die gut 31 000 De-Lijn- und TEC-Halte
       * (`gtfs:be:dl:…`, `gtfs:be:tec:…` — der Fahrplan ist nur die Bahn), in
       * den Niederlanden die rund 11 600 Kennungen, die OVapi inzwischen neu
       * vergeben hat. Ohne passenden Halt in der Nähe zeigten sie ausnahmslos
       * „keine Abfahrten"; jetzt geht es weiter zu MOTIS/HAFAS (null unten).
       */
      allStopIds =
        args.latitude != null && args.longitude != null
          ? await coordLookup(args.latitude, args.longitude)
          : [];
    }
  } else if (args.latitude != null && args.longitude != null) {
    allStopIds = await coordLookup(args.latitude, args.longitude);
  }
  return allStopIds;
}

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
  /** Name, Art und Verkehrsarten unserer Haltestelle — damit der Koordinaten-
   *  Abgleich den richtigen GTFS-Halt nimmt (siehe `coordLookup`). Optional:
   *  ohne sie wird wie früher nur nach Lage entschieden. */
  label?: string | null;
  type?: string | null;
  kinds?: readonly string[] | null;
  /** Nur dieser Steig, nicht seine Station (siehe `boardStopIds`). */
  standOnly?: boolean;
}): Promise<StopBoardResponse | null> {
  if (!args.country) return null;
  const feedId = FEED_ID_BY_COUNTRY[args.country];
  if (!feedId) return null;
  if (!(await isFeedImported(feedId))) return null;

  const wanted = wantedFamilies(args.kinds, args.type);
  const allStopIds = await boardStopIds(feedId, args);

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
  const tz = feedTz(feedId);
  const today = serviceDate(now, tz);
  const services = await activeServiceIds(feedId, today);
  // Auch hier null statt leer: 0 aktive Service-IDs heißt praktisch immer
  // „Feed-Kalender abgelaufen" (Feed nicht refresht), nicht „heute fährt im
  // ganzen Land nichts". Ein leeres Board würde den MOTIS-Fallback blocken —
  // ein stale Feed macht sonst still sämtliche Tafeln des Landes leer.
  if (services.size === 0) return null;

  const midnightMs = serviceDayBaseMs(today, tz);
  const nowSec = Math.floor((now.getTime() - midnightMs) / 1000);
  /**
   * Das Fenster zeigt VORWÄRTS — bei Ankünften genauso wie bei Abfahrten.
   *
   * Hier stand es für Ankünfte rückwärts (`jetzt − 2h` bis `jetzt + 5min`), und
   * das beantwortete eine andere Frage als die gestellte: „was ist hier schon
   * angekommen" statt „was kommt als Nächstes an". Wer auf eine Ankunftstafel
   * sieht, wartet auf jemanden — vergangene Ankünfte helfen ihm nicht, und eine
   * Tafel voll davon sieht schlicht kaputt aus.
   *
   * Derselbe Fehler steckte in der MOTIS-Quelle (dort über `arriveBy`), und
   * beide zusammen hießen: Die Ankunftstafel war in JEDER Quelle außer db-rest
   * falsch. Der Unterschied zwischen den Tafeln ist allein die SPALTE
   * (`arrival_seconds` statt `departure_seconds`) — nicht die Zeitrichtung.
   *
   * Ab der LAUFENDEN MINUTE, ohne Rückblick: Ein Zug um 14:26 steht bis
   * 14:26:59 da, danach ist er weg. Hier standen fünf Minuten nach hinten —
   * auf der Tafel waren das Züge, die schon abgefahren waren.
   */
  const fromSec = nowSec - (nowSec % 60);
  const toSec = nowSec + WINDOW_MINUTES * 60;

  // Service-ID-IN-Liste — Postgres-array-Param. Drizzle/postgres-js akzeptieren
  // Arrays direkt als Bind-Param.
  const serviceList = Array.from(services);

  // Inner CTEs nutzen `st` (gtfs_stop_times); das äußere SELECT iteriert
  // über `combined c` und muss den `c`-Alias verwenden, sonst "missing
  // FROM-clause entry for table st".
  const timeCol = args.board === "departures" ? sql`st.departure_seconds` : sql`st.arrival_seconds`;
  const orderCol = args.board === "departures" ? sql`c.departure_seconds` : sql`c.arrival_seconds`;

  /**
   * Der ERSTE Halt der Fahrt — und nur für die Ankunftstafel.
   *
   * Das Kopfschild (`headsign`) nennt das ZIEL. Auf einer Abfahrtstafel ist das
   * genau richtig, auf einer Ankunftstafel die falsche Hälfte der Fahrt: Wer
   * dort steht, will wissen, woher der Zug kommt. Die zweite Quelle derselben
   * Tafel (db-rest) nimmt dafür `provenance` — ohne das hier bedeutete dieselbe
   * Zeile je nach antwortendem Anbieter etwas anderes.
   *
   * Als Unterabfrage je Zeile statt als Verbund: Sie läuft höchstens
   * `MAX_RESULTS` mal und trifft mit (feed_id, trip_id, stop_sequence) genau
   * den vorhandenen Schlüssel-Index — ein `DISTINCT ON` über die ganze
   * Halte-Tabelle wäre um Größenordnungen teurer. Für Abfahrten wird sie gar
   * nicht erst gestellt. Nachgemessen am Abfrageplan: die Unterabfrage läuft
   * NACH dem Sortieren und Begrenzen (Postgres zieht die Projektion in einen
   * eigenen Knoten darüber), also zwanzig Mal und nicht einige hundert.
   *
   * DAS `CASE` IST KEIN SCHMUCK: Beginnt die Fahrt an genau dieser Station,
   * gibt es keine Herkunft. Den ERSTEN Halt einer Fahrt hält `servesHere`
   * inzwischen ganz von der Ankunftstafel fern — übrig bleiben Ringfahrten,
   * die hier beginnen UND enden, und Fahrten, die an einem anderen Bahnsteig
   * derselben Station anfangen. Ohne die Fallunterscheidung stünde an solchen
   * Zeilen der Name der Station, vor der man gerade steht. NULL heißt hier
   * „keine Angabe", und der Aufrufer fällt dann auf das Fahrtziel zurück.
   *
   * Der Kommentar steht hier und NICHT in der Abfrage: Alles zwischen den
   * Schrägstrichen ginge sonst bei jedem Aufruf mit über die Leitung an
   * Postgres — und ein einziger Backtick darin beendet das Template-Literal.
   */
  const originSel =
    args.board === "arrivals"
      ? sql`(
          SELECT CASE
                   WHEN o.stop_id = ANY(${sql.param(allStopIds)}::text[]) THEN NULL
                   ELSE s.name
                 END
          FROM gtfs_stop_times o
          LEFT JOIN gtfs_stops s ON s.feed_id = o.feed_id AND s.stop_id = o.stop_id
          WHERE o.feed_id = ${feedId} AND o.trip_id = c.trip_id
          ORDER BY o.stop_sequence ASC
          LIMIT 1
        ) AS origin_name`
      : sql`NULL::text AS origin_name`;

  // Auch das nächste Tagessegment (Service-IDs von gestern, deren Trips über
  // Mitternacht hinauslaufen — GTFS erlaubt seconds > 86400). Wenn unsere
  // current `nowSec` knapp nach Mitternacht ist (z.B. 00:30 = 1800s), könnte
  // ein Trip von gestern mit `departure_seconds=88200` (= 24:30 = 0:30 next
  // day) für uns relevant sein. Wir prüfen das durch ein zweites Window
  // verschoben um +86400.
  const yesterdayServices = await activeServiceIds(feedId, previousDate(today));
  const ySvcList = Array.from(yesterdayServices);

  /**
   * Nur Fahrten der Familien, die an UNSERER Haltestelle verkehren — dieselbe
   * Regel wie im HAFAS-Zweig (routes/stops.ts, „Bus-Stop → nur Bus"). Eine
   * Haltezone (NL-„stoparea", britische Station) bündelt oft mehrere
   * Verkehrsmittel; an der Bushaltestelle davor gehören die Züge nicht auf die
   * Tafel. Unbekannte Linienart (`r.type` NULL) bleibt drin.
   */
  /**
   * Der LETZTE Halt der Fahrt — nur, wo das Kopfschild fehlt.
   *
   * Im britischen Feed haben 272 000 von 1,6 Mio. Fahrten (17 %) kein
   * `trip_headsign`. Die Tafel zeigte dort Zeilen ohne Richtung, und die App
   * ignoriert den Tipp auf eine Zeile ohne Richtung (StopDetailSheet,
   * `onSelectDeparture`) — jede sechste britische Abfahrt war nicht antippbar.
   * Wie `originSel` höchstens `MAX_RESULTS` mal, über den Schlüssel-Index.
   */
  const destSel = sql`(
      SELECT d.name
      FROM gtfs_stop_times o
      JOIN gtfs_stops d ON d.feed_id = o.feed_id AND d.stop_id = o.stop_id
      WHERE (coalesce(trim(c.headsign), '') = '' OR lower(trim(c.headsign)) = ANY(${sql.param(GENERIC_HEADSIGNS)}::text[]))
        AND o.feed_id = ${feedId} AND o.trip_id = c.trip_id
      ORDER BY o.stop_sequence DESC
      LIMIT 1
    ) AS dest_name`;

  /**
   * Nur Halte, an denen die Fahrt hier wirklich BEDIENT — Abfahrten nicht am
   * letzten Halt einer Fahrt, Ankünfte nicht am ersten.
   *
   * Vorher stand an der Endhaltestelle jede ankommende Fahrt als „Abfahrt"
   * (Bath, Dorchester Street: Linie 2 „nach City Centre, Dorchester Street" —
   * eine Ringlinie, die dort ENDET) und am Startpunkt jede abfahrende als
   * „Ankunft". Dazu die Halte, an denen laut Fahrplan nicht ein- bzw.
   * ausgestiegen werden darf (`pickup_type`/`drop_off_type` = 1).
   * Die Probe läuft über den Schlüssel-Index (feed_id, trip_id, stop_sequence).
   */
  /*
   * … und der andere Halt muss WOANDERS sein (anderer Name), nicht nur ein
   * anderer Steig derselben Station. Die Linie 145 beginnt in „Barendrecht,
   * Station Barendrecht" und hält als Nächstes am zweiten Steig desselben
   * Bahnhofs: Die Ankunftstafel zeigte sie als „Ankunft aus Barendrecht,
   * Station Barendrecht" — ein Bus, der dort erst losfährt. Gefunden bei der
   * Vollprüfung aller Tafeln (scripts/audit-boards.ts --live, Okt. 2026).
   */
  const servesHere =
    args.board === "departures"
      ? sql`coalesce(st.pickup_type, 0) <> 1 AND EXISTS (
          SELECT 1 FROM gtfs_stop_times nx
          JOIN gtfs_stops ns ON ns.feed_id = nx.feed_id AND ns.stop_id = nx.stop_id
          WHERE nx.feed_id = st.feed_id AND nx.trip_id = st.trip_id AND nx.stop_sequence > st.stop_sequence
            AND ns.name IS DISTINCT FROM (SELECT cs.name FROM gtfs_stops cs WHERE cs.feed_id = st.feed_id AND cs.stop_id = st.stop_id))`
      : sql`coalesce(st.drop_off_type, 0) <> 1 AND EXISTS (
          SELECT 1 FROM gtfs_stop_times pv
          JOIN gtfs_stops ps ON ps.feed_id = pv.feed_id AND ps.stop_id = pv.stop_id
          WHERE pv.feed_id = st.feed_id AND pv.trip_id = st.trip_id AND pv.stop_sequence < st.stop_sequence
            AND ps.name IS DISTINCT FROM (SELECT cs.name FROM gtfs_stops cs WHERE cs.feed_id = st.feed_id AND cs.stop_id = st.stop_id))`;

  /**
   * Doppelte Fahrten EINMAL zeigen. Der britische Feed (BODS) führt dieselbe
   * Fahrt oft in mehreren Fahrplan-Versionen, deren Gültigkeit sich
   * überschneidet — die Tafel zeigte „21:20 Linie 2" zwei-, dreimal. Gleiche
   * Minute, gleiche Linie, gleiches Ziel = dieselbe Abfahrt (wie der Abgleich
   * in motisStops.ts).
   */
  const dedupTime = args.board === "departures" ? sql`cb.departure_seconds` : sql`cb.arrival_seconds`;

  const familyFilter = wanted
    ? sql`WHERE r.type IS NULL OR ${ROUTE_FAMILY_SQL(sql`r.type`)} = ANY(${sql.param(Array.from(wanted))}::text[])`
    : sql``;

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
        AND ${servesHere}
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
        AND ${servesHere}
    ),
    combined AS (
      SELECT * FROM today_stops
      UNION ALL
      SELECT * FROM yesterday_stops
    ),
    dedup AS (
      SELECT DISTINCT ON (${dedupTime}, coalesce(r.short_name, r.long_name, ''), coalesce(cb.headsign, ''))
             cb.trip_id, cb.departure_seconds, cb.arrival_seconds, cb.headsign,
             r.short_name AS route_short_name,
             r.long_name AS route_long_name,
             r.type AS route_type
      FROM combined cb
      LEFT JOIN gtfs_routes r ON r.feed_id = ${feedId} AND r.route_id = cb.route_id
      ${familyFilter}
      ORDER BY ${dedupTime}, coalesce(r.short_name, r.long_name, ''), coalesce(cb.headsign, ''), cb.trip_id
    )
    SELECT c.trip_id, c.departure_seconds, c.arrival_seconds, c.headsign,
           c.route_short_name, c.route_long_name, c.route_type,
           ${originSel},
           ${destSel}
    FROM dedup c
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
      // Ankunft: woher die Fahrt kommt. Abfahrt: wohin sie geht. Fehlt die
      // Herkunft (Fahrt ohne Halte-Einträge), bleibt das Kopfschild besser als
      // gar keine Angabe — siehe `originSel`.
      /**
       * `|| null` und nicht nur `??`: Ein Name, der DA ist, aber leer, ist keine
       * Angabe — `??` griffe darauf nicht und ließe die Zeile ohne Richtung
       * stehen. Dieselbe Unterscheidung wie in `motisStops.ts`.
       */
      direction: (
        (args.board === "arrivals" ? r.origin_name?.trim() || null : null) ??
        directionOf(r.headsign, r.dest_name)
      ).trim(),
      platform: null,
      cancelled: false,
    });
  }

  /**
   * Gleiche ZEILE nur einmal — Zeit, Linie und angezeigte Richtung. Die Abfrage
   * fasst über das Fahrtziel zusammen; auf der Ankunftstafel steht aber die
   * HERKUNFT. Die niederländischen Rufbusse („Flex") führen je Abfahrt mehrere
   * Fahrt-Varianten mit verschiedenen Zielen — unter „Ankünfte" stand dann
   * „Flex 12:01 aus Utrecht, Daelwijck" zwei-, dreimal (Vollprüfung aller
   * Tafeln, Okt. 2026: 431 Doppelzeilen in den Niederlanden).
   */
  const seen = new Set<string>();
  const shown = items.filter((it) => {
    const key = `${it.line}|${it.plannedTime}|${it.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    results: shown,
    fetchedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60_000).toISOString(),
    source: await boardSource(feedId, allStopIds, args.latitude, args.longitude, args.country),
  };
}

/**
 * Der Halt, dessen Zeiten die Tafel zeigt: der nächste der gewählten
 * Fahrplan-Halte, mit dem Namen, den auch die Zeitleiste zeigt. Die Route
 * meldet ihn, wenn er ein ANDERER Halt ist als unsere Haltestelle.
 */
async function boardSource(
  feedId: string,
  ids: string[],
  lat: number | null | undefined,
  lon: number | null | undefined,
  country: string | null,
): Promise<StopBoardResponse["source"]> {
  const rows = (await db.execute(sql`
    SELECT name, latitude::float8 AS lat, longitude::float8 AS lon
    FROM gtfs_stops
    WHERE feed_id = ${feedId} AND stop_id = ANY(${sql.param(ids)}::text[]) AND name IS NOT NULL
  `)) as unknown as { rows: Array<{ name: string; lat: number | null; lon: number | null }> };
  const cosLat = lat != null ? Math.cos((lat * Math.PI) / 180) : 1;
  let best: { name: string; lat: number | null; lon: number | null } | null = null;
  let bestD = Infinity;
  for (const r of rows.rows ?? []) {
    const d = lat != null && lon != null && r.lat != null && r.lon != null
      ? (r.lat - lat) ** 2 + ((r.lon - lon) * cosLat) ** 2
      : Number.MAX_VALUE;
    if (!best || d < bestD) {
      best = r;
      bestD = d;
    }
  }
  return best ? { name: timetableStopName(country, best.name), latitude: best.lat, longitude: best.lon } : undefined;
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
  // Lage 0/0 = unbekannt (siehe `getScheduledTrip`); Zahlen statt Text aus `numeric`.
  const rows = (result.rows ?? []).map((r) => {
    const la = r.latitude == null ? null : Number(r.latitude);
    const lo = r.longitude == null ? null : Number(r.longitude);
    const unknown = la == null || lo == null || (Math.abs(la) < 1 && Math.abs(lo) < 1);
    return { ...r, latitude: unknown ? null : la, longitude: unknown ? null : lo };
  });
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

export interface ScheduledTrip {
  feedId: string;
  /** Zeitzone des Feeds (Ortszeit der Fahrt) — für die Anzeige. */
  tz: string;
  line: string | null;
  product: string;
  headsign: string | null;
  stops: Array<{
    stopId: string;
    name: string | null;
    latitude: number | null;
    longitude: number | null;
    /** ISO-UTC. */
    arrival: string;
    departure: string;
  }>;
}

/**
 * Eine GANZE Fahrt aus dem Länder-Fahrplan — für `/api/trips/detail`.
 *
 * Die Tafeln aus GTFS (NL/BE/CZ/UK) liefern als Kennung die `trip_id` des
 * Feeds. Die Fahrt-Ansicht kannte nur MOTIS- und HAFAS-Kennungen: Jeder Tipp
 * auf eine solche Abfahrt endete mit 404, in der App „Fahrt gerade nicht
 * ladbar" — in ganz Großbritannien, den Niederlanden, Belgien und Tschechien.
 *
 * DER BETRIEBSTAG muss geraten werden, wenn der Aufrufer ihn nicht mitgibt:
 * GTFS-Zeiten zählen ab dem Betriebstag, und eine Fahrt kann heute UND gestern
 * gelten (Nachtlinie nach Mitternacht). Genommen wird der Tag, an dem die
 * Fahrt verkehrt und deren Halt `near`/`stopCode` zeitlich am nächsten an
 * `atTime` liegt (Vorgabe: jetzt — die Tafel zeigt nur die nächsten zwei
 * Stunden, das ist eindeutig).
 *
 * @returns null, wenn der Feed die Fahrt nicht kennt — der Aufrufer versucht
 *          es dann wie bisher (MOTIS/HAFAS).
 */
export async function getScheduledTrip(args: {
  country: string;
  tripId: string;
  /** Unser Halt — um den Betriebstag über SEINE Abfahrtszeit zu bestimmen. */
  stopCode?: string | null;
  near?: { latitude: number; longitude: number } | null;
  /** Abfahrt am Halt laut Tafel (ISO). Ohne: jetzt. */
  atTime?: string | null;
}): Promise<ScheduledTrip | null> {
  const feedId = FEED_ID_BY_COUNTRY[args.country];
  if (!feedId) return null;
  if (!(await isFeedImported(feedId))) return null;

  const tripRows = (await db.execute(sql`
    SELECT t.service_id, t.headsign, r.short_name, r.long_name, r.type AS route_type
    FROM gtfs_trips t
    LEFT JOIN gtfs_routes r ON r.feed_id = t.feed_id AND r.route_id = t.route_id
    WHERE t.feed_id = ${feedId} AND t.trip_id = ${args.tripId}
    LIMIT 1
  `)) as unknown as {
    rows: Array<{
      service_id: string;
      headsign: string | null;
      short_name: string | null;
      long_name: string | null;
      route_type: number | null;
    }>;
  };
  const trip = tripRows.rows?.[0];
  if (!trip) return null;

  const stopRows = (await db.execute(sql`
    SELECT st.stop_id, st.arrival_seconds, st.departure_seconds,
           s.name, s.latitude, s.longitude, s.parent_station
    FROM gtfs_stop_times st
    LEFT JOIN gtfs_stops s ON s.feed_id = st.feed_id AND s.stop_id = st.stop_id
    WHERE st.feed_id = ${feedId} AND st.trip_id = ${args.tripId}
    ORDER BY st.stop_sequence ASC
  `)) as unknown as {
    rows: Array<{
      stop_id: string;
      arrival_seconds: number;
      departure_seconds: number;
      name: string | null;
      latitude: string | number | null;
      longitude: string | number | null;
      parent_station: string | null;
    }>;
  };
  const rows = (stopRows.rows ?? []).map((r) => {
    /**
     * 0/0 heißt „Lage unbekannt": Der niederländische Feed führt so 126
     * ausländische Halte (Berlin Südkreuz, Dortmund Hbf …). Als Koordinate
     * genommen, stünde das Ziel eines internationalen Zugs auf der Karte im
     * Golf von Guinea.
     */
    const la = r.latitude == null ? null : Number(r.latitude);
    const lo = r.longitude == null ? null : Number(r.longitude);
    const unknown = la == null || lo == null || (Math.abs(la) < 1 && Math.abs(lo) < 1);
    return { ...r, latitude: unknown ? null : la, longitude: unknown ? null : lo };
  });
  if (rows.length < 2) return null;
  const num = (v: number | null) => v;

  // Unser Halt in der Fahrt: Kennung (auch als Elternstation), sonst der
  // nächstgelegene Halt. Nur für den Betriebstag — geschnitten wird später.
  const directId = args.stopCode ? gtfsStopIdFromCode(args.stopCode) : null;
  let originIdx = directId
    ? rows.findIndex((r) => r.stop_id === directId || r.parent_station === directId)
    : -1;
  if (originIdx < 0 && args.near) {
    const { latitude: lat, longitude: lon } = args.near;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    let best = Infinity;
    rows.forEach((r, i) => {
      const la = num(r.latitude);
      const lo = num(r.longitude);
      if (la == null || lo == null) return;
      const d = (la - lat) ** 2 + ((lo - lon) * cosLat) ** 2;
      if (d < best) {
        best = d;
        originIdx = i;
      }
    });
  }
  if (originIdx < 0) originIdx = 0;
  const originSec = rows[originIdx]!.departure_seconds;

  const tz = feedTz(feedId);
  const target = args.atTime ? Date.parse(args.atTime) : Date.now();
  const targetMs = Number.isFinite(target) ? target : Date.now();
  const today = serviceDate(new Date(targetMs), tz);
  const nextDate = (d: string) =>
    new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  let baseMs: number | null = null;
  let bestGap = Infinity;
  for (const date of [previousDate(today), today, nextDate(today)]) {
    const active = await activeServiceIds(feedId, date);
    if (!active.has(trip.service_id)) continue;
    const base = serviceDayBaseMs(date, tz);
    const gap = Math.abs(base + originSec * 1000 - targetMs);
    if (gap < bestGap) {
      bestGap = gap;
      baseMs = base;
    }
  }
  // Fährt laut Kalender an keinem der drei Tage (Kalender-Lücke im Feed):
  // dann der heutige — die Uhrzeiten stimmen, nur das Datum ist geraten.
  if (baseMs == null) baseMs = serviceDayBaseMs(today, tz);

  const routeType = trip.route_type ?? 3;
  return {
    feedId,
    tz,
    line: (trip.short_name ?? trip.long_name ?? "").trim() || null,
    product: routeTypeToProduct(routeType),
    headsign: trip.headsign?.trim() || null,
    stops: rows.map((r) => ({
      stopId: r.stop_id,
      name: r.name,
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      arrival: new Date(baseMs! + r.arrival_seconds * 1000).toISOString(),
      departure: new Date(baseMs! + r.departure_seconds * 1000).toISOString(),
    })),
  };
}
