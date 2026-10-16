/**
 * FLUGBÖGEN IN DER LUFT — für den Globus.
 *
 * Auf der Kugel lag ein Flug als Linie auf dem Boden. Ein Flug gehört aber in
 * die Luft: Der Bogen steigt vom Abflughafen auf und landet am Ziel, wie in
 * Google Earth. Er ist eine ECHTE LINIE, nur gehoben — glatt und geglättet wie
 * am Boden. Das kann die selbst gebaute MapLibre-Bibliothek (Patch in
 * `vendor/maplibre-native/`): In Linien-Ebenen, deren ID mit `binch-arc`
 * beginnt, hebt der Shader jeden Punkt auf Höhe · sin(π · t). Die Höhe des
 * Scheitels kommt in Kilometern über `line-gap-width` (ein Bogen hat keine
 * Lücke), der Fortschritt t entlang des Fluges aus der Linien-Metrik der Quelle
 * (`lineMetrics`), die Mercator-Länge des Fluges über `line-offset` (ein Bogen
 * ist nicht versetzt) — mit ihr spannt der Shader das Band im Bildschirmraum
 * auf, quer zur Richtung samt Steigung, damit es auch geneigt nicht von der
 * Kante gesehen verschwindet.
 *
 * Vorher war der Bogen eine Kette schwebender Quader (fill-extrusion); deren
 * flache Dächer lagen im Anstieg gestuft, und die Perspektive machte jede Stufe
 * sichtbar — der Bogen wirkte treppig, wie fein man ihn auch teilte.
 */

interface Coord {
  latitude: number;
  longitude: number;
}

/** Ab hier blendet der Bogen aus, bei `ARC_FADE_END` ist er weg (die Linie am Boden übernimmt). */
export const ARC_FADE_START = 4;
export const ARC_FADE_END = 5;

/** Präfix der Ebenen-ID, an dem der Shader den Bogen erkennt — nicht ändern. */
export const ARC_LAYER_PREFIX = "binch-arc";

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

function distanceKm(a: Coord, b: Coord): number {
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLng = (b.longitude - a.longitude) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * DEG) * Math.cos(b.latitude * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Auf 5 Nachkommastellen (~1 m). */
const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * Je Etappe eine Linie auf dem Großkreis, alle ~25 km ein Punkt (der Shader hebt
 * jeden Punkt einzeln — zwischen zweien ist die Linie gerade), mit der
 * Scheitelhöhe `apexKm`. Die Quelle braucht `lineMetrics` und `tolerance={0}`:
 * Vereinfachte sie die fast gerade Bodenlinie, fehlten dem Bogen die Stützpunkte.
 */
export function flightArcLines(legs: { from: Coord; to: Coord }[]) {
  const features: {
    type: "Feature";
    geometry: { type: "LineString"; coordinates: [number, number][] };
    properties: { apexKm: number; mercatorLength: number };
  }[] = [];
  for (const { from, to } of legs) {
    const km = distanceKm(from, to);
    // Fast genau gegenüber auf der Erdkugel gibt es keinen eindeutigen Großkreis
    // (und `slerp` teilte durch ~0) — kein Flug fliegt so, dann eben kein Bogen.
    if (km < 1 || km / EARTH_RADIUS_KM > Math.PI - 1e-3) continue;
    // Drei Zehntel der Strecke: So hoch steht der Bogen auch von oben gesehen
    // sichtbar über seiner Bodenspur. Gedeckelt, damit ein Flug um die halbe
    // Welt nicht aus dem Bild steigt.
    const apexKm = Math.min(2500, Math.max(40, 0.3 * km));
    const steps = Math.min(800, Math.max(48, Math.round(km / 25)));
    const angle = km / EARTH_RADIUS_KM;
    const a = toVec(from);
    const b = toVec(to);
    const coordinates: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const [lon, lat] = slerp(a, b, angle, i / steps);
      // Über die Datumsgrenze hinweg ohne Sprung (MapLibre zeichnet die Länge
      // jenseits von ±180 auf der Kugel an der richtigen Stelle).
      let x = lon;
      const prev = coordinates[coordinates.length - 1];
      if (prev) {
        while (x - prev[0] > 180) x -= 360;
        while (x - prev[0] < -180) x += 360;
      }
      coordinates.push([round5(x), round5(lat)]);
    }
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: { apexKm, mercatorLength: mercatorLength(coordinates) },
    });
  }
  return { type: "FeatureCollection" as const, features };
}

/**
 * Länge der Linie in Web-Mercator, gemessen in Weltbreiten — so misst MapLibre den
 * Fortschritt entlang der Linie (`lineMetrics`), und so rechnet der Shader ihn um.
 */
function mercatorLength(coordinates: [number, number][]): number {
  const project = ([lon, lat]: [number, number]) => {
    const r = Math.max(-85.0511, Math.min(85.0511, lat)) * DEG;
    return [lon / 360 + 0.5, (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2] as const;
  };
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [x0, y0] = project(coordinates[i - 1]!);
    const [x1, y1] = project(coordinates[i]!);
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  return total;
}

type Vec3 = [number, number, number];
function toVec(c: Coord): Vec3 {
  const la = c.latitude * DEG;
  const lo = c.longitude * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

/** Punkt auf dem Großkreis bei Anteil t (0 = Start, 1 = Ziel), als [Länge, Breite]. */
function slerp(a: Vec3, b: Vec3, angle: number, t: number): [number, number] {
  if (angle < 1e-9) return [Math.atan2(a[1], a[0]) / DEG, Math.atan2(a[2], Math.hypot(a[0], a[1])) / DEG];
  const sa = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sa;
  const wb = Math.sin(t * angle) / sa;
  const x = wa * a[0] + wb * b[0];
  const y = wa * a[1] + wb * b[1];
  const z = wa * a[2] + wb * b[2];
  return [Math.atan2(y, x) / DEG, Math.atan2(z, Math.hypot(x, y)) / DEG];
}
