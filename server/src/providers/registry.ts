import type { TravelMode } from "../db/schema.js";
import type { SearchProvider } from "./types.js";
import { searchApiFlightsProvider } from "./flight/searchApiFlights.js";
import { googleFlightsProvider } from "./flight/googleFlights.js";
import { skyscannerProvider } from "./flight/skyscanner.js";
import { amadeusProvider } from "./flight/amadeus.js";
import { trainlineProvider } from "./train/trainline.js";
import { dbVendoProvider } from "./train/dbVendo.js";
import { transitScheduleProvider } from "./train/transitSchedule.js";
import { flixbusProvider } from "./bus/flixbus.js";
import { busbudProvider } from "./bus/busbud.js";
import { cruisedirectProvider } from "./cruise/cruisedirect.js";

const REGISTRY: Record<TravelMode, SearchProvider[]> = {
  // SearchAPI.io ist der primäre Flug-Provider (volle Provider-Listen + günstige
  // Tarife, deterministisch). google-flights2 läuft NICHT mehr parallel mit —
  // es ist Fallback (siehe FALLBACK), wird also nur gecallt wenn SearchAPI 0
  // Treffer liefert (z.B. Ausfall) ODER bei Round-Trip (SearchAPI gibt one-way-
  // only zurück, g-f2 liefert Round-Trips kombiniert in einem Call).
  FLIGHT: [searchApiFlightsProvider, skyscannerProvider, amadeusProvider],
  // transitSchedule liefert NUR für Tram/U-Bahn-Origin bzw. GTFS-only-Länder
  // (NL/BE/CZ/GB/…) Schedule-Cards (price=0, "Tarif beim Anbieter"). Für
  // normale Bahnhöfe macht der Provider früh `empty()` und kostet nichts.
  TRAIN: [trainlineProvider, dbVendoProvider, transitScheduleProvider],
  // dbVendo (HAFAS) ist intermodal und liefert auch Bus-Verbindungen — vor
  // allem für regionale/Verbund-Strecken die FlixBus/Busbud gar nicht im
  // Angebot haben. Reihenfolge: erst dbVendo (lokale ÖPNV-Strecken), dann
  // FlixBus/Busbud (internationale/Fernbusse).
  BUS: [dbVendoProvider, flixbusProvider, busbudProvider],
  CRUISE: [cruisedirectProvider],
};

// Fallback-Provider: laufen NUR wenn die Primaries (REGISTRY) 0 Treffer liefern.
// Spart Kosten/Quota — der teure Doppel-Call passiert nur im Ausfall-/Round-Trip-
// Fall, nicht bei jeder Suche.
const FALLBACK: Partial<Record<TravelMode, SearchProvider[]>> = {
  FLIGHT: [googleFlightsProvider],
};

export function providersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode];
}

export function activeProvidersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode].filter((p) => p.isConfigured());
}

export function activeFallbackProvidersForMode(mode: TravelMode): SearchProvider[] {
  return (FALLBACK[mode] ?? []).filter((p) => p.isConfigured());
}
