import type { TravelMode } from "../db/schema.js";
import type { SearchProvider } from "./types.js";
import { searchApiFlightsProvider } from "./flight/searchApiFlights.js";
import { googleFlightsProvider } from "./flight/googleFlights.js";
import { skyscannerProvider } from "./flight/skyscanner.js";
import { amadeusProvider } from "./flight/amadeus.js";
import { trainlineProvider } from "./train/trainline.js";
import { dbVendoProvider } from "./train/dbVendo.js";
import { motisProvider, motisBusProvider } from "./train/motis.js";
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
  // motis + dbVendo laufen parallel, dedupe() führt sie zusammen: MOTIS deckt ab,
  // was DB nicht verkauft (CH-Nahverkehr, Tram/Bus-Zubringer), dbVendo liefert
  // DBs eigenes Routing samt Preisen, echten Gleisen und echten Zugnamen.
  TRAIN: [motisProvider, trainlineProvider, dbVendoProvider, transitScheduleProvider],

  // dbVendo ist hier wieder DRIN — aber mit Modus-Filter (siehe isBusOnly dort).
  //
  // Historie: Er lieferte ungefiltert ZÜGE in die Bus-Suche („ICE 529, 0
  // Umstiege" bei Dortmund → Frankfurt), also flog er raus. Das war zu grob —
  // damit verschwand auch der LOKALE Busverkehr, den nur er findet:
  // „Werl, Petrischule → Werl, Bahnhof" lieferte 0 Ergebnisse, obwohl der Bus 522
  // dort fährt. MOTIS kann diese Strecke prinzipbedingt nicht (Ziel in Gehweite
  // → ÖPNV wird weggeprunt), FlixBus überspringt GTFS-Stop-IDs.
  //
  // Jetzt filtert er selbst: nur Verbindungen, deren Fahrten ALLE Busse sind.
  BUS: [motisBusProvider, dbVendoProvider, flixbusProvider, busbudProvider],
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
