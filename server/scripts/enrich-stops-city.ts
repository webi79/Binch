/**
 * Setzt für jeden Stop in `locations` das `city`-Feld auf den Namen der
 * zuständigen Gemeinde. So findet der Autocomplete-ILIKE auf `locations.city`
 * Stops auch über den administrativen Stadt-/Gemeindenamen — z.B.
 * „Anrath Bahnhof" → city="Willich" → Suche nach „Willich" findet ihn.
 *
 * Vorgehen (Reihenfolge der Stufen):
 *
 *   Stufe A — Stadt-Name im Label (administrative Wahrheit aus dem Label).
 *     Wenn das Stop-Label einen unserer city-Namen wörtlich enthält
 *     (z.B. „Willich Anrath Bf"), nehmen wir diese Stadt. Vermeidet Probleme
 *     wo der Ortsteil geografisch näher an einer Nachbargemeinde liegt
 *     (Anrath ist näher an Tönisvorst als an Willich, gehört aber zu Willich).
 *
 *   Stufe B — Admin-Hierarchie via nearest-place + admin4.
 *     1. Finde nächstgelegene Stadt/Gemeinde/Ortsteil (cities-Tabelle, alle
 *        feature_codes PPL*, PPLX) per Grid-Index.
 *     2. Hat sie einen admin4-Code, schauen wir den Gemeindesitz nach
 *        (PPLA4 mit gleichem admin1/2/3/4). Anrath (PPLX, admin4=05154004) →
 *        Willich (PPLA4, admin4=05154004) → Willich gewinnt.
 *     3. Ohne admin4 oder ohne PPLA4-Treffer: Name des nächstgelegenen Orts
 *        direkt benutzen (z.B. wenn die Stadt selbst ein PPL ist).
 *     Distanz-Limit: 20 km, sonst kein city-Eintrag (deutet auf fehlende
 *     GeoNames-Daten in dieser Region).
 *
 * Cities-Tabelle muss vorher gefüllt sein via:
 *   npm run import:admin-places:all   (alle 8 Länder)
 *
 * Idempotent: kann mehrfach laufen.
 */
import { isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities, locations } from "../src/db/schema.js";

const MAX_DISTANCE_M = 20_000;
const CHUNK = 2000;

