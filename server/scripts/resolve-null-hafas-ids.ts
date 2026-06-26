/**
 * Re-resolve für DE/AT-Stations mit hafas_id=NULL.
 *
 * Nach dem Full-Audit haben wir 244 DE/AT-Einträge mit kaputten hafas_ids
 * genullt. Statt sie auf NULL zu lassen (→ Walk-+-Train-Hybrid-Fallback)
 * versuchen wir, die KORREKTE hafas_id zu finden indem wir db-vendo's
 * Locations-Endpoint mit dem Stations-Namen abfragen.
 *
 * Match-Kriterien:
 *   - Top-Treffer von db-vendo (höchstes weight)
 *   - UIC-Prefix passt zum Country (80=DE, 81=AT)
 *   - Name plausibel ähnlich (gleicher normalize+token-Match wie Audit)
 *   - Coords innerhalb 5km vom DB-Eintrag (sonst potenziell falscher Stop
 *     mit gleichem Namen, z.B. "Bahnhof" in zwei Städten)
 *
 * Wenn kein sauberer Match → bleibt NULL (Hybrid-Fallback). Lieber konservativ
 * als wieder kaputte IDs einsetzen.
 *
 * Throttle: 1.1s/req — gleicher Wert wie Full-Audit, sicher unter 60/min-Limit.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/resolve-null-hafas-ids.ts > /tmp/resolve.log 2>&1
 */
import { isNull, like, and, inArray, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100;
// UIC-Prefix-Mapping: erstes 2 Stellen der hafas_id müssen zum Land passen.
const COUNTRY_UIC_PREFIX: Record<string, string> = {
  Germany: "80",
  Austria: "81",
};
const MAX_DISTANCE_KM = 5;

interface HafasLocation {
  id?: string;
  name?: string;
  type?: string;
  location?: { latitude?: number; longitude?: number };
  weight?: number;
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

function nameMatches(ourLabel: string, hafasName: string): boolean {
  const a = normalize(ourLabel);
  const b = normalize(hafasName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Token-Overlap: mind. ein Wort mit Länge >=4 muss matchen
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

async function searchHafas(query: string): Promise<HafasLocation[]> {
  try {
    const url = `${DBREST_BASE_URL}/locations?query=${encodeURIComponent(query)}&results=5`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return (await res.json()) as HafasLocation[];
  } catch {
    return [];
  }
}

async function main() {
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      country: locations.country,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        like(locations.code, "sta:%"),
        isNull(locations.hafasId),
        inArray(locations.country, ["Germany", "Austria"]),
      ),
    )
    .orderBy(locations.code);

  console.log(`Re-resolve: ${rows.length} DE/AT-Einträge mit NULL hafas_id\n`);

  let resolved = 0;
  let stillNull = 0;
  let skippedNoCoords = 0;
  const start = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.label || !r.country) {
      stillNull++;
      continue;
    }
    if (r.latitude === null || r.longitude === null) {
      // Ohne Coords können wir keinen sauberen Match verifizieren — skip.
      skippedNoCoords++;
      continue;
    }
    const uicPrefix = COUNTRY_UIC_PREFIX[r.country];
    if (!uicPrefix) {
      stillNull++;
      continue;
    }

    const results = await searchHafas(r.label);
    // Top-Match-Suche: nach weight sortiert, erster Treffer der ALLE Kriterien
    // erfüllt (UIC-Prefix, Name-plausibel, Coords <5km) gewinnt.
    let match: HafasLocation | null = null;
    for (const h of results) {
      if (!h.id || !h.name) continue;
      if (!h.id.startsWith(uicPrefix)) continue;
      if (!nameMatches(r.label, h.name)) continue;
      const hLat = h.location?.latitude;
      const hLng = h.location?.longitude;
      if (typeof hLat !== "number" || typeof hLng !== "number") continue;
      const dist = haversineKm(Number(r.latitude), Number(r.longitude), hLat, hLng);
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
        `[${i + 1}/${rows.length}] ${rate.toFixed(2)}/s, ETA ${(eta / 60).toFixed(1)}min, resolved=${resolved}, still-null=${stillNull}`,
      );
    }

    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  console.log("\n=== DONE ===");
  console.log(`Total processed: ${rows.length}`);
  console.log(`Resolved (hafas_id set): ${resolved}`);
  console.log(`Still NULL (no clean match): ${stillNull}`);
  console.log(`Skipped (no coords): ${skippedNoCoords}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("Resolve failed:", e);
  process.exit(1);
});
