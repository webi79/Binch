/**
 * Die 3D-Körper der Live-Ansicht — als Flächen, die MapLibre in die Höhe zieht
 * (`fill-extrusion`, wie die Häuser in 3D). Kein Modell-Format, nur senkrecht
 * hochgezogene Umrisse; Schrägen und Rundungen entstehen aus gestapelten
 * Teilen, deren Umriss sich mit der Höhe ändert.
 *
 * Vorbild sind die Low-Poly-Bilder des Nutzers (Okt. 2026), in den Farben der
 * App:
 *   Bahn: weißer Wagenkasten, ein Zierstreifen in der Farbe der Verkehrsart
 *   (Zug gelb, U-Bahn blau, Tram dunkel), dunkles Fensterband — nah dran mit
 *   einzelnen Fenstern zwischen weißen Stegen —, graues Dach mit Aufbau,
 *   dunkles Fahrwerk, Übergänge zwischen den Wagen. Die Nase steigt schräg an
 *   (jede höhere Schicht endet weiter hinten), die Frontscheibe ist dunkel;
 *   Fernzüge spitz an beiden Enden, Regional- und Stadtbahnen rund.
 *   Bus: Reisebus, oben weiß, unten in Lila, große Fenster mit Stegen,
 *   Frontscheibe, Außenspiegel, dunkle Räder, Klimabox auf dem Dach.
 *   Fähre: Rumpf mit spitzem Bug, weißer Aufbau mit Fensterband.
 *   Flugzeug: weißer Rumpf mit rundem Querschnitt und abgeschrägter Nase,
 *   dunkle Fensterreihe und Cockpitscheiben, Winglets und Seitenleitwerk im
 *   Akzent, graue Triebwerke mit dunklem Einlauf.
 *
 * Die Ebene zeichnet ohne senkrechten Verlauf
 * (`fill-extrusion-vertical-gradient: false`), sonst bekäme jedes Teil einen
 * eigenen dunklen Fuß und der Körper sähe gestreift aus.
 */
import { bearingAt, offsetM, pointAt } from "./geo";
import { isLongDistance } from "./motion";
import type { LiveVehicleKind, LngLat } from "./types";

/** Kopfform eines Bodenfahrzeugs. */
type Front = "sleek" | "round" | "box" | "bow";
type Build = "rail" | "bus" | "ferry";

export interface VehicleLook {
  /** Wagen bzw. Glieder. */
  units: number;
  unitLength: number;
  gap: number;
  width: number;
  height: number;
  /** Farbe der Verkehrsart: Zierstreifen (Bahn), Unterteil (Bus), Rumpf (Fähre). */
  accent: string;
  front: Front;
  build: Build;
}

const WHITE = "#F2F4F7";
const ROOF = "#D3D9E0";
const ROOF_BOX = "#AEB6C1";
const GLASS = "#1C2229";
const UNDER = "#2F343B";
const TYRE = "#1F2329";

export function lookFor(kind: LiveVehicleKind, product: string | null): VehicleLook {
  switch (kind) {
    case "bus":
      return { units: 1, unitLength: 12.5, gap: 0, width: 2.55, height: 3.4, accent: "#9D5FE0", front: "box", build: "bus" };
    case "tram":
      return { units: 3, unitLength: 10, gap: 0.5, width: 2.4, height: 3.4, accent: "#3A3F47", front: "round", build: "rail" };
    case "subway":
      return { units: 4, unitLength: 18, gap: 0.8, width: 2.65, height: 3.5, accent: "#4C7BF0", front: "round", build: "rail" };
    case "ferry":
      return { units: 1, unitLength: 60, gap: 0, width: 14, height: 9, accent: "#6B95B5", front: "bow", build: "ferry" };
    case "train":
    default:
      return isLongDistance(product)
        ? { units: 8, unitLength: 25, gap: 1.2, width: 2.95, height: 4.0, accent: "#FFD60A", front: "sleek", build: "rail" }
        : { units: 4, unitLength: 26, gap: 1.2, width: 2.95, height: 4.3, accent: "#FFD60A", front: "round", build: "rail" };
  }
}

