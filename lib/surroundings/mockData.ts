/**
 * Daten für den Surroundings-Screen.
 *
 *   - Transit: Mock-Fallback (echte Daten via /api/surroundings)
 *   - Airport: kuratierte Lat/Lng-Liste der größten Flughäfen weltweit
 *   - Cruise:  kuratierte Lat/Lng-Liste der größten Kreuzfahrt-Häfen
 */
import { AIRPORT_PINS, type AirportPin } from "./airportCoords";
import { CRUISE_PORT_PINS, type CruisePortPin } from "./cruisePortCoords";

export type MarkerKind = "train" | "subway" | "bus" | "tram" | "airport" | "cruise";
export type SheetMode = "transit" | "airport" | "cruise";

export interface Coord {
  latitude: number;
  longitude: number;
}

export interface MapMarker {
  id: string;
  type: MarkerKind;
  /** Alle Mode-Kategorien die an dem Stop verkehren (z.B. ["subway", "bus"]
   *  für „Dortmund Barop Parkhaus"). Wenn mehr als ein Eintrag drin, rendert
   *  der MarkerLayer eine breitere abgerundete Box mit den Icons
   *  nebeneinander statt nur dem dominanten Icon. */
  kinds?: MarkerKind[];
  coord: Coord;
  label?: string;
  selected?: boolean;
  big?: boolean;
}

export interface POI {
  coord: Coord;
  kind: "park" | "shop" | "food";
}

export interface StopListItem {
  /** Stabile ID — Pflicht damit FlatList Rows korrekt diff-en kann. */
  id: string;
  name: string;
  kinds: MarkerKind[];
  lines?: { id: string; color: string }[];
  badge?: string;
  distance: string;
  selected?: boolean;
}

/** Default-Standort (Berlin Hbf) — wird im Screen durch echtes GPS überschrieben. */
export const USER_LOC: Coord = { latitude: 52.5251, longitude: 13.3669 };

export const INITIAL_REGION = {
  ...USER_LOC,
  latitudeDelta: 0.04,
  longitudeDelta: 0.04,
};

/** Haversine-Distanz in Metern zwischen zwei Lat/Lng-Punkten. */
export function distanceMeters(a: Coord, b: Coord): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

// =============================================================
// MOCK-Daten für TRANSIT (Fallback wenn Backend keine Antwort liefert)
// =============================================================

const TRANSIT_MOCK: MapMarker[] = [
  { id: "t1", type: "train", coord: { latitude: 52.5251, longitude: 13.3694 }, label: "5", big: true, selected: true },
  { id: "t2", type: "bus", coord: { latitude: 52.5202, longitude: 13.3878 }, label: "3" },
  { id: "t3", type: "tram", coord: { latitude: 52.5226, longitude: 13.4022 } },
];

const TRANSIT_LIST_MOCK: StopListItem[] = [
  {
    id: "mock:berlin-hbf",
    name: "Berlin Hauptbahnhof",
    kinds: ["train", "tram", "bus"],
    distance: "180 m",
    selected: true,
  },
];

// =============================================================
// AIRPORT + CRUISE — alle als Marker auf der Karte
// =============================================================

function airportMarkers(): MapMarker[] {
  return AIRPORT_PINS.map((a) => ({
    id: `airport:${a.iata}`,
    type: "airport",
    coord: a.coord,
    // Label-Format „Flughafenname (IATA)" — wird im StopDetailSheet-Header
    // beim Marker-Tap angezeigt.
    label: `${a.name} (${a.iata})`,
  }));
}

function cruiseMarkers(): MapMarker[] {
  return CRUISE_PORT_PINS.map((p) => ({
    id: `cruise:${p.code}`,
    type: "cruise",
    coord: p.coord,
    label: p.name,
  }));
}

/** Liefert alle Marker für den aktuellen Modus. Airport/Cruise sind statisch. */
export function markersForMode(mode: SheetMode): MapMarker[] {
  if (mode === "airport") return airportMarkers();
  if (mode === "cruise") return cruiseMarkers();
  return TRANSIT_MOCK;
}

/** Liefert die Liste sortiert nach Distanz zum User. */
export function listForMode(mode: SheetMode, user: Coord = USER_LOC): StopListItem[] {
  if (mode === "airport") return airportListSorted(AIRPORT_PINS, user);
  if (mode === "cruise") return cruiseListSorted(CRUISE_PORT_PINS, user);
  return TRANSIT_LIST_MOCK;
}

function airportListSorted(pins: AirportPin[], user: Coord): StopListItem[] {
  return pins
    .map((a) => ({
      pin: a,
      d: distanceMeters(user, a.coord),
    }))
    .sort((a, b) => a.d - b.d)
    .map(({ pin, d }, i) => ({
      id: `airport:${pin.iata}`,
      name: `${pin.name} (${pin.iata})`,
      kinds: ["airport"] as MarkerKind[],
      badge: pin.country,
      distance: formatDistance(d),
      selected: i === 0,
    }));
}

function cruiseListSorted(pins: CruisePortPin[], user: Coord): StopListItem[] {
  return pins
    .map((p) => ({
      pin: p,
      d: distanceMeters(user, p.coord),
    }))
    .sort((a, b) => a.d - b.d)
    .map(({ pin, d }, i) => ({
      id: `cruise:${pin.code}`,
      name: pin.name,
      kinds: ["cruise"] as MarkerKind[],
      badge: pin.country,
      distance: formatDistance(d),
      selected: i === 0,
    }));
}

// POIs werden weiterhin nur im Transit-Mode angezeigt (Cafés/Shops um den User)
export const POIS: POI[] = [
  { coord: { latitude: 52.5306, longitude: 13.3477 }, kind: "park" },
  { coord: { latitude: 52.5184, longitude: 13.3993 }, kind: "park" },
  { coord: { latitude: 52.5018, longitude: 13.3414 }, kind: "shop" },
  { coord: { latitude: 52.5180, longitude: 13.3909 }, kind: "food" },
];
