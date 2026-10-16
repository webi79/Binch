/**
 * Haltestellen ohne Lage — Koordinaten über die MOTIS-Namenssuche nachtragen.
 *
 * Die Vollprüfung aller Tafeln (scripts/audit-boards.ts, Okt. 2026) fand
 * 2 477 Halte ohne Koordinaten, fast alle aus dem DELFI-Import vom Mai 2026
 * („Aying, Untere Dorfstraße"). Ohne Lage findet MOTIS sie nicht: keine Tafel,
 * kein Punkt auf der Karte — aber in der Suche standen sie.
 *
 * NIE den ersten Treffer blind nehmen (siehe motisGeocode, das genau das als
 * Rückfall tut): Übernommen wird nur ein MOTIS-Halt (type STOP) im selben
 * Land, dessen Name nach dem Normalisieren GLEICH ist — und nur, wenn es genau
 * einen solchen gibt. Alles andere bleibt ohne Lage; solche Halte blendet die
 * Ortssuche aus (services/locationService.ts).
 *
 * Langsam (eine Anfrage je Sekunde) — Transitous ist ein Gemeinschaftsdienst.
 * Probelauf ist die Vorgabe; `--apply` schreibt in EINER Transaktion, vorher
 * eine JSON-Sicherung nach FIX_OUT (Vorgabe ./).
 *
 *   npx tsx --env-file=.env scripts/fill-missing-coords.ts [--limit=50] [--apply]
 *
 * WIEDERAUFNAHME: Jedes Ergebnis landet sofort in `FIX_OUT/fill-missing-coords.progress.jsonl`;
 * ein neuer Lauf überspringt, was dort schon steht. Ein Abbruch (Neustart der
 * Sitzung, von Docker) kostet so höchstens die eine laufende Anfrage.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { motisFetch } from "../src/services/motisClient.js";

const OUT = process.env.FIX_OUT ?? ".";
const APPLY = process.argv.includes("--apply");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? "0") || 0;
const PAUSE_MS = 1_000;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const PROGRESS = `${OUT}/fill-missing-coords.progress.jsonl`;

// Startet die Datenbank neu, melden ruhende Verbindungen einen Fehler — ohne
// diesen Empfänger beendete das den ganzen Lauf.
pool.on("error", (e) => console.error("[fill-coords] Datenbank-Verbindung:", e.message));

interface Result { code: string; label: string; status: string; name?: string; lat?: number; lon?: number }

const ISO: Record<string, string> = {
  Germany: "DE", Austria: "AT", Switzerland: "CH", Italy: "IT", France: "FR", Netherlands: "NL",
  Belgium: "BE", Poland: "PL", "Czech Republic": "CZ", Denmark: "DK", Luxembourg: "LU", Spain: "ES",
};

interface Hit { type?: string; name?: string; lat?: number; lon?: number; country?: string }

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ß/g, "ss")
    .replace(/\bstr\b\.?/g, "strasse").replace(/strasse/g, "str").split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { rows } = await pool.query<{ code: string; label: string; country: string | null }>(
    `SELECT code, label, country FROM locations
      WHERE type IN ('BUS', 'TRAIN') AND (latitude IS NULL OR longitude IS NULL)
      ORDER BY code ${LIMIT ? `LIMIT ${LIMIT}` : ""}`,
  );
  const done = new Map<string, Result>();
  if (existsSync(PROGRESS)) {
    for (const line of readFileSync(PROGRESS, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as Result;
      if (!r.status.startsWith("Fehler")) done.set(r.code, r);
    }
  }
  console.log(`[fill-coords] ${APPLY ? "ANWENDEN" : "PROBELAUF"} — ${rows.length} Halte ohne Lage, ${done.size} schon geprüft`);
  const record = (r: Result) => {
    done.set(r.code, r);
    appendFileSync(PROGRESS, JSON.stringify(r) + "\n");
  };
  let i = 0;
  for (const r of rows) {
    i++;
    if (done.has(r.code)) continue;
    let hits: Hit[] = [];
    try {
      const raw = await motisFetch(`/v1/geocode?text=${encodeURIComponent(r.label)}`, AbortSignal.timeout(15_000));
      hits = Array.isArray(raw) ? (raw as Hit[]) : [];
    } catch (e) {
      record({ code: r.code, label: r.label, status: `Fehler: ${String(e).slice(0, 80)}` });
      await sleep(PAUSE_MS);
      continue;
    }
    const iso = r.country ? ISO[r.country] : undefined;
    const exact = hits.filter(
      (h) => h.type === "STOP" && h.lat != null && h.lon != null && h.name &&
        (!iso || h.country?.toUpperCase() === iso) && norm(h.name) === norm(r.label),
    );
    // Gleichnamige Treffer an VERSCHIEDENEN Orten (> 1 km) sind mehrdeutig.
    const spread = exact.length > 1 && exact.some((h) =>
      Math.abs(h.lat! - exact[0]!.lat!) > 0.01 || Math.abs(h.lon! - exact[0]!.lon!) > 0.015);
    if (exact.length >= 1 && !spread) {
      const h = exact[0]!;
      record({ code: r.code, label: r.label, status: "gefunden", name: h.name!, lat: h.lat!, lon: h.lon! });
    } else {
      record({ code: r.code, label: r.label, status: exact.length > 1 ? "mehrdeutig" : "kein gleichnamiger Halt" });
    }
    if (i % 100 === 0) {
      const n = [...done.values()].filter((x) => x.status === "gefunden").length;
      console.log(`[fill-coords] ${i}/${rows.length} — gefunden ${n}`);
    }
    await sleep(PAUSE_MS);
  }
  const wanted = new Set(rows.map((r) => r.code));
  const results = [...done.values()].filter((r) => wanted.has(r.code));
  const found = results
    .filter((r) => r.status === "gefunden")
    .map((r) => ({ code: r.code, label: r.label, lat: r.lat!, lon: r.lon!, name: r.name! }));
  const report: string[][] = [["code", "label", "ergebnis", "motis_name", "lat", "lon"]];
  for (const r of results) report.push([r.code, r.label, r.status, r.name ?? "", r.lat != null ? String(r.lat) : "", r.lon != null ? String(r.lon) : ""]);
  writeFileSync(`${OUT}/fill-missing-coords.${STAMP}.csv`, report.map((r) => r.map(csvCell).join(",")).join("\n"));
  console.log(`[fill-coords] gefunden ${found.length} von ${rows.length} → ${OUT}/fill-missing-coords.${STAMP}.csv`);

  if (APPLY && found.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const backup = await client.query(`SELECT * FROM locations WHERE code = ANY($1)`, [found.map((f) => f.code)]);
      writeFileSync(`${OUT}/fill-missing-coords.backup-${STAMP}.json`, JSON.stringify(backup.rows));
      for (const f of found) {
        await client.query(
          `UPDATE locations SET latitude = $2, longitude = $3 WHERE code = $1 AND (latitude IS NULL OR longitude IS NULL)`,
          [f.code, f.lat, f.lon],
        );
      }
      await client.query("COMMIT");
      console.log(`[fill-coords] ${found.length} Lagen eingetragen`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
