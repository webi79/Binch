/**
 * Die Aufnahme als Blatt — statt des Kastens über der Eingabezeile
 * (03.11.2026). Fläche, Rundung, Scrim und Tempo wie die übrigen Blätter. Die
 * Eingabezeile bleibt, wo sie ist (sie fährt nicht mehr hinunter); das Blatt
 * legt sich darüber.
 *
 * Kommt die Aufnahme aus dem Berechtigungs-Blatt, ist jenes schon auf genau
 * diese Höhe zusammengefahren. Dann steht dieses sofort (`instant`) und gibt
 * jenem zwei Bilder später per `releasePrimer` das Zeichen zu verschwinden —
 * der Tausch ist unsichtbar, beide sehen gleich aus.
 *
 * Der Scrim nimmt keine Tipps an: Ein Tipp daneben darf keine Aufnahme
 * verwerfen. Beendet wird über die Knöpfe im Blatt.
 *
 * Die Fahrt (04.11.2026): weich wie das Berechtigungs-Blatt (`softSheetMotion`,
 * nur die eigene Höhe), und der Inhalt fährt MIT — er wird einen Frame vor dem
 * Start eingehängt, dann erst fährt das Blatt. Vorher fuhr ein leeres Blatt
 * hoch und die Elemente kamen hinterher.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { softSheetMotion } from "@/lib/nav/overlayCover";
import { releasePrimer } from "@/lib/permissions/primer";
import { usePalette } from "@/lib/theme/appBg";

const SHEET_RADIUS = 28;

export function VoiceSheet({
  open,
  instant,
  height,
  children,
}: {
  open: boolean;
  /** Aus dem Berechtigungs-Blatt heraus: ohne Einfahrt, das andere steht schon hier. */
  instant: boolean;
  height: number;
  children: ReactNode;
}) {
  const palette = usePalette();
  const motion = useMemo(() => softSheetMotion(height), [height]);
  const y = useSharedValue(height);
  /** Nur beim Tausch aus dem Berechtigungs-Blatt: der Inhalt blendet über, das Blatt steht ja schon. */
  const fade = useSharedValue(1);
  /**
   * Der Inhalt bleibt während der Ausfahrt stehen und geht erst danach. Als
   * Ablage statt Zustand: Ein eigener Durchgang beim Öffnen fiele genau auf den
   * Start der Einfahrt.
   */
  const keepRef = useRef(false);
  if (open) keepRef.current = true;
  const [, rerender] = useState(0);
  const dropContent = useCallback(() => {
    keepRef.current = false;
    rerender((n) => n + 1);
  }, []);

  useEffect(() => {
    if (open) {
      cancelAnimation(y);
      if (instant) {
        y.value = 0;
        fade.value = 0;
        fade.value = withTiming(1, { duration: 200 });
        // Zwei Bilder: Erst steht dieses Blatt, dann geht das andere.
        let second = 0;
        const first = requestAnimationFrame(() => {
          second = requestAnimationFrame(releasePrimer);
        });
        return () => {
          cancelAnimationFrame(first);
          cancelAnimationFrame(second);
        };
      }
      fade.value = 1;
      // Ein Bild Vorlauf: Der Inhalt hängt dann schon, die Fahrt hat den Strang für sich.
      const id = requestAnimationFrame(() => {
        y.value = withTiming(0, motion.in);
      });
      return () => cancelAnimationFrame(id);
    }
    // Öffnet es vorher wieder, bricht `cancelAnimation` die Fahrt ab — dann bleibt der Inhalt.
    y.value = withTiming(height, motion.out, (finished) => {
      if (finished) runOnJS(dropContent)();
    });
    // Gefahren wird nur beim Öffnen und Schließen; `instant` gilt fürs Öffnen,
    // `height` ändert sich nur mit der sicheren Fläche.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const content = useAnimatedStyle(() => ({ opacity: fade.value }));
  const scrim = useAnimatedStyle(() => ({ opacity: 1 - y.value / height }));
  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.scrim, scrim]} />
      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        style={[styles.sheet, { height, backgroundColor: palette.s1 }, sheet]}
      >
        <Animated.View style={[styles.fill, content]}>{open || keepRef.current ? children : null}</Animated.View>
      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: "rgba(0,0,0,0.6)" },
  fill: { flex: 1 },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
  },
});