/** Gesamtlänge (m) — für Kamera und „wie weit vom Halt". */
export const lookLength = (l: VehicleLook) => l.units * l.unitLength + (l.units - 1) * l.gap;

type Ring = LngLat[];
export interface ExtrusionFeature {
  type: "Feature";
  geometry: { type: "Polygon"; coordinates: Ring[] };
  properties: { b: number; h: number; c: string };
}

const poly = (ring: Ring, b: number, h: number, c: string): ExtrusionFeature => ({
  type: "Feature",
  geometry: { type: "Polygon", coordinates: [[...ring, ring[0]!]] },
  properties: { b, h, c },
});

/**
 * Ein Umriss zwischen `back` und `front` (Meter entlang der Linie): an jeder
 * Stützstelle x (m ab `back`) von `left(x)` bis `right(x)` quer zur Linie
 * (Meter, links negativ). Die Mittellinie folgt der Linie, deshalb biegt sich
 * der Wagen in Kurven.
 */
function alongRing(
  coords: LngLat[],
  cum: number[],
  back: number,
  front: number,
  left: (x: number) => number,
  right: (x: number) => number,
  samples: number[],
): Ring {
  const l: LngLat[] = [];
  const r: LngLat[] = [];
  const look = Math.max(4, (front - back) / 3);
  for (const x of samples) {
    const d = back + x;
    const c = pointAt(coords, cum, d);
    const brg = (bearingAt(coords, cum, d, look) * Math.PI) / 180;
    // Rechts von der Fahrtrichtung: (cos, -sin) der Richtung.
    const rx = Math.cos(brg);
    const ry = -Math.sin(brg);
    const a = left(x);
    const b = right(x);
    l.push(offsetM(c, rx * a, ry * a));
    r.push(offsetM(c, rx * b, ry * b));
  }
  return [...l, ...r.reverse()];
}

/**
 * Wie stark der Körper vergrößert wird — getrennt nach Richtung.
 *
 * Ein Zug ist 36-mal so lang wie breit. In echter Größe ist er auf Folge-Zoom
 * keine drei Punkte breit, schmaler als die Linie unter ihm, und sah in der
 * Probe-Darstellung (mbgl-render) von hinten aus wie ein gelber Strich. Die
 * Breite wird deshalb bis zu einer Mindestbreite im Bild verstärkt (wie ein
 * Kartensymbol), die Länge bleibt echt, solange sie reicht, und die Höhe geht
 * maßvoll mit (geometrisches Mittel) — sonst stünde ein Häuserblock auf dem
 * Gleis.
 */
export interface BodyScale {
  len: number;
  wid: number;
  hgt: number;
  /** Fuge zwischen den Wagen, Meter. */
  gap: number;
  /**
   * Groß genug im Bild für Einzelheiten (Fensterstege, Spiegel)? Weit draußen
   * wären sie Bruchteile eines Punkts — und jedes Teil kostet bei jedem der bis
   * zu 20 Durchgänge je Sekunde.
   */
  detail: boolean;
}

/** Elliptischer Übergang: 1 am Beginn der Rundung, `tip` an der Spitze. */
const ellipse = (u: number, tip: number) => tip + (1 - tip) * Math.sqrt(Math.max(0, 1 - u * u));

/**
 * Halbe Breite eines Wagens an der Stelle x (m ab hinten), mit Kopfform an
 * den Enden, die ein Ende des ganzen Fahrzeugs sind.
 */
