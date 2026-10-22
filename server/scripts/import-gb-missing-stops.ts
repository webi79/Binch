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
 *   • nur Halte MIT Fahrten, und nur, wo DERSELBE Mast nicht schon steht
 *     (`samePole`: irgendein Halt ≤ 15 m). Bis zum
 *     22.10.2026 hieß es hier „keine Haltestelle ≤ 50 m" — damit fiel jede
 *     Gegenrichtung weg, deren OSM-Mast 20–40 m gegenüber stand: 21 000
 *     Masten fehlten (Vollprüfung ~/binch-backups/stops-audit-2026-10-22);
 *   • Busbahnhöfe (Station mit ≥ 2 Steigen): die Station als Suchtreffer, jeder
 *     Steig als eigener Halt mit eigener Tafel (scripts/lib/gtfsStands.ts) —
 *     OSM-Masten genau dort werden zum Steig statt daneben gedoppelt;
 *   • Art aus den tatsächlich verkehrenden Linien (Bus/Reisebus → BUS,
 *     Tram/U-Bahn/DLR → TRAIN), Fähren werden ausgelassen;
 *   • Name = NaPTAN-Name; nichtssagende („Bus Station", „Rail Station")
 *     bekommen den nächsten Ort (≤ 8 km) davor;
 *   • Kennung `gtfs:gb:<stop_id>` — die Tafel findet den Halt damit direkt.
 *     Stadt bleibt leer; danach `scripts/enrich-stops-city.ts` laufen lassen.
 *
 *   npx tsx --env-file=.env scripts/import-gb-missing-stops.ts            # Probelauf
 *   npx tsx --env-file=.env scripts/import-gb-missing-stops.ts --apply    # anlegen
 *   GB_POLES=<datei> npx tsx --env-file=.env scripts/import-gb-missing-stops.ts [--apply]
 *
 * `GB_POLES` (eine stop_id je Zeile): NUR diese alleinstehenden Masten, und ohne die
 * 15-m-Regel — die Liste kommt aus der eindeutigen Zuordnung Mast ↔ Marker
 * (~/binch-backups/stops-audit-2026-10-22/matching.py): Masten, deren nahe Marker
 * alle schon einem ANDEREN Mast gehören (die Gegenrichtung stand nur 8–15 m daneben).
 * Busbahnhöfe bleiben dabei unberührt.
 *
 * Mit `--apply` landet die Liste der angelegten bzw. zum Steig gemachten
 * Kennungen in GB_OUT (Vorgabe ./) — zurück geht es mit
 * `DELETE FROM locations WHERE code = ANY(<neu>)` und
 * `UPDATE locations SET parent_code = NULL, platform = NULL WHERE code = ANY(<Steig>)`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import { applyCountryNames, GB } from "./lib/stopNames.js";
import { haversineMeters } from "./lib/locationDedup.js";
import { physicalStands, planStands, type FeedChild, type KnownStop } from "./lib/gtfsStands.js";
import type { Subtype } from "./lib/gtfsModes.js";

const APPLY = process.argv.includes("--apply");
const OUT = process.env.GB_OUT ?? ".";
const PREFIX = "gtfs:gb:";
const ONLY = process.env.GB_POLES
  ? new Set(readFileSync(process.env.GB_POLES, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean))
  : null;

interface FeedStop {
  stop_id: string;
  parent: string | null;
  location_type: number;
  name: string;
  lat: number;
  lon: number;
}

const GENERIC = /^(bus station|bus stn|coach station|rail station|railway station|station|interchange|bus interchange|stand|stop|bay|terminus|village hall|church|post office|school|the green|village)$/i;
/** Keine Haltestellen, sondern Rufbus-/Flächenzonen („Demand Responsive Area", „Hail and Ride"). */
const NOT_A_STOP = /demand responsive|flexi|hail\s*(and|&|\+|n)?\s*ride|any\s*stop|drt\s*zone/i;
/** Steig im Namen eines Busbahnhof-Steigs: „Bus Station Stand K", „Rotherham Interchange/B8", „Bay 3". */
const STAND_IN_NAME = /(?:\b(?:stand|bay|stance|stop)\s+|\/)([A-Z]{1,2}\d{0,2}|\d{1,2}[A-Z]?)\s*$/i;

