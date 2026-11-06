/**
 * Das Blatt vor einer System-Abfrage — gebaut nach Google Maps: oben eine
 * ruhige große Überschrift und ein Satz, wofür; in der Mitte eine einfarbige
 * Strichzeichnung, die sich selbst zeichnet; unten „Weiter" als Pille und
 * „Nicht jetzt" als Text. Erst „Weiter" ruft den Dialog des Systems
 * (`lib/permissions/primer.ts`) — das Blatt bleibt dabei stehen. Erteilt: ein
 * Haken zeichnet sich, dann geht es. Mikrofon: Es fährt stattdessen auf die
 * Höhe des Aufnahme-Blattes zusammen, das dann übernimmt.
 *
 * Fahrt, Wisch und Hülle wie jedes Blatt (`useSheetSlide`, `useSheetSwipe`,
 * Fläche `palette.s1` über dem Scrim). Die Zeichnung beginnt erst, wenn das
 * Blatt steht — nichts läuft gegeneinander. Danach bewegt sich ruhig, was
 * zeigt, wofür es ist: über Hüllen (Lage, Drehung, Deckkraft — Drehpunkte als
 * Verschiebung, nie `transformOrigin`), beim Gesicht über die Zeichnung selbst.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ActivityIndicator, BackHandler, Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  answerPrimer,
  HANDOFF_MS,
  primerClosesInstantly,
  usePrimer,
  type PermissionKind,
  type PrimerRequest,
} from "@/lib/permissions/primer";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { softSheetMotion } from "@/lib/nav/overlayCover";
import { dragHealOffset, snapToPixel, useSheetSwipe } from "@/lib/ui/sheetSwipe";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { GROUP_GAP, GUTTER, ITEM_GAP, TITLE_GAP } from "@/lib/theme/spacing";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { FadePress } from "@/components/ui/FadePress";
import { ms, scaledStyles } from "@/lib/ui/compact";

const WINDOW_H = Dimensions.get("window").height;
const SHEET_RADIUS = 28;
const WHITE = "#F4F4F5";
const G2 = "#8E8E93";
/** Das blasse Nebenelement jeder Zeichnung — wie Googles grauer Bogen. */
const FAINT = "rgba(255,255,255,0.16)";
/**
 * Die Zeichnung beginnt, wenn das Blatt STEHT (Einfahrt höchstens 460 ms,
 * `softSheetMotion`). Vorher begann sie bei 300 ms, im Auslaufen — aber jeder
 * gezeichnete Strich rastert hier die Fläche neu (react-native-svg), und das
 * gehört nicht in eine Fahrt (04.11.2026: „Animationen sollen nie laggen").
 */
const ART_START = 470;
/**
 * Punkte je Rastereinheit der 200er-Zeichnungen. Drehpunkte werden damit als
 * Verschiebung hin und zurück gesetzt (`translate · drehen · zurück`), NICHT
 * über `transformOrigin`: Am Gerät drehte und skalierte es damit um die Mitte
 * der Bühne — Teile flogen durchs Bild (04.11.2026). Außerhalb jedes Worklets
 * gerechnet (`ms` ist keine Worklet-Funktion).
 */
const ART_GRID = ms(200) / 200;
const BELL_PIVOT_Y = (50 - 100) * ART_GRID;
const SUN_PIVOT_X = (112 - 100) * ART_GRID;
const SUN_PIVOT_Y = (92 - 100) * ART_GRID;

