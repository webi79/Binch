/**
 * Wann der Lader erscheint, wie lange er läuft und wie der Inhalt kommt —
 * EINE Regel für die ganze App (Nutzerwunsch 04.11.2026):
 *
 *  - Kommt die Antwort binnen `delayMs` (Standard 2 s), gibt es KEINEN Lader;
 *    der Inhalt blendet einfach weich ein.
 *  - Sonst erscheint der Lader — und wird nicht abgewürgt: Er läuft mindestens
 *    `minCycles` volle Durchläufe (Standard 2) und endet an der Grenze eines
 *    Durchlaufs („die wird nicht einfach abrupt beendet, wir lassen die
 *    durchlaufen 2 mal, so dass es angenehm ist").
 *  - Dann blendet er aus, und der Inhalt blendet ein.
 *
 * Alles Bewegte nur über Deckkraft (schneller Weg). `children` ist eine
 * Funktion: Der Inhalt wird erst gebaut, wenn er an der Reihe ist — vorher
 * dürfte er auf Daten zugreifen, die es noch nicht gibt.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GRID_CYCLE_MS, GridLoader } from "@/components/ui/GridLoader";

/** Bis dahin ohne Lader warten. */
export const LOAD_DELAY_MS = 2000;
/** So viele volle Durchläufe mindestens, wenn er einmal da ist. */
export const LOAD_MIN_CYCLES = 2;
const LEAVE_MS = 240;
const FADE_IN_MS = 280;
const EASE = Easing.out(Easing.quad);

/** wait = noch nichts zeigen · loader = Lader läuft · leaving = blendet aus · content = Inhalt. */
export type LoadPhase = "wait" | "loader" | "leaving" | "content";

export interface LoadGateState {
  phase: LoadPhase;
  /** Kam der Inhalt nach einer Ladephase? Dann blendet er ein (sonst steht er einfach da). */
  fresh: boolean;
  /** Vom Lader: fertig ausgeblendet. */
  onLeft: () => void;
}

export function useLoadGate(
  loading: boolean,
  { delayMs = LOAD_DELAY_MS, minCycles = LOAD_MIN_CYCLES }: { delayMs?: number; minCycles?: number } = {},
): LoadGateState {
  const [phase, setPhase] = useState<LoadPhase>(loading ? "wait" : "content");
  const [fresh, setFresh] = useState(false);
  const shownAt = useRef(0);

  // Gleich im Durchgang, nicht erst im Effekt: Sonst stünde ein Bild lang der
  // alte Inhalt (bzw. ein leerer) da, bevor gewartet wird.
  if (loading && phase === "content") setPhase("wait");
  else if (!loading && phase === "wait") {
    setPhase("content");
    setFresh(true);
  }

  // Warten → Lader.
  useEffect(() => {
    if (phase !== "wait") return;
    const id = setTimeout(() => {
      shownAt.current = Date.now();
      setPhase("loader");
    }, delayMs);
    return () => clearTimeout(id);
  }, [phase, delayMs]);

  // Lader → ausblenden: frühestens nach `minCycles`, und immer am Ende eines Durchlaufs.
  useEffect(() => {
    if (phase !== "loader" || loading) return;
    const elapsed = Date.now() - shownAt.current;
    const cycles = Math.max(minCycles, Math.ceil(elapsed / GRID_CYCLE_MS));
    const id = setTimeout(() => setPhase("leaving"), Math.max(0, cycles * GRID_CYCLE_MS - elapsed));
    return () => clearTimeout(id);
  }, [phase, loading, minCycles]);

  const onLeft = useCallback(() => {
    setFresh(true);
    setPhase((p) => (p === "leaving" ? "content" : p));
  }, []);

  // Sicherung: Meldet sich der Lader nicht ab (z. B. ausgehängt), kommt der Inhalt trotzdem.
  useEffect(() => {
    if (phase !== "leaving") return;
    const id = setTimeout(onLeft, LEAVE_MS + 200);
    return () => clearTimeout(id);
  }, [phase, onLeft]);

  return { phase, fresh, onLeft };
}

/** Der Lader im Tor: läuft, solange er dran ist, und blendet am Ende aus. */
export function GateLoader({
  phase,
  onLeft,
  style,
  children,
}: {
  phase: LoadPhase;
  onLeft: () => void;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const o = useSharedValue(1);
  useEffect(() => {
    if (phase !== "leaving") return;
    o.value = withTiming(0, { duration: LEAVE_MS, easing: EASE }, (done) => {
      if (done) runOnJS(onLeft)();
    });
  }, [phase, o, onLeft]);
  const fade = useAnimatedStyle(() => ({ opacity: o.value }));
  if (phase !== "loader" && phase !== "leaving") return null;
  return (
    <Animated.View style={[style, fade]} pointerEvents="none">
      {children}
    </Animated.View>
  );
}

/** Der Inhalt nach dem Laden: blendet ein — nur, wenn vorher geladen wurde. */
export function GateFade({
  fresh,
  style,
  children,
}: {
  fresh: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const o = useSharedValue(fresh ? 0 : 1);
  useEffect(() => {
    if (o.value < 1) o.value = withTiming(1, { duration: FADE_IN_MS, easing: EASE });
  }, [o]);
  const fade = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[style, fade]}>{children}</Animated.View>;
}

/**
 * Das Tor als ein Baustein: Fläche für Warten und Lader (füllt, Lader mittig),
 * danach der Inhalt.
 */
export function LoadGate({
  loading,
  delayMs,
  minCycles,
  loader,
  fill = false,
  style,
  contentStyle,
  children,
}: {
  loading: boolean;
  delayMs?: number;
  minCycles?: number;
  /** Eigener Lader (Standard: `GridLoader`). */
  loader?: ReactNode;
  /** Der Lader nimmt die ganze Fläche und richtet sich selbst aus (siehe `SheetLoader`). */
  fill?: boolean;
  /** Fläche für Warten und Lader. */
  style?: StyleProp<ViewStyle>;
  /** Hülle des Inhalts (z. B. `flex: 1`). */
  contentStyle?: StyleProp<ViewStyle>;
  children: () => ReactNode;
}) {
  const gate = useLoadGate(loading, { delayMs, minCycles });
  if (gate.phase === "content") {
    return (
      <GateFade fresh={gate.fresh} style={contentStyle}>
        {children()}
      </GateFade>
    );
  }
  return (
    <View style={[styles.area, style]} pointerEvents="none">
      <GateLoader phase={gate.phase} onLeft={gate.onLeft} style={fill ? StyleSheet.absoluteFill : undefined}>
        {loader ?? <GridLoader />}
      </GateLoader>
    </View>
  );
}

const styles = StyleSheet.create({
  /** Mittig in der verfügbaren Fläche — waagerecht und senkrecht. */
  area: { flex: 1, alignItems: "center", justifyContent: "center" },
});
