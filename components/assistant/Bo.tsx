/**
 * Bo — der Binch-Reise-Geist als animiertes Maskottchen.
 *
 * Sechs Zustände steuern Animation + Gesicht:
 *   idle      — sanftes Schweben + Blinzeln
 *   waving    — winkt mit der Hand, lächelt
 *   talking   — wippt, Mund öffnet/schließt im Takt
 *   thinking  — wiegt sich, Augen wandern suchend
 *   happy     — hüpft (Squash & Stretch), Lächel-Augen + Funken + Glow
 *   error     — zittert erschrocken, Sorgen-Brauen + Schweißtropfen
 *
 * Farben:
 *   Glow + Blush + Lime-Akzente werden über useAccent() gesteuert — wenn
 *   der User in Settings auf Mint switcht, switcht auch Bo. Fehler-Farbe
 *   bleibt fest (#FF7A6B), gilt für alle Akzente.
 *
 * Architektur:
 *   - Wrapper-Animated.View transformiert die ganze Figur (Schweben/Hüpfen/Zittern)
 *   - Animated-G-Props bewegen einzelne Gesichtsteile (Augen, Mund, Arm, Tropfen)
 *   - Animationen werden bei state-Wechsel komplett cancelled + neu gestartet
 */
import React, { useEffect, useRef } from "react";
import { View, StyleSheet } from "react-native";
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  Path,
  Ellipse,
  Circle,
  Line,
  G,
} from "react-native-svg";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedProps,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  cancelAnimation,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";

export type BoMood = "idle" | "waving" | "talking" | "thinking" | "happy" | "error" | "sad";

const AG = Animated.createAnimatedComponent(G);
const EASE = Easing.inOut(Easing.ease);

const ERROR_COLOR = "#FF7A6B";
const GHOST_TOP = "#FFFFFF";
const GHOST_BOTTOM = "#E9ECEC";
const INK = "#1A1A1A";
const SWEAT = "#7FD4FF";

interface Props {
  state?: BoMood;
  /** Breite der Figur in px. Höhe ergibt sich aus dem Seitenverhältnis 200:240. */
  size?: number;
  /** Wenn `true`: alle Reanimated-Worklets cancelln und nicht neu starten.
   *  Wird vom Assistant-Tab gesetzt wenn der Tab unfokussiert ist — die
   *  ~5-8 endlos repeatenden Worklets würden sonst auch im Hintergrund
   *  laufen und die UI-Thread auf Home/Settings/Saved bremsen. */
  paused?: boolean;
}

