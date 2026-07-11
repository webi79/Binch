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