function profile(front: Front, w: number, L: number, headEnd: boolean, tailEnd: boolean) {
  // Länge der Rundung je Kopfform (aus der verstärkten Breite, damit die Form
  // bei jeder Vergrößerung dieselbe bleibt).
  const noseLen =
    front === "sleek" ? Math.min(0.42 * L, 5.0 * w) :
    front === "round" ? Math.min(0.3 * L, 1.6 * w) :
    front === "bow" ? Math.min(0.32 * L, 2.6 * w) :
    Math.min(0.2 * L, 0.42 * w); // box: Eckradius
  const tip = front === "sleek" ? 0.2 : front === "round" ? 0.52 : front === "bow" ? 0.04 : 0;
  // Rückseite: Züge sind Wendezüge (gleiche Form hinten), die Fähre hat ein
  // stumpfes Heck, der Bus runde Ecken.
  const tailLen = front === "bow" ? Math.min(0.12 * L, 0.6 * w) : noseLen;
  const tailTip = front === "bow" ? 0.6 : tip;
  const box = (dist: number, r: number) => {
    // Viertelkreis-Ecke mit Radius r: am Ende (dist 0) auf w − r eingezogen.
    const k = Math.max(0, r - dist);
    return w - r + Math.sqrt(Math.max(0, r * r - k * k));
  };
  const hw = (x: number): number => {
    if (headEnd && x > L - noseLen) {
      const dist = L - x;
      return front === "box" ? box(dist, noseLen) : w * ellipse(1 - dist / noseLen, tip);
    }
    if (tailEnd && x < tailLen) {
      return front === "box" ? box(x, tailLen) : w * ellipse(1 - x / tailLen, tailTip);
    }
    return w;
  };
  // Stützstellen: dicht in den Rundungen, locker dazwischen (Biegung reicht).
  const xs = new Set<number>([0, L * 0.33, L * 0.66, L]);
  const dense = (from: number, to: number, n: number) => {
    for (let i = 0; i <= n; i++) xs.add(from + ((to - from) * i) / n);
  };
  if (headEnd) dense(L - noseLen, L, front === "box" ? 4 : 8);
  if (tailEnd) dense(0, tailLen, front === "box" ? 4 : 8);
  const samples = [...xs].filter((x) => x >= 0 && x <= L).sort((a, b) => a - b);
  return { hw, samples, noseLen, tailLen };
}

/** Ein Teil des Körpers: Höhe von–bis (Anteile von H), Länge von–bis (m ab hinten), Kanten quer. */
interface Part {
  from: number;
  to: number;
  x0: number;
  x1: number;
  left: (x: number) => number;
  right: (x: number) => number;
  color: string;
}

/** Symmetrisches Teil mit Breitenfaktor `f` des Profils. */
const sym = (hw: (x: number) => number, f: number) => ({
  left: (x: number) => -hw(x) * f,
  right: (x: number) => hw(x) * f,
});

/** Stege zwischen Fenstern: Positionen im geraden Teil, ~`pitch` Meter auseinander. */
function pillarSpans(a: number, b: number, pitch: number, width: number): Array<[number, number]> {
  const n = Math.floor((b - a) / pitch);
  if (n < 1) return [];
  const step = (b - a) / n;
  const out: Array<[number, number]> = [];
  for (let i = 1; i < n; i++) {
    const c = a + i * step;
    out.push([c - width / 2, c + width / 2]);
  }
  return out;
}

