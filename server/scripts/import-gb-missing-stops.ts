/**
 * Britische Haltestellen, die der Fahrplan kennt, wir aber nicht (Okt. 2026).
 *
 * Großbritannien kommt in `locations` fast nur aus OSM. Der OSM-Import nimmt
 * nur Halte MIT `name` — in Großbritannien steht der Name oft nur in
 * `naptan:CommonName` (seit Okt. 2026 im Importer berücksichtigt). Folge: Von
 * 302 538 Halten mit Fahrten im britischen Feed (BODS) hatten 64 678 (21 %)
 * keine Haltestelle im Umkreis von 75 m — nicht suchbar, nicht auf der Karte.
 * Regional bis zu 88 % (Neath Port Talbot), Blackpool 85 %, Middlesbrough 75 %.
 *
 * Dieses Skript legt sie aus dem Fahrplan an:
 *   • nur Halte MIT Fahrten, ohne irgendeine Bus-/Bahn-Haltestelle ≤ 50 m;
 *   • Steige eines Busbahnhofs (Kinder einer Station) als EINE Zeile für die
 *     Station, nicht 18 × „Halifax Bus Station";
 *   • Art aus den tatsächlich verkehrenden Linien (Bus/Reisebus → BUS,
 *     Tram/U-Bahn/DLR → TRAIN), Fähren werden ausgelassen;
 *   • Name = NaPTAN-Name; nichtssagende („Bus Station", „Rail Station")
 *     bekommen den nächsten Ort (≤ 8 km) davor;
 *   • Kennung `gtfs:gb:<stop_id>` — die Tafel findet den Halt damit direkt.
 *     Stadt bleibt leer; danach `scripts/enrich-stops-city.ts` laufen lassen.
 *
 *   npx tsx --env-file=.env scripts/import-gb-missing-stops.ts            # Probelauf
 *   npx tsx --env-file=.env scripts/import-gb-missing-stops.ts --apply    # anlegen
 *
 * Mit `--apply` landet die Liste der angelegten Kennungen in GB_OUT (Vorgabe ./)
 * — zurück geht es mit `DELETE FROM locations WHERE code = ANY(<Liste>)`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { applyCountryNames, GB } from "./lib/stopNames.js";

const APPLY = process.argv.includes("--apply");
const OUT = process.env.GB_OUT ?? ".";
const RADIUS_M = Number(process.env.GB_RADIUS_M ?? 50);

interface Cand {
  stop_id: string;
  name: string;
  lat: number;
  lon: number;
  families: string[];
  modes: number[];
}

const GENERIC = /^(bus station|bus stn|coach station|rail station|railway station|station|interchange|bus interchange|stand|stop|bay|terminus|village hall|church|post office|school|the green|village)$/i;
/** Keine Haltestellen, sondern Rufbus-/Flächenzonen („Demand Responsive Area", „Hail and Ride"). */
const NOT_A_STOP = /demand responsive|flexi|hail\s*(and|&|\+|n)?\s*ride|any\s*stop|drt\s*zone/i;

