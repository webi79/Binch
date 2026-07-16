import { requireOptionalNativeModule } from "expo";

interface ScreenCornersNativeModule {
  /** Display-Eckradius in dp. 0 = kein runder Bezel. */
  getCornerRadius(): number;
}

// requireOptionalNativeModule statt requireNativeModule: Gibt `null` zurück
// (statt zu werfen), wenn das native Modul nicht gelinkt ist — genau der Fall im
// Dev-Client, der noch keinen EAS-Rebuild mit diesem Modul enthält. So läuft die
// App dort ganz normal weiter und nutzt den Fallback-Radius.
const nativeModule =
  requireOptionalNativeModule<ScreenCornersNativeModule>("ScreenCorners");

/**
 * Echter Display-Eckradius des Geräts in dp — oder `null`, wenn er sich nicht
 * bestimmen lässt (Modul nicht gebaut / unbekanntes Gerät).
 *
 * `0` ist ein GÜLTIGES Ergebnis: Geräte mit eckigem Display (SE, alte iPhones,
 * viele Tablets, Emulatoren) liefern 0 → dort sollen die Ecken eckig bleiben.
 * Nur `null` heißt „nicht bestimmbar" und löst den Fallback aus.
 */
export function getDeviceCornerRadius(): number | null {
  if (!nativeModule) return null;
  try {
    const r = nativeModule.getCornerRadius();
    return typeof r === "number" && r >= 0 ? r : null;
  } catch {
    return null;
  }
}
