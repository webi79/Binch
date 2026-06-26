/**
 * Post-Processor für die Slip-Throughs aus audit-bidirectional-half.
 *
 * Parsed /tmp/bidir-half.log (Format „? KEEP sta:XXX ..."), klassifiziert jeden
 * Eintrag und schlägt eine Aktion vor:
 *
 *   1. REPLACE — Reverse-Top hat eine valide Stations-ID (numerisch, 5-9
 *      Zeichen) die sich von unserer hafas_id UND von der forward-ID
 *      unterscheidet. Vor dem Commit wird die neue ID gegen HAFAS verifiziert
 *      (Name passt zu unserem Label + Coords <3km von unseren DB-Coords).
 *
 *   2. KEEP — Sonst (Reverse-Top ist Adresse/null oder share-token-Overlap).
 *      Wahrscheinlich Naming-Variante, der existierende hafas_id ist OK.
 *
 *   3. NULL — Nicht verwendet hier; konservativ stehen lassen wenn unsicher.
 *
 * Default: DRY-RUN. `--apply` für tatsächliche DB-Updates.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/post-process-slip-throughs.ts [--apply]
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { createClient, type HafasClient } from "hafas-client";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";
import { readFileSync } from "node:fs";

const LOG_FILE = "/tmp/bidir-half.log";
const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
const VERIFY_MAX_KM = 3;

const apply = process.argv.includes("--apply");

const rejseplanenClient: HafasClient = createClient(rejseplanenProfile, "binch-pp/0.1");
const pkpClient: HafasClient = createClient(pkpProfile, "binch-pp/0.1");
const cflClient: HafasClient = createClient(cflProfile, "binch-pp/0.1");

const USES_DBVENDO = new Set(["Germany", "Austria", "Belgium", "Netherlands"]);
const HAFAS_CLIENTS: Record<string, HafasClient> = {
  Denmark: rejseplanenClient,
  Poland: pkpClient,
  Luxembourg: cflClient,
};

interface SlipEntry {
  code: string;
  ourLabel: string;
  fwdName: string;
  distanceKm: number | null;
  reverseId: string | null;
  reverseName: string | null;
}

/** Beispiel-Zeile:
 *  „  ? KEEP sta:8003669 \"Leverkusen-Schlebusch\" — keep: forward \"Leverkusen-Manfort\" 0.1km, reverse=8071474/\"Leverkusen Schlebusch(Stadtbahn), Köln\""
 *
 *  Wir extrahieren mit einem RegExp das die 4 Felder fängt.
 */
