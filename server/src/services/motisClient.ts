import { config } from "../config.js";
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

/** Freitext-Label → MOTIS-Stop (bevorzugt type STOP). Gecacht. */
export async function motisGeocode(label: string, signal?: AbortSignal): Promise<MotisPlace | null> {
  const key = label.trim().toLowerCase();
  if (!key) return null;
  const cached = geocodeCache.get(key);
  if (cached !== undefined) return cached;

  let place: MotisPlace | null = null;
  try {
    const raw = (await motisFetch(
      `/v1/geocode?text=${encodeURIComponent(label)}`,
      signal,
    )) as Array<{ type?: string; id?: string; name?: string; lat?: number; lon?: number; tz?: string }>;
    if (Array.isArray(raw) && raw.length > 0) {
      const hit = raw.find((r) => r.type === "STOP") ?? raw[0];
      if (hit?.id) {
        place = { id: hit.id, name: hit.name ?? label, lat: hit.lat, lon: hit.lon, tz: hit.tz };
      }
    }
  } catch {
    // Geocode-Fehler nicht cachen (könnte transient sein) → früh raus.
    return null;
  }
  geocodeCache.set(key, place);
  return place;
}
