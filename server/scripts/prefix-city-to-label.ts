/**
 * Setzt der Konvention von HAFAS/db-rest folgend den Stadt-Namen als Präfix
 * vors Label, wenn er nicht bereits im Label vorkommt.
 *
 * Beispiele:
 *   - label="Anrath", city="Willich"     → "Willich Anrath"
 *   - label="Werl", city="Werl"          → unverändert
 *   - label="Düsseldorf Hbf", city="Düsseldorf" → unverändert
 *   - label="Soest", city="Soest"        → unverändert
 *
 * Hintergrund: StaDa importiert nur den nackten Stationsnamen. „Anrath"
 * (UIC 8000584) findet so niemand, der nach „Willich" sucht. HAFAS/db-rest
 * hingegen liefern „Willich-Anrath" — wir bauen die gleiche Konvention nach,
 * damit Autocomplete-Searches per Stadt-Name funktionieren.
 *
 * Idempotent: Re-Run ändert nichts, wenn der Stadt-Name bereits prefixiert ist.
 *
 * Match-Strategie: case-insensitiver substring-Check. „Soester Straße" in
 * Bremen → „bremen" ist in „bremen soester straße" → kein Präfix.
 */
import { isNotNull, and, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const CHUNK = 2000;

async function main() {
  const t0 = Date.now();
  console.log("[prefix-city] loading rows with city set…");
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
    })
    .from(locations)
    .where(and(isNotNull(locations.city)));
  console.log(`[prefix-city]   ${rows.length} rows with city`);

  const updates: { code: string; label: string }[] = [];
  for (const r of rows) {
    if (!r.city) continue;
    const cityLc = r.city.toLowerCase();
    const labelLc = r.label.toLowerCase();
    if (labelLc.includes(cityLc)) continue;
    updates.push({ code: r.code, label: `${r.city} ${r.label}` });
  }
  console.log(`[prefix-city] ${updates.length} labels zu prefixieren`);

  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const codeList = batch.map((b) => sql`${b.code}`);
    const cases = batch.map((b) => sql`WHEN ${b.code} THEN ${b.label}`);
    await db.execute(sql`
      UPDATE locations
      SET label = CASE code
        ${sql.join(cases, sql` `)}
      END
      WHERE code IN (${sql.join(codeList, sql`, `)})
    `);
    if ((i / CHUNK) % 5 === 0) {
      console.log(
        `[prefix-city]   updated ${Math.min(i + CHUNK, updates.length)} / ${updates.length}`,
      );
    }
  }

  console.log(`[prefix-city] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[prefix-city] failed:", err);
  process.exit(1);
});
