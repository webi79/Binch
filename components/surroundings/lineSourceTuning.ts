/**
 * Kacheln der Linie nur bis Zoom 14, darüber vergrößert — und etwas gröber
 * vereinfacht (1 statt 0,375 Kachelpunkte).
 *
 * Ein Gleisverlauf über ein paar hundert Kilometer hat Tausende Punkte. Bis
 * Zoom 18 (Vorgabe) zerlegt MapLibre ihn für jede Stufe in eigene Kacheln neu
 * — beim Verschieben und Zoomen in der Nähe der Strecke Arbeit in jedem neuen
 * Ausschnitt. Ab 14 reicht die Genauigkeit (unter einem halben Meter) für
 * jede Stufe, und einen Kachelpunkt Vereinfachung sieht an einer 4 Punkte
 * breiten Linie niemand.
 */
export const LINE_SOURCE_MAXZOOM = 14;
export const LINE_SOURCE_TOLERANCE = 1;
