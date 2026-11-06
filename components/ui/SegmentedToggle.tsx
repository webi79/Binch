/**
 * Umschalter mit gleitender Pille — EIN Baustein für die ganze App: Reiseart im
 * Such-Blatt, feste/flexible Daten im Kalender, Hin/Rück in den Ergebnissen,
 * Reise/Tickets im Gespeichert-Reiter, Abfahrten/Ankünfte am Halt und die
 * Auswahlen in den Einstellungen.
 *
 * API:
 *   <SegmentedToggle
 *     items={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}
 *     selectedId="a"
 *     onChange={(id) => ...}
 *   />
 *
 * DEHNEN BEIM HALTEN: Liegt die Pille auf „Schwarz" und der Finger HÄLT
 * „Grau" gedrückt, reicht die Pille nach zwei Sekunden ein kleines Stück zu
 * „Grau" hinüber — langsam, wenige Punkte. Ein normaler Tipp dehnt nichts, er
 * gleitet nur. Beim Loslassen gleitet sie ganz hinüber; rutscht der Finger weg
 * (Scrollen, Ziehen am Blatt), zieht sie sich zurück. (Nutzerwunsch 28.10.:
 * nicht sofort, nicht so stark, eleganter.)
 *
 * Gedehnt wird OHNE animierte Breite. Die Pille besteht aus ZWEI gleich großen
 * Flächen übereinander, jede mit eigener Verschiebung: Die linke trägt die
 * linke Kante, die rechte die rechte. Liegen sie aufeinander, ist es eine
 * Pille; rückt eine hinaus, ist es eine längere Pille mit denselben Rundungen.
 * Eine animierte `width` fiele aus Reanimateds direktem Weg heraus und liefe
 * jedes Bild über den Schattenbaum (gemessen an den Reitern im Kalender, siehe
 * dort). `scaleX` verzerrte die Rundungen.
 *
 * Alles läuft auf dem UI-Strang. Die Berührung liest eine Tipp-Geste von
 * Gesture Handler, nicht `Pressable`: Die rendert bei jedem Drücken und
 * Loslassen neu, und dieser Commit schriebe die Lage der Pille zu spät zurück
 * (ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS). React erfährt nur das Ergebnis.
 *
 * Die Beschriftungen blenden mit der Pille über. Jede liegt zweimal da, ruhig
 * und hervorgehoben, und die Deckkraft folgt der Lage der Pille. Die Schrift
 * wechselt also genau dann, wenn die Pille darunter ankommt — auch wenn die
 * Auswahl erst danach gemeldet wird (`commitAfterSlide`).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, View, type ColorValue, type TextStyle, type ViewStyle, Platform } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { ms, scaledStyles } from "@/lib/ui/compact";
import type { LucideIcon } from "lucide-react-native";

export interface SegmentedToggleItem {
  id: string;
  label: string;
  /** Farbpunkt vor der Beschriftung (Akzentfarbe in den Einstellungen). */
  dot?: string;
  /** Zeichen vor der Beschriftung — in der Farbe der Schrift (Kartentyp-Blatt). */
  Icon?: LucideIcon;
}

interface Props {
  items: SegmentedToggleItem[];
  selectedId: string;
  onChange: (id: string) => void;
  /** Container background. Default: dunkles surface. */
  containerColor?: ColorValue;
  /** Farbe der Pille. Default: der Akzent. */
  pillColor?: ColorValue;
  /** Aktiver Text-Stil. Default: schwarz, fettgedruckt. */
  activeTextStyle?: TextStyle;
  /** Inaktiver Text-Stil. Default: gedimmtes grau. */
  inactiveTextStyle?: TextStyle;
  /** Padding um die Pill (gleichzeitig Abstand der Pill zu den Container-
   *  Rändern). Default: 4. */
  innerPadding?: number;
  /** Höhe pro Segment. Default: 38. */
  segmentHeight?: number;
  /** BorderRadius des Containers. Default: 14. Pill bekommt borderRadius
   *  automatisch leicht kleiner. */
  borderRadius?: number;
  /** Leuchten um die Pille (nur iOS). Default: true. */
  withShadow?: boolean;
  /**
   * Die Wahl erst melden, wenn die Pille angekommen ist.
   *
   * Für Wechsel, die die ganze App neu aufbauen (Design, Akzentfarbe): Ihr
   * Commit landete sonst mitten in der Fahrt und schriebe die Lage der Pille
   * zu spät zurück — sie zuckte. So fährt die Pille zuerst, und die App zieht
   * im Moment der Ankunft nach.
   */
  commitAfterSlide?: boolean;
  /**
   * Meldet die Wahl SOFORT beim Tipp — auch mit `commitAfterSlide`.
   *
   * Für Begleitbewegungen, die mit der Pille starten sollen, ohne dass dafür
   * gerendert wird (nur geteilte Werte setzen!). Der Commit selbst kommt
   * weiterhin über `onChange` nach der Fahrt (Kartentyp-Blatt: die Vorschau
   * blendet mit der Pille über).
   */
  onPick?: (id: string) => void;
  /** Tipp auf das schon gewählte Segment (Kartentyp: zurück auf „automatisch"). */
  onReselect?: (id: string) => void;
  /** Style des äußeren Containers (z.B. width/margin). */
  style?: ViewStyle;
}

