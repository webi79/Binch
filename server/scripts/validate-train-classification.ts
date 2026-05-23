/**
 * Bereinigt fälschliche TRAIN-Klassifikationen von gtfs:de:-Stops, die in
 * Wahrheit keine Bahnhöfe sind.
 *
 * Problem: Der „gtfs.de free"-Feed (DELFI-Aggregation) tagged manche Bus-Stops
 * mit Schienenersatzverkehr- oder Aggregations-Artefakten als route_type=2
 * (Rail). Beispiel User-Bug-Report: „Hamm Münsterische Schiff.-AG" wurde als
 * TRAIN/SUBURBAN klassifiziert, obwohl es nur eine Busstation ist.
 *
 * Lösung: Cross-Validation gegen StaDa (trainline-eu) — diese Quelle hat
 * vertrauenswürdige HAFAS-IDs für ALLE echten DB-Bahnhöfe in DE. Für jeden
 * gtfs:de:-TRAIN-Stop suchen wir die nächstgelegene StaDa-TRAIN-Station. Liegt
 * sie weiter als 200m weg → der Stop ist KEIN echter Bahnhof, wir degradieren
 * auf BUS.
 *
 * Idempotent: kann mehrfach laufen.
 */
import { sql, eq, and, isNotNull, like } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const MAX_DISTANCE_M = 200;
const CHUNK = 1000;

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

/** Grid-Cell bei 0.01° (~1.1 km Auflösung). 200m-Lookup braucht 3x3-Nachbarschaft. */
function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat * 100)},${Math.floor(lng * 100)}`;
}

async function main() {
  const t0 = Date.now();

  // 1. Alle StaDa-TRAIN-Stops mit Coords laden, in Grid indexieren.
  console.log("[validate-train] loading StaDa TRAIN reference points…");
  const stada = await db
    .select({
      code: locations.code,
      label: locations.label,
      lat: locations.latitude,
      lng: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        eq(locations.source, "stada"),
        eq(locations.type, "TRAIN"),
        isNotNull(locations.latitude),
      ),
    );
  console.log(`[validate-train]   ${stada.length} StaDa-TRAIN-Stops`);

  type Point = { lat: number; lng: number; label: string };
  const grid = new Map<string, Point[]>();
  for (const s of stada) {
    if (s.lat === null || s.lng === null) continue;
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    const p: Point = { lat, lng, label: s.label };
    const key = cellKey(lat, lng);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(p);
  }

  function hasStadaNeighbor(lat: number, lng: number): boolean {
    const cy = Math.floor(lat * 100);
    const cx = Math.floor(lng * 100);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cy + dy},${cx + dx}`);
        if (!bucket) continue;
        for (const p of bucket) {
          if (haversine(lat, lng, p.lat, p.lng) <= MAX_DISTANCE_M) return true;
        }
      }
    }
    return false;
  }

  // 2. Alle gtfs:de:-Rows mit type=TRAIN laden (egal welcher gtfs:de:-Verband).
  console.log("[validate-train] loading gtfs:de: TRAIN candidates…");
  const candidates = await db
    .select({
      code: locations.code,
      label: locations.label,
      lat: locations.latitude,
      lng: locations.longitude,
      subtype: locations.subtype,
      kinds: locations.kinds,
    })
    .from(locations)
    .where(
      and(
        eq(locations.source, "gtfs"),
        eq(locations.type, "TRAIN"),
        like(locations.code, "gtfs:de:%"),
        isNotNull(locations.latitude),
      ),
    );
  console.log(`[validate-train]   ${candidates.length} gtfs:de: TRAIN-Kandidaten`);

  // 3. Prüfen + sammeln welche degradiert werden müssen.
  const toDemote: string[] = [];
  for (const c of candidates) {
    if (c.lat === null || c.lng === null) continue;
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (!hasStadaNeighbor(lat, lng)) toDemote.push(c.code);
  }
  console.log(`[validate-train] ${toDemote.length} Stops haben keinen StaDa-Nachbar — werden auf BUS degradiert`);

  // 4. Batch-Update: type=BUS, subtype=BUS, kinds aus rail-Anteilen entfernen.
  for (let i = 0; i < toDemote.length; i += CHUNK) {
    const batch = toDemote.slice(i, i + CHUNK);
    await db.execute(sql`
      UPDATE locations
      SET
        type = 'BUS',
        subtype = 'BUS',
        kinds = ARRAY(
          SELECT k FROM unnest(coalesce(kinds, ARRAY['bus']::text[])) k WHERE k != 'train'
        )
      WHERE code IN (${sql.join(
        batch.map((c) => sql`${c}`),
        sql`, `,
      )})
    `);

    // Falls kinds nach dem train-filter leer ist → mit ['bus'] befüllen.
    await db.execute(sql`
      UPDATE locations
      SET kinds = ARRAY['bus']
      WHERE code IN (${sql.join(
        batch.map((c) => sql`${c}`),
        sql`, `,
      )}) AND (kinds IS NULL OR array_length(kinds, 1) IS NULL)
    `);

    if ((i / CHUNK) % 5 === 0) {
      console.log(`[validate-train]   ${Math.min(i + CHUNK, toDemote.length)} / ${toDemote.length}`);
    }
  }

  console.log(`[validate-train] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[validate-train] failed:", err);
  process.exit(1);
});
