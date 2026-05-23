/**
 * Diagnose-Skript für „Suche findet Stop X nicht via Stadt Y"-Probleme.
 *
 * Benutzung:
 *   STOP_NAME="anrath" CITY_NAME="willich" npm run diagnose:city-search
 *
 * Prüft:
 *   1. Existiert ein Stop dessen Label „anrath" enthält? Was steht im city-Feld?
 *   2. Existiert die Stadt „willich" in der cities-Tabelle? Mit welchen coords?
 *   3. Wie weit ist der nächste „willich"-Eintrag von dem Anrath-Stop entfernt?
 *   4. Welche Stops haben aktuell city="willich"?
 */
import { sql, ilike } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations, cities } from "../src/db/schema.js";

const STOP_NAME = process.env.STOP_NAME ?? "anrath";
const CITY_NAME = process.env.CITY_NAME ?? "willich";

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function main() {
  console.log(`\n=== Diagnose: Stop "${STOP_NAME}" vs City "${CITY_NAME}" ===\n`);

  // (0) Existiert die cities-Tabelle und ist sie befüllt?
  const cityCount = await db.execute(sql`SELECT COUNT(*)::int AS n FROM cities`);
  const cityResult = cityCount as unknown as { rows?: Array<{ n: number }> } & Array<{ n: number }>;
  const cityRows = cityResult.rows ?? cityResult;
  const cityTotal = Array.isArray(cityRows) && cityRows[0] ? cityRows[0].n : 0;
  console.log(`[0] cities-Tabelle: ${cityTotal} Einträge`);
  if (cityTotal === 0) {
    console.log(`    ⚠ Tabelle ist LEER. → npm run import:cities ausführen.`);
  }

  // (1) Stop-Suche: was steht im city-Feld?
  console.log(`\n[1] Stops mit "${STOP_NAME}" im Label:`);
  const stopMatches = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
      country: locations.country,
      lat: locations.latitude,
      lng: locations.longitude,
      source: locations.source,
    })
    .from(locations)
    .where(ilike(locations.label, `%${STOP_NAME}%`))
    .limit(10);
  if (stopMatches.length === 0) {
    console.log(`    ⚠ Keine Stops mit "${STOP_NAME}" im Label gefunden.`);
  } else {
    for (const s of stopMatches) {
      console.log(
        `    label="${s.label}", city="${s.city}", country="${s.country}", source="${s.source}", coords=(${s.lat}, ${s.lng})`,
      );
    }
  }

  // (2) Existiert die Stadt in cities-Tabelle?
  console.log(`\n[2] Cities mit "${CITY_NAME}" im Namen:`);
  const cityMatches = await db
    .select({
      name: cities.name,
      country: cities.country,
      lat: cities.latitude,
      lng: cities.longitude,
      population: cities.population,
    })
    .from(cities)
    .where(ilike(cities.name, `%${CITY_NAME}%`))
    .limit(10);
  if (cityMatches.length === 0) {
    console.log(
      `    ⚠ Keine Stadt "${CITY_NAME}" in der cities-Tabelle. Vielleicht nicht in cities5000.zip?`,
    );
  } else {
    for (const c of cityMatches) {
      console.log(
        `    name="${c.name}", country="${c.country}", coords=(${c.lat}, ${c.lng}), pop=${c.population}`,
      );
    }
  }

  // (3) Distanz zwischen Stop und Stadt
  if (stopMatches.length > 0 && cityMatches.length > 0) {
    console.log(`\n[3] Distanzen Stop ↔ Stadt:`);
    for (const s of stopMatches.slice(0, 3)) {
      if (s.lat === null || s.lng === null) continue;
      const slat = Number(s.lat);
      const slng = Number(s.lng);
      for (const c of cityMatches.slice(0, 3)) {
        const clat = Number(c.lat);
        const clng = Number(c.lng);
        const d = Math.round(haversineMeters(slat, slng, clat, clng));
        console.log(`    "${s.label}" ↔ "${c.name}": ${d} m`);
      }
    }
  }

  // (4) Welche Stops haben city = "<CITY_NAME>"?
  console.log(`\n[4] Stops mit city ILIKE "%${CITY_NAME}%":`);
  const tagged = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
    })
    .from(locations)
    .where(ilike(locations.city, `%${CITY_NAME}%`))
    .limit(15);
  if (tagged.length === 0) {
    console.log(
      `    ⚠ Kein Stop hat "${CITY_NAME}" im city-Feld. → npm run enrich:stops-city ausführen.`,
    );
  } else {
    for (const s of tagged) {
      console.log(`    label="${s.label}", city="${s.city}"`);
    }
  }

  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error("[diagnose] failed:", err);
  process.exit(1);
});
