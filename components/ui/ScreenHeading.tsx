import type { ReactNode } from "react";
import { StyleSheet, Text } from "react-native";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Die Überschrift eines Tabs — Logo im Landingscreen, „Saved", „Profil".
 *
 * Es gibt sie als eigene Komponente, damit die drei nicht bloß zufällig gleich
 * AUSSEHEN, sondern es per Konstruktion SIND. Vorher standen dieselben Werte
 * dreimal getrennt da (einmal als StyleSheet, zweimal als Tailwind-Klassen) und
 * liefen erwartungsgemäß auseinander.
 *
 * `lineHeight` ist bewusst gesetzt, obwohl es optisch nichts ändert: Ohne den
 * Wert bestimmt die Schriftart die Höhe der Textzeile, und die braucht man, um
 * die Überschrift im Landingscreen richtig zu setzen — dort steht die
 * Glocke daneben, die höher ist als der Text (siehe HEADING_LINE_HEIGHT).
 */
export const HEADING_LINE_HEIGHT = 32;

export function ScreenHeading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

const styles = scaledStyles({
  heading: {
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: -0.6,
    lineHeight: HEADING_LINE_HEIGHT,
    color: "#F4F4F5",
  },
});
