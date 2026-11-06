/**
 * Österreichweiter Fahrplan (Okt. 2026) — von data.mobilitaetsverbuende.at holen und zu EINEM
 * GTFS zusammenführen, das `import-gtfs.ts` wie jeden anderen Feed einspielt.
 *
 * Warum nicht mehr nur die Wiener Linien: Deren Feed kennt nur Wien, und auch dort keine
 * Steige. Am Wiener Hauptbahnhof standen deshalb 32 OSM-Punkte ohne Bezeichnung (Busterminal
 * A1–C5, Regionalbus K1–R), jeder mit derselben Tafel der ganzen Station — „alle zeigen das
 * gleiche". Die Verbund-Feeds führen jede Station mit ihren Steigen (`platform_code`) und
 * denselben Kennungen wie die Wiener Linien (at:49:1349:0:26 = Hauptbahnhof, Steig G).
 *
 * Warum ZUSAMMENFÜHREN statt jeden Datensatz einzeln: Sie überschneiden sich (Wien Hbf steht in
 * Ost-Region und Bahn, Linz in OÖVV und Linz AG). Einzeln eingespielt schriebe jeder Lauf Arten
 * und Steige der gemeinsamen Stationen aus SEINER Sicht — die Bahn-Sicht ließe Wien Hbf ohne
 * Busse und Trams zurück. Zusammengeführt zählen alle Fahrten.
 *
 * Zugang: kostenloses Konto, `MVO_USER`/`MVO_PASSWORD` in `.env` (Keycloak, Passwort-Login).
 *
 * Aufruf:
 *   AT_GTFS_OUT=<verzeichnis> npx tsx --env-file=.env scripts/fetch-at-gtfs.ts
 * Ergebnis: <verzeichnis>/merged/{agency,routes,trips,stops,stop_times}.txt — für
 * `GTFS_DIR`. Unveränderte Datensätze werden nicht neu geladen (Versionsnummer je Datensatz).
 * Exit-Code 2: Alles unverändert UND schon eingespielt (`<verzeichnis>/imported`, setzt
 * refresh-stops.sh nach dem Import) — wie `fetch` dort.
 */
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OUT = process.env.AT_GTFS_OUT;
/**
 * Die Verbünde (ohne „Flex": dieselben Fahrten ohne Rufbus-Zonen) und die Bahn:
 * 52 Ost-Region (Wien, NÖ, Bgld.), 53 Steiermark, 54 Salzburg, 55 Kärnten, 56 OÖ,
 * 57 Tirol, 58 Vorarlberg, 69 Linz AG, 66 Eisenbahn (aktuell).
 */
const SETS = (process.env.AT_GTFS_SETS ?? "52,53,54,55,56,57,58,69,66").split(",").map((s: string) => s.trim()).filter(Boolean);
const API = "https://data.mobilitaetsverbuende.at/api/public/v1";
const TOKEN_URL = "https://user.mobilitaetsverbuende.at/auth/realms/dbp-public/protocol/openid-connect/token";

async function token(): Promise<string> {
  const user = process.env.MVO_USER;
  const password = process.env.MVO_PASSWORD;
  if (!user || !password) throw new Error("MVO_USER/MVO_PASSWORD fehlen in .env");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "dbp-public-ui", username: user, password, grant_type: "password", scope: "openid" }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`Anmeldung fehlgeschlagen: ${res.status} ${body.error ?? ""}`);
  return body.access_token;
}

interface DataSet {
  id: number;
  nameDe: string;
  activeVersions?: Array<{ active: boolean; year: string; dataSetVersion?: { id: string } }>;
}

