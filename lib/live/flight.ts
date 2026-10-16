/**
 * Wo ist der Flug JETZT, und wie hoch? — aus dem Flugplan gerechnet.
 *
 * Die Flugtafel liefert Abflug und Ankunft (Plan und erwartet), Start- und
 * Zielflughafen. Positionsdaten (ADS-B) haben wir nicht. Daraus ein Flug, der
 * sich wie einer anfühlt:
 *
 *   • Am Gate bis zum Abflug, dann ROLLEN zur Startbahn (≈ 12 min), am Ziel
 *     nach der Landung zum Gate (≈ 6 min).
 *   • In der Luft auf dem GROSSKREIS — der kürzesten Strecke auf der Kugel.
 *   • HÖHE: Steigflug etwa 1 : 15 (gut 165 km bis 11 km Reiseflughöhe),
 *     Sinkflug im üblichen 3°-Gleitpfad (1 : 19). Auf Kurzstrecken nur so hoch,
 *     wie Steig- und Sinkflug es zusammen zulassen.
 *   • TEMPO: in Bodennähe ein Drittel (Start, Anflug), oben voll — so gelöst,
 *     dass die Landung zur Ankunftszeit passt.
 */
import type { LngLat } from "./types";
import { bearingDeg } from "./geo";

const R = 6_371_000;
const RAD = Math.PI / 180;
const TAXI_OUT_S = 12 * 60;
const TAXI_IN_S = 6 * 60;
const CRUISE_ALT_M = 11_000;
const CLIMB_RATIO = 15; // Meter Strecke je Meter Höhe
const DESCENT_RATIO = 19;

type Vec3 = [number, number, number];
const toVec = ([lon, lat]: LngLat): Vec3 => {
  const la = lat * RAD;
  const lo = lon * RAD;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
};

/** Punkt auf dem Großkreis bei Anteil f (0 = Start, 1 = Ziel). */
function slerp(a: Vec3, b: Vec3, angle: number, f: number): LngLat {
  if (angle < 1e-9) return [Math.atan2(a[1], a[0]) / RAD, Math.atan2(a[2], Math.hypot(a[0], a[1])) / RAD];
  const s = Math.sin(angle);
  const wa = Math.sin((1 - f) * angle) / s;
  const wb = Math.sin(f * angle) / s;
  const x = wa * a[0] + wb * b[0];
  const y = wa * a[1] + wb * b[1];
  const z = wa * a[2] + wb * b[2];
  return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
}

export interface FlightPlan {
  from: LngLat;
  to: LngLat;
  /** Gate-Abflug, Start, Landung, Gate-Ankunft (ms). */
  offBlock: number;
  takeoff: number;
  landing: number;
  onBlock: number;
  /** Großkreis-Länge, m. */
  dist: number;
  cruiseAlt: number;
  /** Reisetempo in der Luft (m/s) — so gelöst, dass die Landung passt. */
  cruiseSpeed: number;
  /** Stützstellen: Strecke (m) → Zeit seit dem Start (s). */
  xs: Float64Array;
  ts: Float64Array;
  angle: number;
  a: Vec3;
  b: Vec3;
}

export type FlightPhase = "gate" | "taxiOut" | "climb" | "cruise" | "descent" | "taxiIn" | "arrived";

export interface FlightState {
  phase: FlightPhase;
  position: LngLat;
  altitude: number; // m über Grund
  speed: number; // m/s über Grund
  heading: number; // Grad
  progress: number; // 0…1 der Strecke
  /** Strecke ab Start, m (für „gefahren"/„noch offen"). */
  x: number;
}

/** Höhe bei `x` m ab Start (Steigflug: erst steil, dann flacher; Sinkflug: Gleitpfad). */
function altitudeAt(plan: { dist: number; cruiseAlt: number }, x: number): number {
  const h = plan.cruiseAlt;
  if (h <= 0) return 0;
  const climb = h * CLIMB_RATIO;
  const descent = h * DESCENT_RATIO;
  const toGo = plan.dist - x;
  const up = x < climb ? (() => { const u = Math.max(0, x / climb); return h * u * (2 - u); })() : h;
  const down = toGo < descent ? (() => { const u = Math.max(0, toGo / descent); return h * u * (2 - u); })() : h;
  return Math.max(0, Math.min(up, down));
}

/**
 * Tempo-Faktor: in Bodennähe ein Drittel des Reisetempos (Start und Anflug
 * um 280 km/h), oben 100 %. Mit 45 % flog der Endanflug mit 370 km/h ein.
 */
const speedFactor = (alt: number, cruiseAlt: number) =>
  0.33 + 0.67 * (cruiseAlt > 0 ? Math.min(1, alt / cruiseAlt) : 1);

