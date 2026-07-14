import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import {
  isReferenceFeedId,
  motisFetch,
  motisGeocode,
  motisGeocodeAnyStop,
  motisGeocodeNearestStop,
  type MotisPlace,
} from "./motisClient.js";

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

/**
 * ISO-Land aus dem Binch-Code.
 *
 * Unsere kuratierten Städte-Einträge tragen es im Code: `FR-PAR`, `DE-MUC`,
 * `IT-ROM` — geprüft, das gilt für ALLE (0 Ausnahmen). Genau diese Einträge haben
 * KEINE Koordinaten, können also nicht über die Distanz disambiguiert werden. Das
 * Land ist dort die einzige Handhabe — und ohne sie löste „Paris" auf einen
 * gleichnamigen Halt in RIO DE JANEIRO auf (München → Paris: 0 Ergebnisse).
 */
function isoFromCode(code: string): string | undefined {
  const m = /^([A-Z]{2})-/.exec(code);
  return m ? m[1] : undefined;
}

/** `lat,lng`-Platzhalter statt echter Stop-ID? */
function isCoordId(id: string): boolean {
  return /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(id);
}

/** Schienen-Modi — Tram/Bus/U-Bahn zählen bei der Knoten-Entdeckung NICHT mit,
 *  sonst landet man auf der Straßenbahnhaltestelle vor dem Bahnhof. */
const RAIL_MODES = new Set([
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "REGIONAL_RAIL",
  "REGIONAL_FAST_RAIL",
  "SUBURBAN",
]);

/**
 * Kanonischen Schienen-Knoten aus der Abfahrtstafel eines beliebigen Seed-Stops
 * herauslesen. Die stopTimes tragen `place.stopId` des TATSÄCHLICH bedienten
 * Halts — auch wenn der Seed ein Referenzdaten-Knoten war.
 *
 * Beispiel: Seed = at-Railway-…_de:09162:100:7:72 (Referenz, keine Gleise)
 *           → stopTimes enthalten de-DELFI_de:09162:100:11:11
 *           → gekürzt auf den Eltern-Knoten: de-DELFI_de:09162:100
 */
