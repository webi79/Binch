import { requireOptionalNativeModule } from "expo";

interface TickSoundNativeModule {
  /** Klang in den Speicher laden. Mehrfach aufrufbar, wirkt nur einmal. */
  prime(): void;
  /** Sofort abspielen. Lautstärke 0…1. */
  play(volume: number): void;
  /** Speicher wieder freigeben. */
  release(): void;
}

/**
 * Der Klick des Zahlenrades über Androids `SoundPool` — siehe
 * `android/.../TickSoundModule.kt` für das Warum.
 *
 * `requireOptionalNativeModule` statt `requireNativeModule`: Es gibt das Modul
 * nur für Android, und im Dev-Client ohne frischen Build gibt es es gar nicht.
 * Beides liefert hier `null`, und die aufrufende Seite (`lib/ui/tick.ts`) fällt
 * dann auf den Abspieler aus `expo-audio` zurück.
 */
export const tickSound =
  requireOptionalNativeModule<TickSoundNativeModule>("TickSound");
