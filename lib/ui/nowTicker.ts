import { useEffect, useState } from "react";

/**
 * EIN Zeitgeber für alle Countdowns statt einer pro Karte.
 *
 * Im Bo-Verlauf bleibt jede jemals abgefragte Abfahrtstafel gemountet — die
 * Liste hängt am unteren Ende, und was oben herausläuft, wird nicht abgebaut.
 * Jede dieser Karten hielt bisher ihren eigenen Sekunden-Zeitgeber samt
 * eigenem Zustand: Bei zehn abgefragten Stationen sind das zehn Renders pro
 * Sekunde, jeder davon mit einer SVG-Eigenschaft (`strokeDashoffset`), und
 * animierte SVG-Eigenschaften machen die ganze Fläche ungültig. Das läuft
 * weiter, solange Bo offen ist, und wächst mit jeder Frage.
 *
 * Zwei Dinge ändern sich damit:
 *
 *  - Ein einziges Intervall für alle Abonnenten. Es läuft nur, solange
 *    tatsächlich jemand zuhört, und wird beim letzten Abgang abgeräumt.
 *  - Zehn Sekunden statt einer. Angezeigt werden ganze MINUTEN, und der Ring
 *    füllt sich über die volle Wartezeit — bei zehn Minuten sind das 1,7% pro
 *    Takt. Sekundengenau zu rechnen hat davon nie etwas sichtbar gemacht, es
 *    hat nur sechsmal so oft gerendert.
 */
const PERIOD_MS = 10_000;

const listeners = new Set<(t: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function tick(): void {
  now = Date.now();
  for (const fn of listeners) fn(now);
}

/**
 * @param active false = gar nicht mitlaufen (Bildschirm nicht im Vordergrund,
 *        Abfahrt längst durch). Der zurückgegebene Stand bleibt dann stehen.
 */
export function useNowTicker(active: boolean): number {
  /**
   * Frisch ablesen, nicht den Modulwert nehmen.
   *
   * `now` wird ausschließlich im Takt fortgeschrieben — und der läuft nur,
   * solange jemand zuhört. Ist gerade keine Karte im Bild, steht die Zahl seit
   * dem App-Start still. Wer sie dann bekommt (etwa eine Zeile, deren Abfahrt
   * längst durch ist und die deshalb gar nicht mitläuft), rechnet mit einer
   * stundenalten Uhrzeit: „in 110 Min" für einen Zug, der vor zehn Minuten weg
   * war, samt passend gemaltem Ring.
   */
  const [t, setT] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Auf den aktuellen Stand ziehen — aus derselben Quelle wie der Takt, nicht
    // aus dem womöglich eingefrorenen Modulwert.
    now = Date.now();
    setT(now);
    listeners.add(setT);
    if (timer === null) timer = setInterval(tick, PERIOD_MS);
    return () => {
      listeners.delete(setT);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [active]);

  return t;
}
