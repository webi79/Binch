import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, type StyleProp, type ViewStyle } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";

/**
 * EIN Bewegungs-Vokabular für die ganze App.
 *
 * Ohne das erfindet jeder Screen sein eigenes Timing, und die App fühlt sich
 * zusammengestückelt an — mal springt etwas, mal kriecht es. Die Werte hier sind
 * nicht geraten:
 *
 *   - 200-400 ms ist das Fenster, in dem Bewegung als REAKTION gelesen wird.
 *     Darunter wirkt sie abrupt, darüber hält sie auf.
 *   - Der Versatz zwischen zwei Elementen (~60-80 ms) erzeugt die Welle: Das
 *     Auge kann folgen, statt eine fertige Wand zu sehen. Genau das meint
 *     „nicht einfach aufploppen".
 *   - Der Weg nach oben bleibt klein (12 px). Elemente sollen sich SETZEN, nicht
 *     hereinfliegen — eine große Strecke liest sich als Effekt, eine kleine als
 *     Materialität.
 *
 * Die Kurve ist dieselbe wie bei den Push-Transitions (lib/nav/overlayCover.ts,
 * an YouTube nachgemessen): zügig an, langer weicher Auslauf.
 */
export const MOTION = {
  rise: 12,
  duration: 360,
  stagger: 60,
  /** Ab hier kein weiterer Versatz — sonst wartet das 20. Element 1,2 s. */
  maxSteps: 6,
  easing: Easing.bezier(0.05, 0.7, 0.1, 1),
} as const;

export function staggerDelay(index: number): number {
  return Math.min(Math.max(index, 0), MOTION.maxSteps) * MOTION.stagger;
}

/**
 * Systemeinstellung „Bewegung reduzieren".
 *
 * Wer sie gesetzt hat, tut das meist wegen Schwindel oder Migräne — für den ist
 * eine Kaskade keine Verspieltheit, sondern ein Problem. Dann erscheint alles
 * sofort, ohne Bewegung.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduce(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * Zählt hoch, sobald der Screen den Fokus BEKOMMT.
 *
 * Warum nicht einfach Reanimateds `entering`: Das feuert nur beim MOUNT. Die
 * Tabs bleiben aber gemountet (nur die Karte friert ein, siehe die
 * Freeze-Strategie in app/(tabs)/_layout.tsx) — beim Tab-Wechsel würde also nie
 * etwas animieren. Und die Views nur für die Animation zu remounten wäre teuer
 * und genau die Sorte Commit, die den Tab-Wechsel ruckeln lässt.
 *
 * Stattdessen bleiben die Views IMMER gemountet und wir triggern die Animation
 * über einen Shared Value neu. (Klassisches RN-Animated bleibt hier auf der New
 * Architecture am Startwert hängen — deshalb reanimated.)
 */
const EntranceContext = createContext(0);

export function ScreenEntrance({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (focused) setGeneration((g) => g + 1);
  }, [focused]);
  return <EntranceContext.Provider value={generation}>{children}</EntranceContext.Provider>;
}

interface RevealProps {
  children: ReactNode;
  /** Position in der Welle. 0 = zuerst. */
  index?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Blendet sein Kind gestaffelt ein: 12 px hochgleiten + aufblenden, versetzt um
 * `index × 60 ms`.
 *
 * Muss unter einem {@link ScreenEntrance} hängen — dann läuft die Welle bei
 * JEDEM Fokus des Screens neu, nicht nur beim ersten Mount.
 */
export function Reveal({ children, index = 0, style }: RevealProps) {
  const generation = useContext(EntranceContext);
  const reduceMotion = useReduceMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      staggerDelay(index),
      withTiming(1, { duration: MOTION.duration, easing: MOTION.easing }),
    );
  }, [generation, index, reduceMotion, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * MOTION.rise }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}

/**
 * Dieselbe Welle für Listen, die FRISCH mounten (Ergebnis-Screen).
 *
 * Dort ist Reanimateds `entering` genau richtig — die Liste entsteht neu, wir
 * brauchen keinen Fokus-Trigger. Wichtig ist nur, dass sie dasselbe Timing und
 * denselben kurzen Weg benutzt wie {@link Reveal}, sonst fühlt sich der
 * Ergebnis-Screen an wie eine andere App.
 *
 * `ReduceMotion.System`: Wer „Bewegung reduzieren" gesetzt hat, bekommt die
 * Elemente sofort.
 */
export function revealEntering(index: number) {
  return FadeInDown.delay(staggerDelay(index))
    .duration(MOTION.duration)
    .easing(MOTION.easing)
    .withInitialValues({ opacity: 0, transform: [{ translateY: MOTION.rise }] })
    .reduceMotion(ReduceMotion.System);
}
