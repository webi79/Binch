import { Easing, makeMutable } from "react-native-reanimated";

/**
 * Timing der horizontalen Push-Transitions — Werte NACHGEMESSEN an YouTubes
 * Push (screenrecord → Frame-Analyse, 60 Samples/s, Juli 2026):
 *
 *   PUSH (hin):  Overlay ~400ms emphasized-decelerate — perzeptuell gelandet
 *                bei ~300ms, danach langer butterweicher Kriech-Schwanz
 *                (Android-System nutzt dieselbe Idee: 450ms
 *                fast_out_extra_slow_in). Unterlay-Parallax ist bereits nach
 *                ~100-150ms KOMPLETT fertig (Verhältnis ~1:3!) und der Weg
 *                ist klein (~13% Screenbreite).
 *   POP (zurück): schneller (~250ms), Ease-in-out mit WEICHER Landung (kein
 *                pures Beschleunigen) — Unterlay ist nach ~130ms zuhause,
 *                während das Overlay noch rausfährt.
 */
export const PUSH_DURATION = 400;
export const PUSH_IN_EASING = Easing.bezier(0.05, 0.7, 0.1, 1);

export const POP_DURATION = 260;
export const POP_EASING = Easing.bezier(0.35, 0, 0.25, 1);

/**
 * Unterlay-Parallax: kurz + früh fertig (gemessen ~1/3 der Overlay-Dauer).
 * Decelerate-Kurve: zügiger Start, weiches Ausrollen — bei dem kurzen Weg
 * (13% Breite) wirkt das ruhig, nicht snappy.
 */
export const COVER_DURATION = 150;
export const COVER_IN_EASING = Easing.bezier(0.25, 0, 0.2, 1);
export const COVER_OUT_EASING = Easing.bezier(0.25, 0, 0.2, 1);

/**
 * Geteilter Parallax-Fortschritt der horizontalen Push-Overlays.
 * 0 = kein Overlay (Unterlay in Ruhe), 1 = Overlay voll drin (Unterlay
 * maximal verschoben). Wird von den Overlays synchron zu ihrer Slide
 * getrieben, im Root gelesen (Stack-Parallax).
 *
 * makeMutable statt useSharedValue: modulweit geschrieben/gelesen.
 */
export const overlayCover = makeMutable(0);

/** Parallax-Weg des Unterlays als Bruchteil der Screen-Breite (negativ =
 *  links). YouTube gemessen: ~13%. */
export const UNDERLAY_TRAVEL_FRAC = -0.13;
