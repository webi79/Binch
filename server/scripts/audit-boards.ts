/**
 * Vollprüfung der Abfahrts-/Ankunftstafeln über ALLE Haltestellen — nur
 * lesend und nur gegen unsere Datenbank: keine Anfrage an MOTIS, HAFAS oder
 * die Bahn (deren Kontingent gehört der Suche).
 *
 * Jede Tafel live abzufragen hieße über drei Millionen externe Anfragen. Geprüft
 * wird deshalb lückenlos alles, was WIR entscheiden:
 *   • Länder mit eigenem Fahrplan (GB, NL, CZ, BE, FR): Welche Fahrplan-Halte
 *     zeigt die Tafel jeder einzelnen Haltestelle? Dafür läuft `boardStopIds`
 *     (services/gtfsSchedule.ts) — derselbe Code wie im Betrieb, keine
 *     Nachbildung. Auffällig: zugeordnet über die Lage, aber ohne Namensbezug
 *     („falsch zugeordnet"), und im Fahrplan bekannt, aber ohne jede Fahrt.
 *   • Alle übrigen: Hat die Haltestelle, was MOTIS/HAFAS zum Finden braucht
 *     (Lage und Name)?
 *
 *   npx tsx --env-file=.env scripts/audit-boards.ts                       # alles
 *   npx tsx --env-file=.env scripts/audit-boards.ts --country="Netherlands" --limit=2000
 *   npx tsx --env-file=.env scripts/audit-boards.ts --live   # dazu jede Tafel wirklich berechnen
 *
 * `--live` rechnet für jede Haltestelle mit eigener Tafel Abfahrten UND
 * Ankünfte mit `getScheduledStopBoard` aus — dieselbe Funktion wie die Route —
 * und prüft jede Zeile: sortiert, im Zeitfenster (jetzt bis +2 h), mit
 * Richtung, ohne Doppel, und keine Ankunft, deren Herkunft der Halt selbst ist.
 *
 * Auffälligkeiten als CSV nach FIX_OUT (Vorgabe: ./), Zusammenfassung als JSON.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { FEED_ID_BY_COUNTRY, boardStopIds, getScheduledStopBoard, isFeedImported } from "../src/services/gtfsSchedule.js";
import { sameStopByName } from "../src/util/tripStopMatch.js";

const OUT = process.env.FIX_OUT ?? ".";
const ONLY_COUNTRY = process.argv.find((a) => a.startsWith("--country="))?.slice(10).replace(/^"|"$/g, "");
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? "0") || 0;
const LIVE = process.argv.includes("--live");
const PARALLEL = 4;
/** Tafel-Fenster in gtfsSchedule.ts (`WINDOW_MINUTES`) plus Spielraum für die Laufzeit. */
const WINDOW_MS = 122 * 60_000;
const PAGE = 5_000;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

interface Row {
  code: string;
  label: string;
  type: string;
  kinds: string[] | null;
  lat: number | null;
  lon: number | null;
}

// Startet die Datenbank neu, melden ruhende Verbindungen einen Fehler — ohne
// diesen Empfänger beendete das den ganzen Lauf.
pool.on("error", (e) => console.error("[audit-boards] Datenbank-Verbindung:", e.message));

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Bis hierhin ist eine Zuordnung über die Lage derselbe Halt, egal wie er heißt. */
const SAME_SPOT_M = 30;

