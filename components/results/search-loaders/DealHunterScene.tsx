/**
 * „Schnäppchenjäger" — Bo wippt hin und her und fängt fallende Deal-Chips.
 */
import { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withDelay,
  cancelAnimation,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { Bo } from "@/components/assistant/Bo";
import { useAccent } from "@/lib/theme/accent";
import { CatchNet, DealChip, SCENE_W, useLoaderPaused } from "./SearchSceneChrome";
import { scaledStyles } from "@/lib/ui/compact";

const SCENE_H = 252;

const CHIPS = [
  { code: "FR", color: "#1B4DA0", label: "89 €", x: 30, delay: 0, dur: 2500 },
  { code: "EW", color: "#9B1B6B", label: "94 €", x: 150, delay: 900, dur: 2700 },
  { code: "DE", color: "#C8881A", label: "112 €", x: 224, delay: 1700, dur: 2400 },
  { code: "U2", color: "#C8551A", label: "76 €", x: 96, delay: 2600, dur: 2600 },
];

function FallingChip({
  code,
  color,
  label,
  x,
  delay,
  dur,
  accent,
}: (typeof CHIPS)[number] & { accent: string }) {
  const paused = useLoaderPaused();
  const t = useSharedValue(0);
  useEffect(() => {
    if (paused) return;
    t.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: dur, easing: Easing.linear }), -1, false),
    );
    return () => cancelAnimation(t);
  }, [delay, dur, t, paused]);

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.14, 0.72, 1], [0, 1, 1, 0]),
    transform: [
      { translateY: interpolate(t.value, [0, 1], [0, 168]) },
      { rotate: `${interpolate(t.value, [0, 1], [-10, 8])}deg` },
    ],
  }));

  return (
    <Animated.View
      style={[{ position: "absolute", left: x, top: 60 }, style]}
      pointerEvents="none"
    >
      <DealChip code={code} badgeColor={color} label={label} accent={accent} />
    </Animated.View>
  );
}

function Catcher({ accent }: { accent: string }) {
  const paused = useLoaderPaused();
  const slide = useSharedValue(-52);
  useEffect(() => {
    if (paused) return;
    slide.value = withRepeat(
      withTiming(52, { duration: 2500, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(slide);
  }, [slide, paused]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: slide.value }] }));

  return (
    <Animated.View style={[styles.catcher, style]}>
      <View style={styles.bo}>
        <Bo state="happy" size={110} />
      </View>
      <View style={styles.net}>
        <CatchNet size={96} accent={accent} />
      </View>
    </Animated.View>
  );
}

export function DealHunterScene() {
  const accent = useAccent();
  return (
    <View style={{ width: SCENE_W, height: SCENE_H, overflow: "hidden" }}>
      {CHIPS.map((c, i) => (
        <FallingChip key={i} {...c} accent={accent.solid} />
      ))}
      <Catcher accent={accent.solid} />
    </View>
  );
}

const styles = scaledStyles({
  catcher: {
    position: "absolute",
    bottom: 4,
    left: (SCENE_W - 170) / 2,
    width: 170,
    height: 170,
  },
  bo: { position: "absolute", left: 0, bottom: 0 },
  net: { position: "absolute", left: 58, top: 0 },
});
