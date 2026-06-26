import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { locations } from "../../db/schema.js";
import {
  getStopBoard,
  resolveHafasByCoord,
  type StopBoardItem,
} from "../../services/stopInfoService.js";
import { profileForStop, isAtRegionalProfile } from "../../services/countryProfile.js";
import {
  getScheduledStopBoard,
  getScheduledTripStops,
} from "../../services/gtfsSchedule.js";
import { dbVendoProvider } from "./dbVendo.js";
import type {
  LegInfo,
  NormalizedResult,
  ProviderResult,
  ProviderSearchInput,
  SearchProvider,
  StopoverInfo,
} from "../types.js";

/**
 * Schedule-only Provider für nicht-buchbare ÖPNV-Stops.
 *
 * Greift wenn der Origin Tram, U-Bahn oder ein GTFS-only-Land-Stop ist
 * (NL/BE/CZ/GB ohne hafas_id-Coverage). Liefert für jede solche Suche
 * NormalizedResult[] mit `price=0` — die UI rendert dann "Tarif beim
 * Anbieter" statt eines Buchungs-CTAs.
 *
 * Strategien in dieser Reihenfolge:
 *  1) WALK + TRAIN HYBRID — wenn der nächstgelegene Bahnhof <2 km vom
 *     Origin entfernt ist UND eine hafas_id hat: zu Fuß zum Bahnhof, dann
 *     DB-HAFAS-Routing. So bekommt der User echte Umstiege/Zug-Verbindungen.
 *  2) STOP-BOARD-FALLBACK — wenn (1) nicht greift: nächste Departures am
 *     Origin pro Linie mit den kompletten Zwischenhalten. Keine Umstiege,
 *     aber wenigstens Abfahrtszeiten und Linien-Ziel sichtbar.
 *
 * Für BE/FR/IT/ES/PT/HU/SK/IE/GB greift in der Praxis nur (2) weil DB-HAFAS
 * dort intern keine Verbindungen routet und unsere alternativen Routing-
 * Quellen (sncb, SNCF) entweder gesperrt oder kein HAFAS sind.
 */
export const transitScheduleProvider: SearchProvider = {
  name: "transit-schedule",
  mode: "TRAIN",
  isConfigured: () => true,

  async search(input, signal): Promise<ProviderResult> {
    const start = Date.now();

    const originStop = await loadStop(input.origin);
    if (!originStop) return empty(start);
    if (!isScheduleOnly(originStop)) return empty(start);

    // Strategy 1: Walk + Train Hybrid
    // Wenn der User-Origin ein non-Bahnhof-Stop ist (Tram/Bus/U-Bahn) und in
    // der Nähe ein echter Bahnhof liegt, nehmen wir den als Ausgangspunkt und
    // berechnen die Walking-Zeit dahin oben drauf.
    const hybrid = await tryWalkAndTrain(originStop, input, signal);
    if (hybrid && hybrid.length > 0) {
      return {
        results: hybrid,
        raw: { source: "transit-schedule", via: "walk+train", origin: input.origin, count: hybrid.length },
        statusCode: 200,
        durationMs: Date.now() - start,
      };
    }

    // Strategy 2: Stop-Board-Fallback (Abfahrten am Origin mit Trip-Stops)
    const items = await fetchOriginDepartures(originStop);
    if (items.length === 0) return empty(start);

    const TRIP_DETAIL_LIMIT = 6;
    const enriched = await Promise.all(
      items.slice(0, TRIP_DETAIL_LIMIT).map((item) => enrichWithTripStops(item, originStop)),
    );
    const results: NormalizedResult[] = enriched.map((data, i) =>
      toNormalizedResult(items[i]!, data, originStop, input, i),
    );

    return {
      results,
      raw: { source: "transit-schedule", via: "stop-board", origin: input.origin, count: results.length },
      statusCode: 200,
      durationMs: Date.now() - start,
    };
  },
};

// ============================================================================
// Walk + Train Hybrid: Origin = non-Bahnhof → walk zu nahem Bahnhof → DB-HAFAS
// ============================================================================

/** HAFAS-starke Länder: DB-HAFAS bzw. hafas-client npm können dort
 *  Multi-Modal-Routing nativ machen (Origin = U-Bahn-Stop → HAFAS routet
 *  automatisch via U-Bahn + ICE etc.). In diesen Ländern ist unser naives
 *  „Walk to nearest Bahnhof" eher schlechter als die HAFAS-Routung —
 *  beispielsweise würde unser Algo für München Odeonsplatz erst 839 m zu
 *  Marienplatz gehen, während HAFAS einfach die U6 von Odeonsplatz selbst
 *  zum Hbf nehmen würde. Daher: Hybrid NUR in GTFS-only-Ländern wo HAFAS
 *  uns keine Routung liefert. */