export function PermissionSheetHost() {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const request = usePrimer();
  const open = request !== null;
  /** Die letzte Anfrage bleibt stehen, sonst verschwände der Inhalt mitten im Hinausfahren. */
  const lastRef = useRef<PrimerRequest | null>(request);
  if (request) lastRef.current = request;
  const shown = lastRef.current;
  /** Beim Hinausfahren gilt die letzte Phase weiter (Haken bleibt sichtbar). */
  const phase = shown?.phase ?? "ask";
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const room = Math.max(1, WINDOW_H - insets.top);
  const sheetH = Math.round(Math.min(room - 24, Math.max(520, WINDOW_H * 0.72)));
  /**
   * Nur die eigene Höhe (+ Luft für den Schatten) und die weiche Kurve — nicht
   * mehr die ganze Bildhöhe in 300 ms wie die großen Blätter: Das Blatt „schoss
   * hoch" (04.11.2026). Siehe `softSheetMotion`.
   */
  const park = sheetH + 48;
  const motion = useMemo(() => softSheetMotion(park), [park]);
  const { y, run, adopt, parkNow, warm, heal } = useSheetSlide("permission", park, motion);

  /**
   * Übergabe ans Aufnahme-Blatt: Das Blatt sinkt um `drop`, bis nur noch dessen
   * Höhe zu sehen ist. Nur Lage, keine Höhe — sonst würde in jedem Bild neu
   * vermessen. Der Inhalt blendet dabei früh aus, der Scrim bleibt.
   */
  const shrink = useSharedValue(0);
  const drop = useSharedValue(0);
  /** Nach dem Haken braucht es keine Knöpfe mehr. */
  const buttonsOut = useSharedValue(0);
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(y.value + shrink.value * drop.value) + dragHealOffset(heal) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - y.value / park }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: 1 - Math.min(1, shrink.value * 2.5) }));
  const buttonsStyle = useAnimatedStyle(() => ({ opacity: 1 - buttonsOut.value }));

  /** Den echten Weg einmal kalt anlaufen lassen — ein Bild später (siehe Mitteilungs-Blatt). */
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current) return;
    const id = requestAnimationFrame(() => {
      warmed.current = true;
      warm();
    });
    return () => cancelAnimationFrame(id);
  }, [warm]);

  const lastOpen = useRef(false);
  const enteredAt = useRef(0);
  useEffect(() => {
    if (lastOpen.current === open) return;
    lastOpen.current = open;
    if (open) {
      enteredAt.current = Date.now();
      shrink.value = 0;
      buttonsOut.value = 0;
      run(true);
      return;
    }
    // Nach der Übergabe steht das Aufnahme-Blatt schon an seiner Stelle — ohne Fahrt weg.
    if (primerClosesInstantly()) {
      parkNow();
      shrink.value = 0;
      return;
    }
    run(false);
  }, [open, run, parkNow, shrink, buttonsOut]);

  const handoffTo = request?.phase === "handoff" ? (request.handoffHeight ?? 0) : 0;
  useEffect(() => {
    if (!handoffTo) return;
    drop.value = Math.max(0, sheetH - handoffTo);
    shrink.value = withTiming(1, { duration: HANDOFF_MS, easing: Easing.inOut(Easing.cubic) });
  }, [handoffTo, sheetH, drop, shrink]);

  useEffect(() => {
    if (phase === "granted") buttonsOut.value = withTiming(1, { duration: 200 });
  }, [phase, buttonsOut]);

  const dismissBySwipe = useCallback(
    (durationMs: number, fromY: number) => {
      adopt(false, durationMs, fromY);
      lastOpen.current = false;
      answerPrimer("later");
    },
    [adopt],
  );
  // Wischen nur, solange gewählt werden kann — nicht während des System-Dialogs, des Hakens oder der Übergabe.
  const panGesture = useSheetSwipe({
    y,
    travel: park,
    onDismiss: dismissBySwipe,
    enabled: open && phase === "ask",
    heal,
    closing: !open,
  });

  useEffect(() => {
    if (!open) parkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [park]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      // Nach der Wahl läuft es von selbst zu Ende — die Taste wird nur geschluckt.
      if (phaseRef.current === "ask") answerPrimer("later");
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const onContinue = () => {
    haptic("button");
    answerPrimer("continue");
  };
  const onLater = () => {
    haptic("button");
    answerPrimer("later");
  };
  /** Tippen neben das Blatt zählt erst, wenn es oben steht. */
  const onScrim = () => {
    if (Date.now() - enteredAt.current < motion.in.duration || phaseRef.current !== "ask") return;
    answerPrimer("later");
  };
  const choosing = phase === "ask";

  return (
    // Berührungs-Sperre auf der ruhenden Hülle, nicht auf den bewegten Knoten.
    <View style={[StyleSheet.absoluteFillObject, styles.layer]} pointerEvents={open ? "auto" : "none"}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.scrim, scrimStyle]} />
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t("perm.later")}
        onPress={onScrim}
      />
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.sheet,
            { height: sheetH, backgroundColor: palette.s1, paddingBottom: insets.bottom + GROUP_GAP },
            sheetStyle,
          ]}
        >
          {shown ? (
            <Animated.View key={shown.session} style={[styles.body, contentStyle]}>
              <Text style={styles.title}>{t(`perm.${shown.kind}.title`)}</Text>
              <Text style={styles.text}>{t(`perm.${shown.kind}.body`)}</Text>
              <View style={styles.stage}>
                <PrimerStage kind={shown.kind} play={open} granted={phase === "granted"} />
              </View>
              <Animated.View style={buttonsStyle} pointerEvents={choosing ? "auto" : "none"}>
                <RippleTouch
                  onPress={onContinue}
                  disabled={!choosing}
                  accessibilityRole="button"
                  rippleColor="rgba(0,0,0,0.12)"
                  style={[styles.primary, { backgroundColor: accent.solid }]}
                >
                  {phase === "asking" ? (
                    <ActivityIndicator color={accent.textOnSolid} />
                  ) : (
                    <Text style={[styles.primaryText, { color: accent.textOnSolid }]}>{t("perm.continue")}</Text>
                  )}
                </RippleTouch>
                <FadePress onPress={onLater} disabled={!choosing} accessibilityRole="button">
                  <View style={[styles.secondary, !choosing && styles.secondaryOff]}>
                    <Text style={[styles.secondaryText, { color: accent.solid }]}>{t("perm.later")}</Text>
                  </View>
                </FadePress>
              </Animated.View>
            </Animated.View>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/* ------------------------------------------------------------ Zeichnungen */

/**
 * Raster 200 × 200, Strich 6, runde Enden — eine Farbe (Akzent) und ein blasses
 * Nebenelement. Die Längen sind nachgerechnet (Bögen r·φ, Strecken), damit jeder
 * Strich genau dann fertig ist, wenn seine Zeit um ist.
 */
const STROKE = 6;
const DRAW = Easing.inOut(Easing.cubic);
const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

/** Ein Strich, der sich selbst zeichnet. `len` = Länge im 200er-Raster. */
function DrawPath({
  d,
  len,
  color,
  play,
  delay,
  duration,
  fill = "none",
  base = ART_START,
}: {
  d: string;
  len: number;
  color: string;
  play: boolean;
  delay: number;
  duration: number;
  /** Füllung in Blattfarbe deckt, was dahinter liegt (Fotos). */
  fill?: string;
  /** Ab wann die Verzögerung zählt — sonst ab dem Stehen des Blattes. */
  base?: number;
}) {
  const p = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      cancelAnimation(p);
      return;
    }
    p.value = withDelay(base + delay, withTiming(1, { duration, easing: DRAW }));
  }, [play, p, base, delay, duration]);
  // Startet einen Strich weit VOR dem Pfad — sonst zeigte die runde Kappe schon einen Punkt.
  const props = useAnimatedProps(() => ({ strokeDashoffset: (len + STROKE) * (1 - p.value) }));
  return (
    <AnimatedPath
      d={d}
      stroke={color}
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill={fill}
      strokeDasharray={[len, len + STROKE]}
      animatedProps={props}
    />
  );
}

