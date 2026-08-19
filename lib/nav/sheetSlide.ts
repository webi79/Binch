import { useCallback, useRef } from "react";
import {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "./overlayCover";
import { setSheetMoving } from "./searchHandoff";

/**
 * EINE Fahrt für alle Blätter von unten.
 *
 * Warum das hier steht und nicht in jedem Blatt einzeln: Weil sie über Monate
 * auseinandergelaufen sind, ohne dass es jemandem auffiel. Zuletzt unterschieden
 * sich Ortswähler, Datumswähler und Such-Blatt in Dauer (250 gegen 300),
 * Strecke (Geräte- gegen Fensterhöhe), Reihenfolge von Parken und Bild-Vorlauf,
 * und darin, ob die Rückfahrt überhaupt eine Ebene bekam. Jede dieser
 * Abweichungen war für sich klein — zusammen ergaben sie den Eindruck „das eine
 * ist elegant, das andere ruckelt".
 *
 * Alles, was die Bewegung ausmacht, steht deshalb genau einmal hier:
 *
 *  - Strecke: die FENSTER-Höhe beim Laden. Nicht die Gerätehöhe (die ist um
 *    Status- und Navigationsleiste größer, das wären bei gleicher Dauer 9% mehr
 *    Tempo), und nicht laufend gelesen (unter `adjustResize` schrumpft sie mit
 *    der Tastatur).
 *  - Kurve und Dauer: `SHEET_IN`/`SHEET_OUT`, dieselben Konstanten wie überall.
 *  - Ablauf: parken, anmelden, EIN Bild zeichnen lassen, dann fahren. Das Bild
 *    dazwischen ist der Unterschied zwischen „die Bewegung läuft gegen den
 *    Aufbau an" und „sie hat den Strang für sich".
 *  - Beide Richtungen gleich aufgebaut. Die Ausfahrt hatte diesen Vorlauf lange
 *    nicht, und genau deshalb war sie die schlechtere von beiden.
 *
 * Die Anmeldung (`markSheetMoving` + `setSheetMoving`) gehört mit hierher: An
 * ihr hängen die Freigabe der GPU-Ebenen und alles, was sich aus einer laufenden
 * Bewegung heraushalten soll. Ein Blatt, das sie vergisst, erzeugt Fehler an
 * ganz anderer Stelle — das ist in dieser Datei mehrfach passiert.
 */
export function useSheetSlide(key: string, park: number) {
  const y = useSharedValue(park);
  const rafRef = useRef<number | null>(null);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value }],
  }));

  /**
   * @param show true = hereinfahren, false = hinausfahren
   * @param onFrame läuft im Bild VOR dem Start — für Bewegungen, die
   *        mitlaufen sollen (etwa das Zurückweichen der Unterlage). Bewusst
   *        genau hier, damit sie denselben Takt bekommen.
   */
  const run = useCallback(
    (show: boolean, onFrame?: (show: boolean) => void) => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      cancelAnimation(y);
      const cfg = show ? SHEET_IN : SHEET_OUT;
      if (show) y.value = park;
      markSheetMoving(cfg.duration);
      setSheetMoving(true, key);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        onFrame?.(show);
        y.value = withTiming(show ? 0 : park, cfg, (finished) => {
          "worklet";
          if (!finished) return;
          runOnJS(setSheetMoving)(false, key);
        });
      });
    },
    [key, park, y],
  );

  /** Ohne Bewegung an den Ausgangspunkt — für den ersten Aufbau. */
  const parkNow = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    cancelAnimation(y);
    y.value = park;
  }, [park, y]);

  return { y, style, run, parkNow };
}