const HAFAS_ROUTABLE_COUNTRIES = new Set([
  "Germany",
  "Austria",
  "Switzerland",
  "Poland",
  "Luxembourg",
  "Denmark",
]);

/** Maximale Walking-Distanz zum nächsten Bahnhof. 2 km in <30 Min zu Fuß ist
 *  für die meisten User OK. Wenn weiter, machen wir Stop-Board statt Hybrid. */
const MAX_WALK_DISTANCE_M = 2000;
/** Walking-Geschwindigkeit für die Walking-Leg-Dauer-Schätzung. 4.8 km/h =
 *  80 m/min entspricht "normal gehen" laut OTP-Default. */
const WALK_SPEED_M_PER_MIN = 80;

interface NearestStation {
  code: string;
  label: string;
  latitude: number;
  longitude: number;
  /** Luftlinie in Metern (Bbox-distance approximation). Walking-Distanz ist
   *  in der Realität ~1.3x länger wegen Straßennetz — wir korrigieren beim
   *  Time-Estimate. */
  distanceMeters: number;
}

async function tryWalkAndTrain(
  origin: StopRow,
  input: ProviderSearchInput,
  signal?: AbortSignal,
): Promise<NormalizedResult[] | null> {
  if (origin.latitude == null || origin.longitude == null || !origin.country) return null;
  // Skip in HAFAS-starken Ländern: dbVendo / multiHafas können dort selber
  // multi-modal routen, unser walk+train wäre nur kontraproduktiv.
  if (HAFAS_ROUTABLE_COUNTRIES.has(origin.country)) return null;
  const lat = Number(origin.latitude);
  const lng = Number(origin.longitude);
  const station = await findNearestTrainStation(lat, lng, origin.country);
  if (!station) return null;

  // Walking-Distanz korrigieren (Luftlinie → realistic walking ~1.3x).
  const walkingDistMeters = Math.round(station.distanceMeters * 1.3);
  const walkingMinutes = Math.max(1, Math.ceil(walkingDistMeters / WALK_SPEED_M_PER_MIN));

  // dbVendo mit Station als Origin aufrufen. departTime — falls der Caller
  // einen Wert mitgibt — schieben wir um die Walking-Zeit nach hinten, damit
  // die User-tatsächlich-erreichbare Verbindung im Fenster landet.
  const dbInput: ProviderSearchInput = {
    ...input,
    origin: station.code,
    originLabel: station.label,
    departTime: input.departTime
      ? new Date(Date.parse(input.departTime) + walkingMinutes * 60_000).toISOString()
      : undefined,
  };
  const dbResult = await dbVendoProvider.search(dbInput, signal);
  if (dbResult.results.length === 0) return null;

  return dbResult.results.map((r, idx) =>
    prependWalkingLeg(r, origin, station, walkingMinutes, walkingDistMeters, input, idx),
  );
}

/** Findet den nächstgelegenen Bahnhof mit hafas_id im Bbox-Radius. Filter:
 *    - Selbes Land (kein Walking über Grenze)
 *    - hafas_id IS NOT NULL (= DB-buchbar oder zumindest dbVendo-resolvable)
 *    - type=TRAIN, subtype IN (LONG_DISTANCE, REGIONAL, SUBURBAN) — also
 *      echte Bahnhöfe, keine U-Bahn-Stationen. */
async function findNearestTrainStation(
  lat: number,
  lng: number,
  country: string,
): Promise<NearestStation | null> {
  // Bbox: 0.02° ≈ ~2.2 km Lat-Direction. Lon-Skalierung pro cos(lat).
  const dLat = MAX_WALK_DISTANCE_M / 111_000;
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const rows = (await db.execute(sql`
    SELECT
      code,
      label,
      latitude::float AS lat,
      longitude::float AS lng,
      -- Squared euclidean (mit lon-Skalierung) als Distance-Proxy für
      -- die Sortierung. Nicht meter-genau, aber für "nearest" reicht's.
      ((latitude::float - ${lat}) * (latitude::float - ${lat})) +
      ((longitude::float - ${lng}) * (longitude::float - ${lng}) *
        ${Math.cos((lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180)})
        AS dist_sq
    FROM locations
    WHERE country = ${country}
      AND hafas_id IS NOT NULL
      AND type = 'TRAIN'
      AND subtype IN ('LONG_DISTANCE', 'REGIONAL', 'SUBURBAN')
      AND latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude::float BETWEEN ${lat - dLat} AND ${lat + dLat}
      AND longitude::float BETWEEN ${lng - dLon} AND ${lng + dLon}
    ORDER BY dist_sq ASC
    LIMIT 1
  `)) as unknown as {
    rows: Array<{ code: string; label: string; lat: number; lng: number; dist_sq: number }>;
  };
  const row = (rows.rows ?? [])[0];
  if (!row) return null;
  // dist_sq in meter umrechnen: sqrt(dist_sq) ist Distanz in Grad, * 111000
  // ergibt Meter. Approximation für Mitteleuropa.
  const distMeters = Math.round(Math.sqrt(row.dist_sq) * 111_000);
  return {
    code: row.code,
    label: row.label,
    latitude: row.lat,
    longitude: row.lng,
    distanceMeters: distMeters,
  };
}