/** Eine Schleife nach dem Auftritt — `make` baut einen Durchgang. */
function useLoop(play: boolean, delay: number, make: () => number): SharedValue<number> {
  const v = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      cancelAnimation(v);
      return;
    }
    v.value = withDelay(ART_START + delay, withRepeat(make(), -1, false));
    // `make` ist je Zeichnung fest — es soll die Schleife nicht neu starten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, v, delay]);
  return v;
}

/** Einmal einblenden, nach dem Auftritt. */
function useFade(play: boolean, delay: number): SharedValue<number> {
  const v = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      cancelAnimation(v);
      return;
    }
    v.value = withDelay(ART_START + delay, withTiming(1, { duration: 360 }));
  }, [play, v, delay]);
  return v;
}

/**
 * Die Mitte des Blattes: die Zeichnung — nach der Erlaubnis blendet sie aus,
 * und ein Haken zeichnet sich an ihrer Stelle.
 */
function PrimerStage({ kind, play, granted }: { kind: PermissionKind; play: boolean; granted: boolean }) {
  const out = useSharedValue(0);
  useEffect(() => {
    if (granted) out.value = withTiming(1, { duration: 200 });
  }, [granted, out]);
  const artStyle = useAnimatedStyle(() => ({ opacity: 1 - out.value, transform: [{ scale: 1 - 0.06 * out.value }] }));
  return (
    // Das Gesicht braucht links Platz für seine Wellen (siehe `TALK_VIEWBOX`); der Haken bleibt mittig.
    <View style={kind === "microphone" ? styles.artWide : styles.art}>
      <Animated.View style={[StyleSheet.absoluteFill, artStyle]}>
        <Art kind={kind} play={play && !granted} />
      </Animated.View>
      {granted ? <GrantedCheck /> : null}
    </View>
  );
}

