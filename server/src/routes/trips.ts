import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { profileForStop, type HafasProfileKey } from "../services/countryProfile.js";
import { fetchTrip as multiFetchTrip } from "../services/multiHafas.js";

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

async function fetchTripPolyline(tripId: string): Promise<[number, number][] | null> {
  const url = `${config.DBREST_BASE_URL}/trips/${encodeURIComponent(tripId)}?polyline=true&stopovers=false`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
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
    return null;
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
async function fetchTripBody(
  profile: HafasProfileKey,
  tripId: string,
): Promise<DbTripBody | null> {
  if (profile === "db") {
    const url = `${config.DBREST_BASE_URL}/trips/${encodeURIComponent(tripId)}?stopovers=true&polyline=false&remarks=false`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
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
  fromStopId: string | undefined,
  profile: HafasProfileKey,
): Promise<TripDetailResponse | null> {
  const trip = await fetchTripBody(profile, tripId);
  if (!trip) return null;

  // Raw stopovers aus HAFAS — beinhaltet IMMER origin + alle Zwischenhalte +
  // destination (alle Stops chronologisch). Daraus bauen wir die User-zentrierte
  // Slice unten.
  const rawStops = trip.stopovers ?? [];

  // Falls `fromStopId` angegeben ist: schneide die Stop-Liste ab dem User-Stop
  // ab. Beispiel: Bus 245 fährt 17:56→18:34, User steigt um 18:08 am Lüneburg-
  // str-Halt ein. Wir wollen 18:08→18:34 anzeigen, nicht die volle Linie.
  // Match per HAFAS-Stop-ID (zuverlässig). Wenn der Stop nicht gefunden wird,
  // fallen wir zurück auf den vollen Trip (besser irgendwas zeigen als nichts).
  let startIdx = 0;
  if (fromStopId) {
    const idx = rawStops.findIndex((s) => s.stop?.id === fromStopId);
    if (idx >= 0) startIdx = idx;
  }
  const slicedStops = rawStops.slice(startIdx);
  if (slicedStops.length === 0) return null;

  const firstStop = slicedStops[0]!;
  const lastStop = slicedStops[slicedStops.length - 1]!;

  // departTime kommt vom ABFAHRTS-Wert des ersten Slice-Stops (das ist die Zeit
  // wann der Bus den User-Halt verlässt). arriveTime vom ANKUNFTS-Wert des
  // letzten Stops (Endstation). Falls die Felder fehlen (z.B. Endstation hat
  // kein departure), fallen wir auf den jeweils anderen Wert zurück.
  const departTime =
    toIso(firstStop.plannedDeparture ?? firstStop.departure) ??
    toIso(firstStop.plannedArrival ?? firstStop.arrival);
  const arriveTime =
    toIso(lastStop.plannedArrival ?? lastStop.arrival) ??
    toIso(lastStop.plannedDeparture ?? lastStop.departure);
  if (!departTime || !arriveTime) return null;

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
      arrival: toIso(s.plannedArrival ?? s.arrival) ?? undefined,
      departure: toIso(s.plannedDeparture ?? s.departure) ?? undefined,
      platform:
        s.plannedArrivalPlatform ??
        s.arrivalPlatform ??
        s.plannedDeparturePlatform ??
        s.departurePlatform,
    }))
    .filter((s) => s.name);

  const stopLabels = stopovers.map((s) => s.name).filter((n): n is string => !!n);

  const mode = productToMode(trip.line?.product);
  const product = trip.line?.product;
  const lineName = trip.line?.name;
  const fahrtNr = trip.line?.fahrtNr;
  const direction = trip.direction;

  const originId = firstStop.stop?.id ?? trip.origin?.id ?? "";
  const destinationId = lastStop.stop?.id ?? trip.destination?.id ?? "";
  const originName = firstStop.stop?.name ?? trip.origin?.name ?? "";
  const destinationName = lastStop.stop?.name ?? trip.destination?.name ?? "";
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
    stops: stopovers.length,
    stopLabels,
    line: lineName,
    product,
    fahrtNr,
    direction,
    legs: [leg],
    originTz: "Europe/Berlin",
    destinationTz: "Europe/Berlin",
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
  /** Optional: Stop-Code unseres internen `locations.code`-Schemas (z.B.
   *  `gtfs:at:…` oder `sta:8011160`). Daraus leiten wir das HAFAS-Profile ab.
   *  Wenn fehlend, fallen wir auf "db" (Deutschland) zurück. */
  stopCode: z.string().optional(),
});

export async function tripsRoutes(app: FastifyInstance) {
  /**
   * GET /api/trips/polyline?ids=id1,id2,id3
   * → { polylines: { [tripId]: [[lng, lat], ...] } }
   */
  app.get("/api/trips/polyline", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const ids = parsed.data.ids.slice(0, 10); // safety cap
    const results = await Promise.all(ids.map((id) => fetchTripPolyline(id)));
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
  app.get("/api/trips/detail", async (req, reply) => {
    const parsed = tripDetailQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    // Profile aus dem (optionalen) stopCode ableiten. Bei AT-Stops brauchen
    // wir zusätzlich Lat/Lon um aufs richtige Verbund-Profile zu routen
    // (vor/vvt/svv/etc.) — die holen wir per DB-Lookup. Ein extra Query pro
    // Trip-Detail-Call, aber das ist billig (indizierter Primary-Key).
    let profile: HafasProfileKey = "db";
    if (parsed.data.stopCode) {
      const row = await db
        .select({
          country: locations.country,
          latitude: locations.latitude,
          longitude: locations.longitude,
        })
        .from(locations)
        .where(eq(locations.code, parsed.data.stopCode))
        .limit(1);
      const r = row[0];
      profile =
        profileForStop({
          code: parsed.data.stopCode,
          country: r?.country ?? null,
          latitude: r?.latitude != null ? Number(r.latitude) : null,
          longitude: r?.longitude != null ? Number(r.longitude) : null,
        }) || "db";
    }
    const detail = await fetchTripDetail(
      parsed.data.tripId,
      parsed.data.fromStopId,
      profile,
    );
    if (!detail) {
      return reply.code(404).send({ error: "Trip not found" });
    }
    return detail;
  });
}
