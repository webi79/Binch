/**
 * Vögel (Tag/Morgen) und kleine Bo-Geister (Nacht) die über den Hero
 * fliegen. Reanimated UI-Thread mit EINEM useAnimatedStyle pro Creature.
 *
 * Architektur:
 *  - Jedes Creature ist eine Reanimated.View, absolut positioniert
 *  - EIN useAnimatedStyle pro Creature, kombiniert alle Transforms in
 *    einem Worklet (translateX + ggf. scaleY für Wing-Flap)
 *  - Statisches SVG-Sprite inside, kein Animated-SVG-Prop
 *  - paused=true → null return, alle Worklets weg
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  Ellipse,
  LinearGradient,
  Path,
  Stop,
} from "react-native-svg";

export type CreatureKind = "bird" | "ghost";

interface Props {
  kind: CreatureKind;
  paused?: boolean;
  /** Y-Position in Container-DP wo der Schwarm fliegen soll (Sun/Moon-
   *  Höhe). Default 95 (passt für Tag/Nacht in einem typischen Container). */
  centerY?: number;
}

interface CreatureSpec {
  id: string;
  startX: number;
  endX: number;
  y: number;
  durationMs: number;
  delayMs: number;
  scale: number;
}

export function BinchCreatures({ kind, paused = false, centerY = 95 }: Props) {
  const { width: screenW } = useWindowDimensions();
  const creatures = useMemo(
    () => spawnCreatures(kind, screenW, centerY),
    [kind, screenW, centerY],
  );

  // Bei paused NICHT unmounten — sonst trägt der erste Tap die Kosten der
  // 2-3 Animated.View-Destructions. Stattdessen Wrapper unsichtbar
  // machen, Children selbst entscheiden ob sie ihre Animation stoppen.
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        opacity: paused ? 0 : 1,
      }}
    >
      {creatures.map((c) =>
        kind === "bird" ? (
          <Bird key={c.id} spec={c} paused={paused} />
        ) : (
          <Ghost key={c.id} spec={c} paused={paused} />
        ),
      )}
    </View>
  );
}

function spawnCreatures(
  kind: CreatureKind,
  screenW: number,
  centerY: number,
): CreatureSpec[] {
  const count = 2 + Math.floor(Math.random() * 2); // 2..3
  // Alle in dieselbe Richtung (Schwarm-Optik).
  const flockDirection: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const out: CreatureSpec[] = [];
  for (let i = 0; i < count; i++) {
    // Y direkt auf Sun/Moon-Höhe mit kleiner Streuung. So fliegen die
    // Vögel/Geister auf gleicher Linie wie die Sonne/Mond.
    const y = centerY + (Math.random() - 0.5) * 20; // ±10 dp
    const startX = flockDirection === 1 ? -60 : screenW + 60;
    const endX = flockDirection === 1 ? screenW + 60 : -60;
    const durationMs = 9000 + Math.random() * 4000; // 9..13s
    // Weiter auseinander damit sie nicht im Pulk fliegen — der erste
    // ist schon halbwegs durch wenn der nächste startet.
    const delayMs = i * 1200 + Math.random() * 800;
    const scale = kind === "bird" ? 1.0 + Math.random() * 0.5 : 0.9 + Math.random() * 0.4;
    out.push({
      id: `${kind}-${i}-${Math.random().toString(36).slice(2, 8)}`,
      startX,
      endX,
      y,
      durationMs,
      delayMs,
      scale,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bird
// ---------------------------------------------------------------------------

const BIRD_W = 36;
const BIRD_H = 22;

function Bird({ spec, paused }: { spec: CreatureSpec; paused: boolean }) {
  const tx = useSharedValue(spec.startX);
  const wing = useSharedValue(0);

  useEffect(() => {
    if (paused) {
      // Bei paused Animationen stoppen (aber View bleibt mounted für
      // Cheap toggling). Werte bleiben wo sie waren.
      cancelAnimation(tx);
      cancelAnimation(wing);
      return;
    }
    tx.value = withDelay(
      spec.delayMs,
      withTiming(spec.endX, { duration: spec.durationMs, easing: Easing.linear }),
    );
    wing.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }),
        withTiming(0, { duration: 500, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(tx);
      cancelAnimation(wing);
    };
  }, [tx, wing, spec, paused]);

  // EIN Worklet: liest beide Shared Values, returnt eine kombinierte
  // Transform-Liste. Reanimated v4 + Fabric handhabt das zuverlässig.
  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { scaleY: 0.55 + wing.value * 0.45 },
    ],
  }));

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          top: spec.y,
          left: 0,
          width: BIRD_W * spec.scale,
          height: BIRD_H * spec.scale,
        },
        animStyle,
      ]}
    >
      <Svg
        width={BIRD_W * spec.scale}
        height={BIRD_H * spec.scale}
        viewBox={`-${BIRD_W / 2} -${BIRD_H / 2} ${BIRD_W} ${BIRD_H}`}
      >
        <Path
          d="M -14 0 Q -7 -8 0 0 Q 7 -8 14 0"
          stroke="#0A0A0A"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Ghost — Mini-Bo mit den echten Bo-Body-Pfaden (statisch, ohne Reanimated).