interface CityPoint {
  geonameId: number;
  name: string;
  lat: number;
  lng: number;
  population: number;
  featureCode: string | null;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  admin4: string | null;
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Grid-Cell-Key bei 0.1°-Raster (~11 km bei mittleren Breitengraden). */
function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat * 10)},${Math.floor(lng * 10)}`;
}

/** Admin-Pfad-Key. Wird zur Lookup-Map für Gemeindesitze (PPLA4) genutzt. */
function adminKey(c: { admin1: string | null; admin2: string | null; admin3: string | null; admin4: string | null }): string | null {
  // admin4 ist das wichtigste Feld — ohne admin4 keine Hierarchie-Auflösung
  // möglich.
  if (!c.admin4) return null;
  return `${c.admin1 ?? ""}|${c.admin2 ?? ""}|${c.admin3 ?? ""}|${c.admin4}`;
}

async function main() {
  const t0 = Date.now();

  // 1. Cities laden + Grid-Index + Admin-Lookup aufbauen.
  console.log("[enrich-stops-city] loading cities…");
  const cityRows = await db
    .select({
      geonameId: cities.geonameId,
      name: cities.name,
      lat: cities.latitude,
      lng: cities.longitude,
      population: cities.population,
      featureCode: cities.featureCode,
      admin1: cities.admin1,
      admin2: cities.admin2,
      admin3: cities.admin3,
      admin4: cities.admin4,
    })
    .from(cities);
  console.log(`[enrich-stops-city]   ${cityRows.length} cities`);

  const grid = new Map<string, CityPoint[]>();
  const allPoints: CityPoint[] = [];
  for (const c of cityRows) {
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    const point: CityPoint = {
      geonameId: c.geonameId,
      name: c.name,
      lat,
      lng,
      population: c.population ?? 0,
      featureCode: c.featureCode,
      admin1: c.admin1,
      admin2: c.admin2,
      admin3: c.admin3,
      admin4: c.admin4,
    };
    allPoints.push(point);
    const key = cellKey(lat, lng);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(point);
  }

  // Gemeindesitz-Lookup: adminKey → PPLA4 (oder PPLA3/PPLA2/PPLA1 als Fallback).
  // Mehrere Kandidaten pro adminKey kann's geben — der mit höherer Priorität
  // gewinnt, bei gleicher Priorität der mit mehr Einwohnern.
  const seatPriority: Record<string, number> = {
    PPLA4: 100,
    PPLA3: 90,
    PPLA2: 80,
    PPLA: 70,
    PPLC: 60, // capital — selten für admin4 relevant, aber als Fallback ok
    PPLA5: 50,
    PPL: 10, // generic populated place — letzter Fallback
  };
  const seatByAdminKey = new Map<string, CityPoint>();
  for (const p of allPoints) {
    const k = adminKey(p);
    if (!k) continue;
    const myPrio = seatPriority[p.featureCode ?? ""] ?? 0;
    if (myPrio === 0) continue; // PPLX und unbekannte Codes nicht als Seat
    const existing = seatByAdminKey.get(k);
    if (!existing) {
      seatByAdminKey.set(k, p);
      continue;
    }
    const existPrio = seatPriority[existing.featureCode ?? ""] ?? 0;
    if (myPrio > existPrio) {
      seatByAdminKey.set(k, p);
    } else if (myPrio === existPrio && p.population > existing.population) {
      seatByAdminKey.set(k, p);
    }
  }
  console.log(`[enrich-stops-city]   ${seatByAdminKey.size} admin4-Gemeinden indexiert`);

  function nearestPlace(lat: number, lng: number): { place: CityPoint; dist: number } | null {
    const cy = Math.floor(lat * 10);
    const cx = Math.floor(lng * 10);
    let best: CityPoint | null = null;
    let bestDist = Infinity;
    // 3x3-Nachbarschaft scannen
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cy + dy},${cx + dx}`);
        if (!bucket) continue;
        for (const p of bucket) {
          const d = haversine(lat, lng, p.lat, p.lng);
          if (d < bestDist) {
            bestDist = d;
            best = p;
          }
        }
      }
    }
    if (!best || bestDist > MAX_DISTANCE_M) return null;
    return { place: best, dist: bestDist };
  }

  /** Gemeinde-Ebene: admin1/2/3 ohne admin4. In Italien der ISTAT-Gemeindecode. */
  function adminKey3(p: CityPoint): string | null {
    if (!p.admin1 || !p.admin2 || !p.admin3) return null;
    return `${p.admin1}|${p.admin2}|${p.admin3}`;
  }
  /**
   * Größter NICHT-Bezirk je Gemeinde-Kennung.
   *
   * Bezirke (`PPLX`) fallen raus — sonst gewänne in Rom wieder ein Rione.
   * Die Einwohnerzahl entscheidet, weil die Gemeinde selbst praktisch immer
   * der größte Eintrag ihrer eigenen Kennung ist.
   */
  const townByAdmin3 = new Map<string, CityPoint>();
  for (const p of allPoints) {
    if ((p.featureCode ?? "") === "PPLX") continue;
    const k = adminKey3(p);
    if (!k) continue;
    const prev = townByAdmin3.get(k);
    if (!prev || (p.population ?? 0) > (prev.population ?? 0)) townByAdmin3.set(k, p);
  }

  // Liefert für einen Place den Namen der zuständigen Gemeinde:
  //   - Wenn der Place selbst ein PPLA-*-/PPLC ist → eigener Name (er ist
  //     selbst der Gemeindesitz)
  //   - Wenn ein PPLX/PPL: über admin4 den PPLA4-Sitz nachschlagen
  //   - Fallback: eigener Name
  function municipalityFor(p: CityPoint): string {
    const fc = p.featureCode ?? "";
    // Selbst-Sitz → eigener Name ist die Gemeinde
    if (fc.startsWith("PPLA") || fc === "PPLC" || fc === "PPLG") return p.name;
    const k = adminKey(p);
    if (k) {
      const seat = seatByAdminKey.get(k);
      if (seat) return seat.name;
    }
    /**
     * Zweite Stufe: über admin3 (die GEMEINDE) statt admin4.
     *
     * Ohne diese Stufe bekamen Stops in Rom als Stadt „Campitelli", „Celio"
     * oder „Centro Storico" — das sind Rioni, also Stadtbezirke. Der Grund
     * steht in den Daten: Rom selbst ist ein `PPLC` mit admin3=058091 und
     * OHNE admin4; seine Rioni sind `PPLX` mit demselben admin3 und einem
     * eigenen admin4=05809101. Ein `PPLA4`-Gemeindesitz zu diesem admin4
     * existiert nicht, also blieb der Bezirksname stehen.
     *
     * In Italien ist admin3 der ISTAT-Code der Gemeinde — alle Rioni Roms
     * teilen ihn mit Rom. Dasselbe Muster tragen andere Großstädte mit
     * Bezirksgliederung. Gesucht wird deshalb der größte Ort mit derselben
     * admin1/2/3-Kennung, der selbst kein Bezirk ist; das ist verlässlich die
     * Gemeinde.
     *
     * Ohne Wirkung, wo Stufe 1 schon greift (Deutschland, Österreich): Dort
     * gibt es die PPLA4-Sitze, und die werden oben gefunden.
     */
    const k3 = adminKey3(p);
    if (k3) {
      const town = townByAdmin3.get(k3);
      if (town) return town.name;
    }
    return p.name;
  }

  // Lookup-Index für Stadt-Namen im Stop-Label. Nur PPLA*/PPLC — also echte
  // Verwaltungssitze (Gemeinden, Hauptstädte). Generische PPL und Ortsteile
  // (PPLX) wären zu rauschig: „Kapelle" (PPL in Willichs admin4) würde sonst
  // jeden Stop mit „Kapelle" im Namen nach Willich taggen. Ortsteile werden
  // stattdessen über Stufe B (nearest-place + admin4) korrekt aufgelöst.
  //
  // Mehrere Kandidaten pro Name sind die Regel (z.B. mehrere „Frankfurt"
  // oder „Neustadt"). Wir sammeln alle und wählen bei einer konkreten Suche
  // den nächstgelegenen zum Stop.
  const cityByName = new Map<string, CityPoint[]>();
  for (const p of allPoints) {
    const fc = p.featureCode ?? "";
    if (!fc.startsWith("PPLA") && fc !== "PPLC") continue;
    const key = p.name.toLowerCase();
    let bucket = cityByName.get(key);
    if (!bucket) {
      bucket = [];
      cityByName.set(key, bucket);
    }
    bucket.push(p);
  }

  // Maximale plausible Distanz zwischen Stop und der im Label genannten Stadt.
  // Geht weit genug für große Flächengemeinden (Hbf-Vororte sind oft 5-15 km
  // vom Stadtkern), schließt aber Querverweise quer durchs Land aus
  // („Wil. Neersen" 500 km weg von einem Stop in NRW).
  const MAX_LABEL_MATCH_DIST_M = 30_000;

  /** Sucht im Stop-Label nach einer Stadt aus unserer cities-Tabelle.
   *  Bei mehreren Namens-Treffern gewinnt der nächstgelegene zum Stop. Wenn
   *  der nächste >30 km weg ist → kein Match (verhindert Spurious-Matches auf
   *  Generika wie „Hardt" oder „Mitte"). */
  function findCityInLabel(label: string, stopLat: number, stopLng: number): CityPoint | null {
    const words = label.toLowerCase().split(/[\s,.;:/()\-]+/).filter(Boolean);
    const matches: CityPoint[] = [];
    function pushAll(bucket: CityPoint[] | undefined) {
      if (!bucket) return;
      for (const c of bucket) {
        if (!matches.some((m) => m.geonameId === c.geonameId)) matches.push(c);
      }
    }
    for (const word of words) {
      pushAll(cityByName.get(word));
    }
    for (let i = 0; i < words.length - 1; i++) {
      pushAll(cityByName.get(`${words[i]} ${words[i + 1]}`));
    }
    if (matches.length === 0) return null;
    matches.sort(
      (a, b) =>
        haversine(stopLat, stopLng, a.lat, a.lng) -
        haversine(stopLat, stopLng, b.lat, b.lng),
    );
    const best = matches[0]!;
    if (haversine(stopLat, stopLng, best.lat, best.lng) > MAX_LABEL_MATCH_DIST_M) {
      return null;
    }
    return best;
  }

  // 2. Alle GTFS-Locations laden, Updates batch-weise schreiben.
  console.log("[enrich-stops-city] loading stops…");
  const stops = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
      lat: locations.latitude,
      lng: locations.longitude,
    })
    .from(locations)
    .where(isNotNull(locations.latitude));
  console.log(`[enrich-stops-city]   ${stops.length} stops with coords`);

  const updates: { code: string; city: string }[] = [];
  let assigned = 0;
  let unchanged = 0;
  let fromLabel = 0;
  let fromHierarchy = 0;
  let fromOwnName = 0;
  for (const s of stops) {
    if (s.lat === null || s.lng === null) continue;
    const lat = Number(s.lat);
    const lng = Number(s.lng);

    let chosenName: string | null = null;

    // Stufe A: Stadt-Name im Label.
    const labelMatch = findCityInLabel(s.label, lat, lng);
    if (labelMatch) {
      chosenName = municipalityFor(labelMatch);
      fromLabel++;
    }

    // Stufe B: Admin-Hierarchie via nearest-place.
    if (!chosenName) {
      const np = nearestPlace(lat, lng);
      if (np) {
        chosenName = municipalityFor(np.place);
        const fc = np.place.featureCode ?? "";
        // Heuristik: wenn der Place selbst kein Seat war und ein admin4 hat,
        // war's ein echter Hierarchie-Resolve.
        if (!fc.startsWith("PPLA") && fc !== "PPLC" && np.place.admin4) {
          fromHierarchy++;
        } else {
          fromOwnName++;
        }
      }
    }

    if (!chosenName) continue;
    if (s.city === chosenName) {
      unchanged++;
      continue;
    }
    updates.push({ code: s.code, city: chosenName });
    assigned++;
  }

  console.log(
    `[enrich-stops-city] ${updates.length} stops to update (${unchanged} already correct)`,
  );

  // 3. Batch-Update.
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const codeList = batch.map((b) => sql`${b.code}`);
    const cases = batch.map((b) => sql`WHEN ${b.code} THEN ${b.city}`);
    await db.execute(sql`
      UPDATE locations
      SET city = CASE code
        ${sql.join(cases, sql` `)}
      END
      WHERE code IN (${sql.join(codeList, sql`, `)})
    `);
    if ((i / CHUNK) % 5 === 0) {
      console.log(
        `[enrich-stops-city]   updated ${Math.min(i + CHUNK, updates.length)} / ${updates.length}`,
      );
    }
  }

  console.log(`[enrich-stops-city] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[enrich-stops-city]   assigned: ${assigned}`);
  console.log(`[enrich-stops-city]     - via Stadt-Name im Label: ${fromLabel}`);
  console.log(`[enrich-stops-city]     - via admin4-Hierarchie:   ${fromHierarchy}`);
  console.log(`[enrich-stops-city]     - via nearest-place-Name:  ${fromOwnName}`);
  console.log(`[enrich-stops-city]   unchanged: ${unchanged}`);
  console.log(
    `[enrich-stops-city]   unmatched (no place <20km): ${stops.length - assigned - unchanged}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[enrich-stops-city] failed:", err);
  process.exit(1);
});
