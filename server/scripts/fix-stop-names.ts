/**
 * Offizielle Anzeigenamen der Haltestellen (Okt. 2026) — die Regeln stehen in
 * `scripts/lib/stopNames.ts`, hier nur Bestand lesen, vergleichen, schreiben.
 *
 * PROBELAUF IST DIE VORGABE: Ohne `--apply` wird nur gezählt, mit Beispielen
 * ausgegeben und je Abschnitt eine CSV der geplanten Änderungen geschrieben.
 *
 *   npx tsx --env-file=.env scripts/fix-stop-names.ts                         # alle Länder, Probelauf
 *   npx tsx --env-file=.env scripts/fix-stop-names.ts --country="United Kingdom"
 *   npx tsx --env-file=.env scripts/fix-stop-names.ts --only=gbtwin,detail --apply
 *   npx tsx --env-file=.env scripts/fix-stop-names.ts --codes=osm:533803703,osm:533806376
 *
 * `--codes` zeigt für einzelne Halte, was herauskäme (Quelle, Zwilling, Name,
 * Zusatz) — für Stichproben, schreibt nie.
 *
 * `--source-names=<csv>` (Spalten `code,name`): Fahrplan-Namen aus den Berichten
 * eines Abgleichs (`GTFS_REPORT`) — im Probelauf nur im Speicher, mit `--apply`
 * landen sie in `source_name` (Abschnitt `source`). Sonst füllt die Spalte der
 * Monatsabgleich selbst.
 *
 * Mit `--apply` je Abschnitt EINE Transaktion; vorher landen die betroffenen
 * Zeilen vollständig als JSON in FIX_OUT (Vorgabe: ./). `label` wird nie
 * angefasst — zurück geht es mit `display_name`/`display_detail` aus der
 * Sicherung (oder NULL: dann gilt wieder `label`).
 *
 * Abschnitte:
 *   gbtwin  — GB: Name des Fahrplan-Zwillings (BODS = NaPTAN, wie die Zeitleiste)
 *   gbclean — GB: Quellname ohne Ort-Vorsatz, Straßenseite, Richtung, Halt-Buchstabe
 *   nltwin  — NL: Name des Fahrplan-Zwillings (OVapi, „Ort, Halt")
 *   source  — `source_name` aus `--source-names` übernehmen
 *   fahrplan — Name aus dem aktuellen Fahrplan statt aus `label` („Hbf Nord" → „Hauptbahnhof Nord")
 *   steig   — Steige tragen den Namen ihrer Station
 *   clean   — übrige Länder: ohne Fahrtrichtung, Steig, Mastnummer, Bedarfshalt
 *   detail  — Zusatz bei gleichnamigen Nachbarn (≤ 400 m, gleiche Art)
 *   reset   — Anzeigenamen, die nach den Regeln nicht mehr gelten (→ NULL)
 *
 * Läuft auch im monatlichen Abgleich (refresh-stops.sh) — dann fallen nur die
 * neuen bzw. geänderten Halte an.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { computeCountryNames, displayNameValue, type NameDecision } from "./lib/stopNames.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ONLY = (arg("only") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ONLY_COUNTRY = arg("country");
const CODES = (arg("codes") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.FIX_OUT ?? ".";
const SOURCE_NAMES_FILE = arg("source-names");
/** code → Name im Fahrplan (zweispaltige CSV mit Kopfzeile `code,name`). */
function readSourceNames(file: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = readFileSync(file, "utf-8").split("\n").slice(1);
  for (const line of lines) {
    if (!line) continue;
    const comma = line.indexOf(",");
    let name = line.slice(comma + 1);
    if (name.startsWith('"')) name = name.slice(1, -1).replace(/""/g, '"');
    out.set(line.slice(0, comma), name);
  }
  return out;
}
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

