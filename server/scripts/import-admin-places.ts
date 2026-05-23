/**
 * Import-Script: Populated Places (Städte, Gemeinden, Ortsteile) aus den
 * GeoNames Country-Dumps. Im Gegensatz zu cities5000 (nur >=5000 Einwohner)
 * enthalten die Country-Dumps ALLE Orte, inkl. Ortsteile (feature_code=PPLX)
 * und Gemeinde-Sitze (feature_code=PPLA4).
 *
 * Warum brauchen wir das? Beispiel Anrath:
 *   - cities5000 hat: Willich (PPLA4) bei 51.26, 6.55, pop 51843
 *   - cities5000 hat KEIN Anrath
 *   - Nearest-City für Anrath-Bahnhof (51.30, 6.51) → Tönisvorst (näher, aber
 *     administrativ falsch)
 *   - GeoNames DE.zip hat: Anrath (PPLX, admin4=05154004) und Willich (PPLA4,
 *     admin4=05154004) — gleicher admin4-Code!
 *   - Korrekte Zuordnung: Anrath → Willich via admin4-Hierarchie.
 *
 * Datenformat: Tab-separierte allCountries-Subsets, eine Datei pro Land.
 * Format (19 Spalten):
 *   0=geonameid, 1=name, 2=asciiname, 3=alternatenames, 4=lat, 5=lng,
 *   6=feature_class, 7=feature_code, 8=country_code, 9=cc2,
 *   10=admin1, 11=admin2, 12=admin3, 13=admin4, 14=population, 15=elevation,
 *   16=dem, 17=timezone, 18=modification_date
 *
 * Ausführung:
 *   GEONAMES_COUNTRY_FILE=/tmp/geonames-DE.txt GEONAMES_COUNTRY=Germany \
 *     tsx --env-file=.env scripts/import-admin-places.ts
 *
 * Bzw. via npm run import:admin-places:de etc. — siehe package.json.
 *
 * Idempotent: ON CONFLICT (geoname_id) DO UPDATE.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities } from "../src/db/schema.js";

const CSV_PATH = process.env.GEONAMES_COUNTRY_FILE;
const COUNTRY_NAME = process.env.GEONAMES_COUNTRY;
const CHUNK = 500;

if (!CSV_PATH || !COUNTRY_NAME) {
  console.error(
    "[admin-places] missing env: GEONAMES_COUNTRY_FILE=<path> GEONAMES_COUNTRY=<name>",
  );
  process.exit(1);
}

// Feature-Codes die wir wollen. Alles was eine Stadt/Gemeinde/Ortsteil ist.
// Ausgeschlossen: PPLH (verlassen), PPLW (zerstört), PPLQ (verlassen),
// PPLCH (frühere Hauptstadt). Wir nehmen auch PPLF (farm village) nicht mit,
// das sind sehr kleine Weiler die nur Rauschen einbringen würden.
const WANTED_FEATURE_CODES = new Set([
  "PPL", // populated place (default)
  "PPLA", // seat of admin1 (Landeshauptstadt)
  "PPLA2", // seat of admin2 (Regierungsbezirk-Sitz)
  "PPLA3", // seat of admin3 (Kreis-Sitz)
  "PPLA4", // seat of admin4 (Gemeinde-Sitz) — wichtig!
  "PPLA5", // seat of admin5
  "PPLC", // capital
  "PPLG", // seat of government
  "PPLS", // populated places
  "PPLX", // section of populated place (Ortsteil) — wichtig!
]);

interface CityRow {
  geonameId: number;
  name: string;
  asciiName: string | null;
  country: string;
  latitude: string;
  longitude: string;
  population: number | null;
  featureCode: string | null;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  admin4: string | null;
}

async function main() {
  const t0 = Date.now();
  console.log(`[admin-places] reading ${CSV_PATH} (${COUNTRY_NAME})…`);
  const text = readFileSync(CSV_PATH!, "utf-8");
  const lines = text.split("\n");
  console.log(`[admin-places]   ${lines.length} raw lines`);

  const out: CityRow[] = [];
  let skippedFeatureClass = 0;
  let skippedFeatureCode = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 15) continue;

    const featureClass = cols[6]?.trim();
    if (featureClass !== "P") {
      skippedFeatureClass++;
      continue;
    }

    const featureCode = cols[7]?.trim() ?? "";
    if (!WANTED_FEATURE_CODES.has(featureCode)) {
      skippedFeatureCode++;
      continue;
    }

    const geonameId = parseInt(cols[0] ?? "", 10);
    const name = cols[1]?.trim();
    const asciiName = cols[2]?.trim() || null;
    const lat = parseFloat(cols[4] ?? "");
    const lng = parseFloat(cols[5] ?? "");
    const admin1 = cols[10]?.trim() || null;
    const admin2 = cols[11]?.trim() || null;
    const admin3 = cols[12]?.trim() || null;
    const admin4 = cols[13]?.trim() || null;
    const pop = parseInt(cols[14] ?? "", 10);

    if (!Number.isFinite(geonameId)) continue;
    if (!name) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    out.push({
      geonameId,
      name,
      asciiName,
      country: COUNTRY_NAME!,
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      population: Number.isFinite(pop) ? pop : null,
      featureCode: featureCode || null,
      admin1,
      admin2,
      admin3,
      admin4,
    });
  }

  console.log(
    `[admin-places] ${out.length} places (skipped: ${skippedFeatureClass} non-P, ${skippedFeatureCode} other-P-codes)`,
  );

  for (let i = 0; i < out.length; i += CHUNK) {
    const batch = out.slice(i, i + CHUNK);
    await db
      .insert(cities)
      .values(batch)
      .onConflictDoUpdate({
        target: cities.geonameId,
        set: {
          name: sql`excluded.name`,
          asciiName: sql`excluded.ascii_name`,
          country: sql`excluded.country`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          population: sql`excluded.population`,
          featureCode: sql`excluded.feature_code`,
          admin1: sql`excluded.admin1`,
          admin2: sql`excluded.admin2`,
          admin3: sql`excluded.admin3`,
          admin4: sql`excluded.admin4`,
        },
      });
    if ((i / CHUNK) % 10 === 0) {
      console.log(`[admin-places]   ${Math.min(i + CHUNK, out.length)} / ${out.length}`);
    }
  }

  console.log(`[admin-places] ${COUNTRY_NAME} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[admin-places] failed:", err);
  process.exit(1);
});