/** Je Datensatz die jüngste aktive Version (Jahr + Versionsnummer). */
async function versions(auth: string): Promise<Map<string, { year: string; version: string; name: string }>> {
  const res = await fetch(`${API}/data-sets?tagIds=20&tagFilterModeInclusive=false`, { headers: { Authorization: `Bearer ${auth}` } });
  if (!res.ok) throw new Error(`Datensatz-Liste: ${res.status}`);
  const out = new Map<string, { year: string; version: string; name: string }>();
  for (const s of (await res.json()) as DataSet[]) {
    const v = (s.activeVersions ?? []).filter((x) => x.active && x.dataSetVersion).sort((a, b) => b.year.localeCompare(a.year))[0];
    if (v) out.set(String(s.id), { year: v.year, version: v.dataSetVersion!.id, name: s.nameDe });
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSV — GTFS-Zeilen enthalten fast nie Anführungszeichen; dann reicht `split`.
// ---------------------------------------------------------------------------
function splitCsv(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function csvValue(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function readTable(path: string): { header: string[]; rows: string[][] } {
  if (!existsSync(path)) return { header: [], rows: [] };
  const lines = readFileSync(path, "utf-8").replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.length > 0);
  const header = splitCsv(lines[0] ?? "").map((h) => h.trim());
  return { header, rows: lines.slice(1).map(splitCsv) };
}

/** Den Ordner eines Datensatzes finden, in dem stops.txt liegt (manche ZIPs haben einen Unterordner). */
function gtfsDirOf(dir: string): string {
  if (existsSync(resolve(dir, "stops.txt"))) return dir;
  const found = execFileSync("find", [dir, "-maxdepth", "3", "-name", "stops.txt", "-print", "-quit"], { encoding: "utf-8" }).trim();
  if (!found) throw new Error(`keine stops.txt in ${dir}`);
  return resolve(found, "..");
}

async function main() {
  if (!OUT) throw new Error("AT_GTFS_OUT fehlt");
  mkdirSync(resolve(OUT, "zips"), { recursive: true });
  let auth = await token();
  const avail = await versions(auth);
  let changed = false;
  for (const id of SETS) {
    const v = avail.get(id);
    if (!v) throw new Error(`Datensatz ${id} hat keine aktive Version`);
    const zip = resolve(OUT, "zips", `${id}.zip`);
    const mark = resolve(OUT, "zips", `${id}.version`);
    if (existsSync(zip) && existsSync(mark) && readFileSync(mark, "utf-8").trim() === v.version) {
      console.log(`[at] ${id} ${v.name}: unverändert (Version ${v.version})`);
      continue;
    }
    // Ein Token gilt nur Minuten — vor jedem Download frisch.
    auth = await token();
    const t0 = Date.now();
    const res = await fetch(`${API}/data-sets/${id}/${v.year}/file`, { headers: { Authorization: `Bearer ${auth}` } });
    if (!res.ok || !res.body) throw new Error(`Download ${id}: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${zip}.new`));
    execFileSync("mv", [`${zip}.new`, zip]);
    writeFileSync(mark, v.version);
    changed = true;
    rmSync(resolve(OUT, "imported"), { force: true });
    console.log(`[at] ${id} ${v.name}: geladen (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const merged = resolve(OUT, "merged");
  if (!changed && existsSync(resolve(OUT, "imported"))) {
    console.log("[at] alles unverändert und eingespielt");
    process.exit(2);
  }

  rmSync(resolve(OUT, "sets"), { recursive: true, force: true });
  rmSync(merged, { recursive: true, force: true });
  mkdirSync(merged, { recursive: true });
  const agency: string[] = ["agency_id,agency_name"];
  const routes: string[] = ["route_id,agency_id,route_short_name,route_type"];
  const trips: string[] = ["route_id,trip_id"];
  const stops = new Map<string, Map<string, string>>();
  const stopCols = new Set<string>();
  const stopTimes = createWriteStream(resolve(merged, "stop_times.txt"));
  stopTimes.write("trip_id,stop_id,pickup_type,drop_off_type\n");
  let stopTimeRows = 0;

  for (const id of SETS) {
    const dir = resolve(OUT, "sets", id);
    mkdirSync(dir, { recursive: true });
    execFileSync("unzip", ["-q", "-o", resolve(OUT, "zips", `${id}.zip`), "-d", dir]);
    const g = gtfsDirOf(dir);
    // Kennungen von Linien, Fahrten und Anbietern je Datensatz eindeutig machen — die von
    // Haltestellen NICHT: Die sind österreichweit dieselben (at:49:1349:0:26), genau darüber
    // finden die Datensätze zusammen.
    const pre = (v: string) => `${id}_${v.trim()}`;
    const a = readTable(resolve(g, "agency.txt"));
    const ai = { id: a.header.indexOf("agency_id"), name: a.header.indexOf("agency_name") };
    for (const r of a.rows) agency.push([pre(r[ai.id] ?? ""), csvValue(r[ai.name] ?? "")].join(","));
    const ro = readTable(resolve(g, "routes.txt"));
    const ri = {
      id: ro.header.indexOf("route_id"), agency: ro.header.indexOf("agency_id"),
      short: ro.header.indexOf("route_short_name"), type: ro.header.indexOf("route_type"),
    };
    for (const r of ro.rows) {
      routes.push([pre(r[ri.id] ?? ""), pre(ri.agency >= 0 ? (r[ri.agency] ?? "") : ""), csvValue(r[ri.short] ?? ""), r[ri.type] ?? ""].join(","));
    }
    const tr = readTable(resolve(g, "trips.txt"));
    const ti = { route: tr.header.indexOf("route_id"), trip: tr.header.indexOf("trip_id") };
    for (const r of tr.rows) trips.push([pre(r[ti.route] ?? ""), pre(r[ti.trip] ?? "")].join(","));
    const st = readTable(resolve(g, "stops.txt"));
    const si = st.header.indexOf("stop_id");
    for (const r of st.rows) {
      const sid = (r[si] ?? "").trim();
      if (!sid || stops.has(sid)) continue;
      const rec = new Map<string, string>();
      st.header.forEach((h, i) => {
        stopCols.add(h);
        rec.set(h, r[i] ?? "");
      });
      stops.set(sid, rec);
    }
    // stop_times gestreamt — Ost-Region allein hat zig Millionen Zeilen.
    const rl = createInterface({ input: createReadStream(resolve(g, "stop_times.txt")), crlfDelay: Infinity });
    let header: string[] | null = null;
    let idx = { trip: -1, stop: -1, pick: -1, drop: -1 };
    for await (const line of rl) {
      if (!header) {
        header = splitCsv(line.replace(/^﻿/, "")).map((h) => h.trim());
        idx = { trip: header.indexOf("trip_id"), stop: header.indexOf("stop_id"), pick: header.indexOf("pickup_type"), drop: header.indexOf("drop_off_type") };
        continue;
      }
      if (!line) continue;
      const c = splitCsv(line);
      const ok = stopTimes.write(
        [pre(c[idx.trip] ?? ""), csvValue((c[idx.stop] ?? "").trim()), idx.pick >= 0 ? (c[idx.pick] ?? "") : "", idx.drop >= 0 ? (c[idx.drop] ?? "") : ""].join(",") + "\n",
      );
      stopTimeRows++;
      if (!ok) await new Promise((r) => stopTimes.once("drain", r));
    }
    console.log(`[at] ${id}: ${st.rows.length} Halte, ${tr.rows.length} Fahrten`);
  }
  await new Promise<void>((r) => stopTimes.end(r));

  const cols = [...stopCols];
  const stopLines = [cols.join(",")];
  for (const rec of stops.values()) stopLines.push(cols.map((c) => csvValue(rec.get(c) ?? "")).join(","));
  writeFileSync(resolve(merged, "stops.txt"), stopLines.join("\n") + "\n");
  writeFileSync(resolve(merged, "agency.txt"), agency.join("\n") + "\n");
  writeFileSync(resolve(merged, "routes.txt"), routes.join("\n") + "\n");
  writeFileSync(resolve(merged, "trips.txt"), trips.join("\n") + "\n");
  rmSync(resolve(OUT, "sets"), { recursive: true, force: true });
  console.log(`[at] zusammengeführt: ${stops.size} Halte, ${trips.length - 1} Fahrten, ${stopTimeRows.toLocaleString()} Halte-Zeiten → ${merged}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
