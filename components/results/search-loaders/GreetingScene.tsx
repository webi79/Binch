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
import { useT } from "@/lib/i18n/useT";
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
  const t = useT();
  // Kurzes Ziel-Label für die Sprechblase (sonst wirken lange „Frankfurt(M)Hbf"
  // Strings überdimensioniert).
  const shortDest = destLabel.length > 20 ? destLabel.slice(0, 18) + "…" : destLabel;
  const greeting = name
    ? t("loader.greeting.named").replace("{name}", name)
    : t("loader.greeting");
  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      {/* Sprechblase und Bo stapeln sich jetzt in einer Spalte, statt beide
          absolut positioniert zu sein (Blase top:0, Bo fest bei top:92).
          Absolut hieß: Wird die Blase kürzer als erwartet, klafft darunter eine
          Lücke und die Blasenspitze zeigt ins Leere — genau das war zu sehen,
          Bo hing ~35 px unter seiner eigenen Sprechblase.

          Mit den neuen Übersetzungen wäre es schlimmer geworden: „Accroche-toi —
          direction Lisbonne!" bricht anders um als der deutsche Satz, die
          Blasenhöhe variiert also je Sprache. Eine Spalte hält Bo IMMER direkt
          unter der Spitze, egal wie hoch die Blase wird. */}
      <View style={styles.stack}>
        <SpeechBubble maxWidth={250}>
          <Text style={styles.bubbleTxt}>
            {greeting}
            {"\n"}
            {t("loader.destination")}{" "}
            <Text style={[styles.hi, { color: accent.solid }]}>{shortDest}!</Text>
          </Text>
        </SpeechBubble>
        <Bo state="talking" size={118} />
      </View>

      <View style={styles.route}>
        <View style={styles.routeLine} />
        <Text style={[styles.code, { left: 0, color: "#8A8A90" }]}>{t("loader.from")}</Text>
        <Text style={[styles.code, { right: 0, color: accent.solid }]}>{t("loader.to")}</Text>
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
  stack: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    // Kleiner, fester Abstand zwischen Blasenspitze und Bos Kopf — sie gehören
    // zusammen. Vorher ergab er sich zufällig aus zwei absoluten Positionen.
    gap: 6,
  },
  bubbleTxt: {
    color: "#FFFFFF",
    fontSize: 14.5,
    lineHeight: 20,
    fontWeight: "500",
    textAlign: "center",
  },
  hi: { fontWeight: "700" },
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
