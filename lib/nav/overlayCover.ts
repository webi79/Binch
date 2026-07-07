import { Easing, makeMutable } from "react-native-reanimated";

/**
 * Gemeinsame Timing-Kurven für Slide + Parallax (Material-3 „emphasized").
 * Decelerate = starke Abbremsung zum Ende → weiche Landung, kein „Anschlagen
 * an die Kante". Accelerate = beschleunigt beim Rausfahren weg.
 */
export const PUSH_DURATION = 300;
export const PUSH_IN_EASING = Easing.bezier(0.05, 0.7, 0.1, 1);
export const PUSH_OUT_EASING = Easing.bezier(0.3, 0, 0.8, 0.15);

/**
 * Eigene, SANFTERE Kurve für den Unterlay-Parallax (overlayCover): Die
 * emphasized-Kurve oben ist frontlastig (~80% Weg in ~40% Zeit) — auf dem
 * kurzen Parallax-Weg (~22% Screenbreite) wirkt das als „Ruck"/zu snappy.
 * Material-Standard verteilt den Weg gleichmäßiger → das Unterlay trailt
 * dem Overlay weich hinterher (YouTube-Feel). Gleiche Dauer, beide enden
 * synchron.
 */
export const COVER_IN_EASING = Easing.bezier(0.4, 0, 0.2, 1);
export const COVER_OUT_EASING = Easing.bezier(0.4, 0, 0.2, 1);

/**
 * Geteilter Parallax-Fortschritt der horizontalen Push-Overlays.
 * 0 = kein Overlay (Unterlay in Ruhe), 1 = Overlay voll drin (Unterlay
 * maximal verschoben). Wird von den Overlays synchron zu ihrer Slide
 * getrieben, im Root gelesen (Stack-Parallax).
 *
 * makeMutable statt useSharedValue: modulweit geschrieben/gelesen.
 */
export const overlayCover = makeMutable(0);

/** Parallax-Weg des Unterlays als Bruchteil der Screen-Breite (negativ = links). */
export const UNDERLAY_TRAVEL_FRAC = -0.22;