async function discoverRailStopId(seedStopId: string, signal?: AbortSignal): Promise<string | null> {
  let raw: { stopTimes?: Array<{ mode?: string; place?: { stopId?: string } }> };
  try {
    raw = (await motisFetch(
      `/v1/stoptimes?stopId=${encodeURIComponent(seedStopId)}&n=50`,
      signal,
    )) as typeof raw;
  } catch {
    return null;
  }

  const counts = new Map<string, number>();
  for (const st of raw.stopTimes ?? []) {
    if (!st.mode || !RAIL_MODES.has(st.mode)) continue;
    const id = st.place?.stopId;
    if (!id || /reference-data/i.test(id)) continue;

    // "<feed>_<dhid>" → Eltern-Knoten = Feed + die ersten drei DHID-Segmente
    // (de:AGS:Halt bzw. at:Region:Halt). Die weiteren Segmente sind
    // Bereich/Bahnsteig.
    const sep = id.indexOf("_");
    if (sep < 0) continue;
    const feed = id.slice(0, sep);
    const parts = id.slice(sep + 1).split(":");
    if (parts.length < 3) continue;
    const trimmed = parts.slice(0, 3);

    // GUARD: Das Kürzen auf drei Segmente gilt NUR für DHID-artige IDs. Schweizer
    // sloids sehen anders aus („ch:1:sloid:3000:0:1") — dort schnitte man mitten
    // im Bezeichner ab und bekäme „ch:1:sloid", einen unbrauchbaren Knoten.
    // Genau das hat Zürich HB → Brunau auf 0 Ergebnisse gesetzt. Das letzte
    // Segment eines echten Halt-Bezeichners ist numerisch — daran erkennen wir es.
    if (!/^\d+$/.test(trimmed[2]!)) continue;

    const base = `${feed}_${trimmed.join(":")}`;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of counts) {
    if (n > bestCount) {
      bestCount = n;
      best = id;
    }
  }
  return best;
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
  if (place && !isCoordId(place.id) && place.type !== "PLACE") return place;
  if (!label) return null;
  // motisGeocodeAnyStop statt motisGeocode: Die Tafel BRAUCHT eine Stop-ID, und
  // motisGeocode gibt inzwischen bewusst auch Nicht-Halte zurück (Stadt-PLACE),
  // mit denen /v6/stoptimes nichts anfangen kann → die Tafel bliebe leer.
  return motisGeocodeAnyStop(label, signal);
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
  const iso = isoFromCode(code);
  let place: MotisPlace | null = null;

  // 1) Geocoder — funktioniert für Stops, die er kanonisch kennt (z.B. Schweiz).
  if (name && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = await motisGeocodeNearestStop(name, lat, lng, 400, signal);
  }

  // 2) ENTDECKUNG über die Abfahrtstafel.
  //    (Der Seed muss ein echter STOP sein — eine Stadt/Adresse hat keine
  //    stopTimes, die Entdeckung liefe ins Leere.)
  //
  // Für große deutsche/österreichische Bahnhöfe gibt der Transitous-Geocoder NUR
  // den at-Railway-Referenzknoten her — und der trägt keine Gleise. Genau daher
  // kam die Beobachtung „die Abfahrtstafel hat Gleise, die Suche nie": die Tafel
  // fragt einen Knoten ab, der DELFI-Daten liefert, die Suche routete über die
  // Koordinate und snappte auf den Referenzknoten.
  //
  // Die Tafel verrät aber den kanonischen Knoten: in ihren stopTimes steht
  // `place.stopId` — z.B. de-DELFI_de:09162:100:11:11 für München Hbf. Wir nehmen
  // den häufigsten SCHIENEN-Knoten (Tram/Bus filtern wir raus, sonst landet man
  // auf der Straßenbahnhaltestelle davor) und kürzen ihn auf den Eltern-Knoten.
  //
  // Wirkung gemessen (München→Wien): 11/12 Legs mit Abfahrts-Gleis statt 5/12,
  // und „IC 63 ab München Hbf, Gleis 11" statt „RJX 63, Gleis —".
  let seed: MotisPlace | null = null;
  if (!place && name) {
    seed = await motisGeocode(name, signal, iso);
    if (seed && seed.type === "STOP") {
      const railId = await discoverRailStopId(seed.id, signal);
      if (railId) {
        place = {
          id: railId,
          name,
          lat: Number.isFinite(lat) ? lat : seed.lat,
          lon: Number.isFinite(lng) ? lng : seed.lon,
          tz: seed.tz,
          type: "STOP",
        };
      }
    }
  }

  // 3) Koordinate — MOTIS snappt selbst auf den bedienten Halt.
  if (!place && Number.isFinite(lat) && Number.isFinite(lng)) {
    place = { id: `${lat},${lng}`, name: name ?? code, lat, lon: lng };
  }

  // 4) Letzter Ausweg: der Geocode-Treffer von oben.
  //
  //    Ist er KEIN Halt (Stadt/Adresse — unsere `type=ALL`-Einträge wie IT-ROM
  //    „Roma Rom" haben gar keine Koordinate in der DB, landen also immer hier),
  //    dann darf seine ID NICHT ins Routing: `fromPlace=<place-id>` wäre kein
  //    Fahrplan-Knoten. Stattdessen über seine KOORDINATE routen — MOTIS sucht
  //    sich den bedienten Halt selbst. Sonst wurde aus „Rom" die U-Bahn-Station
  //    „Re di Roma".
  if (!place && seed) {
    // HIER gehören Referenz-Knoten abgefangen — als Routing-ZIEL bauen sie
    // Phantom-Fußwege zwischen zwei gleichnamigen Knoten ein („München
    // Hauptbahnhof → 8 min zu Fuß → München Hbf"). Beim GEOCODING dürfen sie
    // dagegen nicht fehlen, weil die Entdeckung oben sie als Startpunkt braucht.
    // Erreicht die Entdeckung sie nicht (kein Schienen-Knoten gefunden), routen
    // wir über ihre Koordinate — MOTIS snappt selbst auf den bedienten Halt.
    const unusable = isReferenceFeedId(seed.id) || seed.type !== "STOP";
    place =
      !unusable || seed.lat == null || seed.lon == null
        ? seed
        : { id: `${seed.lat},${seed.lon}`, name: seed.name, lat: seed.lat, lon: seed.lon, tz: seed.tz };
  }

  placeCache.set(code, place);
  return place;
}
