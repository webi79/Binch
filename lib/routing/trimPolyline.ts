/**
 * Schneidet eine Trip-Polyline auf den Abschnitt zwischen zwei Coords zu.
 *
 * Hintergrund: dbrest (HAFAS) gibt für jede Trip-ID die *komplette* Schienen-
 * Geometrie zurück — auch Abschnitte vor dem Origin und nach der Destination
 * des konkreten Legs (z.B. ein ICE Amsterdam → Berlin → München liefert auch
 * die München-Strecke, obwohl der User in Berlin aussteigt). Ohne Trim
 * zeichnen wir „Äste" die nicht zur Route gehören.
 */

interface Pt {
  latitude: number;
  longitude: number;
}

function squaredDist(coordLng: number, coordLat: number, p: Pt): number {
  const dx = coordLng - p.longitude;
  const dy = coordLat - p.latitude;
  return dx * dx + dy * dy;
}

/** Findet den Polyline-Index am nächsten zur Coord. */
function nearestIndex(coords: [number, number][], target: Pt): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const [lng, lat] = coords[i];
    const d = squaredDist(lng, lat, target);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function trimPolyline(
  coords: [number, number][],
  from: Pt,
  to: Pt,
): [number, number][] {
  if (coords.length < 2) return coords;
  let fromIdx = nearestIndex(coords, from);
  let toIdx = nearestIndex(coords, to);
  if (fromIdx > toIdx) {
    [fromIdx, toIdx] = [toIdx, fromIdx];
  }
  const sliced = coords.slice(fromIdx, toIdx + 1);
  if (sliced.length < 2) return coords; // Sicherheitsnetz — niemals Polyline ganz killen
  return sliced;
}
