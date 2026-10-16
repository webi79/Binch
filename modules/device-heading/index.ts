import { requireOptionalNativeModule } from "expo";

export interface HeadingEvent {
  /** Richtung in Grad, 0 = geografisch Nord, im Uhrzeigersinn. */
  heading: number;
  /** Geschätzte Unsicherheit in Grad, −1 wenn unbekannt. */
  accuracy: number;
}

interface DeviceHeadingNativeModule {
  /** Gibt es einen Lagesensor? Ohne ihn keine Richtung. */
  isAvailable(): boolean;
  start(): void;
  stop(): void;
  /** Standort für die Missweisung (Magnetnord → geografisch Nord). */
  setLocation(latitude: number, longitude: number): void;
  addListener(
    event: "onHeading",
    listener: (e: HeadingEvent) => void,
  ): { remove(): void };
}

/**
 * Androids fusionierter Lagesensor — siehe `android/.../DeviceHeadingModule.kt`
 * für das Warum.
 *
 * `requireOptionalNativeModule`: Es gibt das Modul nur für Android, und im
 * Dev-Client ohne frischen Build gar nicht. Dann ist es `null`, und
 * `lib/surroundings/useDeviceHeading.ts` fällt auf `expo-location` zurück.
 */
export const deviceHeading =
  requireOptionalNativeModule<DeviceHeadingNativeModule>("DeviceHeading");
