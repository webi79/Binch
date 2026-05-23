/**
 * Re-importiert NUR die stops.txt eines GTFS-Feeds (mit lat/lon Coords).
 * Schnelle Variante des grossen import-gtfs-schedule.ts — überspringt
 * trips/stop_times/calendar damit es Minuten statt Stunden braucht.
 *
 * Aufruf:
 *   GTFS_DIR=/tmp/gtfs-nl GTFS_FEED_ID=nl-ovapi npx tsx scripts/reimport-gtfs-stops.ts
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { gtfsStops } from "../src/db/schema.js";

const GTFS_DIR = process.env.GTFS_DIR ?? "/tmp/gtfs";
const FEED_ID = (process.env.GTFS_FEED_ID ?? "").trim();
if (!FEED_ID) {
  console.error("GTFS_FEED_ID env var required");
  process.exit(1);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const path = resolve(GTFS_DIR, "stops.txt");
  console.log(`[${FEED_ID}] purging existing gtfs_stops…`);
  await db.execute(sql`DELETE FROM gtfs_stops WHERE feed_id = ${FEED_ID}`);

  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;
  let batch: typeof gtfsStops.$inferInsert[] = [];
  let total = 0;
  const CHUNK = 5000;

  for await (const rawLine of rl) {
    const line = header === null ? rawLine.replace(/^﻿/, "") : rawLine;
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (header === null) { header = cols.map((c) => c.trim()); continue; }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = cols[i] ?? "";
    if (!row["stop_id"]) continue;
    const locType = row["location_type"] ? Number(row["location_type"]) : 0;
    const lat = row["stop_lat"] ? Number(row["stop_lat"]) : NaN;
    const lon = row["stop_lon"] ? Number(row["stop_lon"]) : NaN;
    batch.push({
      feedId: FEED_ID,
      stopId: row["stop_id"].slice(0, 128),
      parentStation: row["parent_station"] ? row["parent_station"].slice(0, 128) : null,
      name: row["stop_name"] || null,
      locationType: Number.isFinite(locType) ? locType : 0,
      latitude: Number.isFinite(lat) ? String(lat.toFixed(6)) : null,
      longitude: Number.isFinite(lon) ? String(lon.toFixed(6)) : null,
    });
    if (batch.length >= CHUNK) {
      await db.insert(gtfsStops).values(batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length) { await db.insert(gtfsStops).values(batch); total += batch.length; }
  console.log(`[${FEED_ID}] stops: ${total} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
