import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { config } from "../config.js";
import { decodePolyline, getMotisTripPolyline, motisFetch } from "../services/motisClient.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { profileForStop, type HafasProfileKey } from "../services/countryProfile.js";
import { fetchTrip as multiFetchTrip } from "../services/multiHafas.js";
import { cleanPlatform } from "../util/platform.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { EXPENSIVE_IP_CEILING_FACTOR, ipLimiter } from "../util/rateLimit.js";
import { liveSearchesInFlight } from "../services/searchService.js";
import { acquireDb, reportIfBlocked, tryAcquireDb, type DbLane } from "../services/dbQuota.js";
import { FEED_ID_BY_COUNTRY, getScheduledTrip } from "../services/gtfsSchedule.js";
import { dbStopTz, dbTimeToUtc } from "../util/dbTime.js";
import { timetableStopName } from "../util/stopDisplayName.js";
import { isoOffset } from "../util/isoOffset.js";
import { matchStopIndices } from "../util/tripStopMatch.js";
import { buildLiveShape, type LngLat } from "../util/liveShape.js";

/**
 * Liefert die geographische Polyline (Route entlang der Schienen) für eine
 * Liste von HAFAS Trip-IDs. Eine Trip-ID kommt pro Leg aus der Search-Response
 * (`legs[i].tripId`). Der Frontend ruft diesen Endpoint on-demand auf wenn
 * der User „Route anzeigen" klickt — dadurch bleibt die Such-Liste schnell.
 *
 * Quelle: dbrest `/trips/{id}?polyline=true` (HAFAS).
 */

interface PolylineFeature {
  type: "Feature";
  geometry?: { type: "Point"; coordinates: [number, number] };
}

interface DbTripResponse {
  trip?: DbTripBody;
  polyline?: {
    type: "FeatureCollection";
    features: PolylineFeature[];
  };
}

interface DbTripBody {
  id?: string;
  origin?: DbTripStop;
  destination?: DbTripStop;
  departure?: string;
  plannedDeparture?: string;
  arrival?: string;
  plannedArrival?: string;
  plannedDeparturePlatform?: string;
  departurePlatform?: string;
  plannedArrivalPlatform?: string;
  arrivalPlatform?: string;
  line?: { name?: string; fahrtNr?: string; product?: string };
  direction?: string;
  stopovers?: DbTripStopover[];
  polyline?: { type: "FeatureCollection"; features: PolylineFeature[] };
}

interface DbTripStop {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number };
}

interface DbTripStopover {
  stop?: DbTripStop;
  arrival?: string;
  plannedArrival?: string;
  departure?: string;
  plannedDeparture?: string;
  arrivalPlatform?: string;
  plannedArrivalPlatform?: string;
  departurePlatform?: string;
  plannedDeparturePlatform?: string;
  cancelled?: boolean;
}

const querySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
});

/**
 * Verläufe gemerkt — eine Fahrt fährt heute dieselbe Strecke wie vor fünf
 * Minuten. Derselbe ICE steht in mehreren Verbindungen einer Suche (über
 * Hamm, über Münster …) und würde sonst für jede einzeln bei der Bahn geholt.
 * Leere Antworten werden NICHT gemerkt: Ein Aussetzer soll beim nächsten
 * Öffnen neu versucht werden, nicht für Stunden als Gerade stehen bleiben.
 */
const polylineCache = new BoundedTtlCache<[number, number][]>(2000, 6 * 60 * 60 * 1000);

/**
 * Kennungen OHNE Verlauf — zehn Minuten gemerkt.
 *
 * Bisher wurde nur ein Treffer gemerkt. Eine Kennung, die nie einen Verlauf
 * bekommt (Fahrten aus den Länder-Fahrplänen, siehe `isDbwebTripId`), ging
 * damit bei JEDEM Öffnen einer Stadt erneut an die DB.
 */
const polylineMiss = new BoundedTtlCache<true>(2000, 10 * 60 * 1000);

/**
 * Nur DBs eigene Fahrt-Kennungen gehen an dbweb (int.bahn.de): Sie tragen
 * `#VN#` („2|#VN#1#ST#…"). Alles andere — etwa die `trip_id`s der
 * Länder-Fahrpläne (NL/BE/CZ/UK/FR/IT, services/transitSchedule.ts) — kennt
 * die DB nicht; die Anfrage kostete Kontingent und scheiterte immer.
 */
function isDbwebTripId(tripId: string): boolean {
  return tripId.includes("#VN#");
}

/**
 * DAS DB-KONTINGENT GEHÖRT DER SUCHE — Gleisverläufe sind nachrangig.
 *
 * Eine Stadt auf der Karte zeichnet bis zu vier Strecken, zusammen leicht zehn
 * bis sechzehn Fahrten, jede ein Abruf bei dbweb. Drei Städte in einer Minute
 * hätten die ~60 Anfragen/Minute der Suche aufgebraucht.
 *
 * Deshalb die Stufe `background` im gemeinsamen Kontingent (services/
 * dbQuota.ts) — und zusätzlich Vorrang für die Suche: Solange eine Suche live
 * bei den Anbietern läuft, wartet jeder Verlaufs-Abruf. Wer zu lange wartet
 * (10 s), bekommt keinen Verlauf und fragt später wieder; gemerkt wird so ein
 * Ausfall nicht.
 */
const POLY_MAX_WAIT_MS = 10_000;

async function waitForDbwebSlot(until = Date.now() + POLY_MAX_WAIT_MS): Promise<DbLane | null> {
  for (;;) {
    if (liveSearchesInFlight() === 0) {
      const lane = tryAcquireDb("background");
      if (lane) return lane;
    }
    if (Date.now() >= until) return null;
    await new Promise((done) => setTimeout(done, 250));
  }
}

/**
 * Höchstens drei Abrufe gleichzeitig.
 *
 * Hier stand `Promise.all` über bis zu zehn Kennungen — zehn Anfragen im selben
 * Augenblick an dieselbe Bahn-Schnittstelle, deren Kontingent (~60/min) der
 * Suche gehört. Drei nebeneinander sind für ein Kartenbild schnell genug.
 */