type SectionId = "source" | "gbtwin" | "gbclean" | "nltwin" | "fahrplan" | "steig" | "clean" | "detail" | "reset";
const SECTIONS: Array<{ id: SectionId; title: string; column: "display_name" | "display_detail" | "source_name" }> = [
  { id: "source", title: "Fahrplan-Namen in source_name übernehmen", column: "source_name" },
  { id: "gbtwin", title: "GB: Name des Fahrplan-Zwillings (NaPTAN)", column: "display_name" },
  { id: "gbclean", title: "GB: Quellname ohne Ort-Vorsatz, Seite, Richtung, Halt-Buchstabe", column: "display_name" },
  { id: "nltwin", title: "NL: Name des Fahrplan-Zwillings („Ort, Halt“)", column: "display_name" },
  { id: "fahrplan", title: "Name aus dem aktuellen Fahrplan statt aus label", column: "display_name" },
  { id: "steig", title: "Steige tragen den Namen ihrer Station", column: "display_name" },
  { id: "clean", title: "Übrige Länder: ohne Fahrtrichtung, Steig, Mastnummer, Bedarfshalt", column: "display_name" },
  { id: "reset", title: "Anzeigenamen, die nicht mehr gelten (→ NULL)", column: "display_name" },
  { id: "detail", title: "Zusatz bei gleichnamigen Nachbarn (≤ 400 m, gleiche Art)", column: "display_detail" },
];

