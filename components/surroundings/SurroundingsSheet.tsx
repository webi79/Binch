import { memo, useEffect, useMemo } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  useWindowDimensions,
  Pressable,
  type ListRenderItemInfo,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Train,
  Bus,
  TramFront,
  Plane,
  Ship,
  ChevronRight,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useT } from "@/lib/i18n/useT";
import { MarkerKind, SheetMode, StopListItem } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";

const LIME = "#7FEA4D";
const LIME_SUB = "rgba(127,234,77,0.18)";
const TRAIN_YELLOW = "#FFD60A";
const TRAIN_YELLOW_SUB = "rgba(255,214,10,0.18)";
const BUS_PURPLE = "#9D5FE0";
const BUS_PURPLE_SUB = "rgba(157,95,224,0.22)";

/** Chip-Styling pro Marker-Typ — matched die Map-Marker für visuelle Konsistenz. */
const KIND_CHIP_STYLE: Record<string, { bg: string; fg: string }> = {
  train: { bg: TRAIN_YELLOW_SUB, fg: TRAIN_YELLOW },
  // airport entfernt — wird zur Laufzeit aus accent berechnet (siehe useAccent).
  bus: { bg: BUS_PURPLE_SUB, fg: BUS_PURPLE },
};
const C = {
  bg: "#1F1F20",
  border: "#2E2E30",
  white: "#FFFFFF",
  g1: "#C4C4C8",
  g2: "#8A8A90",
  g3: "#56565C",
  s2: "#1F1F20",
  s3: "#2A2A2C",
  s4: "#3A3A3D",
};

const KIND_ICON: Record<MarkerKind, LucideIcon> = {
  train: Train,
  subway: Train, // U-Bahn nutzt Train-Icon, in der Liste durch eigenen Chip-Farbton unterschieden
  bus: Bus,
  tram: TramFront,
  airport: Plane,
  cruise: Ship,
};

const MODE_TABS: { mode: SheetMode; tKey: string; Icon: LucideIcon }[] = [
  { mode: "transit", tKey: "surroundings.mode.transit", Icon: Train },
  { mode: "airport", tKey: "surroundings.mode.airport", Icon: Plane },
  { mode: "cruise", tKey: "surroundings.mode.cruise", Icon: Ship },
];

const TITLE_KEY: Record<SheetMode, string> = {
  transit: "surroundings.title.transit",
  airport: "surroundings.title.airport",
  cruise: "surroundings.title.cruise",
};

interface Props {
  mode: SheetMode;
  setMode: (m: SheetMode) => void;
  items: StopListItem[];
}

export function SurroundingsSheet({ mode, setMode, items }: Props) {
  const t = useT();
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  // Snap points als translateY-Offsets relativ zur Top-Position des Sheets.
  // 0 = full open (Sheet bedeckt fast den ganzen Screen, oben 80px frei).
  // PEEK = Sheet zeigt nur Handle + Tabs + Title + ein Listenelement,
  // FloatingTabBar bleibt darunter sichtbar.
  const snap = useMemo(() => {
    const fullTop = Math.max(60, insets.top + 12);
    const sheetHeight = screenHeight - fullTop;
    const tabBarSpace = 80 + insets.bottom; // Platz für FloatingTabBar
    // Peek = nur Handle + Tab-Row; die 1-px-Border darunter wird abgeschnitten
    const peekVisible = 51;
    const midVisible = Math.min(sheetHeight - 80, Math.max(420, screenHeight * 0.5));
    return {
      sheetHeight,
      tabBarSpace,
      // Vom Sheet aus runter geschoben (positiv = weiter unten):
      full: 0,
      mid: Math.max(0, sheetHeight - midVisible - tabBarSpace),
      peek: Math.max(0, sheetHeight - peekVisible - tabBarSpace),
    };
  }, [screenHeight, insets.top, insets.bottom]);

  const translateY = useSharedValue(snap.peek);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  useEffect(() => {
    // Beim ersten Mount sanft in den Peek-State sliden.
    translateY.value = withSpring(snap.peek, { damping: 22, stiffness: 200 });
  }, []);

  // Pan-Gesture an der Handle-Zone: aktualisiert translateY während Drag,
  // snapt beim Loslassen auf den nächstgelegenen Punkt.
  const startY = useSharedValue(0);
  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      const next = startY.value + e.translationY;
      translateY.value = Math.max(snap.full, Math.min(snap.peek, next));
    })
    .onEnd((e) => {
      const final = startY.value + e.translationY;
      const points = [snap.full, snap.mid, snap.peek];
      let closest = points[0];
      let bestDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p - final);
        if (d < bestDist) {
          bestDist = d;
          closest = p;
        }
      }
      // Flick: starke Vertikal-Geschwindigkeit überschreibt die nächste-Snap-Wahl
      if (e.velocityY < -800) closest = snap.full;
      else if (e.velocityY > 800) closest = snap.peek;
      translateY.value = withSpring(closest, { damping: 22, stiffness: 220, mass: 0.8 });
    });

  const title = t(TITLE_KEY[mode]);

  return (
    <Animated.View
      style={[
        styles.sheet,
        { top: Math.max(60, insets.top + 12), height: snap.sheetHeight },
        sheetAnim,
      ]}
    >
      <GestureDetector gesture={pan}>
        <View style={styles.handleZone}>
          <View style={styles.handle} />
        </View>
      </GestureDetector>

      <View style={styles.tabRow}>
        {MODE_TABS.map(({ mode: tabMode, tKey, Icon }) => {
          const active = mode === tabMode;
          return (
            <Pressable
              key={tabMode}
              style={styles.tab}
              onPress={() => setMode(tabMode)}
              android_ripple={null}
              hitSlop={4}
            >
              <View style={styles.tabInner}>
                <Icon color={active ? accent.solid : C.g2} size={18} strokeWidth={2} />
                <Text
                  style={[
                    styles.tabLabel,
                    { color: active ? C.white : C.g2, fontWeight: active ? "700" : "600" },
                  ]}
                >
                  {t(tKey)}
                </Text>
              </View>
              {active && <View style={[styles.tabUnderline, { backgroundColor: accent.solid }]} />}
            </Pressable>
          );
        })}
      </View>

      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        <RippleTouch style={styles.filterRow} borderless>
          <Text style={[styles.filterText, { color: accent.solid }]}>{t("surroundings.filter")}</Text>
          <SlidersHorizontal color={accent.solid} size={12} strokeWidth={2.2} />
        </RippleTouch>
      </View>

      <FlatList
        style={styles.scroll}
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderStopRow}
        contentContainerStyle={{ paddingBottom: snap.tabBarSpace + 40 }}
        showsVerticalScrollIndicator={false}
        // Performance: nur die sichtbaren Rows rendern statt alle 60 auf einmal.
        windowSize={5}
        maxToRenderPerBatch={8}
        initialNumToRender={8}
        removeClippedSubviews
        ListFooterComponent={
          <Text style={styles.footer}>
            {items.length} {t("surroundings.footer.suffix")}
          </Text>
        }
      />
    </Animated.View>
  );
}