const SLIDE = { duration: 220, easing: Easing.out(Easing.cubic) };
/**
 * Erst nach so langem Halten. Ein Tipp dauert 80–200 ms und ist vorbei, bevor
 * sich etwas dehnt; ein Langdruck beginnt bei Android erst ab ~400 ms — dazwischen
 * zeigt sich das Halten, ohne dass man darauf warten muss (2 s waren zu träge).
 */
const STRETCH_DELAY_MS = 320;
const STRETCH = { duration: 520, easing: Easing.inOut(Easing.cubic) };
const RELAX = { duration: 260, easing: Easing.out(Easing.cubic) };
/** Wie weit die Pille beim Halten hinüberreicht: Anteil einer Segmentbreite, höchstens `STRETCH_MAX`. */
const STRETCH_FRAC = 0.06;
const STRETCH_MAX = 7;

export function SegmentedToggle({
  items,
  selectedId,
  onChange,
  containerColor,
  pillColor,
  activeTextStyle,
  inactiveTextStyle,
  innerPadding = 4,
  segmentHeight = 38,
  borderRadius = 14,
  withShadow = true,
  commitAfterSlide = false,
  onPick,
  onReselect,
  style,
}: Props) {
  const palette = usePalette();
  const accent = useAccent();
  const [containerWidth, setContainerWidth] = useState(0);

  const count = items.length;
  const selectedIndex = Math.max(
    0,
    items.findIndex((i) => i.id === selectedId),
  );
  const segmentWidth = containerWidth > 0 ? (containerWidth - innerPadding * 2) / count : 0;

  /** Segmentbreite und -zahl für die Worklets. */
  const sw = useSharedValue(0);
  const n = useSharedValue(count);
  /** Wo die Pille steht bzw. hinfährt — die Wahl aus Sicht des UI-Strangs. */
  const cur = useSharedValue(selectedIndex);
  /** Verschiebung der linken und der rechten Fläche (siehe Dateikopf). */
  const left = useSharedValue(0);
  const right = useSharedValue(0);

  // Immer die aktuellen Werte, ohne die Geste bei jedem Durchgang neu zu bauen.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const deferRef = useRef(commitAfterSlide);
  deferRef.current = commitAfterSlide;
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onReselectRef = useRef(onReselect);
  onReselectRef.current = onReselect;
  /**
   * Wohin die Berührung die Pille zuletzt geschickt hat. Kommt dieselbe Wahl
   * danach als Eigenschaft zurück, fährt die Pille schon dorthin und darf
   * nicht neu angestoßen werden (sonst begänne die Kurve von vorn).
   */
  const touchTargetRef = useRef<number | null>(null);

  // Eigenschaft → Pille. Geschrieben wird nur bei Änderungen, nie bei jedem
  // Durchgang, und gelesen wird `.value` hier nie: Aus React heraus ist das ein
  // synchroner Sprung in die UI-Laufzeit, der beide Stränge kurz sperrt.
  const lastIndexRef = useRef(selectedIndex);
  const lastWidthRef = useRef(0);
  if (segmentWidth > 0) {
    if (lastWidthRef.current !== segmentWidth) {
      // Erstes Layout oder neue Breite (Drehung, andere Zahl der Segmente): sofort setzen, ohne Fahrt.
      sw.value = segmentWidth;
      n.value = count;
      cur.value = selectedIndex;
      left.value = selectedIndex * segmentWidth;
      right.value = selectedIndex * segmentWidth;
      lastWidthRef.current = segmentWidth;
      lastIndexRef.current = selectedIndex;
    } else if (selectedIndex !== lastIndexRef.current) {
      lastIndexRef.current = selectedIndex;
      if (touchTargetRef.current !== selectedIndex) {
        // Von außen gewechselt (oder per Bildschirmleser) — hinfahren.
        cur.value = selectedIndex;
        left.value = withTiming(selectedIndex * segmentWidth, SLIDE);
        right.value = withTiming(selectedIndex * segmentWidth, SLIDE);
      }
      touchTargetRef.current = null;
    }
  }

  /** Beim Loslassen auf einem anderen Segment. */
  const picked = useCallback((index: number) => {
    const item = itemsRef.current[index];
    if (!item) return;
    touchTargetRef.current = index;
    haptic("button");
    onPickRef.current?.(item.id);
    if (!deferRef.current) onChangeRef.current(item.id);
  }, []);
  const reselected = useCallback((index: number) => {
    const item = itemsRef.current[index];
    if (item) onReselectRef.current?.(item.id);
  }, []);
  /** Die Pille ist angekommen. */
  const arrived = useCallback((index: number) => {
    const item = itemsRef.current[index];
    if (item && deferRef.current) onChangeRef.current(item.id);
  }, []);

  const tap = useMemo(() => {
    const indexAt = (x: number) => {
      "worklet";
      const w = sw.value;
      if (w <= 0) return -1;
      return Math.min(n.value - 1, Math.max(0, Math.floor((x - innerPadding) / w)));
    };
    const relax = () => {
      "worklet";
      // Bricht auch eine noch wartende Dehnung ab — die neue Animation ersetzt sie.
      const x = cur.value * sw.value;
      left.value = withTiming(x, RELAX);
      right.value = withTiming(x, RELAX);
    };
    return (
      Gesture.Tap()
        // Gehalten werden darf beliebig lange — genau dann zeigt sich die Dehnung.
        .maxDuration(60_000)
        .maxDistance(24)
        .onBegin((e) => {
          "worklet";
          const j = indexAt(e.x);
          const i = cur.value;
          if (j < 0 || j === i) return;
          const w = sw.value;
          const s = Math.min(STRETCH_MAX, w * STRETCH_FRAC);
          if (j > i) right.value = withDelay(STRETCH_DELAY_MS, withTiming(i * w + s, STRETCH));
          else left.value = withDelay(STRETCH_DELAY_MS, withTiming(i * w - s, STRETCH));
        })
        .onEnd((e, success) => {
          "worklet";
          if (!success) return;
          const j = indexAt(e.x);
          if (j < 0 || j === cur.value) {
            relax();
            if (j >= 0) runOnJS(reselected)(j);
            return;
          }
          cur.value = j;
          const x = j * sw.value;
          left.value = withTiming(x, SLIDE);
          right.value = withTiming(x, SLIDE, (finished) => {
            "worklet";
            if (finished) runOnJS(arrived)(j);
          });
          runOnJS(picked)(j);
        })
        .onFinalize((_e, success) => {
          "worklet";
          if (!success) relax();
        })
    );
  }, [sw, n, cur, left, right, innerPadding, picked, arrived, reselected]);

  /** Bildschirmleser: Doppeltipp auf ein Segment. Derselbe Weg wie ein Fingertipp, nur von hier aus angestoßen. */
  const activate = useCallback(
    (index: number) => {
      if (index === selectedIndex || segmentWidth <= 0) return;
      cur.value = index;
      left.value = withTiming(index * segmentWidth, SLIDE);
      right.value = withTiming(index * segmentWidth, SLIDE, (finished) => {
        "worklet";
        if (finished) runOnJS(arrived)(index);
      });
      picked(index);
    },
    [selectedIndex, segmentWidth, cur, left, right, arrived, picked],
  );

  const leftStyle = useAnimatedStyle(() => ({ transform: [{ translateX: left.value }] }));
  const rightStyle = useAnimatedStyle(() => ({ transform: [{ translateX: right.value }] }));

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

  const containerStyle: ViewStyle = {
    flexDirection: "row",
    backgroundColor: containerColor ?? palette.s2,
    borderRadius,
    padding: innerPadding,
    height: segmentHeight + innerPadding * 2,
    overflow: "hidden",
  };

  const fill = pillColor ?? accent.solid;
  const pillBaseStyle: ViewStyle = {
    position: "absolute",
    top: innerPadding,
    left: innerPadding,
    width: segmentWidth,
    height: segmentHeight,
    borderRadius: borderRadius - 3,
    backgroundColor: fill,
    // Kein `elevation`: Der Schatten der einen Fläche fiele als dunkle Naht auf
    // die andere. Auf dem dunklen Grund war er ohnehin kaum zu sehen. Das
    // Leuchten auf iOS ist gleichfarbig und tut das nicht; halbe Stärke je
    // Fläche, damit es in Ruhe (beide aufeinander) so hell ist wie früher.
    ...(withShadow && Platform.OS === "ios"
      ? { shadowColor: fill, shadowOpacity: 0.16, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } }
      : null),
  };

  const activeText = activeTextStyle ?? styles.activeText;
  const inactiveText = inactiveTextStyle ?? styles.inactiveText;

  return (
    <GestureDetector gesture={tap}>
      <View style={[containerStyle, style]} onLayout={onContainerLayout} accessibilityRole="radiogroup">
        {/* Die Pille — erst sichtbar, sobald der Container vermessen ist. */}
        {segmentWidth > 0 ? (
          <>
            <Animated.View style={[pillBaseStyle, leftStyle]} />
            <Animated.View style={[pillBaseStyle, rightStyle]} />
          </>
        ) : null}

        {items.map((it, index) => (
          <Segment
            key={it.id}
            item={it}
            index={index}
            selected={index === selectedIndex}
            left={left}
            right={right}
            sw={sw}
            cur={cur}
            activeText={activeText}
            inactiveText={inactiveText}
            onActivate={activate}
          />
        ))}
      </View>
    </GestureDetector>
  );
}