/** Stellt vor einen dbVendo-Result einen Walking-Leg "Origin → Bahnhof". Die
 *  Gesamt-Verbindung sieht dann aus: Walking + Train-Legs vom dbVendo-Result. */
function prependWalkingLeg(
  result: NormalizedResult,
  origin: StopRow,
  station: NearestStation,
  walkingMinutes: number,
  walkingDistMeters: number,
  input: ProviderSearchInput,
  idx: number,
): NormalizedResult {
  // Walking startet so dass es genau am train-departure endet (User kommt
  // gerade rechtzeitig an). Train-departure = result.departTime.
  const trainDepartMs = Date.parse(result.departTime);
  const walkStartIso = new Date(trainDepartMs - walkingMinutes * 60_000).toISOString();
  const walkArriveIso = result.departTime;

  const walkingLeg: LegInfo = {
    origin: origin.code,
    destination: station.code,
    originLabel: origin.label,
    destLabel: station.label,
    originLat: origin.latitude != null ? Number(origin.latitude) : undefined,
    originLng: origin.longitude != null ? Number(origin.longitude) : undefined,
    destLat: station.latitude,
    destLng: station.longitude,
    departTime: walkStartIso,
    arriveTime: walkArriveIso,
    durationMinutes: walkingMinutes,
    walking: true,
    // Linien-Text für die UI: zeigt "Zu Fuß · 12 Min · 950m"
    line: `Zu Fuß · ${walkingDistMeters} m`,
    product: "walk",
    stops: 0,
  };

  // Train-Legs aus dem dbVendo-Result kommen in `result.legs` (von dbVendo
  // schon befüllt). Falls leer (sollte selten sein), wenigstens den Walking-
  // Leg setzen — der User sieht dann nur den Walk vor dem Train-Header.
  const existingLegs = result.legs ?? [];
  const allLegs = [walkingLeg, ...existingLegs];

  // Umstieg-Labels: Walking + Train-internal Umstiege. Der Bahnhof selbst
  // ist KEIN Umstieg (User geht durch), also nicht in stopLabels.
  const stopLabels = result.stopLabels ?? [];

  return {
    ...result,
    externalId: `hybrid:${origin.code}:${result.externalId}:${idx}`,
    origin: origin.code,
    originLabel: input.originLabel ?? origin.label,
    departTime: walkStartIso,
    durationMinutes: result.durationMinutes + walkingMinutes,
    legs: allLegs,
    stopLabels,
    // Walking + DB-HAFAS-Preis durchreichen. dbVendo setzt manchmal price=0
    // (Verbund-Tarif) → wir lassen das stehen. Hybrid-Card ist nicht direkt
    // buchbar (deepLink würde zur Train-only-URL führen), daher deepLink
    // leeren und User über Linien-Detail zum Buchen leiten lassen.
    deepLink: "",
    // operatedBy als kurze Tour-Beschreibung: "Walking + 1 Umstieg"
    operatedBy:
      result.stops > 0
        ? `Zu Fuß zum Bahnhof, ${result.stops} Umstieg${result.stops > 1 ? "e" : ""}`
        : "Zu Fuß zum Bahnhof, dann direkt",
  };
}

function empty(start: number): ProviderResult {
  return {
    results: [],
    raw: { source: "transit-schedule", skipped: true },
    statusCode: 0,
    durationMs: Date.now() - start,
  };
}

interface StopRow {
  code: string;
  label: string;
  country: string | null;
  subtype: string | null;
  type: string | null;
  hafasId: string | null;
  latitude: string | null;
  longitude: string | null;
}

