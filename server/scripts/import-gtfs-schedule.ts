/**
 * GTFS-Schedule-Importer — lädt routes/trips/stop_times/calendar in unsere
 * eigenen Tabellen. Damit können wir Departure-Boards für Länder bedienen die
 * kein funktionierendes hafas-client Profile haben (NL/FR/IT/ES/CZ/etc.).
 *
 * Aufruf:
 *   GTFS_DIR=/tmp/gtfs-nl GTFS_FEED_ID=nl-ovapi npx tsx scripts/import-gtfs-schedule.ts
 *
 * Env-Vars:
 *   GTFS_DIR     — Verzeichnis mit den entpackten GTFS-Files (txt)
 *   GTFS_FEED_ID — Discriminator (max 32 chars). Pro Country/Feed eindeutig.
 *
 * stop_times.txt kann mehrere Millionen Zeilen haben → wir streamen Zeile für
 * Zeile statt alles in Memory zu laden, und schreiben in 5k-Batches.
 *
 * Re-Import: Vor dem Schreiben werden ALLE Rows mit dem gegebenen feed_id
 * gelöscht. Damit kann täglich/wöchentlich frisch importiert werden ohne
 * Konflikte.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  gtfsCalendar,
  gtfsCalendarDates,
  gtfsRoutes,
  gtfsTrips,
  gtfsStops,
  gtfsStopTimes,
} from "../src/db/schema.js";

const GTFS_DIR = process.env.GTFS_DIR ?? "/tmp/gtfs";
const FEED_ID = (process.env.GTFS_FEED_ID ?? "").trim();
if (!FEED_ID) {
  console.error("GTFS_FEED_ID env var required (z.B. nl-ovapi)");
  process.exit(1);
}
if (FEED_ID.length > 32) {
  console.error("GTFS_FEED_ID darf max 32 Zeichen lang sein");
  process.exit(1);
}

const CHUNK_SMALL = 1000;
const CHUNK_LARGE = 5000; // für stop_times

/** Minimaler CSV-Parser: split per comma, respektiert "..."-Quotes mit
 *  escaped doubles ("" innerhalb von Quotes = literal "). GTFS-CSVs sind
 *  i.d.R. simpel — kein newline in fields. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** Streamt eine GTFS-CSV zeilenweise, ruft `onRow(record)` für jeden
 *  Datensatz. Erste Zeile = Header (definiert die Keys). */
async function streamCsv(
  path: string,
  onRow: (row: Record<string, string>) => Promise<void> | void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let header: string[] | null = null;
  for await (const rawLine of rl) {
    // BOM strippen (manche Feeds haben UTF-8-BOM in der ersten Zeile)
    const line = header === null ? rawLine.replace(/^﻿/, "") : rawLine;
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (header === null) {
      header = cols.map((c) => c.trim());
      continue;
    }
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]!] = cols[i] ?? "";
    }
    await onRow(row);
  }
}

/** "HH:MM:SS" → Sekunden seit Mitternacht. GTFS erlaubt >24h (z.B. "25:30:00"
 *  für Nachtbus die über Mitternacht weiterfährt) — das funktioniert hier auch. */
function timeToSeconds(s: string): number {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s.trim());
  if (!m) return -1;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Date "YYYYMMDD" → ISO date "YYYY-MM-DD" (für Postgres date). */
function gtfsDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Type alias for the transaction handle. Drizzle's transaction callback gives
 *  us a `Tx` that has the same insert/execute API as `db` — wir reichen das in
 *  alle Helper rein damit der ganze Import in einer Postgres-Transaction läuft.
 *  Vorteil: MVCC zeigt Readern während des Imports die ALTEN Daten, beim
 *  COMMIT atomar umgeschaltet. Kein Empty-Window mehr für App-User. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function importCalendar(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "calendar.txt");
  let batch: typeof gtfsCalendar.$inferInsert[] = [];
  let total = 0;
  try {
    await streamCsv(path, async (r) => {
      const start = gtfsDate(r["start_date"] ?? "");
      const end = gtfsDate(r["end_date"] ?? "");
      if (!start || !end || !r["service_id"]) return;
      batch.push({
        feedId: FEED_ID,
        serviceId: r["service_id"],
        monday: r["monday"] === "1",
        tuesday: r["tuesday"] === "1",
        wednesday: r["wednesday"] === "1",
        thursday: r["thursday"] === "1",
        friday: r["friday"] === "1",
        saturday: r["saturday"] === "1",
        sunday: r["sunday"] === "1",
        startDate: start,
        endDate: end,
      });
      if (batch.length >= CHUNK_SMALL) {
        await tx.insert(gtfsCalendar).values(batch);
        total += batch.length;
        batch = [];
      }
    });
    if (batch.length) {
      await tx.insert(gtfsCalendar).values(batch);
      total += batch.length;
    }
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      console.log(`[${FEED_ID}] calendar.txt fehlt — skip (manche Feeds nutzen nur calendar_dates)`);
      return;
    }
    throw e;
  }
  console.log(`[${FEED_ID}] calendar: ${total} services`);
}

