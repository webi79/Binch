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
interface CachedPlan {
  itineraries: MotisItinerary[];
  /** MOTIS-Cursor für die nächste Seite („später") — an den Client durchgereicht. */
  nextPageCursor?: string;
}
const planCache = new BoundedTtlCache<CachedPlan>(500, 5 * 60 * 1000);

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
  /** Fahrplan-Gleis. MOTIS füllt mal nur `track`, mal beides — beide lesen. */
  scheduledTrack?: string;
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
  /** Herkunfts-Feed, z.B. "de_DELFI.gtfs.zip/..." — siehe dropReferenceDuplicates. */
  source?: string;
  intermediateStops?: MotisLegStop[];
}
interface MotisItinerary {
  startTime: string;
  endTime: string;
  transfers?: number;
  legs: MotisLeg[];
}

/**
 * Transitous speist neben den operativen Fahrplänen (de_DELFI, ÖBB, SBB …) auch
 * einen REFERENZDATEN-Feed ein (`at_Railway-Current-Reference-Data`). Der bildet
 * dieselben Fahrten nochmal ab, aber schlechter:
 *   - keine Gleise (München Hbf ohne „Gl. 11"),
 *   - eigene Bahnhofs-Knoten mit abweichenden Namen („München Hauptbahnhof"),
 *     was uns die Phantom-Fußwege und den falschen Geocode eingebracht hat.
 * Landet so eine Dublette im Ranking oben, fehlt dem User das Gleis.
 *
 * Also: Referenz-Variante verwerfen, WENN dieselbe Fahrt (gleiche Abfahrt +
 * Ankunft) auch aus einem operativen Feed vorliegt. Gibt es sie NUR dort, bleibt
 * sie — so geht keine Verbindung verloren.
 */
function isReferenceLeg(leg: MotisLeg): boolean {
  return /reference-data/i.test(leg.source ?? "");
}

function dropReferenceDuplicates(itineraries: MotisItinerary[]): MotisItinerary[] {
  const tripKey = (it: MotisItinerary): string | null => {
    const transit = it.legs.filter((l) => l.mode !== "WALK");
    const first = transit[0];
    const last = transit[transit.length - 1];
    if (!first || !last) return null;
    const dep = first.from.scheduledDeparture ?? first.from.departure ?? "";
    const arr = last.to.scheduledArrival ?? last.to.arrival ?? "";
    return dep && arr ? `${dep}|${arr}` : null;
  };

  const operational = new Set<string>();
  for (const it of itineraries) {
    const isRef = it.legs.some((l) => l.mode !== "WALK" && isReferenceLeg(l));
    const k = tripKey(it);
    if (!isRef && k) operational.add(k);
  }

  return itineraries.filter((it) => {
    const isRef = it.legs.some((l) => l.mode !== "WALK" && isReferenceLeg(l));
    if (!isRef) return true;
    const k = tripKey(it);
    return !k || !operational.has(k);
  });
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
    platform: s.track ?? s.scheduledTrack,
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

/**
 * Bahnhofs-Abkürzungen, die dieselbe Station meinen. Nötig, weil die Feeds
 * denselben Bahnhof unterschiedlich benennen („München Hbf" vs. „München
 * Hauptbahnhof", „Zürich HB"). Ohne Auflösung hielten wir die zwei Knoten für
 * verschiedene Orte und zeigten einen Fußweg von München Hbf nach München Hbf.
 * Nur als ganzes WORT ersetzen — sonst würde „Bahnhofstrasse" mitverstümmelt.
 */
const STATION_ABBR: Record<string, string> = {
  hbf: "hauptbahnhof",
  hb: "hauptbahnhof",
  bhf: "bahnhof",
  bf: "bahnhof",
};

/** Stationsname → normalisierte WORT-Liste (Abkürzungen aufgelöst). */
function stationTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((tok) => STATION_ABBR[tok] ?? tok);
}