async function loadStop(code: string): Promise<StopRow | null> {
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      country: locations.country,
      subtype: locations.subtype,
      type: locations.type,
      hafasId: locations.hafasId,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(eq(locations.code, code))
    .limit(1);
  return rows[0] ?? null;
}

/** Länder bei denen wir GTFS-Schedule statt HAFAS nutzen (kein HAFAS-Profile
 *  verfügbar). Diese Stops haben in der Regel keinen hafas_id — dbVendo kann
 *  sie nicht resolven und der Schedule-Pfad ist die einzige Option. */
const GTFS_ONLY_COUNTRIES = new Set([
  "Netherlands",
  "Belgium",
  "Czech Republic",
  "United Kingdom",
  "France",
  "Italy",
  "Spain",
  "Portugal",
  "Hungary",
  "Slovakia",
  "Ireland",
]);

function isScheduleOnly(stop: StopRow): boolean {
  // HAFAS-starke Länder: dbVendo (DB) bzw. multiHafas (oebb/zvv/...) routen
  // dort selbst — auch von Tram/U-Bahn-Stops aus, mit echtem Multi-Modal.
  // Unser Provider würde nur Rauschen erzeugen (Stop-Board-Nachtbus-
  // Departures statt Frankfurt-Verbindungen). Komplett überspringen.
  if (stop.country && HAFAS_ROUTABLE_COUNTRIES.has(stop.country)) return false;
  // GTFS-only-Länder (NL/BE/CZ/GB/FR/IT/ES/PT/HU/SK/IE): kein HAFAS, daher
  // schalten wir den Schedule-Provider ein (Hybrid + Stop-Board-Fallback).
  if (stop.country && GTFS_ONLY_COUNTRIES.has(stop.country) && !stop.hafasId) return true;
  // Sonderfall: Stops ohne klares Land aber als TRAM/SUBWAY markiert.
  // Selten — die meisten haben country gesetzt. Fallback auf schedule-only.
  if (!stop.country && (stop.subtype === "TRAM" || stop.subtype === "SUBWAY")) return true;
  return false;
}

async function fetchOriginDepartures(stop: StopRow): Promise<StopBoardItem[]> {
  const lat = stop.latitude != null ? Number(stop.latitude) : null;
  const lon = stop.longitude != null ? Number(stop.longitude) : null;

  // GTFS-Schedule zuerst (NL/BE/CZ/GB/FR/IT/ES/...). Wenn der Feed importiert
  // ist und der Stop drin liegt, liefert das planmäßige Abfahrten. null =
  // kein GTFS verfügbar → HAFAS-Pfad probieren.
  const gtfs = await getScheduledStopBoard({
    stopCode: stop.code,
    country: stop.country,
    board: "departures",
    latitude: lat,
    longitude: lon,
  });
  if (gtfs) return gtfs.results;

  // HAFAS-Profile (DE/AT/CH/PL/LU/DK) — via stopInfoService-Dispatcher.
  const profile = profileForStop({
    code: stop.code,
    country: stop.country,
    latitude: lat,
    longitude: lon,
  });
  if (!profile) return [];

  // AT-Verbund-Profile haben eigenen ID-Raum → gespeicherte hafas_id ist
  // unbrauchbar, immer per Coord+Name resolven. Sonst: hafas_id direkt.
  const skipCachedId = isAtRegionalProfile(profile);
  let resolvedId = !skipCachedId && stop.hafasId ? stop.hafasId : null;
  if (!resolvedId && lat != null && lon != null) {
    // expectedType verhindert dass ein BUS-Stop fälschlich an die direkt
    // benachbarte Train-Station resolved (Westtünnen-Bug).
    const expectedType = stop.type === "BUS" || stop.type === "TRAIN" || stop.type === "ALL"
      ? stop.type
      : null;
    resolvedId = await resolveHafasByCoord(lat, lon, stop.label, profile, expectedType);
  }
  if (!resolvedId) return [];

  try {
    const data = await getStopBoard(resolvedId, "departures", profile);
    return data.results;
  } catch {
    return [];
  }
}

interface TripStopsEnriched {
  stopovers: StopoverInfo[];
  /** Letzter Stop des Trips ab Origin = Linien-Endstation oder letzter
   *  bekannter Halt. Wird für arriveTime/destLabel benutzt. */
  lastStopName: string | null;
  lastStopArrival: string;
  lastStopLat: number | null;
  lastStopLng: number | null;
  firstStopLat: number | null;
  firstStopLng: number | null;
}

