import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { LucideIcon } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER, ITEM_GAP, SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

/**
 * Die Verkehrsart-Reihe der Blätter auf der Karte: Umgebung (Transit · Airport ·
 * Cruise) und Stadt-Blatt (Zug · Bus · Flug). EINE Form für beide — gewählt die
 * volle grüne Pille mit dunkler Schrift wie jeder Knopf der App, sonst eine
 * dunkle Fläche eine Stufe über dem Blatt (Nutzerwahl 04.11.2026).
 *
 * Die Pille GLEITET zum neuen Chip, mit derselben Kurve wie `SegmentedToggle`
 * (eine Quelle für gleiche Bewegungen), und die Schrift wechselt genau dort, wo
 * sie gerade ist: In der Pille liegt eine dunkle Kopie aller Beschriftungen,
 * gegenläufig verschoben und von ihr beschnitten.
 *
 * Gemeldet wird die Wahl erst, wenn die Pille ANGEKOMMEN ist. Das ist Leistung,
 * nicht Zierde: Mit der Wahl bauen beide Blätter Liste und Karte um (und die
 * Umgebung startet danach die Kamerafahrt). Lief das während der Fahrt der
 * Pille, ruckelte sie — so gleitet sie allein auf dem UI-Strang, und der Umbau
 * kommt danach in einem Stück.
 *
 * `hint` hängt eine Angabe an die Beschriftung („Zug · 3h 12m"). `disabled`
 * dimmt einen Chip — antippbar bleibt er, damit das Blatt sagen kann, warum es
 * dorthin nichts gibt.
 */

export interface SheetTab<K extends string> {
  key: K;
  label: string;
  Icon: LucideIcon;
  hint?: string;
  disabled?: boolean;
}

/** Wie die Pille in `SegmentedToggle`. */
const SLIDE = { duration: 220, easing: Easing.out(Easing.cubic) };
/** Rohmaße der Reihe (vor `scaledStyles`): Luft oben und Höhe eines Chips. */
const ROW_TOP = 4;
const CHIP_H = 40;
/**
 * So hoch ist die Reihe auf dem Gerät — mit demselben Faktor, den
 * `scaledStyles` anlegt. Das Umgebungs-Blatt rechnet damit seine Ruhehöhe
 * (über der Tab-Leiste steht genau Griff + Reihe + Luft).
 */
export const SHEET_TABS_HEIGHT = ms(ROW_TOP) + ms(CHIP_H);
const IDLE_TEXT = "#C4C4C8";
const IDLE_HINT = "#8E8E93";
const ON_PILL_HINT = "rgba(0,0,0,0.55)";

