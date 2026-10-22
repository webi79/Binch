/**
 * Wo ist das Fahrzeug JETZT? — aus dem Fahrplan gerechnet.
 *
 * Echte Positionsdaten haben wir nicht. Wir kennen aber die Linie, die Stelle
 * jedes Halts darauf und die Zeiten (Plan, mit Verspätung wo bekannt). Daraus
 * wird eine Bewegung, die sich wie ein Fahrzeug anfühlt:
 *
 *   • Zwischen zwei Halten ein TRAPEZ: anfahren, Reisetempo, bremsen. Das
 *     Tempo ist so gelöst, dass das Fahrzeug pünktlich ankommt.
 *   • Hat der Fahrplan viel Puffer, schleicht es nicht über die Strecke —
 *     es fährt sein übliches Tempo und steht dafür länger am Halt (so machen
 *     es Züge an Knotenbahnhöfen und Busse an Zeitpunkten).
 *   • An jedem Halt steht es mindestens kurz (`minDwell`), auch wenn Ankunft
 *     und Abfahrt in derselben Minute stehen (Fahrpläne zählen in Minuten).
 *   • Ist der Fahrplan physikalisch zu knapp, fährt es so schnell es kann und
 *     holt die Verspätung an den nächsten Halten wieder auf.
 */
import type { LiveTrip, LiveVehicleKind } from "./types";
import { isLongDistance } from "@/lib/theme/transitColors";

interface Params {
  /** Anfahr- und Bremsbeschleunigung, m/s². */
  accel: number;
  /** Übliches Reisetempo auf kurzen Stücken, m/s. */
  cruiseShort: number;
  /** … und auf langen (ab `longM`), m/s. */
  cruiseLong: number;
  longM: number;
  /** Höchsttempo, m/s. */
  vmax: number;
  /** Mindest-Haltezeit, s. */
  minDwell: number;
}

const kmh = (v: number) => v / 3.6;

// Fernverkehr erkennen — steht bei den Farben der Verkehrsmittel (eine Quelle).
export { isLongDistance };

export function paramsFor(kind: LiveVehicleKind, product: string | null): Params {
  switch (kind) {
    case "bus":
      return { accel: 1.0, cruiseShort: kmh(40), cruiseLong: kmh(85), longM: 6_000, vmax: kmh(100), minDwell: 20 };
    case "tram":
      return { accel: 1.0, cruiseShort: kmh(38), cruiseLong: kmh(60), longM: 3_000, vmax: kmh(70), minDwell: 20 };
    case "subway":
      return { accel: 1.0, cruiseShort: kmh(55), cruiseLong: kmh(75), longM: 3_000, vmax: kmh(90), minDwell: 25 };
    case "ferry":
      return { accel: 0.15, cruiseShort: kmh(20), cruiseLong: kmh(35), longM: 10_000, vmax: kmh(45), minDwell: 120 };
    case "train":
    default:
      return isLongDistance(product)
        ? { accel: 0.5, cruiseShort: kmh(160), cruiseLong: kmh(280), longM: 60_000, vmax: kmh(300), minDwell: 60 }
        : { accel: 0.7, cruiseShort: kmh(90), cruiseLong: kmh(150), longM: 15_000, vmax: kmh(160), minDwell: 30 };
  }
}

/** Ein Fahrt-Stück zwischen zwei Halten — Zeiten in ms, Wege in m, Tempo in m/s. */
interface Seg {
  from: number; // Halt-Index
  to: number;
  t0: number; // Abfahrt
  t1: number; // Ankunft (kann vor der Fahrplan-Ankunft liegen — dann längerer Halt)
  d0: number;
  d1: number;
  a: number; // Beschleunigung dieses Stücks
  v: number; // Reisetempo
  ta: number; // Dauer des Anfahrens (= des Bremsens), s
}

export interface MotionPlan {
  segs: Seg[];
  /** Je Halt die Zeiten, mit denen gerechnet wird (ms): wann das Fahrzeug steht und abfährt. */
  stops: Array<{ arr: number; dep: number; d: number }>;
  /** Abfahrt am ersten Halt und Ankunft am letzten (ms). */
  start: number;
  end: number;
  total: number;
}

