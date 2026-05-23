/**
 * Great-Circle-Interpolation für Flug-Polylines.
 *
 * Flüge folgen geografisch der kürzesten Linie auf der Erdoberfläche (=
 * Großkreis). Auf einer Mercator-projizierten Karte erscheint die Großkreis-
 * Linie als gebogene Kurve — was der typischen „Flugkurve" entspricht, die
 * jeder von Flightradar etc. kennt. Kurze Flüge (Berlin → London) sehen
 * kaum gebogen aus, Langstrecke (Frankfurt → NYC) deutlich.
 *
 * Wir samplen den Großkreis in N Segmenten (Default 64) und geben eine Liste
 * von `[lng, lat]`-Tuples zurück, die direkt als MapLibre-`LineString`-
 * Coordinates verwendet werden können.
 */

interface Coord {
  latitude: number;
  longitude: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function greatCircleArc(
  from: Coord,
  to: Coord,
  segments = 64,
): [number, number][] {
  const lat1 = toRad(from.latitude);
  const lng1 = toRad(from.longitude);
  const lat2 = toRad(to.latitude);
  const lng2 = toRad(to.longitude);

  // Winkeldistanz zwischen den beiden Punkten via Haversine.
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const d = 2 * Math.asin(Math.sqrt(Math.min(1, a)));

  // Degenerierte Fälle: gleiche Punkte oder Antipoden → einfache Linie.
  if (d === 0 || !Number.isFinite(d)) {
    return [
      [from.longitude, from.latitude],
      [to.longitude, to.latitude],
    ];
  }

  const sinD = Math.sin(d);
  const out: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / sinD;
    const B = Math.sin(f * d) / sinD;
    const x = A * Math.cos(lat1) * Math.cos(lng1) + B * Math.cos(lat2) * Math.cos(lng2);
    const y = A * Math.cos(lat1) * Math.sin(lng1) + B * Math.cos(lat2) * Math.sin(lng2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y));
    const lng = Math.atan2(y, x);
    out.push([toDeg(lng), toDeg(lat)]);
  }
  return out;
}
