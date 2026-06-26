/**
 * Re-resolve für DK + BE Stations mit hafas_id=NULL.
 *
 * DK: nutzt rejseplanen-HAFAS via hafas-client (in-process). Liefert echte
 *     DSB/Rejseplan-IDs, kompatibel mit unserem BE-Routing-Pfad.
 *
 * BE: nutzt DB-HAFAS via db-vendo (HTTP). DB kennt BE-Stationen durch IC/ICE/
 *     Thalys-Integration. SNCB-Profile in hafas-client ist defekt ("Invalid
 *     client version"), daher Workaround über DB.
 *
 * Match-Kriterien (gleich wie DACH-Resolve):
 *   - Top-Treffer (höchstes weight bzw. erster relevance-Match)
 *   - Land passt: für DK Prefix 86 (oder rejseplanen-IDs starten manchmal mit
 *     anderen Ziffern, dann checken wir nur Name-Match), für BE Prefix 88
 *   - Name plausibel ähnlich
 *   - Coords innerhalb 5km
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/resolve-null-hafas-dk-be.ts [dk|be|all]
 */
import { isNull, like, and, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { createClient, type HafasClient } from "hafas-client";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
const MAX_DISTANCE_KM = 5;

interface HafasLoc {
  id?: string | null;
  name?: string | null;
  latitude?: number;
  longitude?: number;
  weight?: number;
}

const rejseplanenClient: HafasClient = createClient(rejseplanenProfile, "binch-resolve/0.1");
const pkpClient: HafasClient = createClient(pkpProfile, "binch-resolve/0.1");
const cflClient: HafasClient = createClient(cflProfile, "binch-resolve/0.1");

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),./\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(ourLabel: string, hafasName: string): boolean {
  const a = normalize(ourLabel);
  const b = normalize(hafasName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(" ").filter((t) => t.length >= 4));
  const bTokens = b.split(" ").filter((t) => t.length >= 4);
  return bTokens.some((t) => aTokens.has(t));
}

function haversineKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Generischer hafas-client-Locations-Wrapper. */
async function searchHafasClient(client: HafasClient, query: string): Promise<HafasLoc[]> {
  try {
    const res = await client.locations(query, { results: 5 });
    return res.map((r: any) => ({
      id: r.id,
      name: r.name,
      latitude: r.location?.latitude,
      longitude: r.location?.longitude,
      weight: r.weight,
    }));
  } catch {
    return [];
  }
}

async function searchRejseplanen(query: string): Promise<HafasLoc[]> {
  return searchHafasClient(rejseplanenClient, query);
}

async function searchPkp(query: string): Promise<HafasLoc[]> {
  return searchHafasClient(pkpClient, query);
}

async function searchCfl(query: string): Promise<HafasLoc[]> {
  return searchHafasClient(cflClient, query);
}

/** Resolve via DB db-vendo — HTTP API für DE/BE/etc. */
async function searchDbVendo(query: string): Promise<HafasLoc[]> {
  try {
    const url = `${DBREST_BASE_URL}/locations?query=${encodeURIComponent(query)}&results=5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const arr = (await res.json()) as any[];
    return arr.map((r) => ({
      id: r.id,
      name: r.name,
      latitude: r.location?.latitude,
      longitude: r.location?.longitude,
      weight: r.weight,
    }));
  } catch {
    return [];
  }
}

type SupportedCountry = "Denmark" | "Belgium" | "Poland" | "Netherlands" | "Luxembourg";

// uicPrefix=null bedeutet: keine UIC-Prefix-Validierung. Nötig für CFL weil
// die CFL-API interne IDs vergibt (z.B. Luxembourg = "9217081", nicht 82xxx).
const COUNTRY_CONFIG: Record<SupportedCountry, { uicPrefix: string | null; search: (q: string) => Promise<HafasLoc[]> }> = {
  Denmark: { uicPrefix: "86", search: searchRejseplanen },
  // BE + NL via DB-HAFAS — DB kennt beide via Cross-Border-Integration
  // (Thalys/ICE Brussels, ICE Amsterdam). Native NMBS-/NS-HAFAS gibt's nicht
  // mehr (deprecated). PL via pkp-Profile, das funktioniert noch.
  Belgium: { uicPrefix: "88", search: searchDbVendo },
  Poland: { uicPrefix: "51", search: searchPkp },
  Netherlands: { uicPrefix: "84", search: searchDbVendo },
  // CFL-IDs sind nicht UIC-prefixed → wir verlassen uns nur auf Name+Coords-
  // Match (Coords <5km filtern zuverlässig den falschen Stop raus).
  Luxembourg: { uicPrefix: null, search: searchCfl },
};

async function resolveCountry(country: SupportedCountry) {
  const cfg = COUNTRY_CONFIG[country];
  const { uicPrefix, search } = cfg;
  // Beim BE wollen wir ALLE NULL-Einträge resolven. Bei DK auch.
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        like(locations.code, "sta:%"),
        isNull(locations.hafasId),
        eq(locations.country, country),
      ),
    )
    .orderBy(locations.code);

  console.log(`\n========== ${country} ==========`);
  console.log(`${rows.length} NULL-Einträge zum Resolven\n`);

  let resolved = 0;
  let stillNull = 0;
  const start = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.label || r.latitude === null || r.longitude === null) {
      stillNull++;
      continue;
    }

    const results = await search(r.label);
    let match: HafasLoc | null = null;
    for (const h of results) {
      if (!h.id || !h.name) continue;
      // UIC-Prefix-Check: nur soft-prüfen wenn der Provider UIC-IDs vergibt
      // (DK/BE/NL/PL). Bei CFL (uicPrefix=null) skippen wir den Check ganz —
      // CFL nutzt interne IDs (z.B. 9217081 für Luxembourg).
      if (uicPrefix !== null && h.id.length === 7 && !h.id.startsWith(uicPrefix)) continue;
      if (!nameMatches(r.label, h.name)) continue;
      if (typeof h.latitude !== "number" || typeof h.longitude !== "number") continue;
      const dist = haversineKm(Number(r.latitude), Number(r.longitude), h.latitude, h.longitude);
      if (dist > MAX_DISTANCE_KM) continue;
      match = h;
      break;
    }

    if (match) {
      await db.update(locations).set({ hafasId: match.id! }).where(eq(locations.code, r.code));
      resolved++;
      console.log(`  ✓ ${r.code}  ${r.label}  →  ${match.id} ${match.name}`);
    } else {
      stillNull++;
    }

    if ((i + 1) % 25 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = (i + 1) / elapsed;
      const remaining = rows.length - i - 1;
      const eta = remaining / rate;
      console.log(
        `[${i + 1}/${rows.length}] ${rate.toFixed(2)}/s, ETA ${(eta / 60).toFixed(1)}min, resolved=${resolved}`,
      );
    }

    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  console.log(`\n--- ${country} done ---`);
  console.log(`Resolved: ${resolved}/${rows.length}`);
  console.log(`Still NULL: ${stillNull}`);
}

async function main() {
  const arg = (process.argv[2] ?? "all").toLowerCase();
  if (arg === "dk" || arg === "all") await resolveCountry("Denmark");
  if (arg === "be" || arg === "all") await resolveCountry("Belgium");
  if (arg === "pl" || arg === "all") await resolveCountry("Poland");
  if (arg === "nl" || arg === "all") await resolveCountry("Netherlands");
  if (arg === "lu" || arg === "all") await resolveCountry("Luxembourg");
  console.log("\n=== ALL DONE ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("Resolve failed:", e);
  process.exit(1);
});
