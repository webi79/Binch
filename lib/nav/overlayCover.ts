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
 * Eigenes Timing für den Unterlay-Parallax (overlayCover), YouTube-Feel:
 * Der Parallax soll FRÜHER zur Ruhe kommen als die Overlay-Slide — gleich-
 * zeitiges Ankommen wirkt komisch (das Unterlay „zappelt" noch, während das
 * Overlay schon steht). Deshalb kürzere Dauer (240 vs 300 ms) + moderate
 * Decelerate-Kurve: sanfter Start (kein Ruck wie bei der frontlastigen
 * emphasized-Kurve), weiches Ausrollen, sichtbar fertig bevor das Overlay
 * landet.
 */
export const COVER_DURATION = 240;
export const COVER_IN_EASING = Easing.bezier(0.3, 0, 0.2, 1);
export const COVER_OUT_EASING = Easing.bezier(0.3, 0, 0.2, 1);

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
