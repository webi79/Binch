/**
 * Veraltete und doppelte Haltestellen entfernen — jede mit Ersatz am selben
 * Ort (Okt. 2026). Nichts wird zusammengefasst: Eine Zeile verschwindet nur,
 * wenn derselbe Halt schon als andere Zeile dasteht.
 *
 *   B1 „veraltet" — Zeile eines Fahrplans, die der aktuelle nicht mehr führt;
 *      ein aktueller Halt derselben Art steht daneben.
 *   B2 „doppelt"  — Zeile eines Verbund-Fahrplans (VBB/VRS/MVG), die einen
 *      gtfs.de-Halt derselben Art kopiert.
 *   B3 „doppelt"  — Zwilling: Derselbe gtfs.de-Halt stand in zwei Abgleich-Läufen
 *      unter zwei Zeilen (die Zuordnung kippte bei gleicher Lage), beide
 *      bekamen Steige. Die überzählige Station geht samt ihren Steigen (Steig →
 *      Steig an derselben Stelle). Die Identität kommt aus den Berichten — hier
 *      gelten weder Namens- noch Abstandsregeln.
 *   B5 „doppelt"  — OSM-Dublette: Ein Mast bzw. eine Station des Fahrplans hat auf der
 *      Karte mehrere Marker; der OSM-Marker geht, Ersatz ist der beste daneben
 *      (DB-Kennung, Fahrplan-Zeile, Steig — Plan: osm_dup_plan.py). Steig bleibt
 *      Steig: Ein OSM-Mast wird durch den Mast ersetzt, nicht durch die Station.
 *   B6 „doppelt"  — verrutschter Geist: Am Ort hält laut Fahrplan nichts dieser Art, aber
 *      50–300 m weiter steht der gleichnamige Mast mit eigenem Marker (Plan: ghost_plan.py).
 *      Nur mit passendem Namen; Grenze `B6_MAX_M` statt `MAX_M`. Steig bleibt Steig.
 *   B4 „doppelt"  — Feed-Zwilling: gtfs.de (bzw. NL) führt denselben Mast unter
 *      zwei aktuellen Stationen, alle Steige der einen stehen deckungsgleich
 *      (≤ 1 m) bei der anderen. Sie geht samt Steigen — aber nur, wenn die
 *      Namen zusammenpassen; sonst verschwände ein Name aus der Suche.
 *
 * Der Plan (JSON `[{kind, code, repl, …}]`) kommt aus
 * `~/binch-backups/stops-audit-2026-10-22/stale_plan.py`; hier wird er gegen
 * den Stand JETZT geprüft und eingespielt.
 *
 * PROBELAUF IST DIE VORGABE: Ohne `--apply` wird nur geprüft, gezählt und in
 * FIX_OUT eine CSV der geplanten Ersetzungen geschrieben.
 *
 *   FIX_OUT=… npx tsx --env-file=.env scripts/apply-stop-replacements.ts --plan=stale-plan.json --current=current-codes.txt
 *   FIX_OUT=… npx tsx --env-file=.env scripts/apply-stop-replacements.ts --plan=… --current=… --show=gtfs:de:149598
 *   FIX_OUT=… npx tsx --env-file=.env scripts/apply-stop-replacements.ts --plan=… --current=… --apply
 *
 * `--current`: die Codes, die der letzte Abgleich den Fahrplänen zuordnete
 * (Spalte `code` der Berichte `stations.csv`/`stands.csv`, ohne „fremd") —
 * ein Ersatz muss ein aktueller Halt sein, keine andere veraltete Zeile.
 *   FIX_OUT=… npx tsx --env-file=.env scripts/apply-stop-replacements.ts --undo=<FIX_OUT>/replacements-backup-….json
 *   FIX_OUT=… npx tsx --env-file=.env scripts/apply-stop-replacements.ts --recheck=<FIX_OUT>/replacements-backup-….json
 *
 * `--recheck` prüft eine eingespielte Runde mit den HEUTIGEN Namensregeln nach und schreibt die
 * Zeilen, deren Ersatz nicht mehr besteht, als eigene Sicherung — für ein gezieltes `--undo`.
 *
 * Eine Zeile bleibt stehen, wenn …
 *  - sie ein Steig ist oder eine Station mit Steigen,
 *  - sie eine DB-Kennung (`hafas_id`) trägt, die der Ersatz nicht hat —
 *    sonst fehlten dort die DB-Preise,
 *  - ein Preisalarm auf ihr liegt,
 *  - der Ersatz fehlt, selbst entfernt wird (Ketten werden aufgelöst, Kreise
 *    bleiben stehen), eine andere Verkehrsart hat oder weiter weg liegt als
 *    `MAX_M` (Bus/Tram 30 m, U-Bahn 150 m, Bahn 300 m, Fähre 100 m),
 *  - die Namen nicht zusammenpassen (siehe Schritt 3 in `main`).
 * Ist der Ersatz ein Steig, tritt seine Station an die Stelle — die alte Zeile
 * stand für den ganzen Halt, ihre Tafel zeigt dann alle Steige.
 *
 * Mit `--apply` EINE Transaktion: Ersatz-Einträge in `location_replacements`,
 * dann die Zeilen löschen. Vorher landen sie vollständig als JSON in FIX_OUT;
 * `--undo=<datei> --apply` legt sie wieder an und nimmt die Ersatz-Einträge zurück.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pool } from "../src/db/client.js";

const APPLY = process.argv.includes("--apply");
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PLAN = arg("plan");
const CURRENT = arg("current");
const UNDO = arg("undo");
const RECHECK = arg("recheck");
const SHOW = new Set(
  (arg("show") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const OUT = process.env.FIX_OUT;
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");

type Family = "rail" | "subway" | "tram" | "bus" | "ferry";
const MAX_M: Record<Family, number> = { bus: 30, tram: 30, subway: 150, rail: 300, ferry: 100 };
/** Wie weit ein Halt mit dem alten Namen noch „derselbe" sein kann (verlegt, falsch verortet). */
const SAME_NAME_M = 5_000;
const REASON = { B1: "veraltet", B2: "doppelt", B3: "doppelt", B4: "doppelt", B5: "doppelt", B6: "doppelt" } as const;
/** Verrutschte Geister (B6): so weit darf der gleichnamige Ersatz weg sein. */
const B6_MAX_M: Record<Family, number> = { bus: 300, tram: 300, subway: 600, rail: 1500, ferry: 600 };
/** Fahrpläne mit Abgleich-Bericht; Zeilen anderer Quellen (OSM, StaDa, GB, BE …) gelten als aktuell. */
const REPORTED_FEEDS = ["gtfs:de:", "gtfs:at:", "gtfs:fr:", "gtfs:nl:", "gtfs:cz:", "gtfs:pl:", "gtfs:ch:"];
const SUB_FEEDS = ["gtfs:de:vbb:", "gtfs:de:mvg:", "gtfs:de:vrs:"];

