/**
 * Räumt grenzüberschreitende Falsch-Tags in der `locations`-Tabelle auf:
 * Stops die als „Niederlande" markiert sind, aber laut Koordinaten in
 * Deutschland liegen, werden gelöscht (kein Re-Import nötig).
 *
 * Wird ausgeführt nach dem Hinzufügen des Bounding-Box-Filters im
 * GTFS-Import. Verwende `npm run cleanup:foreign-stops`.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

/** Identisch zu COUNTRY_BBOX in scripts/import-gtfs.ts — eng gefasst, damit
 *  Cross-Border-Stops nicht durchschlüpfen. */
const COUNTRY_BBOX: Record<string, [number, number, number, number]> = {
  Germany: [47.3, 55.1, 5.87, 15.04],
  Austria: [46.37, 49.02, 9.53, 17.17],
  France: [41.3, 51.1, -5.14, 9.56],
  Netherlands: [50.75, 53.55, 3.36, 7.22],
  Switzerland: [45.82, 47.81, 5.96, 10.49],
  "Czech Republic": [48.55, 51.06, 12.09, 18.86],
  Poland: [49.0, 54.84, 14.12, 24.15],
  Belgium: [49.5, 51.5, 2.55, 6.4],
};

async function main() {
  let totalRemoved = 0;
  for (const [country, [minLat, maxLat, minLng, maxLng]] of Object.entries(COUNTRY_BBOX)) {
    const res = await db.execute(sql`
      DELETE FROM locations
      WHERE source = 'gtfs'
        AND country = ${country}
        AND (
          latitude::numeric < ${minLat}
          OR latitude::numeric > ${maxLat}
          OR longitude::numeric < ${minLng}
          OR longitude::numeric > ${maxLng}
        )
    `);
    const n = res.rowCount ?? 0;
    if (n > 0) console.log(`[cleanup-foreign-stops] ${country}: ${n} out-of-bbox rows removed`);
    totalRemoved += n;
  }
  console.log(`[cleanup-foreign-stops] total removed: ${totalRemoved}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[cleanup-foreign-stops] failed:", err);
  process.exit(1);
});