async function polylinesThrottled(ids: string[]): Promise<Array<[number, number][] | null>> {
  const out: Array<[number, number][] | null> = new Array(ids.length).fill(null);
  /**
   * EINE Wartefrist für den ganzen Abruf, nicht eine je Fahrt: Bei zehn
   * Kennungen und drei Arbeitern summierte sich die Wartezeit sonst auf rund
   * 40 s — für eine Anfrage, die niemand abbrechen kann.
   */
  const until = Date.now() + POLY_MAX_WAIT_MS;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      const id = ids[i]!;
      const hit = polylineCache.get(id);
      if (hit) {
        out[i] = hit;
        continue;
      }
      if (polylineMiss.get(id)) continue;
      const coords = await fetchTripPolyline(id, until);
      if (coords) polylineCache.set(id, coords);
      else if (coords === null) polylineMiss.set(id, true);
      out[i] = coords ?? null;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

/**
 * `null` = kein Verlauf (gemerkt), `undefined` = diesmal nicht abgerufen, weil
 * das DB-Budget erschöpft war (NICHT gemerkt — beim nächsten Mal wieder).
 */
async function fetchTripPolyline(
  tripId: string,
  /** Bis wann auf einen Platz im Kontingent gewartet wird (siehe `polylinesThrottled`). */
  until?: number,
): Promise<[number, number][] | null | undefined> {
  // MOTIS-tripIds (Format YYYYMMDD_HH:MM_<feed>_<num>) → Geometrie direkt von
  // MOTIS (precision-6-Polyline).
  if (/^\d{8}_\d{2}:\d{2}_/.test(tripId)) {
    return getMotisTripPolyline(tripId);
  }
  if (!isDbwebTripId(tripId)) return null;
  const lane = await waitForDbwebSlot(until);
  if (!lane) return undefined;
  // HAFAS-tripIds (2|#VN#...) kommen von dbweb (bahn.de-Routen) → gegen den
  // dbweb-Sidecar (int.bahn.de, UNBLOCKIERT), NICHT den geblockten db-Container.
  // Response-Format identisch (GeoJSON features[].geometry.coordinates=[lng,lat]).
  //
  // `language=de` ist PFLICHT: Ohne gibt das `dbweb`-Profil seine Vorgabe
  // „Accept-Language: en" weiter, und genau die sperrt Akamai auf
  // int.bahn.de/…/fahrt mit 403 OPS_BLOCKED — nachgestellt Kopfzeile für
  // Kopfzeile (Sept. 2026): „de" → 200, „en" → 403, alles andere egal. Die
  // Suche (dbVendo.ts) und die Tafeln (stopInfoService.ts) setzen es längst;
  // hier fehlte es, und jede Route auf der Karte fiel auf Geraden zwischen den
  // Halten zurück.
  const url = `${lane.dbwebUrl}/trips/${encodeURIComponent(tripId)}?polyline=true&stopovers=false&language=de`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      // Nicht länger warten als ein Nutzer auf eine graue Linie wartet.
      signal: AbortSignal.timeout(8000),
    });
    /**
     * Nur ein ECHTES „gibt es nicht" (404/410) wird als Fehltreffer gemerkt.
     * Sperre, Drosselung, Serverfehler und Zeitüberschreitung sind
     * vorübergehend — sie als „kein Verlauf" zehn Minuten festzuhalten, ließ
     * die Linie auch dann gerade, wenn die Bahn eine Minute später wieder
     * geantwortet hätte.
     */
    await reportIfBlocked(lane, res);
    if (!res.ok) return res.status === 404 || res.status === 410 ? null : undefined;
    const data = (await res.json()) as DbTripResponse;
    const fc = data.trip?.polyline ?? data.polyline;
    if (!fc || !Array.isArray(fc.features)) return null;
    const coords: [number, number][] = [];
    for (const f of fc.features) {
      const c = f.geometry?.coordinates;
      if (Array.isArray(c) && c.length === 2) coords.push([c[0], c[1]]);
    }
    return coords.length > 1 ? coords : null;
  } catch {
    return undefined;
  }
}

/**
 * Trip-Detail-Response: kompakte SearchResult-ähnliche Form mit genau einem
 * Leg (das gesamte Trip). Wir tun bewusst NICHT so als wäre das ein
 * Such-Result mit Booking-Token — der Client erkennt anhand des dedizierten
 * Endpoints, dass kein Booking möglich ist und macht stattdessen direkt das
 * Timeline-Overlay auf. */
interface TripDetailLeg {
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  originLat?: number;
  originLng?: number;
  destLat?: number;
  destLng?: number;
  departTime: string;
  arriveTime: string;
  durationMinutes: number;
  departPlatform?: string;
  arrivePlatform?: string;
  line?: string;
  product?: string;
  fahrtNr?: string;
  direction?: string;
  stops?: number;
  stopovers?: TripStopover[];
  tripId?: string;
  /** Ortszeit-Zone von Ab- und Ankunft (IANA oder „+01:00") — siehe `stopTz`. */
  originTz?: string;
  destTz?: string;
}

interface TripStopover {
  name?: string;
  arrival?: string;
  departure?: string;
  platform?: string;
}

interface TripDetailResponse {
  id: string;
  mode: "TRAIN" | "BUS";
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departTime: string;
  arriveTime: string;
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  line?: string;
  product?: string;
  fahrtNr?: string;
  direction?: string;
  legs: TripDetailLeg[];
  originTz?: string;
  destinationTz?: string;
}