interface PlanEntry {
  kind: keyof typeof REASON;
  code: string;
  repl: string;
}

interface Row {
  code: string;
  name: string;
  city: string | null;
  type: string;
  subtype: string | null;
  lat: number | null;
  lng: number | null;
  parent_code: string | null;
  hafas_id: string | null;
}

interface Target {
  /** Ersatz (Station). */
  code: string;
  /** Der Steig, über den die Station gefunden wurde. */
  via?: string;
  d: number;
  choice: "Plan" | "gleicher Name daneben" | "umbenannt";
}

function familyOf(r: Row): Family {
  switch (r.subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "rail";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "FERRY":
      return "ferry";
    case "BUS":
    case "COACH":
      return "bus";
    default:
      return r.type === "TRAIN" ? "rail" : "bus";
  }
}

function meters(a: Row, b: Row): number {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Wörter, die zwei Halte nicht verwandt machen („Kerk", „Mairie", „Bahnhof") — auch die
 * Straßenarten anderer Sprachen: „Fairway Road" und „Taylor Road" teilen nur „Road" (Runde 1
 * ersetzte so „King Street" durch „Church Street").
 */
const GENERIC_WORDS = new Set(
  `bahnhof hauptbahnhof station gare mitte zentrum centrum kirche kerk markt rathaus mairie eglise schule school post dorf
   place strasse straat weg laan rue avenue platz gasse allee ring damm ufer berg chemin route boulevard plein kade singel gracht
   dijk road street lane drive close hill park square court crescent gardens grove terrace green walk rise mews view bridge cross
   corner stop stand bay house hall church shops hotel hospital centre center north south east west upper lower`
    .split(/\s+/)
    .filter(Boolean),
);

/** Steig-/Buchtkennzeichen („Bay G", „Stand 3", „Stop HB") — verschieden heißt: anderer Halt. */
function markOf(v: string): string | null {
  const m = /\b(?:bay|stand|stop|stance|steig|bussteig|gleis|quai|perron|stanowisko)\s+([a-z0-9]{1,3})\s*$/i.exec(v) ?? /\s([a-z]{1,2}|\d{1,3})\s*$/i.exec(v);
  return m ? m[1]!.toLowerCase() : null;
}

function wordsOf(v: string | null): string[] {
  return (v ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/\bhbf\b\.?/g, "hauptbahnhof")
    .replace(/str\.?(?=[\s,.)/-]|$)/g, "strasse")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Gemeinsame Straßen-Endung — verglichen wird dann nur der Stamm. */
const STREET_SUFFIX = /(strasse|straat|weg|laan|plein|platz|gasse|allee|dijk|singel|kade|gracht|ring|damm)$/;

/**
 * Dasselbe Wort, abgekürzt („Stadth." / „Stadtheide") oder anders geschrieben
 * („Viaduct" / „Viadukt"). Bei gleicher Straßen-Endung zählt nur der Stamm:
 * „Luisenstraße" und „Elisenstraße" trennen sonst nur zwei Buchstaben.
 */
function similarWord(a: string, b: string): boolean {
  if (a === b) return true;
  const suffix = a.match(STREET_SUFFIX)?.[0];
  if (suffix && b.endsWith(suffix)) {
    a = a.slice(0, -suffix.length);
    b = b.slice(0, -suffix.length);
    if (a === b) return true;
  }
  const short = Math.min(a.length, b.length);
  if (short >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return short >= 5 && levenshtein(a, b) <= (Math.max(a.length, b.length) >= 9 ? 2 : 1);
}

type Relation = "gleich" | "verwandt" | "nur Ort" | "anders";

/**
 * Wie nah sind sich zwei Haltestellennamen? Der Ortsname zählt nicht als
 * Gemeinsamkeit: „Wernigerode Westerntor" und „Wernigerode, Unter den
 * Zindeln" sind „nur Ort" — allein die Lage beweist dann nicht, dass es
 * derselbe Halt ist.
 */
function nameRelation(a: Row, b: Row): Relation {
  const wa = wordsOf(a.name);
  const wb = wordsOf(b.name);
  if (wa.join("") === wb.join("")) return "gleich";
  const ma = markOf(a.name);
  const mb = markOf(b.name);
  if (ma && mb && ma !== mb) return "anders";
  const sa = new Set(wa.filter((w) => w.length >= 3));
  const sb = new Set(wb.filter((w) => w.length >= 3));
  if (sa.size === sb.size && [...sa].every((w) => sb.has(w))) return "gleich"; // „Rungis Mairie" / „Mairie de Rungis"
  const place = new Set([...wordsOf(a.city), ...wordsOf(b.city)]);
  const distinct = (ws: string[]) => ws.filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && !place.has(w));
  const da = distinct(wa);
  const db = distinct(wb);
  if (da.some((x) => db.some((y) => similarWord(x, y)))) return "verwandt";
  const ja = da.join("");
  const jb = db.join("");
  if (Math.min(ja.length, jb.length) >= 5 && (ja.includes(jb) || jb.includes(ja))) return "verwandt"; // „Neugeusmanns" / „Neu-Geusmanns"
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (small.size >= 2 && [...small].every((w) => big.has(w))) return "verwandt";
  return [...sa].some((w) => w.length >= 4 && sb.has(w)) ? "nur Ort" : "anders";
}

const strong = (rel: Relation) => rel === "gleich" || rel === "verwandt";

const SHORT_FORMS: Record<string, string> = {
  rd: "road", st: "street", ave: "avenue", ln: "lane", dr: "drive", cl: "close", sq: "square", bf: "bahnhof", bhf: "bahnhof",
};
/**
 * Steht JEDES Wort von `a` auch in `b` (ausgeschrieben zählt: „Rd" → „Road")? Für weite Ersetzungen
 * (B6, bis 300 m): Ein gemeinsames Wort reicht dort nicht — „Applemore Recreation Centre" und
 * „Applemore Tesco" sind zwei Halte. `b` darf nur ergänzen („Barfüsserplatz" → „Basel, Barfüsserplatz").
 */
function coversAll(a: string, b: string): boolean {
  const fb = wordsOf(b);
  return wordsOf(a).every(
    (w) => fb.includes(w) || fb.includes(SHORT_FORMS[w] ?? "") || fb.some((f) => f.length > w.length && f.startsWith(w)),
  );
}

const csv = (cells: Array<string | number>) =>
  cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",");

