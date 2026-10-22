/**
 * Die 3D-Körper der Live-Ansicht — als Flächen, die MapLibre in die Höhe zieht
 * (`fill-extrusion`, wie die Häuser in 3D). Kein Modell-Format, nur senkrecht
 * hochgezogene Umrisse; Schrägen und Rundungen entstehen aus gestapelten
 * Teilen, deren Umriss sich mit der Höhe ändert.
 *
 * Vorbild sind die Low-Poly-Bilder des Nutzers (Okt. 2026), in den Farben der
 * App — bewusst mit WENIGEN, großen Teilen:
 *   Bahn: je Wagen sechs Schichten — dunkles Fahrwerk, weißer Kasten, ein
 *   Zierstreifen in der Farbe der Verkehrsart (Zug gelb, U-Bahn blau, Tram
 *   dunkel), hohes dunkles Fensterband, weißer Kasten, schmaleres graues Dach;
 *   Übergänge zwischen den Wagen. Die Nase steigt schräg an (jede höhere Schicht endet
 *   weiter hinten); Fernzüge spitz an beiden Enden, Regional- und Stadtbahnen
 *   rund.
 *   Bus: Räder, unten in Lila, Heckwand, ein Fensterband bis vorn, weißer
 *   Abschluss, graues Dach.
 *   Fähre: Rumpf mit spitzem Bug, weißer Aufbau mit Fensterband.
 *   Flugzeug: kein Körper hier — es ist ein vorgerendertes 3D-Modell
 *   (`server/scripts/build-plane-sprites.mjs`, siehe `planePoint` in
 *   features.ts); hier nur sein Schatten am Boden.
 *
 * KEINE KLEINTEILE (Fensterstege, Spiegel, Dachaufbauten, Winglets, Stufen):
 * Sie kamen erst nah dran dazu und lagen hauchdünn über dem Fensterband — die
 * fast deckungsgleichen Flächen flackerten gegeneinander („beim Reinzoomen
 * glitcht alles"), und jedes Teil kostete bei jedem Takt. Teile liegen nur
 * übereinander oder nebeneinander, nie ineinander.
 *
 * Die Ebene zeichnet ohne senkrechten Verlauf
 * (`fill-extrusion-vertical-gradient: false`), sonst bekäme jedes Teil einen
 * eigenen dunklen Fuß und der Körper sähe gestreift aus.
 */
import { bearingAt, offsetM, pointAt } from "./geo";
import { isLongDistance, TRANSIT_COLOR } from "@/lib/theme/transitColors";
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
/** Dach: schmaler und grau — so liest man den Kasten als gerundet, nicht als weiße Platte. */
const ROOF = "#C5CCD4";
const GLASS = "#1C2229";
const UNDER = "#2F343B";
const TYRE = "#1F2329";

