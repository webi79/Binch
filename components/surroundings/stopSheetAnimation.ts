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
import { makeMutable, type SharedValue, withTiming } from "react-native-reanimated";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import { reportStopSheetTarget } from "@/lib/surroundings/mapViewport";

/**
 * Die Lage des Blattes (translateY ab `fullTop`) — als EIN Wert auf
 * Modulebene statt im Blatt.
 *
 * Der Standort-Knopf über dem Auswahlfenster liest ihn mit: Er steht über dem
 * Blatt, das gerade höher reicht, und wurde vorher vom hereinfahrenden
 * Haltestellen-Blatt einfach verdeckt. Der Knopf lebt im Karten-Tab, das
 * Blatt am Wurzel-Layout — ein gemeinsamer Wert erreicht beide im selben
 * Bild. Ein Zwischenschritt über eine Reaktion hinkte ein Bild hinterher,
 * sichtbar als Wackeln des Knopfes beim Ziehen.
 *
 * Startwert weit unter dem Rand: „kein Blatt da". Das Blatt setzt beim Anlegen
 * seine echte Ruhestellung (siehe StopDetailSheet.tsx).
 */
export const stopSheetY = makeMutable(100000);

/**
 * Die Selbstkorrektur des Blattes beim Ziehen (siehe `startDragHeal` in
 * lib/ui/sheetSwipe.ts) — ebenfalls auf Modulebene: Der Standort-Knopf hängt an
 * der Kante dieses Blattes und braucht sie genauso.
 */
export const stopSheetHeal = makeMutable(0);

/**
 * Was das Blatt zeigt: eine Haltestelle (Abfahrten) oder eine Stadt (Zug, Bus
 * und Flug dorthin). Dieselbe Fläche, dieselbe Bewegung, dieselben Rastpunkte.
 */
export type StopSheetKind = "stop" | "city";

/**
 * Die Rastpunkte des Blattes — EINE Stelle für Blatt und Karte.
 *
 * Die Karte braucht die mittlere Höhe auch: Sie rückt die Route des
 * Stadt-Blatts so ein, dass sie über dem Blatt zu sehen ist. Stünde die Rechnung zweimal, liefen die
 * beiden beim nächsten Anfassen auseinander.
 *
 * Werte als translateY ab der Oberkante (`fullTop`): 0 = ganz offen,
 * `sheetHeight` = unter dem Bildrand.
 */
export function stopSheetSnap(screenHeight: number, insetsTop: number, insetsBottom: number) {
  const fullTop = Math.max(60, insetsTop + 12);
  const sheetHeight = screenHeight - fullTop;
  const midVisible = Math.min(sheetHeight - 80, Math.max(420, screenHeight * 0.5));
  return {
    fullTop,
    sheetHeight,
    full: 0,
    mid: Math.max(0, sheetHeight - midVisible),
    /** Wie viel vom Blatt in der Mitte zu sehen ist — für die Karte. */
    midVisible,
  };
}

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
  // Als Fahrt anmelden: Wer auf „nichts fährt gerade" wartet (Vorbau der
  // Such-Slide, Kegel, Sekundentakt), wartet damit auch auf diese Einfahrt.
  markSheetMoving(SHEET_IN.duration);
  controller.translateY.value = withTiming(controller.getMid(), SHEET_IN);
  reportStopSheetTarget(controller.getMid());
}

/** Ohne Aufrufer — bleibt als Gegenstück stehen, benutzt aber dieselbe Vorgabe. */
export function closeStopSheet(): void {
  if (!controller) return;
  controller.translateY.value = withTiming(controller.getSheetHeight(), SHEET_OUT);
  reportStopSheetTarget(null);
}
