/**
 * Hinweise zum ZUSTAND der App: Mitteilungen an oder aus, Verbindung weg oder
 * wieder da.
 *
 * Bewusst nicht im Ticket-Design der Bestätigungen (`GlideToast`): Das sagt
 * „erledigt", dieses hier „so steht es gerade". Darum die Form einer
 * Mitteilung, Symbol im Kreis, Titel und eine Zeile. Fläche, Rand und Fahrt von
 * oben sind dieselben wie dort, damit es zur App gehört.
 *
 * Die Verbindung hat Vorrang: Fehlt sie, bleibt der Hinweis stehen, bis sie
 * zurück ist, und wird dann an Ort und Stelle zu „Wieder verbunden".
 *
 * Wie jede Meldung lässt er sich nach oben wegwischen — dieselben Schwellen wie
 * `GlideToast`. Ein Finger darauf hält die Haltezeit an.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  FadeIn,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { RESUME_HOLD_MS, SWIPE_DISTANCE, SWIPE_VELOCITY } from "@/components/ui/GlideToast";
import { Bell, BellOff, Building2, Wifi, WifiOff } from "lucide-react-native";
import { useConnectivity } from "@/lib/net/connectivity";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";

/** Hinweise, die über einem BLATT erscheinen (siehe `showSheetStatus`). */
type SheetKind = "buildingsSatellite" | "buildingsSaver";
type Kind = "notifyOn" | "notifyOff" | "offline" | "unreachable" | "online" | SheetKind;
type Shown = { kind: Kind; key: number };

const SURFACE = "#171719";
const BORDER = "rgba(255,255,255,0.08)";
const WHITE = "#F4F4F5";
const G2 = "#8E8E93";
const WARN = "#F5A142";
/** Dieselbe Fahrt wie `GlideToast`. */
const SLIDE_IN = { duration: 420, easing: Easing.out(Easing.cubic) };
const SLIDE_OUT = { duration: 320, easing: Easing.in(Easing.cubic) };
const PARK = -180;
const HOLD_MS = 2600;
const BACK_HOLD_MS = 1800;
/** So lange muss die Verbindung fehlen, bevor es jemand erfährt — ein Aussetzer ist keine Meldung wert. */
const LOST_AFTER_MS = 1500;
const CONTENT_SWAP = FadeIn.duration(180);

const listeners = new Set<(s: Shown) => void>();

/** Mitteilungen ein- oder ausgeschaltet — die Bestätigung oben. */
export function showStatusToast(kind: "notifyOn" | "notifyOff"): void {
  const shown = { kind, key: Date.now() };
  for (const fn of listeners) fn(shown);
}

const sheetListeners = new Set<(s: Shown) => void>();

/**
 * Ein Hinweis, während ein Blatt offen ist — etwa „3D-Gebäude gibt es im
 * Satellitenbild nicht", wenn man den gesperrten Schalter antippt.
 *
 * Eigener Weg, weil die Blätter (`SheetModal`) EIGENE Fenster sind: Der
 * Gastgeber am Wurzel-Layout läge darunter und wäre unsichtbar. Jedes Blatt
 * trägt deshalb seinen eigenen (`SheetStatusHost`). Form, Fahrt und Wischen
 * sind dieselben wie oben.
 */
export function showSheetStatus(kind: SheetKind): void {
  const shown = { kind, key: Date.now() };
  for (const fn of sheetListeners) fn(shown);
}

/** Der Gastgeber IM Fenster eines Blattes — siehe `showSheetStatus`. */
export function SheetStatusHost() {
  const [shown, setShown] = useState<Shown | null>(null);
  useEffect(() => {
    const fn = (s: Shown) => setShown(s);
    sheetListeners.add(fn);
    return () => {
      sheetListeners.delete(fn);
    };
  }, []);
  if (!shown) return null;
  const key = shown.key;
  return (
    <StatusCard
      key={key}
      kind={shown.kind}
      hold={HOLD_MS}
      onHidden={() => setShown((cur) => (cur?.key === key ? null : cur))}
    />
  );
}

export function StatusToastHost() {
  const conn = useConnectivity();
  const [shown, setShown] = useState<Shown | null>(null);
  /** Läuft gerade ein Verbindungs-Hinweis? Dann gehört die Karte ihm. */
  const lostKey = useRef<number | null>(null);

  useEffect(() => {
    const fn = (s: Shown) => {
      if (lostKey.current === null) setShown(s);
    };
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (conn === "online") {
      const key = lostKey.current;
      if (key === null) return;
      lostKey.current = null;
      // Dieselbe Karte, neuer Inhalt — sie fährt nicht noch einmal herein.
      setShown({ kind: "online", key });
      return;
    }
    const id = setTimeout(() => {
      const key = lostKey.current ?? Date.now();
      lostKey.current = key;
      setShown({ kind: conn, key });
    }, LOST_AFTER_MS);
    return () => clearTimeout(id);
  }, [conn]);

  if (!shown) return null;
  const hold = shown.kind === "offline" || shown.kind === "unreachable" ? null : shown.kind === "online" ? BACK_HOLD_MS : HOLD_MS;
  const key = shown.key;
  return (
    <StatusCard
      key={key}
      kind={shown.kind}
      hold={hold}
      onHidden={() => setShown((cur) => (cur?.key === key ? null : cur))}
    />
  );
}

