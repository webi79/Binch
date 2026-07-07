import { makeMutable } from "react-native-reanimated";

/**
 * Geteilter Parallax-Fortschritt für die horizontalen Push-Overlays.
 *
 * 0 = kein Overlay offen (der darunterliegende Screen ruht),
 * 1 = Overlay voll eingefahren (Underlay maximal verschoben).
 *
 * Die Push-Overlays (DetailsOverlay, TicketDetailOverlay) treiben diesen Wert
 * synchron zu ihrem eigenen Slide. Der Root-Stack-Wrapper (app/_layout.tsx)
 * liest ihn und verschiebt den darunterliegenden Screen ein Stück mit —
 * der iOS-/YouTube-typische gekoppelte Slide. Beim Zurück fährt der Wert auf 0
 * und der Underlay kehrt an seine Ausgangsposition zurück.
 *
 * makeMutable statt useSharedValue, weil der Wert modulweit von mehreren
 * Komponenten geschrieben und im Root gelesen wird (kein Hook-Kontext).
 */
export const underlayShift = makeMutable(0);

/**
 * Wanderstrecke des Underlays als Bruchteil der Screen-Breite.
 * Negativ = nach links (Standard-Parallax: der abgedeckte Screen weicht in
 * Leserichtung zurück). Für „nach rechts" das Vorzeichen umdrehen.
 */
export const UNDERLAY_TRAVEL_FRAC = -0.22;