export function buildFlightPlan(
  from: LngLat,
  to: LngLat,
  times: { depP: string | null; depE: string | null; arrP: string | null; arrE: string | null },
): FlightPlan | null {
  const a = toVec(from);
  const b = toVec(to);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const angle = Math.acos(dot);
  const dist = angle * R;
  if (!(dist > 1000)) return null;
  const parse = (s: string | null) => (s ? Date.parse(s) : NaN);
  const offBlock = [parse(times.depE), parse(times.depP)].find(Number.isFinite);
  if (offBlock == null) return null;
  let onBlock = [parse(times.arrE), parse(times.arrP)].find(Number.isFinite);
  // Ohne Ankunftszeit: mit 800 km/h und 30 Minuten für Rollen, Start und Landung.
  if (onBlock == null || onBlock <= offBlock) onBlock = offBlock + (dist / (800 / 3.6) + 30 * 60) * 1000;
  const block = (onBlock - offBlock) / 1000;
  // Rollzeiten höchstens ein Viertel des Ganzen (Inselhüpfer).
  const taxiScale = Math.min(1, (block * 0.25) / (TAXI_OUT_S + TAXI_IN_S));
  const takeoff = offBlock + TAXI_OUT_S * taxiScale * 1000;
  const landing = onBlock - TAXI_IN_S * taxiScale * 1000;
  const airborne = Math.max(60, (landing - takeoff) / 1000);
  const cruiseAlt = Math.min(CRUISE_ALT_M, dist / (CLIMB_RATIO + DESCENT_RATIO));
  // Zeit = ∫ dx / (v · Faktor) → Reisetempo so, dass das Integral die Flugzeit trifft.
  const N = 400;
  const xs = new Float64Array(N + 1);
  const ts = new Float64Array(N + 1);
  let acc = 0;
  for (let i = 0; i <= N; i++) {
    const x = (dist * i) / N;
    xs[i] = x;
    if (i > 0) {
      const xm = (dist * (i - 0.5)) / N;
      acc += dist / N / speedFactor(altitudeAt({ dist, cruiseAlt }, xm), cruiseAlt);
    }
    ts[i] = acc; // noch in „Metern pro Tempo-1"
  }
  const cruiseSpeed = acc / airborne;
  for (let i = 0; i <= N; i++) ts[i] = ts[i]! / cruiseSpeed;
  return { from, to, offBlock, takeoff, landing, onBlock, dist, cruiseAlt, cruiseSpeed, xs, ts, angle, a, b };
}

export function flightStateAt(plan: FlightPlan, t: number): FlightState {
  const initialHeading = bearingDeg(plan.from, plan.to);
  if (t < plan.offBlock) {
    return { phase: "gate", position: plan.from, altitude: 0, speed: 0, heading: initialHeading, progress: 0, x: 0 };
  }
  if (t < plan.takeoff) {
    return { phase: "taxiOut", position: plan.from, altitude: 0, speed: 8, heading: initialHeading, progress: 0, x: 0 };
  }
  if (t >= plan.onBlock) {
    return { phase: "arrived", position: plan.to, altitude: 0, speed: 0, heading: bearingDeg(slerp(plan.a, plan.b, plan.angle, 0.999), plan.to), progress: 1, x: plan.dist };
  }
  if (t >= plan.landing) {
    return { phase: "taxiIn", position: plan.to, altitude: 0, speed: 8, heading: bearingDeg(slerp(plan.a, plan.b, plan.angle, 0.999), plan.to), progress: 1, x: plan.dist };
  }
  const tau = (t - plan.takeoff) / 1000;
  // Zeit → Strecke über die Stützstellen.
  const { xs, ts } = plan;
  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= tau) lo = mid;
    else hi = mid;
  }
  const span = ts[hi]! - ts[lo]!;
  const f = span > 0 ? Math.max(0, Math.min(1, (tau - ts[lo]!) / span)) : 0;
  const x = xs[lo]! + (xs[hi]! - xs[lo]!) * f;
  const frac = Math.max(0, Math.min(1, x / plan.dist));
  const position = slerp(plan.a, plan.b, plan.angle, frac);
  const altitude = altitudeAt(plan, x);
  const ahead = slerp(plan.a, plan.b, plan.angle, Math.min(1, frac + 0.002));
  const heading = frac < 0.998 ? bearingDeg(position, ahead) : bearingDeg(slerp(plan.a, plan.b, plan.angle, 0.995), plan.to);
  const speed = plan.cruiseSpeed * speedFactor(altitude, plan.cruiseAlt);
  const climbEnd = plan.cruiseAlt * CLIMB_RATIO;
  const descentStart = plan.dist - plan.cruiseAlt * DESCENT_RATIO;
  const phase: FlightPhase = x < Math.min(climbEnd, plan.dist / 2) ? "climb" : x > Math.max(descentStart, plan.dist / 2) ? "descent" : "cruise";
  return { phase, position, altitude, speed, heading, progress: frac, x };
}

/** Bodenspur des Fluges als Linie (für Kartenlinie und „geflogen"/„noch offen"). */
export function flightTrack(plan: FlightPlan, steps = 128): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = slerp(plan.a, plan.b, plan.angle, i / steps);
    const prev = out[out.length - 1];
    let x = p[0];
    if (prev) {
      while (x - prev[0] > 180) x -= 360;
      while (x - prev[0] < -180) x += 360;
    }
    out.push([x, p[1]]);
  }
  return out;
}
