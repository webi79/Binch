/**
 * Live-Quellen für Locations-Autocomplete. Werden vom locationService
 * aufgerufen, um lokale DB-Treffer mit Tausenden externer Stationen
 * zu ergänzen — ohne dass wir riesige Listen lokal pflegen müssen.
 *
 *   - flixbusLiveLocations  → BUS (FlixBus Autocomplete via RapidAPI)
 *   - dbRestLiveLocations   → TRAIN (db-rest, public, no auth)
 */
import { config } from "../config.js";
import { flixbusAutocomplete, type AutocompleteItem } from "../providers/bus/flixbus.js";
import type { LocationType } from "../db/schema.js";

export interface LiveLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: LocationType;
}

interface DbRestStation {
  id?: string;
  name?: string;
  type?: string;
  location?: { latitude?: number; longitude?: number };
}

export async function flixbusLiveLocations(
  query: string,
  signal?: AbortSignal,
): Promise<LiveLocation[]> {
  const items = await flixbusAutocomplete(query, signal);
  const out: LiveLocation[] = [];
  const seenCity = new Set<string>();

  for (const item of items) {
    const cityName = item.city?.name ?? item.name;
    const cityId = item.city?.id ?? item.id;
    if (!cityId || !cityName) continue;

    // City-Eintrag (einmal pro City)
    if (!seenCity.has(cityId)) {
      seenCity.add(cityId);
      out.push({
        code: `flix:${cityId}`,
        label: cityName,
        city: cityName,
        country: item.country?.name ?? null,
        type: "BUS",
      });
    }

    // Optional: spezifische Station, wenn sie nicht selbst eine City ist
    if (item.id && item.id !== cityId && item.name && item.name !== cityName) {
      out.push({
        code: `flix:${item.id}`,
        label: `${item.name} (${cityName})`,
        city: cityName,
        country: item.country?.name ?? null,
        type: "BUS",
      });
    }
  }

  return out.slice(0, 25);
}

export async function dbRestLiveLocations(
  query: string,
  signal?: AbortSignal,
): Promise<LiveLocation[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  const url = new URL(`${config.DBREST_BASE_URL}/stations`);
  url.searchParams.set("query", trimmed);
  url.searchParams.set("limit", "25");

  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as DbRestStation[] | Record<string, DbRestStation> | null;
  if (!data) return [];

  // db-rest /stations gibt entweder Array oder Object zurück.
  const list = Array.isArray(data) ? data : Object.values(data);

  const out: LiveLocation[] = [];
  for (const s of list) {
    if (!s?.id || !s?.name) continue;
    out.push({
      code: `dbrest:${s.id}`,
      label: s.name,
      city: s.name,
      country: "Germany",
      type: "TRAIN",
    });
  }
  return out.slice(0, 25);
}

export type { AutocompleteItem };
