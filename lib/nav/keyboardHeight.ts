import { useAnimatedKeyboard, useAnimatedReaction, makeMutable } from "react-native-reanimated";

/**
 * Die Tastaturhöhe — EINMAL angemeldet, für die ganze Lebensdauer der App.
 *
 * WARUM DAS EIN EIGENES MODUL IST:
 *
 * `useAnimatedKeyboard()` ist nicht bloß ein Abonnement. Die ERSTE Anmeldung
 * schaltet die Fenster-Dekoration um (`setDecorFitsSystemWindows`) und hängt
 * einen Insets-Horcher an die decorView; dessen Rückruf setzt `LayoutParams`
 * auf der Activity-Wurzel. Das ist ein `requestLayout()` über den GESAMTEN
 * nativen Baum der Activity — auf dem UI-Strang.
 *
 * Bisher stand der Aufruf im Render-Körper des Bo-Bildschirms, und der ist der
 * einzige Nutzer in der App. Er wird beim Verlassen abgebaut und beim
 * Zurückkehren neu aufgebaut — die volle Neuvermessung fiel damit in die ersten
 * Bilder JEDER Einfahrt und ans Ende jeder Ausfahrt. Und sie wird teurer, je
 * mehr Nachrichten im Verlauf stehen: Vermessen wird alles, was gemountet ist,
 * und das sind bei langem Verlauf ein Dutzend Zeilen mehr.
 *
 * Hier oben angemeldet passiert das genau einmal beim App-Start — dort, wo
 * ohnehin gerade alles aufgebaut wird und der Startbildschirm davorliegt.
 *
 * Der Wert selbst ist ein Modul-Wert (wie `assistantPush` in `overlayCover`):
 * Wer ihn braucht, liest ihn im Worklet, ohne dass jemand ihn durchreichen
 * muss.
 */
export const keyboardHeight = makeMutable(0);

/**
 * Mountet einmal im Wurzel-Layout und hält `keyboardHeight` aktuell.
 *
 * Rendert nichts. Die Spiegelung läuft über eine Reaktion und damit auf dem
 * UI-Strang — kein Sprung nach JS, kein Rendern.
 */
export function KeyboardHeightProbe(): null {
  const kb = useAnimatedKeyboard();
  useAnimatedReaction(
    () => kb.height.value,
    (value, prev) => {
      if (value !== prev) keyboardHeight.value = value;
    },
  );
  return null;
}
