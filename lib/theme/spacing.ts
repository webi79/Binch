import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";
import { HEADING_LINE_HEIGHT } from "@/components/ui/ScreenHeading";
import { ms } from "@/lib/ui/compact";
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
/**
 * ROHWERTE — die Skalierung passiert erst im Stilblatt.
 *
 * Naheliegend wäre, sie hier einmal herunterzurechnen. Das wäre aber genau
 * einmal zu viel: Diese Werte stehen fast ausschließlich IN Stilblättern, und
 * die laufen inzwischen alle durch `scaledStyles`. Vorskaliert bekämen sie den
 * Faktor zweimal — auf einem kurzen Gerät aus 16 erst 13 und dann 10.
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

/**
 * Vertikaler Takt der Tab-Überschrift (Logo, „Saved", „Profil").
 *
 * Gleiches Problem wie beim GUTTER, nur senkrecht: Jeder Screen hatte seinen
 * eigenen Abstand unter der Überschrift — Saved 16, Landing 14, Profil 12. Beim
 * Tab-Wechsel rutschte der Inhalt also jedes Mal ein paar Pixel, zu wenig um es
 * zu benennen, genug damit es unruhig wirkt.
 *
 * `TOP` gilt ab der sicheren Fläche (unter Statusleiste/Notch), `GAP` ist der
 * Abstand von der Unterkante der Überschrift zum ERSTEN Element darunter.
 */
export const HEADING_TOP = SPACE.xxl;
export const HEADING_GAP = SPACE.lg;

/**
 * Das Schließen-Zeichen einer Kopfzeile — und wo die Zeile dafür beginnt.
 *
 * Beides wird von zwei Kopfzeilen gebraucht (Bos Bildschirm und die
 * Chat-Schublade dahinter). Zwei Kopien laufen auseinander, und der Fehler
 * wäre nicht offensichtlich: Die Überschriften stünden um wenige Punkte
 * versetzt.
 *
 * Das X steht FREI, ohne Kreis — so wie in allen Blättern der App. Es war in
 * Bos Kopfzeile als einziges in einen 36er-Kreis gesetzt.
 *
 * `TOPBAR_TOP` ist hergeleitet, nicht geschätzt: `alignItems: "center"`
 * schiebt die Textzeile um die halbe Differenz nach unten, WENN das Zeichen
 * daneben höher ist als sie. Mit dem freien X (26 gegen 32) ist es das nicht
 * mehr — der Überhang ist null, und die Überschrift beginnt schlicht auf
 * HEADING_TOP. Das `Math.max` hält die Herleitung trotzdem sichtbar: Wächst
 * das Zeichen je über die Zeilenhöhe, rechnet sie wieder mit.
 */
export const CLOSE_ICON_SIZE = 26;
export const TOPBAR_TOP =
  HEADING_TOP - Math.max(0, (CLOSE_ICON_SIZE - HEADING_LINE_HEIGHT) / 2);

/** Kantenlänge der Glocke rechts in der Kopfzeile des Landingscreens. */
export const BELL_SIZE = 44;

/**
 * Um so viel überragt die Glocke die Textzeile nach oben UND unten.
 *
 * Die Kopfzeile ist so hoch wie die Glocke (44), nicht wie der Text (32).
 * `alignItems: "center"` schiebt den Text damit um die halbe Differenz nach
 * unten — die Abstände darüber und darunter werden um genau diesen Betrag
 * gekürzt, damit die Überschrift trotzdem auf denselben Werten sitzt wie in
 * den Tabs ohne Glocke.
 */
export const BELL_OVERHANG = (BELL_SIZE - HEADING_LINE_HEIGHT) / 2;

/**
 * Höhe des Kopfblocks im Landingscreen — ab der sicheren Fläche gerechnet,
 * also OHNE `insets.top`.
 *
 * Damit endet er, und damit beginnt das erste Element darunter (die Suchleiste).
 * Das Benachrichtigungs-Blatt der Glocke braucht diesen Wert, weil es genau an
 * dieser Kante stehen bleibt statt bis nach oben zu fahren.
 *
 * SCHON SKALIERT — wie `useNavbarSpace()` und aus demselben Grund: Der Wert
 * wird direkt als Position gesetzt und läuft durch kein Stilblatt. In ein
 * `scaledStyles`-Blatt gehört er deshalb NICHT, dort bekäme er den Faktor ein
 * zweites Mal.
 *
 * Die drei Summanden werden EINZELN gedreht, nicht die Summe: Genau so stehen
 * sie im Stilblatt der Kopfzeile, und nur so trifft das Ergebnis die dortige
 * Rundung auf den Punkt.
 */
export const HOME_HEADER_H =
  ms(HEADING_TOP - BELL_OVERHANG) + ms(BELL_SIZE) + ms(HEADING_GAP - BELL_OVERHANG);

/**
 * Höhe eines Eingabefeldes — und des Such-Knopfes.
 *
 * Steht hier und nicht in einem der beiden Screens, weil der Such-Screen und der
 * Kopfbereich der Ergebnisliste gleich aussehen SOLLEN: Es ist dieselbe Strecke,
 * einmal zum Eingeben und einmal zum Anzeigen. Zwei Zahlen an zwei Orten laufen
 * beim nächsten Feinschliff garantiert auseinander.
 */
export const FIELD_H = 56;

/**
 * Platz, den eine scrollende Fläche unten freihalten muss.
 *
 * Nötig, seit die Tab-Leiste durchsichtig ist: Vorher hat sie ihren Platz selbst
 * reserviert und der Inhalt endete über ihr. Jetzt läuft er darunter hindurch.
 *
 * Als KONSTANTE ging das nicht auf, und zwar nicht knapp: Die echte Höhe ist
 * `TAB_BAR_H (66) + insets.bottom`, und die sichere Fläche schwankt zwischen 24
 * (Gesten-Navigation) und 48 (drei Knöpfe) — also 90 bis 114. Mit festen 96 lag
 * das letzte Element auf Geräten mit Knopfleiste bis zu 18dp hinter der Leiste,
 * sichtbar durchscheinend und nicht antippbar.
 *
 * Deshalb ein Hook. Wer ihn nicht aufrufen kann (Stil außerhalb einer
 * Komponente), nimmt NAVBAR_SPACE_MAX.
 */
export function useNavbarSpace(): number {
  // `ms` hier, weil dieser Wert NICHT durch ein Stilblatt läuft, sondern
  // direkt als Innenabstand gesetzt wird. Die Leiste selbst schrumpft über ihr
  // eigenes Stilblatt — ohne diese Zeile bliebe unten ein Rest Luft stehen.
  return ms(TAB_BAR_H) + useSafeAreaInsets().bottom;
}

/** Sicherer Höchstwert für Stile, die außerhalb einer Komponente stehen. */
export const NAVBAR_SPACE_MAX = ms(TAB_BAR_H) + 48;
