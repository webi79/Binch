/**
 * SaveStarButton — exakte Portierung der „Variante 1a" Stern-Animation.
 *
 * Optik & Timing 1:1 aus der Design-Vorlage:
 *   POP (save): 640ms, cubic-bezier(.2,.8,.25,1)
 *     scale  0.30 → 1.45 → 0.90 → 1.06 → 1.00  (bei 0/45/68/85/100%)
 *     rotate -18° → 10° → -4° → 2° → 0°
 *     Gold-Stern 33px, Verlauf #FFF0BE→#FFC01F→#F39A12, Kontur #FFDE86
 *   FUNKEN: 15 Partikel, cubic-bezier(.2,.7,.3,1), pro Partikel:
 *     Distanz 36–88 · Größe 6–13 · Endscale 0.3–0.85 · Rot ±180° ·
 *     Delay 0–90ms · Dauer 600–900ms · 50% Funkel-Sterne / 50% Punkte
 *     save-Opacity 0/12/70/100% → 0/1/1/0 · unsave 0/25/100% → 0/1/0
 *
 * Engine: react-native-reanimated (UI-Thread, Fabric-nativ). Der klassische
 * RN-Animated-native-driver blieb auf dem New-Architecture-Stack hängen; die
 * animierten Views sind hier IMMER gemountet (Sichtbarkeit via Opacity), sodass
 * es keine Mount-Race gibt.
 *
 * Verwendung: <SaveStarButton saved={saved} onChange={(willSave) => ...} />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from "react-native-svg";
import { haptic } from "@/lib/haptics";
import { useAccent, type AccentPalette } from "@/lib/theme/accent";
import { subscribeSheetMoving } from "@/lib/nav/searchHandoff";
import { scaledStyles } from "@/lib/ui/compact";

// Stern-Pfad (viewBox 0 0 24 24)
const STAR_PATH =
  "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";
// Vierzackiger Funkel-Stern (CSS-clip-path 50/0 60/40 100/50 …)
const SPARKLE_PATH = "M12 0 L14.4 9.6 L24 12 L14.4 14.4 L12 24 L9.6 14.4 L0 12 L9.6 9.6 Z";

/**
 * Die Funken-Farben — abgeleitet aus dem gewählten Akzent, nicht mehr golden.
 *
 * Die Vorlage war in Gold gezeichnet, und Gold gehört zu keiner der beiden
 * Paletten der App. Der Stern gehörte damit als einziges Element nirgends dazu:
 * Wer auf Mint umstellt, bekam überall Mint — und hier weiter Gold.
 *
 * Die Palette hat genau die drei Stufen, die die Vorlage braucht (hell, Haupt,
 * dunkel), dazu die abgedunkelte Variante als vierte. Die Verteilung bleibt
 * damit dieselbe wie vorher: vier Töne desselben Farbtons, von hell nach satt.
 */
function sparkColors(accent: AccentPalette): string[] {
  return [accent.gradient[0], accent.gradient[1], accent.solid, accent.dark];
}
const SPARK_COUNT = 15;

// Easing-Kurven — exakt wie im CSS
const EASE_POP = Easing.bezier(0.2, 0.8, 0.25, 1); // bnc-pop-save
const EASE_SPARK = Easing.bezier(0.2, 0.7, 0.3, 1); // bnc-spark / bnc-spark-in

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Spark {
  tx: number;
  ty: number;
  scale: number;
  rot: string;
  color: string;
  size: number;
  star: boolean;
  delay: number;
  duration: number;
}

function makeSparks(colors: string[]): Spark[] {
  return Array.from({ length: SPARK_COUNT }, () => {
    const angle = Math.random() * Math.PI * 2;
    const dist = rand(36, 88);
    return {
      tx: Math.cos(angle) * dist,
      ty: Math.sin(angle) * dist,
      scale: rand(0.3, 0.85),
      rot: `${Math.round(rand(-180, 180))}deg`,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      size: rand(6, 13),
      star: Math.random() < 0.5,
      delay: Math.random() * 200,
      duration: rand(1300, 1800),
    };
  });
}

interface Props {
  size?: number;
  starSize?: number;
  saved?: boolean;
  onChange?: (saved: boolean) => void;
}

/** Ein Funke mit eigenem Progress-SharedValue — feuert seine exakte
 *  delay/duration/easing bei jedem Burst. Immer gemountet (fixe 15). */