/** Erteilt: Kreis und Haken zeichnen sich — derselbe Strich wie die Bilder. */
function GrantedCheck() {
  const accent = useAccent();
  return (
    <Layer>
      <DrawPath
        d="M100 40 A60 60 0 1 1 100 160 A60 60 0 1 1 100 40"
        len={377}
        color={accent.solid}
        play
        base={0}
        delay={120}
        duration={520}
      />
      <DrawPath d="M74 102 L92 120 L128 82" len={77.8} color={accent.solid} play base={0} delay={480} duration={320} />
    </Layer>
  );
}

function Art({ kind, play }: { kind: PermissionKind; play: boolean }) {
  switch (kind) {
    case "location":
      return <LocationArt play={play} />;
    case "microphone":
      return <TalkArt play={play} />;
    case "notifications":
      return <BellArt play={play} />;
    case "photos":
      return <PhotoArt play={play} />;
  }
}

/** Eine Ebene der Zeichnung — alle liegen deckungsgleich übereinander. */
function Layer({ children, viewBox = "0 0 200 200" }: { children: ReactNode; viewBox?: string }) {
  return (
    <Svg width="100%" height="100%" viewBox={viewBox} style={StyleSheet.absoluteFill}>
      {children}
    </Svg>
  );
}

/** Standort: eine Nadel mit Ortungsbögen; danach hüpft sie sacht, ihr Schatten atmet mit. */
function LocationArt({ play }: { play: boolean }) {
  const accent = useAccent();
  const shadowIn = useFade(play, 700);
  const hop = useLoop(play, 1500, () =>
    withSequence(
      withTiming(1, { duration: 280, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 340, easing: Easing.in(Easing.quad) }),
      withTiming(0, { duration: 2200 }),
    ),
  );
  // Außerhalb des Worklets ausrechnen — `ms` gibt es auf dem UI-Strang nicht (Absturz beim Öffnen der Karte).
  const lift = ms(8);
  const pin = useAnimatedStyle(() => ({ transform: [{ translateY: -lift * hop.value }] }));
  const shadow = useAnimatedStyle(() => ({
    opacity: shadowIn.value * (1 - 0.35 * hop.value),
    transform: [{ scaleX: 1 - 0.2 * hop.value }],
  }));
  return (
    <View style={styles.art}>
      {/* Ortungsbögen beiderseits des Kopfes — dieselbe Bildsprache wie Mikrofon und Glocke. */}
      <Layer>
        <DrawPath d="M46.31 115 A62 62 0 0 1 46.31 53" len={64.9} color={FAINT} play={play} delay={900} duration={450} />
        <DrawPath d="M153.69 53 A62 62 0 0 1 153.69 115" len={64.9} color={FAINT} play={play} delay={900} duration={450} />
      </Layer>
      <Animated.View style={[StyleSheet.absoluteFill, shadow]}>
        <Layer>
          <Ellipse cx={100} cy={180} rx={22} ry={5} fill={FAINT} />
        </Layer>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, pin]}>
        <Layer>
          <DrawPath
            d="M100 164 L65.36 104 A40 40 0 1 1 134.64 104 Z"
            len={306.1}
            color={accent.solid}
            play={play}
            delay={150}
            duration={950}
          />
          <DrawPath
            d="M86 84 A14 14 0 1 1 114 84 A14 14 0 1 1 86 84"
            len={88}
            color={accent.solid}
            play={play}
            delay={900}
            duration={450}
          />
        </Layer>
      </Animated.View>
    </View>
  );
}

