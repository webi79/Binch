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
import { scaledStyles } from "@/lib/ui/compact";

const SCENE_H = 250;

/**
 * Hebt die ganze Szene an. Der Loader zentriert die Szene vertikal
 * (`justifyContent: "center"`), und Margins zählen dabei mit — unten Luft heißt
 * also: Inhalt rutscht um die HÄLFTE davon nach oben.
 *
 * Nötig, weil die Sprechblase über Bo Platz braucht und ihn dadurch unter die
 * optische Mitte drückt. Eine Zahl, ein Effekt — wenn Bo jetzt zu HOCH sitzt,
 * hier kleiner machen.
 */
const BOTTOM_LIFT = 34;

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
    // Linear, aus demselben Grund wie beim Bogen (siehe useArcMotion): Die
    // Schleife kehrt nicht um (`false`), sie springt zurück. Eine Kurve, die zum
    // Ende abbremst und am Anfang anläuft, erzeugt dabei je eine halbe Sekunde
    // Stillstand pro Zyklus.
    t.value = withRepeat(
      withTiming(1, { duration: 3400, easing: Easing.linear }),
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
    <View style={{ width: SCENE_W, height: SCENE_H, marginBottom: BOTTOM_LIFT * 2 }}>
      {/* Bo ist der Blickfang — er gehört auf die Mitte, nicht die Sprechblase.
          Darum hängt die Gruppe UNTEN (bottom-verankert) und die Blase wächst
          nach OBEN aus ihr heraus.

          Vorher war der Stapel top-verankert: Die Blase wuchs nach unten und
          schob Bo vor sich her — je länger der Text, desto tiefer saß er. Genau
          deshalb wirkte er nur in DIESER Szene zu tief (die anderen haben keine
          Sprechblase über ihm). Und mit den Übersetzungen wäre es je nach Sprache
          unterschiedlich schlimm geworden: „Accroche-toi — direction Lisbonne!"
          bricht anders um als der deutsche Satz.

          Jetzt steht Bo fest, egal wie hoch die Blase wird. */}
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
        <Text style={[styles.code, { left: 0, color: "#8E8E93" }]}>{t("loader.from")}</Text>
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

const styles = scaledStyles({
  stack: {
    position: "absolute",
    // Bottom-verankert: Bo (letztes Kind) sitzt fest über der Routen-Linie, die
    // Blase wächst nach oben. Damit hängt Bos Höhe NICHT mehr an der Textlänge.
    bottom: 44,
    left: 0,
    right: 0,
    alignItems: "center",
    // Fester Abstand Blasenspitze → Bos Kopf. Sie gehören zusammen.
    gap: 6,
  },
  bubbleTxt: {
    color: "#F4F4F5",
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
    backgroundColor: "#212123",
  },
  code: { position: "absolute", top: 5, fontSize: 11, fontWeight: "700" },
});