async function main() {
  const t0 = Date.now();
  // Gruppe = Station (falls Kind) bzw. Halt selbst. Lage der Gruppe = Station
  // bzw. Halt. Verkehrsarten aus einer Stichprobe der Fahrten.
  const rows = (
    await pool.query<Cand>(`
      WITH served AS (
        SELECT coalesce(s.parent_station, s.stop_id) AS grp
        FROM gtfs_stops s
        WHERE s.feed_id = 'gb-gtfs' AND coalesce(s.location_type, 0) = 0
        GROUP BY 1
      ), g AS (
        SELECT sv.grp, gs.name, gs.latitude::float8 AS lat, gs.longitude::float8 AS lon
        FROM served sv JOIN gtfs_stops gs ON gs.feed_id = 'gb-gtfs' AND gs.stop_id = sv.grp
        WHERE gs.latitude IS NOT NULL AND abs(gs.latitude) > 1
      ), missing AS (
        SELECT g.* FROM g
        WHERE NOT EXISTS (
          SELECT 1 FROM locations l
          WHERE l.latitude BETWEEN (g.lat - ${RADIUS_M / 111_000})::numeric AND (g.lat + ${RADIUS_M / 111_000})::numeric
            AND l.longitude BETWEEN (g.lon - ${RADIUS_M / 111_000} / cos(radians(g.lat)))::numeric
                               AND (g.lon + ${RADIUS_M / 111_000} / cos(radians(g.lat)))::numeric
            AND l.type IN ('BUS', 'TRAIN')
            AND 111320 * sqrt(power(l.latitude::float8 - g.lat, 2) + power((l.longitude::float8 - g.lon) * cos(radians(g.lat)), 2)) <= ${RADIUS_M}
        )
      )
      SELECT m.grp AS stop_id, m.name, m.lat, m.lon,
        ARRAY(
          SELECT DISTINCT r.type
          FROM (
            SELECT st.trip_id FROM gtfs_stops c
            CROSS JOIN LATERAL (SELECT trip_id FROM gtfs_stop_times st WHERE st.feed_id = 'gb-gtfs' AND st.stop_id = c.stop_id LIMIT 10) st
            WHERE c.feed_id = 'gb-gtfs' AND (c.stop_id = m.grp OR c.parent_station = m.grp)
            LIMIT 40
          ) x
          JOIN gtfs_trips t ON t.feed_id = 'gb-gtfs' AND t.trip_id = x.trip_id
          JOIN gtfs_routes r ON r.feed_id = 'gb-gtfs' AND r.route_id = t.route_id
        ) AS modes,
        ARRAY[]::text[] AS families
      FROM missing m`)
  ).rows;
  console.log(`[gb-missing] ${rows.length} Halte/Stationen mit Fahrten ohne Haltestelle ≤ ${RADIUS_M} m (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  // Nächster Ort für nichtssagende Namen.
  const places = (
    await pool.query<{ name: string; lat: number; lon: number; population: number }>(
      `SELECT name, latitude::float8 AS lat, longitude::float8 AS lon, coalesce(population, 0) AS population
       FROM cities WHERE country IN ('GB', 'United Kingdom')`,
    )
  ).rows;
  const nearestPlace = (lat: number, lon: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    const cos = Math.cos((lat * Math.PI) / 180);
    for (const p of places) {
      const d = 111_320 * Math.hypot(p.lat - lat, (p.lon - lon) * cos);
      // Größere Orte bevorzugen: 1 km Vorsprung je Zehnerpotenz Einwohner.
      const score = d - 1000 * Math.log10(Math.max(1, p.population));
      if (d <= 8000 && score < bestD) {
        bestD = score;
        best = p.name;
      }
    }
    return best;
  };

  const out: Array<{ code: string; label: string; type: "BUS" | "TRAIN"; subtype: string; kinds: string[]; lat: number; lon: number }> = [];
  let skippedFerry = 0;
  let skippedNoMode = 0;
  let skippedZone = 0;
  for (const r of rows) {
    const modes = (r.modes ?? []).map(Number);
    if (modes.length === 0) {
      skippedNoMode++;
      continue;
    }
    const kinds = new Set<string>();
    for (const m of modes) {
      if (m === 0) kinds.add("tram");
      else if (m === 1) kinds.add("subway");
      else if (m === 2) kinds.add("train");
      else if (m === 4) kinds.add("ferry");
      else if (m === 5 || m === 6 || m === 7) kinds.add("tram");
      else kinds.add("bus");
    }
    if (kinds.size === 1 && kinds.has("ferry")) {
      skippedFerry++;
      continue;
    }
    kinds.delete("ferry");
    const isBus = kinds.has("bus") && kinds.size === 1;
    const subtype = isBus
      ? modes.some((m) => m >= 200 && m < 300) && !modes.includes(3)
        ? "COACH"
        : "BUS"
      : kinds.has("subway")
        ? "SUBWAY"
        : kinds.has("tram")
          ? "TRAM"
          : "SUBURBAN";
    let label = r.name.replace(/\s+/g, " ").trim();
    if (!label) continue;
    if (NOT_A_STOP.test(label)) {
      skippedZone++;
      continue;
    }
    if (GENERIC.test(label)) {
      const place = nearestPlace(r.lat, r.lon);
      if (place) label = `${place} ${label}`;
    }
    out.push({
      code: `gtfs:gb:${r.stop_id}`,
      label,
      type: isBus ? "BUS" : "TRAIN",
      subtype,
      kinds: [...kinds],
      lat: r.lat,
      lon: r.lon,
    });
  }
  const byType = new Map<string, number>();
  for (const o of out) byType.set(`${o.type}/${o.subtype}`, (byType.get(`${o.type}/${o.subtype}`) ?? 0) + 1);
  console.log(
    `[gb-missing] würden angelegt: ${out.length} (${[...byType].map(([k, v]) => `${k} ${v}`).join(", ")}); ` +
      `ausgelassen: ${skippedFerry} nur Fähre, ${skippedZone} Rufbus-Zonen, ${skippedNoMode} ohne erkennbare Linie`,
  );
  const step = Math.max(1, Math.floor(out.length / 15));
  for (let i = 0; i < out.length; i += step) {
    const o = out[i]!;
    console.log(`   ${o.code} «${o.label}» ${o.type}/${o.subtype} ${o.lat.toFixed(5)},${o.lon.toFixed(5)}`);
  }
  if (!APPLY) {
    console.log("[gb-missing] Probelauf — nichts geschrieben.");
    await pool.end();
    return;
  }
  const client = await pool.connect();
  const inserted: string[] = [];
  const file = `${OUT}/import-gb-missing-stops.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < out.length; i += 500) {
      const batch = out.slice(i, i + 500);
      const res = await client.query(
        `INSERT INTO locations (code, label, city, country, type, latitude, longitude, hafas_id, subtype, kinds, source)
         SELECT x.code, x.label, NULL, 'United Kingdom', x.type, x.lat, x.lon, NULL, x.subtype, x.kinds, 'gtfs'
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, label text, type text, lat numeric, lon numeric, subtype text, kinds text[])
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [JSON.stringify(batch)],
      );
      for (const r of res.rows) inserted.push(r.code as string);
    }
    // Die Rücknahme-Liste VOR dem Commit schreiben: Scheitert das Schreiben
    // (Ordner fehlt, Platte voll), wird zurückgerollt, statt angelegte Zeilen
    // ohne Liste zu hinterlassen.
    // Ordner anlegen: Fehlt er, scheiterte das Schreiben — und damit (richtig) die ganze Transaktion.
    mkdirSync(OUT, { recursive: true });
    writeFileSync(file, JSON.stringify(inserted));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  // Anzeigenamen gleich mitsetzen: Die neuen Halte tragen den Fahrplan-Namen
  // schon als Label, aber Zusätze („(N Bound)", „Stand 3") und der Zusatz bei
  // gleichnamigen Nachbarn kommen erst hier dazu (lib/stopNames.ts).
  const named = await applyCountryNames(pool, GB);
  console.log(`[gb-missing] Anzeigenamen: ${named} geändert.`);
  console.log(`[gb-missing] ${inserted.length} angelegt — Liste: ${file}. Jetzt enrich-stops-city.ts laufen lassen.`);
  await pool.end();
}

main().catch((err) => {
  console.error("[gb-missing] fehlgeschlagen:", err);
  process.exit(1);
});
