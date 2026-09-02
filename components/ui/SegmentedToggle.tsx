/**
 * Segmented-Toggle mit Reanimated-Pill, die smooth zwischen den Segmenten
 * slidet. Wird im SearchHero (Roundtrip/Oneway/Multicity), Saved-Tab
 * (Trips/Tickets) und Results-Screen (Outbound/Return) genutzt.
 *
 * API:
 *   <SegmentedToggle
 *     items={[{ id: "a", label: "A" }, { id: "b", label: "B" }]}
 *     selectedId="a"
 *     onChange={(id) => ...}
 *   />
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { LayoutChangeEvent, Pressable, StyleSheet, Text, View, type ColorValue, type TextStyle, type ViewStyle, Platform } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

export interface SegmentedToggleItem {
  id: string;
  label: string;
}

interface Props {
  items: SegmentedToggleItem[];
  selectedId: string;
  onChange: (id: string) => void;
  /** Container background. Default: dunkles surface. */
  containerColor?: ColorValue;
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
  /** Mit elevation/shadow auf der Pill. Default: true. */
  withShadow?: boolean;
  /** Style des äußeren Containers (z.B. width/margin). */
  style?: ViewStyle;
}

const SLIDE_MS = 220;
const EASE = Easing.out(Easing.cubic);

export function SegmentedToggle({
  items,
  selectedId,
  onChange,
  containerColor,
  activeTextStyle,
  inactiveTextStyle,
  innerPadding = 4,
  segmentHeight = 38,
  borderRadius = 14,
  withShadow = true,
  style,
}: Props) {
  const palette = usePalette();
  const accent = useAccent();
  const [containerWidth, setContainerWidth] = useState(0);

  const selectedIndex = useMemo(() => {
    const idx = items.findIndex((i) => i.id === selectedId);
    return idx === -1 ? 0 : idx;
  }, [items, selectedId]);

  const segmentWidth = useMemo(
    () => (containerWidth > 0 ? (containerWidth - innerPadding * 2) / items.length : 0),
    [containerWidth, innerPadding, items.length],
  );

  // Sliding-Pill-Position. Initial = selectedIndex * segmentWidth (kein
  // Animation beim ersten Layout, sonst slidet's beim Mount aus 0).
  const tx = useSharedValue(0);
  const lastSelectedRef = useRef(selectedIndex);

  // Bei jeder Selection-Änderung: animiere Pill smooth zur neuen Position.
  /** Zuletzt an `tx` geschriebene Zielposition — siehe unten. */
  const lastTargetRef = useRef<number | null>(null);
  // Wenn segmentWidth noch nicht bekannt (vor onLayout), nichts tun — der
  // erste Layout-Pass setzt tx direkt auf den richtigen Initial-Wert.
  if (segmentWidth > 0) {
    const targetX = selectedIndex * segmentWidth;
    if (selectedIndex !== lastSelectedRef.current) {
      tx.value = withTiming(targetX, { duration: SLIDE_MS, easing: EASE });
      lastSelectedRef.current = selectedIndex;
      lastTargetRef.current = targetX;
    } else if (lastTargetRef.current !== targetX) {
      // Erstes Layout ODER segmentWidth änderte sich (Orientation-Wechsel
      // etc.) — instant setzen ohne Slide.
      //
      // Verglichen wird gegen eine eigene Ablage, NICHT gegen `tx.value`.
      // Letzteres stand hier und ist aus React heraus ein synchroner Sprung in
      // die UI-Laufzeit, bei dem beide Stränge kurz gegeneinander gesperrt
      // werden — und zwar bei JEDEM Render dieser Komponente, nicht nur beim
      // Wechsel. Sie sitzt im Kopf des Saved-Reiters und im Such-Blatt, rendert
      // also unter anderem mitten im Reiter-Wechsel. Die Ablage beantwortet
      // dieselbe Frage, ohne irgendetwas zu sperren.
      tx.value = targetX;
      lastTargetRef.current = targetX;
    }
  }

  const pillStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
  }));

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

  const pillBaseStyle: ViewStyle = {
    position: "absolute",
    top: innerPadding,
    left: innerPadding,
    width: segmentWidth,
    height: segmentHeight,
    borderRadius: borderRadius - 3,
    backgroundColor: accent.solid,
    ...(withShadow
      ? Platform.select({
          ios: {
            shadowColor: accent.solid as string,
            shadowOpacity: 0.3,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
          },
          android: { elevation: 4 },
        })
      : null),
  };

  return (
    <View style={[containerStyle, style]} onLayout={onContainerLayout}>
      {/* Sliding Pill — absolut positioniert hinter den Texten. Nur sichtbar
          sobald wir den Container vermessen haben. */}
      {segmentWidth > 0 ? <Animated.View style={[pillBaseStyle, pillStyle]} /> : null}

      {items.map((it) => {
        const active = it.id === selectedId;
        return (
          <Pressable
            key={it.id}
            onPress={() => {
              if (active) return;
              haptic("button");
              onChange(it.id);
            }}
            style={styles.segment}
          >
            <Text
              style={[
                styles.text,
                active ? (activeTextStyle ?? styles.activeText) : (inactiveTextStyle ?? styles.inactiveText),
              ]}
            >
              {it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = scaledStyles({
  segment: { flex: 1, alignItems: "center", justifyContent: "center" },
  text: { fontSize: 13, fontWeight: "600" },
  activeText: { color: "#000000", fontWeight: "700" },
  inactiveText: { color: "#8E8E93" },
});
