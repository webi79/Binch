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

/**
 * Einmal rechnen, nicht bei jedem Aufruf.
 *
 * Die Zeile darunter sagte schon immer „Airport/Cruise sind statisch" —
 * zwischengespeichert wurde trotzdem nichts. Jeder Aufruf baute 3276
 * Flughafen-Objekte neu auf, samt Zeichenketten-Verkettung fürs Label. Und
 * aufgerufen wird das nicht selten: Der Umgebungs-Bildschirm leitet seine
 * Marker aus der Antwort ab, und deren Kennung wechselt bei jedem Stillstand
 * der Karte. Daran hängt die ganze Kette — 3276 Objekte, daraus 3276
 * GeoJSON-Merkmale, daraus eine neue Sammlung, und weil sich damit die Kennung
 * der Quelle ändert, baut MapLibre nativ die komplette Häufung neu auf.
 *
 * Träge berechnet, nicht beim Laden des Moduls: Wer die App öffnet und nie in
 * den Umgebungs-Reiter geht, soll dafür keine Startzeit zahlen.
 */
let airportCache: MapMarker[] | null = null;
let cruiseCache: MapMarker[] | null = null;

/** Liefert alle Marker für den aktuellen Modus. Airport/Cruise sind statisch. */
export function markersForMode(mode: SheetMode): MapMarker[] {
  if (mode === "airport") return (airportCache ??= airportMarkers());
  if (mode === "cruise") return (cruiseCache ??= cruiseMarkers());
  /**
   * Für den Nahverkehr gibt es hier nichts.
   *
   * Hier standen drei erfundene Marker mit Berliner Koordinaten. Der Bildschirm
   * ruft diesen Zweig zwar nicht mehr auf (er gibt bei fehlenden Serverdaten
   * selbst eine leere Liste zurück, mit ausgeschriebener Begründung), aber ein
   * erreichbarer Rückfall auf Berlin ist genau die Art Rest, die irgendwann
   * wieder auf der Karte landet.
   */
  return [];
}

/**
 * Liefert die Liste sortiert nach Distanz zum User.
 *
 * Zwischengespeichert auf eine GERUNDETE Position, nicht auf die exakte: Hier
 * werden 3276 Entfernungen gerechnet, sortiert und abgebildet. Der Ortungs-Fix
 * kommt zweistufig (erst aus dem Zwischenspeicher des Systems, bis zu acht
 * Sekunden später der frische), und jede Karten-Bewegung löst ohnehin einen
 * neuen Durchlauf aus. Auf zwei Nachkommastellen — rund einen Kilometer — ändert
 * sich an der Reihenfolge nichts, was jemand bemerkt.
 */
let listCache: { key: string; items: StopListItem[] } | null = null;

/**
 * Der Standort ist PFLICHT, und ohne ihn gibt es keine Liste.
 *
 * Hier stand der Berliner Platzhalter als Vorgabewert. Die Flughafen- und
 * Hafenliste wird nach Entfernung sortiert — ohne echten Standort bekam also
 * jeder Nutzer die Nähe von Berlin als „in deiner Nähe" ausgegeben. Eine leere
 * Liste ist die richtige Antwort auf eine Frage, die sich ohne Standort nicht
 * beantworten lässt; die Karte zeigt die Punkte ohnehin.
 */
export function listForMode(mode: SheetMode, user: Coord | null): StopListItem[] {
  if (mode !== "airport" && mode !== "cruise") return [];
  if (!user) return [];
  const key = `${mode}|${user.latitude.toFixed(2)}|${user.longitude.toFixed(2)}`;
  if (listCache?.key === key) return listCache.items;
  const items =
    mode === "airport"
      ? airportListSorted(AIRPORT_PINS, user)
      : cruiseListSorted(CRUISE_PORT_PINS, user);
  listCache = { key, items };
  return items;
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

/**
 * Hier standen vier fest eingetragene Punkte mit Berliner Koordinaten — zwei
 * Parks, ein Laden, ein Restaurant. Sie stammten aus der Aufbauphase und wurden
 * jedem Nutzer auf die Karte gezeichnet, egal wo er sich befand: zwei Bäume,
 * eine Tasche und ein Besteck mitten in Berlin. Es gibt keine Datenquelle
 * dahinter, also sind sie ersatzlos entfallen.
 */
