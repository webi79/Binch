/**
 * Falsche Verkehrsart korrigieren (Okt. 2026). Eine Zeile behauptet eine Art, die der Fahrplan
 * dort nicht kennt, während daneben ein gleichnamiger Mast einer anderen Art steht — „Bollion
 * village" ist ein Bushalt, gespeichert als Bahnhof: Die Tafel filtert nach `kinds` und blieb leer.
 *
 * Der Plan (JSON `[{code, old: {type, subtype, kinds}, new: {…}, pole, d}]`) kommt aus
 * `~/binch-backups/stops-audit-2026-10-22/mode_plan.py` (Beweis aus dem Fahrplan). Geschrieben
 * wird nur, wo die Zeile JETZT noch genau den alten Stand hat.
 *
 * Zweiter Plan derselben Form: `kinds_plan.py` — Arten an geteilten Masten (Bus an einem Tramhalt,
 * dessen Busse die Tafel bisher wegfilterte). Nur ERGÄNZEN (Art und Unterart gleich, nichts fällt
 * weg) darf auch ein Steig; seine Station bekommt dieselbe Art dazu — sie führt die Arten aller
 * Steige, und ihre Tafel filtert genauso.
 *
 * PROBELAUF IST DIE VORGABE.
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-modes.ts --plan=mode-plan.json
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-modes.ts --plan=mode-plan.json --apply
 *   FIX_OUT=… npx tsx --env-file=.env scripts/fix-stop-modes.ts --undo=<FIX_OUT>/modes-backup-….json --apply
 *
 * Mit `--apply` EINE Transaktion; vorher landen type/subtype/kinds aller Zeilen als JSON in FIX_OUT.
 * Danach: Stationen mit Steigen übernehmen ihre Arten aus den Steigen ohnehin beim nächsten Abgleich.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PLAN = arg("plan");
const UNDO = arg("undo");
const OUT = process.env.FIX_OUT;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

interface Mode {
  type: string;
  subtype: string | null;
  kinds: string[];
}
interface PlanEntry {
  code: string;
  name: string;
  old: Mode;
  new: Mode;
  pole: string;
  d: number;
}

const TYPES = new Set(["TRAIN", "BUS"]);
const SUBTYPES = new Set(["LONG_DISTANCE", "REGIONAL", "SUBURBAN", "SUBWAY", "TRAM", "BUS", "COACH", "FERRY"]);
const KINDS = new Set(["train", "subway", "tram", "bus", "ferry"]);
const same = (a: string[] | null, b: string[]) => (a ?? []).join(" ") === b.join(" ");
/** Kommt nur eine Art dazu (Art und Unterart gleich, nichts fällt weg)? Das darf auch ein Steig. */
const addsKindsOnly = (e: PlanEntry) =>
  e.new.type === e.old.type &&
  (e.new.subtype ?? null) === (e.old.subtype ?? null) &&
  e.old.kinds.every((k) => e.new.kinds.includes(k));