/**
 * Meinen die beiden Namen denselben Bahnhof?
 *
 * Erlaubt ist nur ein vorangestelltes PRÄFIX — Feeds hängen gern Verkehrsmittel-
 * Marker davor („S+U Berlin Hauptbahnhof" = „Berlin Hbf"). Ein angehängtes
 * SUFFIX ändert dagegen die Bedeutung: „Wien Hauptbahnhof Ost" ist NICHT „Wien
 * Hbf" — diese Verwechslung hat uns schon zum falschen Knoten geroutet (Feed
 * ohne Gleisdaten → Gleis fehlte am Start).
 *
 * Verglichen wird auf WORT-Ebene, nicht auf dem zusammengeklebten String: sonst
 * matchte „Neustadt".endsWith("Stadt") — zwei völlig verschiedene Bahnhöfe, und
 * ein echter Fußweg dorthin wäre verschwunden.
 *
 *   ["s","u","berlin","hauptbahnhof"] ⊃ ["berlin","hauptbahnhof"]  → true (Suffix)
 *   ["wien","hauptbahnhof","ost"]     vs ["wien","hauptbahnhof"]   → false (Präfix)
 *   ["zürich","bahnhofstrasse","hauptbahnhof"] vs ["zürich","hauptbahnhof"] → false
 *     (echte Tram-Haltestelle nebenan — der Fußweg dorthin muss bleiben)
 */
function sameStation(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = stationTokens(a);
  const y = stationTokens(b);
  if (x.length === 0 || y.length === 0) return false;

  // Der kürzere Name muss ein WORT-SUFFIX des längeren sein (= nur Präfixe
  // dazugekommen). Ein einzelnes Allerweltswort („Bahnhof") reicht dafür nicht.
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 2 && long.length !== short.length) return false;
  const tail = long.slice(long.length - short.length);
  return short.every((tok, i) => tok === tail[i]);
}

/**
 * Ab welchem Zeitpunkt suchen wir?
 *
 * Vorher stand hier schlicht `input.departTime ?? input.departDate`. Für ein
 * reines Datum ergab das `2026-07-16T00:00:00Z` — Mitternacht UTC. Zwei Fehler:
 *   - Suche für HEUTE lieferte längst abgefahrene Verbindungen (ab 00:00,
 *     obwohl es 19 Uhr ist).
 *   - Suche für morgen lieferte nur die ersten Verbindungen ab Mitternacht,
 *     also ausschließlich Nachtzüge — die Tages-ICEs sah der User nie.
 *
 * Jetzt: heute → ab JETZT (wie die DB). Künftiges Datum → ab DEFAULT_HOUR, weil
 * die App (noch) keinen Uhrzeit-Picker hat und 00:00 nur Nachtzüge zeigen würde.
 * Weiter in den Tag kommt der User über die Pagination („später", nextPageCursor).
 *
 * Ein großes `searchWindow` wäre der elegantere Weg, ist auf der öffentlichen
 * Transitous-Instanz aber unbezahlbar: 3 h → 6,5 s, 12 h → 16,5 s, 24 h → 39 s
 * (bei nur ~0,6 s echter Routing-Zeit — der Rest ist Payload/Last). Erst ein
 * self-hosted MOTIS macht Tagesfenster praktikabel.
 *
 * Der Reisetag wird in Europe/Berlin abgegrenzt (Kernmarkt; CH/AT/FR/ES liegen
 * in derselben Zone).
 */
const DAY_TZ = "Europe/Berlin";
const DEFAULT_HOUR = 8;

/** Tagesbeginn (00:00 Ortszeit) des Datums in DAY_TZ, als UTC-Millis. Trick: den
 *  Zonen-Offset an diesem Datum aus der Differenz von UTC- und Zonen-
 *  Formatierung ableiten. */
function dayStartMs(date: string): number {
  const midnightUtc = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const offsetMs =
    new Date(midnightUtc.toLocaleString("en-US", { timeZone: "UTC" })).getTime() -
    new Date(midnightUtc.toLocaleString("en-US", { timeZone: DAY_TZ })).getTime();
  return midnightUtc.getTime() + offsetMs;
}

/** Suchzeitpunkt für einen Reisetag (ohne explizite Uhrzeit). */
function startForDate(date: string): string {
  const dayStart = dayStartMs(date);
  const dayEnd = dayStart + 24 * 3600_000;
  const now = Date.now();

  // Der Reisetag läuft bereits (= heute) → ab JETZT, wie die DB. NICHT ab
  // DEFAULT_HOUR: eine Suche um 06:00 für heute hätte sonst erst ab 08:00
  // gesucht und die noch fahrenden Frühzüge verschluckt.
  if (now >= dayStart && now < dayEnd) return new Date(now).toISOString();

  // Künftiger Tag → ab DEFAULT_HOUR (00:00 zeigte nur Nachtzüge). Liegt der Tag
  // in der Vergangenheit (sollte der Picker verhindern), ebenso — dann bekommt
  // der User wenigstens den Fahrplan des Tages statt Verbindungen von heute.
  return new Date(dayStart + DEFAULT_HOUR * 3600_000).toISOString();
}

