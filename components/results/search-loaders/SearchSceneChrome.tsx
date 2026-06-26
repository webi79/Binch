/**
 * Geteilte SVG-Bausteine + Hooks für die 4 Search-Loader-Szenen.
 *
 * KEIN SearchScreen-Wrapper hier — die Szenen werden in den bestehenden
 * Results-Screen unter die Such-Kriterien-Box gerendert, nicht fullscreen.
 *
 * Farben kommen aus useAccent() statt fest verdrahtetem Lime — passt sich
 * dem aktuellen User-Theme an.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path, Circle, Line, Ellipse, G } from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  cancelAnimation,
  interpolate,
  Easing,
  type SharedValue,
} from "react-native-reanimated";

export const SCENE_W = 300;
export const SCENE_H = 240;
export const ARC = { x0: 30, y0: 170, cx: 150, cy: 40, x1: 270, y1: 170 };

/** Wenn true, halten alle Scene-Animationen ihre Worklet-Initialisierung
 *  zurück bis der Wert wieder false wird. Genutzt vom Results-Screen damit
 *  die Loader-Bilder schon WÄHREND des Slide-In's gerendert sind, aber die
 *  Reanimated-Worklets erst NACH dem Slide loslegen — sonst konkurrieren
 *  Slide-Worklet und Scene-Worklets um die UI-Thread-Zeit. */
export const LoaderPausedContext = createContext<boolean>(false);
export function useLoaderPaused(): boolean {
  return useContext(LoaderPausedContext);
}

const C = {
  surface2: "#242425",
  surface4: "#323234",
  border: "#2E2E30",
  text: "#FFFFFF",
  textTertiary: "#8A8A90",
  ink: "#1A1A1A",
  ghostBodyBottom: "#E9ECEC",
};

/** 0→1 Loop entlang des Routenbogens. */
export function useArcMotion(duration = 5000): SharedValue<number> {
  const paused = useLoaderPaused();
  const p = useSharedValue(0);
  useEffect(() => {
    if (paused) return;
    p.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
    return () => cancelAnimation(p);
  }, [duration, paused]);
  return p;
}

/** Style-Hook für ein Element das den Bogen entlangfliegt.
 *  anchorX/Y = Punkt im Element der auf der Linie sitzt. */
export function useArcStyle(p: SharedValue<number>, anchorX: number, anchorY: number) {
  return useAnimatedStyle(() => {
    const t = p.value;
    const mt = 1 - t;
    const x = mt * mt * ARC.x0 + 2 * mt * t * ARC.cx + t * t * ARC.x1;
    const y = mt * mt * ARC.y0 + 2 * mt * t * ARC.cy + t * t * ARC.y1;
    const opacity = interpolate(t, [0, 0.1, 0.9, 1], [0, 1, 1, 0]);
    return {
      opacity,
      transform: [{ translateX: x - anchorX }, { translateY: y - anchorY }],
    };
  });
}

/** Papierflieger in Akzent-Farbe. */
export function PaperPlane({
  size = 100,
  light,
  main,
  dark,
}: {
  size?: number;
  light: string;
  main: string;
  dark: string;
}) {
  return (
    <Svg width={size} height={size * 0.6} viewBox="0 0 100 60">
      <Path d="M4,9 L96,30 L24,30 Z" fill={main} />
      <Path d="M4,51 L96,30 L24,30 Z" fill={dark} />
      <Path d="M24,30 L96,30 L40,38 Z" fill={light} />
    </Svg>
  );
}

/** Kescher für den Deal-Hunter. */
export function CatchNet({ size = 96, accent }: { size?: number; accent: string }) {
  return (
    <Svg width={size} height={size * 1.15} viewBox="0 0 110 126">
      <Path
        d="M64,70 L100,116"
        stroke={C.ghostBodyBottom}
        strokeWidth={6}
        strokeLinecap="round"
      />
      <Circle cx={64} cy={70} r={4.5} fill={C.ghostBodyBottom} />
      <Path
        d="M11,44 Q34,108 55,100 Q76,108 95,44 Z"
        fill="rgba(255,255,255,0.04)"
        stroke={accent}
        strokeWidth={1.4}
        opacity={0.55}
      />
      <G stroke={accent} strokeWidth={1.2} opacity={0.4} fill="none">
        <Path d="M30,46 Q34,82 49,92" />
        <Path d="M53,46 Q53,84 53,96" />
        <Path d="M76,46 Q72,82 58,92" />
      </G>
      <Ellipse
        cx={53}
        cy={44}
        rx={42}
        ry={15}
        fill="rgba(255,255,255,0.04)"
        stroke={accent}
        strokeWidth={4.5}
      />
    </Svg>
  );
}

