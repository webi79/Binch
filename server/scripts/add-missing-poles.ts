/**
 * Masten mit Fahrten anlegen, die es bei uns GAR NICHT gibt (Okt. 2026). Der Plan kommt aus
 * `~/binch-backups/stops-audit-2026-10-22/missing_poles_plan.py`: kein Marker ihrer Art in 30 m,
 * keine gleichnamige Zeile in 90 m, keine Zeile überhaupt in 10 m (Prüfung gegen den Fahrplan).
 *
 * Meist grenznahe Halte aus gtfs.de: Der Import überspringt Halte im Ausland („kommt durch den
 * Feed des Landes") — nur gibt es für Polen, Belgien, Tschechien … keinen landesweiten Feed, und
 * dort fehlten sie ganz („Czernica, OSP", „Bliesransbach Abzweigung"). Dazu deutsche Halte, die die
 * Dublettenprüfung des Imports wegen eines gleichnamigen Halts weiter weg verworfen hatte.
 *
 * Wie im Import: Kennung `<präfix><feed-kennung>`, ist sie belegt (auch von einer entfernten
 * Zeile, `location_replacements`) → „n" davor; Art, Unterart und Arten aus den Fahrten
 * (`gtfsModes.ts`), Land des nächsten Orts (siehe unten), Name = Fahrplan-Name (auch als
 * `source_name`); nur Bus- und Tram-Masten. Stadt und
 * Anzeigenamen danach mit enrich-stops-city.ts bzw. fix-stop-names.ts.
 *
 * PROBELAUF IST DIE VORGABE.
 *   FIX_OUT=… npx tsx --env-file=.env scripts/add-missing-poles.ts --plan=missing-poles-plan.json
 *   FIX_OUT=… npx tsx --env-file=.env scripts/add-missing-poles.ts --plan=missing-poles-plan.json --apply
 * Zurück: `DELETE FROM locations WHERE code = ANY(…)` mit der Liste aus FIX_OUT.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { countryFromCoord, countryFromZone } from "../src/lib/country-from-coord.js";
import { dominantSubtype, kindsForStop, subtypeToType, type Subtype } from "./lib/gtfsModes.js";

const APPLY = process.argv.includes("--apply");
const PLAN = process.argv.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
const OUT = process.env.FIX_OUT;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

/** Feed des Prüfprogramms → Präfix wie in stops-feeds.conf. Großbritannien hat sein eigenes Skript. */
const PREFIX: Record<string, string> = {
  de: "gtfs:de:", fr: "gtfs:fr:", cz: "gtfs:cz:", pl: "gtfs:pl:", be: "gtfs:be:", at: "gtfs:at:", ch: "gtfs:ch:", nl: "gtfs:nl:",
};

interface PlanEntry {
  feed: string;
  id: string;
  name: string;
  lat: number;
  lon: number;
  country: string;
  /** Fahrten je Familie (rail/subway/tram/bus/ferry) und deren häufigste Unterart. */
  fcounts: Record<string, number>;
  fsub: Record<string, string>;
}

