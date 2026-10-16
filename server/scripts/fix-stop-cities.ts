/**
 * Einmalige Korrektur (Sept. 2026): Stadtteile als Stadt und als
 * vorangestelltes Label-Präfix bei Bahnhöfen und Haltestellen.
 *
 *   1. `city` neu nach der länderbewussten Gemeinde-Ermittlung
 *      (scripts/lib/stopMunicipality.ts) — Wien Hbf: „Matzleinsdorf" → „Vienna".
 *   2. Ein vorangestellter STADTTEIL wird aus dem Label entfernt — aber nur,
 *      wenn der Rest die richtige Stadt noch nennt (auch in einer anderen
 *      Sprache, cityExonyms.ts): „Neubau Wien Westbahnhof" → „Wien
 *      Westbahnhof", „Stationsbuurt Den Haag HS" → „Den Haag HS". Ist der
 *      Vorsatz selbst eine Gemeinde („Hutthurm Prag") oder nennt der Rest die
 *      Stadt nicht, bleibt das Label, wie es ist.
 *
 * Probelauf (nur Bericht):  npx tsx --env-file=.env scripts/fix-stop-cities.ts
 * Anwenden:                 … --apply   (schreibt vorher eine Sicherung)
 * Bericht/Sicherung:        FIX_REPORT_DIR (Vorgabe: ./)
 */
import { writeFileSync } from "node:fs";
import { and, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities, locations } from "../src/db/schema.js";
import { BUS_STATIONS } from "../src/data/cities.js";
import { exonymQueryVariants } from "../src/util/cityExonyms.js";
import { buildMunicipalityResolver, type PlacePoint } from "./lib/stopMunicipality.js";

const APPLY = process.argv.includes("--apply");
const OUT = process.env.FIX_REPORT_DIR ?? ".";
const CHUNK = 2000;
/** Wie nah der Ort sein muss, dessen Name vorn im Label steht. */
const PREFIX_PLACE_RADIUS_M = 5_000;
/** Ohne Gemeinde-Ebene: nur Stadtteile von Städten ab dieser Größe umhängen. */
const BIG_CITY = 500_000;

function fold(v: string): string {
  return v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ß/g, "ss");
}


/**
 * BEGINNT der Rest mit der Stadt (in irgendeiner bekannten Sprache)?
 *
 * Beginnen, nicht nur enthalten: Das Präfix-Skript hat `Stadtteil + Label`
 * gebaut, und die Labels der Quellen beginnen mit dem Ort („Den Haag HS",
 * „Amersfoort, Tulpstraat", „Hardinxveld-Giessendam, …"). Mit „enthalten"
 * wurde aus „Lotschen (b. Blankenhain)" ein „(b. Blankenhain)" — dort ist der
 * Vorsatz der eigentliche Ort und die Klammer nur die Unterscheidung.
 */