export function MapPin({ size = 26, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size * 1.3} viewBox="0 0 26 34">
      <Path
        d="M13,1 C6,1 1,6 1,13 C1,22 13,33 13,33 C13,33 25,22 25,13 C25,6 20,1 13,1 Z"
        fill={color}
        stroke={C.ink}
        strokeWidth={1.2}
      />
      <Circle cx={13} cy={13} r={4.6} fill={C.ink} />
    </Svg>
  );
}

export function Sun({ size = 64, accent }: { size?: number; accent: string }) {
  const rays = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <Svg width={size} height={size} viewBox="0 0 80 80">
      <G stroke={accent} strokeWidth={3.4} strokeLinecap="round">
        {rays.map((a) => {
          const r = (a * Math.PI) / 180;
          return (
            <Line
              key={a}
              x1={40 + Math.cos(r) * 26}
              y1={40 + Math.sin(r) * 26}
              x2={40 + Math.cos(r) * 34}
              y2={40 + Math.sin(r) * 34}
            />
          );
        })}
      </G>
      <Circle cx={40} cy={40} r={19} fill={accent} />
      <Circle cx={40} cy={40} r={12} fill="rgba(255,255,255,0.85)" />
    </Svg>
  );
}

export function Cloud({ w = 84 }: { w?: number }) {
  return (
    <Svg width={w} height={w * 0.5} viewBox="0 0 70 35">
      <G fill="rgba(255,255,255,0.06)">
        <Circle cx={20} cy={22} r={13} />
        <Circle cx={36} cy={16} r={16} />
        <Circle cx={52} cy={23} r={12} />
      </G>
    </Svg>
  );
}

export function DealChip({
  code,
  badgeColor,
  label,
  accent,
}: {
  code?: string;
  badgeColor?: string;
  label: string;
  accent: string;
}) {
  return (
    <View style={styles.chip}>
      {code ? (
        <View style={[styles.chipCode, { backgroundColor: badgeColor || C.surface4 }]}>
          <Text style={styles.chipCodeTxt}>{code}</Text>
        </View>
      ) : (
        <View style={[styles.chipDot, { backgroundColor: accent }]} />
      )}
      <Text style={[styles.chipLabel, { color: accent }]}>{label}</Text>
    </View>
  );
}

export function WeatherChip({
  temp,
  place,
  cond,
  accent,
}: {
  temp: string;
  place: string;
  cond: string;
  accent: string;
}) {
  return (
    <View style={styles.weather}>
      <Sun size={22} accent={accent} />
      <Text style={styles.weatherTemp}>{temp}</Text>
      <Text style={styles.weatherMeta}>
        {place} · {cond}
      </Text>
    </View>
  );
}

export function SpeechBubble({
  children,
  maxWidth = 236,
}: {
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <View style={[styles.bubble, { maxWidth }]}>
      {children}
      <View style={styles.bubbleTail} />
    </View>
  );
}

/** Rotierende Sprüche-Zeile. */
export function SpruecheLine({ items }: { items: string[] }) {
  const paused = useLoaderPaused();
  const [i, setI] = useState(0);
  const op = useSharedValue(1);
  useEffect(() => {
    if (paused) return;
    let to: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      op.value = withTiming(0, { duration: 240 });
      to = setTimeout(() => {
        setI((p) => (p + 1) % items.length);
        op.value = withTiming(1, { duration: 300 });
      }, 260);
    }, 2100);
    return () => {
      clearInterval(id);
      if (to) clearTimeout(to);
    };
  }, [items.length, paused]);
  const style = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.Text style={[styles.sprueche, style]} numberOfLines={2}>
      {items[i]}
    </Animated.Text>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 99,
    paddingVertical: 5,
    paddingLeft: 5,
    paddingRight: 11,
    alignSelf: "flex-start",
  },
  chipCode: {
    width: 20,
    height: 20,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  chipCodeTxt: { color: C.text, fontSize: 9, fontWeight: "800" },
  chipDot: { width: 9, height: 9, borderRadius: 5, marginLeft: 4 },
  chipLabel: { fontWeight: "800", fontSize: 13 },
  weather: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 99,
    paddingVertical: 7,
    paddingLeft: 9,
    paddingRight: 13,
    alignSelf: "flex-start",
  },
  weatherTemp: { color: C.text, fontWeight: "800", fontSize: 14 },
  weatherMeta: { color: C.textTertiary, fontSize: 12 },
  bubble: {
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  bubbleTail: {
    position: "absolute",
    bottom: -7,
    left: "50%",
    marginLeft: -7,
    width: 14,
    height: 14,
    backgroundColor: C.surface2,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: C.border,
    transform: [{ rotate: "45deg" }],
  },
  sprueche: {
    textAlign: "center",
    color: C.text,
    fontWeight: "700",
    fontSize: 15,
    lineHeight: 20,
    minHeight: 22,
    letterSpacing: -0.3,
    paddingHorizontal: 16,
  },
});
