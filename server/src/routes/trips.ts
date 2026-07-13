import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { getMotisTripPolyline, motisFetch } from "../services/motisClient.js";
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
  // MOTIS-tripIds (Format YYYYMMDD_HH:MM_<feed>_<num>) → Geometrie direkt von
  // MOTIS (precision-6-Polyline).
  if (/^\d{8}_\d{2}:\d{2}_/.test(tripId)) {
    return getMotisTripPolyline(tripId);
  }
  // HAFAS-tripIds (2|#VN#...) kommen von dbweb (bahn.de-Routen) → gegen den
  // dbweb-Sidecar (int.bahn.de, UNBLOCKIERT), NICHT den geblockten db-Container.
  // Response-Format identisch (GeoJSON features[].geometry.coordinates=[lng,lat]).
  const url = `${config.DBWEB_BASE_URL}/trips/${encodeURIComponent(tripId)}?polyline=true&stopovers=false`;
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
    arrivalPlatform: s.scheduledTrack ?? s.track,
    departurePlatform: s.scheduledTrack ?? s.track,
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
  fromStopLabel: string | undefined,
  fromStopLat: number | undefined,
  fromStopLng: number | undefined,
  boardDirection: string | undefined,
  profile: HafasProfileKey,
): Promise<TripDetailResponse | null> {
  const trip = await fetchTripBody(profile, tripId);
  if (!trip) return null;

  // Raw stopovers aus HAFAS — beinhaltet IMMER origin + alle Zwischenhalte +
  // destination (alle Stops chronologisch). Daraus bauen wir die User-zentrierte
  // Slice unten.
  const rawStops = trip.stopovers ?? [];

  // Slice die Stop-Liste auf den User-Halt (Beispiel: Bus 245 fährt 17:56→18:34,
  // User steigt um 18:08 ein → wir wollen 18:08→18:34 anzeigen, nicht die volle
  // Linie inklusive der Stops vor dem User). Mehrere Match-Strategien probiert,
  // weil HAFAS-IDs zwischen Stop-Board und Trip-Stopovers nicht immer 1:1
  // matchen (Stops haben oft Station-vs-Platform-Hierarchie):
  //   1. Exakter Stop-ID-Match
  //   2. ID-Prefix-Match (parent_station vs platform_id Variation)
  //   3. Name-Match (fuzzy, lowercase) — case der User-Stop kein hafas_id hat
  //      oder die IDs einfach nicht übereinstimmen (passiert bei Berlin BVG-
  //      Bus-Stops wo VBB-IDs anders sind als BVG-Trip-IDs)
  // Common city-name-Varianten zwischen englisch (in unseren GTFS-Labels)
  // und deutsch (in HAFAS-Trip-Bodies). Müssen normalisiert werden sonst
  // matched „Munich Chiemgaustraße" nicht „München, Chiemgaustraße".
  const cityAliases: Record<string, string> = {
    munich: "münchen",
    cologne: "köln",
    vienna: "wien",
    nuremberg: "nürnberg",
    geneva: "genf",
    zurich: "zürich",
    prague: "prag",
    warsaw: "warschau",
    // „Hauptbahnhof" → „hbf" damit beide Schreibweisen denselben Token
    // erzeugen. Praxis-Bug: User-Label „Berlin Hbf" tokenized zu [berlin, hbf],
    // HAFAS-Trip-Stop „Berlin Hauptbahnhof" → ohne Alias zu [berlin, …] und
    // matched nicht — wir landen stattdessen auf „Berlin Mahlsdorf" das auch
    // „berlin" hat aber 22 km woanders ist.
    hauptbahnhof: "hbf",
  };
  // Tokenizer: lowercase, Sonderzeichen (inkl. Bindestriche, Slashes, Punkte)
  // zu Whitespace, in Wörter splitten, City-Aliase normalisieren.
  // Bindestriche MÜSSEN gesplittet werden — sonst wird „Hamm-Westtünnen" zu
  // einem einzigen Token „hamm-westtünnen" der weder „hamm" noch „westtünnen"
  // matched. Praxis-Bug: User tippte „Hamm Westtünnen Bahnhof" im Surroundings,
  // Trip-Stops hatten „Hamm-Westtünnen" — kein Match → falscher Slice-Start.
  // Stop-Words wie „bahnhof"/„station" filtern wir weg sonst pollen sie die
  // Match-Scores: „Hessen Bahnhof Hamm Westf" hätte sonst auf {hamm, bahnhof}
  // = 2 Tokens gematched obwohl Bahnhof ein Generic-Qualifier ist.
  // ABER: „Hbf" / „Hauptbahnhof" BEHALTEN wir als Token — die sind so spezifisch
  // dass sie zwischen sub-Stops in einer Stadt unterscheiden (Berlin Hbf vs
  // Berlin Mahlsdorf). Via cityAliases werden die zwei Schreibweisen unifiziert.
  const STOP_WORDS = new Set([
    "bahnhof", "bahnhst", "bahnsteig", "bahnsteige",
    "station", "stop", "stops", "haltestelle", "halt",
    "gleis", "platform", "platt",
    // DB-/regional-Qualifier („Hamm Westf", „Bad Münster a Stein")
    "westf", "westfalen", "westfälisch",
    // Generische Straßen-/Wege-/Brücken-Bezeichner — zu unscharf um zwischen
    // Stops zu unterscheiden. Praxis-Bug: „Tegeler Weg/Jungfernheide" matched
    // fälschlich „Gandenitzer Weg, Berlin" auf {weg, berlin} = 2 Tokens und
    // gewinnt damit den ersten Iterations-Slot, „Jungfernheide Bahnhof"
    // verliert via > statt >=.
    "weg", "wege",
    "str", "straße", "strasse",
    "brücke", "brucke",
    "platz",
    "allee",
    "gasse",
    "ring",
    "ufer",
  ]);
  const tokenize = (s: string): string[] => {
    const cleaned = s.toLowerCase().replace(/[,()./\-]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned
      .split(" ")
      .map((w) => cityAliases[w] ?? w)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  };

  // Haversine in Metern — für den Coord-Fallback unten. Ein bisschen
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

  let startIdx = 0;
  if (fromStopId) {
    const idx = rawStops.findIndex((s) => s.stop?.id === fromStopId);
    if (idx >= 0) startIdx = idx;
    else {
      // Prefix-Match: trip-stops könnten Platform-IDs sein (parentId + Suffix)
      const idx2 = rawStops.findIndex((s) => s.stop?.id?.startsWith(fromStopId + ":")
        || (s.stop?.id && fromStopId.startsWith(s.stop.id + ":")));
      if (idx2 >= 0) startIdx = idx2;
    }
  }
  // Coord-Match (PRIMARY-SIGNAL wenn beide Coords vorhanden): finde den
  // Trip-Stop der am nächsten zu unseren DB-Coords liegt. Token-Match
  // unten ist ein guter Fallback, scheitert aber bei generischen Namen.
  // Coords sind zuverlässig weil Bus-/Bahn-Stops geographisch eindeutig
  // sind. Schwelle 500 m: HAFAS-Trip-Bodies enthalten oft nicht JEDEN
  // physischen Stop sondern nur die wichtigsten (z.B. M21 listet
  // „Jungfernheide Bahnhof" aber nicht „Tegeler Weg" 360m daneben — der
  // User steht aber an Tegeler Weg). 500m fängt diesen Fall und ist eng
  // genug um nicht zwischen 2 echten Stops zu verwechseln (urban inter-
  // stop-distance liegt typisch 200-500m).
  if (startIdx === 0 && fromStopLat != null && fromStopLng != null) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rawStops.length; i++) {
      const loc = rawStops[i]!.stop?.location;
      if (!loc || loc.latitude == null || loc.longitude == null) continue;
      const d = haversineMeters(fromStopLat, fromStopLng, loc.latitude, loc.longitude);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestDist <= 500) startIdx = bestIdx;
  }
  if (startIdx === 0 && fromStopLabel) {
    // Token-Set-Match: wir vergleichen distinktive Wörter, nicht Substrings.
    // Beispiel: User-Label "Munich Chiemgaustraße" → tokens [munich→münchen,
    // chiemgaustraße]. HAFAS-Stop "München, Chiemgaustraße" → tokens [münchen,
    // chiemgaustraße]. Beide haben dieselbe Token-Menge → Match.
    // Robust gegen Sprache (DE/EN-Stadtnamen) und Format-Variationen
    // (Komma vs. Klammer-Klammer-Format).
    const wantedTokens = new Set(tokenize(fromStopLabel));
    if (wantedTokens.size > 0) {
      // Bester Match = meiste überlappende Tokens. Bei Gleichstand: erster
      // im Trip (kommt früher).
      let bestIdx = -1;
      let bestOverlap = 0;
      for (let i = 0; i < rawStops.length; i++) {
        const name = rawStops[i]!.stop?.name;
        if (!name) continue;
        const stopTokens = tokenize(name);
        let overlap = 0;
        for (const tok of stopTokens) if (wantedTokens.has(tok)) overlap++;
        // Mindestens 1 token muss überlappen UND es muss ein "wirklicher"
        // Match sein (nicht nur ein zufälliges "münchen" das in 100 Stops
        // vorkommt). Wir verlangen Overlap >= min(2, wantedTokens.size) — also
        // bei kurzen Labels (1 Token) reicht 1, bei längeren mind. 2.
        const required = Math.min(2, wantedTokens.size);
        if (overlap >= required && overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) startIdx = bestIdx;
    }
  }
  // END-Slice auf die Board-Richtung: bei RINGLINIEN (Start=Ende, z.B. C1 in
  // Werl: Bahnhof→…→Justus-Liebig-Platz→…→Bahnhof) und generell wenn der
  // Headsign NICHT die Endstation ist, ist der operative letzte Halt (Werl
  // Bahnhof) ein ANDERER Ort als wohin der User laut Board fährt (Justus-
  // Liebig-Platz). Ohne End-Slice zeigte der Header das Richtungs-Label, aber
  // die Ziel-Koordinaten wären die der Endstation → Marker an falscher Stelle.
  // Wir suchen die Board-Richtungs-Haltestelle AB dem User-Halt und schneiden
  // dort ab. Gleiche Token-Match-Logik wie beim Start-Slice.
  let endIdx = rawStops.length - 1;
  let endMatched = false;
  if (boardDirection?.trim()) {
    const wanted = new Set(tokenize(boardDirection));
    if (wanted.size > 0) {
      let bestIdx = -1;
      let bestOverlap = 0;
      for (let i = startIdx + 1; i < rawStops.length; i++) {
        const name = rawStops[i]!.stop?.name;
        if (!name) continue;
        let overlap = 0;
        for (const tok of tokenize(name)) if (wanted.has(tok)) overlap++;
        const required = Math.min(2, wanted.size);
        if (overlap >= required && overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = i;
        }
      }
      if (bestIdx > startIdx) {
        endIdx = bestIdx;
        endMatched = true;
      }
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
  // destinationName: bevorzugt `trip.direction` (der Headsign-Name den der
  // User auf dem Bus-Display sieht — z.B. „S+U Pankow"), nicht der operative
  // letzte Halt (z.B. „Hadlichstr." wo die M27 nur wendet). Der User wählt
  // den Bus nach Headsign aus, das soll konsistent in der Trip-Detail-Header
  // sein. Stop-Liste selbst zeigt unverändert ALLE realen Stops bis zum
  // technischen Endhalt.
  // WICHTIG: Label MUSS zu den Ziel-Koordinaten (lastStop) passen, sonst sitzt
  // der Marker falsch. Wenn der End-Slice die Board-Richtungs-Haltestelle
  // gefunden hat, ist lastStop genau dieser Halt → Board-Direction als Label ok
  // (schöner, ohne „Werl,"-Präfix). Wenn NICHT gefunden, ist lastStop die echte
  // Endstation → dann deren Namen nehmen (nicht den Headsign, der woanders
  // liegt), damit Label und Koordinaten konsistent bleiben.
  const destinationName =
    (endMatched ? boardDirection?.trim() : undefined) ??
    lastStop.stop?.name ??
    trip.direction?.trim() ??
    trip.destination?.name ??
    boardDirection?.trim() ??
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
    // Stop-Coords aus unserer DB — werden im Slice-Match als Coord-Primary-
    // Signal benutzt. Geographische Match-Strategie ist robuster als Namens-
    // Tokens (Praxis-Bug: User-Stop „Kolschitzkygasse" matched nichts im
    // Trip-Body weil HAFAS andere Schreibweise nutzt → wir landen auf dem
    // Trip-Start „Wien Liesing Bahnhof" statt Kolschitzkygasse).
    let stopLat: number | undefined;
    let stopLng: number | undefined;
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
      stopLat = r?.latitude != null ? Number(r.latitude) : undefined;
      stopLng = r?.longitude != null ? Number(r.longitude) : undefined;
      profile =
        profileForStop({
          code: parsed.data.stopCode,
          country: r?.country ?? null,
          latitude: stopLat ?? null,
          longitude: stopLng ?? null,
        }) || "db";
    }
    const detail = await fetchTripDetail(
      parsed.data.tripId,
      parsed.data.fromStopId,
      parsed.data.fromStopLabel,
      stopLat,
      stopLng,
      parsed.data.direction,
      profile,
    );
    if (!detail) {
      return reply.code(404).send({ error: "Trip not found" });
    }
    return detail;
  });
}
