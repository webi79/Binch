/**
 * Prüft (und korrigiert auf Wunsch) die Lage der kuratierten Städte (`type =
 * ALL`, Quelle `src/data/cities.ts`) gegen GeoNames.
 *
 * Anlass (Sept. 2026): Ein Teil der Städte stand an einem falschen Ort —
 * „Granada" bei Barcelona, „San Sebastián" in Sevilla, „Oxford" in London.
 * Die Koordinaten stammten aus einer einmaligen Geokodierung, die offenbar den
 * ersten Treffer blind übernahm. Außerdem hatte `enrich-stops-city.ts` die
 * Spalte `city` der kuratierten Städte mit dem Verwaltungsbezirk an ihrem Punkt
 * überschrieben („Nørrebro" für Kopenhagen).
 *
 * Vorgehen je Stadt:
 *   • Städte mit eigener Lage im Seed (Busbahnhöfe wie „Prag UAN Florenc")
 *     gelten mit DIESER Lage.
 *   • Sonst: GeoNames-Orte im selben Land, deren Name oder Alternativname zum
 *     Namen der Stadt passt (Seed-Name, lokaler Name, Exonyme) — genommen wird
 *     der einwohnerstärkste. Nie „irgendein" Treffer: ohne Namensgleichheit
 *     keine Korrektur, sondern ein Eintrag „ungeklärt" im Bericht.
 *   • Abweichung über `MAX_OFFSET_KM` → Korrektur.
 *   • `city` wird auf den lokalen Namen aus dem Seed zurückgesetzt.
 *
 * GeoNames: https://download.geonames.org/export/dump/cities1000.zip
 * (CC BY 4.0, GeoNames.org). Pfad über GEONAMES_CITIES_PATH.
 *
 * Nur lesen:      npx tsx --env-file=.env scripts/audit-curated-cities.ts
 * Korrigieren:    … --apply   (schreibt vorher eine Sicherung der alten Werte)
 * Bericht:        AUDIT_REPORT_PATH (Vorgabe: ./audit-curated-cities.json)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { CITIES, BUS_STATIONS } from "../src/data/cities.js";
import { exonymQueryVariants } from "../src/util/cityExonyms.js";

const GEONAMES_PATH = process.env.GEONAMES_CITIES_PATH ?? "/tmp/geonames-cities1000.txt";
const REPORT_PATH = process.env.AUDIT_REPORT_PATH ?? "./audit-curated-cities.json";
const APPLY = process.argv.includes("--apply");

/** Ab so viel Abstand zur GeoNames-Lage gilt eine Stadt als falsch verortet. */
const MAX_OFFSET_KM = 15;
/** Busbahnhöfe mit eigener Lage im Seed: ab so viel Abstand wird korrigiert. */
const MAX_SEED_OFFSET_KM = 1;

