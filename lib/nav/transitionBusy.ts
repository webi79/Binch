/**
 * „Gerade fährt etwas" — als schlichter Zeitstempel.
 *
 * WOZU: Die Persistenz des Speichers serialisiert den Zustand und wartet dafür
 * auf eine
 * Leerlauf-Lücke (`requestIdleCallback`). Nur misst die die Ruhe des
 * JS-STRANGS — und jede Bewegung dieser App läuft als Worklet auf dem
 * UI-STRANG. Während einer Slide ist der JS-Strang also genau ruhig, die
 * Leerlauf-Bedingung ist erfüllt, und der Schreibvorgang läuft ausgerechnet
 * dann hinein.
 *
 * Sichtbar fällt dabei kein Bild aus: Die Kurve selbst rechnet weiter auf dem
 * UI-Strang. Was sich staut, sind die Rückrufe, an denen die Übergänge hängen —
 * `runOnJS` am Ende einer Bewegung, React-Commits, Berührungen. Genau das kommt
 * als „läuft, hakt kurz, läuft weiter" an.
 *
 * WARUM EIN ZEITSTEMPEL und kein Zähler: Ein Zähler müsste bei jedem
 * Abbruch, jeder unterbrochenen Kurve und jedem Bildschirm, der ohne
 * Abschluss-Rückruf verschwindet, sauber wieder heruntergezählt werden — und
 * jeder vergessene Pfad ließe die Persistenz für immer verstummen. Ein
 * Zeitstempel verfällt von selbst; im schlimmsten Fall wartet ein
 * Schreibvorgang eine halbe Sekunde zu lang.
 */
import { probeTransition } from "@/lib/perf/transitionProbe";

let busyUntil = 0;

/**
 * Meldet eine laufende Bewegung an, für die angegebene Dauer plus Reserve.
 * Gibt das Ende DIESER Meldung zurück (`Date.now()`-Zeit) — für
 * `whenMapQuiet(fn, ownBusyUntil)`.
 */
export function markTransitionBusy(durationMs: number): number {
  const until = Date.now() + durationMs + 80;
  if (until > busyUntil) busyUntil = until;
  // Messsonde (vorübergehend, nur gegen einen Server im eigenen Netz).
  probeTransition(durationMs);
  return until;
}

/** Bis wann (`Date.now()`-Zeit) gerade etwas fährt; in der Vergangenheit: nichts. */
export function transitionBusyUntil(): number {
  return busyUntil;
}

export function isTransitionBusy(): boolean {
  return Date.now() < busyUntil;
}

/**
 * „Ein Finger zieht gerade ein Blatt" — der Fall, den `markTransitionBusy`
 * NICHT abdeckt.
 *
 * Der Zeitstempel oben will eine DAUER, und die kennt man bei einer
 * programmierten Fahrt. Bei einem Ziehen kennt sie niemand: Es dauert, solange
 * der Finger liegt. Ihn pro Bild anzumelden hieße einen Sprung auf den
 * JS-Strang je Bild — genau das, was die Bewegung flüssig hält, indem es
 * unterbleibt.
 *
 * Also zwei Meldungen je Ziehen, beim Aufsetzen und beim Loslassen. Damit ein
 * verpasstes Loslassen nicht alles für immer lahmlegt, verfällt auch dieser
 * Zustand von selbst — dieselbe Vorsicht wie beim Zeitstempel oben, nur mit
 * einer großzügigen Grenze: Ein Ziehen von über einer Viertelminute gibt es
 * nicht.
 *
 * WOZU: Im Haltestellen-Blatt läuft ein Sekundentakt für die Abfahrtszeiten.
 * Er zeichnet die ganze Liste neu, samt eines SVG-Rings je Zeile — und
 * animierte SVG-Eigenschaften machen die ganze Fläche ungültig. Trifft dieser
 * Takt in ein laufendes Ziehen, springt der Inhalt sichtbar, während man das
 * Blatt in der Hand hat.
 */
let dragSince = 0;
const DRAG_MAX_MS = 15_000;

export function setSheetDragging(on: boolean): void {
  dragSince = on ? Date.now() : 0;
}

export function isSheetDragging(): boolean {
  return dragSince > 0 && Date.now() - dragSince < DRAG_MAX_MS;
}
