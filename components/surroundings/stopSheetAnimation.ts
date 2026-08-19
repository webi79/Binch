/**
 * Globaler Animations-Controller für das StopDetailSheet.
 *
 * Warum nicht direkt in der React-Component? Weil React Re-Renders und der
 * useLayoutEffect-Hook zwischen Tap-Event und Animation-Start liegen — auf
 * langsameren Geräten spürbare Latenz (30-100ms „warum kommt das Sheet nicht
 * sofort?").
 *
 * Stattdessen: das StopDetailSheet registriert seinen SharedValue + Snap-
 * Werte hier einmal beim Mount. Marker-Tap-Handler ruft `openStopSheet()` —
 * läuft komplett auf der UI-Thread (Reanimated `withTiming`), null
 * React-Latenz, instant.
 *
 * Der Store-Update für den Inhalt (Label, Distanz etc.) passiert parallel
 * über `selectStop()`. Beide Pfade convergieren beim User-sichtbaren Sheet.
 */
import { type SharedValue, withTiming } from "react-native-reanimated";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";

interface SheetController {
  translateY: SharedValue<number>;
  getMid: () => number;
  getSheetHeight: () => number;
}

let controller: SheetController | null = null;

export function registerStopSheetAnimation(c: SheetController): () => void {
  controller = c;
  return () => {
    if (controller === c) controller = null;
  };
}

/**
 * Startet die Bewegung im Berührungs-Frame — und ist damit die EINZIGE Stelle,
 * die sie startet.
 *
 * Das Blatt fuhr bis eben zweimal: hier mit 350ms und Reanimateds Vorgabe-Kurve,
 * und einen Commit später noch einmal aus dem Blatt selbst mit `SHEET_IN`. Die
 * zweite Kurve setzte von der inzwischen erreichten Position neu an — ein
 * Geschwindigkeitssprung mitten in der Fahrt, und die Gesamtdauer lag über
 * beiden Werten. Der Kommentar im Blatt behauptete dabei, hier laufe die
 * Bewegung bereits und dort werde nur ein Zeitgeber gesetzt.
 *
 * Jetzt gilt dieselbe Vorgabe wie für jedes andere Blatt von unten.
 */
export function openStopSheet(): void {
  if (!controller) return;
  controller.translateY.value = withTiming(controller.getMid(), SHEET_IN);
}

/** Ohne Aufrufer — bleibt als Gegenstück stehen, benutzt aber dieselbe Vorgabe. */
export function closeStopSheet(): void {
  if (!controller) return;
  controller.translateY.value = withTiming(controller.getSheetHeight(), SHEET_OUT);
}
