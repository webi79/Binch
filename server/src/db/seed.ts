/**
 * Seed-Script — befüllt die `locations`-Tabelle für Autocomplete.
 * Quellen:
 *   - data/airports.ts → type=FLIGHT (IATA-Code)
 *   - data/cities.ts CITIES → type=ALL (durchsuchbar in allen Modi, primär TRAIN/BUS)
 *   - data/cities.ts CRUISE_PORTS → type=CRUISE
 *
 * Ausführung: `npm run db:seed`
 * Re-Run sicher: ON CONFLICT DO UPDATE — Einträge werden nur überschrieben.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";
import { locations } from "./schema.js";
import type { LocationType } from "./schema.js";
import { AIRPORTS } from "../data/airports.js";
import { CITIES, CRUISE_PORTS, BUS_STATIONS } from "../data/cities.js";

interface Row {
  code: string;
  label: string;
  city: string;
  country: string;
  type: LocationType;
  /** Größenklasse bei Flughäfen (LARGE/MEDIUM/SMALL/OTHER) — die Suche
   *  sortiert danach, siehe `locationService`. */
  subtype?: string;
  /** Fernbus-Bahnhöfe und Flughäfen bringen eigene Koordinaten mit — damit
   *  resolveMotisPlace den echten ZOB trifft statt per Label zu raten.
   *  Drizzle bildet die numeric-Spalten auf `string` ab. */
  latitude?: string;
  longitude?: string;
}

function buildRows(): Row[] {
  const rows: Row[] = [];

  for (const a of AIRPORTS) {
    rows.push({
      code: a.iata,
      label: `${a.name} (${a.iata})`,
      city: a.city,
      country: a.country,
      type: "FLIGHT",
      // Größenklasse steuert die Trefferreihenfolge (siehe `locationService`),
      // Koordinaten machen Flughäfen für die Umkreissuche auffindbar — beides
      // kam bisher gar nicht in der Tabelle an.
      subtype: a.size,
      latitude: String(a.latitude),
      longitude: String(a.longitude),
    });
  }

  for (const c of CITIES) {
    rows.push({
      code: c.code,
      label: c.name,
      city: c.city,
      country: c.country,
      type: "ALL",
    });
  }

  for (const b of BUS_STATIONS) {
    rows.push({
      code: b.code,
      label: b.name,
      city: b.city,
      country: b.country,
      type: "BUS",
      latitude: String(b.latitude),
      longitude: String(b.longitude),
    });
  }

  for (const p of CRUISE_PORTS) {
    rows.push({
      code: p.code,
      label: p.name,
      city: p.city,
      country: p.country,
      type: "CRUISE",
    });
  }

  return rows;
}

async function main() {
  const rows = buildRows();
  console.log(`[seed] inserting ${rows.length} locations…`);

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    await db
      .insert(locations)
      .values(batch)
      .onConflictDoUpdate({
        target: locations.code,
        set: {
          label: sql`excluded.label`,
          city: sql`excluded.city`,
          country: sql`excluded.country`,
          type: sql`excluded.type`,
          subtype: sql`COALESCE(excluded.subtype, ${locations.subtype})`,
          // COALESCE: Vorhandene Koordinaten (aus dem GTFS-Refresh) NICHT mit
          // NULL überschreiben, nur fehlende ergänzen.
          latitude: sql`COALESCE(excluded.latitude, ${locations.latitude})`,
          longitude: sql`COALESCE(excluded.longitude, ${locations.longitude})`,
        },
      });
    console.log(`[seed]   ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
  }

  console.log("[seed] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
