import { eq } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { locations, type TravelMode } from "../../db/schema.js";
import { BoundedTtlCache } from "../../util/boundedCache.js";
import {
  motisFetch,
  motisGeocode,
  motisGeocodeNearestStop,
  type MotisPlace,
} from "../../services/motisClient.js";
import { buildBahnDeeplink } from "../../util/bahnDeeplink.js";
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
 * Binch-`code` → MOTIS-Place. Bevorzugt die **exakte MOTIS-Stop-ID** (via
 * Label-Geocode, disambiguiert über die gespeicherte Koordinate), damit die
 * Route genau am gewählten Halt endet. Routet man nur an eine Koordinate,
 * snappt MOTIS auf den nächstgelegenen Halt — bei eng benachbarten Stops
 * (Zürich Brunau vs. Saalsporthalle) landet die Fahrt am falschen Ort.
 *
 * Fallback-Kette: exakte Stop-ID (Geocode + Koordinaten-Nähe) → gespeicherte
 * Koordinate als `lat,lng` → reines Label-Geocode. So gibt es nie 0 Ergebnisse
 * nur weil der Geocode danebengreift. (Die HAFAS-ID taugt nicht als MOTIS-ID —
 * anderer Namespace.)
 */
async function resolvePlace(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  const cached = coordCache.get(code);
  if (cached !== undefined) return cached;

  let lat = NaN;
  let lng = NaN;
  let dbLabel: string | undefined;
  try {
    const hit = await db
      .select({ lat: locations.latitude, lng: locations.longitude, label: locations.label })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    lat = hit[0]?.lat != null ? Number(hit[0].lat) : NaN;
    lng = hit[0]?.lng != null ? Number(hit[0].lng) : NaN;
    dbLabel = hit[0]?.label ?? undefined;
  } catch {
    // DB-Fehler → unten auf Geocode/Koordinate fallen.
  }

  const name = dbLabel ?? label;
  let place: MotisPlace | null = null;

  // 1) Exakte Stop-ID: Label geocoden, den STOP nächst unserer Koordinate nehmen.
  if (name && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = await motisGeocodeNearestStop(name, lat, lng, 400, signal);
  }
  // 2) Sonst Koordinate direkt (MOTIS akzeptiert `lat,lng` als fromPlace/toPlace).
  //    lat/lon mitgeben — Aufrufer (Deeplink) brauchen sie als Fallback.
  if (!place && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = { id: `${lat},${lng}`, name: name ?? code, lat, lon: lng };
  }
  // 3) Gar keine Koordinate → reines Label-Geocode.
  if (!place && name) {
    place = await motisGeocode(name, signal);
  }

  coordCache.set(code, place);
  return place;
}

function toStopovers(stops: MotisLegStop[] | undefined): StopoverInfo[] | undefined {
  if (!stops || stops.length === 0) return undefined;
  return stops.map((s) => ({
    name: s.name,
    // Planmäßige Zeit zuerst (Fahrplanzeit) — NICHT die Echtzeit inkl.
    // Verspätung; sonst zeigt die Timeline verwirrende „Ist"-Zeiten.
    arrival: s.scheduledArrival ?? s.arrival,
    departure: s.scheduledDeparture ?? s.departure,
    platform: s.track,
  }));
}

/**
 * Linien-/Zug-Label: Fernverkehr nutzt die Zugnummer (tripShortName „ICE 523"),
 * Nahverkehr die Liniennummer (routeShortName „RE1") — NICHT die interne
 * Fahrtnummer (tripShortName ist bei Nahverkehr „026848", routeShortName bei
 * Fernverkehr eine nackte „41"). Genau umgekehrte Priorität je Verkehrsart.
 */
