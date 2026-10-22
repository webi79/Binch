/**
 * GlideToast — die Bestätigungs-Meldung der App (Premium-Glide).
 *
 *  - gleitet herein, oben oder unten — wie in den Einstellungen gewählt
 *    („Speicher-Bestätigung", Vorgabe oben)
 *  - nach dem Hereingleiten pulst der Ring einmal, das Häkchen zeichnet sich
 *  - steht kurz und gleitet von selbst wieder hinaus, ERST DANACH abgebaut
 *  - lässt sich zum Rand hin wegwischen (oben: nach oben)
 *
 * Herein und hinaus sind Spiegelbilder mit derselben Dauer: herein weich
 * abbremsend, hinaus weich anfahrend. Vorher lief die Ausfahrt mit der
 * Einfahrts-Kurve (schießt los, bremst dann) — der sichtbare Teil war damit in
 * einem Augenblick vorbei, „das Rausfliegen wirkt komisch".
 *
 * Das Aussehen ist das der früheren „Ticket gespeichert"-Meldung, unverändert —
 * jetzt für alle Bestätigungen (Ticket, Station, Preisalarm). Die Stations-
 * Meldung hatte vorher eine eigene Fassung mit dem klassischen `Animated`,
 * dessen nativer Treiber auf der neuen Architektur am Startwert hängen blieb:
 * Sie stand bei Deckkraft 0 und war nie zu sehen.
 */
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { useSearchStore } from "@/stores/searchStore";

const AnimatedPath = Animated.createAnimatedComponent(Path);

const HOLD_MS = 2600;
/** Herein UND hinaus — dieselbe Dauer, gespiegelte Kurven (`ENTER_EASE`/`EXIT_EASE`). */
const SLIDE_DURATION = 420;
const ENTER_EASE = Easing.out(Easing.cubic);
const EXIT_EASE = Easing.in(Easing.cubic);
/** Nach dem Loslassen eines Wischs, der nicht weit genug war: so lange steht sie noch. */
const RESUME_HOLD_MS = 1600;
/** Ab so viel Weg (dp) oder Tempo (dp/s) zum Rand hin gilt ein Wisch als „weg". */
const SWIPE_DISTANCE = 28;
const SWIPE_VELOCITY = 500;
const RING_DURATION = 420;
const CHECK_DURATION = 280;
const CHECK_LEN = 26;

const SURFACE = "#171719";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT_PRIMARY = "#F4F4F5";
const TEXT_TERTIARY = "#8E8E93";
const ICON_INK = "#123007";

/**
 * Beide Richtungen über EIGENE Werte, keine Ein-/Aussprung-Animation.
 *
 * Mit eigenen Werten bestimmen wir selbst, wann abgebaut wird: Die Meldung
 * gleitet hinaus, und ERST DANACH verschwindet sie — Reanimated hält nichts
 * fest, weil gar keine Ein-/Aussprung-Animation im Spiel ist.
 *
 * Der Weg reicht knapp über den Bildrand (Höhe der Meldung, ihr Abstand zum
 * Rand und etwas Luft) statt fest 200 dp: Bei gleicher Dauer ist sie damit
 * langsamer unterwegs — der ruhigere Teil der Bewegung ist der sichtbare.
 */
const TOAST_HEIGHT = 84;

export interface GlideToastProps {
  title: string;
  subtitle?: ReactNode;
  /** Knopf rechts („Ansehen") — der Aufrufer baut die Meldung dann selbst ab. */
  actionLabel?: string;
  onAction?: () => void;
  /** Nach dem Hinausgleiten: abbauen. */
  onHidden: () => void;
  holdMs?: number;
}