export function lookFor(kind: LiveVehicleKind, product: string | null): VehicleLook {
  switch (kind) {
    case "bus":
      return { units: 1, unitLength: 12.5, gap: 0, width: 2.55, height: 3.4, accent: TRANSIT_COLOR.bus, front: "box", build: "bus" };
    case "tram":
      return { units: 3, unitLength: 10, gap: 0.5, width: 2.4, height: 3.4, accent: TRANSIT_COLOR.tram, front: "round", build: "rail" };
    case "subway":
      return { units: 4, unitLength: 18, gap: 0.8, width: 2.65, height: 3.5, accent: TRANSIT_COLOR.subway, front: "round", build: "rail" };
    case "ferry":
      return { units: 1, unitLength: 60, gap: 0, width: 14, height: 9, accent: TRANSIT_COLOR.ferry, front: "bow", build: "ferry" };
    case "train":
    default:
      return isLongDistance(product)
        ? { units: 8, unitLength: 25, gap: 1.2, width: 2.95, height: 4.0, accent: TRANSIT_COLOR.longDistance, front: "sleek", build: "rail" }
        : { units: 4, unitLength: 26, gap: 1.2, width: 2.95, height: 4.3, accent: TRANSIT_COLOR.regional, front: "round", build: "rail" };
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
  // Genug für eine runde Nase im Bild, nicht mehr — jede Stützstelle sind
  // vier Ecken je Schicht und Takt.
  const n = front === "box" ? 3 : front === "round" ? 5 : 6;
  if (headEnd) dense(L - noseLen, L, n);
  if (tailEnd) dense(0, tailLen, n);
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

/** Bahn (Zug, U-Bahn, Tram): sechs Schichten eines Wagens. */
function railParts(look: VehicleLook, L: number, head: boolean, tail: boolean, prof: ReturnType<typeof profile>): Part[] {
  const { hw, noseLen } = prof;
  // Schräge Front: je höher, desto weiter zurück (Anteil der Nasenlänge).
  const slope = look.front === "sleek" ? 0.72 : 0.36;
  const recess = (hf: number) => noseLen * (0.03 + slope * hf ** 1.5);
  const span = (hf: number): [number, number] => [tail ? recess(hf) : 0, head ? L - recess(hf) : L];
  const layer = (from: number, to: number, f: number, color: string): Part => {
    const [x0, x1] = span((from + to) / 2);
    return { from, to, x0, x1, ...sym(hw, f), color };
  };
  // Das Fensterband hoch genug, dass es auch schräg von oben (Folge-Kamera,
  // 58°) als Band zu sehen ist.
  return [
    layer(0, 0.12, 0.8, UNDER),
    layer(0.12, 0.34, 1, WHITE),
    layer(0.34, 0.4, 1, look.accent),
    layer(0.4, 0.76, 1, GLASS),
    layer(0.76, 0.9, 1, WHITE),
    layer(0.9, 1, 0.84, ROOF),
  ];
}

/** Reisebus: ein Glied, sechs Teile. */
function busParts(look: VehicleLook, L: number, w: number, s: BodyScale, prof: ReturnType<typeof profile>): Part[] {
  const { hw } = prof;
  const parts: Part[] = [];
  // Räder: dunkle Blöcke an den Achsen, eine Spur breiter als der Wagen.
  for (const axle of [0.2 * L, 0.8 * L]) {
    const half = 0.55 * s.len;
    const o = w + 0.05 * s.wid;
    parts.push({ from: 0, to: 0.3, x0: axle - half, x1: axle + half, left: () => -o, right: () => o, color: TYRE });
  }
  parts.push(
    { from: 0.08, to: 0.4, x0: 0, x1: L, ...sym(hw, 1), color: look.accent },
    // Heckwand, davor ein Fensterband bis in die Frontscheibe
    { from: 0.4, to: 0.84, x0: 0, x1: 0.06 * L, ...sym(hw, 1), color: WHITE },
    { from: 0.4, to: 0.84, x0: 0.06 * L, x1: L, ...sym(hw, 1), color: GLASS },
    { from: 0.84, to: 0.93, x0: 0, x1: L, ...sym(hw, 1), color: WHITE },
    { from: 0.93, to: 1, x0: 0, x1: L, ...sym(hw, 0.9), color: ROOF },
  );
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
      railParts(look, L, head, tail, prof);
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
const mirrorX = (pts: XY): XY => pts.map(([x, y]) => [-x, y] as [number, number]).reverse();
/** Ganzer Umriss aus der rechten Hälfte (Nase oben, im Uhrzeigersinn). */
const fullOutline = (half: XY, widthFactor = 1): XY => [
  ...half.map(([x, y]) => [x * widthFactor, y] as [number, number]),
  // Ohne die Nasenspitze (x = 0, nur einmal), MIT dem Heckpunkt: der Konus
  // endet stumpf und braucht beide Ecken.
  ...half.slice(1).reverse().map(([x, y]) => [-x * widthFactor, y] as [number, number]),
];
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

/** Dieselbe Silhouette flach am Boden — der Schatten unter dem Flugzeug. */
export function planeShadow(center: LngLat, headingDeg: number, scale: number): Ring[] {
  return [fullOutline(FUSELAGE_HALF), WING, mirrorX(WING), STABILIZER, mirrorX(STABILIZER)]
    .map((p) => placed(center, headingDeg, scale, p))
    .map((r) => [...r, r[0]!]);
}
