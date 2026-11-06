/**
 * Strichzeichnungen — die Bildsprache der Berechtigungs-Blätter, für die ganze
 * App (04.11.2026: „diese gezeichneten Animationen … dezent einsetzen, anstatt
 * überall einfach Bo hinzuklatschen"). Einfarbig im Akzent, ein blasses
 * Nebenelement, Strich 6 im 200er-Raster, runde Enden.
 *
 * WIE SIE SICH ZEICHNEN — und warum nicht über den Strich selbst:
 * `react-native-svg` rastert auf Android bei JEDER Änderung die ganze Fläche
 * neu in ein frisches Bitmap (`SvgView.invalidate` → `drawOutput` →
 * `Bitmap.createBitmap`), und eine animierte SVG-Eigenschaft geht auf Fabric
 * außerdem über einen Commit des ganzen Baums. Ein über `strokeDashoffset`
 * gezeichnetes Bild kostete damit in jedem Bild einen Commit plus ein neues
 * ~1-MB-Bitmap — genau im Tab-Wechsel und im Gleiten Trips → Tickets:
 * „das hat gelaggt, das war vorher noch nie" (04.11.2026).
 *
 * Jetzt liegt jeder Strich in einer EIGENEN kleinen Fläche (nur so groß wie
 * er selbst), die genau einmal gerastert wird. Aufgedeckt wird er mit einer
 * Wischblende in Zeichenrichtung: Eine Hülle mit `overflow: hidden` fährt über
 * ihn, der Inhalt fährt gegenläufig und steht dadurch still — nur Lage und
 * Drehung, der schnelle Weg auf dem UI-Strang. Kein Commit, kein Neurastern.
 * (Dieselbe Technik wie die gleitende Pille in `SheetTabs`.)
 *
 * EINMAL GESTARTET, LÄUFT ES ZU ENDE („Animationen sollen immer mindestens
 * einmal ausgeführt werden, die werden nicht unterbrochen"): `play` startet,
 * ein späteres `false` hält nichts mehr an. Danach steht alles still und
 * kostet nichts — auch wenn die Fläche unsichtbar eingehängt bleibt.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type EasingFunction,
  type EasingFunctionFactory,
} from "react-native-reanimated";
import Svg from "react-native-svg";

export const ART_STROKE = 6;
/** Das blasse Nebenelement jeder Zeichnung — wie Googles grauer Bogen. */
export const ART_FAINT = "rgba(255,255,255,0.16)";
/** Zeichnen: anfahren, zügig, auslaufen. Feste Größen — am Ort gebaut startete jeder Render die Animation neu. */
const DRAW_EASE = Easing.inOut(Easing.cubic);
const POP_EASE = Easing.out(Easing.quad);

/** Ein Ausschnitt des 200er-Rasters: [x, y, Breite, Höhe] — Rand für den halben Strich schon drin. */
export type ArtBox = readonly [number, number, number, number];

/**
 * 0 → 1, sobald `play` zum ersten Mal gilt — danach nicht mehr anzuhalten
 * (nur das Aushängen bricht ab).
 */
function useOnceProgress(play: boolean, delay: number, duration: number, easing: EasingFunction | EasingFunctionFactory) {
  const p = useSharedValue(0);
  const started = useRef(false);
  useEffect(() => {
    if (!play || started.current) return;
    started.current = true;
    p.value = withDelay(delay, withTiming(1, { duration, easing }));
  }, [play, p, delay, duration, easing]);
  useEffect(() => () => cancelAnimation(p), [p]);
  return p;
}

/**
 * Ein Strich (oder wenige zusammen) in seiner eigenen Fläche, aufgedeckt mit
 * einer Wischblende. `angle` = Richtung der Blende in Grad (0 = von links nach
 * rechts, 90 = von oben nach unten, −40 = nach rechts oben).
 *
 * Die Hülle ist ein Quadrat über die Diagonale der Fläche, gedreht um
 * `angle`: So deckt eine Verschiebung um ihre Kantenlänge die Fläche in jeder
 * Richtung vollständig zu bzw. auf. Drehpunkt ist die Mitte beider Ansichten
 * (Standard), also heben sich Drehung und Verschiebung für den Inhalt auf.
 */
export function RevealLayer({
  k,
  box,
  angle = 0,
  play,
  delay,
  duration,
  children,
}: {
  /** Punkte je Rastereinheit. */
  k: number;
  box: ArtBox;
  angle?: number;
  play: boolean;
  delay: number;
  duration: number;
  children: ReactNode;
}) {
  const [bx, by, bw, bh] = box;
  const w = bw * k;
  const h = bh * k;
  const d = Math.ceil(Math.hypot(w, h)) + 2;
  const p = useOnceProgress(play, delay, duration, DRAW_EASE);
  const hull = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle}deg` }, { translateX: -d * (1 - p.value) }],
  }));
  const inner = useAnimatedStyle(() => ({
    transform: [{ translateX: d * (1 - p.value) }, { rotate: `${-angle}deg` }],
  }));
  return (
    <Animated.View
      style={[
        styles.abs,
        styles.clip,
        { left: bx * k + w / 2 - d / 2, top: by * k + h / 2 - d / 2, width: d, height: d },
        hull,
      ]}
    >
      <Animated.View style={[styles.abs, { left: d / 2 - w / 2, top: d / 2 - h / 2, width: w, height: h }, inner]}>
        <Svg width={w} height={h} viewBox={`${bx} ${by} ${bw} ${bh}`}>
          {children}
        </Svg>
      </Animated.View>
    </Animated.View>
  );
}

/** Ein kleines Teil (Punkt, Loch), das einblendet und dabei auf volle Größe wächst — um seine Mitte. */
export function FadeLayer({
  k,
  box,
  play,
  delay,
  duration = 240,
  from = 0.6,
  children,
}: {
  k: number;
  box: ArtBox;
  play: boolean;
  delay: number;
  duration?: number;
  /** Größe am Anfang (Anteil). */
  from?: number;
  children: ReactNode;
}) {
  const [bx, by, bw, bh] = box;
  const w = bw * k;
  const h = bh * k;
  const p = useOnceProgress(play, delay, duration, POP_EASE);
  const style = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ scale: from + (1 - from) * p.value }],
  }));
  return (
    <Animated.View style={[styles.abs, { left: bx * k, top: by * k, width: w, height: h }, style]}>
      <Svg width={w} height={h} viewBox={`${bx} ${by} ${bw} ${bh}`}>
        {children}
      </Svg>
    </Animated.View>
  );
}

/** Strich-Eigenschaften der Zeichnungen — für jeden `Path` darin gleich. */
export const STROKE_PROPS = {
  strokeWidth: ART_STROKE,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const styles = StyleSheet.create({
  abs: { position: "absolute" },
  clip: { overflow: "hidden" },
});