interface Geo {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sameGeo(a: Geo[], b: Geo[]): boolean {
  return a.length === b.length && a.every((g, i) => g.x === b[i]!.x && g.y === b[i]!.y && g.w === b[i]!.w && g.h === b[i]!.h);
}

export function SheetTabs<K extends string>({
  tabs,
  active,
  onChange,
  chipColor,
  style,
}: {
  tabs: SheetTab<K>[];
  active: K;
  onChange: (key: K) => void;
  /** Fläche der nicht gewählten Chips — eine Stufe über dem Blatt (Standard `s2`). */
  chipColor?: string;
  /** Abstände der Reihe (Stadt-Blatt: unten Luft statt oben). */
  style?: StyleProp<ViewStyle>;
}) {
  const accent = useAccent();
  const palette = usePalette();
  const idleBg = chipColor ?? palette.s2;
  const n = tabs.length;
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.key === active));

  /** Lage der Pille als Chip-Nummer (Zwischenwerte während der Fahrt). */
  const pos = useSharedValue(activeIndex);
  const xs = useSharedValue<number[]>([]);
  const geoRef = useRef<(Geo | undefined)[]>([]);
  const [geo, setGeo] = useState<Geo[] | null>(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  /** Wohin die Pille fährt bzw. wo sie steht. */
  const target = useRef(activeIndex);

  // Von außen gewechselt (Suchtreffer, das Stadt-Blatt wählt selbst um):
  // mitgleiten, nichts melden. Die eigene Wahl kommt hier als „schon da" an.
  useEffect(() => {
    if (activeIndex === target.current) return;
    target.current = activeIndex;
    pos.value = withTiming(activeIndex, SLIDE);
  }, [activeIndex, pos]);

  const onSlotLayout = (i: number) => (e: LayoutChangeEvent) => {
    const { x, y, width, height } = e.nativeEvent.layout;
    geoRef.current[i] = { x, y, w: width, h: height };
    const all = geoRef.current.slice(0, n);
    if (all.length < n || !all.every(Boolean)) return;
    const next = all as Geo[];
    xs.value = next.map((g) => g.x);
    setGeo((prev) => (prev && sameGeo(prev, next) ? prev : next));
  };

  const commit = useCallback((i: number) => {
    const tab = tabsRef.current[i];
    if (tab) onChangeRef.current(tab.key);
  }, []);

  const press = (i: number) => {
    const tab = tabs[i];
    if (!tab) return;
    if (i === target.current) {
      // Steht schon dort: nochmal melden (Umgebung fliegt dann zurück an den
      // Ort, das Stadt-Blatt sucht den Flug erneut). Fährt erst hin: warten.
      if (i === activeIndex) onChange(tab.key);
      return;
    }
    haptic("button");
    target.current = i;
    if (!geo) {
      pos.value = i;
      onChange(tab.key);
      return;
    }
    pos.value = withTiming(i, SLIDE, (done) => {
      "worklet";
      if (done) runOnJS(commit)(i);
    });
  };

  const tx = useDerivedValue(() => {
    const x = xs.value;
    if (x.length === 0) return 0;
    const p = Math.min(x.length - 1, Math.max(0, pos.value));
    const i0 = Math.floor(p);
    const i1 = Math.min(x.length - 1, i0 + 1);
    return x[i0]! + (x[i1]! - x[i0]!) * (p - i0);
  });
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const innerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -tx.value }] }));

  const first = geo?.[0];
  const last = geo?.[n - 1];
  return (
    <View style={[styles.row, style]}>
      {/* Eigene Spur ohne Innenabstand: Lagen der Chips und der Pille im
          selben Bezug, egal wie der Rand der Reihe gesetzt ist. */}
      <View style={styles.track}>
      {tabs.map((tab, i) => {
        // Bis gemessen ist, trägt der gewählte Chip die Pille selbst.
        const ownPill = !geo && i === activeIndex;
        return (
          <View key={tab.key} style={styles.slot} onLayout={onSlotLayout(i)}>
            <RippleTouch
              onPress={() => press(i)}
              accessibilityRole="button"
              accessibilityState={{ selected: i === activeIndex, disabled: !!tab.disabled }}
              accessibilityLabel={tab.label}
              rippleColor="rgba(255,255,255,0.12)"
              style={[
                styles.chip,
                { backgroundColor: ownPill ? accent.solid : idleBg },
                tab.disabled && i !== activeIndex ? styles.dim : null,
              ]}
            >
              <ChipLabel
                tab={tab}
                color={ownPill ? accent.textOnSolid : IDLE_TEXT}
                hintColor={ownPill ? ON_PILL_HINT : IDLE_HINT}
              />
            </RippleTouch>
          </View>
        );
      })}
      {geo && first && last ? (
        <Animated.View
          pointerEvents="none"
          // Die dunkle Kopie ist nur Bild — vorgelesen werden die Chips selbst.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.pill,
            {
              top: first.y,
              width: first.w,
              height: first.h,
              borderRadius: first.h / 2,
              backgroundColor: accent.solid,
            },
            pillStyle,
          ]}
        >
          <Animated.View style={[styles.pillInner, { width: last.x + last.w, height: first.h }, innerStyle]}>
            {tabs.map((tab, i) => (
              <View key={tab.key} style={[styles.pillLabel, { left: geo[i]!.x, width: geo[i]!.w, height: geo[i]!.h }]}>
                <ChipLabel tab={tab} color={accent.textOnSolid} hintColor={ON_PILL_HINT} />
              </View>
            ))}
          </Animated.View>
        </Animated.View>
      ) : null}
      </View>
    </View>
  );
}

function ChipLabel<K extends string>({ tab, color, hintColor }: { tab: SheetTab<K>; color: string; hintColor: string }) {
  const { Icon } = tab;
  return (
    <>
      <Icon size={16} color={color} strokeWidth={2.2} />
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {tab.label}
        {tab.hint ? <Text style={{ color: hintColor }}>{` · ${tab.hint}`}</Text> : null}
      </Text>
    </>
  );
}

const styles = scaledStyles({
  row: {
    paddingHorizontal: GUTTER,
    paddingTop: ROW_TOP,
  },
  track: { flexDirection: "row", columnGap: ITEM_GAP },
  slot: { flex: 1 },
  chip: {
    height: CHIP_H,
    borderRadius: CHIP_H / 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    columnGap: SPACE.sm,
    paddingHorizontal: 12,
  },
  dim: { opacity: 0.38 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: "700", letterSpacing: -0.1 },
  pill: { position: "absolute", left: 0, overflow: "hidden" },
  pillInner: { position: "absolute", left: 0, top: 0 },
  pillLabel: {
    position: "absolute",
    top: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    columnGap: SPACE.sm,
    paddingHorizontal: 12,
  },
});
