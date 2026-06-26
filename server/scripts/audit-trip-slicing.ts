/**
 * Integration-Test: prüft ob unsere Trip-Detail-Slicing-Logik für zufällige
 * Stops im DACH-Raum den richtigen Slice-Start trifft.
 *
 * Workflow pro Stop:
 *   1. /api/stops/<code>/departures abrufen → echte HAFAS-Departure mit tripId
 *   2. /api/trips/detail mit dieser tripId aufrufen (wie der Client beim Tap)
 *   3. Verifizieren: der returned origin = der User-Stop?
 *      - Match: Name-Substring ODER Coords <500m vom User-Stop
 *      - Mismatch: Slice startete an einem anderen Stop → BUG
 *
 * Sample: 50 random Stops aus DE/AT mit Coords (damit Slicing-Coord-Fallback
 * relevant ist). Wir mischen TRAIN + BUS damit beide Klassen abgedeckt sind.
 *
 * Throttle: 1.1s zwischen API-Calls (db-vendo 60/min Limit). Pro Stop bis zu
 * 2 Calls = ~110 Calls = ~2 Min Laufzeit für 50 Stops.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/audit-trip-slicing.ts            # 50 Stops
 *   tsx --env-file=.env scripts/audit-trip-slicing.ts --sample=100
 */
