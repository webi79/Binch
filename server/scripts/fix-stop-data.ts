/**
 * Datenkorrekturen aus der Haltestellen-Prüfung (Okt. 2026).
 *
 * PROBELAUF IST DIE VORGABE: Ohne `--apply` wird nur gezählt, mit Beispielen
 * ausgegeben und je Abschnitt eine CSV der geplanten Änderungen geschrieben.
 *
 *   npx tsx --env-file=.env scripts/fix-stop-data.ts                    # alle Abschnitte, Probelauf
 *   npx tsx --env-file=.env scripts/fix-stop-data.ts --only=prefix,dups # nur diese
 *   npx tsx --env-file=.env scripts/fix-stop-data.ts --only=prefix --apply
 *
 * Mit `--apply` je Abschnitt EINE Transaktion; vorher landen die betroffenen
 * Zeilen vollständig als JSON in FIX_OUT (Vorgabe: ./), damit sich alles
 * zurückspielen lässt. Haltestellen, auf die ein Preis-Alarm zeigt
 * (`price_alerts.origin/destination`), werden nie gelöscht.
 *
 * Abschnitte (Einzelheiten jeweils an der Funktion):
 *   encoding  — der eine kaputt kodierte Name („Westegg AuÃerriezlern")
 *   spaces    — doppelte Leerzeichen und Leerraum am Rand
 *   passonly  — Betriebspunkte ohne Ein-/Ausstieg (CZ/BE: Weichen, km-Punkte, Grenzen)
 *   prefix    — vorangestellte Ortsteile aus dem stillgelegten prefix-city-to-label (NL/CZ)
 *   codenames — Namen aus Ziffern/Kürzeln („363", „C", „B1066") aus dem alten `ref`-Rückfall
 *   dups      — dieselbe Haltestelle mehrfach (gleicher Name, gleiche Kategorie, ≤ 5 m;
 *               OSM-Kopie neben GTFS/StaDa-Eintrag gleichen Namens ≤ 30 m)
 *   coords    — Halte ohne Lage (Reparatur 30.09.2026), die eine Zwillings-Zeile MIT Lage haben
 *   gbcaps    — britische Namen in GROSSBUCHSTABEN → normale Schreibweise
 *   country   — Halte mit falschem Land (Zeitzone am Halt und 3 km rundum eindeutig + GeoNames)
 *   bordercity — dasselbe direkt an der Grenze: Stadt (GeoNames ≤ 15 km, ein Land) + Zeitzone am Halt
 *   streetcity — Stadt aus einem Straßennamen („Slaithwaite, Manchester Road" → nicht Manchester)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";
import tzLookup from "tz-lookup";
import { ZONE_COUNTRY } from "../src/lib/country-from-coord.js";
import { normalizeName, dedupCategory, haversineMeters } from "./lib/locationDedup.js";
import { buildMunicipalityResolver, type PlacePoint } from "./lib/stopMunicipality.js";

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.FIX_OUT ?? ".";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

type Change =
  | { code: string; action: "update"; set: Record<string, string | null>; old: Record<string, string | null>; note?: string }
  | { code: string; action: "delete"; note?: string; label?: string };

interface Section {
  id: string;
  title: string;
  run: () => Promise<Change[]>;
}

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params);
  return r.rows as T[];
}

/**
 * Codes, auf die ein Preis-Alarm zeigt — werden nie gelöscht.
 *
 * Ein Fehler hier bricht ab, statt still eine leere Menge zu liefern: Sonst
 * liefe die Löschung ohne den Schutz weiter, und niemand merkte es.
 */
async function protectedCodes(): Promise<Set<string>> {
  const rows = await q<{ c: string }>(
    `SELECT origin AS c FROM price_alerts UNION SELECT destination FROM price_alerts`,
  );
  return new Set(rows.map((r) => r.c).filter(Boolean));
}

/**
 * Halte eines Länder-Fahrplans, an denen dort Fahrten halten (selbst oder an
 * einem ihrer Steige) — werden ebenfalls nie gelöscht.
 *
 * Ihre Tafel liest die Abfahrten über die EIGENE Kennung (gtfsSchedule.ts,
 * direkter Weg); gleichnamige Nachbarn führt sie nicht zusammen. Zwei
 * britische Halte 4–5 m auseinander mit demselben Namen sind meist die beiden
 * Fahrtrichtungen: Im Probelauf vom 15.10. hätten 351 solche „Dubletten" ihre
 * Abfahrten verloren, dazu „EE" (87 Fahrten, Haltestelle am EE-Sitz in
 * Darlington) als „Name ohne Verwertbares".
 */
let feedIds: Promise<string[]> | null = null;
async function servedFeedStops(codes: string[]): Promise<Set<string>> {
  if (codes.length === 0) return new Set();
  feedIds ??= q<{ feed_id: string }>(`SELECT DISTINCT feed_id FROM gtfs_trips`).then((rows) => rows.map((r) => r.feed_id));
  const feeds = await feedIds;
  const rows: Array<{ code: string; feed: string; stopId: string }> = [];
  for (const code of codes) {
    const m = /^gtfs:([a-z]{2,3}):(.+)$/i.exec(code);
    const feed = m ? feeds.find((f) => f.startsWith(`${m[1]!.toLowerCase()}-`)) : undefined;
    if (m && feed) rows.push({ code, feed, stopId: m[2]! });
  }
  if (rows.length === 0) return new Set();
  const served = await q<{ code: string }>(
    `SELECT x.code
       FROM unnest($1::text[], $2::text[], $3::text[]) AS x(code, feed, stop_id)
      WHERE EXISTS (SELECT 1 FROM gtfs_stop_times st WHERE st.feed_id = x.feed AND st.stop_id = x.stop_id)
         OR EXISTS (SELECT 1 FROM gtfs_stops c
                      JOIN gtfs_stop_times st ON st.feed_id = c.feed_id AND st.stop_id = c.stop_id
                     WHERE c.feed_id = x.feed AND c.parent_station = x.stop_id)`,
    [rows.map((r) => r.code), rows.map((r) => r.feed), rows.map((r) => r.stopId)],
  );
  return new Set(served.map((r) => r.code));
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------
/**
 * Genau EIN kaputter Name im ganzen Bestand (Prüfung aller „Ã/Â"-Vorkommen):
 * „ß" (UTF-8 C3 9F) wurde als Latin-1 gelesen, das Steuerzeichen 0x9F ging
 * verloren — übrig blieb „Ã". Eine allgemeine Rückwandlung gibt es deshalb
 * nicht; „Troisième Âge", „Santo Ângelo" und „PURA LÃ" sind richtig.
 */
async function sectionEncoding(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string }>(
    `SELECT code, label FROM locations WHERE code = 'gtfs:de:264884' AND label = 'Westegg AuÃerriezlern'`,
  );
  return rows.map((r) => ({
    code: r.code,
    action: "update" as const,
    set: { label: "Westegg Außerriezlern" },
    old: { label: r.label },
  }));
}

