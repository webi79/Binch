/**
 * Wohin die Kamera in der Live-Ansicht schaut.
 *
 * FOLGEN: schräg von hinten auf das Fahrzeug (Neigung ~58°), so nah, dass ein
 * Zug ein gutes Viertel der Bildbreite einnimmt. Ein Flugzeug fliegt hoch — die
 * Kamera muss deutlich höher stehen als es, sonst flöge es aus dem Bild (oder
 * hinter die Kamera). Darum hängt dort der Zoom an der Höhe, und der Mittelpunkt
 * liegt VOR dem Flugzeug: Ein Punkt in der Höhe h erscheint um h·tan(Neigung)
 * weiter vorn auf dem Boden, als er senkrecht darunter steht.
 *
 * DREHUNG: Die Karte dreht sich nicht mit jeder Kurve mit (das macht auf Dauer
 * schwindlig), sondern erst, wenn die Fahrtrichtung um mehr als 25° von der
 * Kamera abweicht — dann jede Sekunde um ein Viertel des Unterschieds.
 */
import { isLongDistance } from "./motion";
import { metersPerPixel, offsetM } from "./geo";
import type { LiveFrame, LiveModel } from "./model";
import type { LiveVehicleKind, LngLat } from "./types";

const RAD = Math.PI / 180;

export interface CameraTarget {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/**
 * Nah genug, dass die vorgerenderten Modelle (echte Proportionen, nur
 * maßvoll kräftiger) als Zug bzw. Bus zu lesen sind — die alten Klötze waren
 * viermal überbreit und vertrugen mehr Abstand.
 */
const FOLLOW: Record<LiveVehicleKind, { zoom: number; pitch: number }> = {
  train: { zoom: 16.6, pitch: 58 },
  subway: { zoom: 17.0, pitch: 58 },
  tram: { zoom: 17.4, pitch: 58 },
  bus: { zoom: 17.8, pitch: 58 },
  ferry: { zoom: 14.6, pitch: 55 },
};
const PLANE_PITCH = 50;
/**
 * Weiter hinein darf die Karte bei einem Flug nicht: Der Stil wechselt bei
 * `projection: globe` zwischen Zoom 10 und 12 vom Globus auf die flache Karte,
 * und ab 12 laufen die flachen Shader — dort hebt der Bogen-Patch nichts
 * (vendor/maplibre-native), die 3D-Körper aber schon. Nachgeprüft mit
 * mbgl-render: bei 11,6 sitzt das Flugzeug auf dem Bogen, bei 12,2 liegt der
 * Bogen am Boden.
 */
export const PLANE_MAX_ZOOM = 11.9;

/**
 * Wohin die Kamera blickt: Bodenfahrzeuge von hinten, Flugzeuge schräg von der
 * Seite. Von hinten lägen der Bogen in der Luft und die Bodenspur darunter auf
 * derselben Bildlinie — die Höhe wäre nicht zu sehen (mbgl-render-Probe); 50°
 * daneben steht der Bogen sichtbar über seiner Spur, mit dem Schatten darunter.
 */
export function viewHeading(model: LiveModel, f: LiveFrame): number {
  return model.kind === "plane" ? (f.heading - 50 + 360) % 360 : f.heading;
}

/** Nächste Kamera-Drehung: bleibt stehen, bis die Fahrtrichtung deutlich abweicht. */
export function nextBearing(current: number | null, heading: number): number {
  if (current == null) return heading;
  const diff = ((heading - current + 540) % 360) - 180;
  if (Math.abs(diff) <= 25) return current;
  return (current + diff * 0.25 + 360) % 360;
}

/**
 * Ziel der Kamera für einen Zustand. `mapHeight` in Punkten — die Kamera steht
 * in MapLibre 1,5 Bildhöhen über dem Mittelpunkt (Öffnungswinkel ~37°).
 */
export function cameraTarget(model: LiveModel, f: LiveFrame, bearing: number, mapHeight: number): CameraTarget {
  if (model.kind === "plane") {
    // Kamera rund viermal so hoch wie das Flugzeug, am Boden 3 km — gemessen an
    // der GEZEICHNETEN Höhe (auf dem Bogen), sonst stünde es nicht in der Mitte.
    const alt = f.drawAltitude;
    const camHeight = 4 * alt + 3_000;
    const dist = camHeight / Math.cos(PLANE_PITCH * RAD);
    const mpp = dist / (1.5 * Math.max(300, mapHeight));
    // Höchstens 11,5: Ab Zoom 12 zeichnet MapLibre flach (Ende des Globus-
    // Übergangs), und der Bogen-Shader hebt die Linie dann nicht mehr — das
    // Flugzeug schwebte über einer Linie am Boden (siehe PLANE_MAX_ZOOM).
    const zoom = Math.max(5, Math.min(PLANE_MAX_ZOOM - 0.4, Math.log2(metersPerPixel(0, f.position[1]) / mpp)));
    const ahead = alt * Math.tan(PLANE_PITCH * RAD);
    const c = offsetM(f.position, Math.sin(bearing * RAD) * ahead, Math.cos(bearing * RAD) * ahead);
    return { latitude: c[1], longitude: c[0], zoom, bearing, pitch: PLANE_PITCH };
  }
  const cfg = FOLLOW[model.kind];
  // Fernzüge sind doppelt so lang und schnell — etwas weiter weg (nicht mehr:
  // darunter werden die Wagen-Modelle vergrößert, der Zug würde überlang).
  const zoom = model.kind === "train" && isLongDistance(model.product) ? cfg.zoom - 0.2 : cfg.zoom;
  return { latitude: f.position[1], longitude: f.position[0], zoom, bearing, pitch: cfg.pitch };
}

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin(lat * RAD);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const latOfMercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/**
 * Die ganze Strecke im Bild, von oben (ohne Neigung und Drehung) — Mitte und
 * Zoom für den freien Ausschnitt `width`×`height` abzüglich `padding`.
 */
export function overviewCamera(
  coords: LngLat[],
  width: number,
  height: number,
  padding: { top: number; bottom: number; left: number; right: number },
): CameraTarget | null {
  if (coords.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lng, lat] of coords) {
    const x = mercX(lng);
    const y = mercY(lat);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const availW = Math.max(1, width - padding.left - padding.right);
  const availH = Math.max(1, height - padding.top - padding.bottom);
  const w = Math.max(1e-9, (maxX - minX) * 512);
  const h = Math.max(1e-9, (maxY - minY) * 512);
  const zoom = Math.max(2, Math.min(16, Math.log2(Math.min(availW / w, availH / h))));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { latitude: latOfMercY(cy), longitude: cx * 360 - 180, zoom, bearing: 0, pitch: 0 };
}