function toIso(v: string | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Bus-Produkte aus HAFAS landen alle als BUS-Mode beim Client. Alles andere
 *  (national/regional/suburban/subway/tram/ferry/flight) wird als TRAIN
 *  behandelt, da unsere Modes nur 4 sind und der DetailsOverlay-Skip eh nur
 *  für Bus wichtig ist. */
function productToMode(product: string | undefined): "TRAIN" | "BUS" {
  if (!product) return "TRAIN";
  const p = product.toLowerCase();
  if (/bus|coach/.test(p)) return "BUS";
  return "TRAIN";
}

/** Holt das rohe Trip-Body-Objekt für die gegebene Profile + tripId. Pro
 *  Profile gibt's einen anderen Backend-Pfad:
 *    - DE → HTTP-Fetch gegen den dbrest-Container
 *    - AT/PL/LU/DK → in-process hafas-client lookup
 *  Beide Pfade liefern strukturell identische Trip-Objekte (gleiche
 *  hafas-client Vorlage), daher kann der nachfolgende Parser sie gleich
 *  behandeln.
 *
 *  AT-Verbund-Profile (vor/vvt/svv/etc.) haben oft Probleme mit der `trip()`-
 *  Methode (PARAMETER-Fehler bei stv, fehlende Implementierung bei manchen).
 *  Falls's da fehlschlägt, fallen wir auf oebb zurück — die hat National-
 *  Trip-Daten und kennt die Trip-IDs aller österreichischen Züge. */
/** Ein Halt aus einem MOTIS-/v6/trip-Leg. */
interface MotisTripStop {
  name?: string;
  stopId?: string;
  lat?: number;
  lon?: number;
  arrival?: string;
  scheduledArrival?: string;
  departure?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
}
interface MotisTripLeg {
  mode?: string;
  tripShortName?: string;
  routeShortName?: string;
  headsign?: string;
  from?: MotisTripStop;
  to?: MotisTripStop;
  intermediateStops?: MotisTripStop[];
}

function motisStopToStopover(s: MotisTripStop): DbTripStopover {
  return {
    stop: { id: s.stopId, name: s.name, location: { latitude: s.lat, longitude: s.lon } },
    // Planzeit zuerst (konsistent mit Suche/Board), Ist nur als Fallback.
    arrival: s.scheduledArrival ?? s.arrival,
    plannedArrival: s.scheduledArrival,
    departure: s.scheduledDeparture ?? s.departure,
    plannedDeparture: s.scheduledDeparture,
    arrivalPlatform: cleanPlatform(s.scheduledTrack ?? s.track),
    departurePlatform: cleanPlatform(s.scheduledTrack ?? s.track),
  };
}

/**
 * MOTIS-Trip (`/v6/trip`) → dieselbe Trip-Body-Struktur wie dbrest, damit die
 * bestehende Slice-/Match-Logik in fetchTripDetail unverändert läuft. Nötig,
 * weil die Abfahrtstafeln (Surroundings) MOTIS-tripIds liefern und dbrest
 * (db-Profil) geblockt ist.
 */
async function motisTripToBody(tripId: string): Promise<DbTripBody | null> {
  let raw: { legs?: MotisTripLeg[] };
  try {
    raw = (await motisFetch(`/v6/trip?tripId=${encodeURIComponent(tripId)}`)) as {
      legs?: MotisTripLeg[];
    };
  } catch {
    return null;
  }
  const leg = (raw.legs ?? []).find((l) => l.mode && l.mode !== "WALK");
  if (!leg?.from || !leg.to) return null;
  const stopovers: DbTripStopover[] = [
    motisStopToStopover(leg.from),
    ...(leg.intermediateStops ?? []).map(motisStopToStopover),
    motisStopToStopover(leg.to),
  ];
  const longDist =
    leg.mode === "HIGHSPEED_RAIL" || leg.mode === "LONG_DISTANCE" || leg.mode === "NIGHT_RAIL";
  const lineName =
    (longDist ? leg.tripShortName || leg.routeShortName : leg.routeShortName || leg.tripShortName) ||
    undefined;
  return {
    id: tripId,
    origin: {
      id: leg.from.stopId,
      name: leg.from.name,
      location: { latitude: leg.from.lat, longitude: leg.from.lon },
    },
    destination: {
      id: leg.to.stopId,
      name: leg.to.name,
      location: { latitude: leg.to.lat, longitude: leg.to.lon },
    },
    departure: leg.from.scheduledDeparture ?? leg.from.departure,
    plannedDeparture: leg.from.scheduledDeparture,
    arrival: leg.to.scheduledArrival ?? leg.to.arrival,
    plannedArrival: leg.to.scheduledArrival,
    line: { name: lineName, product: leg.mode, fahrtNr: leg.tripShortName },
    direction: leg.headsign,
    stopovers,
  };
}

async function fetchTripBody(
  profile: HafasProfileKey,
  tripId: string,
): Promise<DbTripBody | null> {
  // MOTIS-tripIds (Format YYYYMMDD_HH:MM_<feed>_<num>) → MOTIS statt dbrest.
  if (/^\d{8}_\d{2}:\d{2}_/.test(tripId)) {
    return motisTripToBody(tripId);
  }
  if (profile === "db") {
    // Nur HAFAS-Kennungen („1|…", „2|#VN#…") kennt die Bahn. Kennungen der
    // Länder-Fahrpläne („16_17447_260829") kosteten sonst einen Platz im
    // Kontingent und scheiterten immer.
    if (!tripId.includes("|")) return null;
    // `language=de` — sonst 403 OPS_BLOCKED, siehe `fetchTripPolyline`.
    // Ein Platz aus dem Bahn-Kontingent (Stufe `detail`): Jemand wartet auf die
    // Zeitleiste, also kurz warten — aber nie der Suche den Platz nehmen.
    const lane = await acquireDb("detail", 3_000);
    if (!lane) return null;
    const url = `${lane.dbrestUrl}/trips/${encodeURIComponent(tripId)}?stopovers=true&polyline=false&remarks=false&language=de`;
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      await reportIfBlocked(lane, res);
      if (!res.ok) return null;
      const data = (await res.json()) as DbTripResponse;
      // db-vendo wickelt manchmal in `.trip`, manchmal nicht — beide Shapes
      // tolerieren wir genauso wie beim Polyline-Endpoint.
      return data.trip ?? (data as unknown as DbTripBody | undefined) ?? null;
    } catch {
      return null;
    }
  }
  const trip = await multiFetchTrip(profile, tripId);
  if (trip) return trip as unknown as DbTripBody;
  // Fallback für AT-Verbund-Profile auf oebb. multiFetchTrip hat schon den
  // Error geloggt — hier nur noch versuchen ob oebb's Trip-Endpoint klappt.
  if (profile !== "oebb" && profile !== "pkp" && profile !== "cfl" && profile !== "rejseplanen") {
    const fallback = await multiFetchTrip("oebb", tripId);
    if (fallback) return fallback as unknown as DbTripBody;
  }
  return null;
}

async function fetchTripDetail(
  tripId: string,
  slice: TripSlice,
  profile: HafasProfileKey,
): Promise<TripDetailResponse | null> {
  const trip = await fetchTripBody(profile, tripId);
  if (!trip) return null;
  // Nur der dbrest-Weg (db-vendo) hängt an jeden Halt den Offset des
  // STARTORTS — siehe util/dbTime.ts. MOTIS liefert UTC, die übrigen
  // HAFAS-Profile stimmige Offsets.
  const localClock = profile === "db" && !/^\d{8}_\d{2}:\d{2}_/.test(tripId);
  return buildTripDetail(trip, tripId, slice, localClock);
}

/**
 * Die Fahrt eines Länder-Fahrplans (GTFS: NL/BE/CZ/UK …) in derselben Form wie
 * ein dbrest-Fahrtverlauf — damit Schnitt, Namen und Zeiten unten dieselbe
 * Logik durchlaufen. null, wenn der Feed die Kennung nicht kennt.
 */
async function gtfsTripToBody(
  country: string,
  tripId: string,
  stopCode: string | undefined,
  near: { latitude: number; longitude: number } | null,
  atTime: string | undefined,
): Promise<DbTripBody | null> {
  const trip = await getScheduledTrip({ country, tripId, stopCode, near, atTime });
  if (!trip) return null;
  /**
   * Zeiten mit dem Offset des Feeds statt „Z" — derselbe Zeitpunkt.
   *
   * `stopTz` nimmt die Zone eines Halts aus seiner Lage, sonst aus dem Offset
   * des Zeitstempels. Halte ohne Lage (0/0 → null, im niederländischen Feed
   * 126 ausländische wie Berlin Südkreuz oder Dortmund Hbf, oft Endhalt eines
   * Fernzugs) bekamen mit „Z" die Zone UTC: Ankunft eine bis zwei Stunden zu
   * früh angezeigt. Die Ortszeit des Feeds stimmt für sie fast immer.
   */
  const local = (iso: string) => formatInTimeZone(new Date(iso), trip.tz, "yyyy-MM-dd'T'HH:mm:ssxxx");
  const stopovers: DbTripStopover[] = trip.stops.map((s) => ({
    stop: {
      id: s.stopId,
      // Derselbe Name wie im Kopf des Halt-Blatts — in Großbritannien ohne
      // Netz-Zusatz, Postbezirk, Richtung oder Steignummer (siehe
      // util/stopDisplayName.ts). Andere Länder: der Fahrplan-Name, wie er ist.
      name: s.name ? timetableStopName(country, s.name) : undefined,
      location: { latitude: s.latitude ?? undefined, longitude: s.longitude ?? undefined },
    },
    arrival: local(s.arrival),
    plannedArrival: local(s.arrival),
    departure: local(s.departure),
    plannedDeparture: local(s.departure),
  }));
  const first = stopovers[0]!;
  const last = stopovers[stopovers.length - 1]!;
  return {
    id: tripId,
    origin: first.stop,
    destination: last.stop,
    departure: first.departure,
    plannedDeparture: first.plannedDeparture,
    arrival: last.arrival,
    plannedArrival: last.plannedArrival,
    line: { name: trip.line ?? undefined, product: trip.product },
    direction: trip.headsign ?? undefined,
    stopovers,
  };
}

