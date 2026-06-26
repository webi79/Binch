/**
 * BinchSplash — animierter App-Startscreen / Splash
 *
 * Minimalistisches Logo-Reveal: jeder Buchstabe der Binch-Wortmarke
 * klappt einzeln per Split-Flap-Tafel (rotateX) rein, gestaffelt.
 * Am Ende der Sequenz fadet das gesamte Logo wieder weg (für den
 * Übergang zum Landing-Screen).
 *
 * Reanimated-basiert — alles läuft auf dem UI-Thread, smooth auch
 * während JS-Bundle / Fonts laden. Ein einzelner SharedValue `p` (0→1)
 * treibt alle Animationen per Interpolation.
 */

import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";

const WHITE = "#FFFFFF";
const BG = "#161616";

interface Props {
  onFinish?: () => void;
  loop?: boolean;
  duration?: number;
}

export function BinchSplash({
  onFinish,
  loop = false,
  duration = 3000,
}: Props) {
  const p = useSharedValue(0);
  // Akzent-Farbe aus dem User-Setting (lime/mint/…). Splash matched damit
  // die App-Wahl — bei Lime grün, bei Mint türkis.
  const accent = useAccent();

  const letters = [
    { ch: "B", color: WHITE },
    { ch: "i", color: accent.solid },
    { ch: "n", color: WHITE },
    { ch: "c", color: WHITE },
    { ch: "h", color: WHITE },
  ];

  useEffect(() => {
    if (loop) {
      const tick = () => {
        p.value = 0;
        p.value = withTiming(
          1,
          { duration, easing: Easing.linear },
          (finished) => {
            if (finished) runOnJS(tick)();
          },
        );
      };
      tick();
    } else {
      p.value = withTiming(
        1,
        { duration, easing: Easing.linear },
        (finished) => {
          if (finished && onFinish) runOnJS(onFinish)();
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.root}>
      <View style={styles.logoRow} pointerEvents="none">
        {letters.map((l, i) => (
          <Letter key={i} p={p} index={i} char={l.ch} color={l.color} />
        ))}
      </View>
    </View>
  );
}

function Letter({
  p,
  index,
  char,
  color,
}: {
  p: SharedValue<number>;
  index: number;
  char: string;
  color: string;
}) {
  const style = useAnimatedStyle(() => {
    // Staffel-Start früh (ab 5%), pro Buchstabe +5%. Mit 5 Buchstaben
    // landet der letzte bei ~25% + 8% Flip → fertig bei ~33% des Splash.
    // Danach kann das Logo solid stehen bleiben und am Ende rausfaden.
    const start = 0.05 + index * 0.05;
    const rotateX = interpolate(
      p.value,
      [0, start, start + 0.08, 0.9, 1],
      [-92, -92, 0, 0, -92],
    );
    const opacity = interpolate(
      p.value,
      [0, start, start + 0.08, 0.9, 1],
      [0, 0, 1, 1, 0],
    );
    return {
      opacity,
      transform: [{ perspective: 760 }, { rotateX: `${rotateX}deg` }],
    };
  });

  return (
    <Animated.Text style={[styles.letter, { color }, style]}>
      {char}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
    alignItems: "center",
    justifyContent: "center",
  },
  logoRow: {
    flexDirection: "row",
    alignItems: "flex-end",
  },
  letter: {
    fontSize: 78,
    lineHeight: 80,
    fontWeight: "900",
    letterSpacing: -4,
    marginHorizontal: 1,
  },
});