// ---------------------------------------------------------------------------
// spaces
// ---------------------------------------------------------------------------
async function sectionSpaces(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string }>(
    `SELECT code, label FROM locations WHERE label ~ '\\s{2,}' OR label ~ '^\\s' OR label ~ '\\s$'`,
  );
  return rows
    .map((r) => ({ r, neu: r.label.replace(/\s+/g, " ").trim() }))
    .filter(({ r, neu }) => neu && neu !== r.label)
    .map(({ r, neu }) => ({ code: r.code, action: "update" as const, set: { label: neu }, old: { label: r.label } }));
}

// ---------------------------------------------------------------------------
// passonly
// ---------------------------------------------------------------------------
/**
 * Halte, an denen laut Fahrplan KEINE Fahrt ein- oder aussteigen lässt
 * (`pickup_type = drop_off_type = 1` bei allen Halte-Einträgen): Weichen,
 * Abzweige, Kilometerpunkte, Bezirksgrenzen („Zbraň hr.VUSC 0200/0520 04",
 * „Kolín výh.č.201-207"). Der Import hat sie als Bahnhof bzw. Haltestelle
 * übernommen (behoben in import-gtfs.ts). Eine Station zählt nur, wenn KEINER
 * ihrer Bahnsteige bedient wird.
 */
async function sectionPassOnly(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string }>(`
    WITH s AS (
      SELECT s.feed_id, s.stop_id, s.parent_station, bool_or(st.pickup_type <> 1 OR st.drop_off_type <> 1) AS boards
      FROM gtfs_stops s JOIN gtfs_stop_times st ON st.feed_id = s.feed_id AND st.stop_id = s.stop_id
      WHERE s.feed_id IN ('cz-gtfs', 'be-gtfs')
      GROUP BY 1, 2, 3
    ), grp AS (
      SELECT feed_id, coalesce(parent_station, stop_id) AS g, bool_or(boards) AS boards FROM s GROUP BY 1, 2
      UNION ALL
      SELECT feed_id, stop_id, boards FROM s WHERE parent_station IS NOT NULL
    )
    SELECT DISTINCT l.code, l.label
    FROM grp JOIN locations l
      ON l.code = CASE grp.feed_id WHEN 'cz-gtfs' THEN 'gtfs:cz:' ELSE 'gtfs:be:' END || grp.g
    WHERE NOT grp.boards`);
  return rows.map((r) => ({ code: r.code, action: "delete" as const, label: r.label, note: "nur Durchfahrt" }));
}

// ---------------------------------------------------------------------------
// prefix
// ---------------------------------------------------------------------------
/**
 * Der stillgelegte `prefix-city-to-label.ts` klebte den Wert von `city` vor
 * jedes Label — bei Weilern und Ortsteilen entstanden „Stolpen Callantsoog,
 * Buitenzorg", „Santoška Malvazinky", „Den Ham Vleuten, Boterbloemsingel".
 * `fix-stop-cities.ts` hat nur einen Teil zurückgenommen (nicht, wenn die
 * Stadt der Zeile selbst der Weiler blieb).
 *
 * Für NL und CZ liegt der ORIGINALNAME im Fahrplan (`gtfs_stops.name`, gleiche
 * Kennung): Label = „<Vorsatz> <Originalname>" → Originalname. Dazu die Fälle,
 * in denen nur die Groß-/Kleinschreibung abweicht oder vorn ein Teil des
 * Originals fehlt („Rixtel, Dorpsstraat" statt „Aarle Rixtel, Dorpsstraat").
 */
