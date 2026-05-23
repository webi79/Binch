/**
 * Konvertiert ein SearchResult in einen RoutePlan für die Karten-Darstellung.
 * Pro Leg werden Origin + Destination als Waypoints extrahiert; aufeinander-
 * folgende Legs teilen sich den Umsteige-Punkt.
 *
 * Wenn das Backend Coords im Leg geliefert hat → die nutzen. Sonst Fallback:
 *   - Flight: Lookup in AIRPORT_PINS via IATA-Code
 *   - Cruise: Lookup in CRUISE_PORT_PINS via Code
 *   - Train/Bus: kein Fallback (HAFAS liefert immer Coords) — Waypoint wird
 *     übersprungen wenn keine Coords da sind
 */
import type { SearchResult, LegInfo, TravelMode } from "@/types/search";
import type { RoutePlan, RouteWaypoint, RouteLegGeometry } from "@/stores/searchStore";
import { AIRPORT_PINS } from "@/lib/surroundings/airportCoords";
import { CRUISE_PORT_PINS } from "@/lib/surroundings/cruisePortCoords";
import { greatCircleArc } from "@/lib/routing/greatCircle";

interface CoordLookup {
  latitude: number;
  longitude: number;
}

function lookupAirport(code: string): CoordLookup | null {
  const a = AIRPORT_PINS.find((p) => p.iata === code);
  return a ? a.coord : null;
}

function lookupCruisePort(code: string): CoordLookup | null {
  const p = CRUISE_PORT_PINS.find((x) => x.code === code);
  return p ? p.coord : null;
}

function resolveCoord(
  legCode: string,
  legLat: number | undefined,
  legLng: number | undefined,
  mode: TravelMode,
): CoordLookup | null {
  // 1. Vom Backend gelieferte Coords (HAFAS für Train/Bus)
  if (typeof legLat === "number" && typeof legLng === "number") {
    return { latitude: legLat, longitude: legLng };
  }
  // 2. Statische Lookups für Flight + Cruise
  if (mode === "FLIGHT") return lookupAirport(legCode);
  if (mode === "CRUISE") return lookupCruisePort(legCode);
  return null;
}

function markerKindFor(mode: TravelMode): RouteWaypoint["type"] {
  switch (mode) {
    case "FLIGHT":
      return "airport";
    case "TRAIN":
      return "train";
    case "BUS":
      return "bus";
    case "CRUISE":
      return "cruise";
  }
}

export function buildRoutePlan(result: SearchResult): RoutePlan | null {
  const kind = markerKindFor(result.mode);
  const waypoints: RouteWaypoint[] = [];
  const legGeometries: RouteLegGeometry[] = [];

  const legs: LegInfo[] = result.legs && result.legs.length > 0
    ? result.legs
    : [
        // Wenn kein detaillierter Legs-Array da ist: ein einziger Leg vom
        // Origin zum Destination des Tickets.
        {
          origin: result.origin,
          destination: result.destination,
          originLabel: result.originLabel,
          destLabel: result.destLabel,
          departTime: result.departTime,
          arriveTime: result.arriveTime,
          durationMinutes: result.durationMinutes,
        },
      ];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const isFirst = i === 0;
    const isLast = i === legs.length - 1;

    // Origin-Waypoint (nur am Anfang oder als „transfer" zwischen zwei Legs)
    if (isFirst) {
      const c = resolveCoord(leg.origin, leg.originLat, leg.originLng, result.mode);
      if (c) {
        waypoints.push({
          label: leg.originLabel ?? leg.origin,
          latitude: c.latitude,
          longitude: c.longitude,
          type: kind,
          role: "origin",
        });
      }
    }

    const fromIndex = Math.max(0, waypoints.length - 1);

    // Destination-Waypoint — ist entweder ein Umstieg (zwischen Legs) oder das Ziel
    const c = resolveCoord(leg.destination, leg.destLat, leg.destLng, result.mode);
    if (c) {
      waypoints.push({
        label: leg.destLabel ?? leg.destination,
        latitude: c.latitude,
        longitude: c.longitude,
        type: kind,
        role: isLast ? "destination" : "transfer",
      });
      const toIndex = waypoints.length - 1;
      // Bei Flügen die Polyline direkt als Großkreis-Arc generieren — auf der
      // Mercator-Karte ergibt das die typische gebogene Flugkurve (kurzer
      // Hop kaum gebogen, Langstrecke deutlich). Für Train/Bus warten wir
      // weiterhin auf echte Schienen-/Straßen-Polylines (per fetchTripPolylines
      // im Surroundings-Tab nachgefetched). Cruise bleibt straight (Schiffs-
      // routen folgen Küsten, kein Großkreis).
      let coords: [number, number][] | undefined;
      if (result.mode === "FLIGHT") {
        const from = waypoints[fromIndex];
        if (from) coords = greatCircleArc(from, { latitude: c.latitude, longitude: c.longitude });
      }
      legGeometries.push({
        tripId: leg.tripId,
        fromIndex,
        toIndex,
        coords,
      });
    }
  }

  if (waypoints.length < 2) return null; // ohne 2 Punkte keine Route

  return {
    mode: result.mode,
    waypoints,
    legs: legGeometries,
    title: `${result.originLabel} → ${result.destLabel}`,
  };
}
