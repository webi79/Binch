import type { TravelMode } from "../db/schema.js";
import type { SearchProvider } from "./types.js";
import { googleFlightsProvider } from "./flight/googleFlights.js";
import { skyscannerProvider } from "./flight/skyscanner.js";
import { amadeusProvider } from "./flight/amadeus.js";
import { trainlineProvider } from "./train/trainline.js";
import { dbVendoProvider } from "./train/dbVendo.js";
import { flixbusProvider } from "./bus/flixbus.js";
import { busbudProvider } from "./bus/busbud.js";
import { cruisedirectProvider } from "./cruise/cruisedirect.js";

const REGISTRY: Record<TravelMode, SearchProvider[]> = {
  FLIGHT: [googleFlightsProvider, skyscannerProvider, amadeusProvider],
  TRAIN: [trainlineProvider, dbVendoProvider],
  BUS: [flixbusProvider, busbudProvider],
  CRUISE: [cruisedirectProvider],
};

export function providersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode];
}

export function activeProvidersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode].filter((p) => p.isConfigured());
}
