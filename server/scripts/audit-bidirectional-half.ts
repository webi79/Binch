/**
 * Bidirektionaler Voll-Audit auf 50% Sample pro Land.
 *
 * Methode (gleich wie audit-bidirectional-sample.ts):
 *   FORWARD:  HAFAS by-id → name+coords
 *   REVERSE:  HAFAS by-name (unser Label) → top-1
 *   Confident wenn: id-match ODER (Name-Substring + Coords <3km)
 *   Slip-Through wenn: kein Name-Match UND kein ID-Match
 *
 * NULL-Aktion (strikt-konservativ — wir wollen keine richtigen IDs killen):
 *   NULL'n nur wenn ALLE diese Bedingungen erfüllt sind:
 *     - Forward+Reverse haben beide ein Ergebnis geliefert (no-data → leave it)
 *     - Forward.name matched NICHT unser Label (kein Substring)
 *     - Coords sind >5km voneinander entfernt ODER fehlen
 *     - Reverse-top-ID unterscheidet sich von unserem hafas_id
 *
 * Sample: stratified 50% pro Land — DE 3220, AT 670, DK 85, NL 193, BE 145,
 * PL 61, LU 23 → ~4397 total. ETA ~2.7h bei 1.1s/Throttle.
 *
 * Progress wird alle 50 Stations in /tmp/bidir-half-progress.json gespeichert
 * für Resume nach Abbruch.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/audit-bidirectional-half.ts > /tmp/bidir-half.log 2>&1 &
 */
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { createClient, type HafasClient } from "hafas-client";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
const MAX_DISTANCE_KM_OK = 3;
const NULL_MIN_DISTANCE_KM = 5; // strikter Schwellwert für NULL-Aktion
// Zweite-Hälfte-Modus: nutzt OFFSET damit wir die andere 50% des md5-Sorts
// treffen. Eigener Progress-File damit Resume-State der ersten Hälfte
// nicht überschrieben wird.
const SECOND_HALF = process.argv.includes("--second-half");
const PROGRESS_FILE = SECOND_HALF
  ? "/tmp/bidir-second-half-progress.json"
  : "/tmp/bidir-half-progress.json";
const CHECKPOINT_EVERY = 50;

const rejseplanenClient: HafasClient = createClient(rejseplanenProfile, "binch-audit/0.1");
const pkpClient: HafasClient = createClient(pkpProfile, "binch-audit/0.1");
const cflClient: HafasClient = createClient(cflProfile, "binch-audit/0.1");

const HAFAS_CLIENTS: Record<string, HafasClient> = {
  Denmark: rejseplanenClient,
  Poland: pkpClient,
  Luxembourg: cflClient,
};
const USES_DBVENDO = new Set(["Germany", "Austria", "Belgium", "Netherlands"]);

const COUNTRIES = ["Germany", "Austria", "Denmark", "Netherlands", "Belgium", "Poland", "Luxembourg"] as const;
type CountryName = typeof COUNTRIES[number];