export interface VehicleState {
  phase: "waiting" | "moving" | "dwelling" | "arrived";
  /** Meter entlang der Linie. */
  d: number;
  /** m/s */
  speed: number;
  /** Halt, an dem es steht — bzw. der zuletzt verlassene, solange es fährt. */
  stopIndex: number;
  /** Nächster Halt (beim Fahren das Ziel des Stücks, beim Stehen der danach). */
  nextIndex: number | null;
  /** Anteil der Strecke, 0…1. */
  progress: number;
}

const parse = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);

/** Fahrtdauer eines Stücks bei Reisetempo v (mit Anfahren und Bremsen), s. */
function runTime(L: number, a: number, v: number): number {
  return L >= (v * v) / a ? L / v + v / a : 2 * Math.sqrt(L / a);
}

export function buildMotionPlan(trip: LiveTrip): MotionPlan {
  const p = paramsFor(trip.vehicle, trip.product);
  const n = trip.stops.length;
  // 1) Zeiten je Halt: erwartet vor Plan; erster Halt ohne Ankunft, letzter ohne Abfahrt.
  const arr = trip.stops.map((s) => {
    const v = parse(s.arrE ?? s.arrP);
    return Number.isFinite(v) ? v : parse(s.depE ?? s.depP);
  });
  const dep = trip.stops.map((s, i) => {
    const v = parse(s.depE ?? s.depP);
    return Number.isFinite(v) ? v : arr[i]!;
  });
  // Lücken (Halt ganz ohne Zeit) nach der Strecke zwischen den Nachbarn füllen.
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(arr[i]!)) continue;
    let a = i - 1;
    while (a >= 0 && !Number.isFinite(dep[a]!)) a--;
    let b = i + 1;
    while (b < n && !Number.isFinite(arr[b]!)) b++;
    if (a < 0 || b >= n) continue;
    const span = trip.stops[b]!.d - trip.stops[a]!.d;
    const f = span > 0 ? (trip.stops[i]!.d - trip.stops[a]!.d) / span : 0;
    arr[i] = dep[i] = dep[a]! + (arr[b]! - dep[a]!) * f;
  }
  // Rückwärts in der Zeit gibt es nicht.
  for (let i = 0; i < n; i++) {
    if (i > 0) arr[i] = Math.max(arr[i]!, dep[i - 1]!);
    dep[i] = Math.max(dep[i]!, arr[i]!);
  }

  // 2) Die Stücke — Abfahrt wie geplant (bzw. so spät, wie das Fahrzeug da ist).
  const segs: Seg[] = [];
  const effArr = arr.slice();
  const effDep = dep.slice();
  for (let i = 0; i < n - 1; i++) {
    const t0 = effDep[i]!;
    const d0 = trip.stops[i]!.d;
    const d1 = trip.stops[i + 1]!.d;
    const L = Math.max(0, d1 - d0);
    const last = i + 1 === n - 1;
    // Ankunft so, dass vor der Abfahrt noch die Mindest-Haltezeit bleibt.
    const target = last ? arr[i + 1]! : Math.min(arr[i + 1]!, dep[i + 1]! - p.minDwell * 1000);
    const T = Math.max(0, (target - t0) / 1000);
    const cruise = p.cruiseShort + (p.cruiseLong - p.cruiseShort) * Math.min(1, L / p.longM);
    let a = p.accel;
    let v: number;
    let run: number;
    if (L < 1) {
      v = 0;
      run = 0;
    } else {
      const tFastest = runTime(L, a, p.vmax);
      if (T <= tFastest) {
        // Zu knapp: so schnell es geht (später an, holt an den Halten auf).
        v = Math.min(p.vmax, Math.sqrt(a * L));
        run = tFastest;
      } else {
        // PÜNKTLICH: Tempo so gelöst, dass es genau zur Ankunftszeit einfährt —
        // Puffer im Fahrplan wird gefahren, nicht am Halt gestanden. Vorher
        // fuhr es ab 80 % Puffer übliches Tempo und stand dann minutenlang
        // vorher am Bahnsteig („fährt schon zwei Minuten vorher ein"). Nicht
        // langsamer als 30 % des üblichen Tempos; erst was dann noch bleibt,
        // steht es ab.
        const goal = Math.min(T, runTime(L, a, 0.3 * cruise));
        const disc = a * a * goal * goal - 4 * a * L;
        v = disc >= 0 ? (a * goal - Math.sqrt(disc)) / 2 : (2 * L) / goal;
        if (disc < 0) a = (4 * L) / (goal * goal);
        run = goal;
      }
    }
    const t1 = t0 + run * 1000;
    const ta = L < 1 ? 0 : Math.min(v / a, run / 2);
    segs.push({ from: i, to: i + 1, t0, t1, d0, d1, a, v: L >= (v * v) / a ? v : a * ta, ta });
    // Ist es später da als geplant, verschiebt sich die Abfahrt (nicht vor Mindest-Halt).
    effArr[i + 1] = t1;
    if (!last) effDep[i + 1] = Math.max(dep[i + 1]!, t1 + p.minDwell * 1000);
    else effDep[i + 1] = t1;
  }
  const stops = trip.stops.map((s, i) => ({ arr: effArr[i]!, dep: effDep[i]!, d: s.d }));
  return {
    segs,
    stops,
    start: effDep[0]!,
    end: effArr[n - 1]!,
    total: trip.stops[n - 1]!.d,
  };
}

