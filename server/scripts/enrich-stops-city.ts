/**
 * Setzt `city` für Bahnhöfe und Haltestellen, die noch KEINE Stadt haben — die
 * Gemeinde nach scripts/lib/stopMunicipality.ts (Sitz im Label, sonst der
 * nächste Ort, länderbewusst aufgelöst). So findet die Ortssuche einen Halt
 * auch über seine Gemeinde: „Anrath Bahnhof" → city="Willich".
 *
 * NUR LEERE FELDER (seit Sept. 2026). Vorher rechnete das Skript bei jedem
 * Lauf alle 1,6 Mio. Zeilen neu — mit der alten, länderblinden Regel kamen
 * dabei Stadtteile heraus (Wien Hbf in „Matzleinsdorf"), und jede Korrektur
 * wäre beim nächsten Import wieder weg gewesen. Die einmalige Korrektur der
 * vorhandenen Werte steht in `fix-stop-cities.ts`; hier landen nur neue Halte
 * aus dem monatlichen Abgleich (scripts/refresh-stops.sh).
 *
 * NUR Haltestellen und Bahnhöfe. Kuratierte Städte (`ALL`), Flughäfen, Häfen
 * und die kuratierten Busbahnhöfe tragen ihren Stadtnamen aus dem Seed.
 *
 * Cities-Tabelle muss vorher gefüllt sein via:
 *   npm run import:admin-places:all
 *
 * Idempotent: Ein zweiter Lauf findet nichts mehr zu tun.
 */
import { and, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities, locations } from "../src/db/schema.js";
import { BUS_STATIONS } from "../src/data/cities.js";
import { buildMunicipalityResolver, type PlacePoint } from "./lib/stopMunicipality.js";

const CHUNK = 2000;

async function main() {
  const t0 = Date.now();

  const stops = await db
    .select({
      code: locations.code,
      label: locations.label,
      lat: locations.latitude,
      lng: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        isNull(locations.city),
        isNotNull(locations.latitude),
        inArray(locations.type, ["TRAIN", "BUS"]),
        notInArray(
          locations.code,
          BUS_STATIONS.map((b) => b.code),
        ),
      ),
    );
  console.log(`[enrich-stops-city] ${stops.length} Halte ohne Stadt`);
  if (stops.length === 0) process.exit(0);

  const cityRows = await db
    .select({
      geonameId: cities.geonameId,
      name: cities.name,
      lat: cities.latitude,
      lng: cities.longitude,
      population: cities.population,
      featureCode: cities.featureCode,
      country: cities.country,
      admin1: cities.admin1,
      admin2: cities.admin2,
      admin3: cities.admin3,
      admin4: cities.admin4,
    })
    .from(cities);
  const points: PlacePoint[] = cityRows.map((c) => ({
    geonameId: c.geonameId,
    name: c.name,
    lat: Number(c.lat),
    lng: Number(c.lng),
    population: c.population ?? 0,
    featureCode: c.featureCode,
    country: c.country,
    admin1: c.admin1,
    admin2: c.admin2,
    admin3: c.admin3,
    admin4: c.admin4,
  }));
  const resolver = buildMunicipalityResolver(points);
  console.log(`[enrich-stops-city] ${points.length} Orte geladen`);

  const updates: { code: string; city: string }[] = [];
  for (const s of stops) {
    const muni = resolver.municipalityForStop(s.label, Number(s.lat), Number(s.lng));
    if (muni) updates.push({ code: s.code, city: muni.name });
  }

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
  }

  console.log(
    `[enrich-stops-city] ${updates.length} gesetzt, ${stops.length - updates.length} ohne Ort im Umkreis (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[enrich-stops-city] failed:", err);
  process.exit(1);
});
