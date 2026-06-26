/**
 * Bidirektionaler Sample-Audit: prüft Slip-Through-Rate des bisherigen Audits.
 *
 * Methode pro Station (mit hafas_id):
 *   1. FORWARD:  HAFAS by-id → name+coords (was unser bisheriger Audit auch tat)
 *   2. REVERSE:  HAFAS by-name (mit unserem Label) → top-1-Treffer
 *   3. MATCH? Wenn forward.id == reverse.id → confident-match.
 *      Wenn unterschiedlich aber Name+Coords plausibel → maybe-ok (Alias).
 *      Sonst → Slip-Through (unser hafas_id stimmt nicht).
 *
 * Stratified Sample: 25 random pro Land × 7 Länder = 175 Stations.
 * Gleiche Confidence pro Land statt proportional (sonst dominiert DE).
 *
 * Output: pro Land die Quote + Beispiele von Slip-Throughs.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/audit-bidirectional-sample.ts
 */
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { createClient, type HafasClient } from "hafas-client";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
const SAMPLE_PER_COUNTRY = 25;
const MAX_DISTANCE_KM_OK = 3;

const rejseplanenClient: HafasClient = createClient(rejseplanenProfile, "binch-audit/0.1");
const pkpClient: HafasClient = createClient(pkpProfile, "binch-audit/0.1");
const cflClient: HafasClient = createClient(cflProfile, "binch-audit/0.1");

const HAFAS_CLIENTS: Record<string, HafasClient> = {
  Denmark: rejseplanenClient,
  Poland: pkpClient,
  Luxembourg: cflClient,
};
// DE/AT/BE/NL nutzen db-vendo (HTTP), nicht hafas-client.
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
      id: r.id ?? undefined,
      name: r.name,
      latitude: r.location?.latitude,
      longitude: r.location?.longitude,
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
      id: x.id,
      name: x.name,
      latitude: x.location?.latitude,
      longitude: x.location?.longitude,
    }));
  } catch { return []; }
}

interface Result {
  code: string;
  label: string;
  hafasId: string;
  forwardName: string | null;
  reverseTopId: string | null;
  reverseTopName: string | null;
  status: "confident" | "alias" | "slip-through" | "no-data";
  reason: string;
}

async function auditOne(row: { code: string; label: string; hafasId: string; country: string; latitude: number | null; longitude: number | null }): Promise<Result> {
  const country = row.country as CountryName;
  const useDbVendo = USES_DBVENDO.has(country);
  const client = useDbVendo ? null : HAFAS_CLIENTS[country];

  const fwd = useDbVendo
    ? await forwardDbVendo(row.hafasId)
    : client ? await forwardHafasClient(client, row.hafasId) : null;

  await new Promise((r) => setTimeout(r, THROTTLE_MS));

  const rev = useDbVendo
    ? await reverseDbVendo(row.label)
    : client ? await reverseHafasClient(client, row.label) : [];
  const revTop = rev[0] ?? null;

  const base: Omit<Result, "status" | "reason"> = {
    code: row.code,
    label: row.label,
    hafasId: row.hafasId,
    forwardName: fwd?.name ?? null,
    reverseTopId: revTop?.id ?? null,
    reverseTopName: revTop?.name ?? null,
  };

  if (!fwd) return { ...base, status: "no-data", reason: "forward-lookup failed" };

  // Coords-Plausibility-Check: forward.coords sollte nahe an unseren DB-Coords
  // sein. Das ist das härteste Kriterium gegen Slip-Throughs — eine kaputte
  // ID auf den falschen Stop (anderes Land/Stadt) hat selten zufällig <3km
  // Distanz zu unserem Stop.
  const fwdName = fwd.name ?? "";
  const ourLabel = row.label;
  let coordsClose = false;
  let coordsDistance: number | null = null;
  if (
    fwd.latitude != null && fwd.longitude != null &&
    row.latitude != null && row.longitude != null
  ) {
    coordsDistance = haversineKm(Number(row.latitude), Number(row.longitude), fwd.latitude, fwd.longitude);
    coordsClose = coordsDistance <= MAX_DISTANCE_KM_OK;
  }

  // Name-Match-Kriterien — von strikt nach lax:
  //   1. exakt gleich
  //   2. forward.name ist Substring unseres Labels (z.B. "Weida Altstadt" ⊂
  //      "Steinsdorf Weida Altstadt") — sehr häufig, weil unsere Labels den
  //      Stadt/Region-Kontext zusätzlich enthalten
  //   3. unser Label ist Substring von forward.name (selten, aber möglich)
  const nameA = normalize(ourLabel);
  const nameB = normalize(fwdName);
  const exactName = nameA === nameB;
  const fwdInOurs = nameB.length > 0 && nameA.includes(nameB);
  const oursInFwd = nameA.length > 0 && nameB.includes(nameA);
  const nameMatches = exactName || fwdInOurs || oursInFwd;

  // CONFIDENT-Pfade:
  //   a) Reverse-Lookup liefert ID die mit unserer oder fwd.id übereinstimmt
  //   b) Name-Match (exakt / substring) UND Coords passen (<3km)
  if (revTop && revTop.id && (revTop.id === row.hafasId || revTop.id === fwd.id)) {
    return { ...base, status: "confident", reason: `id-match (reverse=${revTop.id})` };
  }
  if (nameMatches && coordsClose) {
    return { ...base, status: "confident", reason: `name+coords ok (forward="${fwdName}", ${coordsDistance?.toFixed(2)}km)` };
  }

  // ALIAS: Name passt aber kein Coords (z.B. CPH Lufthavn / Kastrup Lufthavn —
  // semantisch gleich, andere Schreibweise). Wir lassen das stehen — der ID
  // funktioniert ja, nur das Label-Phrasing weicht ab.
  if (nameMatches) {
    return { ...base, status: "alias", reason: `name matches (forward="${fwdName}") but coords ${coordsDistance?.toFixed(2)}km` };
  }

  // Wenn der Reverse-Lookup leer war, können wir nichts mehr sagen.
  if (!revTop) return { ...base, status: "no-data", reason: "reverse-lookup empty, name+coords didn't confirm" };

  return {
    ...base,
    status: "slip-through",
    reason: `forward.name="${fwdName}" coords${coordsClose ? "" : "-FAR"}, no name match, reverse.id=${revTop.id} "${revTop.name}"`,
  };
}