/**
 * Die Ortszeit-Zone eines Halts: aus seiner Lage (tz-lookup), sonst aus dem
 * Offset des Zeitstempels, sonst Berlin.
 *
 * Hier stand für JEDE Fahrt fest „Europe/Berlin". Die Zeitleiste rechnet damit
 * um — eine Abfahrt in London um 14:05 stand dort als 15:05, in Lissabon zwei
 * Stunden daneben genauso. Die Tafel davor (richtig) und die Zeitleiste
 * dahinter (falsch) widersprachen sich um genau den Zonenabstand.
 */
function stopTz(stop: DbTripStopover | undefined, raw: string | undefined): string {
  return dbStopTz(stop?.stop) ?? isoOffset(raw) ?? "Europe/Berlin";
}

/** Woran das Detail die Fahrt zuschneidet — alles aus der getippten Tafel-Zeile. */
interface TripSlice {
  /** Kennung des Halts, an dem der Nutzer steht (aus der Tafel). */
  fromStopId?: string;
  /** Name dieses Halts — Rückfall, wenn weder Kennung noch Lage greifen. */
  fromStopLabel?: string;
  /** Lage dieses Halts aus unserer DB. */
  fromStopLat?: number;
  fromStopLng?: number;
  /** Die Richtung der Zeile („Werl, Bf."). Auf der Ankunftstafel die HERKUNFT. */
  boardDirection?: string;
  /** Zeile der Ankunftstafel: gezeigt wird die Fahrt BIS zum Halt, nicht ab ihm. */
  arrivals?: boolean;
  /** Planzeit der Zeile (ISO) — welches Vorkommen des Halts gemeint ist. */
  atTime?: string;
}