function searchStartFor(input: ProviderSearchInput): string {
  // Uhrzeit aus dem Picker (bzw. Surroundings-Departure-Tap): exakter Zeitpunkt.
  if (input.departTime) return new Date(input.departTime).toISOString();
  return startForDate(input.departDate);
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
    departPlatform: leg.from.track ?? leg.from.scheduledTrack,
    arrivePlatform: leg.to.track ?? leg.to.scheduledTrack,
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
  // Nicht jeder WALK ist eine Etappe:
  //   - 0-Minuten-Stubs (MOTIS hängt an Umstiegen gern Null-Wege an),
  //   - Wege von einer Haltestelle ZU SICH SELBST („Waffenplatzstrasse →
  //     Waffenplatzstrasse", 1 min) — das ist ein Bahnsteig-/Steigwechsel.
  // Beides wäre in der Timeline nur Rauschen; die DB zeigt dort schlicht den
  // Umstieg. Fällt so ein Weg weg, rendert der Client wieder den „Umstieg"-Block.
  const journeyLegs = it.legs.filter((l) => {
    if (l.mode !== "WALK") return true;
    if (Math.round((l.duration ?? 0) / 60) < 1) return false;
    if (sameStation(l.from?.name, l.to?.name)) return false;
    return true;
  });

  // ABER: Routen wir über eine Koordinate (weil der Geocoder für große Bahnhöfe
  // keinen kanonischen Knoten hergibt), hängt MOTIS vorn/hinten einen künstlichen
  // Zugangsweg zum Bahnsteig an — und weil die Feeds denselben Bahnhof
  // verschieden benennen, sieht das aus wie eine echte Etappe:
  //   09:10 München Hbf → 🚶3min → 09:13 München Hauptbahnhof → RJX 63
  // Beides ist derselbe Bahnhof. Die DB zeigt schlicht „ab 09:13" — und die
  // Abfahrt/Dauer stimmten bei uns dadurch auch nicht (09:10/4h31 statt
  // 09:13/4h19). Solche Fußwege ZUM EIGENEN Bahnhof fliegen raus; ein Fußweg zu
  // einer ANDEREN Station (Billoweg → Brunau) bleibt drin.
  const originName = input.originLabel ?? from.name;
  const destName = input.destLabel ?? to.name;
  const droppedAccessWalk =
    journeyLegs[0]?.mode === "WALK" && sameStation(journeyLegs[0].to?.name, originName);
  if (droppedAccessWalk) journeyLegs.shift();

  const lastLegIdx = journeyLegs.length - 1;
  const droppedEgressWalk =
    lastLegIdx > 0 &&
    journeyLegs[lastLegIdx]?.mode === "WALK" &&
    sameStation(journeyLegs[lastLegIdx]!.from?.name, destName);
  if (droppedEgressWalk) journeyLegs.pop();

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

  // Endpunkt-Beschriftung auf das vom User gewählte Label ziehen. Drei Fälle:
  //   - Koordinaten-Routing → MOTIS nennt die Endpunkte "START"/"END".
  //   - Feed-Alias → der Zug startet laut Feed an „München Hauptbahnhof",
  //     gewählt wurde „München Hbf". Die DB zeigt den gewählten Namen.
  //   - sonst (echte andere Station, z.B. Tram-Halt nach Fußweg) → unangetastet.
  const mappedLegs = journeyLegs.map(toLeg);
  const firstMapped = mappedLegs[0];
  const lastMapped = mappedLegs[mappedLegs.length - 1];
  if (
    firstMapped &&
    (!firstMapped.originLabel ||
      firstMapped.originLabel === "START" ||
      sameStation(firstMapped.originLabel, originName))
  ) {
    firstMapped.originLabel = originName;
  }
  if (
    lastMapped &&
    (!lastMapped.destLabel ||
      lastMapped.destLabel === "END" ||
      sameStation(lastMapped.destLabel, destName))
  ) {
    lastMapped.destLabel = destName;
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
    // Beginnt die Reise mit einem Fußweg, ist der Startknoten beim Koordinaten-
    // Routing ein synthetisches „START" OHNE tz — und die per Koordinate
    // aufgelöste MotisPlace hat auch keine. Ohne den Zug-Leg als Rückfall
    // stünde hier `undefined`, und der Client würde die Zeiten in GERÄTE-Zeit
    // rendern statt in Ortszeit (auf Auslandsstrecken sichtbar falsch).
    originTz: journeyFrom.tz ?? first.from.tz ?? from.tz,
    destinationTz: journeyTo.tz ?? last.to.tz ?? to.tz,
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

      // Ein MOTIS-Plan (mit Cache). Wird für Hin- UND Rückfahrt benutzt.
      const plan = async (
        a: MotisPlace,
        b: MotisPlace,
        time: string,
        cursor?: string,
      ): Promise<CachedPlan> => {
        // Blättert der User („später"), gibt MOTIS den Zeitpunkt über den Cursor
        // vor — dann ist `time` irrelevant und darf NICHT in den Cache-Key.
        const bucket = Math.floor(Date.parse(time) / (10 * 60_000));
        // transitModes im Key: Bus- und Zug-Suche derselben Strecke dürfen sich
        // den Plan-Cache NICHT teilen.
        const key = cursor
          ? `${transitModes}|${a.id}|${b.id}|cursor:${cursor}`
          : `${transitModes}|${a.id}|${b.id}|${bucket}`;
        const hit = planCache.get(key);
        if (hit) return hit;

        const url =
          `/v6/plan?fromPlace=${encodeURIComponent(a.id)}` +
          `&toPlace=${encodeURIComponent(b.id)}` +
          (cursor
            ? `&pageCursor=${encodeURIComponent(cursor)}`
            : `&time=${encodeURIComponent(time)}`) +
          // maxTransfers=5 kappt absurde Pareto-Odysseen (6+ Umstiege quer
          // durchs Regionalnetz), die die DB nie zeigt — legitime grenz-
          // überschreitende+lokale Routen brauchen max. ~3-4 Umstiege.
          `&transitModes=${encodeURIComponent(transitModes)}&numItineraries=6&maxTransfers=5&detailedTransfers=false`;
        const raw = (await motisFetch(url, signal)) as {
          itineraries?: MotisItinerary[];
          nextPageCursor?: string;
        };
        const fresh: CachedPlan = {
          itineraries: raw.itineraries ?? [],
          nextPageCursor: raw.nextPageCursor,
        };
        planCache.set(key, fresh);
        return fresh;
      };

      let outbound: CachedPlan;
      // Rückfahrt: bisher las NUR dbVendo `returnDate` — und der ist von der DB
      // geblockt. „Hin & Rück" lieferte damit gar keine Rückfahrt, der
      // Richtungs-Umschalter erschien nie. Jetzt routet MOTIS die Gegenrichtung
      // gleich mit (nur bei der ersten Seite — beim „Später"-Blättern gilt der
      // Cursor der Hinfahrt).
      let inbound: CachedPlan | null = null;
      try {
        const cursor = input.paginationToken;
        outbound = await plan(from, to, searchStartFor(input), cursor);
        if (input.returnDate && !cursor) {
          inbound = await plan(to, from, startForDate(input.returnDate));
        }
      } catch (e) {
        return empty(start, { error: "motis_plan_failed", message: e instanceof Error ? e.message : String(e) });
      }

      const results = dropReferenceDuplicates(outbound.itineraries)
        .map((it, i) => toNormalized(it, input, from!, to!, i, mode))
        .filter((r): r is NormalizedResult => r !== null);

      if (inbound) {
        // Für die Rückfahrt sind Start/Ziel vertauscht — sonst trüge sie die
        // Labels der Hinfahrt.
        const back: ProviderSearchInput = {
          ...input,
          origin: input.destination,
          destination: input.origin,
          originLabel: input.destLabel,
          destLabel: input.originLabel,
          departDate: input.returnDate!,
          departTime: undefined,
        };
        const returnResults = dropReferenceDuplicates(inbound.itineraries)
          .map((it, i) => toNormalized(it, back, to!, from!, i, mode))
          .filter((r): r is NormalizedResult => r !== null)
          .map((r) => ({ ...r, direction: "RETURN" as const }));
        results.push(...returnResults);
      }

      return {
        results,
        // „Später"-Blättern: der Client schickt den Cursor beim nächsten Call
        // zurück. So kommt der User billig durch den Tag, ohne dass wir ein
        // teures 24h-Fenster anfragen müssen.
        paginationToken: outbound.nextPageCursor,
        raw: { source: name, from: from.id, to: to.id, count: results.length },
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
