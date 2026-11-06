/**
 * Der Ladezustand der App — „Grid" von uiball (ldrs 1.1.9), vom Nutzer
 * ausgesucht (04.11.2026), nach React Native übertragen.
 *
 * Sechzehn Punkte in einem schrägen 4 × 4-Raster (wie von oben auf eine
 * Fläche geschaut); jeder springt auf und ab, die Diagonalen um je 0,08 Takte
 * versetzt — so läuft eine Welle über die Fläche. Hintere Punkte sind eine
 * Spur kleiner und blasser (Tiefe, 0,82 … 1).
 *
 * Werte 1:1 aus dem Original (`Grid.css`): Rahmen `size` × 0,8·`size`,
 * Raster 0,64·`size`, Punkt 0,1·`size`, Lagen als `bottom`/`right` in Prozent
 * des Rasters plus halber Punkt, Sprung ±120 % der Punktgröße mit CSS-
 * `ease-in-out` (cubic-bezier 0.42, 0, 0.58, 1) je Halbtakt, Takt 1,5 s,
 * negative Startverzögerungen = Vorlauf im Takt.
 *
 * LEISTUNG („smooth, immer"): EIN Takt auf dem UI-Strang, jeder Punkt
 * verschiebt nur seine Lage — der schnelle Weg, kein Commit, kein Neuzeichnen
 * eines SVG. Läuft weiter, auch wenn JS gerade beschäftigt ist (Antwort wird
 * verarbeitet, Liste gebaut).
 *
 * Wann er erscheint und wie lange er mindestens läuft, regelt `LoadGate`
 * (erst nach 2 s, dann mindestens zwei volle Durchläufe, weich hinaus —
 * Nutzerwunsch 04.11.2026). Er selbst blendet nur kurz ein.
 * `active={false}` hält ihn an (z. B. in einer geschlossenen Schublade).
 */
import { useEffect } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { ms } from "@/lib/ui/compact";

/**
 * Je Punkt: [bottom %, right %, Vorlauf (Anteil des Takts), Tiefe] — in der
 * Reihenfolge des Originals (spätere liegen oben). Punkt 4 hat dort keine
 * Tiefe gesetzt und ist damit der vorderste (1).
 */
const DOTS: readonly (readonly [number, number, number, number])[] = [
  [24, -35, 0.48, 0.94],
  [16, -6, 0.4, 0.96],
  [8, 23, 0.32, 0.98],
  [-1, 51, 0.24, 1],
  [38, -17.5, 0.4, 0.9],
  [30, 10, 0.32, 0.92],
  [22, 39, 0.24, 0.94],
  [14, 67, 0.16, 0.96],
  [53, -0.8, 0.32, 0.86],
  [44.5, 27, 0.24, 0.88],
  [36, 55.7, 0.16, 0.9],
  [28.7, 84.3, 0.08, 0.92],
  [66.8, 15, 0.24, 0.82],
  [58.8, 43, 0.16, 0.84],
  [50, 72, 0.08, 0.86],
  [42, 100, 0, 0.88],
];
/** Sprung in Punktgrößen: von +1,2 (unten) nach −1,2 (oben) und zurück. */
const JUMP = 1.2;
/** Ein Durchlauf (Standard-`speed`) — `LoadGate` lässt ihn nur an dessen Ende enden. */
export const GRID_CYCLE_MS = 1500;

/** CSS `ease-in-out` = cubic-bezier(0.42, 0, 0.58, 1) — x nach t (Newton), dann y. */
function cssEaseInOut(x: number): number {
  "worklet";
  let t = x;
  for (let i = 0; i < 6; i++) {
    const u = 1 - t;
    const err = 3 * u * u * t * 0.42 + 3 * u * t * t * 0.58 + t * t * t - x;
    if (Math.abs(err) < 1e-4) break;
    // Ableitung nach t — auf [0, 1] überall positiv (1,26u² + 0,96ut + 1,26t²).
    t -= err / (1.26 * u * u + 0.96 * u * t + 1.26 * t * t);
  }
  const u = 1 - t;
  return 3 * u * t * t + t * t * t;
}

export function GridLoader({
  size = 60,
  speed = GRID_CYCLE_MS / 1000,
  color,
  active = true,
  style,
}: {
  /** Kantenlänge wie im Original (`size`, vor `ms`); die Höhe ist 0,8 davon. */
  size?: number;
  /** Sekunden je Takt. */
  speed?: number;
  /** Standard: der Akzent. */
  color?: string;
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useT();
  const accent = useAccent().solid;
  const fill = color ?? accent;
  const s = ms(size);
  const h = s * 0.8;
  const grid = s * 0.64;
  const dot = s * 0.1;

  /** 0 → 1 je Takt, linear; die Kurve rechnet jeder Punkt selbst. */
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!active) {
      cancelAnimation(clock);
      return;
    }
    clock.value = 0;
    clock.value = withRepeat(withTiming(1, { duration: speed * 1000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(clock);
  }, [active, clock, speed]);

  const shown = useSharedValue(0);
  useEffect(() => {
    shown.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) });
    return () => cancelAnimation(shown);
  }, [shown]);
  const wrap = useAnimatedStyle(() => ({ opacity: shown.value }));

  return (
    <Animated.View
      style={[{ width: s, height: h }, wrap, style]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t("results.loading")}
      pointerEvents="none"
    >
      {DOTS.map(([bottom, right, lead, depth], i) => {
        // Mitte des Punktes im Rahmen: Raster mittig, Lage von unten rechts.
        const cx = (s - grid) / 2 + grid - (right / 100) * grid - dot;
        const cy = (h - grid) / 2 + grid - (bottom / 100) * grid - dot;
        return (
          <GridDot key={i} cx={cx} cy={cy} dot={dot} lead={lead} depth={depth} color={fill} clock={clock} />
        );
      })}
    </Animated.View>
  );
}

function GridDot({
  cx,
  cy,
  dot,
  lead,
  depth,
  color,
  clock,
}: {
  cx: number;
  cy: number;
  dot: number;
  lead: number;
  depth: number;
  color: string;
  clock: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const ph = (clock.value + lead) % 1;
    const y = ph < 0.5 ? JUMP - 2 * JUMP * cssEaseInOut(ph * 2) : -JUMP + 2 * JUMP * cssEaseInOut((ph - 0.5) * 2);
    return { transform: [{ translateY: y * dot }] };
  });
  // Tiefe wie im Original: Kreis um seine Mitte verkleinert, Punkt blasser.
  const d = dot * depth;
  return (
    <Animated.View style={[styles.dot, { left: cx - d / 2, top: cy - d / 2, opacity: depth }, style]}>
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: color }} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dot: { position: "absolute" },
});