/** Luftlinie in Metern zwischen zwei Halten — null, wenn einer keine Lage hat. */
function stopDistanceMeters(a: DbTripStopover | undefined, b: DbTripStopover | undefined): number | null {
  const p = a?.stop?.location;
  const q = b?.stop?.location;
  if (p?.latitude == null || p.longitude == null || q?.latitude == null || q.longitude == null) return null;
  const rad = Math.PI / 180;
  const dLat = (q.latitude - p.latitude) * rad;
  const dLon = (q.longitude - p.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(p.latitude * rad) * Math.cos(q.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Fährt die Fahrt nach Halt `idx` zurück zum Startpunkt — eine Ringlinie
 * (oder ein Hin-und-zurück) also, deren Kopfschild den Wendepunkt nennt?
 * Der letzte Halt muss dem ersten weniger als halb so fern sein wie `idx`.
 * Ein kleiner Haken am Ende reicht nicht: Ein Schulbus nach „Cromer" wendet
 * in Sheringham an der „Cromer Road" und hält danach noch dreimal, 600 m
 * zurück — der Ring-Fall ist das nicht. Ohne Lagen: nein, die Fahrt bleibt ganz.
 */
function turnsBackAfter(stops: DbTripStopover[], idx: number): boolean {
  const first = stops[0];
  const toTurn = stopDistanceMeters(first, stops[idx]);
  const toLast = stopDistanceMeters(first, stops[stops.length - 1]);
  return toTurn != null && toLast != null && toLast * 2 < toTurn;
}

function buildTripDetail(
  trip: DbTripBody,
  tripId: string,
  slice: TripSlice,
  localClock: boolean,
): TripDetailResponse | null {
  const { fromStopId, fromStopLabel, fromStopLat, fromStopLng, boardDirection, arrivals, atTime } = slice;
  /** Zeitstempel eines Halts → ISO-UTC (bei dbrest in der Zone DES Halts). */
  const timeOf = (v: string | undefined, s: DbTripStopover | undefined): string | null =>
    localClock ? dbTimeToUtc(v, dbStopTz(s?.stop)) : toIso(v);

  // Raw stopovers aus HAFAS — beinhaltet IMMER origin + alle Zwischenhalte +
  // destination (alle Stops chronologisch). Daraus bauen wir die User-zentrierte
  // Slice unten.
  const rawStops = trip.stopovers ?? [];

  // Slice die Stop-Liste auf den User-Halt (Beispiel: Bus 245 fährt 17:56→18:34,
  // User steigt um 18:08 ein → wir wollen 18:08→18:34 anzeigen, nicht die volle
  // Linie inklusive der Stops vor dem User). Der Halt des Nutzers, in dieser
  // Reihenfolge:
  //   1. Exakte Stop-ID, dann ID-Prefix (parent_station vs. platform_id)
  //   2. Lage: nächster Halt der Fahrt, höchstens 500 m entfernt
  //   3. Name (util/tripStopMatch.ts) — nur wenn er EINDEUTIG ist
  // Wird er nicht gefunden: die ganze Fahrt, nie ein geratener Halt.

  // Haversine in Metern — für den Coord-Match unten. Ein bisschen
  // overkill für kurze Distanzen (man könnte auch dx²+dy² in Lat/Lon nehmen)
  // aber die korrekte Form ist hier schnell genug (200 stops × 1 Trig-Calc).
  const haversineMeters = (la1: number, lo1: number, la2: number, lo2: number): number => {
    const R = 6_371_000;
    const dLat = ((la2 - la1) * Math.PI) / 180;
    const dLon = ((lo2 - lo1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const names = rawStops.map((s) => s.stop?.name);

  // Abfahren kann man nie am Endhalt, ankommen nie am ersten Halt. Eine
  // Ringlinie hat am Start-/Endhalt zwei Einträge (oft zwei Steige gleich
  // nebeneinander); lag der letzte näher, war er der „Einstieg", und das
  // Detail zeigte eine Fahrt aus einem einzigen Halt.
  const possible = (i: number) => (arrivals ? i > 0 : i < rawStops.length - 1);
  // Derselbe Halt kann in einer Fahrt ZWEIMAL vorkommen: Die 621 in Werl fährt
  // ab Schulzentrum, ist 11:30 am Bahnhof, dreht ihre Runde und ist 12:06
  // wieder am Bahnhof. Welches Vorkommen die getippte Zeile meint, sagt ihre
  // Uhrzeit — ohne sie zeigte die Ankunft um 12:06 die Fahrt bis 11:30.
  const atMs = atTime ? Date.parse(atTime) : NaN;
  const eventMs = (i: number): number => {
    const s = rawStops[i]!;
    const dep = timeOf(s.plannedDeparture ?? s.departure, s);
    const arr = timeOf(s.plannedArrival ?? s.arrival, s);
    const iso = arrivals ? (arr ?? dep) : (dep ?? arr);
    return iso ? Date.parse(iso) : NaN;
  };
  const pick = (candidates: number[]): number => {
    const ok = candidates.filter(possible);
    if (ok.length <= 1 || !Number.isFinite(atMs)) return ok[0] ?? -1;
    let best = ok[0]!;
    let bestGap = Infinity;
    for (const i of ok) {
      const t = eventMs(i);
      const gap = Number.isFinite(t) ? Math.abs(t - atMs) : Infinity;
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  };
  const indicesWhere = (test: (s: DbTripStopover, i: number) => boolean): number[] =>
    rawStops.flatMap((s, i) => (test(s, i) ? [i] : []));

  let userIdx = -1;
  if (fromStopId) {
    userIdx = pick(indicesWhere((s) => s.stop?.id === fromStopId));
    // Prefix-Match: trip-stops könnten Platform-IDs sein (parentId + Suffix)
    if (userIdx < 0) {
      userIdx = pick(indicesWhere((s) => !!s.stop?.id && (s.stop.id.startsWith(fromStopId + ":")
        || fromStopId.startsWith(s.stop.id + ":"))));
    }
  }
  // Coord-Match (PRIMARY-SIGNAL wenn beide Coords vorhanden): finde den
  // Trip-Stop der am nächsten zu unseren DB-Coords liegt. Coords sind
  // zuverlässig weil Bus-/Bahn-Stops geographisch eindeutig sind. Schwelle
  // 500 m: HAFAS-Trip-Bodies enthalten oft nicht JEDEN physischen Stop sondern
  // nur die wichtigsten (z.B. M21 listet „Jungfernheide Bahnhof" aber nicht
  // „Tegeler Weg" 360m daneben — der User steht aber an Tegeler Weg). 500m
  // fängt diesen Fall und ist eng genug um nicht zwischen 2 echten Stops zu
  // verwechseln (urban inter-stop-distance liegt typisch 200-500m). Als
  // „derselbe Halt" zählt alles bis 30 m über dem nächsten (Steige).
  if (userIdx < 0 && fromStopLat != null && fromStopLng != null) {
    const dist = rawStops.map((s) => {
      const loc = s.stop?.location;
      return loc?.latitude == null || loc.longitude == null
        ? Infinity
        : haversineMeters(fromStopLat, fromStopLng, loc.latitude, loc.longitude);
    });
    let bestDist = Infinity;
    dist.forEach((d, i) => {
      if (possible(i) && d < bestDist) bestDist = d;
    });
    if (bestDist <= 500) {
      // Nach Abstand sortiert: Ohne Uhrzeit (oder bei gleicher) gewinnt der nächste.
      userIdx = pick(
        indicesWhere((_, i) => dist[i]! <= Math.min(500, bestDist + 30)).sort((a, b) => dist[a]! - dist[b]!),
      );
    }
  }
  // Name: „Munich Chiemgaustraße" (unser GTFS-Label) findet „München,
  // Chiemgaustraße" (HAFAS) — aber „Werl, Bahnhof" findet unter lauter
  // „Werl, …"-Halten nur den einen, der auch „Bahnhof" heißt, sonst keinen.
  if (userIdx < 0 && fromStopLabel) userIdx = pick(matchStopIndices(names, fromStopLabel));

  let startIdx = 0;
  let endIdx = rawStops.length - 1;
  if (arrivals) {
    // ANKUNFTSTAFEL: Die Zeile sagt „aus Unna, an 16:33" — ihre Richtung ist
    // die Herkunft. Gezeigt wird die Fahrt von dort BIS HIER. Vorher lief
    // auch diese Zeile durch den Abfahrts-Schnitt: ab hier bis zu dem Halt,
    // dessen Name dem HERKUNFTSORT ähnelte — eine Fahrt, die es so nicht gibt.
    if (userIdx > 0) endIdx = userIdx;
  } else {
    if (userIdx >= 0) startIdx = userIdx;
    // END-Slice auf die Board-Richtung — NUR für RINGLINIEN (Start=Ende, z.B.
    // C1 in Werl: Bahnhof→…→Justus-Liebig-Platz→…→Bahnhof). Dort ist der
    // letzte Halt (Werl Bahnhof) ein ANDERER Ort als wohin der User laut Board
    // fährt (Justus-Liebig-Platz), und das Detail endet am Richtungs-Halt.
    //
    // Sonst NIE: Das Kopfschild nennt das Ziel der Fahrt, und ein Halt
    // unterwegs, der ähnlich heißt, ist ein anderer Ort. Nachgestellt an 17 000
    // Fahrten der Länder-Fahrpläne: „Nottingham" endete an „Nottingham Road",
    // 24 Halte vor dem Ziel; „Reading Station" an „Reading West Station";
    // „Amersfoort CS" an „Amersfoort, Prins Frederiklaan" — in den
    // Niederlanden fast jede zweite Fahrt. Und „Werl, Bf." auf der 522, die gar
    // nicht am Bahnhof hält, endete eine Minute nach dem Einstieg am nächsten
    // „Werl, …"-Halt. Darum: Der Name muss genau einen Halt meinen (siehe
    // util/tripStopMatch.ts), UND die Fahrt muss danach zurück Richtung
    // Startpunkt fahren — sonst die ganze Fahrt bis zum echten Endhalt.
    // Nennt das Kopfschild den Endhalt SELBST (Ring „Palmovka" ab Palmovka
    // zurück nach Palmovka, mit einem zweiten Steig „Palmovka" gleich danach),
    // ist die ganze Runde gemeint — nicht der nächste gleichnamige Steig.
    if (boardDirection?.trim()) {
      const hits = matchStopIndices(names, boardDirection);
      const idx = hits.find((i) => i > startIdx) ?? -1;
      const namesTerminal = hits.includes(rawStops.length - 1);
      if (idx > startIdx && !namesTerminal && turnsBackAfter(rawStops, idx)) endIdx = idx;
    }
  }
  const slicedStops = rawStops.slice(startIdx, endIdx + 1);
  if (slicedStops.length === 0) return null;

  const firstStop = slicedStops[0]!;
  const lastStop = slicedStops[slicedStops.length - 1]!;

  // departTime kommt vom ABFAHRTS-Wert des ersten Slice-Stops (das ist die Zeit
  // wann der Bus den User-Halt verlässt). arriveTime vom ANKUNFTS-Wert des
  // letzten Stops (Endstation). Falls die Felder fehlen (z.B. Endstation hat
  // kein departure), fallen wir auf den jeweils anderen Wert zurück.
  const departTime =
    timeOf(firstStop.plannedDeparture ?? firstStop.departure, firstStop) ??
    timeOf(firstStop.plannedArrival ?? firstStop.arrival, firstStop);
  const arriveTime =
    timeOf(lastStop.plannedArrival ?? lastStop.arrival, lastStop) ??
    timeOf(lastStop.plannedDeparture ?? lastStop.departure, lastStop);
  if (!departTime || !arriveTime) return null;
  const originTz = stopTz(firstStop, firstStop.plannedDeparture ?? firstStop.departure);
  const destinationTz = stopTz(lastStop, lastStop.plannedArrival ?? lastStop.arrival);

  const durationMinutes = Math.max(
    1,
    Math.round((Date.parse(arriveTime) - Date.parse(departTime)) / 60_000),
  );

  // ZWISCHENHALTE — explizit OHNE User-Stop (= erster Eintrag der sliced
  // Liste) und OHNE Endstation (= letzter Eintrag). Convention im Frontend:
  // `leg.stopovers` enthält nur die Halte ZWISCHEN origin und destination, weil
  // die beiden Endpunkte schon im Timeline-Header gerendert werden. Sonst
  // würde der Stops-Counter „3" sagen aber die Dropdown 5 Einträge zeigen.
  const middleRaw = slicedStops.slice(1, -1);
  const stopovers: TripStopover[] = middleRaw
    .map((s) => ({
      name: s.stop?.name,
      arrival: timeOf(s.plannedArrival ?? s.arrival, s) ?? undefined,
      departure: timeOf(s.plannedDeparture ?? s.departure, s) ?? undefined,
      platform:
        s.plannedArrivalPlatform ??
        s.arrivalPlatform ??
        s.plannedDeparturePlatform ??
        s.departurePlatform,
    }))
    .filter((s) => s.name);

  const mode = productToMode(trip.line?.product);
  const product = trip.line?.product;
  const lineName = trip.line?.name;
  const fahrtNr = trip.line?.fahrtNr;
  const direction = trip.direction;

  const originId = firstStop.stop?.id ?? trip.origin?.id ?? "";
  const destinationId = lastStop.stop?.id ?? trip.destination?.id ?? "";
  const originName = firstStop.stop?.name ?? trip.origin?.name ?? "";
  // destinationName: der Name des Halts, an dem das Detail endet — derselbe,
  // dessen Koordinaten den Marker setzen. Die Richtung der Tafel („Werl, Bf.")
  // stand hier, sobald der End-Schnitt einen Halt „gefunden" hatte; war es der
  // falsche, trug ein Halt eine Minute nach dem Einstieg den Namen des
  // Bahnhofs. Die Richtung selbst zeigt die Zeitleiste ohnehin („Richtung …",
  // `leg.direction`), der Halt heißt jetzt so, wie er heißt.
  const destinationName =
    lastStop.stop?.name ??
    trip.direction?.trim() ??
    trip.destination?.name ??
    (arrivals ? undefined : boardDirection?.trim()) ??
    "";
  const originLat = firstStop.stop?.location?.latitude ?? trip.origin?.location?.latitude;
  const originLng = firstStop.stop?.location?.longitude ?? trip.origin?.location?.longitude;
  const destLat = lastStop.stop?.location?.latitude ?? trip.destination?.location?.latitude;
  const destLng = lastStop.stop?.location?.longitude ?? trip.destination?.location?.longitude;
  const departPlatform =
    firstStop.plannedDeparturePlatform ?? firstStop.departurePlatform ??
    trip.plannedDeparturePlatform ?? trip.departurePlatform;
  const arrivePlatform =
    lastStop.plannedArrivalPlatform ?? lastStop.arrivalPlatform ??
    trip.plannedArrivalPlatform ?? trip.arrivalPlatform;

  const leg: TripDetailLeg = {
    origin: originId,
    destination: destinationId,
    originLabel: originName,
    destLabel: destinationName,
    originLat,
    originLng,
    destLat,
    destLng,
    departTime,
    arriveTime,
    durationMinutes,
    departPlatform,
    arrivePlatform,
    line: lineName,
    product,
    fahrtNr,
    direction,
    stops: Math.max(0, stopovers.length),
    stopovers: stopovers.length > 0 ? stopovers : undefined,
    tripId,
    originTz,
    destTz: destinationTz,
  };

  return {
    id: `trip:${tripId}`,
    mode,
    origin: originId,
    destination: destinationId,
    originLabel: originName,
    destLabel: destinationName,
    departTime,
    arriveTime,
    durationMinutes,
    // Auf Ebene der VERBINDUNG zählt `stops` die Umstiege (so liefern es alle
    // Suchanbieter, und so beschriftet die App das Feld). Eine einzelne Fahrt
    // hat keine — die Zwischenhalte stehen am Leg. Vorher stand hier deren
    // Zahl, und der Kopf der Zeitleiste zeigte „29 Stopps · Umstieg".
    stops: 0,
    stopLabels: [],
    line: lineName,
    product,
    fahrtNr,
    direction,
    legs: [leg],
    originTz,
    destinationTz,
  };
}

const tripDetailQuerySchema = z.object({
  // HAFAS-Trip-IDs enthalten `#`, `|` und Leerzeichen-Padding (z.B.
  // `2|#VN#1#ST#1779382091#…#ZB#Bus           255#…`). Path-Parameter sind
  // damit unzuverlässig — Fastify's Path-Matcher matched die URL nicht, weil
  // die enkodierten Sonderzeichen den Routen-Trie verwirren. Query-Parameter
  // werden hingegen sauber als RFC-3986-konformer Wert dekodiert.
  tripId: z.string().min(1),
  /** Optional: HAFAS-Stop-ID des User-Halts. Wenn gesetzt, slicen wir die
   *  Trip-Stop-Liste ab diesem Stop (zeigt nur ab-User-Halt bis Endstation
   *  statt ganzer Linie). */
  fromStopId: z.string().optional(),
  /** Optional: Label des User-Halts (Name). Wird zusätzlich zur ID als
   *  Fallback genutzt — manche Stops haben keine konsistente hafas_id
   *  zwischen unseren Quellen, dann muss per Name gematched werden. */
  fromStopLabel: z.string().optional(),
  /** Optional: Stop-Code unseres internen `locations.code`-Schemas (z.B.
   *  `gtfs:at:…` oder `sta:8011160`). Daraus leiten wir das HAFAS-Profile ab.
   *  Wenn fehlend, fallen wir auf "db" (Deutschland) zurück. */
  stopCode: z.string().optional(),
  /** Optional: Direction-Label aus dem Board (wie es auf der getappten
   *  Card stand, z.B. „Charlottenburg, Goerdelersteg"). Wird als destLabel
   *  bevorzugt — sonst stimmt das Trip-Detail nicht mit dem überein was
   *  der User vor dem Tap gesehen hat. HAFAS' `trip.direction` ist manchmal
   *  ein anderer Headsign-Wert als der Board-Eintrag (z.B. M21 zeigt im
   *  Board „Goerdelersteg" aber im Trip-Body steht „S+U Jungfernheide"). */
  direction: z.string().optional(),
  /** Optional: von welcher Tafel die Zeile stammt. Bei `arrivals` ist
   *  `direction` die HERKUNFT, und das Detail zeigt die Fahrt bis zum Halt. */
  board: z.enum(["departures", "arrivals"]).optional(),
  /** Optional: Zeit der getippten Zeile (ISO) — legt bei Fahrten aus den
   *  Länder-Fahrplänen den Betriebstag fest. Ohne: der nächstliegende. */
  atTime: z.string().max(40).optional(),
});

// ---------------------------------------------------------------------------
// Live-Ansicht
// ---------------------------------------------------------------------------
/**
 * EINE Antwort je Fahrt: jeder Halt mit Lage und Zeiten (Plan und erwartet)
 * und die Linienführung samt der Stelle jedes Halts darauf. Wo das Fahrzeug
 * gerade ist, rechnet die App selbst aus (lib/live/) — Bild für Bild, ohne
 * weitere Anfrage. Echte Positionsdaten (GPS) haben wir nicht; die Ansicht sagt
 * das auch so.
 */

/** Wie das Fahrzeug aussieht — die App baut daraus Wagenkette, Tram oder Bus. */
type LiveVehicle = "train" | "subway" | "tram" | "bus" | "ferry";

interface LiveTripStop {
  name: string;
  lat: number;
  lon: number;
  /** Ankunft/Abfahrt laut Plan (…P) und wie erwartet (…E, mit Verspätung, falls bekannt), ISO-UTC. */
  arrP: string | null;
  arrE: string | null;
  depP: string | null;
  depE: string | null;
  /** Stelle auf der Linie, Meter ab ihrem Anfang. */
  d: number;
}

interface LiveTripResponse {
  tripId: string;
  vehicle: LiveVehicle;
  product: string | null;
  line: string | null;
  direction: string | null;
  /** Kommen die erwarteten Zeiten aus Echtzeitdaten? Sonst sind sie der Plan. */
  realtime: boolean;
  /** Echte Linienführung — oder gerade Stücke von Halt zu Halt (Länder-Fahrpläne). */
  shape: "geometry" | "straight";
  coords: LngLat[];
  /** Länge bis zu jedem Punkt der Linie, Meter. */
  cum: number[];
  stops: LiveTripStop[];
  /**
   * Der Halt der Tafel, von der aus geöffnet wurde — Index in `stops`, oder
   * null, wenn er sich nicht sicher finden lässt. Die App nennt damit, wann das
   * Fahrzeug „bei dir" ist.
   */
  boardIndex: number | null;
  fetchedAt: string;
}

type RawLiveStop = Omit<LiveTripStop, "d">;

/** So weit darf der Halt der Tafel von seinem Gegenstück in der Fahrt liegen. */
const BOARD_STOP_RADIUS_M = 400;

/**
 * Der Halt der Tafel in der Fahrt — über die LAGE, nicht den Namen: Namen
 * weichen zwischen Tafel und Fahrt ab („Werl" / „Werl, Bahnhof"), und ein
 * blinder Namensabgleich hat schon falsche Orte geliefert. In Frage kommt
 * jeder Halt bis 400 m um den der Tafel; berührt eine Ringlinie ihn zweimal,
 * entscheidet die Zeit der Tafel-Zeile (Sekunden Abweichung + Meter).
 */
function boardStopIndex(
  stops: LiveTripStop[],
  lat: number | undefined,
  lng: number | undefined,
  atTime: string | undefined,
): number | null {
  if (lat == null || lng == null) return null;
  const at = atTime ? Date.parse(atTime) : NaN;
  const here = { stop: { location: { latitude: lat, longitude: lng } } } as DbTripStopover;
  let best: number | null = null;
  let bestScore = Infinity;
  stops.forEach((s, i) => {
    const dist = stopDistanceMeters(here, { stop: { location: { latitude: s.lat, longitude: s.lon } } } as DbTripStopover);
    if (dist == null || dist > BOARD_STOP_RADIUS_M) return;
    let dt = 0;
    if (Number.isFinite(at)) {
      const times = [s.depP, s.arrP].map((t) => (t ? Date.parse(t) : NaN)).filter(Number.isFinite);
      dt = times.length ? Math.min(...times.map((t) => Math.abs(t - at))) / 1000 : 0;
    }
    const score = dt + dist;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

function liveVehicle(product: string | null | undefined): LiveVehicle {
  const p = (product ?? "").toLowerCase();
  if (/bus|coach/.test(p)) return "bus";
  if (/tram|cable|funicular|aerial|light/.test(p)) return "tram";
  if (/subway|metro|underground/.test(p)) return "subway";
  if (/ferry|ship|boat/.test(p)) return "ferry";
  return "train";
}

/**
 * MOTIS mit EINER Anfrage: Halte (`arrival` ist dort schon die erwartete
 * Zeit, `scheduledArrival` der Plan) und die Linienführung derselben Fahrt.
 */
async function motisLiveRaw(tripId: string): Promise<{
  stops: RawLiveStop[];
  geometry: LngLat[] | null;
  product: string | null;
  line: string | null;
  direction: string | null;
  realtime: boolean;
} | null> {
  type Leg = MotisTripLeg & { legGeometry?: { points?: string; precision?: number }; realTime?: boolean };
  let raw: { legs?: Leg[] };
  try {
    raw = (await motisFetch(`/v6/trip?tripId=${encodeURIComponent(tripId)}`)) as { legs?: Leg[] };
  } catch {
    return null;
  }
  const leg = (raw.legs ?? []).find((l) => l.mode && l.mode !== "WALK");
  if (!leg?.from || !leg.to) return null;
  const stops = [leg.from, ...(leg.intermediateStops ?? []), leg.to]
    .filter((s) => s.lat != null && s.lon != null)
    .map((s) => ({
      name: s.name ?? "",
      lat: s.lat!,
      lon: s.lon!,
      arrP: toIso(s.scheduledArrival ?? s.arrival),
      arrE: toIso(s.arrival ?? s.scheduledArrival),
      depP: toIso(s.scheduledDeparture ?? s.departure),
      depE: toIso(s.departure ?? s.scheduledDeparture),
    }));
  const g = leg.legGeometry;
  const longDist = leg.mode === "HIGHSPEED_RAIL" || leg.mode === "LONG_DISTANCE" || leg.mode === "NIGHT_RAIL";
  const line =
    (longDist ? leg.tripShortName || leg.routeShortName : leg.routeShortName || leg.tripShortName) || null;
  return {
    stops,
    geometry: g?.points ? decodePolyline(g.points, g.precision ?? 6) : null,
    product: leg.mode ?? null,
    line,
    direction: leg.headsign ?? null,
    realtime: leg.realTime === true,
  };
}

/** Halte aus einem dbrest-/HAFAS-/Länder-Fahrplan-Verlauf (Zeiten → ISO-UTC wie im Fahrt-Detail). */
function bodyLiveRaw(trip: DbTripBody, localClock: boolean): RawLiveStop[] {
  const timeOf = (v: string | undefined, s: DbTripStopover): string | null =>
    localClock ? dbTimeToUtc(v, dbStopTz(s.stop)) : toIso(v);
  return (trip.stopovers ?? [])
    .filter((s) => s.stop?.location?.latitude != null && s.stop.location.longitude != null)
    .map((s) => ({
      name: s.stop?.name ?? "",
      lat: s.stop!.location!.latitude!,
      lon: s.stop!.location!.longitude!,
      arrP: timeOf(s.plannedArrival ?? s.arrival, s),
      arrE: timeOf(s.arrival ?? s.plannedArrival, s),
      depP: timeOf(s.plannedDeparture ?? s.departure, s),
      depE: timeOf(s.departure ?? s.plannedDeparture, s),
    }));
}

function liveResponse(
  tripId: string,
  stops: RawLiveStop[],
  geometry: LngLat[] | null,
  meta: { product: string | null; line: string | null; direction: string | null; realtime: boolean },
): LiveTripResponse | null {
  if (stops.length < 2) return null;
  const shape = buildLiveShape(geometry, stops.map((s) => [s.lon, s.lat] as LngLat));
  return {
    tripId,
    vehicle: liveVehicle(meta.product),
    product: meta.product,
    line: meta.line,
    direction: meta.direction,
    realtime: meta.realtime || stops.some((s) => s.arrE !== s.arrP || s.depE !== s.depP),
    shape: shape.source,
    coords: shape.coords,
    cum: shape.cum,
    stops: stops.map((s, i) => ({ ...s, d: shape.stopD[i]! })),
    boardIndex: null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Kurz aufheben: Die App fragt einmal je Minute nach (Verspätungen), mehrere Nutzer dieselbe Fahrt. */
const liveCache = new BoundedTtlCache<LiveTripResponse>(400, 30_000);

const liveQuerySchema = z.object({
  tripId: z.string().min(1),
  /** Halt, von dem aus die Fahrt angetippt wurde — bestimmt Quelle und Land (wie beim Fahrt-Detail). */
  stopCode: z.string().optional(),
  /** Zeit der Tafel-Zeile — Betriebstag bei Länder-Fahrplänen. */
  atTime: z.string().max(40).optional(),
});

/**
 * Woher eine Fahrt kommt, hängt am Halt, von dem aus sie angetippt wurde:
 * Profil (DE → dbrest/MOTIS, AT/PL/LU/DK → hafas-client), Land (Länder-
 * Fahrplan?) und Lage (Abgleich im Fahrtverlauf). Ein Abruf über den
 * Primärschlüssel — billig.
 *
 * Bei AT-Halten braucht das Profil zusätzlich die Lage, um aufs richtige
 * Verbund-Profil zu kommen (vor/vvt/svv/…). Die Lage dient außerdem im
 * Fahrtverlauf als stärkstes Zeichen für den Halt des Nutzers: Namen weichen
 * zwischen den Quellen ab (Praxis-Bug: „Kolschitzkygasse" passte zu nichts im
 * HAFAS-Verlauf, und das Detail begann in „Wien Liesing Bahnhof").
 */
async function stopContext(stopCode: string | undefined): Promise<{
  profile: HafasProfileKey;
  stopLat: number | undefined;
  stopLng: number | undefined;
  stopCountry: string | null;
}> {
  if (!stopCode) return { profile: "db", stopLat: undefined, stopLng: undefined, stopCountry: null };
  const row = await db
    .select({ country: locations.country, latitude: locations.latitude, longitude: locations.longitude })
    .from(locations)
    .where(eq(locations.code, stopCode))
    .limit(1);
  const r = row[0];
  const stopLat = r?.latitude != null ? Number(r.latitude) : undefined;
  const stopLng = r?.longitude != null ? Number(r.longitude) : undefined;
  const profile =
    profileForStop({ code: stopCode, country: r?.country ?? null, latitude: stopLat ?? null, longitude: stopLng ?? null }) ||
    "db";
  return { profile, stopLat, stopLng, stopCountry: r?.country ?? null };
}

export async function tripsRoutes(app: FastifyInstance) {
  // Trips: bis zu 10 Polyline-/Detail-Calls pro Request (MOTIS/HAFAS) → DB-Quota.
  const preHandler = ipLimiter("trips", [{ limit: 40, windowMs: 60 * 1000 }], {
    ipCeilingFactor: EXPENSIVE_IP_CEILING_FACTOR,
  });
  /**
   * GET /api/trips/polyline?ids=id1,id2,id3
   * → { polylines: { [tripId]: [[lng, lat], ...] } }
   */
  app.get("/api/trips/polyline", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const ids = parsed.data.ids.slice(0, 10); // safety cap
    const results = await polylinesThrottled(ids);
    const polylines: Record<string, [number, number][]> = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const coords = results[i];
      if (id && coords) polylines[id] = coords;
    }
    return { polylines };
  });

  /**
   * GET /api/trips/detail?tripId=...
   * → kompakter Trip mit allen Stopovers (für StopDetailSheet-Tap-Flow).
   * Quelle: dbrest `/trips/{id}?stopovers=true`. Viel billiger als eine
   * `/journeys?from=X&to=Y`-Suche, weil HAFAS hier kein Routing macht sondern
   * einen schon-bekannten Trip ausliefert.
   */
  app.get("/api/trips/detail", { preHandler }, async (req, reply) => {
    const parsed = tripDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const { profile, stopLat, stopLng, stopCountry } = await stopContext(parsed.data.stopCode);
    /**
     * Fahrten aus den Länder-Fahrplänen (GTFS) ZUERST — ihre Kennungen kennt
     * weder MOTIS noch HAFAS. Nur wenn das Land einen Feed hat und die Kennung
     * nicht nach MOTIS („YYYYMMDD_HH:MM_…") oder HAFAS („…|…") aussieht; findet
     * der Feed sie nicht, geht es unverändert weiter.
     */
    const tripId = parsed.data.tripId;
    const slice: TripSlice = {
      fromStopId: parsed.data.fromStopId,
      fromStopLabel: parsed.data.fromStopLabel,
      fromStopLat: stopLat,
      fromStopLng: stopLng,
      boardDirection: parsed.data.direction,
      arrivals: parsed.data.board === "arrivals",
      atTime: parsed.data.atTime,
    };
    const looksForeign = /^\d{8}_\d{2}:\d{2}_/.test(tripId) || tripId.includes("|");
    let detail: TripDetailResponse | null = null;
    if (stopCountry && FEED_ID_BY_COUNTRY[stopCountry] && !looksForeign) {
      const body = await gtfsTripToBody(
        stopCountry,
        tripId,
        parsed.data.stopCode,
        stopLat != null && stopLng != null ? { latitude: stopLat, longitude: stopLng } : null,
        parsed.data.atTime,
      );
      if (body) detail = buildTripDetail(body, tripId, slice, false);
    }
    detail ??= await fetchTripDetail(tripId, slice, profile);
    if (!detail) {
      return reply.code(404).send({ error: "Trip not found" });
    }
    return detail;
  });

  /**
   * GET /api/live/trip?tripId=...&stopCode=...&atTime=...
   * → Halte mit Lage und Zeiten + Linienführung (siehe `LiveTripResponse`).
   * Quellen wie beim Fahrt-Detail: Länder-Fahrplan, MOTIS, HAFAS. Den
   * Verlauf einer DB-Fahrt (dbweb) gibt es nur über das Hintergrund-Kontingent;
   * fehlt er, zeichnet die App gerade Stücke.
   */
  app.get("/api/live/trip", { preHandler }, async (req, reply) => {
    const parsed = liveQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const { tripId, stopCode, atTime } = parsed.data;
    const key = `${tripId}|${stopCode ?? ""}|${(atTime ?? "").slice(0, 10)}`;
    const { profile, stopLat, stopLng, stopCountry } = await stopContext(stopCode);
    const hit = liveCache.get(key);
    if (hit) return { ...hit, boardIndex: boardStopIndex(hit.stops, stopLat, stopLng, atTime) };

    const looksMotis = /^\d{8}_\d{2}:\d{2}_/.test(tripId);
    const looksForeign = looksMotis || tripId.includes("|");
    let res: LiveTripResponse | null = null;
    if (stopCountry && FEED_ID_BY_COUNTRY[stopCountry] && !looksForeign) {
      const body = await gtfsTripToBody(
        stopCountry,
        tripId,
        stopCode,
        stopLat != null && stopLng != null ? { latitude: stopLat, longitude: stopLng } : null,
        atTime,
      );
      if (body) {
        res = liveResponse(tripId, bodyLiveRaw(body, false), null, {
          product: body.line?.product ?? null,
          line: body.line?.name ?? null,
          direction: body.direction ?? null,
          realtime: false,
        });
      }
    }
    if (!res && looksMotis) {
      const m = await motisLiveRaw(tripId);
      if (m) res = liveResponse(tripId, m.stops, m.geometry, m);
    }
    if (!res) {
      const body = await fetchTripBody(profile, tripId);
      if (body) {
        const localClock = profile === "db" && !looksMotis;
        const geometry = isDbwebTripId(tripId) ? ((await polylinesThrottled([tripId]))[0] ?? null) : null;
        res = liveResponse(tripId, bodyLiveRaw(body, localClock), geometry, {
          product: body.line?.product ?? null,
          line: body.line?.name ?? null,
          direction: body.direction ?? null,
          realtime: false,
        });
      }
    }
    if (!res) return reply.code(404).send({ error: "Trip not found" });
    liveCache.set(key, res);
    // Je Anfrage, nicht im Zwischenspeicher: Der Schlüssel kennt nur den Tag
    // der Tafel-Zeile, eine Ringlinie hat am selben Halt aber zwei Zeiten.
    return { ...res, boardIndex: boardStopIndex(res.stops, stopLat, stopLng, atTime) };
  });
}