/** Bahn (Zug, U-Bahn, Tram): Teile eines Wagens. */
function railParts(look: VehicleLook, L: number, w: number, s: BodyScale, head: boolean, tail: boolean, prof: ReturnType<typeof profile>): Part[] {
  const { hw, noseLen } = prof;
  // Schräge Front: je höher, desto weiter zurück (Anteil der Nasenlänge).
  const slope = look.front === "sleek" ? 0.72 : 0.36;
  const recess = (hf: number) => noseLen * (0.03 + slope * hf ** 1.5);
  const span = (hf: number): [number, number] => [tail ? recess(hf) : 0, head ? L - recess(hf) : L];
  const layer = (from: number, to: number, f: number, color: string): Part => {
    const [x0, x1] = span((from + to) / 2);
    return { from, to, x0, x1, ...sym(hw, f), color };
  };
  const parts: Part[] = [
    layer(0, 0.13, 0.8, UNDER),
    layer(0.13, 0.36, 1, WHITE),
    layer(0.36, 0.42, 1, look.accent),
    layer(0.42, 0.72, 1, GLASS),
    layer(0.72, 0.9, 1, WHITE),
    layer(0.9, 1, 0.84, ROOF),
  ];
  // Dachaufbau (Stromabnehmer-Abdeckung, Klima) — auf jedem Wagen mittig.
  parts.push({ from: 1, to: 1.07, x0: 0.38 * L, x1: 0.62 * L, ...sym(hw, 0.5), color: ROOF_BOX });
  if (s.detail) {
    // Fensterstege: weiße, hauchdünn breitere Scheiben quer durch das Band.
    const a = tail ? noseLen * 1.05 : 0.04 * L;
    const b = head ? L - noseLen * 1.05 : 0.96 * L;
    for (const [x0, x1] of pillarSpans(a, b, 2.4 * s.len, 0.45 * s.len)) {
      parts.push({ from: 0.44, to: 0.7, x0, x1, ...sym(hw, 1.03), color: WHITE });
    }
  }
  return parts;
}

/** Reisebus: ein Glied. */
function busParts(look: VehicleLook, L: number, w: number, s: BodyScale, prof: ReturnType<typeof profile>): Part[] {
  const { hw } = prof;
  const fx = L - 0.4 * s.len; // hinter der Front: Scheibe und Stoßfänger
  const parts: Part[] = [];
  // Räder: dunkle Blöcke an den Achsen, eine Spur breiter als der Wagen.
  for (const axle of [0.2 * L, 0.8 * L]) {
    const half = 0.55 * s.len;
    const o = w + 0.05 * s.wid;
    parts.push({ from: 0, to: 0.3, x0: axle - half, x1: axle + half, left: () => -o, right: () => o, color: TYRE });
  }
  parts.push(
    { from: 0.08, to: 0.4, x0: 0, x1: fx, ...sym(hw, 1), color: look.accent },
    { from: 0.08, to: 0.26, x0: fx, x1: L, ...sym(hw, 1), color: look.accent },
    // Frontscheibe, tief heruntergezogen
    { from: 0.26, to: 0.84, x0: fx, x1: L, ...sym(hw, 1), color: GLASS },
    // Heckwand, darauf das Seitenfensterband
    { from: 0.4, to: 0.84, x0: 0, x1: 0.06 * L, ...sym(hw, 1), color: WHITE },
    { from: 0.4, to: 0.84, x0: 0.06 * L, x1: fx, ...sym(hw, 1), color: GLASS },
    { from: 0.84, to: 0.94, x0: 0, x1: L, ...sym(hw, 1), color: WHITE },
    { from: 0.94, to: 1, x0: 0, x1: L, ...sym(hw, 0.94), color: "#E9ECF0" },
    // Klimabox auf dem Dach
    { from: 1, to: 1.07, x0: 0.34 * L, x1: 0.66 * L, ...sym(hw, 0.6), color: "#C3CAD3" },
  );
  if (s.detail) {
    for (const [x0, x1] of pillarSpans(0.06 * L, fx, 1.7 * s.len, 0.22 * s.len)) {
      parts.push({ from: 0.42, to: 0.82, x0, x1, ...sym(hw, 1.03), color: WHITE });
    }
    // Außenspiegel vorn an beiden Seiten
    const m0 = fx - 0.3 * s.len;
    const out = w + 0.26 * s.wid;
    parts.push(
      { from: 0.56, to: 0.74, x0: m0, x1: fx, left: () => -out, right: () => -w, color: TYRE },
      { from: 0.56, to: 0.74, x0: m0, x1: fx, left: () => w, right: () => out, color: TYRE },
    );
  }
  return parts;
}