/** Weg und Tempo nach τ Sekunden auf einem Stück (Trapez bzw. Dreieck). */
function along(seg: Seg, tau: number): { s: number; v: number } {
  const T = (seg.t1 - seg.t0) / 1000;
  const L = seg.d1 - seg.d0;
  if (T <= 0 || L <= 0) return { s: L, v: 0 };
  const { a, ta } = seg;
  const v = seg.v;
  const tc = Math.max(0, T - 2 * ta);
  if (tau <= 0) return { s: 0, v: 0 };
  if (tau >= T) return { s: L, v: 0 };
  if (tau < ta) return { s: 0.5 * a * tau * tau, v: a * tau };
  if (tau < ta + tc) return { s: 0.5 * a * ta * ta + v * (tau - ta), v };
  const rest = T - tau;
  return { s: Math.max(0, L - 0.5 * a * rest * rest), v: a * rest };
}

export function vehicleStateAt(plan: MotionPlan, t: number): VehicleState {
  const { segs, stops, total } = plan;
  const prog = (d: number) => (total > 0 ? Math.max(0, Math.min(1, d / total)) : 0);
  if (stops.length === 0) return { phase: "arrived", d: 0, speed: 0, stopIndex: 0, nextIndex: null, progress: 1 };
  if (t < plan.start || segs.length === 0) {
    return { phase: "waiting", d: stops[0]!.d, speed: 0, stopIndex: 0, nextIndex: stops.length > 1 ? 1 : null, progress: prog(stops[0]!.d) };
  }
  const lastIdx = stops.length - 1;
  if (t >= plan.end) {
    return { phase: "arrived", d: stops[lastIdx]!.d, speed: 0, stopIndex: lastIdx, nextIndex: null, progress: 1 };
  }
  // Letztes Stück, das schon begonnen hat.
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const seg = segs[lo]!;
  if (t < seg.t1) {
    const { s, v } = along(seg, (t - seg.t0) / 1000);
    const d = seg.d0 + s;
    return { phase: "moving", d, speed: v, stopIndex: seg.from, nextIndex: seg.to, progress: prog(d) };
  }
  // Angekommen, steht bis zur Abfahrt.
  const at = seg.to;
  return {
    phase: at === lastIdx ? "arrived" : "dwelling",
    d: stops[at]!.d,
    speed: 0,
    stopIndex: at,
    nextIndex: at < lastIdx ? at + 1 : null,
    progress: prog(stops[at]!.d),
  };
}