const keyExtractor = (item: StopListItem) => item.id;
const renderStopRow = ({ item }: ListRenderItemInfo<StopListItem>) => (
  <StopRow item={item} />
);

const StopRow = memo(function StopRow({ item }: { item: StopListItem }) {
  const t = useT();
  const accent = useAccent();
  return (
    <RippleTouch style={[styles.row, item.selected && styles.rowSelected]}>
      <View style={{ flex: 1 }}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{item.name}</Text>
          {item.selected && (
            <View style={[styles.selectedBadge, { backgroundColor: accent.solid }]}>
              <Text style={styles.selectedBadgeText}>{t("surroundings.selected")}</Text>
            </View>
          )}
        </View>
        <View style={styles.kindRow}>
          {item.kinds.map((k, i) => {
            const Icon = KIND_ICON[k];
            // Unbekannte Kinds (z.B. „ferry" aus OSM-Imports, leere Strings
            // aus partiellen Daten) → Chip einfach skippen statt Render-
            // Crash mit „Cannot read property displayName of undefined".
            if (!Icon) return null;
            // Airport-Chip nutzt den User-Akzent, train/bus haben feste
            // informative Farben (Gelb/Lila) damit die Mode-Erkennung im
            // Marker erhalten bleibt.
            const styled = k === "airport"
              ? { bg: accent.subtle, fg: accent.solid }
              : KIND_CHIP_STYLE[k];
            const bg = styled?.bg ?? C.s3;
            const fg = styled?.fg ?? C.white;
            return (
              <View key={i} style={[styles.kindChip, { backgroundColor: bg }]}>
                <Icon color={fg} size={14} strokeWidth={2} />
              </View>
            );
          })}
          {item.lines?.map((ln, i) => (
            <View key={`ln${i}`} style={[styles.lineBadge, { backgroundColor: ln.color }]}>
              <Text style={styles.lineBadgeText}>{ln.id}</Text>
            </View>
          ))}
          {item.badge && (
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText}>{item.badge}</Text>
            </View>
          )}
        </View>
      </View>
      <View style={styles.distanceCol}>
        <Text style={[styles.distance, { color: accent.solid }]}>{item.distance}</Text>
        <ChevronRight color={C.g3} size={16} strokeWidth={2.4} />
      </View>
    </RippleTouch>
  );
});

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: C.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderTopColor: C.border,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 20,
    zIndex: 40,
  },
  handleZone: {
    paddingTop: 10,
    paddingBottom: 4,
    alignItems: "center",
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#FFFFFF",
    opacity: 0.85,
  },
  tabRow: {
    flexDirection: "row",
    borderBottomColor: C.border,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    position: "relative",
  },
  tabInner: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
  },
  tabLabel: {
    fontSize: 14,
    letterSpacing: -0.1,
  },
  tabUnderline: {
    position: "absolute",
    bottom: 0,
    left: "15%",
    right: "15%",
    height: 3,

    borderRadius: 2,
  },
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 10,
  },
  title: {
    fontSize: 19,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.4,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 4,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  filterText: {
    fontSize: 12,

    fontWeight: "600",
  },
  scroll: { flex: 1 },
  row: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: C.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 14,
  },
  rowSelected: { backgroundColor: C.s2 },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
    marginBottom: 8,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.2,
  },
  selectedBadge: {

    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  selectedBadgeText: {
    color: "#000",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  kindRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 6,
    rowGap: 6,
  },
  kindChip: {
    width: 26,
    height: 26,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  lineBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
  },
  lineBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  metaBadge: {
    backgroundColor: C.s3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  metaBadgeText: {
    color: C.g1,
    fontSize: 10,
    fontWeight: "600",
  },
  distanceCol: {
    alignItems: "flex-end",
    rowGap: 4,
  },
  distance: {
    fontSize: 14,
    fontWeight: "700",

    letterSpacing: -0.2,
  },
  footer: {
    textAlign: "center",
    fontSize: 12,
    color: C.g3,
    paddingVertical: 20,
  },
});

