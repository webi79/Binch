import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { locations, type TravelMode } from "../../db/schema.js";
import { BoundedTtlCache } from "../../util/boundedCache.js";
import { motisFetch, motisGeocode, type MotisPlace } from "../../services/motisClient.js";
import type {
  LegInfo,
  NormalizedResult,
  ProviderResult,
  ProviderSearchInput,
  SearchProvider,
  StopoverInfo,
} from "../types.js";

/**
 * MOTIS-Zug-Provider (Übergang: öffentliche Transitous-Instanz, später eigene
 * self-hosted MOTIS-Box — nur MOTIS_BASE_URL umstellen).
 *
 * Warum: DB blockt db-vendo-client extern (OPS_BLOCKED) und limitiert selbst
 * unblocked auf ~60 req/min. MOTIS routet aus OFFENEN GTFS-Daten (de-DELFI &
 * Co.) — kein DB-Kontakt → unblockbar, kein Rate-Limit auf der eigenen Instanz.
 *
 * Liefert Verbindungen mit Zeiten/Umstiegen/Echtzeit, aber `price=0` (GTFS hat
 * keine Fahrpreise → UI rendert "Tarif beim Anbieter", exakt wie
 * transitSchedule). Preise sind ein separater, späterer Enrichment-Layer.
 *
 * HTTP-Client + Geocode liegen geteilt in services/motisClient (auch vom
 * Stop-Board genutzt). Guter-Bürger-Design: Koordinaten-Cache (24h) + kurzer
 * Plan-Cache (5 min) senken die Anzahl teurer Routing-Calls.
 */

// code → MOTIS-Place (bevorzugt aus unseren gespeicherten Koordinaten). Stabil → 24h.
const coordCache = new BoundedTtlCache<MotisPlace | null>(2000, 24 * 60 * 60 * 1000);
// Plan-Response pro (from|to|10-Min-Bucket) → 5 min (schont Transitous, Routing
// ist deren teuerster Endpoint; Ergebnisse sind für ein paar Minuten stabil).
const planCache = new BoundedTtlCache<MotisItinerary[]>(500, 5 * 60 * 1000);

interface MotisLegStop {
  name?: string;
  stopId?: string;
  lat?: number;
  lon?: number;
  tz?: string;
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
}
interface MotisLeg {
  mode: string;
  from: MotisLegStop;
  to: MotisLegStop;
  startTime?: string;
  endTime?: string;
  duration?: number;
  tripShortName?: string;
  routeShortName?: string;
  headsign?: string;
  agencyName?: string;
  realTime?: boolean;
  tripId?: string;
  intermediateStops?: MotisLegStop[];
}
interface MotisItinerary {
  startTime: string;
  endTime: string;
  transfers?: number;
  legs: MotisLeg[];
}

/**
 * Binch-`code` → MOTIS-Place. Bevorzugt die in `locations` gespeicherten
 * Koordinaten (präzise, kein Geocode-Call, reused Asset) und gibt MOTIS ein
 * `lat,lng`-Tupel als `fromPlace`. Nur wenn keine Koordinaten vorliegen,
 * fällt es auf Label-Geocoding zurück. (Die HAFAS-ID selbst taugt nicht als
 * MOTIS-ID — anderer Namespace; die daneben liegenden Koordinaten schon.)
 */
async function resolvePlace(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  const cached = coordCache.get(code);
  if (cached !== undefined) return cached;

  let place: MotisPlace | null = null;
  try {
    const hit = await db
      .select({ lat: locations.latitude, lng: locations.longitude, label: locations.label })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    const lat = hit[0]?.lat != null ? Number(hit[0].lat) : NaN;
    const lng = hit[0]?.lng != null ? Number(hit[0].lng) : NaN;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      // MOTIS akzeptiert `latitude,longitude` direkt als fromPlace/toPlace.
      place = { id: `${lat},${lng}`, name: hit[0]?.label ?? label ?? code };
    }
  } catch {
    // DB-Fehler → nicht cachen, unten auf Geocode fallen.
  }

  // Kein Koordinaten-Treffer → Label-Geocoding als Fallback.
  if (!place && label) {
    place = await motisGeocode(label, signal);
  }
  coordCache.set(code, place);
  return place;
}