/** Fähre: Rumpf, darauf ein weißer Aufbau mit Fensterband. */
function ferryParts(look: VehicleLook, L: number, prof: ReturnType<typeof profile>): Part[] {
  const { hw } = prof;
  return [
    { from: 0, to: 0.12, x0: 0, x1: L, ...sym(hw, 0.96), color: "#4B6B85" },
    { from: 0.12, to: 0.45, x0: 0, x1: L, ...sym(hw, 1), color: look.accent },
    { from: 0.45, to: 0.66, x0: 0.12 * L, x1: 0.72 * L, ...sym(hw, 0.78), color: WHITE },
    { from: 0.66, to: 0.78, x0: 0.16 * L, x1: 0.7 * L, ...sym(hw, 0.76), color: GLASS },
    { from: 0.78, to: 1, x0: 0.2 * L, x1: 0.62 * L, ...sym(hw, 0.7), color: WHITE },
  ];
}

/**
 * Der Körper eines Bodenfahrzeugs, die Spitze bei `dHead` Metern entlang der
 * Linie.
 */
export function vehicleBody(
  coords: LngLat[],
  cum: number[],
  dHead: number,
  look: VehicleLook,
  scale: BodyScale,
): ExtrusionFeature[] {
  const out: ExtrusionFeature[] = [];
  const L = look.unitLength * scale.len;
  const gap = scale.gap;
  const w = (look.width * scale.wid) / 2;
  const H = look.height * scale.hgt;
  for (let k = 0; k < look.units; k++) {
    const front = dHead - k * (L + gap);
    const back = front - L;
    const head = k === 0;
    const tail = k === look.units - 1;
    const prof = profile(look.front, w, L, head, tail);
    const parts =
      look.build === "bus" ? busParts(look, L, w, scale, prof) :
      look.build === "ferry" ? ferryParts(look, L, prof) :
      railParts(look, L, w, scale, head, tail, prof);
    for (const p of parts) {
      if (p.x1 - p.x0 < 0.05) continue;
      const xs = [p.x0, ...prof.samples.filter((x) => x > p.x0 && x < p.x1), p.x1];
      const ring = alongRing(coords, cum, back, front, p.left, p.right, xs);
      out.push(poly(ring, p.from * H, p.to * H, p.color));
    }
    // Übergang zum nächsten Wagen: dunkler Faltenbalg über die Fuge.
    if (k < look.units - 1 && gap > 0) {
      const ring = alongRing(coords, cum, back - gap - 0.4, back + 0.4, () => -0.74 * w, () => 0.74 * w, [0, (gap + 0.8) / 2, gap + 0.8]);
      out.push(poly(ring, 0.1 * H, 0.86 * H, UNDER));
    }
  }
  return out;
}

// --- Flugzeug -------------------------------------------------------------
/**
 * Draufsicht in Metern (x nach rechts, y nach vorn), etwa A320: 37,6 m lang,
 * 35,8 m Spannweite. Halbe Umrisse der rechten Seite; links gespiegelt.
 */
