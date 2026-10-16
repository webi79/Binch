/**
 * Strecke einer Fahrt für die Live-Ansicht — gemessen und mit den Halten darauf.
 *
 * Die App rechnet die Position eines Fahrzeugs selbst aus (lib/live/): Sie
 * braucht dafür die Linienführung als Punktfolge, ihre Länge bis zu jedem Punkt
 * und für jeden Halt die Stelle auf dieser Linie. Das hier liefert genau das —
 * einmal pro Fahrt, danach fragt die App nichts mehr nach.
 *
 * Ohne Linienführung (Länder-Fahrpläne haben keine `shapes`) bleibt die Folge
 * der Halte selbst: gerade Stücke von Halt zu Halt.
 */

export type LngLat = [number, number];

const R = 6_371_000;
const RAD = Math.PI / 180;

/** Abstand in Metern — für die kurzen Stücke einer Linie genau genug (äquirektangular). */
export function stepMeters(a: LngLat, b: LngLat): number {
  const lat = ((a[1] + b[1]) / 2) * RAD;
  const dx = (b[0] - a[0]) * RAD * Math.cos(lat);
  const dy = (b[1] - a[1]) * RAD;
  return R * Math.hypot(dx, dy);
}

/** Länge der Linie bis zu jedem Punkt, in Metern (erster Wert 0). */
export function measure(coords: LngLat[]): number[] {
  const out = new Array<number>(coords.length);
  let d = 0;
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    d += stepMeters(coords[i - 1]!, coords[i]!);
    out[i] = d;
  }
  return out;
}

/**
 * Lotfußpunkt von `p` auf das Stück a→b: Anteil t ∈ [0, 1] und Abstand in
 * Metern. Lokal flach gerechnet (die Stücke sind kurz).
 */
function projectOnSegment(p: LngLat, a: LngLat, b: LngLat): { t: number; dist: number } {
  const cos = Math.cos(((a[1] + b[1]) / 2) * RAD);
  const ax = a[0] * cos, ay = a[1];
  const bx = b[0] * cos, by = b[1];
  const px = p[0] * cos, py = p[1];
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  const q: LngLat = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { t, dist: stepMeters(p, q) };
}

/**
 * Stelle jedes Halts auf der Linie, in Metern ab ihrem Anfang.
 *
 * Nicht einfach „der nächste Punkt der Linie": Eine Ringlinie kommt an ihrem
 * Start-/Endhalt zweimal vorbei, eine Stichstrecke mit Wendeschleife fährt auf
 * dem Hinweg an Halten vorbei, die sie erst auf dem Rückweg bedient (Gegen-
 * fahrbahn, 20 m daneben). Deshalb wie beim Kartenabgleich in der Navigation:
 *   1. Je Halt alle VORBEIFAHRTEN der Linie als Kandidaten (je Annäherung der
 *      nächste Punkt, bis `PASS_M` neben der besten).
 *   2. Die Folge, die VORWÄRTS läuft (jeder Halt nicht vor dem vorigen) und in
 *      Summe am nächsten an den Halten liegt — dynamische Programmierung über
 *      wenige Kandidaten je Halt.
 */
const PASS_M = 150;