interface Change {
  code: string;
  country: string;
  label: string;
  old: string | null;
  value: string | null;
  note?: string;
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Stichprobe: Was käme für diese Halte heraus? */
async function showCodes(codes: string[], sourceNames?: Map<string, string>): Promise<void> {
  const rows = (
    await pool.query<{ code: string; country: string | null }>(`SELECT code, country FROM locations WHERE code = ANY($1)`, [codes])
  ).rows;
  const countries = [...new Set(rows.map((r) => r.country).filter((c): c is string => !!c))];
  for (const country of countries) {
    const { rows: all, decisions, details } = await computeCountryNames(pool, country, { sourceNames });
    for (const r of all.filter((x) => codes.includes(x.code))) {
      const d = decisions.get(r.code)!;
      console.log(`${r.code} [${country}, ${r.type}/${r.subtype ?? "-"}, ${r.source ?? "-"}]`);
      console.log(`   Quelle (label):  «${r.label}»`);
      if (r.sourceName) console.log(`   Fahrplan:        «${r.sourceName}»`);
      if (r.parentCode) console.log(`   Station:         ${r.parentCode}`);
      if (d.twin) console.log(`   Fahrplan-Zwilling: «${d.twin.name}» (${d.twin.stopId}, ${d.twin.d} m, ${d.twin.same ? "gleicher Name" : "gleicher Punkt"})`);
      console.log(`   Anzeigename:     «${d.name}»${d.rule ? ` [${d.rule}]` : " [unverändert]"}`);
      console.log(`   Zusatz:          ${details.get(r.code) ? `«${details.get(r.code)}»` : "— (kein gleichnamiger Nachbar bzw. nichts abgetrennt)"}`);
      console.log(`   jetzt in der DB: display_name=${r.displayName == null ? "NULL" : `«${r.displayName}»`}, display_detail=${r.displayDetail == null ? "NULL" : `«${r.displayDetail}»`}`);
    }
  }
}

async function main() {
  const sourceNames = SOURCE_NAMES_FILE ? readSourceNames(SOURCE_NAMES_FILE) : undefined;
  if (sourceNames) console.log(`[fix-stop-names] ${sourceNames.size} Fahrplan-Namen aus ${SOURCE_NAMES_FILE}`);
  if (CODES.length > 0) {
    await showCodes(CODES, sourceNames);
    await pool.end();
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const countries = ONLY_COUNTRY
    ? [ONLY_COUNTRY]
    : (
        await pool.query<{ country: string }>(
          `SELECT DISTINCT country FROM locations WHERE type IN ('BUS', 'TRAIN') AND country IS NOT NULL ORDER BY 1`,
        )
      ).rows.map((r) => r.country);
  console.log(`[fix-stop-names] ${APPLY ? "ANWENDEN" : "PROBELAUF"} — ${countries.length} Länder`);

  const bySection = new Map<SectionId, Change[]>(SECTIONS.map((s) => [s.id, []]));
  const twinStats = { same: 0, point: 0 };
  for (const country of countries) {
    const t0 = Date.now();
    const original = sourceNames
      ? new Map(
          (
            await pool.query<{ code: string; source_name: string | null }>(
              `SELECT code, source_name FROM locations WHERE country = $1 AND type IN ('BUS', 'TRAIN')`,
              [country],
            )
          ).rows.map((r) => [r.code, r.source_name]),
        )
      : undefined;
    const { rows, decisions, details } = await computeCountryNames(pool, country, { sourceNames });
    let n = 0;
    for (const row of rows) {
      if (original && row.sourceName !== original.get(row.code)) {
        bySection.get("source")!.push({ code: row.code, country, label: row.label, old: original.get(row.code) ?? null, value: row.sourceName });
        n++;
      }
      const d: NameDecision = decisions.get(row.code)!;
      const name = displayNameValue(row, d);
      if (name !== row.displayName) {
        const section: SectionId = name == null ? "reset" : (d.rule ?? "clean");
        const note = d.twin ? `${d.twin.d} m${d.twin.same ? "" : ", anderer Name"}` : undefined;
        if (d.twin && name != null && section !== "gbclean") d.twin.same ? twinStats.same++ : twinStats.point++;
        bySection.get(section)!.push({ code: row.code, country, label: row.label, old: row.displayName, value: name, note });
        n++;
      }
      const detail = details.get(row.code) ?? null;
      if (detail !== row.displayDetail) {
        bySection.get("detail")!.push({
          code: row.code,
          country,
          label: row.label,
          old: row.displayDetail,
          value: detail,
          note: d.name,
        });
        n++;
      }
    }
    if (n > 0) console.log(`   ${country}: ${rows.length} Halte, ${n} Änderungen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  console.log(`   Zwillinge: ${twinStats.same} mit gleichem Namen (≤ 40 m), ${twinStats.point} auf demselben Punkt mit anderem Namen (≤ 5 m)`);

  for (const s of SECTIONS) {
    if (ONLY.length > 0 && !ONLY.includes(s.id)) continue;
    const changes = bySection.get(s.id)!;
    const perCountry = new Map<string, number>();
    for (const c of changes) perCountry.set(c.country, (perCountry.get(c.country) ?? 0) + 1);
    console.log(`\n== ${s.id}: ${s.title} — ${changes.length} Änderungen`);
    if (perCountry.size > 0) {
      console.log(`   je Land: ${[...perCountry].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    const step = Math.max(1, Math.floor(changes.length / 20));
    for (let i = 0; i < changes.length; i += step) {
      const c = changes[i]!;
      if (s.column === "display_detail") {
        console.log(`   ${c.code}: «${c.note}» + Zusatz ${c.value == null ? "— (entfällt)" : `«${c.value}»`}   [Quelle «${c.label}»]`);
      } else {
        console.log(`   ${c.code}: «${c.label}» → ${c.value == null ? "(Quelle)" : `«${c.value}»`}${c.note ? ` [${c.note}]` : ""}`);
      }
    }
    writeFileSync(
      `${OUT}/fix-stop-names.${s.id}.${STAMP}.csv`,
      ["code,country,label,old,new,note"]
        .concat(changes.map((c) => [c.code, c.country, c.label, c.old, c.value, c.note].map(csvCell).join(",")))
        .join("\n"),
    );
    if (!APPLY || changes.length === 0) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const codes = changes.map((c) => c.code);
      const backup: unknown[] = [];
      for (let i = 0; i < codes.length; i += 20_000) {
        const r = await client.query(`SELECT * FROM locations WHERE code = ANY($1)`, [codes.slice(i, i + 20_000)]);
        backup.push(...r.rows);
      }
      const file = `${OUT}/fix-stop-names.${s.id}.backup-${STAMP}.json`;
      // Sicherung VOR dem Schreiben — scheitert sie, wird nichts geändert.
      writeFileSync(file, JSON.stringify(backup));
      for (let i = 0; i < changes.length; i += 5000) {
        await client.query(
          `UPDATE locations l SET ${s.column} = x.value
           FROM jsonb_to_recordset($1::jsonb) AS x(code text, value text)
           WHERE l.code = x.code`,
          [JSON.stringify(changes.slice(i, i + 5000).map((c) => ({ code: c.code, value: c.value })))],
        );
      }
      await client.query("COMMIT");
      console.log(`   angewendet (Sicherung: ${file})`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error("[fix-stop-names] fehlgeschlagen:", err);
  process.exit(1);
});