type XY = Array<[number, number]>;
/** Rumpf: halbe Breite entlang y — Nase rund, Heck läuft zum Konus aus. */
const FUSELAGE_HALF: XY = [
  [0, 18.8], [0.62, 18.45], [1.05, 17.9], [1.45, 17.1], [1.74, 16.1], [1.92, 14.9], [1.98, 13.4],
  [1.98, -8.8], [1.9, -11], [1.66, -13.2], [1.3, -15.2], [0.86, -17], [0.42, -18.4], [0.18, -18.8],
];
const WING: XY = [[1.9, 4.2], [6.4, 1.6], [17.4, -4.7], [17.9, -5.5], [17.9, -6.9], [17.2, -7.3], [6.8, -4.6], [1.9, -3.6]];
const STABILIZER: XY = [[1.15, -13.7], [6.2, -17.1], [6.4, -17.8], [6.2, -18.5], [1.0, -17.7]];
/** Triebwerk unter dem Flügel: Gondel mit runder Lippe vorn; vorn der dunkle Einlauf. */
const ENGINE: XY = [[5.0, 2.2], [5.35, 2.6], [6.25, 2.6], [6.6, 2.2], [6.6, -1.4], [6.2, -2.1], [5.4, -2.1], [5.0, -1.4]];
const INTAKE: XY = [[5.0, 2.2], [5.35, 3.0], [6.25, 3.0], [6.6, 2.2]];
/**
 * Seitenleitwerk, gepfeilt. Eine senkrechte Fläche kann nicht schräg stehen —
 * die Pfeilung entsteht aus acht dünnen Stufen, je höher, desto weiter hinten
 * (bei vier sah man die Treppe).
 */
const FIN_STEPS: Array<{ y0: number; y1: number; from: number; to: number }> = Array.from({ length: 8 }, (_, i) => {
  const u = i / 8;
  return { y0: -11.4 - u * 5.0, y1: -18.5 - u * 0.45, from: 1.0 + u * 1.4, to: 1.0 + (u + 1 / 8) * 1.4 };
});

const mirrorX = (pts: XY): XY => pts.map(([x, y]) => [-x, y] as [number, number]).reverse();
/** Ganzer Umriss aus der rechten Hälfte (Nase oben, im Uhrzeigersinn). */
const fullOutline = (half: XY, widthFactor = 1): XY => [
  ...half.map(([x, y]) => [x * widthFactor, y] as [number, number]),
  // Ohne die Nasenspitze (x = 0, nur einmal), MIT dem Heckpunkt: der Konus
  // endet stumpf und braucht beide Ecken.
  ...half.slice(1).reverse().map(([x, y]) => [-x * widthFactor, y] as [number, number]),
];
/**
 * Der Rumpfumriss, vorn und hinten gestaucht — für die oberen Schichten
 * (Nase steigt schräg an) und die untere (Heck hebt sich zum Konus).
 */
const shaped = (noseKeep: number, tailKeep: number, widthFactor: number): XY =>
  fullOutline(
    FUSELAGE_HALF.map(([x, y]) => [x, y > 13 ? 13 + (y - 13) * noseKeep : y < -9 ? -9 + (y + 9) * tailKeep : y] as [number, number]),
    widthFactor,
  );
/** Nur ein Abschnitt des Rumpfs (y von–bis) — für Fensterreihe und Cockpit. */
function section(y0: number, y1: number, widthFactor: number): XY {
  const halfAt = (y: number) => {
    for (let i = 1; i < FUSELAGE_HALF.length; i++) {
      const [xa, ya] = FUSELAGE_HALF[i - 1]!;
      const [xb, yb] = FUSELAGE_HALF[i]!;
      if ((y <= ya && y >= yb) || (y >= ya && y <= yb)) {
        const f = ya === yb ? 0 : (y - ya) / (yb - ya);
        return xa + (xb - xa) * f;
      }
    }
    return 0;
  };
  const ys = [y1, ...FUSELAGE_HALF.map(([, y]) => y).filter((y) => y < y1 && y > y0), y0];
  const right = ys.map((y) => [halfAt(y) * widthFactor, y] as [number, number]);
  const left = [...ys].reverse().map((y) => [-halfAt(y) * widthFactor, y] as [number, number]);
  return [...right, ...left];
}

function placed(center: LngLat, headingDeg: number, scale: number, pts: XY): Ring {
  const a = (headingDeg * Math.PI) / 180;
  const s = Math.sin(a);
  const c = Math.cos(a);
  return pts.map(([x, y]) => {
    // Drehen: y zeigt in Flugrichtung (Grad im Uhrzeigersinn ab Norden).
    const east = (x * c + y * s) * scale;
    const north = (-x * s + y * c) * scale;
    return offsetM(center, east, north);
  });
}

