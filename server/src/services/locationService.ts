import { ilike, or, and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import type { LocationType } from "../db/schema.js";
import { flixbusLiveLocations, dbRestLiveLocations } from "./liveLocations.js";

export interface ClientLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: LocationType;
}

/**
 * Sucht Locations für die Autocomplete.
 *
 * Strategie:
 *   - FLIGHT  → ausschließlich lokale DB (IATA-Airports, ~390 Einträge)
 *   - CRUISE  → ausschließlich lokale DB (~40 Häfen)
 *   - BUS     → lokale DB-City-Treffer (type=ALL) + LIVE FlixBus-Autocomplete
 *   - TRAIN   → lokale DB-City-Treffer (type=ALL) + LIVE db-rest /stations
 *   - ALL     → komplette lokale DB
 *
 * Live-Quellen werden parallel gefetcht und mit lokalen Treffern gemerged.
 * Dedup: über `code`. Bei externen Treffern hat der `code`-Prefix das Format
 * `flix:<uuid>` bzw. `dbrest:<id>`, damit Provider-Search später wieder ableiten kann.
 */
export async function searchLocations(
  query: string,
  type: LocationType | "ALL",
  limit = 20,
): Promise<ClientLocation[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  const dbResults = await searchLocalDb(q, type, limit);

  if (type === "BUS" || type === "TRAIN") {
    const live = type === "BUS" ? flixbusLiveLocations(q) : dbRestLiveLocations(q);
    const liveResults = await live.catch(() => []);
    return mergeAndCap([...dbResults, ...liveResults], limit);
  }

  return dbResults;
}

async function searchLocalDb(
  q: string,
  type: LocationType | "ALL",
  limit: number,
): Promise<ClientLocation[]> {
  const like = `%${q}%`;

  // Mode-spezifische Filter:
  //   - FLIGHT/CRUISE: nur exakter Type
  //   - BUS/TRAIN: type=ALL (Cities) — die echten Stationen kommen via Live-Quelle
  //   - ALL: kein Filter
  let typeFilter;
  if (type === "FLIGHT" || type === "CRUISE") {
    typeFilter = eq(locations.type, type);
  } else if (type === "BUS" || type === "TRAIN") {
    typeFilter = eq(locations.type, "ALL");
  } else {
    typeFilter = undefined;
  }

  const textFilter = or(
    ilike(locations.label, like),
    ilike(locations.city, like),
    ilike(locations.country, like),
    ilike(locations.code, like),
  );

  const where = typeFilter ? and(textFilter, typeFilter) : textFilter;

  const rows = await db
    .select()
    .from(locations)
    .where(where)
    .orderBy(sql`length(${locations.label}) asc`)
    .limit(limit);

  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    city: r.city,
    country: r.country,
    type: r.type,
  }));
}

function mergeAndCap(list: ClientLocation[], limit: number): ClientLocation[] {
  const seen = new Set<string>();
  const out: ClientLocation[] = [];
  for (const l of list) {
    if (seen.has(l.code)) continue;
    seen.add(l.code);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}
