/**
 * Die Daten der Live-Ebene auf der Karte (`components/live/LiveVehicleLayer`)
 * — als reine Rechnung herausgelöst, damit sie sich ohne Gerät prüfen lässt.
 */
import { metersPerPixel, sliceLine } from "./geo";
import { isLongDistance } from "./motion";
import { LIVE_MODEL_SPECS, type LiveModelSet } from "./liveModelSpecs";
import type { LiveFrame, LiveModel } from "./model";
import {
  lookFor,
  PLANE_LENGTH_M,
  planeShadow,
  vehicleBody,
  type BodyScale,
  type ExtrusionFeature,
} from "./shapes";
import type { LngLat } from "./types";

/** So lang (in Punkten) steht ein Bodenfahrzeug mindestens im Bild … */
export const MIN_LEN_PX = 44;
/** … aber höchstens dreifach vergrößert — darunter übernimmt der Punkt. */
export const MAX_SCALE = 3;
/** Ein Flugzeug mindestens so lang (Punkte) — es ist ein Zeichen, kein Maßstab. */
export const PLANE_MIN_PX = 56;
/** Ab diesem Zoom das Flugzeug in 3D; darunter das Symbol (Welt-Überblick, Globus). */
export const PLANE_3D_ZOOM = 6;
/** Wo 3D beginnt: Dort ist das Fahrzeug, höchstens dreifach vergrößert, `MIN_LEN_PX` lang. */
export function threeDZoom(model: LiveModel): number {
  if (model.kind === "plane") return PLANE_3D_ZOOM;
  const lat = model.stops[0]?.lat ?? 50;
  const set = modelSetFor(model);
  if (set && set !== "plane") return modelRefZoom(set, lat) - Math.log2(MAX_SCALE);
  const mppNeeded = (model.length * MAX_SCALE) / MIN_LEN_PX;
  return Math.log2(metersPerPixel(0, lat) / mppNeeded);
}

/**
 * DIE 3D-MODELLE (`modules/live-models`): Bahn, Bus und Flugzeug zeichnet eine
 * eigene Ebene IN der Karte — echte Netze, fest in der Welt nach Fahrtrichtung
 * ausgerichtet; Wagenkette, Größe zum Zoom und Bewegung zwischen zwei Takten
 * rechnet sie in jedem Bild selbst. Hier steht nur ihre Belegung. Die Fähre
 * bleibt ein hochgezogener Körper (`vehicleBody`).
 */