function toStopovers(stops: MotisLegStop[] | undefined): StopoverInfo[] | undefined {
  if (!stops || stops.length === 0) return undefined;
  return stops.map((s) => ({
    name: s.name,
    arrival: s.arrival ?? s.scheduledArrival,
    departure: s.departure ?? s.scheduledDeparture,
    platform: s.track,
  }));
}

function toLeg(leg: MotisLeg): LegInfo {
  const depart = leg.from.departure ?? leg.from.scheduledDeparture ?? leg.startTime ?? "";
  const arrive = leg.to.arrival ?? leg.to.scheduledArrival ?? leg.endTime ?? "";
  const durationMinutes =
    depart && arrive ? Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60_000)) : 0;
  const stopovers = toStopovers(leg.intermediateStops);
  return {
    origin: leg.from.stopId ?? leg.from.name ?? "",
    destination: leg.to.stopId ?? leg.to.name ?? "",
    originLabel: leg.from.name,
    destLabel: leg.to.name,
    originLat: leg.from.lat,
    originLng: leg.from.lon,
    destLat: leg.to.lat,
    destLng: leg.to.lon,
    departTime: depart,
    arriveTime: arrive,
    durationMinutes,
    departPlatform: leg.from.track,
    arrivePlatform: leg.to.track,
    line: leg.tripShortName || leg.routeShortName || undefined,
    product: leg.mode,
    fahrtNr: leg.tripShortName || undefined,
    direction: leg.headsign || undefined,
    walking: leg.mode === "WALK",
    stops: leg.intermediateStops?.length ?? 0,
    stopovers,
    tripId: leg.tripId,
  };
}

function toNormalized(
  it: MotisItinerary,
  input: ProviderSearchInput,
  from: MotisPlace,
  to: MotisPlace,
  idx: number,
): NormalizedResult | null {
  const transit = it.legs.filter((l) => l.mode !== "WALK");
  if (transit.length === 0) return null; // reine Fußweg-"Verbindung" ignorieren

  const first = transit[0]!;
  const last = transit[transit.length - 1]!;
  // Headline = echte ZUG-Zeiten (erste Zug-Abfahrt → letzte Zug-Ankunft), nicht
  // it.startTime/endTime (die den Bahnsteig-Zugangsweg vom Koordinaten-Punkt
  // mit-einrechnen und die Abfahrt einige Minuten zu früh wirken lassen).
  const departTime = first.from.departure ?? first.from.scheduledDeparture ?? first.startTime ?? it.startTime;
  const arriveTime = last.to.arrival ?? last.to.scheduledArrival ?? last.endTime ?? it.endTime;
  const durationMinutes = Math.max(
    1,
    Math.round((Date.parse(arriveTime) - Date.parse(departTime)) / 60_000),
  );
  // Umstiegs-Stationen = Ziel jedes Transit-Legs außer dem letzten.
  const transferLabels = transit
    .slice(0, -1)
    .map((l) => l.to.name)
    .filter((n): n is string => !!n);

  return {
    externalId: `motis:${input.origin}:${input.destination}:${it.startTime}:${idx}`,
    origin: input.origin,
    destination: input.destination,
    originLabel: input.originLabel ?? from.name,
    destLabel: input.destLabel ?? to.name,
    departTime,
    arriveTime,
    originTz: first.from.tz ?? from.tz,
    destinationTz: last.to.tz ?? to.tz,
    dateOnly: false,
    durationMinutes,
    stops: Math.max(0, transit.length - 1),
    stopLabels: transferLabels,
    // Nur Zug-Segmente (wie transitSchedule) — Zugangs-/Umstiegs-Fußwege
    // lassen wir aus der Card-Timeline raus.
    legs: transit.map(toLeg),
    price: 0,
    currency: input.currency,
    // Schedule-only, nicht buchbar → kein deepLink (wie transitSchedule). UI
    // nutzt den Trip-Detail-Flow (LegTimelineOverlay). Booking-Deeplink/Preis
    // kommt später als eigener Layer.
    deepLink: "",
    // flightNumber dient als Linien-Kürzel (z.B. "ICE 1007").
    flightNumber: first.tripShortName || first.routeShortName || undefined,
    operatedBy: first.agencyName || undefined,
  };
}

