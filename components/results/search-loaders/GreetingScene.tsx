/**
 * „Persönlicher Gruß" — Bo spricht den User per Sprechblase mit Namen an,
 * darunter eine Mini-Route mit fliegendem Papierflieger.
 */
import { useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { Bo } from "@/components/assistant/Bo";
import { useAccent } from "@/lib/theme/accent";
import { SpeechBubble, PaperPlane, SCENE_W, useLoaderPaused } from "./SearchSceneChrome";

const SCENE_H = 250;

interface Props {
  name?: string;
  destLabel: string;
}

function MiniPlane({
  light,
  main,
  dark,
}: {
  light: string;
  main: string;
  dark: string;
}) {
  const paused = useLoaderPaused();
  const t = useSharedValue(0);
  useEffect(() => {
    if (paused) return;
    t.value = withRepeat(
      withTiming(1, { duration: 3400, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
    return () => cancelAnimation(t);
  }, [t, paused]);

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.12, 0.88, 1], [0, 1, 1, 0]),
    transform: [{ translateX: interpolate(t.value, [0, 1], [10, SCENE_W - 76]) }],
  }));

  return (
    <Animated.View style={[{ position: "absolute", top: -2 }, style]} pointerEvents="none">
      <PaperPlane size={30} light={light} main={main} dark={dark} />
    </Animated.View>
  );
}

export function GreetingScene({ name, destLabel }: Props) {
  const accent = useAccent();
  // Kurzes Ziel-Label für die Sprechblase (sonst wirken lange „Frankfurt(M)Hbf"
  // Strings überdimensioniert).
  const shortDest = destLabel.length > 20 ? destLabel.slice(0, 18) + "…" : destLabel;
  const greeting = name ? `Schnall dich an, ${name} —` : "Schnall dich an —";
  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      <View style={styles.bubbleWrap}>
        <SpeechBubble maxWidth={250}>
          <Text style={styles.bubbleTxt}>
            {greeting}
            {"\n"}
            ab nach{" "}
            <Text style={[styles.hi, { color: accent.solid }]}>{shortDest}!</Text>
          </Text>
        </SpeechBubble>
      </View>

      <View style={styles.boWrap}>
        <Bo state="talking" size={118} />
      </View>

      <View style={styles.route}>
        <View style={styles.routeLine} />
        <Text style={[styles.code, { left: 0, color: "#8A8A90" }]}>VON</Text>
        <Text style={[styles.code, { right: 0, color: accent.solid }]}>NACH</Text>
        <MiniPlane
          light={accent.gradient[0]}
          main={accent.solid}
          dark={accent.dark}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubbleWrap: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  bubbleTxt: {
    color: "#FFFFFF",
    fontSize: 14.5,
    lineHeight: 20,
    fontWeight: "500",
    textAlign: "center",
  },
  hi: { fontWeight: "700" },
  boWrap: { position: "absolute", top: 92, left: 0, right: 0, alignItems: "center" },
  route: {
    position: "absolute",
    bottom: 6,
    left: 8,
    right: 8,
    height: 26,
    justifyContent: "center",
  },
  routeLine: {
    position: "absolute",
    top: 12,
    left: 8,
    right: 8,
    height: 2,
    borderRadius: 2,
    backgroundColor: "#323234",
  },
  code: { position: "absolute", top: 5, fontSize: 11, fontWeight: "700" },
});