const ROW_COLUMNS = `l.code, coalesce(l.display_name, l.label) AS name, l.city, l.type, l.subtype,
  l.latitude::float8 AS lat, l.longitude::float8 AS lng, l.parent_code, l.hafas_id`;

async function loadRows(codes: string[]): Promise<Map<string, Row>> {
  const { rows } = await pool.query<Row>(`SELECT ${ROW_COLUMNS} FROM locations l WHERE l.code = ANY($1::text[])`, [
    codes,
  ]);
  return new Map(rows.map((r) => [r.code, r]));
}

/** Halte derselben Art im Umkreis, deren Name zu dem von `old` passt — der nächste zuerst. */
async function sameNameNearby(old: Row, radiusM: number): Promise<Row[]> {
  if (old.lat == null || old.lng == null) return [];
  const dLat = radiusM / 110_574;
  const dLng = radiusM / (111_320 * Math.cos((old.lat * Math.PI) / 180));
  const { rows } = await pool.query<Row>(
    `SELECT ${ROW_COLUMNS} FROM locations l
      WHERE l.latitude BETWEEN $1::numeric AND $2::numeric
        AND l.longitude BETWEEN $3::numeric AND $4::numeric
        AND l.type IN ('TRAIN', 'BUS') AND l.code <> $5`,
    [old.lat - dLat, old.lat + dLat, old.lng - dLng, old.lng + dLng, old.code],
  );
  return rows
    .filter((r) => familyOf(r) === familyOf(old) && meters(old, r) <= radiusM && strong(nameRelation(old, r)))
    .sort((a, b) => meters(old, a) - meters(old, b));
}

