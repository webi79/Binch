import { config } from "../config.js";
import { stationNameCompatible, normStationName } from "../util/stationName.js";
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
export async function motisGeocode(label: string, signal?: AbortSignal): Promise<MotisPlace | null> {
  const key = label.trim().toLowerCase();
  if (!key) return null;
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  let place: MotisPlace | null = null;
  try {
    const raw = await geocodeRaw(label, signal);
    if (raw.length > 0) {
      const stop = raw.find((r) => r.type === "STOP" && stationNameCompatible(label, r.name));
      const hit = stop ?? raw[0]!;
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
}

async function geocodeRaw(label: string, signal?: AbortSignal): Promise<GeocodeHit[]> {
  const raw = (await motisFetch(
    `/v1/geocode?text=${encodeURIComponent(label)}`,
    signal,
  )) as GeocodeHit[];
  return Array.isArray(raw) ? raw : [];
}

/**
 * Erster STOP-Treffer, ohne Namensprüfung — der alte Weg.
 *
 * Nur für Abfahrtstafeln: `/v6/stoptimes` braucht zwingend eine Stop-ID, eine
 * Koordinate hilft dort nicht. Lieber eine Tafel vom ähnlichsten Halt als gar
 * keine. Fürs ROUTING niemals verwenden — dafür ist motisGeocode zuständig.
 */
export async function motisGeocodeAnyStop(
  label: string,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  if (!label.trim()) return null;
  try {
    const raw = await geocodeRaw(label, signal);
    const hit = raw.find((r) => r.type === "STOP");
    if (!hit?.id) return null;
    return { id: hit.id, name: hit.name ?? label, lat: hit.lat, lon: hit.lon, tz: hit.tz, type: hit.type };
  } catch {
    return null;
  }
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
function isReferenceFeed(id: string): boolean {
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
    if (isReferenceFeed(r.id)) continue;

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
