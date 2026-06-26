/**
 * Findet Train-Stations die in unserer DB fehlen aber in HAFAS existieren.
 *
 * Heuristik: für jeden BUS-Stop (DE) mit „Bahnhof"/„Hbf"/„Bf" im Label, dessen
 * Coords einen nahen HAFAS-Train-Station enthüllen die wir noch nicht haben,
 * dokumentieren wir den Treffer. Mit `--apply` wird der Stop importiert.
 *
 * Sample-Modus (`--sample=N`) verarbeitet N zufällige Bus-Stops — schneller
 * Smoke-Test bevor wir 4956 anfassen. Default: 50.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/discover-missing-train-stations.ts             # 50 sample, dry-run
 *   tsx --env-file=.env scripts/discover-missing-train-stations.ts --sample=100
 *   tsx --env-file=.env scripts/discover-missing-train-stations.ts --apply     # Schreibt INSERTs
 */
import { and, eq, isNotNull, like, sql, or, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
const NEARBY_RADIUS_M = 300;

const apply = process.argv.includes("--apply");
const sampleArg = process.argv.find((a) => a.startsWith("--sample="));
const sampleSize = sampleArg ? Number(sampleArg.split("=")[1] ?? "50") : 50;

interface DbRestNearby {
  id?: string;
  name?: string;
  type?: string;
  location?: { latitude?: number; longitude?: number };
  products?: Record<string, boolean>;
}

async function nearby(lat: number, lon: number): Promise<DbRestNearby[]> {
  try {
    const u = new URL(`${DBREST_BASE_URL}/locations/nearby`);
    u.searchParams.set("latitude", String(lat));
    u.searchParams.set("longitude", String(lon));
    u.searchParams.set("distance", String(NEARBY_RADIUS_M));
    u.searchParams.set("results", "10");
    const res = await fetch(u);
    if (!res.ok) return [];
    return (await res.json()) as DbRestNearby[];
  } catch { return []; }
}

interface Candidate {
  hafasId: string;
  name: string;
  lat: number;
  lon: number;
  fromBusStop: string;
}

function isTrainStation(p?: Record<string, boolean>): boolean {
  if (!p) return false;
  return !!(p.national || p.regional || p.regionalExpress || p.nationalExpress || p.suburban);
}

async function main() {
  // BUS-Stops mit „Bahnhof"-Pattern im Label (DE, country Germany).
  // Wir sampelen zufällig damit ein einzelner Lauf eine breite geographische
  // Verteilung abdeckt.
  const candidates = await db
    .select({
      code: locations.code,
      label: locations.label,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(and(
      eq(locations.type, "BUS"),
      eq(locations.country, "Germany"),
      or(
        like(locations.label, "%Bahnhof%"),
        like(locations.label, "% Hbf%"),
        like(locations.label, "% Bf%"),
      )!,
      isNotNull(locations.latitude),
      isNotNull(locations.longitude),
    ))
    .orderBy(sql`RANDOM()`)
    .limit(sampleSize);

  console.log(`Sample-Discovery: ${candidates.length} BUS-Stops mit Bahnhof-Pattern\n`);

  // Welche HAFAS-IDs haben wir schon?
  const existingHafas = await db
    .select({ hafasId: locations.hafasId })
    .from(locations)
    .where(isNotNull(locations.hafasId));
  const existingSet = new Set(existingHafas.map((r) => r.hafasId).filter(Boolean));
  console.log(`Wir haben aktuell ${existingSet.size} hafas_ids in der DB\n`);

  const found = new Map<string, Candidate>();
  const start = Date.now();

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (c.latitude == null || c.longitude == null) continue;
    const list = await nearby(Number(c.latitude), Number(c.longitude));
    for (const n of list) {
      if (!n.id || !n.name) continue;
      // Strenge Filter um Lärm rauszuhalten:
      //   - type=station (keine Sub-Stops/Plattformen)
      //   - UIC-prefix 80 (echte DE-Train-Stations, kein S-Bahn-Tram-Mischmasch)
      //   - 7-stellig (keine internen kurzen IDs)
      //   - hat NATIONAL/REGIONAL/REGIONAL-EXPRESS (kein nur-suburban)
      if (n.type !== "station") continue;
      if (!/^80\d{5}$/.test(n.id)) continue;
      const p = n.products ?? {};
      if (!(p.national || p.regional || p.regionalExpress || p.nationalExpress)) continue;
      if (existingSet.has(n.id)) continue; // schon bei uns
      // Verhindere Duplikate INNERHALB des Sample-Laufs
      if (found.has(n.id)) continue;
      const lat = n.location?.latitude;
      const lon = n.location?.longitude;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      found.set(n.id, {
        hafasId: n.id,
        name: n.name,
        lat,
        lon,
        fromBusStop: `${c.code} "${c.label}"`,
      });
      console.log(`  + ${n.id}  ${n.name}  (entdeckt via ${c.code} "${c.label}")`);
    }
    if ((i + 1) % 10 === 0) {
      const elapsed = (Date.now() - start) / 1000;
      const rate = (i + 1) / elapsed;
      console.log(`  [${i + 1}/${candidates.length}] ${rate.toFixed(2)}/s, ${found.size} neue Stations gefunden`);
    }
    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, THROTTLE_MS));
  }

  console.log(`\n=== SAMPLE RESULT ===`);
  console.log(`Sample: ${candidates.length} Bus-Stops`);
  console.log(`Discovered: ${found.size} potenziell fehlende Train-Stations`);
  console.log(`Yield-Rate: ${((found.size / candidates.length) * 100).toFixed(1)}% (echte Funde pro Bus-Stop-Check)`);

  if (apply && found.size > 0) {
    console.log(`\nApply: ${found.size} Stations werden inseriert...`);
    let inserted = 0;
    for (const c of found.values()) {
      // Land aus HAFAS-Country-Code-Prefix ableiten (80=DE, 81=AT, …).
      // Für dieses Skript nur DE gesucht, also fix Germany.
      try {
        await db.insert(locations).values({
          code: `sta:${c.hafasId}`,
          label: c.name,
          country: "Germany",
          type: "TRAIN",
          subtype: "REGIONAL",
          hafasId: c.hafasId,
          latitude: String(c.lat),
          longitude: String(c.lon),
        }).onConflictDoNothing();
        inserted++;
      } catch (e) {
        console.log(`  ! INSERT failed für ${c.hafasId}: ${(e as Error).message}`);
      }
    }
    console.log(`Inserted: ${inserted}`);
  } else if (found.size > 0) {
    console.log(`\nDry-Run — kein INSERT. Mit --apply würden ${found.size} Stations importiert.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error("Discovery failed:", e); process.exit(1); });