async function importCalendarDates(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "calendar_dates.txt");
  let batch: typeof gtfsCalendarDates.$inferInsert[] = [];
  let total = 0;
  try {
    await streamCsv(path, async (r) => {
      const date = gtfsDate(r["date"] ?? "");
      if (!date || !r["service_id"]) return;
      const ex = Number(r["exception_type"] ?? "1");
      if (ex !== 1 && ex !== 2) return;
      batch.push({
        feedId: FEED_ID,
        serviceId: r["service_id"],
        date,
        exceptionType: ex,
      });
      if (batch.length >= CHUNK_SMALL) {
        await tx.insert(gtfsCalendarDates).values(batch);
        total += batch.length;
        batch = [];
      }
    });
    if (batch.length) {
      await tx.insert(gtfsCalendarDates).values(batch);
      total += batch.length;
    }
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") {
      console.log(`[${FEED_ID}] calendar_dates.txt fehlt — skip`);
      return;
    }
    throw e;
  }
  console.log(`[${FEED_ID}] calendar_dates: ${total} exceptions`);
}

async function importRoutes(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "routes.txt");
  let batch: typeof gtfsRoutes.$inferInsert[] = [];
  let total = 0;
  await streamCsv(path, async (r) => {
    if (!r["route_id"]) return;
    const type = Number(r["route_type"] ?? "3");
    batch.push({
      feedId: FEED_ID,
      routeId: r["route_id"],
      agencyId: r["agency_id"] || null,
      shortName: r["route_short_name"] || null,
      longName: r["route_long_name"] || null,
      type: Number.isFinite(type) ? type : 3,
      color: r["route_color"] ? r["route_color"].slice(0, 8) : null,
      textColor: r["route_text_color"] ? r["route_text_color"].slice(0, 8) : null,
    });
    if (batch.length >= CHUNK_SMALL) {
      await tx.insert(gtfsRoutes).values(batch);
      total += batch.length;
      batch = [];
    }
  });
  if (batch.length) {
    await tx.insert(gtfsRoutes).values(batch);
    total += batch.length;
  }
  console.log(`[${FEED_ID}] routes: ${total}`);
}

async function importTrips(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "trips.txt");
  let batch: typeof gtfsTrips.$inferInsert[] = [];
  let total = 0;
  await streamCsv(path, async (r) => {
    if (!r["trip_id"] || !r["route_id"] || !r["service_id"]) return;
    const dirRaw = r["direction_id"];
    const dir = dirRaw === "" || dirRaw === undefined ? null : Number(dirRaw);
    batch.push({
      feedId: FEED_ID,
      tripId: r["trip_id"].slice(0, 192),
      routeId: r["route_id"].slice(0, 128),
      serviceId: r["service_id"].slice(0, 128),
      headsign: r["trip_headsign"] || null,
      directionId: dir,
    });
    if (batch.length >= CHUNK_LARGE) {
      await tx.insert(gtfsTrips).values(batch);
      total += batch.length;
      batch = [];
      if (total % 50_000 === 0) console.log(`[${FEED_ID}] trips: ${total}`);
    }
  });
  if (batch.length) {
    await tx.insert(gtfsTrips).values(batch);
    total += batch.length;
  }
  console.log(`[${FEED_ID}] trips: ${total}`);
}

