/**
 * Lightweight-Skeleton der unter der MapSurface gerendert wird bevor MapLibre
 * native initialisiert ist. Ziel: Tab-Switch fühlt sich INSTANT an. Statt
 * leerem Hintergrund sieht der User sofort die Map-Farbgebung + ein paar
 * Andeutungen von „hier wird gleich eine Karte sein".
 *
 * Bewusst KEINE Animation, KEIN Reanimated, KEIN Shimmer — der Sinn ist,
 * Null Aufwand auf dem JS-/UI-Thread während des Tab-Wechsels zu erzeugen.
 * Pure View + StyleSheet, das rendert in einem Frame.
 */
import { View, StyleSheet } from "react-native";
import { scaledStyles } from "@/lib/ui/compact";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { LIGHT_PALETTE } from "@/components/surroundings/mapStyle";

// MapLibre's Standard-Dark-Style hat einen Mid-Grey-Hintergrund (#3A3F44 ca.).
// Wir benutzen einen leicht abgedunkelten Wert damit das Skelett unauffälliger
// als die finale Karte ist und der Fade-In sichtbar bleibt.
const MAP_BG = "#2A2D31";
const LINE = "rgba(255,255,255,0.04)";

/**
 * Unter der HELLEN Karte hell — sonst blendete beim Öffnen ein dunkles Grau in
 * die helle Karte über. Die Siedlungsfarbe und nicht das Land: Die Karte öffnet
 * in der Stadtansicht (Zoom 13), und dort ist ihr Grund genau diese Farbe.
 */
const LIGHT_BG = LIGHT_PALETTE.residential;
const LIGHT_LINE = "rgba(0,0,0,0.05)";

export function MapSkeleton() {
  const light = useResolvedMapStyle() === "light";
  const line = light ? styles.lineLight : styles.line;
  return (
    <View style={[styles.root, light ? styles.rootLight : null]}>
      {/* Horizontal- + Vertikal-Linien als „Straßen-Hint" — sieht nach
          Karte aus ohne Inhalt zu suggerieren. */}
      <View style={[line, styles.lineH, { top: "32%" }]} />
      <View style={[line, styles.lineH, { top: "58%" }]} />
      <View style={[line, styles.lineH, { top: "78%" }]} />
      <View style={[line, styles.lineV, { left: "22%" }]} />
      <View style={[line, styles.lineV, { left: "64%" }]} />
    </View>
  );
}

const styles = scaledStyles({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: MAP_BG,
    overflow: "hidden",
  },
  rootLight: { backgroundColor: LIGHT_BG },
  line: { position: "absolute", backgroundColor: LINE },
  lineLight: { position: "absolute", backgroundColor: LIGHT_LINE },
  lineH: { left: 0, right: 0, height: 1 },
  lineV: { top: 0, bottom: 0, width: 1 },
});