export function GlideToast({ title, subtitle, actionLabel, onAction, onHidden, holdMs = HOLD_MS }: GlideToastProps) {
  const insets = useSafeAreaInsets();
  const accent = useAccent();
  const palette = usePalette();
  const atBottom = useSearchStore((s) => s.savedToastPosition) === "bottom";
  const edge = atBottom ? ms(TAB_BAR_H) + insets.bottom + 10 : (insets.top || 0) + 10;
  const travel = (atBottom ? 1 : -1) * (edge + ms(TOAST_HEIGHT) + 16);

  /** Position und Deckkraft der Meldung — siehe Begründung oben. */
  const ty = useSharedValue(travel);
  const op = useSharedValue(0);
  const toastStyle = useAnimatedStyle(() => ({
    // Ausblenden folgt der Lage: Beim Hinausgleiten wie beim Wegwischen wird
    // sie zum Rand hin durchsichtig, nie mitten auf dem Bildschirm.
    opacity:
      op.value *
      interpolate(Math.abs(ty.value), [0, Math.abs(travel) * 0.4, Math.abs(travel)], [1, 1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: ty.value }],
  }));

  // Neuester Rückruf über eine Ablage — ein neuer Rückruf des Aufrufers darf
  // Hereingleiten und Haltezeit nicht neu starten.
  const onHiddenRef = useRef(onHidden);
  onHiddenRef.current = onHidden;
  /**
   * Hinausgleiten und ERST DANACH abbauen. Der Riegel fängt den Fall ab, dass
   * die Haltezeit abläuft, während schon von Hand geschlossen wurde.
   */
  const closingRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Die Haltezeit — ruht, solange ein Finger auf der Meldung liegt. */
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideOut = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    ty.value = withTiming(travel, { duration: SLIDE_DURATION, easing: EXIT_EASE });
    hideTimer.current = setTimeout(() => onHiddenRef.current(), SLIDE_DURATION);
  }, [ty, travel]);
  /** Weggewischt: mit dem Schwung des Fingers hinaus, dann abbauen. */
  const flungOut = useCallback((dur: number) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    hideTimer.current = setTimeout(() => onHiddenRef.current(), dur);
  }, []);
  const holdOn = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = null;
  }, []);
  const holdOff = useCallback(() => {
    if (closingRef.current) return;
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    dismissTimer.current = setTimeout(slideOut, RESUME_HOLD_MS);
  }, [slideOut]);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
    },
    [],
  );

  const ring = useSharedValue(0);
  const check = useSharedValue(0);

  useEffect(() => {
    // Innere Animationen erst nach dem Hereingleiten starten (UI-Thread via withDelay).
    ring.value = withDelay(
      SLIDE_DURATION,
      withTiming(1, { duration: RING_DURATION, easing: Easing.out(Easing.ease) }),
    );
    check.value = withDelay(
      SLIDE_DURATION,
      withTiming(1, { duration: CHECK_DURATION, easing: Easing.out(Easing.cubic) }),
    );
    // Hereingleiten im nächsten Bild — der Baum steht dann, die Bewegung läuft
    // nicht gegen seinen Aufbau an.
    const raf = requestAnimationFrame(() => {
      op.value = 1;
      ty.value = withTiming(0, { duration: SLIDE_DURATION, easing: ENTER_EASE });
    });
    dismissTimer.current = setTimeout(slideOut, holdMs);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimation(ring);
      cancelAnimation(check);
    };
  }, [ring, check, ty, op, slideOut, holdMs]);

  /**
   * Wegwischen zum Rand hin. Folgt dem Finger; in die andere Richtung nur
   * gedämpft (ein Fünftel). Weit oder schnell genug → mit dem Schwung des
   * Fingers hinaus; sonst zurück an ihren Platz, und die Haltezeit läuft neu.
   * Erst nach ein paar Punkten senkrechter Bewegung aktiv — ein Tipp auf
   * „Ansehen" bleibt ein Tipp.
   */
  /** Wo sie beim Zugreifen stand — sie kann noch unterwegs sein. */
  const grabY = useSharedValue(0);
  const pan = useMemo(() => {
    const dir = atBottom ? 1 : -1;
    return Gesture.Pan()
      .activeOffsetY([-6, 6])
      .failOffsetX([-24, 24])
      .onStart(() => {
        cancelAnimation(ty);
        grabY.value = ty.value;
        runOnJS(holdOn)();
      })
      .onUpdate((e) => {
        const d = grabY.value + e.translationY;
        ty.value = d * dir > 0 ? d : d * 0.2;
      })
      .onEnd((e) => {
        const toward = ty.value * dir;
        const fling = e.velocityY * dir;
        if (toward > SWIPE_DISTANCE || fling > SWIPE_VELOCITY) {
          // Mit dem Tempo des Fingers weiter: Anfangstempo von `out(quad)` ist
          // 2 · Weg / Dauer — so gewählt, dass es dort anschließt.
          const rest = Math.abs(travel - ty.value);
          const speed = Math.max(Math.abs(e.velocityY), 900);
          const dur = Math.min(320, Math.max(140, (2 * rest * 1000) / speed));
          ty.value = withTiming(travel, { duration: dur, easing: Easing.out(Easing.quad) });
          runOnJS(flungOut)(dur);
          return;
        }
        ty.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
        runOnJS(holdOff)();
      });
  }, [atBottom, travel, ty, grabY, holdOn, holdOff, flungOut]);

  const onPressAction = useCallback(() => {
    cancelAnimation(ring);
    cancelAnimation(check);
    onAction?.();
  }, [ring, check, onAction]);

  const ringStyle = useAnimatedStyle(() => {
    const r = ring.value;
    const scale = r < 0.35 ? 0.7 + (r / 0.35) * 0.3 : 1 + ((r - 0.35) / 0.65) * 0.5;
    const opacity = r < 0.2 ? (r / 0.2) * 0.9 : 0.9 * (1 - (r - 0.2) / 0.8);
    return { opacity, transform: [{ scale }] };
  });

  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_LEN * (1 - check.value),
  }));

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFillObject, styles.host]}>
      <GestureDetector gesture={pan}>
      <Animated.View style={[styles.layer, atBottom ? { bottom: edge } : { top: edge }, toastStyle]}>
        {/* Box-Ton, nicht die Stufe darüber: Eine Meldung ist eine Box, die
            über dem Bildschirm schwebt — ihr Rand und ihr Schatten heben sie
            ab, nicht ein hellerer Grauton. */}
        <View style={[styles.toast, { backgroundColor: palette.s2 }]}>
          <View style={styles.iconWrap}>
            <Animated.View style={[styles.ring, { borderColor: accent.solid }, ringStyle]} />
            <View style={[styles.iconBox, { backgroundColor: accent.solid }]}>
              <Svg width={34} height={34} viewBox="0 0 24 24">
                <AnimatedPath
                  d="M6 12.5 l4 4 l8 -8.5"
                  fill="none"
                  stroke={ICON_INK}
                  strokeWidth={4.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={CHECK_LEN}
                  animatedProps={checkProps}
                />
              </Svg>
            </View>
          </View>

          <View style={styles.body}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text style={styles.sub} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>

          {actionLabel && onAction ? (
            <TouchableOpacity onPress={onPressAction} hitSlop={10}>
              <Text style={styles.cta}>{actionLabel}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = scaledStyles({
  /**
   * Über allen Blättern: Android sortiert nach Höhe vor `zIndex`. Der
   * Ortswähler (40) verdeckte sonst die Bestätigung seines eigenen Sterns, das
   * Haltestellen-Blatt (20) ganz aufgezogen die aus dem Blatt. Die Hülle hat
   * keine Fläche, zeichnet also keinen Schatten.
   */
  host: {
    zIndex: 10000,
    elevation: 60,
  },
  layer: {
    position: "absolute",
    left: 14,
    right: 14,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: SURFACE,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 14,
    paddingLeft: 14,
    paddingRight: 18,
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 32,
  },
  iconWrap: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 66,
    height: 66,
    borderRadius: 22,
    borderWidth: 2,
  },
  iconBox: {
    width: 54,
    height: 54,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  sub: {
    color: TEXT_TERTIARY,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  cta: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    textDecorationLine: "underline",
    paddingHorizontal: 4,
  },
});