export function Bo({ state = "idle", size = 128, paused = false }: Props) {
  const accent = useAccent();

  // Wenn Bo mit `paused=true` UND `state="sad"` mountet (typisch in der
  // EmptyState der Saved-Tab), brauchen wir die Sad-Pose-Werte SOFORT
  // im ersten Render-Frame. Sonst startet Bo in der Waving-Pose und
  // snapped dann zur Sad-Pose → der User sieht die Augen "neu positionieren".
  const sadPausedInit = paused && state === "sad";

  // ---- Shared values pro Animation ---------------------------------------
  const tx = useSharedValue(0);
  const ty = useSharedValue(sadPausedInit ? 8 : 0);
  // rot startet auf der WAVING-Pose (-3°), oder 0 wenn sad-paused.
  const rot = useSharedValue(sadPausedInit ? 0 : -3);
  const sx = useSharedValue(1);
  const sy = useSharedValue(1);

  const eyeBlink = useSharedValue(1);
  const eyeLookX = useSharedValue(0);
  // Sad-Pose hat eyeLookY=4.25 (Bo schaut leicht nach unten). Bei
  // sad-paused-Init direkt damit starten → kein sichtbarer Eye-Jump.
  const eyeLookY = useSharedValue(sadPausedInit ? 4.25 : 0);
  const mouthYap = useSharedValue(1);
  const armRot = useSharedValue(-15);
  const sweatY = useSharedValue(-4);
  const sweatOp = useSharedValue(0);

  // Glow ist via SVG RadialGradient gelöst. Sad-Paused = 0.12 Glow,
  // sonst 1.0 (für andere Initial-Posen wie waving).
  const glowOp = useSharedValue(sadPausedInit ? 0.12 : 1);
  const glowScale = useSharedValue(1);
  const sparkle = useSharedValue(0);

  // ---- State-Wechsel: alle Animationen abbrechen und neu setzen ----------
  // Beim ALLERERSTEN Run überspringen wir den Reset-Block: die useSharedValue-
  // Init-Werte sind schon auf der waving-Starting-Pose (rot=-3, armRot=-15),
  // ein Reset würde sie auf 0/-7 zurücksetzen → sichtbarer Snap-Frame bevor
  // die State-spezifische Setup-Logik wieder auf -3/-15 snappt.
  const isFirstRunRef = useRef(true);
  useEffect(() => {
    const all = [
      tx, ty, rot, sx, sy,
      eyeBlink, eyeLookX, eyeLookY, mouthYap, armRot,
      sweatY, sweatOp, glowOp, glowScale, sparkle,
    ];
    all.forEach(cancelAnimation);

    if (!isFirstRunRef.current) {
      // Cross-State-Reset — smoother Übergang zur neutralen Pose (200ms
      // withTiming statt instant assignment). Wenn der neue State danach
      // einen Wert selber animiert (z.B. neue ty/rot via withSequence),
      // überschreibt das die withTiming hier — kein Konflikt, der State-
      // spezifische Code macht seine eigene smooth-Transition. Werte die
      // der neue State NICHT anfasst (z.B. armRot wenn man von waving auf
      // idle wechselt) gleiten über diese withTiming sanft auf neutral.
      const T_RESET = { duration: 200, easing: EASE };
      tx.value = withTiming(0, T_RESET);
      rot.value = withTiming(0, T_RESET);
      sx.value = withTiming(1, T_RESET);
      sy.value = withTiming(1, T_RESET);
      eyeBlink.value = withTiming(1, T_RESET);
      eyeLookX.value = withTiming(0, T_RESET);
      eyeLookY.value = withTiming(0, T_RESET);
      mouthYap.value = withTiming(1, T_RESET);
      armRot.value = withTiming(-7, T_RESET);
      sweatY.value = withTiming(-4, T_RESET);
      sweatOp.value = withTiming(0, T_RESET);
      glowScale.value = withTiming(1, T_RESET);
    }
    isFirstRunRef.current = false;

    // Wenn pausiert: keine Worklets starten. Aber für State-spezifische
    // Posen müssen die Shared-Values auf einen sinnvollen statischen Wert
    // gesetzt werden — sonst rendert Bo z.B. im sad-Static mit der waving-
    // Init-Pose (rot=-3) statt mit der ruhigen sad-Pose (rot=0).
    if (paused) {
      if (state === "sad") {
        // Mid-of-Loop-Werte aus der sad-Animation: sanfter Ruhe-Zustand.
        ty.value = 8;
        rot.value = 0;
        eyeLookY.value = 4.25;
        glowOp.value = 0.12;
      } else {
        glowOp.value = state === "error" ? 0 : 0.18;
      }
      return;
    }

    const blink = () => {
      // Bewusster, langsamer Blink alle ~10s. Schließ-/Öffnungszeiten sind
      // bewusst lang (200/240ms) damit man das Schließen + Öffnen klar
      // wahrnimmt, statt es als kurzes Flackern zu übersehen.
      eyeBlink.value = withRepeat(
        withSequence(
          withDelay(10_000, withTiming(0.04, { duration: 200 })),
          withTiming(1, { duration: 240 }),
        ),
        -1,
      );
    };

    // Smooth-Transition-Helper-Konstante. Erste Phase jeder State-Animation
    // ist ein withTiming auf die Start-Pose (200ms), danach kommt die
    // ursprüngliche Repeat/Sequence. Damit überlappt der State-Wechsel sanft
    // statt zu snappen.
    const T_IN = { duration: 200, easing: EASE };

    if (state === "idle") {
      glowOp.value = withTiming(0.18);
      ty.value = withSequence(
        withTiming(2, T_IN),
        withRepeat(withTiming(-15, { duration: 4800, easing: EASE }), -1, true),
      );
      rot.value = withSequence(
        withTiming(-1.6, T_IN),
        withRepeat(withTiming(1.6, { duration: 4800, easing: EASE }), -1, true),
      );
      blink();
    }

    if (state === "waving") {
      glowOp.value = withTiming(0.25);
      ty.value = withSequence(
        withTiming(0, T_IN),
        withRepeat(withTiming(-6, { duration: 630, easing: EASE }), -1, true),
      );
      rot.value = withSequence(
        withTiming(-2, T_IN),
        withRepeat(withTiming(2, { duration: 630, easing: EASE }), -1, true),
      );
      // Arm sweep: -15° → 40° (55° Range), 630ms each way.
      armRot.value = withSequence(
        withTiming(-15, T_IN),
        withRepeat(withTiming(40, { duration: 630, easing: EASE }), -1, true),
      );
      blink();
    }

    if (state === "talking") {
      glowOp.value = withTiming(0.25);
      ty.value = withSequence(
        withTiming(0, T_IN),
        withRepeat(withTiming(-7, { duration: 400, easing: EASE }), -1, true),
      );
      sy.value = withSequence(
        withTiming(1, T_IN),
        withRepeat(withTiming(0.975, { duration: 210, easing: EASE }), -1, true),
      );
      sx.value = withSequence(
        withTiming(1, T_IN),
        withRepeat(withTiming(1.025, { duration: 210, easing: EASE }), -1, true),
      );
      mouthYap.value = withSequence(
        withTiming(1, T_IN),
        withRepeat(withTiming(0.28, { duration: 180, easing: EASE }), -1, true),
      );
      blink();
    }

    if (state === "thinking") {
      glowOp.value = withTiming(0.2);
      rot.value = withSequence(
        withTiming(-3, T_IN),
        withRepeat(withTiming(3, { duration: 5000, easing: EASE }), -1, true),
      );
      ty.value = withSequence(
        withTiming(0, T_IN),
        withRepeat(withTiming(-5, { duration: 5000, easing: EASE }), -1, true),
      );
      eyeLookX.value = withSequence(
        withTiming(-2, T_IN),
        withRepeat(withTiming(2, { duration: 5500, easing: EASE }), -1, true),
      );
      eyeLookY.value = withTiming(0, T_IN);
      blink();
    }

    if (state === "happy") {
      glowOp.value = withRepeat(withTiming(0.45, { duration: 500, easing: EASE }), -1, true);
      glowScale.value = withRepeat(withTiming(1.12, { duration: 500, easing: EASE }), -1, true);
      ty.value = withRepeat(
        withSequence(
          withTiming(4, { duration: 180, easing: EASE }),
          withTiming(-30, { duration: 300, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 220, easing: Easing.in(Easing.quad) }),
          withTiming(-6, { duration: 140, easing: EASE }),
          withTiming(0, { duration: 160, easing: EASE }),
        ),
        -1,
      );
      sy.value = withRepeat(
        withSequence(
          withTiming(0.93, { duration: 180 }),
          withTiming(1.07, { duration: 300 }),
          withTiming(0.95, { duration: 220 }),
          withTiming(1, { duration: 300 }),
        ),
        -1,
      );
      sparkle.value = withRepeat(withTiming(1, { duration: 1500, easing: EASE }), -1);
    } else {
      sparkle.value = withTiming(0, { duration: 200 });
    }

    if (state === "error") {
      // Im Error-State KEIN roter Glow-Halo — Bo's Sweat + Brauen +
      // Shake-Animation kommunizieren den Error stark genug. Eine satte
      // rote Scheibe drum herum macht das Bild aggressiv.
      glowOp.value = withTiming(0);
      eyeLookY.value = withTiming(3, T_IN);
      const seg = 55;
      tx.value = withRepeat(
        withSequence(
          withTiming(-6, { duration: seg }),
          withTiming(6, { duration: seg }),
          withTiming(-5, { duration: seg }),
          withTiming(5, { duration: seg }),
          withTiming(-3, { duration: seg }),
          withTiming(2, { duration: seg }),
          withTiming(0, { duration: seg }),
          withDelay(1100, withTiming(0, { duration: 1 })),
        ),
        -1,
      );
      rot.value = withRepeat(
        withSequence(
          withTiming(-2.5, { duration: seg }),
          withTiming(2.5, { duration: seg }),
          withTiming(-2, { duration: seg }),
          withTiming(2, { duration: seg }),
          withTiming(-1, { duration: seg }),
          withTiming(0, { duration: seg * 2 }),
          withDelay(1100, withTiming(0, { duration: 1 })),
        ),
        -1,
      );
      sweatOp.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 1 }),
          withTiming(1, { duration: 300 }),
          withTiming(1, { duration: 570 }),
          withTiming(0, { duration: 760 }),
        ),
        -1,
      );
      sweatY.value = withRepeat(
        withSequence(
          withTiming(-4, { duration: 1 }),
          withTiming(0, { duration: 300 }),
          withTiming(11, { duration: 570 }),
          withTiming(20, { duration: 760 }),
        ),
        -1,
      );
    }

    if (state === "sad") {
      // Ruhig + droopy — sinkt langsam tiefer, leicht gesenkter Blick.
      // Kein Blinzeln (heavy-lidded sad feel). Glow ist weniger satt als
      // bei happy/waving — passt zur trübseligen Stimmung ohne komplett
      // dunkel zu sein.
      glowOp.value = withTiming(0.12);
      ty.value = withSequence(
        withTiming(4, T_IN),
        withRepeat(withTiming(12, { duration: 6200, easing: EASE }), -1, true),
      );
      rot.value = withSequence(
        withTiming(-0.5, T_IN),
        withRepeat(withTiming(0.5, { duration: 6200, easing: EASE }), -1, true),
      );
      eyeLookY.value = withSequence(
        withTiming(3, T_IN),
        withRepeat(withTiming(5.5, { duration: 3500, easing: EASE }), -1, true),
      );
    }

    // Cleanup: bei Unmount ALLE laufenden Worklets stoppen. Ohne diesen
    // return-Hook laufen die withRepeat-Loops im UI-Thread weiter — über
    // viele Mount/Unmount-Cycles (Tab-Wechsel, Loader-Scene-Swaps,
    // assistant-Re-Open) akkumulierte das zur App-weiten Slowdown.
    return () => {
      cancelAnimation(tx);
      cancelAnimation(ty);
      cancelAnimation(rot);
      cancelAnimation(sx);
      cancelAnimation(sy);
      cancelAnimation(eyeBlink);
      cancelAnimation(eyeLookX);
      cancelAnimation(eyeLookY);
      cancelAnimation(mouthYap);
      cancelAnimation(armRot);
      cancelAnimation(sweatY);
      cancelAnimation(sweatOp);
      cancelAnimation(glowOp);
      cancelAnimation(glowScale);
      cancelAnimation(sparkle);
    };
  }, [state, paused]);

  // ---- Derived styles + animated props -----------------------------------
  const bodyStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { rotate: `${rot.value}deg` },
      { scaleX: sx.value },
      { scaleY: sy.value },
    ],
  }));

  // ‼️ react-native-svg + Reanimated 4 + Fabric: weder `scaleY` (Shorthand)
  // noch `transform: "<string>"` (SVG-Syntax) brücken zuverlässig auf G.
  // Die Shorthands werden ignoriert (kein visueller Effekt), der String
  // crasht mit ClassCastException weil der Native-Layer ein Array erwartet.
  //
  // Pragmatischer Fix: Blink via `opacity` (CSS-Standardwert, immer
  // sicher), Eye-Look via transform-Array (das akzeptiert RN-SVG nativ).
  // Beim Blink fadet das Eye-G für ~80ms auf fast 0, was sich als
  // klassisches kurzes Augenschließen liest.
  const eyesProps = useAnimatedProps(() => ({
    opacity: eyeBlink.value,
    transform: [
      { translateX: eyeLookX.value },
      { translateY: eyeLookY.value },
    ],
  }));
  const mouthProps = useAnimatedProps(() => ({ scaleY: mouthYap.value }));
  const armProps = useAnimatedProps(() => ({ rotation: armRot.value }));
  const sweatProps = useAnimatedProps(() => ({ y: sweatY.value, opacity: sweatOp.value }));

  const sparkleStyle = useAnimatedStyle(() => ({
    opacity: state === "happy" ? interpolate(sparkle.value, [0, 0.35, 1], [0, 1, 0]) : 0,
    transform: [{ scale: interpolate(sparkle.value, [0, 0.35, 1], [0, 1, 0]) }],
  }));

  const showOpenEyes = state !== "happy";
  const showHappyEyes = state === "happy";
  const showBrows = state === "error";
  const showSadBrows = state === "sad";
  const showArm = state === "waving";
  const showSweat = state === "error";
  const blushOpacity = state === "happy" ? 1 : state === "sad" ? 0.22 : 0.5;

  const W = size;
  const H = size * 1.2; // SVG-Body-Höhe; ViewBox erweitert für Glow-Halo.
  const frameH = H + size * 0.42; // Platz für Schatten unten

  return (
    <View style={[styles.frame, { width: W, height: frameH }]}>
      {/* Glow ist jetzt INNERHALB der SVG via RadialGradient (siehe unten) —
          ein solid-color View-Kreis hatte immer harte Kanten egal wie niedrig
          die Opacity. Mit dem SVG-Gradient bekommt Bo einen echten weichen
          Halo der zur Mitte hin satter wird und zum Rand transparent. */}

      {/* Sparkles only beim Happy-State. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, sparkleStyle]}>
        {SPARKS.map((s, i) => (
          <Animated.Text
            key={i}
            style={[
              styles.spark,
              { left: s.x * W, top: s.y * H, color: accent.solid },
            ]}
          >
            {s.c}
          </Animated.Text>
        ))}
      </Animated.View>

      {/* Der Geist selbst. ViewBox auf 280×320 erweitert (war 200×240) damit
          der Glow-Halo um Bo herum Platz hat. Bo's Koordinaten (28-172 hor,
          48-220 vert) bleiben unverändert, sind jetzt nur zentriert innerhalb
          des größeren Frames bei (40, 40) Offset. */}
      <Animated.View style={bodyStyle}>
        <Svg width={W * 1.4} height={H * 1.33} viewBox="-40 -40 280 320">
          <Defs>
            <LinearGradient id="boBody" x1="100" y1="40" x2="100" y2="220" gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={GHOST_TOP} />
              <Stop offset="1" stopColor={GHOST_BOTTOM} />
            </LinearGradient>
            {/* Radialer Halo: voll im Zentrum, fadet zur Hälfte schon auf
                ~30% und am Rand komplett transparent. Die User-Stoppen-Werte
                sind so abgestimmt dass Bo's Body fast bündig in den glow
                übergeht — kein harter Kreis sichtbar. */}
            <RadialGradient
              id="boGlowAccent"
              cx="100"
              cy="130"
              rx="140"
              ry="140"
              fx="100"
              fy="130"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor={accent.solid} stopOpacity="0.55" />
              <Stop offset="0.35" stopColor={accent.solid} stopOpacity="0.25" />
              <Stop offset="0.7" stopColor={accent.solid} stopOpacity="0.05" />
              <Stop offset="1" stopColor={accent.solid} stopOpacity="0" />
            </RadialGradient>
            <RadialGradient
              id="boGlowError"
              cx="100"
              cy="130"
              rx="140"
              ry="140"
              fx="100"
              fy="130"
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset="0" stopColor={ERROR_COLOR} stopOpacity="0.4" />
              <Stop offset="0.5" stopColor={ERROR_COLOR} stopOpacity="0.12" />
              <Stop offset="1" stopColor={ERROR_COLOR} stopOpacity="0" />
            </RadialGradient>
          </Defs>

          {/* Glow-Ellipse mit RadialGradient — drawn FIRST so Bo's body
              davor liegt. Opacity per glowOp Reanimated value für die
              Mood-Pulse (vor allem happy). */}
          <Ellipse
            cx={100}
            cy={130}
            rx={140}
            ry={140}
            fill={state === "error" ? "url(#boGlowError)" : "url(#boGlowAccent)"}
            opacity={state === "error" ? 0 : 1}
          />

          {/* WICHTIG: Bedingte AnimatedG-Children (`{cond && <AG>...</AG>}`)
              crashen in RN Fabric mit „addViewAt: failed to insert view"
              wenn der Mood wechselt und AG re-mounted wird. Lösung: alle
              AG-Elemente IMMER mounten, Sichtbarkeit per opacity auf einem
              statischen G-Wrapper. SVG-G nimmt opacity 0..1 und macht alle
              Children unsichtbar wenn 0. */}

          {/* Arm beim Winken — hinter dem Körper damit das Ärmel-Ende verschwindet. */}
          <G opacity={showArm ? 1 : 0}>
            <AG originX={150} originY={132} animatedProps={armProps}>
              <Path
                d="M150 132 C176 126 198 110 205 80"
                stroke={GHOST_TOP}
                strokeWidth={18}
                strokeLinecap="round"
                fill="none"
              />
            </AG>
          </G>

          {/* Body — Wellen-Saum unten via 4 Quad-Kurven. */}
          <Path
            d="M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z"
            fill="url(#boBody)"
          />

          {/* Blush — Akzent-Farbe damit Bo zum App-Akzent passt. */}
          <Ellipse cx={56} cy={150} rx={13} ry={7.5} fill={accent.solid} opacity={blushOpacity} />
          <Ellipse cx={144} cy={150} rx={13} ry={7.5} fill={accent.solid} opacity={blushOpacity} />

          {/* Open eyes (alle States außer happy). Transform-Animation läuft
              komplett über den `transform`-String aus eyesProps — siehe
              Kommentar oben. */}
          <G opacity={showOpenEyes ? 1 : 0}>
            <AG animatedProps={eyesProps}>
              <Ellipse cx={76} cy={120} rx={16} ry={21} fill={INK} />
              <Ellipse cx={124} cy={120} rx={16} ry={21} fill={INK} />
              <Circle cx={82} cy={112} r={5.5} fill="#FFFFFF" />
              <Circle cx={130} cy={112} r={5.5} fill="#FFFFFF" />
              <Circle cx={71} cy={126} r={2.6} fill="#FFFFFF" opacity={0.7} />
              <Circle cx={119} cy={126} r={2.6} fill="#FFFFFF" opacity={0.7} />
            </AG>
          </G>

          {/* Happy eyes als Bögen. */}
          <G
            opacity={showHappyEyes ? 1 : 0}
            stroke={INK}
            strokeWidth={7}
            strokeLinecap="round"
            fill="none"
          >
            <Path d="M61 124 Q76 104 91 124" />
            <Path d="M109 124 Q124 104 139 124" />
          </G>

          {/* Sorgen-Brauen bei Error — Outer-Punkt liegt TIEFER als Inner-
              Punkt → V-Form, klassisches "wütend/besorgt"-Profil. */}
          <G
            opacity={showBrows ? 1 : 0}
            stroke={INK}
            strokeWidth={5.5}
            strokeLinecap="round"
          >
            <Line x1={58} y1={107} x2={85} y2={96} />
            <Line x1={142} y1={107} x2={115} y2={96} />
          </G>

          {/* Trauer-Brauen bei Sad — umgekehrter Slope (Inner-Punkt HÖHER
              als Outer): das ist das klassische "traurige Augenbrauen
              hochgezogen in der Mitte"-Profil. Optisch fast identische
              Koordinaten wie Error-Brauen, nur Y-Werte gespiegelt. */}
          <G
            opacity={showSadBrows ? 1 : 0}
            stroke={INK}
            strokeWidth={5.5}
            strokeLinecap="round"
          >
            <Line x1={57} y1={108} x2={86} y2={99} />
            <Line x1={143} y1={108} x2={114} y2={99} />
          </G>

          {/* Schweißtropfen bei Error — animated y + opacity (sweatProps).
              Wrapper-G mit visibility-opacity damit AG immer gemountet ist. */}
          <G opacity={showSweat ? 1 : 0}>
            <AG animatedProps={sweatProps}>
              <Path
                d="M154 99 C160 110 162 116 158 121 C155 124 151 124 149 121 C146 116 149 110 154 99 Z"
                fill={SWEAT}
              />
            </AG>
          </G>

          {/* Mund pro State — alle 6 immer gemountet, opacity steuert Anzeige. */}
          <Path
            opacity={state === "idle" ? 1 : 0}
            d="M89 150 Q100 159 111 150"
            stroke={INK}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
          />
          <Line
            opacity={state === "thinking" ? 1 : 0}
            x1={92}
            y1={153}
            x2={108}
            y2={153}
            stroke={INK}
            strokeWidth={5}
            strokeLinecap="round"
          />
          <Path
            opacity={state === "waving" ? 1 : 0}
            d="M85 149 Q100 164 115 149"
            stroke={INK}
            strokeWidth={5.5}
            strokeLinecap="round"
            fill="none"
          />
          <Path
            opacity={state === "happy" ? 1 : 0}
            d="M82 149 Q100 180 118 149 Z"
            fill={INK}
          />
          <Path
            opacity={state === "error" ? 1 : 0}
            d="M89 159 Q95 151 100 157 Q105 163 111 155"
            stroke={INK}
            strokeWidth={5}
            strokeLinecap="round"
            fill="none"
          />
          {/* Trauer-Mund: umgekehrter Bogen (Mundwinkel ZIEHEN sich nach
              unten). Quad-Kontrollpunkt liegt OBERHALB der Endpunkte → Bogen
              wölbt sich nach oben = traurig. */}
          <Path
            opacity={state === "sad" ? 1 : 0}
            d="M86 159 Q100 148 114 159"
            stroke={INK}
            strokeWidth={5.5}
            strokeLinecap="round"
            fill="none"
          />
          <G opacity={state === "talking" ? 1 : 0}>
            <AG originX={100} originY={153} animatedProps={mouthProps}>
              <Ellipse cx={100} cy={153} rx={11} ry={9} fill={INK} />
            </AG>
          </G>
        </Svg>
      </Animated.View>

      {/* Boden-Schatten. */}
      <View style={[styles.shadow, { width: W * 0.62, bottom: size * 0.04 }]} />
    </View>
  );
}

const SPARKS = [
  { x: 0.14, y: 0.22, c: "✦" },
  { x: 0.86, y: 0.36, c: "✦" },
  { x: 0.08, y: 0.6, c: "✦" },
  { x: 0.78, y: 0.18, c: "✧" },
  { x: 0.82, y: 0.7, c: "✧" },
];

const styles = StyleSheet.create({
  frame: { alignItems: "center", justifyContent: "center" },
  shadow: {
    position: "absolute",
    height: 14,
    borderRadius: 999,
    backgroundColor: "rgba(0,0,0,0.45)",
    opacity: 0.3,
  },
  spark: {
    position: "absolute",
    fontSize: 18,
    fontWeight: "700",
  },
});