/** GTFS-Linienart → unsere Unterart (für die Zählung je Steig). */
function subtypeOfRouteType(t: number): Subtype {
  if (t === 0 || t === 5 || t === 6 || t === 7 || (t >= 900 && t <= 906)) return "TRAM";
  if (t === 1 || t === 12 || (t >= 401 && t <= 405)) return "SUBWAY";
  if (t === 2 || (t >= 100 && t <= 117)) return "REGIONAL";
  if (t >= 300 && t <= 400) return "SUBURBAN";
  if (t === 4 || (t >= 1000 && t <= 1021)) return "FERRY";
  if (t >= 200 && t <= 209) return "COACH";
  return "BUS";
}

/** Räumliches Verzeichnis (0,001°-Zellen ≈ 110 m) für die Masten-Prüfung. */
class Grid<T extends { lat: number; lng: number }> {
  private cells = new Map<string, T[]>();
  private key(lat: number, lng: number) {
    return `${Math.floor(lat * 1000)},${Math.floor(lng * 1000)}`;
  }
  add(x: T) {
    const k = this.key(x.lat, x.lng);
    const c = this.cells.get(k);
    if (c) c.push(x);
    else this.cells.set(k, [x]);
  }
  near(lat: number, lng: number): T[] {
    const cy = Math.floor(lat * 1000);
    const cx = Math.floor(lng * 1000);
    const out: T[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(this.cells.get(`${cy + dy},${cx + dx}`) ?? []));
    return out;
  }
}

