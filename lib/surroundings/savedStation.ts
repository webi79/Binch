/**
 * Konvertiert einen Marker-Tap im Surroundings-Tab in eine Location, wie
 * sie der searchStore.savedStations erwartet. So zeigt eine in den Surroundings
 * gespeicherte Station später auch im Search-Hero-LocationPicker (selber Code-
 * Format).
 *
 * Code-Normalisierung:
 *   - `airport:DTM` → `DTM` (matched die LocationsDB-IATA-Einträge)
 *   - `cruise:HAM`  → `HAM`
 *   - alles andere (`sta:`, `dbrest:`, `gtfs:`, `flix:`) bleibt wie es ist —
 *     diese Prefixes sind serverseitig schon kanonisch.
 *
 * Type-Ableitung folgt der dominanten Mode-Kategorie:
 *   - airport → FLIGHT, cruise → CRUISE, bus/tram → BUS, train/subway → TRAIN
 */
import type { Location, TravelMode } from "@/types/search";
import type { MarkerKind } from "@/lib/surroundings/mockData";

const KIND_TO_MODE: Record<MarkerKind, TravelMode> = {
  airport: "FLIGHT",
  cruise: "CRUISE",
  bus: "BUS",
  tram: "BUS",
  train: "TRAIN",
  subway: "TRAIN",
};

export function stopToLocation(stop: {
  code: string;
  label: string;
  kinds?: MarkerKind[];
  latitude?: number;
  longitude?: number;
}): Location {
  // Code-Prefix stripping nur für die client-seitig konstruierten Marker-IDs
  // (Airport/Cruise) — server-seitige Codes (sta:/dbrest:/gtfs:/flix:) bleiben
  // unverändert, weil der Search-Pfad sie genau in dem Format erwartet.
  const m = /^(airport|cruise):(.+)$/.exec(stop.code);
  const normalizedCode = m ? m[2]! : stop.code;

  const dominantKind = stop.kinds?.[0] ?? "bus";
  const type = KIND_TO_MODE[dominantKind];

  return {
    code: normalizedCode,
    label: stop.label,
    city: "",
    country: "",
    type,
    latitude: stop.latitude,
    longitude: stop.longitude,
  };
}