export const PLANE_LENGTH_M = 37.6;

/** Das Flugzeug in der Luft — Unterkante des Rumpfs bei `altitude`. */
export function planeBody(
  center: LngLat,
  headingDeg: number,
  altitude: number,
  scale: number,
  colors: { fin: string },
): ExtrusionFeature[] {
  const t = 4.1 * scale; // Rumpfhöhe
  const at = (p: XY) => placed(center, headingDeg, scale, p);
  const z = (f: number) => altitude + f * t;
  const BODY = "#F4F6F8";
  const WING_C = "#E3E7EC";
  const out: ExtrusionFeature[] = [
    // Rumpf mit rundem Querschnitt: Bauch schmaler (Heck hebt sich), Mitte voll,
    // Rücken schmaler (Nase steigt an).
    poly(at(shaped(0.92, 0.7, 0.8)), z(0), z(0.28), "#D5DAE1"),
    poly(at(shaped(1, 1, 1)), z(0.28), z(0.5), BODY),
    // Fensterhöhe, lückenlos von vorn nach hinten: Nasenspitze, Cockpit-
    // scheiben, Türbereich, die Reihe der Kabinenfenster, Heck.
    poly(at(section(17.4, 18.8, 1)), z(0.5), z(0.66), BODY),
    poly(at(section(15.6, 17.4, 1.004)), z(0.5), z(0.66), GLASS),
    poly(at(section(13.2, 15.6, 1)), z(0.5), z(0.66), BODY),
    poly(at(section(-10, 13.2, 1)), z(0.5), z(0.53), BODY),
    poly(at(section(-10, 13.2, 1.004)), z(0.53), z(0.63), "#2B3037"),
    poly(at(section(-10, 13.2, 1)), z(0.63), z(0.66), BODY),
    poly(at(section(-18.8, -10, 1)), z(0.5), z(0.66), BODY),
    poly(at(shaped(0.86, 1, 1)), z(0.66), z(0.76), BODY),
    poly(at(shaped(0.72, 1, 0.74)), z(0.76), z(1), "#FFFFFF"),
    // Tiefdecker: Flügel unten am Rumpf, dünn und glatt bis zur Spitze.
    poly(at(WING), z(0.16), z(0.3), WING_C),
    poly(at(mirrorX(WING)), z(0.16), z(0.3), WING_C),
    // Triebwerke unter dem Flügel, vorn der dunkle Einlauf.
    poly(at(ENGINE), z(-0.12), z(0.2), "#9CA3AE"),
    poly(at(mirrorX(ENGINE)), z(-0.12), z(0.2), "#9CA3AE"),
    poly(at(INTAKE), z(-0.12), z(0.2), "#2B3037"),
    poly(at(mirrorX(INTAKE)), z(-0.12), z(0.2), "#2B3037"),
    poly(at(STABILIZER), z(0.62), z(0.72), WING_C),
    poly(at(mirrorX(STABILIZER)), z(0.62), z(0.72), WING_C),
  ];
  for (const s of FIN_STEPS) {
    const fin: XY = [[0.3, s.y0], [0.3, s.y1], [-0.3, s.y1], [-0.3, s.y0]];
    out.push(poly(at(fin), z(s.from), z(s.to), colors.fin));
  }
  return out;
}

/** Dieselbe Silhouette flach am Boden — der Schatten unter dem Flugzeug. */
export function planeShadow(center: LngLat, headingDeg: number, scale: number): Ring[] {
  return [fullOutline(FUSELAGE_HALF), WING, mirrorX(WING), STABILIZER, mirrorX(STABILIZER)]
    .map((p) => placed(center, headingDeg, scale, p))
    .map((r) => [...r, r[0]!]);
}