interface ForwardResp { id?: string; name?: string; latitude?: number; longitude?: number }
interface ReverseHit { id?: string; name?: string; latitude?: number; longitude?: number }

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),./\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function forwardDbVendo(id: string): Promise<ForwardResp | null> {
  try {
    const res = await fetch(`${DBREST_BASE_URL}/stops/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return { id: j.id, name: j.name, latitude: j.location?.latitude, longitude: j.location?.longitude };
  } catch { return null; }
}

async function reverseDbVendo(query: string): Promise<ReverseHit[]> {
  try {
    const res = await fetch(`${DBREST_BASE_URL}/locations?query=${encodeURIComponent(query)}&results=3`);
    if (!res.ok) return [];
    const arr = (await res.json()) as any[];
    return arr.map((r) => ({
      id: r.id ?? undefined, name: r.name,
      latitude: r.location?.latitude, longitude: r.location?.longitude,
    }));
  } catch { return []; }
}

async function forwardHafasClient(c: HafasClient, id: string): Promise<ForwardResp | null> {
  try {
    const s = await c.stop(id, undefined);
    return { id: (s as any).id, name: (s as any).name, latitude: (s as any).location?.latitude, longitude: (s as any).location?.longitude };
  } catch { return null; }
}

async function reverseHafasClient(c: HafasClient, query: string): Promise<ReverseHit[]> {
  try {
    const r = await c.locations(query, { results: 3 });
    return r.map((x: any) => ({
      id: x.id, name: x.name,
      latitude: x.location?.latitude, longitude: x.location?.longitude,
    }));
  } catch { return []; }
}

type Status = "confident" | "alias" | "slip-through" | "no-data";
interface Decision {
  status: Status;
  shouldNull: boolean;
  reason: string;
  forwardName: string | null;
  distance: number | null;
}

interface Row {
  code: string;
  label: string;
  hafasId: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
}

async function auditOne(row: Row): Promise<Decision> {
  const useDbVendo = USES_DBVENDO.has(row.country);
  const client = useDbVendo ? null : HAFAS_CLIENTS[row.country];

  const fwd = useDbVendo
    ? await forwardDbVendo(row.hafasId)
    : client ? await forwardHafasClient(client, row.hafasId) : null;

  await new Promise((r) => setTimeout(r, THROTTLE_MS));

  const rev = useDbVendo
    ? await reverseDbVendo(row.label)
    : client ? await reverseHafasClient(client, row.label) : [];
  const revTop = rev[0] ?? null;

  if (!fwd) return { status: "no-data", shouldNull: false, reason: "forward failed", forwardName: null, distance: null };

  const fwdName = fwd.name ?? "";
  let distance: number | null = null;
  if (
    fwd.latitude != null && fwd.longitude != null &&
    row.latitude != null && row.longitude != null
  ) {
    distance = haversineKm(Number(row.latitude), Number(row.longitude), fwd.latitude, fwd.longitude);
  }
  const coordsClose = distance != null && distance <= MAX_DISTANCE_KM_OK;
  const coordsFar = distance != null && distance >= NULL_MIN_DISTANCE_KM;

  const nameA = normalize(row.label);
  const nameB = normalize(fwdName);
  const nameMatches =
    nameA === nameB ||
    (nameB.length > 0 && nameA.includes(nameB)) ||
    (nameA.length > 0 && nameB.includes(nameA));

  if (revTop && revTop.id && (revTop.id === row.hafasId || revTop.id === fwd.id)) {
    return { status: "confident", shouldNull: false, reason: "id-match", forwardName: fwdName, distance };
  }
  if (nameMatches && coordsClose) {
    return { status: "confident", shouldNull: false, reason: `name+coords ok (${distance?.toFixed(1)}km)`, forwardName: fwdName, distance };
  }
  if (nameMatches) {
    return { status: "alias", shouldNull: false, reason: `name matches but coords ${distance?.toFixed(1)}km`, forwardName: fwdName, distance };
  }
  if (!revTop) return { status: "no-data", shouldNull: false, reason: "reverse empty", forwardName: fwdName, distance };

  // SLIP-THROUGH: kein Name-Match, kein ID-Match.
  // NULL-Bedingung (konservativ): Coords MÜSSEN weit sein (>5km) ODER fehlen
  // ganz UND reverse hat unterschiedliche ID. Wenn coords nicht messbar
  // (distance==null) → konservativ NICHT NULLen (lieber stehen lassen).
  const reverseIdDiffers = revTop.id != null && revTop.id !== row.hafasId && revTop.id !== fwd.id;
  const shouldNull = coordsFar && reverseIdDiffers;
  return {
    status: "slip-through",
    shouldNull,
    reason: shouldNull
      ? `NULL: forward "${fwdName}" ${distance?.toFixed(1)}km away, reverse=${revTop.id}/"${revTop.name}"`
      : `keep: forward "${fwdName}" ${distance != null ? distance.toFixed(1) + "km" : "no-coords"}, reverse=${revTop.id}/"${revTop.name}"`,
    forwardName: fwdName,
    distance,
  };
}

interface Progress {
  countriesDone: string[];
  inProgressCountry: string | null;
  lastIndexInCountry: number;
  totals: Record<string, { total: number; confident: number; alias: number; slipThrough: number; noData: number; nulled: number }>;
}

function loadProgress(): Progress {
  if (!existsSync(PROGRESS_FILE)) {
    return { countriesDone: [], inProgressCountry: null, lastIndexInCountry: -1, totals: {} };
  }
  return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
}
function saveProgress(p: Progress): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

async function auditCountry(country: CountryName, halfSize: number, totalForCountry: number, progress: Progress) {
  const t = progress.totals[country] ?? { total: 0, confident: 0, alias: 0, slipThrough: 0, noData: 0, nulled: 0 };
  progress.totals[country] = t;

  // Deterministische 50%-Auswahl: ORDER BY md5(code) damit Resumes denselben
  // Subset treffen. (Random() würde bei jedem Re-Run anderen Sample geben.)
  // Zweite Hälfte: OFFSET die erste Hälfte → exakt-disjoint zur ersten Hälfte.
  let query = db
    .select({
      code: locations.code, label: locations.label, hafasId: locations.hafasId,
      country: locations.country, latitude: locations.latitude, longitude: locations.longitude,
    })
    .from(locations)
    .where(and(
      like(locations.code, "sta:%"),
      isNotNull(locations.hafasId),
      eq(locations.country, country),
    ))
    .orderBy(sql`md5(${locations.code})`)
    .limit(halfSize)
    .$dynamic();
  if (SECOND_HALF) {
    // erste Hälfte = ceil(total/2); zweite Hälfte = total - firstHalf
    const firstHalfSize = Math.ceil(totalForCountry / 2);
    query = query.offset(firstHalfSize);
  }
  const rows = await query;

  const startIdx = progress.inProgressCountry === country ? progress.lastIndexInCountry + 1 : 0;
  console.log(`\n========== ${country} (${rows.length} stations, resume from ${startIdx}) ==========`);

  progress.inProgressCountry = country;

  const startTime = Date.now();
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.label || !r.hafasId || !r.country) continue;
    const dec = await auditOne({
      code: r.code, label: r.label, hafasId: r.hafasId, country: r.country,
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
    });

    t.total++;
    if (dec.status === "confident") t.confident++;
    else if (dec.status === "alias") t.alias++;
    else if (dec.status === "slip-through") t.slipThrough++;
    else t.noData++;

    if (dec.shouldNull) {
      await db.update(locations).set({ hafasId: null }).where(eq(locations.code, r.code));
      t.nulled++;
      console.log(`  ✗ NULLed ${r.code} "${r.label}" — ${dec.reason}`);
    } else if (dec.status === "slip-through") {
      console.log(`  ? KEEP ${r.code} "${r.label}" — ${dec.reason}`);
    }

    progress.lastIndexInCountry = i;
    if ((i + 1) % CHECKPOINT_EVERY === 0) {
      saveProgress(progress);
      const elapsed = (Date.now() - startTime) / 1000;
      const checkedSinceStart = i - startIdx + 1;
      const rate = checkedSinceStart / elapsed;
      const remaining = rows.length - i - 1;
      const eta = remaining / rate;
      console.log(
        `  [${i + 1}/${rows.length}] confident=${t.confident}, alias=${t.alias}, slip=${t.slipThrough}, null'd=${t.nulled}, ETA ${(eta / 60).toFixed(1)}min`,
      );
    }
    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }
  saveProgress(progress);
  progress.countriesDone.push(country);
  progress.inProgressCountry = null;
  progress.lastIndexInCountry = -1;
  saveProgress(progress);
  console.log(`  ${country} done: confident=${t.confident}/${t.total}, slip=${t.slipThrough}, nulled=${t.nulled}, no-data=${t.noData}`);
}

