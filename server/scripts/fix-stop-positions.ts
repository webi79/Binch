/**
 * Lage von Haltestellen korrigieren (Okt. 2026). Plan (JSON `[{code, name, old: {lat, lng},
 * new: {lat, lng}, d}]`) aus `~/binch-backups/stops-audit-2026-10-22/position_plan.py`: Stationen
 * mit genau einem physischen Mast stehen auf dem Mast statt auf dem Mittelpunkt, den der Fahrplan
 * der Station gibt (bis 1 km daneben). `import-gtfs.ts` schreibt es künftig selbst so — diese
 * Korrektur muss VOR dem nächsten Abgleich laufen, sonst fände er die Zeile am neuen Ort nicht.
 *
 * Geschrieben wird nur, wo die Zeile JETZT noch am alten Ort steht (± 1 m).
 *
 * PROBELAUF IST DIE VORGABE.
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-positions.ts --plan=position-plan.json
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-positions.ts --plan=position-plan.json --apply
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-positions.ts --undo=<FIX_OUT>/positions-backup-….json --apply
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { haversineMeters } from "./lib/locationDedup.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PLAN = arg("plan");
const UNDO = arg("undo");
const OUT = process.env.FIX_OUT;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

interface Point {
  lat: number;
  lng: number;
}
interface PlanEntry {
  code: string;
  name: string;
  old: Point;
  new: Point;
  d: number;
}

async function write(changes: Array<{ code: string; at: Point }>, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const backup = await client.query(
      `SELECT code, latitude::float8 AS lat, longitude::float8 AS lng FROM locations WHERE code = ANY($1::text[]) ORDER BY code FOR UPDATE`,
      [changes.map((c) => c.code)],
    );
    const file = `${OUT}/positions-backup-${STAMP}.json`;
    writeFileSync(file, JSON.stringify(backup.rows.map((r) => ({ code: r.code, at: { lat: r.lat, lng: r.lng } }))));
    console.log(`Sicherung: ${file}`);
    const res = await client.query(
      `UPDATE locations l SET latitude = round(x.lat::numeric, 6), longitude = round(x.lng::numeric, 6)
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, lat float8, lng float8)
        WHERE l.code = x.code`,
      [JSON.stringify(changes.map((c) => ({ code: c.code, lat: c.at.lat, lng: c.at.lng })))],
    );
    if (res.rowCount !== changes.length) throw new Error(`Abweichung: ${res.rowCount} geschrieben, erwartet ${changes.length}`);
    await client.query("COMMIT");
    console.log(`${label}: ${res.rowCount} Zeilen.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  if (!OUT) throw new Error("FIX_OUT fehlt — Bericht und Sicherung gehören nicht ins Repo.");
  mkdirSync(OUT, { recursive: true });
  if (UNDO) {
    const saved = JSON.parse(readFileSync(UNDO, "utf-8")) as Array<{ code: string; at: Point }>;
    console.log(`Rücknahme: ${saved.length} Zeilen aus ${UNDO}`);
    if (APPLY) await write(saved, "Zurückgesetzt");
    else console.log("Probelauf — mit --apply zurücksetzen.");
    return;
  }
  if (!PLAN) throw new Error("--plan=<datei.json> fehlt");
  const plan = JSON.parse(readFileSync(PLAN, "utf-8")) as PlanEntry[];
  const { rows } = await pool.query<{ code: string; lat: number; lng: number }>(
    `SELECT code, latitude::float8 AS lat, longitude::float8 AS lng FROM locations WHERE code = ANY($1::text[])`,
    [plan.map((e) => e.code)],
  );
  const now = new Map(rows.map((r) => [r.code, r]));
  const why = new Map<string, number>();
  const count = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  const changes: Array<{ code: string; at: Point }> = [];
  const report = ["code,name,abstand_m,alt,neu"];
  for (const e of plan) {
    const r = now.get(e.code);
    if (!r) count("fehlt");
    else if (haversineMeters(r.lat, r.lng, e.old.lat, e.old.lng) > 1) count("steht inzwischen woanders");
    else if (!Number.isFinite(e.new.lat) || !Number.isFinite(e.new.lng) || Math.abs(e.new.lat) < 1) count("neue Lage ungültig");
    else {
      changes.push({ code: e.code, at: e.new });
      count(e.d <= 30 ? "verschoben ≤ 30 m" : e.d <= 100 ? "verschoben 30–100 m" : "verschoben > 100 m");
      report.push(`${e.code},"${e.name.replace(/"/g, '""')}",${e.d},${e.old.lat} ${e.old.lng},${e.new.lat} ${e.new.lng}`);
    }
  }
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n}`);
  const file = `${OUT}/positions-plan-${STAMP}.csv`;
  writeFileSync(file, report.join("\n") + "\n");
  console.log(`Verschoben würden ${changes.length} Zeilen — Bericht: ${file}`);
  if (!APPLY) return console.log("Probelauf — mit --apply einspielen.");
  await write(changes, "Eingespielt");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