async function importStops(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "stops.txt");
  let batch: typeof gtfsStops.$inferInsert[] = [];
  let total = 0;
  await streamCsv(path, async (r) => {
    if (!r["stop_id"]) return;
    const locType = r["location_type"] ? Number(r["location_type"]) : 0;
    const lat = r["stop_lat"] ? Number(r["stop_lat"]) : NaN;
    const lon = r["stop_lon"] ? Number(r["stop_lon"]) : NaN;
    batch.push({
      feedId: FEED_ID,
      stopId: r["stop_id"].slice(0, 128),
      parentStation: r["parent_station"] ? r["parent_station"].slice(0, 128) : null,
      name: r["stop_name"] || null,
      locationType: Number.isFinite(locType) ? locType : 0,
      latitude: Number.isFinite(lat) ? String(lat.toFixed(6)) : null,
      longitude: Number.isFinite(lon) ? String(lon.toFixed(6)) : null,
    });
    if (batch.length >= CHUNK_LARGE) {
      await tx.insert(gtfsStops).values(batch);
      total += batch.length;
      batch = [];
    }
  });
  if (batch.length) {
    await tx.insert(gtfsStops).values(batch);
    total += batch.length;
  }
  console.log(`[${FEED_ID}] stops: ${total}`);
}

async function importStopTimes(tx: Tx): Promise<void> {
  const path = resolve(GTFS_DIR, "stop_times.txt");
  let batch: typeof gtfsStopTimes.$inferInsert[] = [];
  let total = 0;
  await streamCsv(path, async (r) => {
    const tripId = r["trip_id"];
    const stopId = r["stop_id"];
    const seq = Number(r["stop_sequence"] ?? "");
    const dep = timeToSeconds(r["departure_time"] ?? r["arrival_time"] ?? "");
    const arr = timeToSeconds(r["arrival_time"] ?? r["departure_time"] ?? "");
    if (!tripId || !stopId || !Number.isFinite(seq) || dep < 0 || arr < 0) return;
    batch.push({
      feedId: FEED_ID,
      tripId: tripId.slice(0, 192),
      stopSequence: seq,
      stopId: stopId.slice(0, 128),
      arrivalSeconds: arr,
      departureSeconds: dep,
      pickupType: r["pickup_type"] ? Number(r["pickup_type"]) : 0,
      dropOffType: r["drop_off_type"] ? Number(r["drop_off_type"]) : 0,
    });
    if (batch.length >= CHUNK_LARGE) {
      await tx.insert(gtfsStopTimes).values(batch);
      total += batch.length;
      batch = [];
      if (total % 500_000 === 0) console.log(`[${FEED_ID}] stop_times: ${total}`);
    }
  });
  if (batch.length) {
    await tx.insert(gtfsStopTimes).values(batch);
    total += batch.length;
  }
  console.log(`[${FEED_ID}] stop_times: ${total}`);
}

async function purgeFeed(tx: Tx): Promise<void> {
  // Vor dem Re-Import alles platt machen damit es keine Duplikate gibt.
  console.log(`[${FEED_ID}] purging existing rows…`);
  await tx.execute(sql`DELETE FROM gtfs_stop_times WHERE feed_id = ${FEED_ID}`);
  await tx.execute(sql`DELETE FROM gtfs_trips WHERE feed_id = ${FEED_ID}`);
  await tx.execute(sql`DELETE FROM gtfs_routes WHERE feed_id = ${FEED_ID}`);
  await tx.execute(sql`DELETE FROM gtfs_stops WHERE feed_id = ${FEED_ID}`);
  await tx.execute(sql`DELETE FROM gtfs_calendar WHERE feed_id = ${FEED_ID}`);
  await tx.execute(sql`DELETE FROM gtfs_calendar_dates WHERE feed_id = ${FEED_ID}`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`[${FEED_ID}] importing from ${GTFS_DIR}`);
  // EINE große Postgres-Transaction für den ganzen Re-Import. Effekt für
  // Reader (= unsere App-User die gerade Departures abfragen): die sehen
  // dank MVCC die ganze Zeit die ALTEN Daten. Erst beim COMMIT am Ende
  // wird atomar umgeschaltet — kein „Empty-Window" mehr während der 8min
  // NL-Import. Bei Crash rollt Postgres alles zurück, der Cache bleibt
  // konsistent.
  //
  // Postgres-Caveat: lange Transaktionen halten WAL-Space und blockieren
  // Vacuum bis sie commit'en. 8-10min sind völlig OK, das macht autovacuum
  // danach problemlos wett.
  await db.transaction(async (tx) => {
    await purgeFeed(tx);
    // Reihenfolge: calendar/routes ohne Foreign-Keys zuerst, dann trips,
    // dann stop_times (das größte). Innerhalb der Transaction wirkt's nach
    // außen sowieso atomar.
    await importCalendar(tx);
    await importCalendarDates(tx);
    await importRoutes(tx);
    await importStops(tx);
    await importTrips(tx);
    await importStopTimes(tx);
  });
  console.log(`[${FEED_ID}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${FEED_ID}] failed:`, err);
  process.exit(1);
});
