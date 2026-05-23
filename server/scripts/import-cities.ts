/**
 * Import-Script: Städte aus dem GeoNames cities5000-Datensatz (Städte mit
 * >=5000 Einwohnern weltweit, ~50k Einträge). Wird in die `cities`-Tabelle
 * geladen und vom enrich-stops-city.ts-Script genutzt um Stops administrativ
 * einer Stadt zuzuordnen.
 *
 * Wir filtern auf unsere 8 Länder.
 *
 * Datei wird unter /tmp/geonames-cities.txt erwartet:
 *   curl -L -o /tmp/cities5000.zip https://download.geonames.org/export/dump/cities5000.zip
 *   unzip -j -o /tmp/cities5000.zip cities5000.txt -d /tmp/
 *   mv -f /tmp/cities5000.txt /tmp/geonames-cities.txt
 *
 * Format ist Tab-separiert, 19 Spalten (siehe README beim GeoNames-Download):
 *   0=geonameid, 1=name, 2=asciiname, 3=alternatenames, 4=lat, 5=lng,
 *   6=feature_class, 7=feature_code, 8=country_code, ..., 14=population, ...
 *
 * Ausführung: npm run import:cities
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities } from "../src/db/schema.js";

const CSV_PATH = process.env.GEONAMES_CITIES_PATH ?? "/tmp/geonames-cities.txt";
const CHUNK = 500;

const COUNTRY_NAMES: Record<string, string> = {
  DE: "Germany",
  AT: "Austria",
  FR: "France",
  NL: "Netherlands",
  CH: "Switzerland",
  CZ: "Czech Republic",
  PL: "Poland",
  BE: "Belgium",
};

interface CityRow {
  geonameId: number;
  name: string;
  asciiName: string | null;
  country: string;
  latitude: string;
  longitude: string;
  population: number | null;
}

async function main() {
  const t0 = Date.now();
  console.log(`[cities] reading ${CSV_PATH}…`);
  const text = readFileSync(CSV_PATH, "utf-8");
  const lines = text.split("\n");
  console.log(`[cities]   ${lines.length} raw lines`);

  const out: CityRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 15) continue;

    const countryCode = cols[8]?.trim();
    const countryName = countryCode ? COUNTRY_NAMES[countryCode] : undefined;
    if (!countryName) continue; // Land außerhalb unserer 8 → skip

    const geonameId = parseInt(cols[0] ?? "", 10);
    const name = cols[1]?.trim();
    const asciiName = cols[2]?.trim() || null;
    const lat = parseFloat(cols[4] ?? "");
    const lng = parseFloat(cols[5] ?? "");
    const featureClass = cols[6]?.trim();
    const pop = parseInt(cols[14] ?? "", 10);

    if (!Number.isFinite(geonameId)) continue;
    if (!name) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Nur populierte Orte (feature class P) — GeoNames hat auch andere
    // Feature-Classes, die wollen wir nicht.
    if (featureClass !== "P") continue;

    out.push({
      geonameId,
      name,
      asciiName,
      country: countryName,
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      population: Number.isFinite(pop) ? pop : null,
    });
  }

  console.log(`[cities] filtered to ${out.length} cities in our 8 countries`);

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
        },
      });
    if ((i / CHUNK) % 10 === 0) {
      console.log(`[cities]   ${Math.min(i + CHUNK, out.length)} / ${out.length}`);
    }
  }

  console.log(`[cities] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[cities] failed:", err);
  process.exit(1);
});
