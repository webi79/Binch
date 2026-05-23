/**
 * Korrigiert das `country`-Feld aller GTFS-Rows in der `locations`-Tabelle
 * anhand der tatsächlichen Koordinaten (Polygon-basierter Lookup statt
 * Bounding-Boxes oder GTFS-Feed-Source).
 *
 * Macht zwei Dinge:
 *   1. UPDATE: wenn ein Row in einem unserer modellierten Länder liegt
 *      (laut Polygon), wird `country` darauf gesetzt.
 *   2. DELETE: wenn ein Row in keinem unserer modellierten Länder liegt
 *      (z.B. internationale Through-Trains in Zonen die wir nicht abdecken)
 *      und sein aktuelles country zu unseren Ländern gehört → löschen,
 *      damit kein falsches Tag in der DB bleibt.
 *
 * Idempotent: kann mehrfach laufen ohne Schaden.
 */
import { sql, eq, isNotNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { countryFromCoord } from "../src/lib/country-from-coord.js";

const CHUNK = 1000;

async function main() {
  const t0 = Date.now();
  console.log("[fix-country] selecting all GTFS rows with coords…");
  const rows = await db
    .select({
      code: locations.code,
      country: locations.country,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(eq(locations.source, "gtfs"));
  const withCoords = rows.filter((r) => r.latitude !== null && r.longitude !== null);
  console.log(`[fix-country]   ${withCoords.length} GTFS rows`);

  const updates: { code: string; country: string }[] = [];
  const deletes: string[] = [];
  for (const r of withCoords) {
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    const detected = countryFromCoord(lat, lng);
    if (detected === null) {
      // Außerhalb unserer modellierten Länder. Wenn aktuell trotzdem eines
      // unserer Länder gesetzt ist → Row ist falsch zugeordnet → löschen.
      const hosted = new Set([
        "Germany",
        "Austria",
        "France",
        "Netherlands",
        "Switzerland",
        "Czech Republic",
        "Poland",
        "Belgium",
      ]);
      if (r.country && hosted.has(r.country)) {
        deletes.push(r.code);
      }
      continue;
    }
    if (detected !== r.country) {
      updates.push({ code: r.code, country: detected });
    }
  }

  console.log(`[fix-country] ${updates.length} rows need country update`);
  console.log(`[fix-country] ${deletes.length} rows to delete (out-of-bounds)`);

  // Updates batch-weise
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    for (const u of batch) {
      await db
        .update(locations)
        .set({ country: u.country })
        .where(eq(locations.code, u.code));
    }
    if ((i / CHUNK) % 5 === 0) {
      console.log(`[fix-country]   updated ${Math.min(i + CHUNK, updates.length)} / ${updates.length}`);
    }
  }

  // Deletes batch-weise
  for (let i = 0; i < deletes.length; i += CHUNK) {
    const batch = deletes.slice(i, i + CHUNK);
    await db.execute(
      sql`DELETE FROM locations WHERE code IN (${sql.join(
        batch.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
    console.log(`[fix-country]   deleted ${Math.min(i + CHUNK, deletes.length)} / ${deletes.length}`);
  }

  console.log(`[fix-country] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[fix-country]   country-updates: ${updates.length}`);
  console.log(`[fix-country]   out-of-bounds-deletes: ${deletes.length}`);
  process.exit(0);
}

// isNotNull bleibt importiert für Klarheit, auch wenn nicht zwingend genutzt.
void isNotNull;

main().catch((err) => {
  console.error("[fix-country] failed:", err);
  process.exit(1);
});