/** Holt die kompletten Stops eines Trips, ab dem Origin. GTFS-Länder via
 *  DB-JOIN; HAFAS-Länder noch ohne Trip-Detail (next iteration) → null. */
async function enrichWithTripStops(
  item: StopBoardItem,
  stop: StopRow,
): Promise<TripStopsEnriched | null> {
  if (!stop.country) return null;
  // GTFS-Pfad: nur wenn der Stop in einem GTFS-Land liegt UND wir keinen
  // HAFAS-Profile-Pfad haben (sonst kommt der tripId aus HAFAS und passt
  // nicht in unsere gtfs_*-Tabellen).
  const isGtfsCountry = GTFS_ONLY_COUNTRIES.has(stop.country);
  if (!isGtfsCountry) return null;
  const lat = stop.latitude != null ? Number(stop.latitude) : null;
  const lon = stop.longitude != null ? Number(stop.longitude) : null;
  const stops = await getScheduledTripStops({
    country: stop.country,
    tripId: item.id,
    originStopCode: stop.code,
    originLatitude: lat,
    originLongitude: lon,
    originTime: item.actualTime ?? item.plannedTime,
  });
  if (!stops || stops.length < 2) return null;
  const lastStop = stops[stops.length - 1]!;
  const firstStop = stops[0]!;
  // Zwischenhalte = alle außer Origin und Endstation (= Konvention der UI).
  const middle = stops.slice(1, -1);
  return {
    stopovers: middle.map((s) => ({
      name: s.name ?? undefined,
      arrival: s.arrival,
      departure: s.departure,
    })),
    lastStopName: lastStop.name,
    lastStopArrival: lastStop.arrival,
    lastStopLat: lastStop.latitude,
    lastStopLng: lastStop.longitude,
    firstStopLat: firstStop.latitude,
    firstStopLng: firstStop.longitude,
  };
}

function toNormalizedResult(
  item: StopBoardItem,
  enriched: TripStopsEnriched | null,
  stop: StopRow,
  input: ProviderSearchInput,
  idx: number,
): NormalizedResult {
  const depart = item.actualTime ?? item.plannedTime;
  // Falls Trip-Stops geholt wurden, nutzen wir die echten Daten — sonst
  // fallen wir auf die nackte Departure-Info zurück (arriveTime = depart,
  // Dauer = 0 — die UI zeigt's als "Tarif beim Anbieter, keine A→B-Daten").
  const arrive = enriched ? enriched.lastStopArrival : depart;
  const durationMinutes = enriched
    ? Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60_000))
    : 0;
  const stopovers = enriched?.stopovers ?? [];
  const stopLabels = stopovers.map((s) => s.name).filter((n): n is string => !!n);
  // destLabel: enriched ? Endstations-Name : Linien-Richtung (= Headsign).
  // Vorteil enriched: User sieht die echte Endstation („Scheveningen Haven")
  // statt nur das Headsign (manchmal kürzer/abweichend).
  const directionLabel = enriched?.lastStopName ?? item.direction;
  const legs: LegInfo[] | undefined = enriched
    ? [
        {
          origin: stop.code,
          destination: input.destination,
          originLabel: input.originLabel ?? stop.label,
          destLabel: directionLabel ?? undefined,
          originLat: enriched.firstStopLat ?? undefined,
          originLng: enriched.firstStopLng ?? undefined,
          destLat: enriched.lastStopLat ?? undefined,
          destLng: enriched.lastStopLng ?? undefined,
          departTime: depart,
          arriveTime: arrive,
          durationMinutes,
          line: item.line,
          product: item.product ?? undefined,
          direction: item.direction || undefined,
          stops: stopovers.length,
          stopovers: stopovers.length > 0 ? stopovers : undefined,
          tripId: item.id,
        },
      ]
    : undefined;
  return {
    externalId: `schedule:${stop.code}:${item.id}:${idx}`,
    origin: stop.code,
    destination: input.destination,
    originLabel: input.originLabel ?? stop.label,
    destLabel: directionLabel || (input.destLabel ?? ""),
    departTime: depart,
    arriveTime: arrive,
    dateOnly: false,
    durationMinutes,
    stops: stopovers.length,
    stopLabels,
    legs,
    price: 0,
    currency: input.currency,
    // Kein deepLink — schedule-only ist nicht buchbar. UI nutzt bei leerem
    // bookUrl den existierenden Trip-Detail-Flow (LegTimelineOverlay).
    deepLink: "",
    // flightNumber dient hier als "Linien-Kürzel" (z.B. "U4", "Tram 11").
    flightNumber: item.line,
    operatedBy: item.product ?? undefined,
  };
}