async function write(changes: Array<{ code: string; to: Mode }>, label: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const codes = changes.map((c) => c.code);
    const backup = await client.query(
      `SELECT code, type, subtype, kinds FROM locations WHERE code = ANY($1::text[]) ORDER BY code FOR UPDATE`,
      [codes],
    );
    const file = `${OUT}/modes-backup-${STAMP}.json`;
    writeFileSync(
      file,
      JSON.stringify(backup.rows.map((r) => ({ code: r.code, new: { type: r.type, subtype: r.subtype, kinds: r.kinds ?? [] } }))),
    );
    console.log(`Sicherung: ${file}`);
    const res = await client.query(
      `UPDATE locations l SET type = x.type, subtype = x.subtype, kinds = x.kinds
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, type text, subtype text, kinds text[])
        WHERE l.code = x.code`,
      [JSON.stringify(changes.map((c) => ({ code: c.code, ...c.to })))],
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
    const saved = JSON.parse(readFileSync(UNDO, "utf-8")) as Array<{ code: string; new: Mode }>;
    console.log(`Rücknahme: ${saved.length} Zeilen aus ${UNDO}`);
    if (APPLY) await write(saved.map((s) => ({ code: s.code, to: s.new })), "Zurückgesetzt");
    else console.log("Probelauf — mit --apply zurücksetzen.");
    return;
  }
  if (!PLAN) throw new Error("--plan=<datei.json> fehlt");
  const plan = JSON.parse(readFileSync(PLAN, "utf-8")) as PlanEntry[];
  for (const e of plan) {
    if (!TYPES.has(e.new.type) || !SUBTYPES.has(e.new.subtype ?? "") || e.new.kinds.length === 0 || !e.new.kinds.every((k) => KINDS.has(k))) {
      throw new Error(`Planeintrag kaputt: ${JSON.stringify(e)}`);
    }
  }
  const { rows } = await pool.query<{ code: string; type: string; subtype: string | null; kinds: string[] | null; parent: boolean; parent_code: string | null; stands: boolean }>(
    `SELECT l.code, l.type, l.subtype, l.kinds, l.parent_code IS NOT NULL AS parent, l.parent_code,
            EXISTS (SELECT 1 FROM locations s WHERE s.parent_code = l.code) AS stands
       FROM locations l WHERE l.code = ANY($1::text[])`,
    [plan.map((e) => e.code)],
  );
  const now = new Map(rows.map((r) => [r.code, r]));
  const why = new Map<string, number>();
  const count = (k: string) => why.set(k, (why.get(k) ?? 0) + 1);
  const changes: Array<{ code: string; to: Mode }> = [];
  const report = ["code,name,alt,neu,fahrplan_mast,abstand_m"];
  for (const e of plan) {
    const r = now.get(e.code);
    if (!r) count("fehlt");
    else if (r.stands || (r.parent && !addsKindsOnly(e))) count("Steig bzw. Station mit Steigen");
    else if (r.type !== e.old.type || (r.subtype ?? null) !== (e.old.subtype ?? null) || !same(r.kinds, e.old.kinds)) count("inzwischen geändert");
    else {
      changes.push({ code: e.code, to: e.new });
      count(`${e.old.kinds.join("+") || e.old.subtype} → ${e.new.kinds.join("+")}`);
      if (r.parent) count("  davon Steige");
      report.push(
        [e.code, `"${e.name.replace(/"/g, '""')}"`, `${e.old.type}/${e.old.subtype}/${e.old.kinds.join("+")}`,
         `${e.new.type}/${e.new.subtype}/${e.new.kinds.join("+")}`, e.pole, e.d].join(","),
      );
    }
  }
  // Die Station eines ergänzten Steigs: dieselbe Art dazu (sie führt die Arten aller Steige).
  const parentAdds = new Map<string, Set<string>>();
  for (const c of changes) {
    const p = now.get(c.code)?.parent_code;
    if (!p) continue;
    const set = parentAdds.get(p) ?? new Set<string>();
    for (const k of c.to.kinds) set.add(k);
    parentAdds.set(p, set);
  }
  if (parentAdds.size > 0) {
    const { rows: parents } = await pool.query<{ code: string; type: string; subtype: string | null; kinds: string[] | null }>(
      `SELECT code, type, subtype, kinds FROM locations WHERE code = ANY($1::text[])`,
      [[...parentAdds.keys()]],
    );
    for (const p of parents) {
      const have = p.kinds ?? [];
      // Ohne eigene Arten (Altbestand) nichts erfinden — das macht der nächste Abgleich.
      if (have.length === 0 || changes.some((c) => c.code === p.code)) continue;
      const add = [...parentAdds.get(p.code)!].filter((k) => !have.includes(k));
      if (add.length === 0) continue;
      changes.push({ code: p.code, to: { type: p.type, subtype: p.subtype, kinds: [...have, ...add] } });
      count("Station: Art ihrer Steige dazu");
      report.push([p.code, "Station", `${p.type}/${p.subtype}/${have.join("+")}`, `${p.type}/${p.subtype}/${[...have, ...add].join("+")}`, "", ""].join(","));
    }
  }
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(34)} ${n}`);
  const file = `${OUT}/modes-plan-${STAMP}.csv`;
  writeFileSync(file, report.join("\n") + "\n");
  console.log(`Geändert würden ${changes.length} Zeilen — Bericht: ${file}`);
  if (!APPLY) {
    console.log("Probelauf — mit --apply einspielen.");
    return;
  }
  await write(changes, "Eingespielt");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
