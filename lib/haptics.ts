import { Platform, Vibration } from "react-native";
import * as Haptics from "expo-haptics";
import { useSearchStore } from "@/stores/searchStore";

export type HapticKind = "button" | "important" | "error" | "tick";

/**
 * Trigger a haptic pulse. Respects the user's `hapticsEnabled` setting —
 * silently no-ops when haptics are disabled in settings.
 *
 * "button" uses platform-specific minimal feedback:
 *   - iOS: selectionAsync() (the softest system tick)
 *   - Android: 8 ms Vibration (Android haptics are not differentiated by
 *     style, so we cap the duration directly to keep the tap subtle)
 *
 * "tick" ist der leichteste, den es gibt — je gescrollter Zahl im Zahlenrad.
 * Auf Android ausdrücklich NICHT als Vibrationsdauer geraten, sondern als
 * `Clock_Tick`: dieselbe Rückmeldung, die das System für die Stunden- und
 * Minutenauswahl seiner eigenen Uhr benutzt. Das Gerät entscheidet damit, wie
 * leicht „leicht" ist, und auf einem Gerät ohne diesen Effekt bleibt es still
 * statt zu poltern.
 */
export function haptic(kind: HapticKind = "button"): void {
  if (!useSearchStore.getState().hapticsEnabled) return;
  switch (kind) {
    case "button":
      if (Platform.OS === "android") Vibration.vibrate(8);
      else void Haptics.selectionAsync();
      return;
    case "important":
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      return;
    case "error":
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    case "tick":
      if (Platform.OS === "android") {
        // Ältere Geräte kennen den Effekt nicht — dann lieber nichts als ein
        // unbehandelter Fehlschlag im Takt von zwanzig je Sekunde.
        Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Clock_Tick).catch(
          () => undefined,
        );
      } else void Haptics.selectionAsync();
      return;
  }
}