/**
 * Ein Segment mit seiner Beschriftung, zweimal übereinander. Eigene
 * Komponente, damit jede Beschriftung ihren eigenen animierten Stil hat — in
 * einer Schleife dürfen keine Hooks stehen.
 */
function Segment({
  item,
  index,
  selected,
  left,
  right,
  sw,
  cur,
  activeText,
  inactiveText,
  onActivate,
}: {
  item: SegmentedToggleItem;
  index: number;
  selected: boolean;
  left: SharedValue<number>;
  right: SharedValue<number>;
  sw: SharedValue<number>;
  cur: SharedValue<number>;
  activeText: TextStyle;
  inactiveText: TextStyle;
  onActivate: (index: number) => void;
}) {
  /** 1, wenn die Pille hier liegt; 0 ab einem Segment Abstand. Vor dem ersten Layout die Wahl selbst. */
  const activeStyle = useAnimatedStyle(() => {
    const w = sw.value;
    if (w <= 0) return { opacity: cur.value === index ? 1 : 0 };
    const d = Math.abs((left.value + right.value) / 2 - index * w) / w;
    return { opacity: Math.max(0, 1 - d) };
  });
  const restStyle = useAnimatedStyle(() => {
    const w = sw.value;
    if (w <= 0) return { opacity: cur.value === index ? 0 : 1 };
    const d = Math.abs((left.value + right.value) / 2 - index * w) / w;
    return { opacity: Math.min(1, d) };
  });
  const label = (textStyle: TextStyle) => (
    <>
      {item.dot ? <View style={[styles.dot, { backgroundColor: item.dot }]} /> : null}
      {item.Icon ? (
        <item.Icon
          size={ICON_SIZE}
          color={(StyleSheet.flatten<TextStyle>([styles.text, textStyle]).color as string | undefined) ?? "#8E8E93"}
          strokeWidth={2.2}
        />
      ) : null}
      <Text numberOfLines={1} style={[styles.text, textStyle]}>
        {item.label}
      </Text>
    </>
  );
  return (
    <View
      style={styles.segment}
      accessible
      accessibilityRole="radio"
      accessibilityLabel={item.label}
      accessibilityState={{ checked: selected }}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={() => onActivate(index)}
    >
      <Animated.View style={[styles.layer, restStyle]}>{label(inactiveText)}</Animated.View>
      <Animated.View style={[styles.layer, styles.overlay, activeStyle]}>{label(activeText)}</Animated.View>
    </View>
  );
}

/** Zeichen im Segment — eine Stufe größer als die 13er Schrift, wie Lucide neben Text üblich. */
const ICON_SIZE = ms(16);

const styles = scaledStyles({
  segment: { flex: 1, alignItems: "center", justifyContent: "center" },
  layer: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 4 },
  overlay: { ...StyleSheet.absoluteFillObject },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  text: { fontSize: 13, fontWeight: "600" },
  activeText: { color: "#000000", fontWeight: "700" },
  inactiveText: { color: "#8E8E93" },
});
