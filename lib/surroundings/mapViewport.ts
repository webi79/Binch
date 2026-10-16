import { isSheetDragging } from "@/lib/nav/transitionBusy";

/**
 * DER FREIE AUSSCHNITT DER KARTE — wohin die Blätter gerade fahren.
 *
 * Die Kamera soll den eigenen Standort (und eine angetippte Station) in die
 * MITTE dessen setzen, was man von der Karte wirklich sieht: zwischen der
 * Leiste oben und dem Blatt unten. Bisher zielte sie auf die Mitte des
 * Bildschirms — mit dem Stadt- oder Haltestellen-Blatt in halber Höhe lag der
 * Standort-Punkt damit zur Hälfte unter dem Blatt.
 *
 * Gemeldet wird das ZIEL einer Blatt-Bewegung, nicht jedes Bild: einmal, wenn
 * sie losfährt. Damit kann die Kamera im selben Moment nachführen, in dem das
 * Blatt sich bewegt, und es gibt keinen Sprung über die Brücke pro Bild.
 *
 * Die Werte sind translateY ab der gemeinsamen Oberkante beider Blätter
 * (`fullTop`, siehe `stopSheetSnap`); `null` heißt: nicht zu sehen.
 */

let surroundingsTarget: number | null = null;
let stopTarget: number | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Das Auswahlfenster (SurroundingsSheet) fährt auf diesen Rastpunkt. */
export function reportSurroundingsTarget(y: number): void {
  if (surroundingsTarget === y) return;
  surroundingsTarget = y;
  notify();
}

/** Das Haltestellen-/Stadt-Blatt fährt auf diesen Rastpunkt — `null` = es schließt. */
export function reportStopSheetTarget(y: number | null): void {
  if (stopTarget === y) return;
  stopTarget = y;
  notify();
}

/** Für die Oberfläche der Karte (Nur-Karte-Modus an/aus) — siehe mapChrome.ts. */
export function notifyViewportChanged(): void {
  notify();
}

export function sheetTargets(): { surroundings: number | null; stop: number | null } {
  return { surroundings: surroundingsTarget, stop: stopTarget };
}

export function subscribeViewport(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Bewegt sich die Karte gerade — Kamerafahrt, Wischen, Ausrollen? Gesetzt vom
 * Karten-Tab (Beginn und Ende jeder Bewegung, `onRegionWillChange` /
 * `onRegionDidChange`).
 */
let mapMoving = false;

export function setMapMoving(moving: boolean): void {
  mapMoving = moving;
}

export function isMapMoving(): boolean {
  return mapMoving;
}

/** Wie oft nachgesehen wird, ob Karte und Blatt zur Ruhe gekommen sind. */
const QUIET_RETRY_MS = 80;
/**
 * Höchstens so lange wird gewartet. Wer die Karte minutenlang hin und her
 * schiebt, bekommt die Linie trotzdem — und ein verpasstes „in Ruhe" darf sie
 * nicht für immer zurückhalten.
 */
const QUIET_MAX_MS = 2500;

/**
 * `fn` sofort — oder sobald Karte UND Blatt ruhen.
 *
 * Für Kartendaten, die ohne Zutun eintreffen (Gleisverläufe, Fußwege). Jede
 * neue Linie zerlegt MapLibre in Kacheln und setzt die Beschriftungen neu; fiel
 * das in die Kamerafahrt nach dem Tipp auf eine Stadt, stockte genau diese
 * Fahrt. Außerdem rendert der Karten-Tab dafür neu, und ein React-Durchgang in
 * einem Blatt-Ziehen setzt das Blatt kurz zurück (siehe `startDragHeal`).
 * Wenige hundert Millisekunden später sieht niemand einen Unterschied.
 */
export function whenMapQuiet(fn: () => void): void {
  const busy = () => mapMoving || isSheetDragging();
  if (!busy()) {
    fn();
    return;
  }
  const start = Date.now();
  const retry = () => {
    if (busy() && Date.now() - start < QUIET_MAX_MS) {
      setTimeout(retry, QUIET_RETRY_MS);
      return;
    }
    fn();
  };
  setTimeout(retry, QUIET_RETRY_MS);
}