async function main() {
  if (!OUT) throw new Error("FIX_OUT fehlt — Bericht und Sicherung gehören nicht ins Repo.");
  if (!PLAN) throw new Error("--plan=<datei.json> fehlt");
  mkdirSync(OUT, { recursive: true });
  const plan = JSON.parse(readFileSync(PLAN, "utf-8")) as PlanEntry[];

  const prefixes = [...new Set(plan.map((e) => PREFIX[e.feed]).filter((p): p is string => !!p))];
  const used = new Set<string>();
  for (const p of prefixes) {
    const { rows } = await pool.query<{ code: string }>(
      `SELECT code FROM locations WHERE code LIKE $1
       UNION SELECT old_code FROM location_replacements WHERE old_code LIKE $1`,
      [`${p}%`],
    );
    for (const r of rows) used.add(r.code);
  }
  const freeCode = (prefix: string, id: string): string | null => {
    const candidates = [`${prefix}${id}`, `${prefix}n${id}`];
    for (let n = 2; candidates.length < 12; n++) candidates.push(`${prefix}n${id}-${n}`);
    const code = candidates.find((c) => c.length <= 64 && !used.has(c)) ?? null;
    if (code) used.add(code);
    return code;
  };

  /**
   * Land = das des nächsten Orts (GeoNames, `cities`, ≤ 15 km) — NICHT Zeitzone oder Grobpolygon.
   * Genau die schnitten die Grenzregionen ab: Für den Import lagen Neureichenau oder Jandelsbrunn
   * im Bayerischen Wald „in Österreich", er übersprang sie als ausländisch — deshalb fehlten sie.
   */
  const places = (await pool.query<{ country: string; lat: number; lon: number }>(
    `SELECT country, latitude::float8 AS lat, longitude::float8 AS lon FROM cities WHERE country IS NOT NULL`,
  )).rows;
  const cell = (lat: number, lon: number) => `${Math.floor(lat / 0.05)}|${Math.floor(lon / 0.05)}`;
  const grid = new Map<string, typeof places>();
  for (const p of places) {
    const k = cell(p.lat, p.lon);
    const l = grid.get(k);
    if (l) l.push(p);
    else grid.set(k, [p]);
  }
  const nearestPlaceCountry = (lat: number, lon: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    const cy = Math.floor(lat / 0.05);
    const cx = Math.floor(lon / 0.05);
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++)
        for (const p of grid.get(`${cy + dy}|${cx + dx}`) ?? []) {
          const x = (p.lon - lon) * Math.cos((lat * Math.PI) / 180) * 111_320;
          const y = (p.lat - lat) * 110_574;
          const d = Math.hypot(x, y);
          if (d < bestD) {
            bestD = d;
            best = p.country;
          }
        }
    return bestD <= 15_000 ? best : null;
  };

  const rows: Array<Record<string, unknown>> = [];
  const report = ["code,name,land,art,unterart,arten,lat,lon"];
  const why = new Map<string, number>();
  const count = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  for (const e of plan) {
    const prefix = PREFIX[e.feed];
    if (!prefix) { count(`Feed ${e.feed} — anderes Skript`); continue; }
    const counts = new Map<Subtype, number>();
    for (const [fam, n] of Object.entries(e.fcounts)) {
      const sub = e.fsub[fam] as Subtype | undefined;
      if (sub && n > 0) counts.set(sub, (counts.get(sub) ?? 0) + n);
    }
    if (counts.size === 0) { count("ohne Fahrten"); continue; }
    const subtype = dominantSubtype(counts);
    // Nur Bus- und Tram-Masten. Hat der Mast auch Bahn, U-Bahn oder Fähre, wäre die neue Zeile ein
    // Bahnhof — neben dem vorhandenen ein zweiter Marker („Dortmund-Aplerbeck": 89 Zug-, 10 Busfahrten).
    if (subtype !== "BUS" && subtype !== "COACH" && subtype !== "TRAM") { count("Bahnhof/U-Bahn/Fähre — bleibt"); continue; }
    const code = freeCode(prefix, e.id);
    if (!code) { count("keine freie Kennung"); continue; }
    const kinds = kindsForStop(counts);
    const country = nearestPlaceCountry(e.lat, e.lon) ?? e.country ?? countryFromCoord(e.lat, e.lon) ?? countryFromZone(e.lat, e.lon);
    rows.push({
      code, label: e.name, source_name: e.name, country, type: subtypeToType(subtype), subtype, kinds,
      latitude: e.lat.toFixed(6), longitude: e.lon.toFixed(6),
    });
    count(`${country}: ${kinds.join("+")}`);
    report.push([code, `"${e.name.replace(/"/g, '""')}"`, country, subtypeToType(subtype), subtype, kinds.join("+"), e.lat, e.lon].join(","));
  }
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n}`);
  const file = `${OUT}/missing-poles-${STAMP}.csv`;
  writeFileSync(file, report.join("\n") + "\n");
  console.log(`Angelegt würden ${rows.length} Halte — Bericht: ${file}`);
  if (!APPLY) {
    console.log("Probelauf — mit --apply einspielen.");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `INSERT INTO locations (code, label, source_name, country, type, subtype, kinds, latitude, longitude, source)
       SELECT x.code, x.label, x.source_name, x.country, x.type, x.subtype, x.kinds, x.latitude::numeric, x.longitude::numeric, 'gtfs'
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, label text, source_name text, country text, type text,
                                                subtype text, kinds text[], latitude text, longitude text)
       ON CONFLICT (code) DO NOTHING`,
      [JSON.stringify(rows)],
    );
    if (res.rowCount !== rows.length) throw new Error(`Abweichung: ${res.rowCount} angelegt, erwartet ${rows.length}`);
    await client.query("COMMIT");
    const list = `${OUT}/missing-poles-created-${STAMP}.json`;
    writeFileSync(list, JSON.stringify(rows.map((r) => r.code)));
    console.log(`Angelegt: ${res.rowCount} Halte — Liste (zum Zurücknehmen): ${list}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
