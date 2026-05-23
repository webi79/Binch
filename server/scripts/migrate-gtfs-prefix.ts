/**
 * Einmalige Migration: alte GTFS-DE-Rows (Präfix `gtfs:`) auf das neue
 * länder-namespaced Schema `gtfs:de:` umbenennen. Idempotent — kann mehrfach
 * laufen, doppelt umbenannte Rows werden nicht angefasst.
 *
 *   npm run migrate:gtfs-prefix
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

async function main() {
  const result = await db.execute(sql`
    UPDATE locations
    SET code = 'gtfs:de:' || SUBSTRING(code FROM 6)
    WHERE source = 'gtfs'
      AND country = 'Germany'
      AND code LIKE 'gtfs:%'
      AND code NOT LIKE 'gtfs:de:de:%'
  `);
  console.log(`[migrate-gtfs-prefix] renamed ${result.rowCount ?? 0} rows`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrate-gtfs-prefix] failed:", err);
  process.exit(1);
});