export function snapStops(coords: LngLat[], cum: number[], stops: LngLat[]): number[] {
  if (coords.length < 2) return stops.map(() => 0);
  // 1) Kandidaten je Halt
  const cands: Array<Array<{ d: number; dist: number }>> = stops.map((p) => {
    const proj: Array<{ d: number; dist: number }> = [];
    let best = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
      const r = projectOnSegment(p, coords[i]!, coords[i + 1]!);
      proj.push({ d: cum[i]! + (cum[i + 1]! - cum[i]!) * r.t, dist: r.dist });
      if (r.dist < best) best = r.dist;
    }
    const limit = best + PASS_M;
    // Je zusammenhängender Annäherung (Stücke unter der Grenze) der beste Punkt.
    const out: Array<{ d: number; dist: number }> = [];
    let run: { d: number; dist: number } | null = null;
    for (const c of proj) {
      if (c.dist <= limit) {
        if (!run || c.dist < run.dist) run = c;
      } else if (run) {
        out.push(run);
        run = null;
      }
    }
    if (run) out.push(run);
    return out;
  });
  // 2) Vorwärts laufende Folge mit der kleinsten Summe der Abstände
  const cost: number[][] = [];
  const from: number[][] = [];
  for (let s = 0; s < stops.length; s++) {
    cost.push([]);
    from.push([]);
    for (let c = 0; c < cands[s]!.length; c++) {
      const cand = cands[s]![c]!;
      if (s === 0) {
        cost[s]!.push(cand.dist);
        from[s]!.push(-1);
        continue;
      }
      let bestCost = Infinity;
      let bestPrev = -1;
      for (let p = 0; p < cands[s - 1]!.length; p++) {
        const prevD = cands[s - 1]![p]!.d;
        // Rückwärts nur mit Strafe (Kandidat liegt vor dem vorigen Halt) —
        // dann wird er unten auf dessen Stelle geklemmt.
        const back = prevD > cand.d + 1 ? 10_000 + (prevD - cand.d) : 0;
        const c2 = cost[s - 1]![p]! + cand.dist + back;
        if (c2 < bestCost) {
          bestCost = c2;
          bestPrev = p;
        }
      }
      cost[s]!.push(bestCost);
      from[s]!.push(bestPrev);
    }
  }
  // Zurückverfolgen
  const last = stops.length - 1;
  let c = cost[last]!.indexOf(Math.min(...cost[last]!));
  const pick: number[] = new Array(stops.length);
  for (let s = last; s >= 0; s--) {
    pick[s] = cands[s]![c]!.d;
    c = from[s]![c]!;
  }
  // Monoton machen (Klemmen) — und den letzten Halt nie vor dem vorletzten.
  for (let s = 1; s < pick.length; s++) pick[s] = Math.max(pick[s]!, pick[s - 1]!);
  return pick;
}

/**
 * Weniger Punkte, gleiche Form (Douglas-Peucker, Toleranz in Metern). Eine
 * ICE-Fahrt München–Hamburg kommt von MOTIS mit zigtausend Punkten; auf der
 * Karte sieht man den Unterschied zu 3 m Toleranz nicht, in der Leitung schon.
 */
export function simplify(coords: LngLat[], toleranceM: number): LngLat[] {
  if (coords.length <= 2) return coords.slice();
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    let worst = -1;
    let worstD = 0;
    for (let k = i + 1; k < j; k++) {
      const d = projectOnSegment(coords[k]!, coords[i]!, coords[j]!).dist;
      if (d > worstD) {
        worstD = d;
        worst = k;
      }
    }
    if (worst >= 0 && worstD > toleranceM) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Die fertige Strecke: vereinfachte Linie mit Längen und die Stelle jedes
 * Halts. Ist die Linienführung offensichtlich nicht die dieser Fahrt (ein Halt
 * liegt mehr als `maxOffM` neben ihr), nimmt sie die geraden Stücke von Halt zu
 * Halt — lieber eckig als ein Fahrzeug, das neben seinen Halten fährt.
 */
export function buildLiveShape(
  geometry: LngLat[] | null,
  stops: LngLat[],
  opts: { toleranceM?: number; maxOffM?: number } = {},
): { coords: LngLat[]; cum: number[]; stopD: number[]; source: "geometry" | "straight" } {
  const tolerance = opts.toleranceM ?? 3;
  const maxOff = opts.maxOffM ?? 600;
  if (geometry && geometry.length >= 2 && stops.length >= 2) {
    const coords = simplify(geometry, tolerance).map(([x, y]) => [round6(x), round6(y)] as LngLat);
    const cum = measure(coords);
    const stopD = snapStops(coords, cum, stops);
    // Gegenprobe: Liegt jeder Halt wirklich an der Linie?
    const fits = stops.every((p, s) => {
      const d = stopD[s]!;
      const at = pointAt(coords, cum, d);
      return stepMeters(p, at) <= maxOff;
    });
    if (fits) return { coords, cum: cum.map((v) => Math.round(v * 10) / 10), stopD: stopD.map((v) => Math.round(v * 10) / 10), source: "geometry" };
  }
  const coords = stops.map(([x, y]) => [round6(x), round6(y)] as LngLat);
  const cum = measure(coords);
  return {
    coords,
    cum: cum.map((v) => Math.round(v * 10) / 10),
    stopD: cum.map((v) => Math.round(v * 10) / 10),
    source: "straight",
  };
}

/** Punkt bei `d` Metern entlang der Linie. */
export function pointAt(coords: LngLat[], cum: number[], d: number): LngLat {
  if (d <= 0) return coords[0]!;
  const total = cum[cum.length - 1]!;
  if (d >= total) return coords[coords.length - 1]!;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi]! - cum[lo]!;
  const t = span > 0 ? (d - cum[lo]!) / span : 0;
  const a = coords[lo]!;
  const b = coords[hi]!;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