// Form aus components/assistant/Bo.tsx kopiert: runde Kappe (Kreissegment),
// 4 wellige Zacken am Bottom-Saum, schwarze Pupillen-Ellipsen mit weißen
// Reflexen, grüne Wangen.
// ---------------------------------------------------------------------------

const GHOST_W = 36;
const GHOST_H = 42;
const GHOST_VB_W = 200; // Match Bo's viewBox X-Range
const GHOST_VB_H = 230; // Match Bo's viewBox Y-Range

function Ghost({ spec, paused }: { spec: CreatureSpec; paused: boolean }) {
  const tx = useSharedValue(spec.startX);

  useEffect(() => {
    if (paused) {
      cancelAnimation(tx);
      return;
    }
    tx.value = withDelay(
      spec.delayMs,
      withTiming(spec.endX, { duration: spec.durationMs, easing: Easing.linear }),
    );
    return () => {
      cancelAnimation(tx);
    };
  }, [tx, spec, paused]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

  const w = GHOST_W * spec.scale;
  const h = GHOST_H * spec.scale;
  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          top: spec.y,
          left: 0,
          width: w,
          height: h,
        },
        animStyle,
      ]}
    >
      <Svg width={w} height={h} viewBox={`0 0 ${GHOST_VB_W} ${GHOST_VB_H}`}>
        <Defs>
          <LinearGradient
            id="ghostBody"
            x1="100"
            y1="40"
            x2="100"
            y2="220"
            gradientUnits="userSpaceOnUse"
          >
            <Stop offset="0" stopColor="#FFFFFF" />
            <Stop offset="1" stopColor="#E9ECEC" />
          </LinearGradient>
        </Defs>
        {/* Bo-Body — runde Kappe oben + wellige Zacken am Saum unten. */}
        <Path
          d="M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z"
          fill="url(#ghostBody)"
        />
        {/* Augen — schwarze Pupillen mit weißen Reflexen. */}
        <Ellipse cx={76} cy={120} rx={16} ry={21} fill="#1a1a1a" />
        <Ellipse cx={124} cy={120} rx={16} ry={21} fill="#1a1a1a" />
        <Circle cx={82} cy={112} r={5.5} fill="#FFFFFF" />
        <Circle cx={130} cy={112} r={5.5} fill="#FFFFFF" />
        <Circle cx={71} cy={126} r={2.6} fill="#FFFFFF" opacity={0.7} />
        <Circle cx={119} cy={126} r={2.6} fill="#FFFFFF" opacity={0.7} />
        {/* Wangen — grüner Akzent wie beim großen Bo. */}
        <Ellipse cx={56} cy={150} rx={13} ry={7.5} fill="#7FEA4D" opacity={0.55} />
        <Ellipse cx={144} cy={150} rx={13} ry={7.5} fill="#7FEA4D" opacity={0.55} />
        {/* Idle-Mund — leichtes Lächeln. */}
        <Path
          d="M89 150 Q100 159 111 150"
          stroke="#1a1a1a"
          strokeWidth={5}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  );
}

export function useCreaturesLifetime(lifetimeMs = 18000): boolean {
  const [alive, setAlive] = useState(true);
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const id = setTimeout(() => setAlive(false), lifetimeMs);
    return () => clearTimeout(id);
  }, [lifetimeMs]);
  return alive;
}