function meters(la1: number, lo1: number, la2: number, lo2: number): number {
  const rad = Math.PI / 180;
  const dLat = (la2 - la1) * rad;
  const dLon = (lo2 - lo1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

interface LiveStats {
  tafeln: number;
  mitZeilen: number;
  zeilen: number;
  ohneQuelle: number;
  unsortiert: number;
  ausserhalbFenster: number;
  ohneRichtung: number;
  doppelt: number;
  herkunftIstHalt: number;
  fehler: number;
}
const emptyLive = (): LiveStats => ({
  tafeln: 0, mitZeilen: 0, zeilen: 0, ohneQuelle: 0, unsortiert: 0,
  ausserhalbFenster: 0, ohneRichtung: 0, doppelt: 0, herkunftIstHalt: 0, fehler: 0,
});
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Beide Tafeln eines Halts wirklich berechnen und jede Zeile prüfen. */
async function checkLive(country: string, r: Row, st: LiveStats, flagged: string[][]) {
  for (const board of ["departures", "arrivals"] as const) {
    st.tafeln++;
    let res;
    try {
      res = await getScheduledStopBoard({
        stopCode: r.code, country, board, latitude: r.lat, longitude: r.lon,
        label: r.label, type: r.type, kinds: r.kinds,
      });
    } catch (e) {
      st.fehler++;
      flagged.push([country, r.code, r.label, `Tafel ${board}: Fehler`, String(e).slice(0, 120), ""]);
      continue;
    }
    // null = der Feed liefert nichts (Kalender) → die Route fragt MOTIS.
    if (!res) { st.ohneQuelle++; continue; }
    const items = res.results;
    st.zeilen += items.length;
    if (items.length > 0) st.mitZeilen++;
    const now = Date.now();
    const seen = new Set<string>();
    let prev = -Infinity;
    const flag = (what: string, detail: string) => flagged.push([country, r.code, r.label, `Tafel ${board}: ${what}`, detail, ""]);
    for (const it of items) {
      const t = Date.parse(it.plannedTime);
      if (t < prev - 60_000) { st.unsortiert++; flag("nicht nach Zeit sortiert", it.plannedTime); }
      prev = Math.max(prev, t);
      if (!(t >= now - 3 * 60_000 && t <= now + WINDOW_MS)) { st.ausserhalbFenster++; flag("außerhalb des Fensters", it.plannedTime); }
      if (!it.direction?.trim()) { st.ohneRichtung++; flag("ohne Richtung", `${it.line} ${it.plannedTime}`); }
      else if (board === "arrivals" && norm(it.direction) === norm(r.label)) { st.herkunftIstHalt++; flag("Ankunft mit Herkunft = dieser Halt", `${it.line} ${it.plannedTime}`); }
      const key = `${it.line}|${it.plannedTime}|${it.direction}`;
      if (seen.has(key)) { st.doppelt++; flag("doppelte Zeile", key); }
      seen.add(key);
    }
  }
}

async function auditCountry(country: string, feedId: string, flagged: string[][], live: LiveStats) {
  const stats = {
    halte: 0,
    direkt: 0,
    ueberLage: 0,
    eigeneTafel: 0,
    zuMotis: 0,
    ohneNamensbezug: 0,
    ohneFahrten: 0,
    fehler: 0,
  };
  const prefix = `gtfs:${feedId.split("-")[0]}:`;
  let after = "";
  const t0 = Date.now();
  for (;;) {
    const { rows } = await pool.query<Row>(
      `SELECT code, label, type, kinds, latitude::float8 AS lat, longitude::float8 AS lon
         FROM locations
        WHERE country = $1 AND type IN ('BUS', 'TRAIN') AND code > $2
        ORDER BY code LIMIT $3`,
      [country, after, PAGE],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.code;
    let next = 0;
    const work = async () => {
      while (next < rows.length) {
        const r = rows[next++]!;
        stats.halte++;
        const direct = r.code.startsWith(prefix);
        if (direct) stats.direkt++;
        else stats.ueberLage++;
        try {
          const ids = await boardStopIds(feedId, {
            stopCode: r.code,
            latitude: r.lat,
            longitude: r.lon,
            label: r.label,
            type: r.type,
            kinds: r.kinds,
          });
          if (ids.length === 0) {
            stats.zuMotis++;
            continue;
          }
          stats.eigeneTafel++;
          if (LIVE) await checkLive(country, r, live, flagged);
          const { rows: gs } = await pool.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; served: boolean }>(
            `SELECT s.stop_id, s.name, s.latitude::float8 AS lat, s.longitude::float8 AS lon,
                    EXISTS (SELECT 1 FROM gtfs_stop_times st WHERE st.feed_id = s.feed_id AND st.stop_id = s.stop_id) AS served
               FROM gtfs_stops s WHERE s.feed_id = $1 AND s.stop_id = ANY($2)`,
            [feedId, ids],
          );
          if (!gs.some((g) => g.served)) {
            stats.ohneFahrten++;
            flagged.push([country, r.code, r.label, "im Fahrplan, aber ohne jede Fahrt", ids.slice(0, 3).join(" "), ""]);
          }
          const near = direct
            ? undefined
            : gs
                .filter((g) => g.lat != null && g.lon != null && r.lat != null && r.lon != null)
                .map((g) => ({ g, d: meters(r.lat!, r.lon!, g.lat!, g.lon!) }))
                .sort((a, b) => a.d - b.d)[0];
          if (near && near.d > SAME_SPOT_M && !gs.some((g) => sameStopByName(r.label, g.name ?? ""))) {
            stats.ohneNamensbezug++;
            flagged.push([
              country,
              r.code,
              r.label,
              "über die Lage zugeordnet (> 30 m), kein gemeinsames Namenswort",
              `${near.g.stop_id} «${near.g.name}»`,
              String(Math.round(near.d)),
            ]);
          }
        } catch (e) {
          stats.fehler++;
          flagged.push([country, r.code, r.label, "Fehler", String(e).slice(0, 120), ""]);
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, work));
    console.log(`[${country}] ${stats.halte} Halte geprüft (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (LIMIT && stats.halte >= LIMIT) break;
  }
  return stats;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const flagged: string[][] = [];
  const summary: Record<string, unknown> = {};

  // 1) Länder mit eigenem Fahrplan — jede Haltestelle durch `boardStopIds`.
  for (const [country, feedId] of Object.entries(FEED_ID_BY_COUNTRY)) {
    if (ONLY_COUNTRY && country !== ONLY_COUNTRY) continue;
    if (!(await isFeedImported(feedId))) continue;
    const live = emptyLive();
    summary[country] = { ...(await auditCountry(country, feedId, flagged, live)), ...(LIVE ? { live } : {}) };
    console.log(country, JSON.stringify(summary[country]));
  }

  // 2) Alle übrigen: Voraussetzungen der externen Quelle (Lage + Name).
  if (!ONLY_COUNTRY) {
    const local = Object.keys(summary);
    const { rows } = await pool.query<{ country: string | null; halte: string; ohne_lage: string; ohne_name: string }>(
      `SELECT country, count(*) AS halte,
              count(*) FILTER (WHERE latitude IS NULL OR longitude IS NULL) AS ohne_lage,
              count(*) FILTER (WHERE coalesce(btrim(label), '') = '') AS ohne_name
         FROM locations
        WHERE type IN ('BUS', 'TRAIN') AND NOT (country = ANY($1))
        GROUP BY country ORDER BY count(*) DESC`,
      [local],
    );
    summary.extern = rows.map((r) => ({ land: r.country, halte: Number(r.halte), ohneLage: Number(r.ohne_lage), ohneName: Number(r.ohne_name) }));
  }

  writeFileSync(`${OUT}/audit-boards.${STAMP}.json`, JSON.stringify(summary, null, 1));
  writeFileSync(
    `${OUT}/audit-boards.${STAMP}.csv`,
    [["land", "code", "label", "befund", "fahrplan_halt", "abstand_m"], ...flagged].map((r) => r.map(csvCell).join(",")).join("\n"),
  );
  console.log(`\nAuffälligkeiten: ${flagged.length} → ${OUT}/audit-boards.${STAMP}.csv`);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
