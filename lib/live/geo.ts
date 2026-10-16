/**
 * Geometrie für die Live-Ansicht — Punkte entlang einer Linie, Richtung,
 * Versatz in Metern. Lokal flach gerechnet: Ein Fahrzeug ist ein paar Dutzend
 * Meter lang, eine Kurve ein paar hundert — auf diesen Längen ist die Erde eben.
 */
import type { LngLat } from "./types";

const R = 6_371_000;
const RAD = Math.PI / 180;

/** Abstand in Metern (Haversine — auch über lange Strecken genau). */
export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Richtung von a nach b in Grad (0 = Norden, im Uhrzeigersinn). */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * RAD;
  const φ2 = b[1] * RAD;
  const Δλ = (b[0] - a[0]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Punkt `east`/`north` Meter neben `p`. */
export function offsetM(p: LngLat, east: number, north: number): LngLat {
  return [p[0] + east / (R * RAD * Math.cos(p[1] * RAD)), p[1] + north / (R * RAD)];
}

/** Index des Stücks, auf dem `d` liegt (cum[i] ≤ d < cum[i+1]), binäre Suche. */
function segmentAt(cum: number[], d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Punkt bei `d` Metern entlang der Linie. Vor dem Anfang und hinter dem Ende
 * geht es GERADE weiter (Richtung des ersten bzw. letzten Stücks) — ein Zug am
 * Startbahnhof hat Wagen hinter der Spitze, die noch auf dem Gleis davor stehen.
 */
export function pointAt(coords: LngLat[], cum: number[], d: number): LngLat {
  const n = coords.length;
  if (n === 1) return coords[0]!;
  const total = cum[n - 1]!;
  if (d < 0) {
    const a = coords[0]!;
    const b = coords[1]!;
    const len = Math.max(1e-6, cum[1]!);
    return [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len];
  }
  if (d > total) {
    const a = coords[n - 2]!;
    const b = coords[n - 1]!;
    const len = Math.max(1e-6, total - cum[n - 2]!);
    const over = d - total;
    return [b[0] + ((b[0] - a[0]) * over) / len, b[1] + ((b[1] - a[1]) * over) / len];
  }
  const i = segmentAt(cum, d);
  const span = cum[i + 1]! - cum[i]!;
  const t = span > 0 ? (d - cum[i]!) / span : 0;
  const a = coords[i]!;
  const b = coords[i + 1]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Fahrtrichtung bei `d`: aus den Punkten `look` Meter davor und danach —
 * geglättet, sonst zuckte das Fahrzeug an jedem Knick der Linie.
 */
export function bearingAt(coords: LngLat[], cum: number[], d: number, look = 20): number {
  const a = pointAt(coords, cum, d - look);
  const b = pointAt(coords, cum, d + look);
  if (a[0] === b[0] && a[1] === b[1]) return 0;
  return bearingDeg(a, b);
}

/** Der Teil der Linie zwischen zwei Längen (für „gefahren" / „noch zu fahren"). */
export function sliceLine(coords: LngLat[], cum: number[], from: number, to: number): LngLat[] {
  const total = cum[cum.length - 1] ?? 0;
  const a = Math.max(0, Math.min(total, from));
  const b = Math.max(0, Math.min(total, to));
  if (b <= a) return [];
  const out: LngLat[] = [pointAt(coords, cum, a)];
  for (let i = 0; i < coords.length; i++) {
    if (cum[i]! > a && cum[i]! < b) out.push(coords[i]!);
  }
  out.push(pointAt(coords, cum, b));
  return out;
}

/** Meter je Bildpunkt bei Zoom `z` und Breite `lat` (512er-Kacheln wie MapLibre). */
export function metersPerPixel(z: number, lat: number): number {
  return (Math.cos(lat * RAD) * 2 * Math.PI * R) / (512 * 2 ** z);
}
