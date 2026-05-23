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

export function openStopSheet(): void {
  if (!controller) return;
  controller.translateY.value = withTiming(controller.getMid(), { duration: 350 });
}

export function closeStopSheet(): void {
  if (!controller) return;
  controller.translateY.value = withTiming(controller.getSheetHeight(), { duration: 350 });
}
