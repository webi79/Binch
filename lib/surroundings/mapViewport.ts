import { isSheetDragging, isTransitionBusy, transitionBusyUntil } from "@/lib/nav/transitionBusy";

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
 * Wie lange bis zum nächsten Nachsehen. Hält nur noch eine angemeldete Fahrt
 * auf (`markTransitionBusy`), ist ihr Ende bekannt — dann genau bis dahin statt
 * im 80-ms-Raster. Das Raster kostete bis zu 80 ms nach jeder Fahrt; gemessen
 * am Kartentyp-Wechsel (06.11.2026) kam der Speicher so erst nach ~400 statt
 * ~380 ms an.
 */
function nextCheckMs(): number {
  if (!mapMoving && !isSheetDragging()) {
    const left = transitionBusyUntil() - Date.now();
    if (left > 0) return left + 1;
  }
  return QUIET_RETRY_MS;
}

/**
 * `fn` sofort — oder sobald Karte UND Blatt ruhen.
 *
 * Für Kartendaten, die ohne Zutun eintreffen (Gleisverläufe, Fußwege). Jede
 * neue Linie zerlegt MapLibre in Kacheln und setzt die Beschriftungen neu; fiel
 * das in die Kamerafahrt nach dem Tipp auf eine Stadt, stockte genau diese
 * Fahrt. Außerdem rendert der Karten-Tab dafür neu, und ein React-Durchgang in
 * einem Blatt-Ziehen setzt das Blatt kurz zurück (siehe `startDragHeal`).
 * Wenige hundert Millisekunden später sieht niemand einen Unterschied.
 *
 * Auch eine laufende FAHRT (Blatt herein/hinaus, `markSheetMoving`) zählt als
 * unruhig. Fast jeder Aufrufer prüfte das vorher selbst daneben; wer es vergaß
 * (Kartendaten nach einem Schwenk, Luftbild-Abdeckung), legte seinen Durchgang
 * genau in die Einfahrt des Haltestellen-Blatts — „manchmal ein Ruck in der
 * Mitte der Fahrt": nur, wenn kurz vorher die Karte bewegt wurde.
 */
export function whenMapQuiet(fn: () => void, ownBusyUntil = 0): void {
  /**
   * `ownBusyUntil`: das Ende einer EIGENEN Fahrt (Rückgabe von
   * `markTransitionBusy`) — die hält den Aufrufer nicht auf, fremde schon. Für
   * Arbeit, die die eigene Fahrt selbst nicht mehr stört, andere aber schon.
   */
  const busy = () =>
    mapMoving || isSheetDragging() || (isTransitionBusy() && transitionBusyUntil() > ownBusyUntil);
  if (!busy()) {
    fn();
    return;
  }
  const start = Date.now();
  const retry = () => {
    if (busy() && Date.now() - start < QUIET_MAX_MS) {
      setTimeout(retry, nextCheckMs());
      return;
    }
    fn();
  };
  setTimeout(retry, nextCheckMs());
}

/**
 * Für `notifyOnChangeProps` einer Abfrage, deren Antwort einen großen
 * Bildschirm neu aufbaut (Haltestellen des Karten-Tabs).
 *
 * Trifft die Antwort in eine Bewegung, meldet die Abfrage sie NICHT (leere
 * Liste = kein Durchgang); `rerender` holt das nach, sobald alles ruht —
 * höchstens `QUIET_MAX_MS` später. Die Abfrage hält den neuen Stand derweil
 * schon; der Durchgang danach liest ihn einfach ab. Ohne Bewegung bleibt alles
 * beim Alten (`undefined` = die verfolgten Felder wie immer).
 */
export function quietNotify(rerender: () => void): () => [] | undefined {
  let pending = false;
  const busy = () => mapMoving || isSheetDragging() || isTransitionBusy();
  return () => {
    if (!busy()) return undefined;
    if (!pending) {
      pending = true;
      const start = Date.now();
      const retry = () => {
        if (busy() && Date.now() - start < QUIET_MAX_MS) {
          setTimeout(retry, nextCheckMs());
          return;
        }
        pending = false;
        rerender();
      };
      setTimeout(retry, nextCheckMs());
    }
    return [];
  };
}
