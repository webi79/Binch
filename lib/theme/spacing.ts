/**
 * EIN Raster für die ganze App.
 *
 * Vorher hatte jeder Screen seinen eigenen Rand: Home 22, Settings 16, Saved 16
 * (mit einem verirrten 20 bei der Ticket-Zeile), Results 16. Beim Tab-Wechsel
 * sprang der Inhalt also seitlich — nicht viel, aber genug, dass es unruhig
 * wirkt, ohne dass man sofort sagen kann warum.
 *
 * Alle Werte liegen auf dem 4er-Raster. Das ist keine Zahlenmystik: Ein Raster
 * macht Abstände VERGLEICHBAR („eine Stufe mehr Luft" statt „18 statt 16"), und
 * dieselbe Stufe sieht dann überall gleich aus.
 */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/**
 * Abstand zum Bildschirmrand. Gilt für JEDEN Screen.
 *
 * 20 statt Homes 22 oder Settings' 16: Material erlaubt 16-24, iOS nutzt 20, und
 * 20 liegt auf dem Raster. Der genaue Wert ist weniger wichtig als die Tatsache,
 * dass es nur EINEN gibt — an ihm richtet sich alles aus, was den Rand berührt:
 * Header, Suchleiste, Sektionsköpfe, Karten.
 */
export const GUTTER = SPACE.xl;