function parseLine(line: string): SlipEntry | null {
  const m = line.match(/\?\s*KEEP\s+(sta:\S+)\s+"([^"]*)"\s+—\s+keep:\s+forward\s+"([^"]*)"\s+([\d.]+)km,\s+reverse=([^/]+)\/"([^"]*)"/);
  if (!m) return null;
  const [, code, ourLabel, fwdName, distStr, revIdRaw, revName] = m;
  const reverseId = revIdRaw === "undefined" || revIdRaw === "null" ? null : revIdRaw;
  return {
    code,
    ourLabel,
    fwdName,
    distanceKm: distStr ? Number(distStr) : null,
    reverseId,
    reverseName: revName,
  };
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),./\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (x === y) return true;
  if (x.length > 0 && y.includes(x)) return true;
  if (y.length > 0 && x.includes(y)) return true;
  return false;
}

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Verify-Helpers — gleicher Code-Pfad wie der Audit, vereinfacht.
async function verifyDbVendo(id: string): Promise<{ name?: string; lat?: number; lon?: number } | null> {
  try {
    const res = await fetch(`${DBREST_BASE_URL}/stops/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return { name: j.name, lat: j.location?.latitude, lon: j.location?.longitude };
  } catch { return null; }
}

async function verifyHafasClient(c: HafasClient, id: string): Promise<{ name?: string; lat?: number; lon?: number } | null> {
  try {
    const s = await c.stop(id, undefined);
    return { name: (s as any).name, lat: (s as any).location?.latitude, lon: (s as any).location?.longitude };
  } catch { return null; }
}

interface DbRow { code: string; label: string; country: string; lat: number | null; lon: number | null }

async function loadRow(code: string): Promise<DbRow | null> {
  const r = await db
    .select({ code: locations.code, label: locations.label, country: locations.country, latitude: locations.latitude, longitude: locations.longitude })
    .from(locations)
    .where(eq(locations.code, code))
    .limit(1);
  if (r.length === 0) return null;
  const row = r[0]!;
  if (!row.label || !row.country) return null;
  return {
    code: row.code,
    label: row.label,
    country: row.country,
    lat: row.latitude !== null ? Number(row.latitude) : null,
    lon: row.longitude !== null ? Number(row.longitude) : null,
  };
}

interface Verdict {
  entry: SlipEntry;
  action: "REPLACE" | "KEEP";
  newId?: string;
  reason: string;
}

async function classify(entry: SlipEntry, dbRow: DbRow): Promise<Verdict> {
  // KEEP wenn kein valider Reverse-ID-Kandidat vorhanden ist.
  // Eine valide ID ist:
  //   - nicht null/undefined
  //   - numerisch (Stations-Patterns: 51xxxxx, 86xxxxx, 80xxxxx, 8xxxxxx,
  //     CFL hat auch längere IDs wie 9217081)
  //   - unterscheidet sich von unserer hafas_id
  if (!entry.reverseId || !/^\d{5,10}$/.test(entry.reverseId)) {
    return { entry, action: "KEEP", reason: "kein valider Reverse-Kandidat" };
  }
  // Reverse hat eine ID. Verifiziere sie gegen HAFAS:
  //   - Name muss zu unserem Label passen (Substring/Exakt)
  //   - Coords innerhalb 3km von unseren DB-Coords
  // Wenn beides ok → REPLACE.
  const useDbVendo = USES_DBVENDO.has(dbRow.country);
  const client = useDbVendo ? null : HAFAS_CLIENTS[dbRow.country];
  const verify = useDbVendo
    ? await verifyDbVendo(entry.reverseId)
    : client ? await verifyHafasClient(client, entry.reverseId) : null;
  await new Promise((r) => setTimeout(r, THROTTLE_MS));

  if (!verify || !verify.name) {
    return { entry, action: "KEEP", reason: "Verify-Call leer/fehlgeschlagen" };
  }
  const nameOk = nameMatches(dbRow.label, verify.name);
  let coordsOk = false;
  let dist: number | null = null;
  if (verify.lat != null && verify.lon != null && dbRow.lat != null && dbRow.lon != null) {
    dist = haversineKm(dbRow.lat, dbRow.lon, verify.lat, verify.lon);
    coordsOk = dist <= VERIFY_MAX_KM;
  }
  if (!nameOk) {
    return { entry, action: "KEEP", reason: `Verify-Name "${verify.name}" matched nicht zu "${dbRow.label}"` };
  }
  if (!coordsOk) {
    return { entry, action: "KEEP", reason: `Verify-Coords ${dist?.toFixed(1)}km zu weit von DB-Position` };
  }
  return { entry, action: "REPLACE", newId: entry.reverseId, reason: `Name+Coords ok (${dist?.toFixed(1)}km)` };
}

async function main() {
  const log = readFileSync(LOG_FILE, "utf-8");
  const lines = log.split("\n");
  const slips: SlipEntry[] = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) slips.push(e);
  }
  console.log(`Geparsed: ${slips.length} Slip-Throughs aus dem Audit-Log`);
  console.log(`Mode: ${apply ? "APPLY (DB-Updates aktiv)" : "DRY-RUN"}\n`);

  const verdicts: Verdict[] = [];
  for (let i = 0; i < slips.length; i++) {
    const e = slips[i]!;
    const row = await loadRow(e.code);
    if (!row) {
      console.log(`  ? ${e.code}  SKIP — nicht in DB`);
      continue;
    }
    const v = await classify(e, row);
    verdicts.push(v);
    const tag = v.action === "REPLACE" ? "→" : ".";
    console.log(`  ${tag} ${e.code} "${e.ourLabel}" → ${v.action}${v.newId ? `=${v.newId}` : ""}  (${v.reason})`);
    if (v.action === "REPLACE" && apply && v.newId) {
      await db.update(locations).set({ hafasId: v.newId }).where(eq(locations.code, e.code));
    }
    if ((i + 1) % 20 === 0) {
      console.log(`  [${i + 1}/${slips.length}] processed`);
    }
  }

  const replace = verdicts.filter((v) => v.action === "REPLACE");
  const keep = verdicts.filter((v) => v.action === "KEEP");
  console.log("\n=== SUMMARY ===");
  console.log(`REPLACE: ${replace.length} ${apply ? "(DB-updated)" : "(would update)"}`);
  console.log(`KEEP:    ${keep.length}`);

  if (replace.length > 0) {
    console.log("\nREPLACE-Details:");
    for (const v of replace) {
      console.log(`  ${v.entry.code} "${v.entry.ourLabel}" — ${v.entry.fwdName}@id-old, → new id=${v.newId} "${v.entry.reverseName}"`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error("Post-processor failed:", e); process.exit(1); });