function SparkView({
  spark,
  burstId,
  isSave,
  center,
}: {
  spark: Spark;
  burstId: number;
  isSave: boolean;
  center: number;
}) {
  const p = useSharedValue(0);

  useEffect(() => {
    if (burstId === 0) return; // noch kein Press
    p.value = 0;
    p.value = withDelay(spark.delay, withTiming(1, { duration: spark.duration, easing: EASE_SPARK }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burstId]);

  const style = useAnimatedStyle(() => {
    const t = p.value;
    // save: aus der Mitte nach außen; unsave: von außen ins Zentrum
    const prog = isSave ? t : 1 - t;
    const scale = isSave ? 0.2 + t * (spark.scale - 0.2) : spark.scale * (1 - t);
    const opacity = isSave
      ? interpolate(t, [0, 0.12, 0.7, 1], [0, 1, 1, 0], Extrapolation.CLAMP)
      : interpolate(t, [0, 0.25, 1], [0, 1, 0], Extrapolation.CLAMP);
    return {
      opacity,
      transform: [
        { translateX: spark.tx * prog },
        { translateY: spark.ty * prog },
        { scale },
        { rotate: spark.rot },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          left: center - spark.size / 2,
          top: center - spark.size / 2,
          width: spark.size,
          height: spark.size,
        },
        style,
      ]}
    >
      {spark.star ? (
        <Svg width={spark.size} height={spark.size} viewBox="0 0 24 24">
          <Path d={SPARKLE_PATH} fill={spark.color} />
        </Svg>
      ) : (
        <View
          style={{
            width: spark.size,
            height: spark.size,
            borderRadius: spark.size / 2,
            backgroundColor: spark.color,
          }}
        />
      )}
    </Animated.View>
  );
}

// Längster Funke: delay ≤200ms + duration ≤1800ms → nach 2100ms ist sicher
// alles vorbei und die Burst-Views können wieder unmounten.
const BURST_LIFETIME_MS = 2100;

export function SaveStarButton({ size = 46, starSize = 30, saved: savedProp, onChange }: Props) {
  const accent = useAccent();
  const [savedState, setSavedState] = useState(false);
  const saved = savedProp ?? savedState;

  const pop = useSharedValue(saved ? 1 : 0);
  const pressOrigin = useRef(false);

  // PERF: Funken (und der Gold-Stern bei nicht-gespeicherten Stationen) sind
  // NUR während eines aktiven Bursts gemountet. Die Komponente wird pro Zeile
  // in always-mounted Overlays (LocationPicker) gerendert — 15 Reanimated-
  // Views + SVG-Gradienten pro Instanz dauerhaft zu compositen bricht die
  // Framerate app-weit ein. Das Mounten passiert im selben Commit wie der
  // Press (lokaler State), und SharedValue-Animationen laufen unabhängig von
  // Views — daher keine Mount-Race wie beim klassischen Animated.
  const [burst, setBurst] = useState<{ id: number; sparks: Spark[]; mode: "save" | "unsave" } | null>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    };
  }, []);

  /**
   * Funken weg, sobald ein Blatt fährt.
   *
   * Sie leben 1,4 Sekunden — lang genug, dass die üblichen Wege sie mitnehmen:
   * Stern antippen, dann eine Zeile wählen, und die Ausfahrt läuft, während 15
   * SVG-Pfade animiert werden. Animierte SVG-Eigenschaften machen die ganze
   * Fläche ungültig (dazu gibt es hier eigene Notizen), und die Fläche ist in
   * dem Moment das bildschirmfüllende Blatt, das als Textur gehalten wird —
   * die müsste damit in jedem Bild der Fahrt neu entstehen.
   *
   * Der Stern selbst behält seinen Zustand; nur der Nachschlag entfällt. Zu
   * sehen ist davon nichts: Die Bewegung verdeckt ihn ohnehin.
   */
  useEffect(
    () =>
      subscribeSheetMoving((on) => {
        if (!on) return;
        if (burstTimer.current) clearTimeout(burstTimer.current);
        setBurst((b) => (b === null ? b : null));
      }),
    [],
  );

  const handlePress = useCallback(() => {
    const willSave = !saved;
    pressOrigin.current = true;
    haptic(willSave ? "important" : "button");

    setBurst((b) => ({
      id: (b?.id ?? 0) + 1,
      sparks: makeSparks(sparkColors(accent)),
      mode: willSave ? "save" : "unsave",
    }));
    if (burstTimer.current) clearTimeout(burstTimer.current);
    burstTimer.current = setTimeout(() => setBurst(null), BURST_LIFETIME_MS);

    if (willSave) {
      pop.value = 0;
      pop.value = withTiming(1, { duration: 1400, easing: EASE_POP });
    } else {
      // Unsave: eigener Keyframe-Pfad 1→2 (siehe goldStyle) — kurzes
      // „Aufatmen", dann sanft schrumpfen + Gegendrehung, synchron zu den
      // implodierenden Funken. NICHT rückwärts durch die Save-Bounce.
      pop.value = 1;
      pop.value = withTiming(2, { duration: 650, easing: Easing.inOut(Easing.ease) });
    }

    if (savedProp === undefined) setSavedState(willSave);
    onChange?.(willSave);
  }, [saved, onChange, savedProp, pop, accent]);

  // Externe saved-Änderung (Erst-Mount / Station-Wechsel ohne Press) → sofort
  // in den Zielzustand snappen, ohne Bounce.
  useEffect(() => {
    if (pressOrigin.current) {
      pressOrigin.current = false;
      return;
    }
    pop.value = saved ? 1 : 0;
  }, [saved, pop]);

  // pop 0→1 = Save-Bounce (Vorlagen-Keyframes), pop 1→2 = Unsave-Exit
  // (leichtes Aufblähen als Anticipation, dann Schrumpfen auf 0 mit Drehung).
  const goldStyle = useAnimatedStyle(() => {
    const p = pop.value;
    return {
      opacity: interpolate(p, [0, 0.12, 1.6, 2], [0, 1, 1, 0], Extrapolation.CLAMP),
      transform: [
        {
          scale: interpolate(
            p,
            [0, 0.45, 0.68, 0.85, 1, 1.3, 2],
            [0.3, 1.45, 0.9, 1.06, 1, 1.14, 0],
            Extrapolation.CLAMP,
          ),
        },
        {
          rotate: `${interpolate(
            p,
            [0, 0.45, 0.68, 0.85, 1, 1.3, 2],
            [-18, 10, -4, 2, 0, 5, -70],
            Extrapolation.CLAMP,
          )}deg`,
        },
      ],
    };
  });

  const center = size / 2;
  const goldSize = Math.round(starSize * 1.1); // 30 → 33, wie in der Vorlage
  const haloSize = goldSize * 1.6;
  const haloOffset = (goldSize - haloSize) / 2;

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={saved ? "Unsave station" : "Save station"}
      style={({ pressed }) => [
        styles.btn,
        { width: size, height: size },
        pressed && { transform: [{ scale: 0.84 }] },
      ]}
    >
      {/* Umriss-Stern (immer sichtbar, weiß) */}
      <Svg width={starSize} height={starSize} viewBox="0 0 24 24">
        <Path
          d={STAR_PATH}
          fill="none"
          stroke="#F4F4F5"
          strokeWidth={1.7}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>

      {/* Gold-Stern + Glow-Halo — gemountet wenn gespeichert oder ein Burst
          läuft (deckt die Unsave-Ausblendung ab); sonst 0 Compositing-Kosten */}
      {(saved || burst !== null) && (
      <Animated.View pointerEvents="none" style={[styles.overlay, goldStyle]}>
        <View style={{ width: goldSize, height: goldSize, alignItems: "center", justifyContent: "center" }}>
          {/* Glow-Halo (RadialGradient) — dezent, plattformübergreifend */}
          <Svg
            width={haloSize}
            height={haloSize}
            viewBox="0 0 100 100"
            style={{ position: "absolute", left: haloOffset, top: haloOffset }}
          >
            <Defs>
              <RadialGradient id="bncglow" cx="50%" cy="50%" r="50%">
                <Stop offset="0%" stopColor={accent.solid} stopOpacity={0.15} />
                <Stop offset="55%" stopColor={accent.solid} stopOpacity={0.05} />
                <Stop offset="100%" stopColor={accent.solid} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Circle cx={50} cy={50} r={50} fill="url(#bncglow)" />
          </Svg>

          <Svg width={goldSize} height={goldSize} viewBox="0 0 24 24">
            <Defs>
              {/* Dieselben drei Stufen wie in der Vorlage — nur eben im
                  Akzentton statt in Gold. Die Kontur ist die hellste davon, so
                  wie das Original eine hellere Kontur über dem Verlauf hatte. */}
              <LinearGradient id="bncGold" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0%" stopColor={accent.gradient[0]} />
                <Stop offset="50%" stopColor={accent.gradient[1]} />
                <Stop offset="100%" stopColor={accent.gradient[2]} />
              </LinearGradient>
            </Defs>
            <Path
              d={STAR_PATH}
              fill="url(#bncGold)"
              stroke={accent.gradient[0]}
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
          </Svg>
        </View>
      </Animated.View>
      )}

      {/* Funken — nur während eines aktiven Bursts gemountet */}
      {burst !== null && (
        <View pointerEvents="none" style={styles.overlay}>
          {burst.sparks.map((s, i) => (
            <SparkView key={i} spark={s} burstId={burst.id} isSave={burst.mode === "save"} center={center} />
          ))}
        </View>
      )}
    </Pressable>
  );
}

const styles = scaledStyles({
  btn: { alignItems: "center", justifyContent: "center" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