/* Googles Gesicht, in unser 200er-Raster übertragen (Dreiviertel-Ansicht, rechts offen). */
const FACE_OUTLINE =
  "M24.4 50.5 C24.85 55.75 25.9 72 27.1 82 C28.3 92 29.2 102.25 31.6 110.5 C34 118.75 37.1 125.25 41.5 131.5 C45.9 137.75 51.75 143.35 58 148 C64.25 152.65 69.9 156.9 79 159.4 C88.1 161.9 107 162.4 112.6 163";
const FACE_BROW_L = "M34 37.6 C36.9 35.95 45.65 28.4 51.4 27.7 C57.15 27 65.65 32.45 68.5 33.4";
const FACE_BROW_R = "M114.4 29.5 C117.25 27.8 125.8 20.15 131.5 19.3 C137.2 18.45 145.75 23.55 148.6 24.4";
const FACE_NOSE = "M90.4 73 L82.6 91 L93.4 94";
const FACE_SMILE = "M79 112 C81.75 113.3 89.9 120.3 95.5 119.8 C101.1 119.3 109.75 110.8 112.6 109";

/**
 * Die Bühne des Gesichts ist breiter als die der anderen Bilder: Wie bei Google
 * spricht es nach LINKS (dorthin zeigt die Nase), und dort laufen die Wellen
 * hinaus — Googles Bogen liegt links vor dem Gesicht. Das Gesicht steht im
 * gewohnten 200er-Raster rechts, links 96 Einheiten Platz.
 */
const TALK_VIEWBOX = "-96 0 254 200";

/**
 * Ein ruhiger Satz: fünf Silben in 1,8 s, dann Pause bis 3,6 s. ALLES hängt an
 * EINEM Takt (Mund, Wellen, Blinzeln) — nichts kann auseinanderlaufen, und am
 * Ende des Takts steht alles wieder in Ruhe, die Wiederholung setzt nahtlos an.
 */
const TALK_PERIOD_S = 3.6;
/** Ab dann spricht es — erst wenn sich das Gesicht gezeichnet hat. */
const TALK_START_MS = 2100;
/** Mund über den Satz: [Sekunde, Öffnung 0…1], dazwischen weich (Kosinus). */
const MOUTH_KEYS: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.22, 0.72],
  [0.5, 0.18],
  [0.78, 0.66],
  [1.06, 0.14],
  [1.34, 0.55],
  [1.6, 0.06],
  [1.82, 0],
];
/** Mit jeder zweiten Silbe eine Welle: Start in Sekunden; sie läuft `WAVE_S` lang hinaus. */
const WAVE_STARTS = [0.14, 0.7, 1.26];
const WAVE_S = 1.9;
/** Mittelpunkt und Weg der Bögen — Googles Bogen: Mitte (−10 | 103), Halbmesser bis 80. */
const WAVE_CX = -10;
const WAVE_CY = 103;
const WAVE_R0 = 30;
const WAVE_R1 = 80;
/** Der Bogen spannt 124° nach links („("), von unten nach oben. */
const WAVE_A0 = (123 * Math.PI) / 180;
const WAVE_A1 = (247 * Math.PI) / 180;
/** Blinzeln in der Pause: zu in 90 ms, auf in 150 ms — wie ein Mensch. */
const BLINK_AT = 2.6;
const BLINK_CLOSE = 0.09;
const BLINK_OPEN = 0.15;

/** Öffnung des Mundes zur Sekunde `sec` im Satz. */
function mouthOpen(sec: number): number {
  "worklet";
  for (let i = 1; i < MOUTH_KEYS.length; i++) {
    const [t1, v1] = MOUTH_KEYS[i]!;
    if (sec <= t1) {
      const [t0, v0] = MOUTH_KEYS[i - 1]!;
      const f = (sec - t0) / (t1 - t0);
      return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * f));
    }
  }
  return 0;
}

/**
 * Der Mund als EIN Pfad: oben das Lächeln, unten dasselbe Lächeln, um die
 * Öffnung tiefer gezogen. Geschlossen liegen beide aufeinander — dann ist es
 * genau `FACE_SMILE`; offen wird daraus eine gefüllte Schale. Kein Skalieren,
 * kein Drehpunkt: Vorher wuchs ein zweiter Mund per `scaleY` um einen
 * `transformOrigin` — am Gerät flog er dabei von oben herein.
 */
