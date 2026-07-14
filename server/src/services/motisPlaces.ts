import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { motisGeocode, motisGeocodeNearestStop, type MotisPlace } from "./motisClient.js";

/**
 * Binch-`code` → MOTIS-Place. EINE Auflösung für alle Verbraucher (Such-Provider
 * UND Abfahrtstafeln).
 *
 * Warum geteilt: Die Suche und die Stop-Boards hatten je eine eigene Auflösung.
 * Die Suche wies den `at-Railway-Current-Reference-Data`-Feed zurück (Dubletten
 * ohne Gleise), die Tafeln nicht — sie nahmen über `motisGeocode` schlicht den
 * ERSTEN STOP. Für „Köln Hbf" ist das ein Referenz-Bahnsteig-Knoten, an dem
 * Stadtbahn-Halte mit hängen: die Tafel zeigte dann „Gleis 86" (eine
 * Stadtbahn-Gleisnummer) und bei den echten Zügen gar keins. Ein Fix an einer
 * Stelle muss beide erreichen — darum hier zentral.
 *
 * Auflösungs-Kette:
 *   1. Exakte Stop-ID: Label geocoden, den STOP nehmen, der unserer
 *      gespeicherten Koordinate am nächsten liegt (verwirft Referenz-Feeds und
 *      verlangt Namensgleichheit).
 *   2. Sonst die Koordinate selbst (`lat,lng`) — MOTIS snappt dann auf den
 *      tatsächlich bedienten Halt.
 *   3. Gar keine Koordinate → reines Label-Geocoding.
 *
 * So gibt es nie 0 Ergebnisse, nur weil der Geocoder danebengreift.
 */

// code → MOTIS-Place. Mapping ist stabil → 24 h.
const placeCache = new BoundedTtlCache<MotisPlace | null>(2000, 24 * 60 * 60 * 1000);

/** `lat,lng`-Platzhalter statt echter Stop-ID? */
function isCoordId(id: string): boolean {
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(id);
}

/**
 * Wie {@link resolveMotisPlace}, aber garantiert eine echte STOP-ID.
 *
 * Nötig für `/v6/stoptimes` (Abfahrtstafeln): der Endpoint akzeptiert nur eine
 * Stop-ID, keine Koordinate. Findet die strenge Auflösung keinen kanonischen
 * Stop (bei großen Bahnhöfen gibt der Transitous-Geocoder oft nur Referenzdaten-
 * Knoten her), fällt sie auf die Koordinate zurück — die wäre hier wertlos und
 * die Tafel bliebe LEER. Dann lieber irgendeinen Geocode-Treffer nehmen: eine
 * Tafel mit unsauberen Gleisangaben ist immer noch besser als keine.
 */
export async function resolveMotisStopId(
  code: string,
  label?: string,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  const place = await resolveMotisPlace(code, label, signal);
  if (place && !isCoordId(place.id)) return place;
  if (!label) return null;
  return motisGeocode(label, signal);
}

export async function resolveMotisPlace(
  code: string,
  label?: string,
  signal?: AbortSignal,
): Promise<MotisPlace | null> {
  const cached = placeCache.get(code);
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

  // Unser DB-Name gewinnt vor dem mitgeschickten Label: der Client kann ein
  // veraltetes Label zu einem Code halten (Recents/Vorschläge).
  const name = dbLabel ?? label;
  let place: MotisPlace | null = null;

  if (name && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = await motisGeocodeNearestStop(name, lat, lng, 400, signal);
  }
  if (!place && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = { id: `${lat},${lng}`, name: name ?? code, lat, lon: lng };
  }
  if (!place && name) {
    place = await motisGeocode(name, signal);
  }

  placeCache.set(code, place);
  return place;
}