export function modelSetFor(model: LiveModel): LiveModelSet | null {
  switch (model.kind) {
    case "plane":
      return "plane";
    case "bus":
      return "bus";
    case "tram":
      return "rail-tram";
    case "subway":
      return "rail-subway";
    case "train":
      return isLongDistance(model.product) ? "rail-ice" : "rail-regional";
    default:
      return null;
  }
}
type GroundSet = Exclude<LiveModelSet, "plane">;
/** So lang (Punkte) steht ein Wagen mindestens im Bild — darunter wird vergrößert. */
const MIN_UNIT_DP: Record<GroundSet, number> = {
  "rail-ice": 30,
  "rail-regional": 30,
  "rail-subway": 28,
  "rail-tram": 22,
  bus: 40,
};
/** Zwischen zwei Wagen (m) — die Fugen der Netze reichen je 0,25 m darüber, sie überlappen. */
export const COUPLING_M = 0.3;
/** Ab hier echte Größe, darunter gleich groß im Bild (vergrößert) — wie in der Ebene. */
export function modelRefZoom(set: GroundSet, lat: number): number {
  return Math.log2((MIN_UNIT_DP[set] * metersPerPixel(0, lat)) / LIVE_MODEL_SPECS[set].length);
}
/** Vergrößerung beim Zoom (höchstens vierfach; ab dreifach übernimmt der 2D-Punkt). */
export function modelScale(set: GroundSet, zoom: number, lat: number): number {
  return Math.min(4, Math.max(1, 2 ** (modelRefZoom(set, lat) - zoom)));
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
type Part = {
  a0?: number; H?: number; zBot?: number; half?: number; bodyEnd?: number;
  noseLen?: number; nose?: number; window?: number; doors?: readonly number[];
};
/** 12 Maße eines Teils für den Shader: a0, H, zBot, half, bodyEnd, noseLen, nose, window, Türen ×3, Türzahl. */
function partParams(q: Part | undefined): number[] {
  if (!q) return new Array(12).fill(0);
  const d = q.doors ?? [];
  return [q.a0 ?? 0, q.H ?? 0, q.zBot ?? 0, q.half ?? 0, q.bodyEnd ?? 0, q.noseLen ?? 0, q.nose ?? 0, q.window ?? 1, d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d.length];
}

/**
 * Belegung für `LiveModels.setVehicle` (Reihenfolge wie `setVehicle` in
 * live_models_core.cpp): Wagen, Wagenlänge, Kupplung, Mindestlänge Wagen,
 * Mindestlänge Flugzeug, 3D-ab-Zoom, Überblendung, Akzent, Kopf- und
 * Mittelteil. Null bei der Fähre.
 */
export function liveModelConfig(model: LiveModel, finColor: string): {
  kind: number;
  head: string;
  mid: string;
  params: number[];
} | null {
  const set = modelSetFor(model);
  if (!set) return null;
  const z3d = threeDZoom(model);
  if (set === "plane") {
    return {
      kind: 2,
      head: "plane",
      mid: "",
      params: [1, PLANE_LENGTH_M, 0, 0, PLANE_MIN_PX, z3d, 0.6, ...rgb(finColor), ...partParams(undefined), ...partParams(undefined)],
    };
  }
  const spec = LIVE_MODEL_SPECS[set];
  const look = lookFor(model.kind as Exclude<typeof model.kind, "plane">, model.product);
  const accent = set === "bus" ? "#9D5FE0" : (spec.head as { stripe?: string }).stripe ?? "#FFD60A";
  const mid = "mid" in spec ? (spec.mid as Part) : undefined;
  return {
    kind: set === "bus" ? 1 : 0,
    head: set === "bus" ? "bus" : `${set}-head`,
    mid: mid ? `${set}-mid` : "",
    params: [look.units, spec.length, COUPLING_M, MIN_UNIT_DP[set], PLANE_MIN_PX, z3d, 0.6, ...rgb(accent), ...partParams(spec.head as Part), ...partParams(mid)],
  };
}

/** Bodenfahrzeuge mindestens so breit (Punkte) — siehe `BodyScale`. */
export const MIN_WIDTH_PX = 11;
/** Halbmesser (Punkte) des Punkts der 2D-Gestalt — `dotPaint` in LiveVehicleLayer. */
export const DOT_RADIUS_PX = 15;

/** Vergrößerung des Körpers in der Länge beim aktuellen Zoom. */
export function bodyScale(model: LiveModel, zoom: number, lat: number): number {
  const mpp = metersPerPixel(zoom, lat);
  if (model.kind === "plane") return Math.max(1, (PLANE_MIN_PX * mpp) / PLANE_LENGTH_M);
  return Math.max(1, Math.min(MAX_SCALE, (MIN_LEN_PX * mpp) / model.length));
}

/** Länge, Breite, Höhe und Fuge eines Bodenfahrzeugs beim aktuellen Zoom. */
export function groundScale(model: LiveModel, zoom: number, lat: number): BodyScale {
  const mpp = metersPerPixel(zoom, lat);
  const look = lookFor(model.kind as Exclude<typeof model.kind, "plane">, model.product);
  const len = bodyScale(model, zoom, lat);
  const wid = Math.max(len, (MIN_WIDTH_PX * mpp) / look.width);
  // Fugen mindestens anderthalb Punkte — sonst verschwimmen die Wagen zu einem.
  return {
    len,
    wid,
    hgt: Math.max(len, Math.sqrt(wid * len)),
    gap: Math.max(look.gap * len, look.units > 1 ? 1.5 * mpp : 0),
    // Einzelheiten (Fensterstege, Spiegel) erst, wenn ein Wagen ~60 Punkte lang im Bild ist.
    detail: (look.unitLength * len) / mpp >= 60,
  };
}

/**
 * Wie weit (m) das Fahrzeug die Strecke um seine Mitte verdeckt — nah die
 * halbe Länge dessen, was gezeichnet wird (Zug samt Vergrößerung, Bus,
 * Flugzeug mit seinem Schatten darunter), weit der Punkt.
 *
 * So weit darf das Ende des Gefahrenen von der Mitte abweichen, ohne dass man
 * es sieht (`LiveVehicleLayer`): Es endet UNTER dem Fahrzeug, und solange es
 * dort bleibt, muss es nicht jedem Bild folgen.
 */
export function hiddenHalfM(model: LiveModel, zoom: number, lat: number, z3d: number): number {
  const mpp = metersPerPixel(zoom, lat);
  if (zoom < z3d) return DOT_RADIUS_PX * mpp;
  if (model.kind === "plane") return (PLANE_LENGTH_M * bodyScale(model, zoom, lat)) / 2;
  const look = lookFor(model.kind, model.product);
  const set = modelSetFor(model);
  if (set && set !== "plane") {
    const k = modelScale(set, zoom, lat);
    return (look.units * LIVE_MODEL_SPECS[set].length * k + (look.units - 1) * COUPLING_M * k) / 2;
  }
  const gs = groundScale(model, zoom, lat);
  return (look.units * look.unitLength * gs.len + (look.units - 1) * gs.gap) / 2;
}

/** Auf 6 Nachkommastellen (~10 cm) — kürzerer Text für die Brücke. */
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const r2 = (v: number) => Math.round(v * 100) / 100;
export function compact(json: unknown): string {
  return JSON.stringify(json, (_k, v) => (typeof v === "number" ? r6(v) : v));
}

/**
 * Wie `compact`, aber für den Takt (bis 30-mal je Sekunde): Gerundet wird an
 * Ort und Stelle in den FRISCH gebauten Ringen (`offsetM` liefert je Punkt ein
 * neues Feld), danach läuft `JSON.stringify` ohne Ersetzer — der rief in
 * Hermes für jede Zahl zurück in JS. Fremde Felder (Halte-Koordinaten der
 * Strecke, die Lage des Rahmens) werden kopiert, nie verändert.
 */
/**
 * Auf 7 Nachkommastellen (~1 cm): Mit 6 (~10 cm) sprang nah dran jede Ecke für
 * sich in Zehn-Zentimeter-Stufen, während das Fahrzeug fuhr — auf Zoom 19 gut
 * ein Bildpunkt, die Kanten zitterten.
 */
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
function roundRingsInPlace(rings: LngLat[][]): void {
  for (const ring of rings) {
    for (const p of ring) {
      p[0] = r7(p[0]);
      p[1] = r7(p[1]);
    }
  }
}
const roundedCopy = (p: LngLat): LngLat => [r7(p[0]), r7(p[1])];

const EMPTY_COLLECTION = JSON.stringify({ type: "FeatureCollection", features: [] });
/**
 * Ein Stück der Strecke (Meter von, bis) als GeoJSON-Text — für das
 * eingefrorene Gefahrene. Gerundet auf frischen Kopien, ohne Ersetzer (siehe
 * `roundRingsInPlace`): Das Stück reicht bis über die ganze Strecke.
 */
export function lineFeature(model: LiveModel, from: number, to: number): string {
  const pts = to > from ? sliceLine(model.coords, model.cum, Math.max(0, from), to) : [];
  if (pts.length < 2) return EMPTY_COLLECTION;
  return JSON.stringify({ type: "Feature", geometry: { type: "LineString", coordinates: pts.map(roundedCopy) }, properties: {} });
}

/**
 * Die Fahrzeug-Quellen für einen Zeitpunkt: das letzte, noch nicht
 * eingefrorene Stück des Gefahrenen (`done`: von, bis — es endet unter der
 * Mitte des Fahrzeugs), der Körper der Fähre (Bahn, Bus und Flugzeug zeichnet
 * die 3D-Ebene samt Schatten), der Schatten des Flugzeugs nur noch ohne diese
 * Ebene (`planeShadow`), und GETRENNT davon der Punkt der 2D-Gestalt.
 *
 * Getrennt, weil der Punkt Symbol-Ebenen trägt: Jede neue Symbol-Quelle lässt
 * die Karte ALLE Beschriftungen neu platzieren (Kollision über den ganzen
 * Schirm) — bei jedem Takt, solange das Fahrzeug fuhr („laggt tierisch, wenn
 * sich die Objekte bewegen"). Geschickt wird nur, was zu sehen ist
 * (`LiveVehicleLayer`).
 *
 * Und der Körper GEBÜNDELT: alle Teile gleicher Farbe, Unter- und Oberkante
 * als EIN Merkmal (MultiPolygon) — ein ICE sind so rund zehn statt 65
 * Merkmale, bei gleichem Aussehen.
 */
export function vehicleCollection(
  model: LiveModel,
  frame: LiveFrame,
  zoom: number,
  done: { from: number; to: number },
  planeShadowInJs: boolean,
): { json: string; ptJson: string } {
  const lat = frame.position[1];
  const parts: ExtrusionFeature[] = [];
  const out: object[] = [];
  if (model.kind === "plane") {
    if (planeShadowInJs) {
      const shadow = planeShadow(frame.position, frame.heading, bodyScale(model, zoom, lat));
      roundRingsInPlace(shadow);
      out.push({ type: "Feature", geometry: { type: "MultiPolygon", coordinates: shadow.map((r) => [r]) }, properties: { k: "shadow" } });
    }
  } else if (!modelSetFor(model)) {
    const look = lookFor(model.kind, model.product);
    const gs = groundScale(model, zoom, lat);
    const half = (look.units * look.unitLength * gs.len + (look.units - 1) * gs.gap) / 2;
    parts.push(...vehicleBody(model.coords, model.cum, frame.d + half, look, gs));
  }
  const groups = new Map<string, { c: string; b: number; h: number; polys: LngLat[][][] }>();
  for (const part of parts) {
    roundRingsInPlace(part.geometry.coordinates);
    const b = r2(part.properties.b);
    const h = r2(part.properties.h);
    const key = `${part.properties.c}|${b}|${h}`;
    let g = groups.get(key);
    if (!g) {
      g = { c: part.properties.c, b, h, polys: [] };
      groups.set(key, g);
    }
    g.polys.push(part.geometry.coordinates);
  }
  for (const g of groups.values()) {
    out.push({
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: g.polys },
      properties: { k: "body", c: g.c, b: g.b, h: g.h },
    });
  }
  const tail = sliceLine(model.coords, model.cum, Math.max(0, done.from), done.to);
  if (tail.length >= 2) {
    out.push({ type: "Feature", geometry: { type: "LineString", coordinates: tail.map(roundedCopy) }, properties: { k: "done" } });
  }
  const pt = {
    type: "Feature",
    geometry: { type: "Point", coordinates: roundedCopy(frame.position) },
    properties: { k: "pt", hdg: Math.round(frame.heading) },
  };
  return {
    json: JSON.stringify({ type: "FeatureCollection", features: out }),
    ptJson: JSON.stringify({ type: "FeatureCollection", features: [pt] }),
  };
}

/** Halte mit Rolle: schon passiert, nächster, Endhalt — für Ring und Beschriftung. */
export function stopsCollection(model: LiveModel, frame: LiveFrame): string {
  const last = model.stops.length - 1;
  const passedUpTo = frame.phase === "moving" || frame.phase === "climb" || frame.phase === "cruise" || frame.phase === "descent" || frame.phase === "taxiOut"
    ? frame.stopIndex
    : frame.stopIndex - 1;
  return compact({
    type: "FeatureCollection",
    features: model.stops.map((s, i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      properties: {
        label: s.code ? `${s.name} · ${s.code}` : s.name,
        role: i === last ? "end" : i === 0 ? "start" : "mid",
        passed: i <= passedUpTo && i !== last,
        next: frame.nextIndex === i,
        // „Dein" Halt — der der Tafel, von der aus geöffnet wurde.
        mine: model.boardIndex === i,
        // Wer zuerst Platz bekommt: dein Halt und der nächste, dann die Enden, dann der Rest.
        rank: model.boardIndex === i || frame.nextIndex === i ? 0 : i === last || i === 0 ? 1 : 2 + i,
      },
    })),
  });
}