function mouthPath(o: number): string {
  "worklet";
  const dy = o * 11;
  const k = dy * 0.35;
  // Die Oberlippe hebt sich ein wenig mit, sonst wirkt der Mund wie ein Kinnladen-Klappen.
  const u = dy * 0.1;
  const f = (v: number) => v.toFixed(2);
  return (
    `M79 112 C81.75 ${f(113.3 - u * 0.4)} 89.9 ${f(120.3 - u)} 95.5 ${f(119.8 - u)} ` +
    `C101.1 ${f(119.3 - u)} 109.75 ${f(110.8 - u * 0.4)} 112.6 109 ` +
    `C109.75 ${f(110.8 + k)} 101.1 ${f(119.3 + dy)} 95.5 ${f(119.8 + dy)} ` +
    `C89.9 ${f(120.3 + dy)} 81.75 ${f(113.3 + k)} 79 112 Z`
  );
}

/** Wie weit die Augen offen sind (1 = offen). */
function eyeOpen(sec: number): number {
  "worklet";
  const d = sec - BLINK_AT;
  if (d <= 0 || d >= BLINK_CLOSE + BLINK_OPEN) return 1;
  return d < BLINK_CLOSE ? 1 - d / BLINK_CLOSE : (d - BLINK_CLOSE) / BLINK_OPEN;
}

/** Ein Wellenbogen mit Halbmesser `r` um die Mitte der Wellen. */
function waveArc(r: number): string {
  "worklet";
  const x1 = WAVE_CX + r * Math.cos(WAVE_A0);
  const y1 = WAVE_CY + r * Math.sin(WAVE_A0);
  const x2 = WAVE_CX + r * Math.cos(WAVE_A1);
  const y2 = WAVE_CY + r * Math.sin(WAVE_A1);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}
const WAVE_REST = waveArc(WAVE_R0);
const MOUTH_REST = mouthPath(0);

/**
 * Mikrofon: Googles Gesicht. Erst zeichnet es sich (ruhig, Strich für Strich),
 * dann spricht es: Der Mund geht in Silben auf und zu, mit den Silben laufen
 * Bögen nach links hinaus und verblassen, in der Pause blinzelt es.
 *
 * Bewegt wird die ZEICHNUNG selbst (Pfad, Augenhöhe, Bogen), nicht Hüllen per
 * Skalieren um einen `transformOrigin` — das flog am Gerät (04.11.2026,
 * „von oben kommt immer was reingeflogen", „viel zu schnell"). Alles Bewegte
 * liegt in einer eigenen Zeichenfläche; die gezeichneten Striche bleiben
 * unberührt und werden nicht in jedem Bild neu gerastert.
 */
function TalkArt({ play }: { play: boolean }) {
  const accent = useAccent();
  const eyesIn = useFade(play, 1200);
  const mouthIn = useFade(play, 1700);
  const clock = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      cancelAnimation(clock);
      return;
    }
    clock.value = withDelay(
      ART_START + TALK_START_MS,
      withRepeat(withTiming(1, { duration: TALK_PERIOD_S * 1000, easing: Easing.linear }), -1, false),
    );
  }, [play, clock]);
  const mouth = useAnimatedProps(() => ({
    d: mouthPath(mouthOpen(clock.value * TALK_PERIOD_S)),
    fillOpacity: mouthIn.value,
    strokeOpacity: mouthIn.value,
  }));
  return (
    <View style={styles.artWide}>
      <Layer viewBox={TALK_VIEWBOX}>
        <DrawPath d={FACE_OUTLINE} len={165.2} color={accent.solid} play={play} delay={0} duration={950} />
        <DrawPath d={FACE_BROW_L} len={38.4} color={accent.solid} play={play} delay={650} duration={420} />
        <DrawPath d={FACE_BROW_R} len={38.1} color={accent.solid} play={play} delay={780} duration={420} />
        <DrawPath d={FACE_NOSE} len={30.8} color={accent.solid} play={play} delay={1000} duration={380} />
        <DrawPath d={FACE_SMILE} len={39} color={accent.solid} play={play} delay={1250} duration={420} />
      </Layer>
      <Layer viewBox={TALK_VIEWBOX}>
        {/* Geschlossen deckt er das gezeichnete Lächeln genau — der Wechsel ist unsichtbar. */}
        <AnimatedPath
          d={MOUTH_REST}
          stroke={accent.solid}
          fill={accent.solid}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          fillOpacity={0}
          strokeOpacity={0}
          animatedProps={mouth}
        />
        <TalkEye cx={48.4} cy={59.5} clock={clock} shown={eyesIn} color={accent.solid} />
        <TalkEye cx={132.7} cy={51.1} clock={clock} shown={eyesIn} color={accent.solid} />
        {WAVE_STARTS.map((_, i) => (
          <TalkWave key={i} index={i} clock={clock} color={accent.solid} />
        ))}
      </Layer>
    </View>
  );
}

