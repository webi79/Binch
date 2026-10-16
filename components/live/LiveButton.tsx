import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { ms } from "@/lib/ui/compact";

/**
 * Der Knopf „Live verfolgen" an einer Tafel-Zeile — nur das Sende-Zeichen im
 * Rot der LIVE-Pille, ohne Kasten darum, und es SENDET: Der Punkt steht, die
 * beiden Wellen blenden nacheinander auf und ab, die innere zuerst.
 *
 * DIE ANIMATION LÄUFT AUF DEM UI-STRANG und bewegt nur die Deckkraft ganzer
 * Ebenen. Jede Welle ist ein eigenes, unveränderliches SVG in einer eigenen
 * Ansicht — animierte SVG-Eigenschaften würden die ganze Fläche bei jedem Bild
 * neu rastern (feedback_svg_animated_props_invalidate), die Deckkraft einer
 * Hülle nicht.
 *
 * EIN TAKT FÜR ALLE: Die Tafel reicht ihre gemeinsame Uhr herein (`clock`,
 * 0 → 1 in 1,8 s, endlos). Sonst liefe jeder Knopf in eigenem Rhythmus, und
 * die Liste blinkte durcheinander. Ohne Uhr von außen läuft eine eigene.
 *
 * `RippleTouch` statt `Pressable`, wie die Zeile selbst: Ein Druck-Zustand
 * rendert neu, und im gezogenen Blatt setzt jeder Durchgang es kurz zurück
 * (siehe `StopBoardRow`).
 */
const RED = "#FF3B5C";
const PERIOD_MS = 1800;
/** Kantenlänge der Fläche und des Zeichens (Punkte, vor `ms`). */
const BOX = 28;
const ICON = 22;

/** Gemeinsame Uhr für alle Knöpfe einer Tafel; läuft nur, solange `active`. */
export function useLiveClock(active: boolean): SharedValue<number> {
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!active) {
      cancelAnimation(clock);
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(withTiming(1, { duration: PERIOD_MS, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(clock);
  }, [active, clock]);
  return clock;
}

export function LiveButton({
  onPress,
  label,
  clock,
}: {
  onPress: () => void;
  label: string;
  clock?: SharedValue<number>;
}) {
  // Eigene Uhr nur, wenn keine hereingereicht wird (Hooks immer gleich oft).
  const own = useLiveClock(clock == null);
  const c = clock ?? own;
  // Weiche Welle (0…1) mit Phasenversatz — die äußere folgt der inneren.
  const inner = useAnimatedStyle(() => {
    const p = c.value;
    return { opacity: 0.28 + 0.72 * (0.5 - 0.5 * Math.cos(2 * Math.PI * p)) };
  });
  const outer = useAnimatedStyle(() => {
    const p = c.value - 0.18;
    return { opacity: 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(2 * Math.PI * p)) };
  });
  const size = ms(ICON);
  return (
    <RippleTouch
      onPress={onPress}
      hitSlop={10}
      borderless
      accessibilityRole="button"
      accessibilityLabel={label}
      rippleColor="rgba(255,59,92,0.22)"
      style={styles.box}
    >
      <View style={[styles.icon, { width: size, height: size }]} pointerEvents="none">
        <Animated.View style={[StyleSheet.absoluteFill, outer]}>
          <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={RED} strokeWidth={2.2} strokeLinecap="round">
            <Path d="M19.075 4.933a10 10 0 0 1 0 14.134" />
            <Path d="M4.925 19.067a10 10 0 0 1 0-14.134" />
          </Svg>
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, inner]}>
          <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={RED} strokeWidth={2.2} strokeLinecap="round">
            <Path d="M16.247 7.761a6 6 0 0 1 0 8.478" />
            <Path d="M7.753 16.239a6 6 0 0 1 0-8.478" />
          </Svg>
        </Animated.View>
        <Svg width={size} height={size} viewBox="0 0 24 24" style={StyleSheet.absoluteFill}>
          <Circle cx={12} cy={12} r={2.6} fill={RED} />
        </Svg>
      </View>
    </RippleTouch>
  );
}

const styles = StyleSheet.create({
  box: {
    width: ms(BOX),
    height: ms(BOX),
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  icon: { position: "relative" },
});