function StatusCard({ kind, hold, onHidden }: { kind: Kind; hold: number | null; onHidden: () => void }) {
  const t = useT();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const y = useSharedValue(PARK);
  const ring = useSharedValue(0);
  /** Wo sie beim Zugreifen stand — sie kann noch unterwegs sein. */
  const grabY = useSharedValue(0);
  const hiddenRef = useRef(onHidden);
  hiddenRef.current = onHidden;
  /** Riegel: Haltezeit und Wischen dürfen nicht beide abbauen. */
  const closing = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slideOut = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    y.value = withTiming(PARK, SLIDE_OUT);
    hideTimer.current = setTimeout(() => hiddenRef.current(), SLIDE_OUT.duration);
  }, [y]);
  /** Weggewischt: Die Fahrt läuft schon, nur noch abbauen, wenn sie draußen ist. */
  const flungOut = useCallback((dur: number) => {
    if (closing.current) return;
    closing.current = true;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    hideTimer.current = setTimeout(() => hiddenRef.current(), dur);
  }, []);
  const holdOn = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }, []);
  const holdOff = useCallback(() => {
    if (closing.current || hold === null) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(slideOut, RESUME_HOLD_MS);
  }, [hold, slideOut]);

  useEffect(() => {
    y.value = withTiming(0, SLIDE_IN);
  }, [y]);

  // Die Glocke läutet einmal kurz, sobald die Karte steht — mehr Bewegung nicht.
  useEffect(() => {
    if (kind !== "notifyOn") return;
    ring.value = withDelay(
      SLIDE_IN.duration - 80,
      withSequence(
        withTiming(14, { duration: 90 }),
        withTiming(-12, { duration: 110 }),
        withTiming(8, { duration: 100 }),
        withTiming(-4, { duration: 90 }),
        withTiming(0, { duration: 80 }),
      ),
    );
  }, [kind, ring]);

  // Haltezeit — fehlt bei „offline", der Hinweis bleibt dann bis zur Rückkehr.
  useEffect(() => {
    if (hold === null) return;
    holdTimer.current = setTimeout(slideOut, SLIDE_IN.duration + hold);
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, [hold, kind, slideOut]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  /** Erst nach ein paar Punkten senkrechter Bewegung aktiv; nach unten nur mit Widerstand. */
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-6, 6])
        .failOffsetX([-24, 24])
        .onStart(() => {
          cancelAnimation(y);
          grabY.value = y.value;
          runOnJS(holdOn)();
        })
        .onUpdate((e) => {
          const d = grabY.value + e.translationY;
          y.value = d < 0 ? d : d * 0.2;
        })
        .onEnd((e) => {
          if (-y.value > SWIPE_DISTANCE || -e.velocityY > SWIPE_VELOCITY) {
            // Mit dem Tempo des Fingers weiter — wie bei `GlideToast`.
            const rest = Math.abs(PARK - y.value);
            const speed = Math.max(Math.abs(e.velocityY), 900);
            const dur = Math.min(320, Math.max(140, (2 * rest * 1000) / speed));
            y.value = withTiming(PARK, { duration: dur, easing: Easing.out(Easing.quad) });
            runOnJS(flungOut)(dur);
            return;
          }
          y.value = withTiming(0, { duration: 260, easing: Easing.out(Easing.cubic) });
          runOnJS(holdOff)();
        }),
    [y, grabY, holdOn, holdOff, flungOut],
  );

  const cardStyle = useAnimatedStyle(() => ({
    // Zum Rand hin durchsichtig, beim Hinausgleiten wie beim Wegwischen.
    opacity: interpolate(-y.value, [0, -PARK * 0.4, -PARK], [1, 1, 0], Extrapolation.CLAMP),
    transform: [{ translateY: y.value }],
  }));
  const bellStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${ring.value}deg` }] }));

  const look = {
    notifyOn: { Icon: Bell, color: accent.solid, tint: accent.subtle },
    notifyOff: { Icon: BellOff, color: G2, tint: "rgba(255,255,255,0.06)" },
    offline: { Icon: WifiOff, color: WARN, tint: "rgba(245,161,66,0.16)" },
    unreachable: { Icon: WifiOff, color: WARN, tint: "rgba(245,161,66,0.16)" },
    online: { Icon: Wifi, color: accent.solid, tint: accent.subtle },
    // Sachlich, nicht als Warnung: Es ist nichts kaputt, es gibt es dort nur nicht.
    buildingsSatellite: { Icon: Building2, color: G2, tint: "rgba(255,255,255,0.06)" },
    buildingsSaver: { Icon: Building2, color: G2, tint: "rgba(255,255,255,0.06)" },
  }[kind];

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFillObject, styles.host]}>
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityLiveRegion="polite"
          style={[styles.card, { top: insets.top + SPACE.sm }, cardStyle]}
        >
          <Animated.View key={kind} entering={CONTENT_SWAP} style={styles.row}>
            <View style={[styles.icon, { backgroundColor: look.tint }]}>
              <Animated.View style={kind === "notifyOn" ? bellStyle : undefined}>
                <look.Icon size={18} color={look.color} strokeWidth={2.2} />
              </Animated.View>
            </View>
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={1}>
                {t(`status.${kind}.title`)}
              </Text>
              <Text style={styles.body} numberOfLines={2}>
                {t(`status.${kind}.body`)}
              </Text>
            </View>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = scaledStyles({
  /** Über allem, auch über den Blättern und Wählern — eine Höhe nur zum Sortieren. */
  host: { zIndex: 10001, elevation: 61, shadowColor: "transparent" },
  card: {
    position: "absolute",
    left: GUTTER,
    right: GUTTER,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: SURFACE,
    paddingVertical: SPACE.md,
    paddingLeft: SPACE.md,
    paddingRight: SPACE.lg,
  },
  row: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 14.5, fontWeight: "600", color: WHITE },
  body: { fontSize: 12.5, lineHeight: 17, color: G2, marginTop: 4 },
});