/** Ein Auge: blinzelt über seine Höhe, nicht über ein Skalieren der Hülle. */
function TalkEye({
  cx,
  cy,
  clock,
  shown,
  color,
}: {
  cx: number;
  cy: number;
  clock: SharedValue<number>;
  shown: SharedValue<number>;
  color: string;
}) {
  const props = useAnimatedProps(() => ({
    ry: 6 * (0.12 + 0.88 * eyeOpen(clock.value * TALK_PERIOD_S)),
    fillOpacity: shown.value,
  }));
  return <AnimatedEllipse cx={cx} cy={cy} rx={6} ry={6} fill={color} fillOpacity={0} animatedProps={props} />;
}

/**
 * Eine Welle: läuft vom Gesicht weg nach links hinaus — gleichmäßig, leicht
 * ausrollend —, blendet kurz auf und verblasst, wird dabei etwas feiner.
 * Zwischen ihren Auftritten steht sie unsichtbar still (keine Bild-Updates).
 */
function TalkWave({ index, clock, color }: { index: number; clock: SharedValue<number>; color: string }) {
  const props = useAnimatedProps(() => {
    const u = (clock.value * TALK_PERIOD_S - WAVE_STARTS[index]!) / WAVE_S;
    if (u <= 0 || u >= 1) return { d: WAVE_REST, strokeOpacity: 0, strokeWidth: 5.5 };
    // Sanft ausrollend, aber ohne Stau außen: Die Bögen bleiben gleich gestaffelt.
    const e = 1 - Math.pow(1 - u, 1.5);
    // Kurz aufblenden, dann stetig verblassen — am Ende ist nichts mehr da, kein Rest am Rand.
    const a = 0.7 * Math.min(1, u / 0.15) * Math.pow(1 - u, 1.2);
    return { d: waveArc(WAVE_R0 + (WAVE_R1 - WAVE_R0) * e), strokeOpacity: a, strokeWidth: 5.5 - 1.5 * e };
  });
  return (
    <AnimatedPath
      d={WAVE_REST}
      stroke={color}
      strokeOpacity={0}
      strokeWidth={5.5}
      strokeLinecap="round"
      fill="none"
      animatedProps={props}
    />
  );
}

/** Mitteilungen: eine Glocke mit Klöppel, daneben die Klangbögen; sie läutet ab und zu. */
function BellArt({ play }: { play: boolean }) {
  const accent = useAccent();
  const ring = useSharedValue(0);
  useEffect(() => {
    if (!play) {
      cancelAnimation(ring);
      return;
    }
    const swing = withSequence(
      withTiming(12, { duration: 110 }),
      withTiming(-10, { duration: 140 }),
      withTiming(6, { duration: 120 }),
      withTiming(-3, { duration: 110 }),
      withTiming(0, { duration: 100 }),
    );
    // Erst wenn sie gezeichnet ist, dann ruhig alle paar Sekunden.
    ring.value = withDelay(ART_START + 1400, withRepeat(withSequence(swing, withTiming(0, { duration: 2600 })), -1, false));
  }, [play, ring]);
  // Um den Knauf (100 | 50) — als Verschiebung hin und zurück, ohne `transformOrigin` (siehe `ART_GRID`).
  const bell = useAnimatedStyle(() => ({
    transform: [{ translateY: BELL_PIVOT_Y }, { rotate: `${ring.value}deg` }, { translateY: -BELL_PIVOT_Y }],
  }));
  return (
    <View style={styles.art}>
      <Layer>
        <DrawPath d="M34.22 72.06 A70 70 0 0 1 59.85 38.66" len={42.8} color={FAINT} play={play} delay={1000} duration={350} />
        <DrawPath d="M140.15 38.66 A70 70 0 0 1 165.78 72.06" len={42.8} color={FAINT} play={play} delay={1000} duration={350} />
      </Layer>
      {/* Die Glocke hängt am Knauf — dort dreht sie sich. */}
      <Animated.View style={[StyleSheet.absoluteFill, bell]}>
        <Layer>
          <DrawPath
            d="M54 140 L66 124 L66 92 A34 34 0 0 1 134 92 L134 124 L146 140 Z"
            len={302.8}
            color={accent.solid}
            play={play}
            delay={0}
            duration={950}
          />
          <DrawPath d="M100 58 L100 50" len={8} color={accent.solid} play={play} delay={850} duration={150} />
          <DrawPath d="M88 150 A12 12 0 0 0 112 150" len={37.7} color={accent.solid} play={play} delay={900} duration={300} />
        </Layer>
      </Animated.View>
    </View>
  );
}