async function main() {
  const t0 = Date.now();
  // Alle Halte des Feeds; „mit Fahrten" prüfen wir unten nur für die Kandidaten.
  const feed = (
    await pool.query<FeedStop>(`
      SELECT stop_id, parent_station AS parent, coalesce(location_type, 0) AS location_type, name,
             latitude AS lat, longitude AS lon
      FROM gtfs_stops
      WHERE feed_id = 'gb-gtfs' AND coalesce(location_type, 0) IN (0, 1)
        AND latitude IS NOT NULL AND abs(latitude) > 1`)
  ).rows;
  const known = (
    await pool.query<KnownStop & { lat: number; lng: number }>(`
      SELECT code, label, display_name AS "displayName", type, subtype, latitude::float8 AS lat, longitude::float8 AS lng,
             source, parent_code AS "parentCode", hafas_id AS "hafasId"
      FROM locations
      WHERE country = 'United Kingdom' AND type IN ('BUS', 'TRAIN') AND latitude IS NOT NULL`)
  ).rows;
  const byCode = new Set(known.map((k) => k.code));
  // Bewusst entfernte Kennungen (location_replacements) nie wieder anlegen.
  for (const r of (await pool.query<{ old_code: string }>(`SELECT old_code FROM location_replacements WHERE old_code LIKE 'gtfs:gb:%'`)).rows) {
    byCode.add(r.old_code);
  }
  const grid = new Grid<KnownStop>();
  for (const k of known) grid.add(k);
  console.log(`[gb-missing] ${feed.length} Halte im Feed, ${known.length} britische Zeilen (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

  /**
   * Steht DERSELBE Mast schon da? In Großbritannien bis 15 m, egal wie
   * benannt: OSM nennt den Mast oft ganz anders als NaPTAN („Station
   * Approach" / „Rugby Club", 6,7 m; „Henry Avenue" / „White Horses Way",
   * 8 m) — der Probelauf vom 22.10.2026 hätte mit Namensprüfung 5 600 solcher
   * Doppelungen angelegt. Die Gegenrichtung steht dagegen fast immer 20 m und
   * mehr gegenüber, mit eigener Tafel — sie kommt dazu.
   */
  const samePole = (_name: string, lat: number, lon: number): boolean => {
    for (const k of grid.near(lat, lon)) {
      if (k.parentCode) continue;
      if (haversineMeters(lat, lon, k.lat, k.lng) <= 15) return true;
    }
    return false;
  };

  const childrenOf = new Map<string, FeedStop[]>();
  const parents = new Map<string, FeedStop>();
  const standalone: FeedStop[] = [];
  for (const s of feed) {
    if (s.location_type === 1) parents.set(s.stop_id, s);
    else if (s.parent) {
      const list = childrenOf.get(s.parent) ?? [];
      list.push(s);
      childrenOf.set(s.parent, list);
    } else standalone.push(s);
  }

  // Kandidaten: alleinstehende Masten ohne Zeile; Stationen werden unten getrennt behandelt.
  const poleCands = standalone.filter(
    (s) =>
      !byCode.has(PREFIX + s.stop_id) &&
      !NOT_A_STOP.test(s.name) &&
      (ONLY ? ONLY.has(s.stop_id) : !samePole(s.name, s.lat, s.lon)),
  );
  const stationIds = ONLY ? [] : [...parents.keys()].filter((id) => (childrenOf.get(id)?.length ?? 0) > 0);
  if (ONLY) console.log(`[gb-missing] Nur Liste: ${ONLY.size} Masten, davon ${poleCands.length} anlegbar`);
  const childIds = stationIds.flatMap((id) => childrenOf.get(id)!.map((c) => c.stop_id));

  /** Linienarten je Halt — Stichprobe aus den Fahrten (wie bisher). */
  const modesOf = new Map<string, number[]>();
  const ids = [...poleCands.map((s) => s.stop_id), ...childIds, ...stationIds];
  for (let i = 0; i < ids.length; i += 2000) {
    const res = await pool.query<{ stop_id: string; modes: number[] }>(
      `SELECT c.stop_id, ARRAY(
         SELECT r.type FROM (
           SELECT st.trip_id FROM gtfs_stop_times st
           WHERE st.feed_id = 'gb-gtfs' AND st.stop_id = c.stop_id LIMIT 10
         ) x
         JOIN gtfs_trips t ON t.feed_id = 'gb-gtfs' AND t.trip_id = x.trip_id
         JOIN gtfs_routes r ON r.feed_id = 'gb-gtfs' AND r.route_id = t.route_id
       ) AS modes
       FROM unnest($1::text[]) AS c(stop_id)`,
      [ids.slice(i, i + 2000)],
    );
    for (const r of res.rows) modesOf.set(r.stop_id, (r.modes ?? []).map(Number));
  }
  console.log(`[gb-missing] Linienarten für ${ids.length} Halte geholt (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

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
  const labelOf = (name: string, lat: number, lon: number): string | null => {
    let label = name.replace(/\s+/g, " ").trim();
    if (!label || NOT_A_STOP.test(label)) return null;
    if (GENERIC.test(label)) {
      const place = nearestPlace(lat, lon);
      if (place) label = `${place} ${label}`;
    }
    return label;
  };
  /** Art aus den Linienarten (wie bisher); null = nichts erkennbar oder nur Fähre. */
  const classify = (modes: number[]) => {
    if (modes.length === 0) return null;
    const kinds = new Set<string>();
    for (const m of modes) {
      const sub = subtypeOfRouteType(m);
      kinds.add(sub === "TRAM" ? "tram" : sub === "SUBWAY" ? "subway" : sub === "REGIONAL" || sub === "SUBURBAN" ? "train" : sub === "FERRY" ? "ferry" : "bus");
    }
    if (kinds.size === 1 && kinds.has("ferry")) return null;
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
    return { type: (isBus ? "BUS" : "TRAIN") as "BUS" | "TRAIN", subtype, kinds: [...kinds] };
  };

  type NewRow = { code: string; label: string; type: "BUS" | "TRAIN"; subtype: string; kinds: string[]; lat: number; lon: number };
  const out: NewRow[] = [];
  let skippedFerry = 0;
  let skippedNoMode = 0;
  for (const s of poleCands) {
    const cls = classify(modesOf.get(s.stop_id) ?? []);
    if (!cls) {
      if ((modesOf.get(s.stop_id) ?? []).length === 0) skippedNoMode++;
      else skippedFerry++;
      continue;
    }
    const label = labelOf(s.name, s.lat, s.lon);
    if (!label) continue;
    out.push({ code: PREFIX + s.stop_id, label, ...cls, lat: s.lat, lon: s.lon });
    // Spätere Kandidaten am selben Punkt (doppelt geführter Mast) sehen ihn schon.
    grid.add({ code: PREFIX + s.stop_id, label, type: cls.type, subtype: cls.subtype, lat: s.lat, lng: s.lon, source: "gtfs", parentCode: null, hafasId: null });
  }

  /**
   * Busbahnhöfe: Station mit ≥ 2 physischen Steigen → Station (falls es sie
   * noch nicht gibt) + Steige. Mit nur einem Steig bleibt es bei EINER Zeile
   * für die Station (wie bisher, wenn dort noch nichts steht).
   */
  const stations = [];
  const stationRows: NewRow[] = [];
  for (const id of stationIds) {
    const p = parents.get(id)!;
    const kids: FeedChild[] = childrenOf.get(id)!.map((c) => ({
      id: c.stop_id,
      name: c.name,
      lat: c.lat,
      lng: c.lon,
      platformCode: STAND_IN_NAME.exec(c.name)?.[1] ?? "",
    }));
    const counts = new Map<string, Map<Subtype, number>>();
    for (const k of kids) {
      const m = new Map<Subtype, number>();
      for (const t of modesOf.get(k.id) ?? []) m.set(subtypeOfRouteType(t), (m.get(subtypeOfRouteType(t)) ?? 0) + 1);
      // Reine Fähranleger bleiben draußen (wie bei den Masten).
      if ([...m.keys()].every((x) => x === "FERRY")) continue;
      m.delete("FERRY");
      counts.set(k.id, m);
    }
    const stands = physicalStands(kids, counts);
    const code = PREFIX + id;
    const allModes = kids.flatMap((k) => modesOf.get(k.id) ?? []);
    const cls = classify(allModes);
    if (!cls) continue;
    const label = labelOf(p.name, p.lat, p.lon);
    if (!label) continue;
    if (stands.length < 2) {
      // Wie bisher: eine Zeile für die Station, nur wo noch nichts steht.
      if (!byCode.has(code) && !samePole(p.name, p.lat, p.lon)) stationRows.push({ code, label, ...cls, lat: p.lat, lon: p.lon });
      continue;
    }
    if (!byCode.has(code)) stationRows.push({ code, label, ...cls, lat: p.lat, lon: p.lon });
    const existing = known.find((k) => k.code === code);
    stations.push({ code, label: existing?.label ?? label, country: GB, city: null, stands });
  }
  const used = new Set(byCode);
  const planned = planStands({
    stations,
    known,
    stationCodes: new Set(stations.map((s) => s.code)),
    linkPrefix: PREFIX,
    newCode: (childId) => {
      let c = PREFIX + childId;
      for (let n = 2; used.has(c); n++) c = `${PREFIX}${childId}-${n}`;
      used.add(c);
      return c;
    },
  });

  const byType = new Map<string, number>();
  for (const o of out) byType.set(`${o.type}/${o.subtype}`, (byType.get(`${o.type}/${o.subtype}`) ?? 0) + 1);
  const by = (a: string) => planned.stands.filter((s) => s.action === a).length;
  console.log(
    `[gb-missing] Masten neu: ${out.length} (${[...byType].map(([k, v]) => `${k} ${v}`).join(", ")}); ` +
      `ausgelassen: ${skippedFerry} nur Fähre, ${skippedNoMode} ohne erkennbare Linie`,
  );
  console.log(
    `[gb-missing] Stationen neu: ${stationRows.length}; Steige an ${stations.length} Busbahnhöfen: ` +
      `${by("new")} neu, ${by("link")} OSM-Masten werden Steig, ${by("update")} aufgefrischt, ${planned.covered} schon vertreten`,
  );
  const step = Math.max(1, Math.floor(out.length / 12));
  for (let i = 0; i < out.length; i += step) {
    const o = out[i]!;
    console.log(`   ${o.code} «${o.label}» ${o.type}/${o.subtype} ${o.lat.toFixed(5)},${o.lon.toFixed(5)}`);
  }
  if (process.env.GB_REPORT) {
    mkdirSync(process.env.GB_REPORT, { recursive: true });
    const csv = (rows: string[][]) =>
      rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
    writeFileSync(
      `${process.env.GB_REPORT}/stations.csv`,
      csv([
        ["feed_code", "code", "aktion", "name", "lat", "lng", "arten"],
        ...[...out, ...stationRows].map((o) => [o.code, o.code, "neu", o.label, o.lat.toFixed(6), o.lon.toFixed(6), o.kinds.join(" ")]),
      ]),
    );
    writeFileSync(
      `${process.env.GB_REPORT}/stands.csv`,
      csv([
        ["station", "code", "aktion", "name", "steig", "unterart", "arten", "lat", "lng", "feed_ids"],
        ...planned.stands.map((s) => [s.parentCode, s.code, s.action, s.label, s.platform ?? "", s.subtype, s.kinds.join(" "), s.latitude, s.longitude, s.feedIds.join(" ")]),
      ]),
    );
  }
  if (!APPLY) {
    console.log("[gb-missing] Probelauf — nichts geschrieben.");
    await pool.end();
    return;
  }
  const client = await pool.connect();
  const inserted: string[] = [];
  const linked: string[] = [];
  const file = `${OUT}/import-gb-missing-stops.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    await client.query("BEGIN");
    const rows = [...out, ...stationRows];
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
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
    for (let i = 0; i < planned.stands.length; i += 500) {
      const batch = planned.stands.slice(i, i + 500);
      const res = await client.query(
        `INSERT INTO locations (code, label, city, country, type, latitude, longitude, hafas_id, subtype, kinds, source, parent_code, platform)
         SELECT x.code, x.label, NULL, 'United Kingdom', x.type, x.lat, x.lon, NULL, x.subtype, x.kinds, 'gtfs', x.parent, x.platform
         FROM jsonb_to_recordset($1::jsonb)
           AS x(code text, label text, type text, lat numeric, lon numeric, subtype text, kinds text[], parent text, platform text)
         ON CONFLICT (code) DO UPDATE SET
           latitude = excluded.latitude, longitude = excluded.longitude,
           parent_code = excluded.parent_code, platform = excluded.platform
         RETURNING code, (xmax = 0) AS is_new`,
        [
          JSON.stringify(
            batch.map((s) => ({
              code: s.code,
              label: s.label,
              type: s.type,
              lat: s.latitude,
              lon: s.longitude,
              subtype: s.subtype,
              kinds: s.kinds,
              parent: s.parentCode,
              platform: s.platform,
            })),
          ),
        ],
      );
      for (const r of res.rows) (r.is_new ? inserted : linked).push(r.code as string);
    }
    // Die Rücknahme-Liste VOR dem Commit schreiben: Scheitert das Schreiben
    // (Ordner fehlt, Platte voll), wird zurückgerollt, statt angelegte Zeilen
    // ohne Liste zu hinterlassen.
    mkdirSync(OUT, { recursive: true });
    writeFileSync(file, JSON.stringify({ neu: inserted, steig: linked }));
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
  console.log(`[gb-missing] ${inserted.length} angelegt, ${linked.length} zum Steig — Liste: ${file}. Jetzt enrich-stops-city.ts laufen lassen.`);
  await pool.end();
}

main().catch((err) => {
  console.error("[gb-missing] fehlgeschlagen:", err);
  process.exit(1);
});