function empty(start: number, raw: unknown): ProviderResult {
  return { results: [], raw, statusCode: 0, durationMs: Date.now() - start };
}

/**
 * Factory: ein MOTIS-Provider je Travel-Mode. `transitModes` steuert, welche
 * Verkehrsmittel MOTIS routet (RAIL für Züge, BUS/COACH für Busse). Alles
 * andere (Auflösung, Cache, Normalisierung) ist geteilt.
 */
function makeMotisProvider(mode: TravelMode, transitModes: string, name: string): SearchProvider {
  return {
    name,
    mode,
    isConfigured: () => config.MOTIS_ENABLED && !!config.MOTIS_BASE_URL,

    async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
      const start = Date.now();

      // Auflösung über unsere gespeicherten Koordinaten (Fallback: Label-Geocode).
      let from: MotisPlace | null;
      let to: MotisPlace | null;
      try {
        [from, to] = await Promise.all([
          resolvePlace(input.origin, input.originLabel, signal),
          resolvePlace(input.destination, input.destLabel, signal),
        ]);
      } catch (e) {
        return empty(start, { error: "motis_resolve_failed", message: e instanceof Error ? e.message : String(e) });
      }
      if (!from || !to) {
        return empty(start, { skipped: "motis resolve no match", origin: input.origin, destination: input.destination });
      }

      const time = input.departTime ?? input.departDate;
      const bucket = Math.floor(Date.parse(time) / (10 * 60_000));
      // transitModes im Key: Bus- und Zug-Suche derselben Strecke dürfen sich
      // den Plan-Cache NICHT teilen.
      const cacheKey = `${transitModes}|${from.id}|${to.id}|${bucket}`;

      let itineraries = planCache.get(cacheKey);
      const fromCache = itineraries !== undefined;
      if (!itineraries) {
        try {
          const url =
            `/v6/plan?fromPlace=${encodeURIComponent(from.id)}` +
            `&toPlace=${encodeURIComponent(to.id)}` +
            `&time=${encodeURIComponent(new Date(time).toISOString())}` +
            `&transitModes=${encodeURIComponent(transitModes)}&numItineraries=6&detailedTransfers=false`;
          const raw = (await motisFetch(url, signal)) as { itineraries?: MotisItinerary[] };
          itineraries = raw.itineraries ?? [];
          planCache.set(cacheKey, itineraries);
        } catch (e) {
          return empty(start, { error: "motis_plan_failed", message: e instanceof Error ? e.message : String(e) });
        }
      }

      const results = itineraries
        .map((it, i) => toNormalized(it, input, from!, to!, i))
        .filter((r): r is NormalizedResult => r !== null);

      return {
        results,
        raw: { source: name, from: from.id, to: to.id, count: results.length, planCached: fromCache },
        statusCode: 200,
        durationMs: Date.now() - start,
      };
    },
  };
}

/** Zug-Routing (RAIL: ICE/IC/RE/S-Bahn etc.). */
export const motisProvider = makeMotisProvider("TRAIN", "RAIL", "motis");
/** Bus-Routing (Regional- + Fernbusse aus GTFS — belebt BUS-Mode trotz DB-Block). */
export const motisBusProvider = makeMotisProvider("BUS", "BUS,COACH", "motis-bus");
