import { makeMutable } from "react-native-reanimated";

/**
 * Geteilter Fortschritt für den Unterlay-Abdunkel-Effekt der horizontalen
 * Push-Overlays. 0 = kein Overlay (Unterlay hell), 1 = Overlay voll drin
 * (Unterlay maximal abgedunkelt).
 *
 * Warum Abdunkeln statt Verschieben: Ein translateX auf dem schweren
 * darunterliegenden Screen (Ergebnisliste + Bilder + native Tab-Bar) muss
 * pro Frame neu compositet werden → Ruckeln. Eine Opacity-Ebene (Schleier)
 * über dem Baum ist dagegen ein billiger Alpha-Blend und läuft flüssig,
 * gibt aber denselben „der Unterlay tritt in den Schatten zurück"-Eindruck
 * wie der iOS-Parallax.
 *
 * makeMutable statt useSharedValue: modulweit von mehreren Komponenten
 * geschrieben, im Root gelesen (kein Hook-Kontext).
 */
export const overlayCover = makeMutable(0);

/** Maximale Schleier-Deckkraft (0..1). */
export const SCRIM_MAX_OPACITY = 0.38;