async function main() {
  const progress = loadProgress();
  // Pro Land 50% berechnen
  const countryTotals = await db
    .select({ country: locations.country, cnt: sql<number>`COUNT(*)::int` })
    .from(locations)
    .where(and(
      like(locations.code, "sta:%"),
      isNotNull(locations.hafasId),
    ))
    .groupBy(locations.country);
  const totalsByCountry = new Map(countryTotals.map((r) => [r.country, r.cnt]));

  for (const c of COUNTRIES) {
    if (progress.countriesDone.includes(c) && progress.inProgressCountry !== c) {
      console.log(`Skipping ${c} (already done)`);
      continue;
    }
    const total = totalsByCountry.get(c) ?? 0;
    // erste Hälfte = ceil(total/2), zweite Hälfte = total - firstHalf (Rest)
    const firstHalfSize = Math.ceil(total / 2);
    const halfSize = SECOND_HALF ? total - firstHalfSize : firstHalfSize;
    await auditCountry(c, halfSize, total, progress);
  }
  console.log("\n=================== SUMMARY ===================");
  let totalAll = 0, slipAll = 0, nullAll = 0, confAll = 0;
  for (const c of COUNTRIES) {
    const t = progress.totals[c];
    if (!t) continue;
    console.log(`${c.padEnd(12)} confident=${t.confident}/${t.total} slip=${t.slipThrough} nulled=${t.nulled} no-data=${t.noData}`);
    totalAll += t.total;
    slipAll += t.slipThrough;
    nullAll += t.nulled;
    confAll += t.confident;
  }
  console.log("---");
  console.log(`Total: ${totalAll} checked, ${confAll} confident, ${slipAll} slip-throughs, ${nullAll} NULLed`);
  console.log(`Slip-rate: ${((slipAll / totalAll) * 100).toFixed(2)}% — NULL-rate: ${((nullAll / totalAll) * 100).toFixed(2)}%`);
  process.exit(0);
}

main().catch((e) => { console.error("Audit failed:", e); process.exit(1); });