async function undo(file: string): Promise<void> {
  const saved = JSON.parse(readFileSync(file, "utf-8")) as Array<Record<string, unknown>>;
  const codes = saved.map((r) => String(r.code));
  // Gespeicherte Spalten (label_fold, city_fold) rechnet die Datenbank selbst.
  const { rows: cols } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'locations' AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
  );
  const list = cols.map((c) => `"${c.column_name}"`).join(", ");
  console.log(`Rücknahme: ${saved.length} Zeilen aus ${file}`);
  if (!APPLY) {
    console.log("Probelauf — mit --apply wieder anlegen.");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO locations (${list})
       SELECT ${list} FROM jsonb_populate_recordset(NULL::locations, $1::jsonb)
       ON CONFLICT (code) DO NOTHING`,
      [JSON.stringify(saved)],
    );
    const del = await client.query(`DELETE FROM location_replacements WHERE old_code = ANY($1::text[])`, [codes]);
    await client.query("COMMIT");
    console.log(`${ins.rowCount} Zeilen wieder angelegt, ${del.rowCount} Ersatz-Einträge entfernt.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Eingespielte Runde mit den heutigen Namensregeln nachprüfen (siehe Kopf). */
async function recheck(file: string): Promise<void> {
  const saved = JSON.parse(readFileSync(file, "utf-8")) as Array<Record<string, unknown>>;
  const { rows: links } = await pool.query<{ old_code: string; new_code: string }>(
    `SELECT old_code, new_code FROM location_replacements WHERE old_code = ANY($1::text[])`,
    [saved.map((r) => String(r.code))],
  );
  const to = new Map(links.map((l) => [l.old_code, l.new_code]));
  const repl = await loadRows([...new Set(to.values())]);
  const bad: Array<Record<string, unknown>> = [];
  const samples: string[] = [];
  for (const r of saved) {
    const target = repl.get(to.get(String(r.code)) ?? "");
    if (!target) continue;
    const old: Row = {
      code: String(r.code),
      name: String(r.display_name ?? r.label),
      city: (r.city as string | null) ?? null,
      type: String(r.type),
      subtype: (r.subtype as string | null) ?? null,
      lat: r.latitude == null ? null : Number(r.latitude),
      lng: r.longitude == null ? null : Number(r.longitude),
      parent_code: null,
      hafas_id: null,
    };
    if (strong(nameRelation(old, target))) continue;
    bad.push(r);
    if (samples.length < 30) samples.push(`   ${old.code} «${old.name}» → ${target.code} «${target.name}» ${meters(old, target).toFixed(1)} m`);
  }
  const outFile = `${OUT}/recheck-undo-${STAMP}.json`;
  writeFileSync(outFile, JSON.stringify(bad));
  console.log(`${saved.length} Ersetzungen geprüft — ${bad.length} bestehen die heutigen Namensregeln nicht:`);
  for (const line of samples) console.log(line);
  console.log(`Zum Zurücknehmen: --undo=${outFile} --apply`);
}

async function main() {
  if (!OUT) throw new Error("FIX_OUT fehlt — Bericht und Sicherung gehören nicht ins Repo.");
  mkdirSync(OUT, { recursive: true });
  if (UNDO) return undo(UNDO);
  if (RECHECK) return recheck(RECHECK);
  if (!PLAN) throw new Error("--plan=<datei.json> fehlt");
  if (!CURRENT) throw new Error("--current=<datei> fehlt (aktuelle Codes aus den Abgleich-Berichten)");
  const current = new Set(readFileSync(CURRENT, "utf-8").split("\n").filter(Boolean));
  const isCurrent = (code: string) => !REPORTED_FEEDS.some((p) => code.startsWith(p)) || current.has(code);

  const plan = new Map<string, PlanEntry>();
  for (const e of JSON.parse(readFileSync(PLAN, "utf-8")) as PlanEntry[]) {
    if (!REASON[e.kind] || !e.code || !e.repl || e.code === e.repl) throw new Error(`Planeintrag kaputt: ${JSON.stringify(e)}`);
    // B5 entfernt nur OSM-Masten, B6 OSM- und veraltete Fahrplan-Zeilen, sonst nur Fahrplan-Zeilen — nie StaDa.
    const allowed = e.kind === "B5" ? ["osm:"] : e.kind === "B6" ? ["osm:", "gtfs:"] : ["gtfs:"];
    if (!allowed.some((p) => e.code.startsWith(p))) {
      throw new Error(`${e.kind} darf ${e.code} nicht entfernen`);
    }
    plan.set(e.code, e);
  }
  console.log(`Plan: ${plan.size} Einträge aus ${PLAN}`);

  const rows = await loadRows([...new Set([...plan.keys(), ...[...plan.values()].map((e) => e.repl)])]);
  const { rows: standRows } = await pool.query<{ code: string; parent: string }>(
    `SELECT code, parent_code AS parent FROM locations WHERE parent_code = ANY($1::text[])`,
    [[...plan.keys()]],
  );
  /** Station → ihre Steige (nur Stationen aus dem Plan). */
  const standsOf = new Map<string, string[]>();
  for (const r of standRows) standsOf.set(r.parent, [...(standsOf.get(r.parent) ?? []), r.code]);
  /** Zwillinge (B3, B4): Steige dürfen mit, Steig → Steig. */
  const twin = (code: string) => plan.get(code)?.kind === "B3" || plan.get(code)?.kind === "B4";
  const { rows: alerted } = await pool.query<{ code: string }>(
    `SELECT DISTINCT c AS code FROM (SELECT origin AS c FROM price_alerts UNION SELECT destination FROM price_alerts) x
      WHERE c = ANY($1::text[])`,
    [[...plan.keys()]],
  );
  const alertCodes = new Set(alerted.map((r) => r.code));

  const skipped = new Map<string, string>();
  const doomed = new Set<string>();
  const target = new Map<string, Target>();
  const drop = (code: string, why: string) => {
    skipped.set(code, why);
    doomed.delete(code);
    target.delete(code);
  };

  // 1) Darf die alte Zeile überhaupt weg? Steige nur als Zwilling (B3), eine
  //    Station mit Steigen nur, wenn alle ihre Steige mitgehen.
  for (const e of plan.values()) {
    const old = rows.get(e.code);
    const stands = standsOf.get(e.code) ?? [];
    if (!old) skipped.set(e.code, "fehlt schon");
    else if (old.parent_code && !twin(e.code)) skipped.set(e.code, "ist Steig");
    else if (stands.length > 0 && !(twin(e.code) && stands.every((c) => twin(c))))
      skipped.set(e.code, "Station mit Steigen");
    else if (alertCodes.has(e.code)) skipped.set(e.code, "Preisalarm");
    else doomed.add(e.code);
  }
  // Fällt ein Steig eines Zwillings heraus, bleibt auch seine Station.
  for (const [station, stands] of standsOf) {
    if (doomed.has(station) && stands.some((c) => !doomed.has(c))) {
      doomed.delete(station);
      skipped.set(station, "Steig bleibt stehen");
    }
  }

  // 2) Ersatz laut Plan — Ketten (A → B → C) auflösen, bis alles zusammenpasst.
  for (let changed = true; changed; ) {
    changed = false;
    target.clear();
    for (const code of [...doomed]) {
      const old = rows.get(code)!;
      const seen = new Set([code]);
      let t = plan.get(code)!.repl;
      while (doomed.has(t) && !seen.has(t)) {
        seen.add(t);
        t = plan.get(t)!.repl;
      }
      const repl = rows.get(t);
      const why = seen.has(t)
        ? "Kreis im Plan"
        : !repl
          ? "Ersatz fehlt"
          : twin(code)
            ? null
            : familyOf(repl) !== familyOf(old)
            ? "Ersatz andere Art"
            : meters(old, repl) > (plan.get(code)!.kind === "B6" ? B6_MAX_M : MAX_M)[familyOf(old)]
              ? "Ersatz zu weit"
              : null;
      if (why) {
        drop(code, why);
        changed = true;
      } else {
        target.set(code, { code: t, d: meters(old, repl!), choice: "Plan" });
      }
    }
  }

  /**
   * 3) Passen die Namen? Die Lage allein beweist nichts: „Groß Schierstedt,
   *    Richtung Giersleben" stand auf den Koordinaten von Giersleben, den echten
   *    Halt gibt es 3,5 km weiter. Teilen sich alter Name und Ersatz höchstens
   *    den Ortsnamen, dann …
   *    - steht ein aktueller Halt mit dem ALTEN Namen in Reichweite (`MAX_M`)
   *      → der wird Ersatz (der Plan nahm schlicht den nächsten); für eine
   *      Verbund-Zeile (B2) nur ein gtfs.de-Halt, das ist ihr Gegenstück;
   *    - steht er weiter weg (≤ 5 km) → bleibt die Zeile: verlegt oder falsch
   *      verortet, das entscheidet hier niemand blind;
   *    - gibt es den alten Namen nirgends mehr → umbenannt oder aufgegeben. Eine
   *      veraltete Zeile (B1) zeigt dann auf den nächsten Halt aus einem
   *      Fahrplan („Elisenstraße" heißt jetzt „Karl-Stützel-Platz"); OSM-Namen
   *      wie „Abri Bus" zählen nicht, und eine aktuelle Zeile (B2) bleibt.
   */
  for (const [code, t] of [...target]) {
    const old = rows.get(code)!;
    const repl = rows.get(t.code)!;
    const planKind = plan.get(code)!.kind;
    // B6 (bis 300 m): Der Ersatz muss den ganzen alten Namen enthalten.
    if (planKind === "B6") {
      if (!coversAll(old.name, repl.name)) drop(code, "Name passt nicht");
      continue;
    }
    // B3: Identität aus den Berichten. Ein Zwillings-Steig folgt seiner Station.
    if (planKind === "B3" || (planKind === "B4" && old.parent_code) || strong(nameRelation(old, repl))) continue;
    if (planKind === "B4") {
      drop(code, "Name passt nicht");
      continue;
    }
    const kind = plan.get(code)!.kind;
    const named = (await sameNameNearby(old, SAME_NAME_M)).filter((r) => !doomed.has(r.code));
    const near = named.find(
      (r) =>
        meters(old, r) <= MAX_M[familyOf(old)] &&
        isCurrent(r.code) &&
        (kind !== "B2" || (r.code.startsWith("gtfs:de:") && !SUB_FEEDS.some((p) => r.code.startsWith(p)))),
    );
    if (near) {
      rows.set(near.code, near);
      target.set(code, { code: near.code, d: meters(old, near), choice: "gleicher Name daneben" });
    } else if (named.length > 0) {
      drop(code, "alter Name steht woanders");
    } else if (kind === "B1" && repl.code.startsWith("gtfs:")) {
      target.set(code, { ...t, choice: "umbenannt" });
    } else {
      drop(code, "Name passt nicht");
    }
  }

  // Bleibt die Station eines Zwillings stehen, bleiben auch ihre Steige.
  for (const [station, stands] of standsOf) {
    if (twin(station) && !target.has(station)) {
      for (const c of stands) if (target.has(c)) drop(c, "Station bleibt stehen");
    }
  }

  // 4) Steig als Ersatz → seine Station (ein Steig ersetzt einen Steig); eine
  //    DB-Kennung muss mitkommen.
  const parents = await loadRows([
    ...new Set([...target.values()].map((t) => rows.get(t.code)!.parent_code).filter((c): c is string => !!c)),
  ]);
  for (const [code, t] of [...target]) {
    const stand = rows.get(t.code)!;
    let final = stand;
    if (stand.parent_code && !rows.get(code)!.parent_code && !["B5", "B6"].includes(plan.get(code)!.kind)) {
      const station = parents.get(stand.parent_code);
      if (!station || doomed.has(station.code)) {
        drop(code, "Station des Steigs fehlt");
        continue;
      }
      final = station;
      target.set(code, { ...t, code: station.code, via: stand.code });
    }
    const old = rows.get(code)!;
    if (old.hafas_id && old.hafas_id !== final.hafas_id) drop(code, "DB-Kennung fehlt am Ersatz");
  }
  for (const [code, t] of target) {
    if (!rows.get(t.code) && !parents.get(t.code)) throw new Error(`Ziel unbekannt: ${code} → ${t.code}`);
    if (doomed.has(t.code)) throw new Error(`Ziel wird selbst entfernt: ${code} → ${t.code}`);
  }

  // Bericht
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const byFeed = new Map<string, number>();
  const byChoice = new Map<string, number>();
  const byRelation = new Map<string, number>();
  const notable: string[] = [];
  const report = [csv(["art", "alt", "alter_name", "ersatz", "ersatz_name", "ueber_steig", "abstand_m", "namen", "wahl"])];
  for (const [code, t] of target) {
    const e = plan.get(code)!;
    const old = rows.get(code)!;
    const stand = rows.get(t.via ?? t.code)!;
    const repl = rows.get(t.code) ?? parents.get(t.code)!;
    const rel = nameRelation(old, stand);
    count(byFeed, `${e.kind} ${code.match(/^gtfs:[a-z]+:(?:(?:vbb|vrs|mvg):)?/)?.[0] ?? "?"}`);
    count(byChoice, t.choice);
    count(byRelation, rel);
    if (t.choice !== "Plan") notable.push(`   [${t.choice}] ${code} «${old.name}» → ${t.code} «${repl.name}» ${t.d.toFixed(1)} m`);
    report.push(csv([e.kind, code, old.name, t.code, repl.name, t.via ?? "", t.d.toFixed(1), rel, t.choice]));
  }
  for (const code of SHOW) {
    const t = target.get(code);
    const old = rows.get(code);
    if (t) {
      const repl = rows.get(t.code) ?? parents.get(t.code)!;
      console.log(
        `  ${code} «${old?.name}» → ${t.code} «${repl.name}»${t.via ? ` (über Steig ${t.via})` : ""}, ${t.d.toFixed(1)} m [${t.choice}]`,
      );
    } else {
      console.log(`  ${code} «${old?.name ?? "?"}»: ${skipped.get(code) ?? "nicht im Plan"}`);
    }
  }
  const byWhy = new Map<string, number>();
  for (const why of skipped.values()) count(byWhy, why);
  const sorted = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]);
  console.log(`\nEntfernt würden ${target.size} Zeilen:`);
  for (const [k, n] of sorted(byFeed)) console.log(`  ${k.padEnd(18)} ${n}`);
  console.log(`Namen alt ↔ Ersatz: ${sorted(byRelation).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Ersatz: ${sorted(byChoice).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log(`Bleiben stehen: ${skipped.size}`);
  for (const [k, n] of sorted(byWhy)) console.log(`  ${k.padEnd(32)} ${n}`);
  if (notable.length > 0) {
    console.log(`\nNicht der Plan-Ersatz (Stichprobe von ${notable.length}):`);
    for (const line of notable.filter((_, i) => i % Math.ceil(notable.length / 40) === 0)) console.log(line);
  }
  const planFile = `${OUT}/replacements-plan-${STAMP}.csv`;
  writeFileSync(planFile, report.join("\n") + "\n");
  writeFileSync(
    `${OUT}/replacements-skipped-${STAMP}.csv`,
    [csv(["code", "name", "grund", "plan_ersatz"]), ...[...skipped].map(([c, w]) => csv([c, rows.get(c)?.name ?? "", w, plan.get(c)?.repl ?? ""]))].join("\n") +
      "\n",
  );
  console.log(`\nBericht: ${planFile}`);

  if (!APPLY) {
    console.log("Probelauf — mit --apply einspielen.");
    return;
  }
  const { rows: ready } = await pool.query<{ ok: string | null }>(`SELECT to_regclass('location_replacements')::text AS ok`);
  if (!ready[0]?.ok) throw new Error("Tabelle location_replacements fehlt — erst Migration 0036 (npm run db:migrate).");

  const codes = [...target.keys()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const backup = await client.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(l) AS row FROM locations l WHERE l.code = ANY($1::text[]) ORDER BY l.code FOR UPDATE`,
      [codes],
    );
    if (backup.rowCount !== codes.length) throw new Error(`Sicherung unvollständig: ${backup.rowCount}/${codes.length}`);
    const backupFile = `${OUT}/replacements-backup-${STAMP}.json`;
    writeFileSync(backupFile, JSON.stringify(backup.rows.map((r) => r.row)));
    console.log(`Sicherung: ${backupFile}`);
    const ins = await client.query(
      `INSERT INTO location_replacements (old_code, new_code, reason)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (old_code) DO UPDATE SET new_code = EXCLUDED.new_code, reason = EXCLUDED.reason, replaced_at = now()`,
      [codes, codes.map((c) => target.get(c)!.code), codes.map((c) => REASON[plan.get(c)!.kind])],
    );
    // Ältere Einträge, die auf eine jetzt entfernte Zeile zeigten, direkt aufs neue Ziel.
    const chained = await client.query(
      `UPDATE location_replacements r SET new_code = n.new_code
         FROM location_replacements n
        WHERE r.new_code = n.old_code AND n.old_code = ANY($1::text[])`,
      [codes],
    );
    // Erst die Steige (nur Zwillinge), dann die Stationen — eine Station mit
    // verbliebenem Steig bleibt stehen, und die Zählung unten bricht ab.
    const delStands = await client.query(
      `DELETE FROM locations l WHERE l.code = ANY($1::text[]) AND l.parent_code IS NOT NULL`,
      [codes.filter((c) => twin(c))],
    );
    const delStations = await client.query(
      `DELETE FROM locations l
        WHERE l.code = ANY($1::text[]) AND l.parent_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM locations s WHERE s.parent_code = l.code)`,
      [codes],
    );
    const deleted = (delStands.rowCount ?? 0) + (delStations.rowCount ?? 0);
    if (ins.rowCount !== codes.length || deleted !== codes.length) {
      throw new Error(`Abweichung: ${ins.rowCount} Ersatz-Einträge, ${deleted} gelöscht, erwartet ${codes.length}`);
    }
    await client.query("COMMIT");
    console.log(`Eingespielt: ${deleted} Zeilen entfernt, ${ins.rowCount} Ersatz-Einträge, ${chained.rowCount} Ketten verkürzt.`);
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
