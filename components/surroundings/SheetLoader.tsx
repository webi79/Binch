/**
 * Der Lader im Haltestellen- bzw. Stadt-Blatt — mittig im SICHTBAREN Teil.
 *
 * Das Blatt steht meist auf dem mittleren Rastpunkt; sein unteres Stück liegt
 * dann unter dem Bildrand. „Mittig in der Fläche" hieße dort: knapp über dem
 * Rand oder halb verdeckt („die Ladeanimationen sollten jeweils immer mittig
 * sein", 04.11.2026). Er rechnet deshalb aus, wie viel seiner Fläche gerade zu
 * sehen ist, und steht in dessen Mitte — Bild für Bild mit dem Blatt, auch
 * beim Ziehen (nur Lage, der schnelle Weg).
 *
 * Voraussetzung: Seine Fläche reicht bis zum unteren Inhaltsrand des Blattes
 * (Tafel und Stadt-Verbindungen tun das, `flex: 1`). Das Blatt steht bei
 * `fullTop` + `stopSheetY` und ist so hoch, dass es bei 0 genau bis zum
 * Bildrand reicht; unten hält es `insets.bottom + 12` frei
 * (StopDetailSheet.tsx, `paddingBottom`).
 */
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GridLoader } from "@/components/ui/GridLoader";
import { stopSheetY } from "@/components/surroundings/stopSheetAnimation";
import { ms } from "@/lib/ui/compact";

/** Wie `paddingBottom` des Blattes über der sicheren Fläche (StopDetailSheet.tsx). */
const SHEET_BOTTOM_PAD = 12;
/** Größe des Laders (vor `ms`) — seine Höhe ist 0,8 davon. */
const SIZE = 60;

export function SheetLoader({ active = true }: { active?: boolean }) {
  const insets = useSafeAreaInsets();
  const areaH = useSharedValue(0);
  const loaderH = ms(SIZE) * 0.8;
  const pad = insets.bottom + SHEET_BOTTOM_PAD;
  const navInset = insets.bottom;
  const place = useAnimatedStyle(() => {
    // So viel der Fläche liegt gerade unter dem Bildrand.
    const hidden = Math.max(0, stopSheetY.value - pad);
    const onScreen = areaH.value - hidden;
    const visible = Math.max(loaderH, onScreen);
    /**
     * Bis die Fläche vermessen ist, nicht zeigen — sonst stünde er ein Bild
     * lang oben. Und nicht, wenn von ihr kaum mehr als die sichere Fläche zu
     * sehen ist: Eingeklappt (untere Stufe des Blattes) läge er sonst halb
     * über der Navigationsleiste. Er blendet über seine eigene Höhe ein.
     */
    const room = (onScreen - navInset) / loaderH;
    return {
      opacity: areaH.value > 0 ? (room <= 0 ? 0 : room >= 1 ? 1 : room) : 0,
      transform: [{ translateY: Math.max(0, (visible - loaderH) / 2) }],
    };
  });
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={(e) => {
        areaH.value = e.nativeEvent.layout.height;
      }}
    >
      <Animated.View style={[styles.slot, place]}>
        <GridLoader size={SIZE} active={active} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "center" },
});
