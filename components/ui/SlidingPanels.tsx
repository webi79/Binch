/**
 * SlidingPanels — Pager-Style Container für 2+ Panels.
 *
 * Beide (oder N) Panels sitzen side-by-side in EINEM breiten Container
 * (width = screenW * N). Bei Mode-Wechsel wird der gesamte Container
 * per translateX bewegt, sodass das gewünschte Panel im Viewport landet.
 *
 * Vorteil gegenüber 2× separaten Animationen: es gibt nur EINE bewegte
 * View. Die Inhalte (auch SVGs wie Bo) werden während des Slides nicht
 * pro Frame neu compositet — sie sind einfach Children einer einzigen
 * sich bewegenden View. Wirkt wie ein durchgehender Pager (Shazam-Style).
 */
import { Children, useEffect, useState } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { ReactNode } from "react";

interface Props {
  /** Welches Panel ist aktiv (0-indexed). */
  activeIndex: number;
  /** Panels — jedes Kind wird in einen full-width Slot gepackt. */
  children: ReactNode;
}

export function SlidingPanels({ activeIndex, children }: Props) {
  const { width: screenW } = useWindowDimensions();
  const panels = Children.toArray(children);
  const tx = useSharedValue(-activeIndex * screenW);

  // Hardware-Texture/Rasterisierung NUR während der Slide-Animation aktiv.
  // Vorher war's permanent ON für saubere Bo-Animation (siehe Saved-Tab
  // EmptyState). Das hat aber bei Panels mit FlatLists drin (z.B.
  // BinchDatePicker-Kalender) verursacht dass die gecachte Bitmap mid-
  // Animation aus dem Sync gerät → Zellen visuell verrutschen.
  //
  // Lösung: bei activeIndex-Wechsel rasterize=true setzen, nach Animation-
  // Ende auf false. Außerhalb des Slides ist die Tree wieder normal.
  const [rasterize, setRasterize] = useState(false);

  useEffect(() => {
    setRasterize(true);
    tx.value = withTiming(
      -activeIndex * screenW,
      { duration: 280, easing: Easing.bezier(0.4, 0, 0.2, 1) },
      (finished) => {
        if (finished) runOnJS(setRasterize)(false);
      },
    );
  }, [activeIndex, screenW, tx]);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  return (
    <View style={s.viewport}>
      <Animated.View
        collapsable={false}
        renderToHardwareTextureAndroid={Platform.OS === "android" && rasterize}
        shouldRasterizeIOS={Platform.OS === "ios" && rasterize}
        style={[
          {
            flexDirection: "row",
            width: screenW * panels.length,
            flex: 1,
          },
          style,
        ]}
      >
        {panels.map((panel, i) => (
          <View key={i} style={[s.slot, { width: screenW }]}>
            {panel}
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  viewport: { flex: 1, overflow: "hidden" },
  slot: { flex: 1 },
});