function restStartsWithCity(rest: string, city: string): boolean {
  const first = (rest.split(/,| - /)[0] ?? "").trim();
  if (/^\(/.test(first) || /^(b|b\.|bei|bij|pres|près)\s/i.test(first)) return false;
  const norm = (v: string) => fold(v).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const head = ` ${norm(first)} `;
  const firstWordParts = fold(first.split(/\s+/)[0] ?? "").split("-");
  for (const name of [city, ...exonymQueryVariants(city)]) {
    const n = norm(name);
    if (!n) continue;
    if (head.startsWith(` ${n} `)) return true;
    // Zusammengesetzt im ersten Wort: „Hardinxveld-Giessendam" → Giessendam.
    if (!n.includes(" ") && firstWordParts.includes(n)) return true;
  }
  return false;
}

async function main() {
  const t0 = Date.now();
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
  const placeNames = new Set(points.map((p) => fold(p.name)));
  console.log(`[fix] ${points.length} Orte geladen`);

  const stops = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
      country: locations.country,
      lat: locations.latitude,
      lng: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        isNotNull(locations.latitude),
        inArray(locations.type, ["TRAIN", "BUS"]),
        notInArray(
          locations.code,
          BUS_STATIONS.map((b) => b.code),
        ),
      ),
    );
  console.log(`[fix] ${stops.length} Halte geladen`);

  type Change = { code: string; country: string | null; oldLabel: string; newLabel: string; oldCity: string | null; newCity: string | null };
  const changes: Change[] = [];
  const byCountry = new Map<string, { city: number; label: number; total: number }>();
  for (const s of stops) {
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    const stat = byCountry.get(s.country ?? "?") ?? { city: 0, label: 0, total: 0 };
    stat.total++;
    byCountry.set(s.country ?? "?", stat);

    /**
     * Die Stadt wird nur ersetzt, wo der ALTE Wert ein Stadtteil einer Stadt
     * war — der gemeldete Fehler (Wien Hbf in „Matzleinsdorf"). Dörfer
     * behalten ihren Namen: Dort wich die neue Rechnung nur ab, weil GeoNames
     * manche Gemeindesitze nicht kennt oder Fusionen nicht nachgeführt hat
     * („Vlierden → Liessel", „Münsingen → Tägertschi").
     *
     * Ersetzt wird, wenn
     *   • bisher gar keine Stadt da war;
     *   • der alte Ort ein Bezirk einer Stadt-Region ist (Prag, Wien,
     *     Budapest, Berlin, Hamburg — siehe `CITY_REGIONS`);
     *   • der alte Ort ein Stadtteil ist (PPLX/PPLA5) und die neue Stadt ein
     *     Sitz oder ab 20 000 Einwohnern ist — in Ländern ohne Gemeinde-Ebene
     *     (GB, Ungarn, Portugal) erst ab `BIG_CITY` (Fulham → London);
     *   • der alte Ort keine Einwohnerzahl hat und die neue Stadt groß ist
     *     (Cureghem → Brussels);
     *   • der alte Ort in einem Land mit Gemeinde-Ebene keine eigene Gemeinde
     *     ist und zu einer Großstadt gehört (Pian del Lot → Turin,
     *     Posillipo → Naples).
     */
    const found = resolver.municipalityForStop(s.label, lat, lng);
    let newCity = s.city;
    if (found && found.name !== s.city) {
      const leveled = resolver.hasMunicipalityLevel(s.country);
      const oldPlace = s.city
        ? resolver
            .placesNear(lat, lng, 10_000)
            .find(({ place: p }) => fold(p.name) === fold(s.city!))?.place
        : undefined;
      const solid = resolver.isSeat(found) || found.population >= 20_000;
      if (!s.city) {
        newCity = found.name;
      } else if (oldPlace && resolver.cityRegionOf(oldPlace)?.name === found.name) {
        // Bezirk einer Stadt-Region (Jinonice → Prague).
        newCity = found.name;
      } else if (oldPlace && resolver.isSection(oldPlace)) {
        if (leveled ? solid : found.population >= BIG_CITY) newCity = found.name;
      } else if (oldPlace && oldPlace.population === 0 && found.population >= 100_000) {
        if (leveled || found.population >= BIG_CITY) newCity = found.name;
      } else if (
        oldPlace &&
        leveled &&
        !resolver.isOwnMunicipality(oldPlace) &&
        resolver.isSeat(found) &&
        found.population >= 100_000
      ) {
        newCity = found.name;
      }
    }

    // Vorangestellter Stadtteil? Längster Vorsatz aus 1–4 Wörtern.
    let newLabel = s.label;
    const words = s.label.split(" ");
    for (let n = Math.min(4, words.length - 1); n >= 1; n--) {
      const prefix = words.slice(0, n).join(" ");
      if (!placeNames.has(fold(prefix))) continue;
      const rest = words.slice(n).join(" ").trim();
      if (rest.replace(/[^\p{L}]/gu, "").length < 3) continue;
      if (!newCity || fold(prefix) === fold(newCity)) continue;
      if (!restStartsWithCity(rest, newCity)) continue;
      const place = resolver
        .placesNear(lat, lng, PREFIX_PLACE_RADIUS_M)
        .find(({ place: p }) => fold(p.name) === fold(prefix))?.place;
      if (!place || resolver.isOwnMunicipality(place)) continue;
      newLabel = rest;
      break;
    }

    const cityChanged = newCity !== s.city;
    const labelChanged = newLabel !== s.label;
    if (!cityChanged && !labelChanged) continue;
    if (cityChanged) stat.city++;
    if (labelChanged) stat.label++;
    changes.push({ code: s.code, country: s.country, oldLabel: s.label, newLabel, oldCity: s.city, newCity });
  }

  const pick = <T,>(arr: T[], n: number) => {
    const out: T[] = [];
    const step = Math.max(1, Math.floor(arr.length / n));
    for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]!);
    return out;
  };
  const watch = ["sta:8103000", "sta:8000207", "sta:8000261", "sta:8000584", "sta:8400280", "sta:8814001", "sta:8600626"];
  const report = {
    total: stops.length,
    changed: changes.length,
    cityChanged: changes.filter((c) => c.oldCity !== c.newCity).length,
    labelChanged: changes.filter((c) => c.oldLabel !== c.newLabel).length,
    byCountry: Object.fromEntries([...byCountry].sort((a, b) => b[1].total - a[1].total)),
    watch: stops
      .filter((s) => watch.includes(s.code))
      .map((s) => changes.find((c) => c.code === s.code) ?? { code: s.code, unchanged: `${s.label} [${s.city}]` }),
    sampleCity: pick(changes.filter((c) => c.oldCity !== c.newCity), 60),
    sampleLabel: pick(changes.filter((c) => c.oldLabel !== c.newLabel), 80),
  };
  writeFileSync(`${OUT}/fix-stop-cities.report.json`, JSON.stringify(report, null, 1));
  console.log(
    `[fix] ${changes.length} Änderungen (Stadt ${report.cityChanged}, Label ${report.labelChanged}) — Bericht: ${OUT}/fix-stop-cities.report.json (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
  );
  if (!APPLY) process.exit(0);

  const backup = `${OUT}/fix-stop-cities.backup-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(changes.map((c) => ({ code: c.code, label: c.oldLabel, city: c.oldCity }))));
  console.log(`[fix] Sicherung: ${backup}`);
  for (let i = 0; i < changes.length; i += CHUNK) {
    const batch = changes.slice(i, i + CHUNK);
    const codes = batch.map((b) => sql`${b.code}`);
    const labelCases = batch.map((b) => sql`WHEN ${b.code} THEN ${b.newLabel}`);
    const cityCases = batch.map((b) => sql`WHEN ${b.code} THEN ${b.newCity}`);
    await db.execute(sql`
      UPDATE locations
      SET label = CASE code ${sql.join(labelCases, sql` `)} END,
          city = CASE code ${sql.join(cityCases, sql` `)} END
      WHERE code IN (${sql.join(codes, sql`, `)})
    `);
    if ((i / CHUNK) % 25 === 0) console.log(`[fix]   ${Math.min(i + CHUNK, changes.length)} / ${changes.length}`);
  }
  console.log(`[fix] angewendet in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