import { and, eq, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3000";
const THROTTLE_MS = 1100;
const SAMPLE = (() => {
  const a = process.argv.find((x) => x.startsWith("--sample="));
  return a ? Number(a.split("=")[1] ?? "50") : 50;
})();

interface StopRow {
  code: string;
  label: string;
  type: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface DepartureItem {
  id: string;
  plannedTime: string;
  line: string;
  product: string | null;
  direction: string;
}

interface DeparturesResponse {
  results: DepartureItem[];
  stop: { code: string; label: string; hafasId: string | null };
}

interface TripDetailLeg {
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  originLat?: number;
  originLng?: number;
  departTime: string;
  arriveTime: string;
}

interface TripDetailResponse {
  id: string;
  origin: string;
  originLabel: string;
  destination: string;
  destLabel: string;
  departTime: string;
  legs: TripDetailLeg[];
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

function nameLooksSame(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.length > 0 && nb.includes(na)) return true;
  if (nb.length > 0 && na.includes(nb)) return true;
  // Token-Overlap: mindestens 50% der distinct 4+-char-Tokens müssen matchen
  const ta = new Set(na.split(" ").filter((t) => t.length >= 4));
  const tb = new Set(nb.split(" ").filter((t) => t.length >= 4));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= Math.ceil(Math.min(ta.size, tb.size) * 0.5);
}

function haversineMeters(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6_371_000;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((la1 * Math.PI) / 180) * Math.cos((la2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function fetchDepartures(code: string): Promise<DeparturesResponse | null> {
  try {
    const url = `${API_BASE}/api/stops/${encodeURIComponent(code)}/departures`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as DeparturesResponse;
  } catch { return null; }
}

async function fetchTripDetail(
  tripId: string,
  fromStopId: string | null,
  fromStopLabel: string,
  stopCode: string,
): Promise<TripDetailResponse | null> {
  try {
    const u = new URL(`${API_BASE}/api/trips/detail`);
    u.searchParams.set("tripId", tripId);
    if (fromStopId) u.searchParams.set("fromStopId", fromStopId);
    u.searchParams.set("fromStopLabel", fromStopLabel);
    u.searchParams.set("stopCode", stopCode);
    const res = await fetch(u.toString());
    if (!res.ok) return null;
    return (await res.json()) as TripDetailResponse;
  } catch { return null; }
}

interface AuditResult {
  stop: StopRow;
  departure?: DepartureItem;
  verdict:
    | "ok-name"
    | "ok-coords"
    | "mismatch"
    | "no-departures"
    | "no-trip"
    | "no-origin-data";
  detailOrigin?: string;
  detailOriginLat?: number;
  detailOriginLng?: number;
  distanceMeters?: number;
}

async function auditStop(row: StopRow): Promise<AuditResult> {
  // 1. Echte Departures
  const board = await fetchDepartures(row.code);
  await new Promise((r) => setTimeout(r, THROTTLE_MS));
  if (!board || board.results.length === 0) {
    return { stop: row, verdict: "no-departures" };
  }
  // 1. Nimm die früheste Departure
  const dep = board.results[0]!;

  // 2. Trip-Detail
  const detail = await fetchTripDetail(
    dep.id,
    board.stop.hafasId,
    row.label,
    row.code,
  );
  if (!detail || !detail.legs || detail.legs.length === 0) {
    return { stop: row, departure: dep, verdict: "no-trip" };
  }
  const firstLeg = detail.legs[0]!;
  const detailOrigin = firstLeg.originLabel ?? "";

  // 3. Verifikation
  // a) Name-Match (Substring oder Token-Overlap)
  if (detailOrigin && nameLooksSame(row.label, detailOrigin)) {
    return { stop: row, departure: dep, verdict: "ok-name", detailOrigin };
  }
  // b) Coord-Match (<500m, etwas großzügiger als Server-Schwelle damit
  //    Platform-Verschiebungen die hier sichtbar werden aber nicht als
  //    Bug zählen)
  if (firstLeg.originLat != null && firstLeg.originLng != null) {
    const d = haversineMeters(row.latitude, row.longitude, firstLeg.originLat, firstLeg.originLng);
    if (d <= 500) {
      return { stop: row, departure: dep, verdict: "ok-coords", detailOrigin, detailOriginLat: firstLeg.originLat, detailOriginLng: firstLeg.originLng, distanceMeters: d };
    }
    return { stop: row, departure: dep, verdict: "mismatch", detailOrigin, detailOriginLat: firstLeg.originLat, detailOriginLng: firstLeg.originLng, distanceMeters: d };
  }
  // c) keine Coords im Trip → können nicht safely sagen ob Mismatch oder
  //    nur abweichendes Naming
  return { stop: row, departure: dep, verdict: "no-origin-data", detailOrigin };
}

async function main() {
  // Sample: ~25 TRAIN + ~25 BUS, beide DE+AT gemischt. RANDOM() macht das
  // gleichmäßig genug verteilt.
  const sample = await db
    .select({
      code: locations.code,
      label: locations.label,
      type: locations.type,
      country: locations.country,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(and(
      isNotNull(locations.latitude),
      isNotNull(locations.longitude),
      inArray(locations.country, ["Germany", "Austria"]),
      inArray(locations.type, ["TRAIN", "BUS"]),
    ))
    .orderBy(sql`RANDOM()`)
    .limit(SAMPLE);

  const rows: StopRow[] = sample.map((r) => ({
    code: r.code,
    label: r.label ?? "?",
    type: r.type ?? "?",
    country: r.country ?? "?",
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
  }));

  console.log(`Slicing-Audit: ${rows.length} Random-Stops aus DACH (TRAIN+BUS)\n`);

  const results: AuditResult[] = [];
  const start = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const verdict = await auditStop(r);
    results.push(verdict);
    const tag = verdict.verdict === "ok-name" ? "✓"
      : verdict.verdict === "ok-coords" ? "·"
      : verdict.verdict === "mismatch" ? "✗"
      : verdict.verdict === "no-departures" ? "-"
      : verdict.verdict === "no-trip" ? "?"
      : "○";
    process.stdout.write(tag);
    if ((i + 1) % 50 === 0) process.stdout.write("\n");
  }
  console.log();
  console.log();

  // Statistik
  const buckets = { "ok-name": 0, "ok-coords": 0, mismatch: 0, "no-departures": 0, "no-trip": 0, "no-origin-data": 0 };
  for (const r of results) buckets[r.verdict]++;

  const evaluated = results.length - buckets["no-departures"] - buckets["no-trip"];
  console.log(`=== STATS ===`);
  console.log(`Total:       ${results.length}`);
  console.log(`✓ ok-name:   ${buckets["ok-name"]}`);
  console.log(`· ok-coords: ${buckets["ok-coords"]}`);
  console.log(`✗ MISMATCH:  ${buckets["mismatch"]}`);
  console.log(`○ no-coords: ${buckets["no-origin-data"]}`);
  console.log(`- no-deps:   ${buckets["no-departures"]}`);
  console.log(`? no-trip:   ${buckets["no-trip"]}`);
  if (evaluated > 0) {
    const okRate = ((buckets["ok-name"] + buckets["ok-coords"]) / evaluated * 100).toFixed(1);
    const missRate = (buckets["mismatch"] / evaluated * 100).toFixed(1);
    console.log(`\nQuote (von ${evaluated} auswertbar): ${okRate}% ok, ${missRate}% mismatch`);
  }

  // Mismatch-Details
  const mismatches = results.filter((r) => r.verdict === "mismatch");
  if (mismatches.length > 0) {
    console.log(`\n=== MISMATCHES (${mismatches.length}) ===`);
    for (const m of mismatches) {
      console.log(`  ✗ ${m.stop.code} "${m.stop.label}" [${m.stop.type}]`);
      console.log(`     Departure: ${m.departure?.line} ${m.departure?.plannedTime.slice(11, 16)} → ${m.departure?.direction}`);
      console.log(`     Got origin: "${m.detailOrigin}" (${m.distanceMeters?.toFixed(0)}m vom User-Stop)`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("Audit failed:", e); process.exit(1); });
