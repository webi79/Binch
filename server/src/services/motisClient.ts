import { config } from "../config.js";
import { stationNameCompatible, normStationName, sameCity } from "../util/stationName.js";
import { BoundedTtlCache } from "../util/boundedCache.js";

/**
 * Geteilter MOTIS-HTTP-Client (Routing-Provider UND Stop-Board nutzen ihn).
 * Basis-URL aus config.MOTIS_BASE_URL (Übergang: Transitous; später eigene
 * self-hosted Instanz per Env-Flip). Identifizierender User-Agent = guter
 * Bürger ggü. dem Volunteer-Dienst.
 */

const UA = "binch-mobile/0.1 (train routing via MOTIS)";

export interface MotisPlace {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
  tz?: string;
  /** MOTIS-Treffertyp. "STOP" = echter Halt (als Routing-Ziel verwendbar);
   *  "PLACE"/"ADDRESS" = Ort ohne Fahrplan → nur über die Koordinate routen. */
  type?: string;
}

// Label → aufgelöster MOTIS-Stop. Mapping ist stabil → 24h.
const geocodeCache = new BoundedTtlCache<MotisPlace | null>(2000, 24 * 60 * 60 * 1000);

export async function motisFetch(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${config.MOTIS_BASE_URL}${path}`, {
    headers: { accept: "application/json", "user-agent": UA },
    signal,
  });
  if (!res.ok) throw new Error(`MOTIS ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Encoded-Polyline-Decoder (Google-Algorithmus). MOTIS nutzt precision 6
 * (nicht den Google-Standard 5!). Gibt [lng, lat]-Paare zurück (GeoJSON-/
 * MapLibre-Reihenfolge, identisch zum dbrest-Polyline-Endpoint).
 */
function decodePolyline(str: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  let index = 0;
  let lat = 0;
  let lng = 0;
  const out: [number, number][] = [];
  while (index < str.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

// tripId → dekodierte Polyline. Geometrie ist stabil → 6h Cache.
const tripPolyCache = new BoundedTtlCache<[number, number][] | null>(1000, 6 * 60 * 60 * 1000);

/**
 * Polyline eines Trips (alle Legs konkateniert) via MOTIS `/v6/trip`. Ersetzt
 * den geblockten dbrest-`/trips/{id}?polyline=true`-Weg für MOTIS-Trips.
 */
export async function getMotisTripPolyline(
  tripId: string,
  signal?: AbortSignal,
): Promise<[number, number][] | null> {
  const cached = tripPolyCache.get(tripId);
  if (cached !== undefined) return cached;

  let coords: [number, number][] | null = null;
  try {
    const raw = (await motisFetch(
      `/v6/trip?tripId=${encodeURIComponent(tripId)}`,
      signal,
    )) as { legs?: Array<{ legGeometry?: { points?: string; precision?: number } }> };
    const all: [number, number][] = [];
    for (const leg of raw.legs ?? []) {
      const g = leg.legGeometry;
      if (g?.points) all.push(...decodePolyline(g.points, g.precision ?? 6));
    }
    coords = all.length > 1 ? all : null;
  } catch {
    coords = null;
  }
  tripPolyCache.set(tripId, coords);
  return coords;
}

/**
 * Freitext-Label → MOTIS-Treffer. Gecacht.
 *
 * WICHTIG: Wir nehmen NICHT mehr blind den ersten STOP. Vorher stand hier
 * `raw.find(r => r.type === "STOP") ?? raw[0]` — der Geocoder liefert seine
 * Treffer nach Relevanz sortiert, und wir haben ihn überstimmt, indem wir
 * unbedingt einen Halt erzwangen. Für „Roma Rom" (unser Stadt-Eintrag IT-ROM)
 * sah das so aus:
 *
 *     1. PLACE  Roma (Italia)          ← der richtige Treffer
 *     2. STOP   RE DI ROMA (Italia)    ← den nahmen wir
 *     3. PLACE  Roma (United States)
 *
 * „Re di Roma" ist eine U-Bahn-Station der Linie A. Wer Rom suchte, wurde also
 * dorthin geroutet statt nach Roma Termini. Dieselbe Fehlerfamilie wie
 * „Wien Hbf → Wien Blumental".
 *
 * Jetzt: Ein STOP gewinnt nur, wenn sein Name zum gesuchten passt. Sonst der
 * relevanteste Treffer — bei Städten der PLACE, dessen Koordinate der Aufrufer
 * zum Routen benutzt (MOTIS snappt selbst auf den bedienten Halt).
 */
export async function motisGeocode(
  label: string,
  signal?: AbortSignal,
  /** ISO-3166-alpha2 des erwarteten Landes. Siehe unten — ohne das landet „Paris"
   *  in Brasilien. */
  country?: string,
): Promise<MotisPlace | null> {
  const key = `${label.trim().toLowerCase()}|${country ?? ""}`;
  if (!label.trim()) return null;
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  let place: MotisPlace | null = null;
  try {
    let raw = await geocodeRaw(label, signal);

    // LÄNDER-FILTER — der wichtigste Teil dieser Funktion.
    //
    // Der Geocoder sortiert nach seinem eigenen Score, und der greift daneben:
    //   „Paris"  → 1. STOP „Paris ,  -"  [BR]   ← Rio de Janeiro!
    //              2. STOP „Paris Est"   [FR]
    //              4. PLACE „Paris"      [FR]
    //
    // Die Namensprüfung rettet hier NICHT: Der brasilianische Halt heißt wirklich
    // „Paris". Gemessen hat uns das eine Zug-Suche München → Paris zerstört —
    // MOTIS routete von einem Referenz-Knoten nach RIO DE JANEIRO und lieferte
    // folgerichtig 0 Ergebnisse.
    //
    // Wir kennen aber das Land des gesuchten Ortes (siehe motisPlaces). Treffer
    // aus anderen Ländern fliegen raus. Bleibt nichts übrig, suchen wir ohne
    // Filter weiter — lieber ein unsicherer Treffer als gar keiner.
    if (country) {
      const inCountry = raw.filter((r) => r.country?.toUpperCase() === country.toUpperCase());
      if (inCountry.length > 0) raw = inCountry;
    }

    // ACHTUNG: Referenzdaten-Feeds hier NICHT herausfiltern.
    //
    // Verlockend ist es (als ROUTING-ZIEL sind sie Gift, siehe isReferenceFeed),
    // aber der Transitous-Geocoder kennt große Bahnhöfe NUR als Referenz-Knoten:
    //     „München Hbf" → at-Railway-Current-Reference-Data-2026_de:09162:100:11:11
    // Genau dafür gibt es die Knoten-Entdeckung in motisPlaces, die daraus den
    // kanonischen DELFI-Knoten macht. Filtert man sie schon hier weg, nimmt man
    // ihr den Startpunkt — im Test blieb für „München" der FLUGHAFEN übrig.
    // Verworfen werden sie erst dort, wo sie tatsächlich Ziel würden.
    if (raw.length > 0) {
      // Unter den namensverträglichen Halten den WICHTIGSTEN nehmen, nicht den
      // erstbesten.
      //
      // Vorher gewann für die Stadt „München" der Halt „München Ost" — schlicht
      // weil „münchen" ein Präfix davon ist und er zufällig oben stand. MOTIS
      // liefert aber ein Wichtigkeits-Maß mit:
      //     München Hbf 0.377 · Flughafen 0.025 · München Ost 0.017
      // Damit landet man dort, wo der User hinwollte.
      //
      // KEIN Vorrang für exakte Namensgleichheit — das war ein Reinfall: Es gibt
      // einen Bushalt, der schlicht „München" heißt (im Landkreis Ebersberg,
      // de:09178:3240). Als exakter Treffer verdrängte er den Hauptbahnhof.
      // Die Namensprüfung engt bereits auf die richtige Stadt ein; innerhalb
      // dieser Menge entscheidet allein die Wichtigkeit — und ein Dorfhalt hat
      // sie nicht.
      //
      // „Werl, Rathaus" bleibt trotzdem heil: „Werl, Bahnhof" ist zu diesem
      // Suchbegriff gar nicht namensverträglich, konkurriert also nicht.
      //
      // Bewusst KEIN Ausweichen auf den Stadt-PLACE (Koordinate): MOTIS müsste
      // dann per Straßen-Routing einen Halt suchen — für München → Paris dauerte
      // das über 15 s und lief in den Provider-Timeout.
      const stops = raw.filter((r) => r.type === "STOP" && stationNameCompatible(label, r.name));
      const best = [...stops].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
      const hit = best ?? raw[0]!;
      if (hit.id) {
        place = {
          id: hit.id,
          name: hit.name ?? label,
          lat: hit.lat,
          lon: hit.lon,
          tz: hit.tz,
          type: hit.type,
        };
      }
    }
  } catch {
    // Geocode-Fehler nicht cachen (könnte transient sein) → früh raus.
    return null;
  }
  geocodeCache.set(key, place);
  return place;
}

interface GeocodeHit {
  type?: string;
  id?: string;
  name?: string;
  lat?: number;
  lon?: number;
  tz?: string;
  /** ISO-3166-alpha2 des Treffers ("FR", "BR", "DE"). Der Rettungsanker gegen
   *  gleichnamige Orte auf anderen Kontinenten. */
  country?: string;
  /** MOTIS' eigenes Wichtigkeits-Maß. München Hbf = 0.377, München Ost = 0.017 —
   *  damit trifft man den Hauptbahnhof statt irgendeines Halts der Stadt. */
  importance?: number;
}

async function geocodeRaw(label: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const raw = (await motisFetch(
    `/v1/geocode?text=${encodeURIComponent(label)}`,
    signal,
  )) as GeocodeHit[];
  return Array.isArray(raw) ? raw : [];
}

/** Grobe Distanz in Metern (equirectangular) — reicht für <10-km-Vergleiche. */
function approxMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Ein STOP innerhalb dieser Distanz zum Marker ist derselbe physische Halt
 *  (andere Schreibweise/Plattform-Knoten) — Name egal. */
const SAME_SPOT_M = 150;
/** Bis hierhin akzeptieren wir einen Halt nur bei verträglichem Namen —
 *  fängt „unser OSM-Marker vs. der 300 m entfernte Feed-Knoten des gleichen
 *  Bahnhofs". Urbane NACHBAR-Stops liegen typisch 200-500 m auseinander,
 *  tragen dann aber andere Namen → Token-Guard schützt. */
const SAME_STOP_NAMED_M = 600;

/**
 * Abfahrtstafel-Stop-Suche, DISTANZ-GEBUNDEN an unsere Marker-Koordinate.
 *
 * Früher stand hier motisGeocodeAnyStop — „erster STOP-Treffer, ohne
 * Namensprüfung, lieber eine Tafel vom ähnlichsten Halt als gar keine". Das
 * war die gefährlichste Zeile des Board-Pfads: Für Halte, die Transitous nicht
 * kennt (Murcia-Stadtbusse, „Estanco Quijero"), lieferte der Fuzzy-Geocoder
 * irgendeinen gleichnamigen Halt IRGENDWO — gemessen: Marker „Iglesia" bei
 * Murcia → Tafel von „IGLESIA" in Galicien, 700 km entfernt. Tafel, Trip-
 * Detail und Route waren dann konsistent falsch. Eine LEERE Tafel ist die
 * ehrliche Antwort; eine falsche ist die schlimmste.
 */
export async function motisGeocodeStopNear(
  label: string,
  refLat: number,
  refLng: number,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  if (!label.trim()) return null;
  // Transport-Fehler bewusst NICHT schlucken (wirft) — der Aufrufer darf ein
  // transientes MOTIS-Down nicht als „Stop existiert nicht" negativ cachen.
  const raw = await geocodeRaw(label, signal);
  let best: MotisPlace | null = null;
  let bestM = Infinity;
  for (const r of raw) {
    if (r.type !== "STOP" || !r.id || r.lat == null || r.lon == null) continue;
    const d = approxMeters(refLat, refLng, r.lat, r.lon);
    const limit = sameCity(label, r.name) || stationNameCompatible(label, r.name)
      ? SAME_STOP_NAMED_M
      : SAME_SPOT_M;
    if (d <= limit && d < bestM) {
      bestM = d;
      best = { id: r.id, name: r.name ?? label, lat: r.lat, lon: r.lon, tz: r.tz, type: r.type };
    }
  }
  return best;
}

/**
 * Nächster STOP an einer Koordinate via `/v1/reverse-geocode` — findet den
 * bedienten Halt auch dann, wenn sein Feed-Name mit unserem Marker-Label
 * nichts gemein hat (OSM-Label vs. GTFS-Name). Distanz-Deckel zwingend:
 * reverse-geocode liefert sonst auch km-weit entfernte Halte.
 */
export async function motisReverseGeocodeStop(
  lat: number,
  lng: number,
  maxMeters = SAME_SPOT_M,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  // Transport-Fehler wirft (siehe motisGeocodeStopNear) — kein Negativ-Cache
  // bei transientem MOTIS-Ausfall.
  const raw = (await motisFetch(
    `/v1/reverse-geocode?place=${lat},${lng}&type=STOP`,
    signal,
  )) as GeocodeHit[];
  if (!Array.isArray(raw)) return null;
  // Operative Feeds bevorzugen: Referenz-Knoten liefern Tafeln (ihre
  // stopTimes tragen den bedienten Halt), aber ohne saubere Gleisangaben.
  // Nur wenn im Radius NICHTS Operatives liegt, den Referenz-Knoten nehmen.
  let bestOp: MotisPlace | null = null;
  let bestOpM = Infinity;
  let bestRef: MotisPlace | null = null;
  let bestRefM = Infinity;
  for (const r of raw) {
    if (r.type !== "STOP" || !r.id || r.lat == null || r.lon == null) continue;
    const d = approxMeters(lat, lng, r.lat, r.lon);
    if (d > maxMeters) continue;
    const place: MotisPlace = { id: r.id, name: r.name ?? "", lat: r.lat, lon: r.lon, tz: r.tz, type: r.type };
    if (isReferenceFeedId(r.id)) {
      if (d < bestRefM) { bestRefM = d; bestRef = place; }
    } else if (d < bestOpM) {
      bestOpM = d;
      bestOp = place;
    }
  }
  return bestOp ?? bestRef;
}

/**
 * Koordinatenloser Rest-Fall (kuratierte Stadt-Codes ohne Coords): erster
 * STOP-Treffer, aber NUR mit namensverträglichem Treffer — der Fuzzy-Geocoder
 * darf aus „Estanco Quijero" kein „Estación de Autobuses" machen.
 */
export async function motisGeocodeStopSimilar(
  label: string,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  if (!label.trim()) return null;
  // Wirft bei Transport-Fehler (siehe motisGeocodeStopNear).
  const raw = await geocodeRaw(label, signal);
  const hit = raw.find(
    (r) => r.type === "STOP" && r.id
      && (stationNameCompatible(label, r.name) || sameCity(label, r.name)),
  );
  if (!hit?.id) return null;
  return { id: hit.id, name: hit.name ?? label, lat: hit.lat, lon: hit.lon, tz: hit.tz, type: hit.type };
}

/** Namensnormalisierung — eine Quelle für alle Provider, siehe util/stationName.ts.
 *  (Stand hier früher als eigene Kopie; zwei Kopien driften auseinander, und
 *  genau an so einem Vergleich hängt, ob wir den richtigen Bahnhof treffen.) */
const normName = normStationName;

/**
 * Feeds, die nur REFERENZDATEN enthalten (europaweite Bahnhofs-Dubletten), nicht
 * den operativen Fahrplan. Der Transitous-Geocoder liefert die gern als ersten
 * STOP-Treffer — sie liegen 100-200 m neben dem echten Bahnhof und werden von
 * MOTIS als eigener Knoten behandelt. Routet man dorthin, baut MOTIS einen
 * absurden Fußweg zwischen zwei gleichnamigen Knoten ein („München Hauptbahnhof
 * → 8 min zu Fuß → München Hbf"). Also nie als Routing-Endpunkt verwenden.
 */
export function isReferenceFeedId(id: string): boolean {
  return /reference-data/i.test(id.split("_")[0] ?? "");
}

/**
 * Wie {@link motisGeocode}, aber sucht den STOP, der WIRKLICH der gewählte Ort
 * ist: gleicher Name UND nah an der bekannten Koordinate UND aus einem operativen
 * Feed. Nur dann routen wir an die exakte Stop-ID — die Route endet dann genau am
 * gewählten Halt (z.B. Zürich Brunau statt am Nachbar-Stop Saalsporthalle).
 *
 * Gibt bewusst `null` zurück, sobald einer der Punkte nicht zweifelsfrei ist —
 * dann routet der Aufrufer über die Koordinate. Das ist der sichere Weg: MOTIS
 * snappt selbst auf den tatsächlich bedienten Halt. Nötig, weil der Geocoder für
 * große Bahnhöfe (München Hbf, Zürich HB) den kanonischen Knoten GAR NICHT
 * herausgibt — dort kämen sonst nur Referenz-Dubletten oder Tram-Halte in der
 * Nähe („Zürich, Sihlquai/HB") heraus.
 */
export async function motisGeocodeNearestStop(
  label: string,
  refLat: number,
  refLng: number,
  maxMeters = 400,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  if (!label.trim()) return null;
  let raw: Array<{ type?: string; id?: string; name?: string; lat?: number; lon?: number; tz?: string }>;
  try {
    raw = (await motisFetch(
      `/v1/geocode?text=${encodeURIComponent(label)}`,
      signal,
    )) as typeof raw;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;

  const want = normName(label);
  const cos = Math.cos((refLat * Math.PI) / 180);
  let best: MotisPlace | null = null;
  let bestM = Infinity;

  for (const r of raw) {
    if (r.type !== "STOP" || !r.id || !r.name || r.lat == null || r.lon == null) continue;
    if (isReferenceFeedId(r.id)) continue;

    // Name muss EXAKT der gewählte Ort sein (Abkürzungen aufgelöst). Bewusst
    // keine Teilstring-Toleranz: „Wien Hbf" hätte sonst auf „Wien Hauptbahnhof
    // OST" gematcht — ein anderer Halt, aus einem Feed ohne Gleisdaten. Wir
    // routeten dorthin, und dem User fehlte am Start das Gleis. Ein falsches
    // Routing-Ziel ist der teuerste Fehler hier; im Zweifel lieber `null` →
    // Koordinaten-Routing, bei dem MOTIS selbst den bedienten Halt trifft.
    if (normName(r.name) !== want) continue;

    const dy = (r.lat - refLat) * 111_000;
    const dx = (r.lon - refLng) * 111_000 * cos;
    const m = Math.sqrt(dx * dx + dy * dy);
    if (m < bestM) {
      bestM = m;
      best = { id: r.id, name: r.name, lat: r.lat, lon: r.lon, tz: r.tz };
    }
  }
  return bestM <= maxMeters ? best : null;
}