async function sectionPrefix(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string; gname: string }>(`
    SELECT l.code, l.label, g.name AS gname
    FROM locations l
    JOIN gtfs_stops g
      ON g.feed_id = CASE WHEN l.code LIKE 'gtfs:nl:%' THEN 'nl-ovapi' ELSE 'cz-gtfs' END
     AND g.stop_id = substring(l.code from '^gtfs:[a-z]{2}:(.+)$')
    WHERE l.code ~ '^gtfs:(nl|cz):' AND g.name IS NOT NULL AND l.label <> g.name`);
  const out: Change[] = [];
  for (const r of rows) {
    const label = r.label.trim();
    const g = r.gname.trim();
    const restore =
      label.endsWith(` ${g}`) || // Vorsatz
      label.toLowerCase() === g.toLowerCase() || // nur Schreibweise
      g.toLowerCase().endsWith(` ${label.toLowerCase()}`); // vorn abgeschnitten
    if (!restore || !g) continue;
    out.push({ code: r.code, action: "update", set: { label: g }, old: { label: r.label } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// codenames
// ---------------------------------------------------------------------------
/**
 * Kurz heißt nicht Kürzel: Bei ein, zwei Zeichen nur Großbuchstaben/Ziffern
 * („C", „ZA", „7"). Hier stand `\S{1,2}` — damit galten echte Orte als Kürzel,
 * und der Probelauf (14.10.) wollte die Bahnhöfe „Eu" (sta:8731753), „Us"
 * (gtfs:fr:IDFM:67131) und „As" (sta:7600510) LÖSCHEN, dazu OSM-Halte wie
 * „Au", „Ey", „Rø", „Øm" löschen bzw. zu „Meilen Au (Au)" umbenennen. Ein
 * `ref` (Mast-/Steignummer) ist nie gemischt geschrieben.
 */
// Auch Ziffern mit Trennzeichen („3-4", „21488 18", „1/2") — die fielen beim ersten
// Lauf durch und blieben als 55 Namen aus reinen Zahlen übrig.
const CODE_NAME = /^\s*([0-9]+\s*[A-Za-z]?|[0-9]+(?:[ ./-]+[0-9]+)+|[A-Z]{0,4}[0-9]{3,}[A-Z0-9]*|[A-Z0-9]{1,2})\s*$/;
const GTFS_FEED_BY_COUNTRY: Record<string, string> = {
  "United Kingdom": "gb-gtfs",
  Netherlands: "nl-ovapi",
  "Czech Republic": "cz-gtfs",
  Belgium: "be-gtfs",
};
/**
 * Namen aus Ziffern oder Kürzeln — der Importer nahm `ref` (Mast-/Steig-/
 * Straßennummer), wenn ein OSM-Halt keinen Namen hatte (behoben in
 * import-osm-stops.ts). „363" oder „C" findet niemand, und auf der Karte sagen
 * sie nichts. Vorschlag in dieser Reihenfolge:
 *   1. benannte Haltestelle derselben Art ≤ 50 m (meist der Steig daneben) →
 *      „<Name> (<Kürzel>)" — so heißen Steige in PL/CZ/SK ohnehin
 *      („Katowice Sądowa (5)", „Vejle Busterminal (5)");
 *   2. sonst der Fahrplan-Name des Zwillings ≤ 20 m (GB/NL/CZ/BE), sofern
 *      nicht nichtssagend („Bus Station");
 *   3. sonst LÖSCHEN — ohne Namen ist der Halt weder suchbar noch auf der
 *      Karte zu deuten (die Tafel löste ihn zudem über den Namen „363" auf).
 * Straßennummern mit Buchstaben („B1066") nur, wenn 1. oder 2. greifen.
 */
async function sectionCodeNames(): Promise<Change[]> {
  const rows = await q<{
    code: string;
    label: string;
    country: string | null;
    type: string;
    sib: string | null;
    twin: string | null;
  }>(`
    WITH d AS (
      SELECT code, label, country, type, latitude, longitude, latitude::float8 AS lat, longitude::float8 AS lon
      FROM locations
      WHERE type IN ('BUS', 'TRAIN') AND latitude IS NOT NULL
        AND (label ~ '^\\s*[0-9]+\\s*[A-Za-z]?\\s*$' OR label ~ '^[A-Z]{0,4}[0-9]{3,}[A-Z0-9]*$' OR length(trim(label)) <= 2
             OR label ~ '^\\s*[0-9]+([ ./-]+[0-9]+)+\\s*$')
    )
    SELECT d.code, d.label, d.country, d.type,
      (SELECT l.label FROM locations l
        WHERE l.latitude BETWEEN d.latitude - 0.00046 AND d.latitude + 0.00046
          AND l.longitude BETWEEN d.longitude - 0.0008 AND d.longitude + 0.0008
          AND l.type = d.type AND l.code <> d.code
          AND l.label !~ '^\\s*[0-9]+\\s*[A-Za-z]?\\s*$' AND l.label !~ '^[A-Z]{0,4}[0-9]{3,}[A-Z0-9]*$' AND length(trim(l.label)) > 2
          AND l.label !~ '^\\s*[0-9]+([ ./-]+[0-9]+)+\\s*$'
          AND 111320 * sqrt(power(l.latitude::float8 - d.lat, 2) + power((l.longitude::float8 - d.lon) * cos(radians(d.lat)), 2)) <= 50
        ORDER BY power(l.latitude::float8 - d.lat, 2) + power((l.longitude::float8 - d.lon) * cos(radians(d.lat)), 2)
        LIMIT 1) AS sib,
      (SELECT g.name FROM gtfs_stops g
        WHERE g.feed_id = CASE d.country WHEN 'United Kingdom' THEN 'gb-gtfs' WHEN 'Netherlands' THEN 'nl-ovapi'
                                         WHEN 'Czech Republic' THEN 'cz-gtfs' WHEN 'Belgium' THEN 'be-gtfs' END
          AND g.latitude BETWEEN (d.lat - 0.00018)::numeric AND (d.lat + 0.00018)::numeric
          AND g.longitude BETWEEN (d.lon - 0.0003)::numeric AND (d.lon + 0.0003)::numeric
          AND coalesce(g.location_type, 0) = 0
        ORDER BY power(g.latitude::float8 - d.lat, 2) + power((g.longitude::float8 - d.lon) * cos(radians(d.lat)), 2)
        LIMIT 1) AS twin
    FROM d`);
  const generic = /^(bus station|bus stn|station|rail station|stand|stop|bay|interchange|terminus|\S{1,2}|[0-9 ]+)$/i;
  const out: Change[] = [];
  for (const r of rows) {
    if (!CODE_NAME.test(r.label)) continue;
    const codeLike = r.label.trim();
    const isRoad = /^[A-Z]{1,4}[0-9]{2,}[A-Z0-9]*$/.test(codeLike) && /[A-Z]/.test(codeLike);
    // Ein Nachbar, der ohne Klammerzusatz selbst nur ein Kürzel ist („104-105 (194)"
    // aus einem früheren Lauf), taugt nicht als Name.
    const sibUsable = r.sib != null && !CODE_NAME.test(r.sib.trim().replace(/\s*\([^)]*\)\s*$/, ""));
    if (r.sib && sibUsable) {
      // Trägt der Nachbar das Kürzel schon (aus einem früheren Lauf umbenannt:
      // „Aulnay-sur-Mauldre D. 191 (D191)"), nicht ein zweites Mal anhängen.
      const sib = r.sib.trim();
      // Trägt er ein ANDERES Kürzel, das weg — sonst stapelten sie sich
      // („Dworcowa PKP (P4) (P3)", „Viale Curtatone (Cimitero) (F) (033)").
      const base = sib.replace(/\s*\(([^()]*)\)$/, (whole, inner: string) => (CODE_NAME.test(inner) ? "" : whole));
      const label = sib.endsWith(`(${codeLike})`) ? sib : `${base} (${codeLike})`;
      out.push({ code: r.code, action: "update", set: { label }, old: { label: r.label }, note: "Nachbar" });
    } else if (r.twin && !generic.test(r.twin.trim()) && r.country && GTFS_FEED_BY_COUNTRY[r.country]) {
      // Heißt auch der Fahrplan-Zwilling nur „A161", wäre das keine Änderung.
      if (r.twin.trim() === codeLike) continue;
      out.push({ code: r.code, action: "update", set: { label: r.twin.trim() }, old: { label: r.label }, note: "Fahrplan-Zwilling" });
    } else if (!isRoad) {
      out.push({ code: r.code, action: "delete", label: r.label, note: "ohne verwertbaren Namen" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// dups
// ---------------------------------------------------------------------------
const GTFS_PRIMARY = new Set([
  "Netherlands", "France", "Italy", "Spain", "Czech Republic", "Belgium", "Hungary", "Slovakia", "United Kingdom", "Portugal",
]);
interface DupRow {
  code: string;
  label: string;
  country: string | null;
  type: string;
  subtype: string | null;
  source: string | null;
  hafas: string | null;
  nkinds: number;
  lat: number;
  lon: number;
}
/**
 * Dieselbe Haltestelle mehrfach — NUR die sicheren Fälle:
 *   A. gleicher normalisierter Name, gleiche Kategorie (Bahn/U-Bahn/Tram/Bus/
 *      Fähre), höchstens 5 m auseinander — derselbe Punkt doppelt erfasst
 *      (OSM-Haltepunkt + Bahnsteig-Knoten, zwei Importe übereinander);
 *   B. eine OSM-Zeile höchstens 30 m neben einer GTFS-/StaDa-Zeile gleichen
 *      Namens und gleicher Kategorie — die OSM-Kopie ist überflüssig, die
 *      Fahrplan-Zeile kennt die Tafel direkt. Gelöscht wird hier NUR die
 *      OSM-Zeile, nie eine Fahrplan-Zeile.
 *   C. wie B für BAHNHÖFE bis 300 m (Bahnhofsgelände sind groß).
 * NICHT angefasst: zwei OSM-Halte gleichen Namens 6–80 m auseinander. Der
 * Probelauf mit 15 m hätte 80 000 davon gelöscht — fast immer die beiden
 * Straßenseiten bzw. einzelne Masten mit eigener Tafel (in Großbritannien
 * hängt jede Tafel an „ihrem" NaPTAN-Halt).
 *
 * Gewinner in A: von Hand gepflegt (Quelle leer) > Bahn-ID (hafas_id) > Quelle
 * (GTFS-Länder: gtfs > stada > osm, sonst stada > gtfs > osm) > mehr
 * Verkehrsarten > kürzerer Name > Code.
 */
async function sectionDups(): Promise<Change[]> {
  const pairs = await q<{ a: string; b: string }>(`
    WITH a AS (
      SELECT code, latitude, longitude, latitude::float8 AS lat, longitude::float8 AS lon, country,
             trim(regexp_replace(lower(label_fold), '[^[:alnum:]]+', ' ', 'g')) AS nl
      FROM locations WHERE type IN ('BUS', 'TRAIN') AND latitude IS NOT NULL AND parent_code IS NULL
    )
    SELECT a.code AS a, b.code AS b
    FROM a JOIN LATERAL (
      SELECT l.code
      FROM locations l
      WHERE l.latitude BETWEEN a.latitude - 0.00028 AND a.latitude + 0.00028
        AND l.longitude BETWEEN a.longitude - 0.0005 AND a.longitude + 0.0005
        AND l.type IN ('BUS', 'TRAIN') AND l.code > a.code AND l.country IS NOT DISTINCT FROM a.country
        -- Steige (scripts/lib/gtfsStands.ts) sind nie Dubletten: Sie stehen
        -- gewollt dicht beieinander und auf der Lage ihrer Station.
        AND l.parent_code IS NULL
        AND 111320 * sqrt(power(l.latitude::float8 - a.lat, 2) + power((l.longitude::float8 - a.lon) * cos(radians(a.lat)), 2)) <= 30
        AND (trim(regexp_replace(lower(l.label_fold), '[^[:alnum:]]+', ' ', 'g')) = a.nl
             OR similarity(trim(regexp_replace(lower(l.label_fold), '[^[:alnum:]]+', ' ', 'g')), a.nl) >= 0.5)
    ) b ON true`);
  const codes = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const info = new Map<string, DupRow>();
  for (let i = 0; i < codes.length; i += 5000) {
    const rows = await q<DupRow>(
      `SELECT code, label, country, type, subtype, source, hafas_id AS hafas, coalesce(cardinality(kinds), 0) AS nkinds,
              latitude::float8 AS lat, longitude::float8 AS lon
       FROM locations WHERE code = ANY($1)`,
      [codes.slice(i, i + 5000)],
    );
    for (const r of rows) info.set(r.code, r);
  }
  const rank = (r: DupRow): number[] => {
    const primary = r.country != null && GTFS_PRIMARY.has(r.country);
    const src = r.source === "gtfs" ? (primary ? 0 : 1) : r.source === "stada" ? (primary ? 1 : 0) : 2;
    /**
     * Ohne Quelle = von Hand angelegt: die Hbf-Einträge, die der StaDa-Import
     * nicht hatte (scripts/audit-hbf-hafas-ids.ts), und die Fernbus-Terminals
     * aus data/cities.ts („DE-BER-B"). Sie gewinnen immer. Bisher zählten sie
     * wie OSM — der Probelauf (14.10.) löschte „Stuttgart Hbf" (sta:8000096,
     * Fernverkehr, Bahn/U-Bahn/Tram/Bus) zugunsten von „Stuttgart"
     * (sta:8080830, Regionalverkehr, nur Bahn).
     */
    return [r.source == null ? 0 : 1, r.hafas ? 0 : 1, src, -r.nkinds, r.label.length];
  };
  const better = (x: DupRow, y: DupRow): boolean => {
    const a = rank(x);
    const b = rank(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
    return x.code < y.code;
  };
  const same = (x: DupRow, y: DupRow) =>
    dedupCategory(x.subtype, x.type) === dedupCategory(y.subtype, y.type) &&
    normalizeName(x.label) !== "" &&
    normalizeName(x.label) === normalizeName(y.label);

  // A — Union-Find nur über Paare ≤ 5 m (Ketten bleiben damit auf wenige Meter begrenzt).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const caseB: Array<[DupRow, DupRow]> = [];
  for (const p of pairs) {
    const x = info.get(p.a);
    const y = info.get(p.b);
    if (!x || !y || !same(x, y)) continue;
    const d = haversineMeters(x.lat, x.lon, y.lat, y.lon);
    if (d <= 5) {
      parent.set(find(p.a), find(p.b));
      continue;
    }
    const fx = x.source === "gtfs" || x.source === "stada";
    const fy = y.source === "gtfs" || y.source === "stada";
    if (x.source === "osm" && fy) caseB.push([x, y]);
    else if (y.source === "osm" && fx) caseB.push([y, x]);
  }
  const clusters = new Map<string, DupRow[]>();
  for (const c of [...parent.keys()]) {
    const r = info.get(c);
    if (!r) continue;
    const root = find(c);
    const list = clusters.get(root) ?? [];
    if (!list.some((x) => x.code === r.code)) list.push(r);
    clusters.set(root, list);
  }
  const out: Change[] = [];
  const deleted = new Set<string>();
  for (const list of clusters.values()) {
    if (list.length < 2) continue;
    let win = list[0]!;
    for (const r of list) if (better(r, win)) win = r;
    for (const r of list) {
      if (r.code === win.code) continue;
      deleted.add(r.code);
      out.push({
        code: r.code,
        action: "delete",
        label: r.label,
        note: `A: Dublette von ${win.code} «${win.label}» (${Math.round(haversineMeters(r.lat, r.lon, win.lat, win.lon))} m, ${r.source}→${win.source})`,
      });
    }
  }
  // C — Bahnhöfe: OSM-Bahnhof ≤ 300 m neben einem StaDa-/GTFS-Bahnhof gleichen
  // Namens. Bahnhofsgelände sind groß (StaDa = Empfangsgebäude, OSM = Mitte
  // der Gleise); 10 500 solcher Paare, in der Suche nur teils zusammengelegt
  // (dort zählt der WÖRTLICH gleiche Name), auf der Karte zwei Nadeln.
  const rail = await q<{ osm: string; keep: string; d: number }>(`
    WITH t AS (
      SELECT code, source, latitude, longitude, latitude::float8 AS lat, longitude::float8 AS lon, country, subtype
      FROM locations
      WHERE type = 'TRAIN' AND subtype IN ('LONG_DISTANCE', 'REGIONAL', 'SUBURBAN') AND latitude IS NOT NULL
    )
    SELECT o.code AS osm, k.code AS keep, k.d
    FROM t o JOIN LATERAL (
      SELECT t2.code, 111320 * sqrt(power(t2.lat - o.lat, 2) + power((t2.lon - o.lon) * cos(radians(o.lat)), 2)) AS d
      FROM t t2
      WHERE t2.latitude BETWEEN o.latitude - 0.0028 AND o.latitude + 0.0028
        AND t2.longitude BETWEEN o.longitude - 0.0045 AND o.longitude + 0.0045
        AND t2.source IN ('stada', 'gtfs') AND t2.country IS NOT DISTINCT FROM o.country
      ORDER BY 2 LIMIT 5
    ) k ON k.d <= 300
    WHERE o.source = 'osm'`);
  const railCodes = [...new Set(rail.flatMap((r) => [r.osm, r.keep]).filter((c) => !info.has(c)))];
  for (let i = 0; i < railCodes.length; i += 5000) {
    const rows = await q<DupRow>(
      `SELECT code, label, country, type, subtype, source, hafas_id AS hafas, coalesce(cardinality(kinds), 0) AS nkinds,
              latitude::float8 AS lat, longitude::float8 AS lon
       FROM locations WHERE code = ANY($1)`,
      [railCodes.slice(i, i + 5000)],
    );
    for (const r of rows) info.set(r.code, r);
  }
  for (const r of rail) {
    const o = info.get(r.osm);
    const k = info.get(r.keep);
    if (!o || !k || !same(o, k)) continue;
    if (!caseB.some(([x]) => x.code === o.code)) caseB.push([o, k]);
  }

  // B/C — OSM-Kopie neben Fahrplan-Zeile; die Fahrplan-Zeile muss selbst bleiben.
  for (const [osm, keep] of caseB) {
    if (deleted.has(osm.code) || deleted.has(keep.code)) continue;
    deleted.add(osm.code);
    out.push({
      code: osm.code,
      action: "delete",
      label: osm.label,
      note: `${haversineMeters(osm.lat, osm.lon, keep.lat, keep.lon) > 30 ? "C: OSM-Bahnhof" : "B: OSM-Kopie"} von ${keep.code} «${keep.label}» (${Math.round(haversineMeters(osm.lat, osm.lon, keep.lat, keep.lon))} m, osm→${keep.source})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// coords
// ---------------------------------------------------------------------------
/**
 * Halte ohne Lage: Die Reparatur vom 30.09.2026 (repair-stop-refresh.ts) setzte
 * die Lage auf NULL, wo sie die richtige nicht eindeutig fand. Die Zeilen sind
 * seitdem unsichtbar (Suche filtert sie, Karte kennt sie nicht). Gibt es eine
 * Zeile gleichen Namens (normalisiert), gleicher Familie und gleicher Stadt MIT
 * Lage, ist die lagelose eine Dublette → löschen. Die übrigen bleiben (der
 * monatliche Abgleich holt die Lage zurück, wenn gtfs.de die Kennung wieder
 * unter wörtlich gleichem Namen führt — Regel 1 in import-gtfs.ts).
 */
async function sectionCoords(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string; city: string | null; type: string; subtype: string | null; country: string | null }>(
    `SELECT code, label, city, type, subtype, country FROM locations WHERE latitude IS NULL AND type IN ('BUS', 'TRAIN')`,
  );
  const cities = [...new Set(rows.map((r) => r.city).filter((c): c is string => !!c))];
  const cands = await q<{ code: string; label: string; city: string; type: string; subtype: string | null; lat: number; lon: number }>(
    `SELECT code, label, city, type, subtype, latitude::float8 AS lat, longitude::float8 AS lon
     FROM locations WHERE latitude IS NOT NULL AND type IN ('BUS', 'TRAIN') AND city = ANY($1)`,
    [cities],
  );
  const byKey = new Map<string, typeof cands>();
  for (const c of cands) {
    const k = `${c.city}|${dedupCategory(c.subtype, c.type)}|${normalizeName(c.label)}`;
    const l = byKey.get(k) ?? [];
    l.push(c);
    byKey.set(k, l);
  }
  const out: Change[] = [];
  for (const r of rows) {
    if (!r.city) continue;
    const twins = byKey.get(`${r.city}|${dedupCategory(r.subtype, r.type)}|${normalizeName(r.label)}`) ?? [];
    if (twins.length === 0) continue;
    // Alle Zwillinge an EINEM Ort (≤ 300 m untereinander) — sonst mehrdeutig.
    const t0 = twins[0]!;
    if (!twins.every((t) => haversineMeters(t.lat, t.lon, t0.lat, t0.lon) <= 300)) continue;
    out.push({ code: r.code, action: "delete", label: r.label, note: `lagelose Dublette von ${t0.code} «${t0.label}»` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// gbcaps
// ---------------------------------------------------------------------------
// „NE"/„NW"/„SE"/„SW" einzeln: `titleCaseGb` trennt am „/", die Einträge „NE/B"
// usw. treffen daher nie — aus „SW/B" wurde sonst „Sw/B" (116 Namen im Probelauf).
const KEEP_UPPER = new Set(["NHS", "ASDA", "ALDI", "LIDL", "YMCA", "BBC", "HQ", "QE2", "UK", "NCP", "DVLA", "RAF", "BP", "MOD", "IKEA", "B&Q", "M&S", "A&E", "N/B", "S/B", "E/B", "W/B", "NE/B", "NW/B", "SE/B", "SW/B", "NE", "NW", "SE", "SW", "PH", "PO", "GP", "II", "III", "IV", "TA"]);
const LOWER_WORDS = new Set(["opp", "adj", "o/s", "nr", "o/s.", "and", "of", "the", "on", "in", "at", "by", "for", "to"]);
function titleCaseGb(label: string): string {
  let first = true;
  return label
    .split(/(\s+|\/|-|\(|\)|,)/)
    .map((tok) => {
      if (!tok || /^(\s+|\/|-|\(|\)|,)$/.test(tok)) return tok;
      const isFirst = first;
      first = false;
      if (KEEP_UPPER.has(tok) || /\d/.test(tok)) return tok;
      const low = tok.toLowerCase();
      if (!isFirst && LOWER_WORDS.has(low)) return low;
      // Mac/Mc und Apostroph-Wörter schlicht: erster Buchstabe groß.
      return low.replace(/^(\p{L})/u, (c) => c.toUpperCase()).replace(/(['’])(\p{L})(?=\p{L}{2,})/gu, (_, a, c) => a + c.toUpperCase());
    })
    .join("");
}
/**
 * Britische OSM-Namen in GROSSBUCHSTABEN (8 800, aus NaPTAN-Importen:
 * „KINGS DRIVE/LEE HALL ROAD"). Nur Namen mit mindestens zwei Wörtern ab vier
 * Buchstaben — Kürzel wie „ASDA" oder „NISSAN" bleiben. Richtungs- und
 * Kürzelteile („N/B", „A631") bleiben groß, „OPP"/„ADJ" werden wie in NaPTAN
 * klein.
 */
async function sectionGbCaps(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string }>(`
    SELECT code, label FROM locations
    WHERE country = 'United Kingdom' AND type IN ('BUS', 'TRAIN')
      AND label = upper(label) AND label <> lower(label)
      AND (SELECT count(*) FROM regexp_matches(label, '[[:alpha:]]{4,}', 'g')) >= 2`);
  return rows
    .map((r) => ({ r, neu: titleCaseGb(r.label) }))
    .filter(({ r, neu }) => neu !== r.label)
    .map(({ r, neu }) => ({ code: r.code, action: "update" as const, set: { label: neu }, old: { label: r.label } }));
}

// ---------------------------------------------------------------------------
// country
// ---------------------------------------------------------------------------
/**
 * Halte mit falschem Land. Nachgezählt über die Zeitzone der Lage: rund 40 000
 * — 6 730 der 7 605 OSM-Halte mit Land „Germany" liegen gar nicht in
 * Deutschland (Straßburg, Bregenz, Kreuzlingen …), 7 600 „französische" in der
 * Schweiz, 3 600 „belgische" in Frankreich. Das Land steuert, welcher Fahrplan
 * bzw. welches HAFAS-Profil die Tafel liefert, und steht in der Suche.
 *
 * Nur, wo es EINDEUTIG ist — zwei unabhängige Belege:
 *   1. Die Zone ist am Halt UND an vier Punkten je 3 km daneben dieselbe
 *      (tz-lookup vereinfacht die Grenzen um einige Kilometer);
 *   2. der nächste Ort aus `cities` (GeoNames, ≤ 5 km) liegt im selben Land.
 * Grenzorte und Halte in Ländern ohne `cities`-Daten (Slowenien, Kroatien …)
 * bleiben, wie sie sind.
 */
async function sectionCountry(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string; country: string | null; lat: number; lon: number }>(
    `SELECT code, label, country, latitude::float8 AS lat, longitude::float8 AS lon
     FROM locations WHERE type IN ('BUS', 'TRAIN') AND latitude IS NOT NULL`,
  );
  const places = await q<{ country: string; lat: number; lon: number }>(
    `SELECT country, latitude::float8 AS lat, longitude::float8 AS lon FROM cities WHERE country IS NOT NULL`,
  );
  const cell = (lat: number, lon: number) => `${Math.floor(lat / 0.05)}|${Math.floor(lon / 0.05)}`;
  const grid = new Map<string, typeof places>();
  for (const p of places) {
    const k = cell(p.lat, p.lon);
    const l = grid.get(k) ?? [];
    l.push(p);
    grid.set(k, l);
  }
  const nearestPlaceCountry = (lat: number, lon: number): string | null => {
    let best: string | null = null;
    let bestD = 5000;
    const cy = Math.floor(lat / 0.05);
    const cx = Math.floor(lon / 0.05);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (const p of grid.get(`${cy + dy}|${cx + dx}`) ?? []) {
          const d = haversineMeters(lat, lon, p.lat, p.lon);
          if (d < bestD) {
            bestD = d;
            best = p.country;
          }
        }
    return best;
  };
  const zoneCountry = (lat: number, lon: number): string | null => {
    try {
      return ZONE_COUNTRY[tzLookup(lat, lon)] ?? null;
    } catch {
      return null;
    }
  };
  const out: Change[] = [];
  for (const r of rows) {
    const here = zoneCountry(r.lat, r.lon);
    if (!here || here === r.country) continue;
    const dLat = 0.027;
    const dLon = 0.027 / Math.cos((r.lat * Math.PI) / 180);
    const around = [
      zoneCountry(r.lat + dLat, r.lon),
      zoneCountry(r.lat - dLat, r.lon),
      zoneCountry(r.lat, r.lon + dLon),
      zoneCountry(r.lat, r.lon - dLon),
    ];
    if (!around.every((c) => c === here)) continue;
    if (nearestPlaceCountry(r.lat, r.lon) !== here) continue;
    out.push({ code: r.code, action: "update", set: { country: here }, old: { label: r.label, country: r.country }, note: `${r.country} → ${here}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// bordercity
// ---------------------------------------------------------------------------
/**
 * Falsches Land DIREKT an der Grenze — dort, wo `country` aus Vorsicht nichts
 * tut: Seine Regel verlangt dieselbe Zeitzone auch 3 km rundum, und Straßburg
 * liegt am Rhein (nach dem ersten Lauf noch 193 Halte „Germany" mit Stadt
 * „Strasbourg").
 *
 * Hier zählt die zugeordnete Stadt: Liegt ein GeoNames-Ort dieses Namens
 * höchstens 15 km entfernt, in genau EINEM anderen Land, UND ergibt die
 * Zeitzone am Halt selbst dasselbe Land, wird es übernommen. Zwei unabhängige
 * Belege, deshalb ohne Umkreis-Prüfung. Gleichnamige Orte in zwei Ländern
 * (Baarle-Nassau/-Hertog) bleiben unangetastet.
 */
async function sectionBorderCity(): Promise<Change[]> {
  const rows = await q<{ code: string; label: string; city: string; country: string | null; lat: number; lon: number }>(
    `SELECT code, label, city, country, latitude::float8 AS lat, longitude::float8 AS lon
     FROM locations WHERE type IN ('BUS', 'TRAIN') AND latitude IS NOT NULL AND city IS NOT NULL AND city <> ''`,
  );
  const places = await q<{ name: string; country: string; lat: number; lon: number; population: number | null }>(
    `SELECT name, country, latitude::float8 AS lat, longitude::float8 AS lon, population FROM cities WHERE country IS NOT NULL`,
  );
  const byName = new Map<string, typeof places>();
  for (const p of places) {
    const k = p.name.toLowerCase();
    const l = byName.get(k) ?? [];
    l.push(p);
    byName.set(k, l);
  }
  const out: Change[] = [];
  for (const r of rows) {
    const near = (byName.get(r.city.toLowerCase()) ?? []).filter(
      (p) => haversineMeters(r.lat, r.lon, p.lat, p.lon) <= 15_000,
    );
    if (near.length === 0) continue;
    const countries = new Set(near.map((p) => p.country));
    if (countries.size > 1) continue;
    const placeCountry = near[0]!.country;
    if (placeCountry === r.country) continue;
    let here: string | null = null;
    try {
      here = ZONE_COUNTRY[tzLookup(r.lat, r.lon)] ?? null;
    } catch {
      here = null;
    }
    if (here !== placeCountry) continue;
    out.push({
      code: r.code,
      action: "update",
      set: { country: placeCountry },
      old: { label: r.label, country: r.country },
      note: `${r.country} → ${placeCountry} (Stadt ${r.city})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// streetcity
// ---------------------------------------------------------------------------
/**
 * Stadt aus einem STRASSENNAMEN: Die Gemeinde-Ermittlung nahm jeden Ortsnamen
 * im Label als „Sitz" — auch den in „Manchester Road" oder „Route de Virton".
 * So lag „Slaithwaite, Manchester Road" in Manchester (29 km) und „Piccadilly
 * Gardens, Oldham Street" in Oldham; die Suche nach „Manchester" fand
 * Haltestellen in Huddersfield. Behoben in scripts/lib/stopMunicipality.ts;
 * hier die Neuberechnung für die betroffenen Zeilen (Stadt im Straßennamen und
 * der Halt mehr als 3 km von jedem gleichnamigen Ort entfernt).
 */
async function sectionStreetCity(): Promise<Change[]> {
  // String.raw: Die Muster enthalten Backslashes (\m, \s), die ein normales
  // Template-Literal schlucken würde.
  const rows = await q<{ code: string; label: string; city: string; country: string | null; lat: number; lon: number; dist: number | null }>(String.raw`
    WITH b AS (
      SELECT code, label, city, country, latitude::float8 AS lat, longitude::float8 AS lon,
             regexp_replace(city, '([.*+?^$\{\}()|\[\]\\])', '\\\1', 'g') AS ce
      FROM locations WHERE type IN ('BUS', 'TRAIN') AND city IS NOT NULL AND latitude IS NOT NULL
    ), l AS (
      SELECT * FROM b
      WHERE (label ~* ('\m' || ce || '\s+(road|rd|street|lane|avenue|ave|way|drive|terrace|crescent|close|straße|strasse|str|weg|allee|chaussee|damm|straat|laan|steenweg)\M'))
         OR (label ~* ('\m(rue|route|avenue|av|chemin|boulevard|bd|chaussée|via|viale|corso|calle|avenida|avda|carrer|avinguda|carretera|rua|estrada|ulica|ul|aleja)\.?\s+((de|du|des|di|del|della|da|do|dos)\s+)?' || ce || '\M'))
    )
    SELECT l.code, l.label, l.city, l.country, l.lat, l.lon,
      (SELECT min(111320 * sqrt(power(c.latitude::float8 - l.lat, 2) + power((c.longitude::float8 - l.lon) * cos(radians(l.lat)), 2)))
       FROM cities c WHERE c.name = l.city) AS dist
    FROM l`);
  const todo = rows.filter((r) => r.dist == null || r.dist > 3000);
  if (todo.length === 0) return [];
  const cityRows = await q<{
    geoname_id: number; name: string; lat: number; lng: number; population: number | null; feature_code: string | null;
    country: string | null; admin1: string | null; admin2: string | null; admin3: string | null; admin4: string | null;
  }>(`SELECT geoname_id, name, latitude::float8 AS lat, longitude::float8 AS lng, population, feature_code, country,
             admin1, admin2, admin3, admin4 FROM cities`);
  const points: PlacePoint[] = cityRows.map((c) => ({
    geonameId: c.geoname_id,
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    population: c.population ?? 0,
    featureCode: c.feature_code,
    country: c.country,
    admin1: c.admin1,
    admin2: c.admin2,
    admin3: c.admin3,
    admin4: c.admin4,
  }));
  const resolver = buildMunicipalityResolver(points);
  const out: Change[] = [];
  for (const r of todo) {
    const found = resolver.municipalityForStop(r.label, r.lat, r.lon);
    if (!found || found.name === r.city) continue;
    out.push({
      code: r.code,
      action: "update",
      set: { city: found.name },
      old: { label: r.label, city: r.city },
      note: `${r.city} → ${found.name}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// review2
// ---------------------------------------------------------------------------
/**
 * Einzelkorrekturen aus der abschließenden Code-Review (15.10.2026), von Hand
 * belegt und deshalb als feste Liste. Jede greift nur, solange die Zeile noch den
 * alten, falschen Wert trägt — ein zweiter Lauf ändert nichts.
 *  - Gestapelte Kürzel aus `codenames` (vor dessen Fix): „Dworcowa PKP (P4) (P3)"
 *    erbte das Kürzel des Nachbarn mit.
 *  - Grenzhalte, die `bordercity` falsch zuordnete: Ihre Stadt kam vom nächsten
 *    Ort JENSEITS der Grenze (Kruså → Harrislee, Vacallo → Maslianico,
 *    Hammerunterwiesenthal → Vejprty, Baarle-Nassau → Merksplas), und die
 *    Zeitzonen-Grenze von tz-lookup ist dort um Kilometer vereinfacht.
 */
const REVIEW2_LABELS: [code: string, from: string, to: string][] = [
  ["osm:11406301320", "Dworcowa PKP (P4) (P3)", "Dworcowa PKP (P3)"],
  ["osm:11406301321", "Dworcowa PKP (P4) (P2)", "Dworcowa PKP (P2)"],
  ["osm:11406301322", "Dworcowa PKP (P4) (P1)", "Dworcowa PKP (P1)"],
  ["osm:12989767784", "Jagiellońska Dworzec (05) (9)", "Jagiellońska Dworzec (9)"],
  ["osm:8893366156", "Viale Curtatone (Cimitero) (F) (033)", "Viale Curtatone (Cimitero) (033)"],
  ["osm:9560857086", "Dworzec Autobusowy Łomża (4) (7)", "Dworzec Autobusowy Łomża (7)"],
];
/** Schon der Nachbarname ist nur ein Kürzel („A1 (LN034)") — wie die übrigen Kürzel-Halte ohne Namen. */
const REVIEW2_DELETE: [code: string, label: string][] = [["osm:9653829502", "A1 (LN034) (B1)"]];
const REVIEW2_PLACE: [code: string, country: string, city: string][] = [
  ["osm:12098576751", "Denmark", "Kruså"],
  ["osm:12098576752", "Denmark", "Kruså"],
  ["osm:12098823787", "Denmark", "Kruså"],
  ["osm:848880810", "Denmark", "Kruså"],
  ["gtfs:nl:3774593", "Netherlands", "Baarle-Nassau"],
  ["osm:984004921", "Switzerland", "Vacallo"],
  ["gtfs:de:440080", "Germany", "Kurort Oberwiesenthal"],
];

async function sectionReview2(): Promise<Change[]> {
  const codes = [...REVIEW2_LABELS.map((r) => r[0]), ...REVIEW2_DELETE.map((r) => r[0]), ...REVIEW2_PLACE.map((r) => r[0])];
  const rows = await q<{ code: string; label: string; country: string | null; city: string | null }>(
    `SELECT code, label, country, city FROM locations WHERE code = ANY($1)`,
    [codes],
  );
  const byCode = new Map(rows.map((r) => [r.code, r]));
  const out: Change[] = [];
  for (const [code, from, to] of REVIEW2_LABELS) {
    const r = byCode.get(code);
    if (r && r.label === from) out.push({ code, action: "update", set: { label: to }, old: { label: from }, note: "gestapeltes Kürzel" });
  }
  for (const [code, label] of REVIEW2_DELETE) {
    const r = byCode.get(code);
    if (r && r.label === label) out.push({ code, action: "delete", label, note: "nur Kürzel, kein brauchbarer Nachbar" });
  }
  for (const [code, country, city] of REVIEW2_PLACE) {
    const r = byCode.get(code);
    if (r && (r.country !== country || r.city !== city)) {
      out.push({ code, action: "update", set: { country, city }, old: { label: r.label, country: r.country, city: r.city }, note: `${r.country} → ${country}, Stadt ${r.city} → ${city}` });
    }
  }
  return out;
}

const SECTIONS: Section[] = [
  { id: "encoding", title: "Kodierungsfehler im Namen", run: sectionEncoding },
  { id: "spaces", title: "Doppelte Leerzeichen", run: sectionSpaces },
  { id: "passonly", title: "Betriebspunkte ohne Ein-/Ausstieg (CZ/BE)", run: sectionPassOnly },
  { id: "prefix", title: "Vorangestellte Ortsteile (NL/CZ) → Fahrplan-Name", run: sectionPrefix },
  { id: "codenames", title: "Namen aus Ziffern/Kürzeln", run: sectionCodeNames },
  { id: "dups", title: "Dubletten (≤ 5 m; OSM-Kopie ≤ 30 m bzw. OSM-Bahnhof ≤ 300 m neben Fahrplan-Zeile)", run: sectionDups },
  { id: "coords", title: "Lagelose Halte mit Zwilling", run: sectionCoords },
  { id: "gbcaps", title: "GB: GROSSBUCHSTABEN → normale Schreibweise", run: sectionGbCaps },
  { id: "country", title: "Falsches Land (eindeutig über die Zeitzone)", run: sectionCountry },
  { id: "bordercity", title: "Falsches Land an der Grenze (Stadt + Zeitzone am Halt)", run: sectionBorderCity },
  { id: "streetcity", title: "Stadt aus einem Straßennamen (Manchester Road)", run: sectionStreetCity },
  { id: "review2", title: "Einzelkorrekturen aus der Code-Review (15.10.)", run: sectionReview2 },
];

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const prot = await protectedCodes();
  console.log(`[fix-stop-data] ${APPLY ? "ANWENDEN" : "PROBELAUF"} — ${prot.size} Codes durch Preis-Alarme geschützt`);
  for (const s of SECTIONS) {
    if (ONLY.length > 0 && !ONLY.includes(s.id)) continue;
    const t0 = Date.now();
    let changes = await s.run();
    const served = await servedFeedStops(changes.filter((c) => c.action === "delete").map((c) => c.code));
    const keep = (c: Change) => c.action === "delete" && (prot.has(c.code) || served.has(c.code));
    const skipped = changes.filter(keep);
    changes = changes.filter((c) => !keep(c));
    const del = changes.filter((c) => c.action === "delete").length;
    const upd = changes.length - del;
    console.log(
      `\n== ${s.id}: ${s.title} — ${upd} Änderungen, ${del} Löschungen${skipped.length ? `, ${skipped.length} geschützt (Preis-Alarm/eigene Fahrten)` : ""} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
    );
    const notes = new Map<string, number>();
    for (const c of changes) notes.set(c.note?.replace(/ von .*/, "") ?? "-", (notes.get(c.note?.replace(/ von .*/, "") ?? "-") ?? 0) + 1);
    if (notes.size > 1) console.log(`   je Art: ${[...notes].map(([k, v]) => `${k}: ${v}`).join(", ")}`);
    const step = Math.max(1, Math.floor(changes.length / 10));
    for (let i = 0; i < changes.length; i += step) {
      const c = changes[i]!;
      if (c.action === "update" && c.set.label === undefined) console.log(`   ${c.code}: «${c.old.label}» ${c.note ?? ""}`);
      else if (c.action === "update") console.log(`   ${c.code}: «${c.old.label}» → «${c.set.label}»${c.note ? ` [${c.note}]` : ""}`);
      else console.log(`   ${c.code}: LÖSCHEN «${c.label ?? ""}»${c.note ? ` [${c.note}]` : ""}`);
    }
    writeFileSync(
      `${OUT}/fix-stop-data.${s.id}.${STAMP}.csv`,
      ["code,action,old_label,new_label,note"]
        .concat(
          changes.map((c) =>
            [c.code, c.action, c.action === "update" ? c.old.label : c.label, c.action === "update" ? c.set.label : "", c.note]
              .map(csvCell)
              .join(","),
          ),
        )
        .join("\n"),
    );
    if (!APPLY || changes.length === 0) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const codes = changes.map((c) => c.code);
      const backup = await client.query(`SELECT * FROM locations WHERE code = ANY($1)`, [codes]);
      writeFileSync(`${OUT}/fix-stop-data.${s.id}.backup-${STAMP}.json`, JSON.stringify(backup.rows));
      for (const c of changes) {
        if (c.action === "delete") {
          await client.query(`DELETE FROM locations WHERE code = $1`, [c.code]);
        } else {
          const cols = Object.keys(c.set);
          await client.query(
            `UPDATE locations SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE code = $1`,
            [c.code, ...cols.map((k) => c.set[k])],
          );
        }
      }
      await client.query("COMMIT");
      console.log(`   angewendet (Sicherung: ${OUT}/fix-stop-data.${s.id}.backup-${STAMP}.json)`);
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
  console.error("[fix-stop-data] fehlgeschlagen:", err);
  process.exit(1);
});
