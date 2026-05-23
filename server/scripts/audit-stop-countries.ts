/**
 * Audit: findet Locations deren `country`-Spalte NICHT zu ihren Koordinaten
 * passt (z.B. „München Ost" in NL bei Lat/Lon (0,0)). Solche Rows kommen aus
 * fehlerhaften GTFS-Feeds die Nachbar-Stationen für Through-Tickets listen
 * aber falsch klassifizieren oder leere Coords haben.
 *
 * Default: nur reporten. Mit `--fix` werden die Rows entweder
 *   - korrigiert (country → tatsächliches Land falls Polygon match)
 *   - oder gelöscht falls Coords (0,0) / null sind (= unbrauchbar)
 *
 * Aufruf:
 *   npx tsx scripts/audit-stop-countries.ts          # report only
 *   npx tsx scripts/audit-stop-countries.ts --fix    # auto-correct + delete
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { countryFromCoord } from "../src/lib/country-from-coord.js";

const FIX = process.argv.includes("--fix");

interface Row {
  code: string;
  label: string;
  country: string | null;
  latitude: string | null;
  longitude: string | null;
  source: string | null;
}

async function main(): Promise<void> {
  // 1) Rows mit Coords (0,0) — sind immer kaputt.
  const zeroRows = (await db.execute(sql`
    SELECT code, label, country, latitude, longitude, source
    FROM locations
    WHERE latitude::float = 0 AND longitude::float = 0
  `)) as unknown as { rows: Row[] };
  console.log(`[audit] (0,0)-Coords: ${zeroRows.rows.length} rows`);
  for (const r of zeroRows.rows.slice(0, 10)) {
    console.log(`  ${r.code} | ${r.label} | country=${r.country} | source=${r.source}`);
  }

  // 2) Country-Mismatch: stored country != coord-derived country
  //    (nur für Rows in unseren 7 modellierten Ländern testbar).
  const allRows = (await db.execute(sql`
    SELECT code, label, country, latitude, longitude, source
    FROM locations
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      AND latitude::float != 0 AND longitude::float != 0
      AND country IN ('Germany','Austria','Switzerland','Netherlands','Belgium','France','Poland')
  `)) as unknown as { rows: Row[] };

  let mismatches = 0;
  const mismatchExamples: Row[] = [];
  const toFixCountry = new Map<string, string>(); // code → correctedCountry
  const toDelete: string[] = [];

  for (const r of allRows.rows) {
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const detected = countryFromCoord(lat, lon);
    if (!detected) continue; // außerhalb unserer Polygone — nicht klassifizierbar
    if (detected !== r.country) {
      mismatches++;
      if (mismatchExamples.length < 15) mismatchExamples.push(r);
      toFixCountry.set(r.code, detected);
    }
  }

  console.log(`[audit] Country-Mismatch (Coords-Polygon): ${mismatches} rows`);
  for (const r of mismatchExamples) {
    const lat = Number(r.latitude).toFixed(4);
    const lon = Number(r.longitude).toFixed(4);
    const detected = countryFromCoord(Number(r.latitude), Number(r.longitude));
    console.log(`  ${r.code} | ${r.label} | stored=${r.country} → detected=${detected} | ${lat},${lon} | source=${r.source}`);
  }

  // (0,0)-Rows: löschen
  for (const r of zeroRows.rows) toDelete.push(r.code);

  if (!FIX) {
    console.log("");
    console.log("[audit] DRY-RUN — nichts geändert. Mit --fix anwenden.");
    process.exit(0);
  }

  if (toDelete.length > 0) {
    console.log(`[audit] Lösche ${toDelete.length} (0,0)-Coord-Rows…`);
    await db.execute(sql.raw(
      `DELETE FROM locations WHERE code IN (${toDelete.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})`,
    ));
  }

  if (toFixCountry.size > 0) {
    console.log(`[audit] Korrigiere country bei ${toFixCountry.size} Rows…`);
    // Batched UPDATE in 500er-Gruppen
    const entries = Array.from(toFixCountry.entries());
    for (let i = 0; i < entries.length; i += 500) {
      const batch = entries.slice(i, i + 500);
      // Sammle pro Country eine Liste von Codes und mache einen UPDATE pro Country
      const byCountry = new Map<string, string[]>();
      for (const [code, ct] of batch) {
        const list = byCountry.get(ct) ?? [];
        list.push(code);
        byCountry.set(ct, list);
      }
      for (const [ct, codes] of byCountry) {
        await db.execute(sql.raw(
          `UPDATE locations SET country = '${ct.replace(/'/g, "''")}' WHERE code IN (${codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})`,
        ));
      }
    }
  }

  console.log("[audit] done.");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