async function sampleCountry(country: CountryName, n: number) {
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      hafasId: locations.hafasId,
      country: locations.country,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        like(locations.code, "sta:%"),
        isNotNull(locations.hafasId),
        eq(locations.country, country),
      ),
    )
    .orderBy(sql`RANDOM()`)
    .limit(n);

  console.log(`\n========== ${country} (sample ${rows.length}) ==========`);
  const results: Result[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.label || !r.hafasId || !r.country) continue;
    const res = await auditOne({
      code: r.code,
      label: r.label,
      hafasId: r.hafasId,
      country: r.country,
      latitude: r.latitude !== null ? Number(r.latitude) : null,
      longitude: r.longitude !== null ? Number(r.longitude) : null,
    });
    results.push(res);
    process.stdout.write(res.status === "confident" ? "." : res.status === "alias" ? "a" : res.status === "slip-through" ? "X" : "?");
    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }
  console.log();

  const c = results.filter((r) => r.status === "confident").length;
  const a = results.filter((r) => r.status === "alias").length;
  const s = results.filter((r) => r.status === "slip-through").length;
  const n2 = results.filter((r) => r.status === "no-data").length;
  console.log(`  confident:    ${c}/${results.length} (${((c/results.length)*100).toFixed(1)}%)`);
  console.log(`  alias-ok:     ${a}/${results.length}`);
  console.log(`  SLIP-THROUGH: ${s}/${results.length} ${s > 0 ? "⚠️" : ""}`);
  console.log(`  no-data:      ${n2}/${results.length}`);

  if (s > 0) {
    console.log(`  Slip-Through examples:`);
    for (const r of results.filter((x) => x.status === "slip-through").slice(0, 5)) {
      console.log(`    ${r.code} "${r.label}" → forward="${r.forwardName}", reverse=${r.reverseTopId}/"${r.reverseTopName}"`);
    }
  }
  return { country, total: results.length, confident: c, alias: a, slipThrough: s, noData: n2 };
}

async function main() {
  const summary: { country: string; total: number; slipThrough: number; confident: number; alias: number; noData: number }[] = [];
  for (const c of COUNTRIES) {
    summary.push(await sampleCountry(c, SAMPLE_PER_COUNTRY));
  }
  console.log("\n=================== SUMMARY ===================");
  console.log("country     | total | confident | alias | slip-thru | no-data");
  console.log("------------|-------|-----------|-------|-----------|--------");
  let totalT = 0, totalS = 0, totalC = 0;
  for (const s of summary) {
    console.log(`${s.country.padEnd(11)} |  ${String(s.total).padStart(3)}  |    ${String(s.confident).padStart(3)}    |  ${String(s.alias).padStart(3)}  |    ${String(s.slipThrough).padStart(3)}    |   ${String(s.noData).padStart(3)}`);
    totalT += s.total;
    totalS += s.slipThrough;
    totalC += s.confident;
  }
  console.log("------------|-------|-----------|-------|-----------|--------");
  console.log(`Slip-Through-Rate: ${totalS}/${totalT} = ${((totalS / totalT) * 100).toFixed(2)}%`);
  console.log(`Confident-Rate:    ${totalC}/${totalT} = ${((totalC / totalT) * 100).toFixed(2)}%`);
  process.exit(0);
}

main().catch((e) => { console.error("Audit failed:", e); process.exit(1); });