/** Fotos: zwei Bilder übereinander, vorn Berge und Sonne; die Sonne glimmt sacht. */
function PhotoArt({ play }: { play: boolean }) {
  const accent = useAccent();
  const palette = usePalette();
  const glow = useLoop(play, 1500, () =>
    withSequence(
      withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.quad) }),
      withTiming(0, { duration: 1200, easing: Easing.inOut(Easing.quad) }),
    ),
  );
  // Um die Mitte der Sonne (112 | 92), ohne `transformOrigin`.
  const sun = useAnimatedStyle(() => ({
    transform: [
      { translateX: SUN_PIVOT_X },
      { translateY: SUN_PIVOT_Y },
      { scale: 1 + 0.12 * glow.value },
      { translateX: -SUN_PIVOT_X },
      { translateY: -SUN_PIVOT_Y },
    ],
  }));
  return (
    <View style={styles.art}>
      <Layer>
        <DrawPath
          d="M70 40 L154 40 A12 12 0 0 1 166 52 L166 116 A12 12 0 0 1 154 128 L70 128 A12 12 0 0 1 58 116 L58 52 A12 12 0 0 1 70 40 Z"
          len={371.4}
          color={FAINT}
          play={play}
          delay={0}
          duration={800}
        />
        <DrawPath
          d="M46 66 L130 66 A12 12 0 0 1 142 78 L142 142 A12 12 0 0 1 130 154 L46 154 A12 12 0 0 1 34 142 L34 78 A12 12 0 0 1 46 66 Z"
          len={371.4}
          color={accent.solid}
          play={play}
          delay={200}
          duration={950}
          fill={palette.s1}
        />
        <DrawPath
          d="M46 142 L74 110 L94 130 L108 116 L130 142"
          len={124.7}
          color={accent.solid}
          play={play}
          delay={950}
          duration={500}
        />
      </Layer>
      <Animated.View style={[StyleSheet.absoluteFill, sun]}>
        <Layer>
          <DrawPath d="M103 92 A9 9 0 1 1 121 92 A9 9 0 1 1 103 92" len={56.6} color={accent.solid} play={play} delay={1150} duration={350} />
        </Layer>
      </Animated.View>
    </View>
  );
}

const styles = scaledStyles({
  /** Über Blättern und Wählern, unter den Meldungen oben. */
  layer: { zIndex: 10000, elevation: 50, shadowColor: "transparent" },
  scrim: { backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
  },
  /** Ränder und Schriftgrade wie bei Google: viel Luft, ruhige große Überschrift. */
  /** Oben und seitlich wie die übrigen Blätter (Kopfzeile: GUTTER). */
  body: { flex: 1, paddingHorizontal: GUTTER, paddingTop: GUTTER },
  title: { fontSize: 30, lineHeight: 38, fontWeight: "400", color: WHITE, letterSpacing: -0.3 },
  text: { marginTop: TITLE_GAP, fontSize: 15.5, lineHeight: 22, color: G2 },
  stage: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: GROUP_GAP },
  art: { width: 200, height: 200 },
  /** Mikrofon: links Platz für die Wellen (siehe `TALK_VIEWBOX`, 254 × 200 Einheiten). */
  artWide: { width: 254, height: 200 },
  primary: {
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  primaryText: { fontSize: 16, fontWeight: "600" },
  secondary: { height: 48, marginTop: ITEM_GAP, alignItems: "center", justifyContent: "center" },
  secondaryText: { fontSize: 16, fontWeight: "600" },
  secondaryOff: { opacity: 0.4 },
});
