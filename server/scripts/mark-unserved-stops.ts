/**
 * Halte ohne Bedienung ausblenden (Okt. 2026) — `locations.unserved_at`. Karte und Suche zeigen
 * sie nicht mehr; gespeicherte Stationen, Verlauf und Tafeln finden sie weiter über den Code.
 *
 * Der Plan (JSON `[{code, name, country, fam}]`) kommt aus
 * `~/binch-backups/stops-audit-2026-10-22/unserved_plan.py`: Bus- und Tramhalte in Gebieten mit
 * vollständigem Fahrplan (DE, NL, CH, England), an denen kein Mast ihrer Art in 50 m steht und
 * auch kein gleichnamiger in 300 m. Nur OSM-Zeilen und Fahrplan-Zeilen, die kein aktueller
 * Fahrplan mehr führt — nie DB-Kennungen (StaDa), Steige oder Stationen mit Steigen.
 *
 * Abgleich: Plan-Zeilen werden markiert (sofern noch nicht); markierte Zeilen, die NICHT mehr im
 * Plan stehen, werden wieder sichtbar — dort fährt inzwischen etwas.
 *
 * PROBELAUF IST DIE VORGABE.
 *   FIX_OUT=… npx tsx --env-file=.env scripts/mark-unserved-stops.ts --plan=unserved-plan.json
 *   FIX_OUT=… npx tsx --env-file=.env scripts/mark-unserved-stops.ts --plan=unserved-plan.json --apply
 *   FIX_OUT=… npx tsx --env-file=.env scripts/mark-unserved-stops.ts --undo=<FIX_OUT>/unserved-backup-….json --apply
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PLAN = arg("plan");
const UNDO = arg("undo");
const OUT = process.env.FIX_OUT;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

interface PlanEntry {
  code: string;
  name: string;
  country: string;
  fam: string;
}

async function main() {
  if (!OUT) throw new Error("FIX_OUT fehlt — Bericht und Sicherung gehören nicht ins Repo.");
  mkdirSync(OUT, { recursive: true });

  if (UNDO) {
    const saved = JSON.parse(readFileSync(UNDO, "utf-8")) as Array<{ code: string; unserved_at: string | null }>;
    console.log(`Rücknahme: ${saved.length} Zeilen aus ${UNDO}`);
    if (!APPLY) return console.log("Probelauf — mit --apply zurücksetzen.");
    const res = await pool.query(
      `UPDATE locations l SET unserved_at = x.unserved_at
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, unserved_at timestamptz)
        WHERE l.code = x.code`,
      [JSON.stringify(saved)],
    );
    return console.log(`${res.rowCount} Zeilen zurückgesetzt.`);
  }

  if (!PLAN) throw new Error("--plan=<datei.json> fehlt");
  const plan = JSON.parse(readFileSync(PLAN, "utf-8")) as PlanEntry[];
  for (const e of plan) {
    if (!e.code.startsWith("osm:") && !e.code.startsWith("gtfs:")) throw new Error(`Nur OSM- und Fahrplan-Zeilen: ${e.code}`);
  }
  const { rows } = await pool.query<{
    code: string;
    type: string;
    subtype: string | null;
    hafas: boolean;
    parent: boolean;
    stands: boolean;
    unserved: boolean;
  }>(
    `SELECT l.code, l.type, l.subtype, l.hafas_id IS NOT NULL AS hafas, l.parent_code IS NOT NULL AS parent,
            EXISTS (SELECT 1 FROM locations s WHERE s.parent_code = l.code) AS stands, l.unserved_at IS NOT NULL AS unserved
       FROM locations l WHERE l.code = ANY($1::text[])`,
    [plan.map((e) => e.code)],
  );
  const now = new Map(rows.map((r) => [r.code, r]));
  const why = new Map<string, number>();
  const count = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  const mark: string[] = [];
  const perCountry = new Map<string, number>();
  for (const e of plan) {
    const r = now.get(e.code);
    if (!r) count("fehlt");
    else if (r.hafas) count("DB-Kennung — bleibt sichtbar");
    else if (r.parent || r.stands) count("Steig bzw. Station mit Steigen — bleibt");
    else if (r.type !== "BUS" || !["BUS", "COACH", "TRAM", null].includes(r.subtype)) count("nicht Bus/Tram — bleibt");
    else {
      if (r.unserved) count("schon ausgeblendet");
      else count("wird ausgeblendet");
      mark.push(e.code);
      perCountry.set(e.country, (perCountry.get(e.country) ?? 0) + 1);
    }
  }
  const { rows: back } = await pool.query<{ code: string; name: string }>(
    `SELECT code, coalesce(display_name, label) AS name FROM locations WHERE unserved_at IS NOT NULL AND NOT (code = ANY($1::text[]))`,
    [mark],
  );
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${n}`);
  console.log(`  je Land: ${[...perCountry].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  console.log(`  wieder sichtbar (fährt jetzt etwas): ${back.length}`);
  const file = `${OUT}/unserved-plan-${STAMP}.csv`;
  writeFileSync(
    file,
    ["code,name,land,art"].concat(plan.filter((e) => mark.includes(e.code)).map((e) => `${e.code},"${e.name.replace(/"/g, '""')}",${e.country},${e.fam}`)).join("\n") + "\n",
  );
  console.log(`Bericht: ${file}`);
  if (!APPLY) return console.log("Probelauf — mit --apply einspielen.");
  // Ein Plan nur aus den SICHTBAREN Zeilen (ausgeblendete fehlen darin) machte alles wieder sichtbar.
  if (back.length > 500 && !process.argv.includes("--allow-unhide")) {
    throw new Error(`${back.length} Zeilen würden wieder sichtbar — Plan aus ALLEN Zeilen gerechnet? Sonst --allow-unhide.`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const backup = await client.query(
      `SELECT code, unserved_at FROM locations WHERE code = ANY($1::text[]) OR unserved_at IS NOT NULL FOR UPDATE`,
      [mark],
    );
    const backupFile = `${OUT}/unserved-backup-${STAMP}.json`;
    writeFileSync(backupFile, JSON.stringify(backup.rows));
    console.log(`Sicherung: ${backupFile}`);
    const on = await client.query(`UPDATE locations SET unserved_at = now() WHERE code = ANY($1::text[]) AND unserved_at IS NULL`, [mark]);
    const off = await client.query(
      `UPDATE locations SET unserved_at = NULL WHERE unserved_at IS NOT NULL AND NOT (code = ANY($1::text[]))`,
      [mark],
    );
    await client.query("COMMIT");
    console.log(`Eingespielt: ${on.rowCount} ausgeblendet, ${off.rowCount} wieder sichtbar.`);
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
