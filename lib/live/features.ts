/**
 * Die Daten der Live-Ebene auf der Karte (`components/live/LiveVehicleLayer`)
 * — als reine Rechnung herausgelöst, damit sie sich ohne Gerät prüfen lässt.
 */
import { metersPerPixel, sliceLine } from "./geo";
import type { LiveFrame, LiveModel } from "./model";
import {
  lookFor,
  PLANE_LENGTH_M,
  planeBody,
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
  const mppNeeded = (model.length * MAX_SCALE) / MIN_LEN_PX;
  return Math.log2(metersPerPixel(0, lat) / mppNeeded);
}

/** Bodenfahrzeuge mindestens so breit (Punkte) — siehe `BodyScale`. */
export const MIN_WIDTH_PX = 11;

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
function roundRingsInPlace(rings: LngLat[][]): void {
  for (const ring of rings) {
    for (const p of ring) {
      p[0] = r6(p[0]);
      p[1] = r6(p[1]);
    }
  }
}
const roundedCopy = (p: LngLat): LngLat => [r6(p[0]), r6(p[1])];

/**
 * Die Fahrzeug-Quellen für einen Zeitpunkt: der Körper (mit Schatten und dem
 * letzten, noch nicht eingefrorenen Stück des Gefahrenen) und GETRENNT davon
 * der Punkt der 2D-Gestalt.
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
  frozenD: number,
  finColor: string,
): { json: string; ptJson: string; rear: number } {
  const lat = frame.position[1];
  const scale = bodyScale(model, zoom, lat);
  const parts: ExtrusionFeature[] = [];
  const out: object[] = [];
  let rear: number;
  if (model.kind === "plane") {
    for (const ring of planeShadow(frame.position, frame.heading, scale)) {
      roundRingsInPlace([ring]);
      out.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { k: "shadow" } });
    }
    // Kein Lot zum Boden — das Flugzeug sitzt auf seinem Bogen in der Luft,
    // der Schatten darunter zeigt, wo es über Grund ist.
    parts.push(...planeBody(frame.position, frame.heading, frame.drawAltitude, scale, { fin: finColor }));
    rear = frame.d;
  } else {
    const look = lookFor(model.kind, model.product);
    const gs = groundScale(model, zoom, lat);
    const half = (look.units * look.unitLength * gs.len + (look.units - 1) * gs.gap) / 2;
    parts.push(...vehicleBody(model.coords, model.cum, frame.d + half, look, gs));
    rear = frame.d - half;
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
  const tail = sliceLine(model.coords, model.cum, Math.max(0, frozenD - 1), rear);
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
    rear,
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