interface GeoCity {
  name: string;
  lat: number;
  lng: number;
  country: string;
  population: number;
  featureCode: string;
}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLng = r(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function loadGeoNames(): Map<string, GeoCity[]> {
  const byName = new Map<string, GeoCity[]>();
  const text = readFileSync(GEONAMES_PATH, "utf-8");
  for (const line of text.split("\n")) {
    const c = line.split("\t");
    if (c.length < 15 || c[6] !== "P") continue;
    const city: GeoCity = {
      name: c[1]!,
      lat: Number(c[4]),
      lng: Number(c[5]),
      country: c[8]!,
      population: Number(c[14]) || 0,
      featureCode: c[7]!,
    };
    // Stadtteile (PPLX) sind keine Städte — mit ihnen fände „Kopenhagen" etwa
    // einen gleichnamigen Ortsteil woanders.
    if (city.featureCode === "PPLX" || city.featureCode === "PPLH") continue;
    const names = new Set([c[1]!, c[2]!, ...(c[3] ? c[3].split(",") : [])].map(norm));
    for (const n of names) {
      if (!n) continue;
      const list = byName.get(n);
      if (list) list.push(city);
      else byName.set(n, [city]);
    }
  }
  return byName;
}

/** ISO-Land aus dem Code („ES-SSE" → „ES"; „UK" gibt es bei GeoNames als „GB"). */
function isoFromCode(code: string): string {
  const cc = code.split("-")[0]!.toUpperCase();
  return cc === "UK" ? "GB" : cc;
}

async function main() {
  console.log(`[audit] GeoNames aus ${GEONAMES_PATH} …`);
  const geo = loadGeoNames();
  console.log(`[audit]   ${geo.size} Namen`);

  const seedByCode = new Map<string, { name: string; city: string; latitude?: number; longitude?: number }>();
  for (const c of [...CITIES, ...BUS_STATIONS] as Array<{
    code: string;
    name: string;
    city: string;
    latitude?: number;
    longitude?: number;
  }>) {
    seedByCode.set(c.code, c);
  }

  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
      country: locations.country,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(eq(locations.type, "ALL"));
  console.log(`[audit] ${rows.length} kuratierte Städte in der Datenbank`);

  type Verdict = {
    code: string;
    label: string;
    oldCity: string | null;
    newCity: string | null;
    oldLat: number | null;
    oldLng: number | null;
    newLat: number | null;
    newLng: number | null;
    offsetKm: number | null;
    status: "ok" | "fix" | "unresolved" | "seed";
    match?: string;
  };
  const verdicts: Verdict[] = [];

  for (const r of rows) {
    const seed = seedByCode.get(r.code);
    const oldLat = r.latitude != null ? Number(r.latitude) : null;
    const oldLng = r.longitude != null ? Number(r.longitude) : null;
    const newCity = seed?.city ?? r.city;
    const base = {
      code: r.code,
      label: r.label,
      oldCity: r.city,
      newCity,
      oldLat,
      oldLng,
    };

    // Busbahnhöfe mit eigener Lage im Seed.
    if (seed?.latitude != null && seed.longitude != null) {
      const off =
        oldLat != null && oldLng != null
          ? haversineKm(oldLat, oldLng, seed.latitude, seed.longitude)
          : Infinity;
      verdicts.push({
        ...base,
        newLat: seed.latitude,
        newLng: seed.longitude,
        offsetKm: Number.isFinite(off) ? Math.round(off * 10) / 10 : null,
        status: off > MAX_SEED_OFFSET_KM ? "fix" : "seed",
        match: "seed",
      });
      continue;
    }

    const iso = isoFromCode(r.code);
    const names = new Set<string>();
    for (const n of [seed?.name, seed?.city, r.label]) {
      if (!n) continue;
      names.add(norm(n));
      for (const v of exonymQueryVariants(n)) names.add(norm(v));
    }
    let best: GeoCity | null = null;
    let bestName = "";
    for (const n of names) {
      for (const g of geo.get(n) ?? []) {
        if (g.country !== iso) continue;
        if (!best || g.population > best.population) {
          best = g;
          bestName = n;
        }
      }
    }
    if (!best) {
      verdicts.push({ ...base, newLat: null, newLng: null, offsetKm: null, status: "unresolved" });
      continue;
    }
    const off =
      oldLat != null && oldLng != null ? haversineKm(oldLat, oldLng, best.lat, best.lng) : Infinity;
    verdicts.push({
      ...base,
      newLat: best.lat,
      newLng: best.lng,
      offsetKm: Number.isFinite(off) ? Math.round(off * 10) / 10 : null,
      status: off > MAX_OFFSET_KM ? "fix" : "ok",
      match: `${best.name} (${best.featureCode}, ${best.population} Einw., über „${bestName}")`,
    });
  }

  const count = (s: Verdict["status"]) => verdicts.filter((v) => v.status === s).length;
  const cityFixes = verdicts.filter((v) => v.newCity && v.newCity !== v.oldCity).length;
  console.log(
    `[audit] ok ${count("ok")} · Seed-Lage ${count("seed")} · falsch verortet ${count("fix")} · ungeklärt ${count("unresolved")} · Stadtname falsch ${cityFixes}`,
  );
  writeFileSync(REPORT_PATH, JSON.stringify(verdicts, null, 2));
  console.log(`[audit] Bericht: ${REPORT_PATH}`);

  if (!APPLY) {
    process.exit(0);
  }

  // Sicherung der alten Werte VOR dem Schreiben — damit ist jede Korrektur umkehrbar.
  const backupPath = REPORT_PATH.replace(/\.json$/, "") + `.backup-${Date.now()}.json`;
  writeFileSync(
    backupPath,
    JSON.stringify(
      verdicts.map((v) => ({ code: v.code, city: v.oldCity, latitude: v.oldLat, longitude: v.oldLng })),
      null,
      2,
    ),
  );
  console.log(`[audit] Sicherung: ${backupPath}`);

  let written = 0;
  for (const v of verdicts) {
    const set: Partial<typeof locations.$inferInsert> = {};
    if (v.status === "fix" && v.newLat != null && v.newLng != null) {
      set.latitude = v.newLat.toFixed(6);
      set.longitude = v.newLng.toFixed(6);
    }
    if (v.newCity && v.newCity !== v.oldCity) set.city = v.newCity;
    if (Object.keys(set).length === 0) continue;
    await db.update(locations).set(set).where(eq(locations.code, v.code));
    written++;
  }
  console.log(`[audit] ${written} Städte korrigiert`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