function lineLabel(leg: MotisLeg): string | undefined {
  const longDist =
    leg.mode === "HIGHSPEED_RAIL" || leg.mode === "LONG_DISTANCE" || leg.mode === "NIGHT_RAIL";
  // Manche Feeds setzen "0" als Platzhalter-Liniennamen. Das ist truthy und hat
  // sonst den echten Namen verdrängt → in der Timeline stand eine Linie „0".
  // (Echte numerische Linien wie Tram „7"/„13" bleiben natürlich gültig.)
  const clean = (s?: string) => {
    const v = s?.trim();
    return v && v !== "0" ? v : undefined;
  };
  const primary = longDist ? clean(leg.tripShortName) : clean(leg.routeShortName);
  const secondary = longDist ? clean(leg.routeShortName) : clean(leg.tripShortName);
  return primary ?? secondary;
}

/** Verspätung in Minuten (Ist − Soll), nur wenn Realtime + echte Verspätung. */
function delayMinutes(scheduled?: string, actual?: string, realTime?: boolean): number | undefined {
  if (!realTime || !scheduled || !actual) return undefined;
  const d = Math.round((Date.parse(actual) - Date.parse(scheduled)) / 60_000);
  return d > 0 ? d : undefined;
}

/** Stationsnamen vergleichbar machen (Kleinbuchstaben, nur Alphanumerisches). */
function normStationName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function toLeg(leg: MotisLeg): LegInfo {
  // Planmäßige (Fahrplan-)Zeit zuerst, Echtzeit nur als Fallback — die Card/
  // Timeline soll die normale Abfahrt zeigen, nicht Soll+Verspätung.
  const depart = leg.from.scheduledDeparture ?? leg.from.departure ?? leg.startTime ?? "";
  const arrive = leg.to.scheduledArrival ?? leg.to.arrival ?? leg.endTime ?? "";
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
    departDelayMinutes: delayMinutes(leg.from.scheduledDeparture, leg.from.departure, leg.realTime),
    arriveDelayMinutes: delayMinutes(leg.to.scheduledArrival, leg.to.arrival, leg.realTime),
    durationMinutes,
    departPlatform: leg.from.track,
    arrivePlatform: leg.to.track,
    line: lineLabel(leg),
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
  mode: TravelMode,
): NormalizedResult | null {
  const transit = it.legs.filter((l) => l.mode !== "WALK");
  if (transit.length === 0) return null; // reine Fußweg-"Verbindung" ignorieren

  const first = transit[0]!;
  const last = transit[transit.length - 1]!;

  // Fußwege sind ECHTE Reise-Bestandteile, keine Deko: MOTIS routet regelmäßig
  // „7 min Fußweg → Tram bis Nachbarhalt → 12 min Fußweg ans Ziel". Zählt man
  // nur die Fahrzeug-Legs, dann
  //   - ist die Verbindung angeblich 10 statt 30 min lang,
  //   - liegt die Abfahrt zu spät (der Zugangsweg zum Halt fehlt) und
  //   - endet die Route sichtbar am falschen Stop („Billoweg" statt Brunau).
  // Darum: Fußweg-Legs mitliefern und die Zeiten daraus ziehen — die
  // DB-Reiseauskunft zeigt sie ebenso als „Fußweg X Min".
  //
  // 0-Minuten-Stubs raus (MOTIS hängt an Umstiegen gern Null-Wege an).
  const journeyLegs = it.legs.filter(
    (l) => l.mode !== "WALK" || Math.round((l.duration ?? 0) / 60) >= 1,
  );

  // ABER: Routen wir über eine Koordinate (weil der Geocoder für große Bahnhöfe
  // keinen kanonischen Knoten hergibt), hängt MOTIS vorn/hinten einen künstlichen
  // Zugangsweg vom Koordinatenpunkt zum Bahnsteig an — „München Hbf → 6 min zu
  // Fuß → München Hbf". Das ist kein Reiseabschnitt, sondern ein Artefakt; die DB
  // zeigt sowas auch nicht (die sagt „ab 08:00, Gleis 21"). Solche Fußwege ZUM
  // EIGENEN Bahnhof werfen wir raus. Ein Fußweg zwischen VERSCHIEDENEN Stationen
  // (Billoweg → Brunau) bleibt selbstverständlich drin.
  const sameStation = (a?: string, b?: string) =>
    !!a && !!b && normStationName(a) === normStationName(b);
  if (
    journeyLegs[0]?.mode === "WALK" &&
    sameStation(journeyLegs[0].to?.name, input.originLabel ?? from.name)
  ) {
    journeyLegs.shift();
  }
  const lastLegIdx = journeyLegs.length - 1;
  if (
    lastLegIdx > 0 &&
    journeyLegs[lastLegIdx]?.mode === "WALK" &&
    sameStation(journeyLegs[lastLegIdx]!.from?.name, input.destLabel ?? to.name)
  ) {
    journeyLegs.pop();
  }
  if (journeyLegs.length === 0) return null;

  // Zeiten aus den verbleibenden Legs (inkl. echter Fußwege).
  const legStart = (l: MotisLeg) =>
    l.from.scheduledDeparture ?? l.from.departure ?? l.startTime ?? it.startTime;
  const legEnd = (l: MotisLeg) =>
    l.to.scheduledArrival ?? l.to.arrival ?? l.endTime ?? it.endTime;
  const departTime = legStart(journeyLegs[0]!);
  const arriveTime = legEnd(journeyLegs[journeyLegs.length - 1]!);
  const durationMinutes = Math.max(
    1,
    Math.round((Date.parse(arriveTime) - Date.parse(departTime)) / 60_000),
  );

  // Startet die Reise mit einem (echten) Fußweg, ist die Abfahrt am Ursprung
  // NICHT verspätet — man geht ja trotzdem los. Die Verspätung des Fahrzeugs
  // steht am jeweiligen Leg in der Timeline.
  const startsWithWalk = journeyLegs[0]?.mode === "WALK";

  // Echte Endpunkte der Reise (können Fußweg-Enden sein) — für Deeplink + TZ.
  const journeyFrom = journeyLegs[0]!.from;
  const journeyTo = journeyLegs[journeyLegs.length - 1]!.to;

  // Umstiegs-Stationen = Ziel jedes Transit-Legs außer dem letzten.
  const transferLabels = transit
    .slice(0, -1)
    .map((l) => l.to.name)
    .filter((n): n is string => !!n);

  // Beim Koordinaten-Routing nennt MOTIS die Endpunkte "START"/"END" — das sind
  // keine Stationsnamen. Mit dem vom User gewählten Label ersetzen, sonst steht
  // in der Timeline "END" statt "Zürich Brunau".
  const mappedLegs = journeyLegs.map(toLeg);
  const firstMapped = mappedLegs[0];
  const lastMapped = mappedLegs[mappedLegs.length - 1];
  if (firstMapped && (!firstMapped.originLabel || firstMapped.originLabel === "START")) {
    firstMapped.originLabel = input.originLabel ?? from.name;
  }
  if (lastMapped && (!lastMapped.destLabel || lastMapped.destLabel === "END")) {
    lastMapped.destLabel = input.destLabel ?? to.name;
  }

  return {
    externalId: `motis:${input.origin}:${input.destination}:${it.startTime}:${idx}`,
    origin: input.origin,
    destination: input.destination,
    originLabel: input.originLabel ?? from.name,
    destLabel: input.destLabel ?? to.name,
    departTime,
    arriveTime,
    departDelayMinutes: startsWithWalk
      ? 0
      : delayMinutes(first.from.scheduledDeparture, first.from.departure, first.realTime),
    // Ankunft am Ziel verschiebt sich sehr wohl mit dem letzten Fahrzeug —
    // auch wenn danach noch ein Fußweg kommt.
    arriveDelayMinutes: delayMinutes(last.to.scheduledArrival, last.to.arrival, last.realTime),
    // Zeitzone der REISE-Endpunkte: departTime/arriveTime beziehen sich seit dem
    // Fußweg-Fix auf sie, nicht mehr auf den ersten/letzten Zug-Halt.
    originTz: journeyFrom.tz ?? from.tz,
    destinationTz: journeyTo.tz ?? to.tz,
    dateOnly: false,
    durationMinutes,
    stops: Math.max(0, transit.length - 1),
    stopLabels: transferLabels,
    // Inkl. Fußweg-Legs — sonst endet die Timeline am letzten Fahrzeug-Halt
    // statt am gewählten Ziel (siehe Kommentar oben).
    legs: mappedLegs,
    price: 0,
    currency: input.currency,
    // deepLink = FALLBACK: vorausgefüllte bahn.de-Suche. Der Direkt-Buchungs-
    // link (bahn.de/buchung/start?vbid) wird beim Tap aus dem bookingToken
    // (Recon, via trainPricing-Enrichment) erzeugt — greift der nicht, landet
    // der Redirect auf dieser Suche. Nur für Züge (bahn.de ist Bahn-zentriert).
    // Endpunkte der REISE, nicht des ersten/letzten Zug-Legs: bei einem
    // Zugangs-Fußweg wäre `first.from` eine Tram-Haltestelle — der Deeplink
    // hätte dann den Namen des gewählten Bahnhofs, aber dessen Koordinaten.
    // bahn.de löst nach Koordinate auf → falscher Startort.
    deepLink:
      mode === "TRAIN"
        ? buildBahnDeeplink({
            origin: { name: input.originLabel ?? from.name, lat: journeyFrom.lat, lng: journeyFrom.lon },
            destination: { name: input.destLabel ?? to.name, lat: journeyTo.lat, lng: journeyTo.lon },
            departTime,
            originTz: journeyFrom.tz ?? from.tz,
          })
        : "",
    // flightNumber dient als Linien-Kürzel: Fern "ICE 523", Nah "RE1".
    flightNumber: lineLabel(first),
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
            // maxTransfers=5 kappt absurde Pareto-Odysseen (6+ Umstiege quer
            // durchs Regionalnetz), die die DB nie zeigt — legitime grenz-
            // überschreitende+lokale Routen brauchen max. ~3-4 Umstiege.
            `&transitModes=${encodeURIComponent(transitModes)}&numItineraries=6&maxTransfers=5&detailedTransfers=false`;
          const raw = (await motisFetch(url, signal)) as { itineraries?: MotisItinerary[] };
          itineraries = raw.itineraries ?? [];
          planCache.set(cacheKey, itineraries);
        } catch (e) {
          return empty(start, { error: "motis_plan_failed", message: e instanceof Error ? e.message : String(e) });
        }
      }

      const results = itineraries
        .map((it, i) => toNormalized(it, input, from!, to!, i, mode))
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
// RAIL allein reicht NICHT: viele Ziele (v.a. lokale/kleine Halte, Schweizer
// SZU-/Nebennetz-Stops wie Zürich Brunau) sind nur über Nahverkehr erreichbar.
// Ohne die Nahverkehrs-Modi → "keine Verbindung gefunden".
//
// BUS gehört ebenfalls dazu: der DB Navigator nimmt für die letzte Meile
// selbstverständlich Tram UND Bus mit rein. Ließen wir Bus weg, fehlten genau
// die Verbindungen, die die DB zeigt. (Der Bus-TAB ist etwas anderes — der
// sucht Fernbusse, siehe motisBusProvider mit BUS,COACH.)
export const motisProvider = makeMotisProvider(
  "TRAIN",
  "RAIL,SUBURBAN,TRAM,SUBWAY,BUS",
  "motis",
);
/** Bus-Routing (Regional- + Fernbusse aus GTFS — belebt BUS-Mode trotz DB-Block). */
export const motisBusProvider = makeMotisProvider("BUS", "BUS,COACH", "motis-bus");
