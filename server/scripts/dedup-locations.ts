/**
 * Einmal-Aufräum-Skript: löscht doppelte Einträge in der `locations`-Tabelle.
 *
 * Strategie:
 *   1. Alle Rows pro (Land, type, normalisiertem Name) gruppieren — Type ist
 *      wichtig damit eine Bushaltestelle „Köln Hbf" NICHT mit dem Bahnhof
 *      „Köln Hbf" zusammenfällt. Bahnhof + Bushaltestelle vor dem Bahnhof
 *      sind zwei unterschiedliche physische Stops und bleiben separat.
 *   2. Innerhalb jeder Gruppe Rows nach Koordinaten-Nähe clustern (Radius
 *      500 m — typische Bahnhofs-/Stations-Campus-Größe). Damit werden
 *      mehrere DELFI-Einträge desselben Bahnhofs zusammengefasst, aber zwei
 *      separate „Marienplatz"-Stops in 10 km Entfernung bleiben getrennt.
 *   3. Pro Cluster: kanonische Variante wählen (HAFAS-ID > Subtype-Priorität
 *      > StaDa > kürzeres Label > erstes Element).
 *   4. Alle Nicht-Kanonischen löschen.
 *
 * Idempotent: kann mehrfach laufen ohne Schaden.
 */
import { sql, isNotNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { dedupCategory, haversineMeters, normalizeName } from "./lib/locationDedup.js";

const CLUSTER_RADIUS_M = 500;
const CHUNK = 1000;

interface Row {
  code: string;
  label: string;
  country: string | null;
  type: string;
  subtype: string | null;
  hafasId: string | null;
  source: string | null;
  latitude: number;
  longitude: number;
}

const SUBTYPE_PRIO: Record<string, number> = {
  LONG_DISTANCE: 100,
  REGIONAL: 90,
  SUBURBAN: 80,
  SUBWAY: 70,
  TRAM: 60,
  COACH: 50,
  FERRY: 40,
  BUS: 30,
};

function prefer(a: Row, b: Row): boolean {
  const aH = a.hafasId ? 1 : 0;
  const bH = b.hafasId ? 1 : 0;
  if (aH !== bH) return aH > bH;

  const aSub = SUBTYPE_PRIO[a.subtype ?? ""] ?? 0;
  const bSub = SUBTYPE_PRIO[b.subtype ?? ""] ?? 0;
  if (aSub !== bSub) return aSub > bSub;

  const aStada = a.source === "stada" ? 1 : 0;
  const bStada = b.source === "stada" ? 1 : 0;
  if (aStada !== bStada) return aStada > bStada;

  return a.label.length < b.label.length;
}



/** Greedy-Clustering: für jeden Row prüfen ob er in der Nähe (≤ radius m)
 *  eines schon existierenden Clusters liegt; ja → dazu, sonst → neuer Cluster. */
function clusterByProximity(rows: Row[], radius: number): Row[][] {
  const clusters: Row[][] = [];
  for (const row of rows) {
    let added = false;
    for (const c of clusters) {
      const seed = c[0]!;
      if (haversineMeters(row.latitude, row.longitude, seed.latitude, seed.longitude) <= radius) {
        c.push(row);
        added = true;
        break;
      }
    }
    if (!added) clusters.push([row]);
  }
  return clusters;
}

async function main() {
  const t0 = Date.now();
  console.log("[dedup-locations] loading rows…");
  const raw = await db
    .select({
      code: locations.code,
      label: locations.label,
      country: locations.country,
      type: locations.type,
      subtype: locations.subtype,
      hafasId: locations.hafasId,
      source: locations.source,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(isNotNull(locations.latitude));
  console.log(`[dedup-locations]   ${raw.length} rows with coords`);

  // Numeric-Coord-Konversion + Index aufbauen.
  const rows: Row[] = raw
    .filter((r) => r.latitude !== null && r.longitude !== null)
    .map((r) => ({
      code: r.code,
      label: r.label,
      country: r.country,
      type: r.type,
      subtype: r.subtype,
      hafasId: r.hafasId,
      source: r.source,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    }));

  // Gruppierung: (country, verkehrs-kategorie, normalized name).
  // Kategorie statt type, weil unsere `type`-Spalte SUBWAY/TRAM/BUS alle
  // unter „BUS" zusammenfasst — dann würde z.B. die U-Bahn-Station
  // „Dortmund Barop Parkhaus" mit dem gleichnamigen Bus-Stop in eine Gruppe
  // fallen und einer von beiden gelöscht werden. Mit der feineren Kategorie
  // bleiben SUBWAY-Station und Bus-Stop an derselben Adresse separat als
  // verschiedene physische Markers stehen.
  //
  // RAIL fasst LONG_DISTANCE/REGIONAL/SUBURBAN zusammen (gleicher Bahnhof aus
  // verschiedenen Quellen mit unterschiedlicher Subtype-Detail → mergen).
  const category = dedupCategory;

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const norm = normalizeName(row.label);
    if (!norm) continue; // ohne sinnvollen Namen kein Dedup möglich
    const key = `${row.country ?? ""}|${category(row.subtype, row.type)}|${norm}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(row);
  }

  console.log(`[dedup-locations]   ${groups.size} name-groups`);

  // Pro Gruppe: Cluster bilden, kanonisch wählen, Rest löschen.
  const toDelete: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue; // keine möglichen Duplikate
    const clusters = clusterByProximity(group, CLUSTER_RADIUS_M);
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      let canonical = cluster[0]!;
      for (let i = 1; i < cluster.length; i++) {
        if (prefer(cluster[i]!, canonical)) canonical = cluster[i]!;
      }
      for (const r of cluster) {
        if (r.code !== canonical.code) toDelete.push(r.code);
      }
    }
  }

  console.log(`[dedup-locations] ${toDelete.length} duplicate rows to delete`);

  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const batch = toDelete.slice(i, i + CHUNK);
    await db.execute(
      sql`DELETE FROM locations WHERE code IN (${sql.join(
        batch.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
    if ((i / CHUNK) % 5 === 0) {
      console.log(`[dedup-locations]   deleted ${Math.min(i + CHUNK, toDelete.length)} / ${toDelete.length}`);
    }
  }

  console.log(`[dedup-locations] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`[dedup-locations]   total deleted: ${toDelete.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[dedup-locations] failed:", err);
  process.exit(1);
});
