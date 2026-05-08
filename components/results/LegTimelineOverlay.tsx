import { useEffect, useState } from "react";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  ScrollView,
  BackHandler,
  Platform,
  useWindowDimensions,
} from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { format, parseISO } from "date-fns";
import { de, enGB, es, fr } from "date-fns/locale";
import { ChevronDown, ChevronUp, Footprints } from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { LegInfo, SearchResult } from "@/types/search";

const C = {
  bg: "#1A1A1A",
  sheet: "#1F1F20",
  card: "#242425",
  cardSoft: "#2A2A2C",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  limeSoft: "rgba(127,234,77,0.14)",
  amber: "#FFB266",
  black: "#000000",
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function timeOf(iso: string): string {
  try {
    return format(parseISO(iso), "HH:mm");
  } catch {
    return "";
  }
}

function productLabel(product?: string): string | null {
  if (!product) return null;
  switch (product) {
    case "national":
    case "nationalExpress":
      return "ICE";
    case "regional":
    case "regionalExpress":
      return "RB";
    case "suburban":
      return "S";
    case "subway":
      return "U";
    case "tram":
      return "T";
    case "bus":
      return "Bus";
    case "ferry":
      return "F";
    case "flight":
      return "✈";
    default:
      return null;
  }
}

function productColor(product?: string): string {
  switch (product) {
    case "suburban":
      return "#1F8A37";
    case "subway":
      return "#0066CC";
    case "national":
    case "nationalExpress":
      return "#EC0016";
    case "tram":
      return "#C13635";
    case "bus":
      return "#73D700";
    case "ferry":
      return "#0EA5E9";
    case "flight":
      return "#1F2A57";
    default:
      return "#3a3a3e";
  }
}

interface SyntheticLeg extends LegInfo {}

function buildFallbackLegs(result: SearchResult): SyntheticLeg[] {
  return [
    {
      origin: result.origin,
      destination: result.destination,
      originLabel: result.originLabel?.split(",")[0]?.trim(),
      destLabel: result.destLabel?.split(",")[0]?.trim(),
      departTime: result.departTime,
      arriveTime: result.arriveTime,
      durationMinutes: result.durationMinutes,
      line: result.flightNumber,
      direction: undefined,
      stops: result.stops,
    },
  ];
}

export function LegTimelineOverlay() {
  const open = useSearchStore((s) => s.legTimelineOverlayOpen);
  const result = useSearchStore((s) => s.selectedResult);
  if (!open || !result) return null;
  return <LegTimelineSheet result={result} />;
}

function LegTimelineSheet({ result }: { result: SearchResult }) {
  const close = useSearchStore((s) => s.closeLegTimelineOverlay);
  const locale = useSearchStore((s) => s.locale);
  const t = useT();
  const { height } = useWindowDimensions();
  const sheetHeight = height * 0.88;
  const sheetTop = height - sheetHeight;

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const translateY = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const panGesture = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetY(-8)
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 700) {
        translateY.value = withTiming(sheetHeight, { duration: 220 });
        runOnJS(close)();
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
      }
    });

  const dateLocale = DATE_LOCALES[locale] ?? enGB;
  const legs = result.legs && result.legs.length > 0 ? result.legs : buildFallbackLegs(result);

  const dateStr = (() => {
    try {
      return format(parseISO(result.departTime), "EEEE, d MMMM", { locale: dateLocale });
    } catch {
      return "";
    }
  })();

  const stopLabel =
    result.stops === 0
      ? t("details.stop.zero")
      : result.stops === 1
      ? t("details.stop.one")
      : t("details.stop.many").replace("{count}", String(result.stops));

  return (
    <View style={StyleSheet.absoluteFillObject}>
      <Animated.View
        entering={FadeIn.duration(220)}
        exiting={FadeOut.duration(180)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(300)}
        style={[styles.sheet, sheetAnim, { top: sheetTop }]}
      >
        <GestureDetector gesture={panGesture}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>

        <View style={styles.headerRow}>
          <View style={styles.dateBadge}>
            <Text style={styles.dateBadgeText}>{dateStr}</Text>
          </View>
          <Text style={styles.headerMeta}>
            {formatDuration(result.durationMinutes)}
            {"  ·  "}
            <Text style={result.stops === 0 ? { color: C.lime } : { color: C.amber }}>
              {stopLabel}
            </Text>
          </Text>
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {legs.map((leg, idx) => {
            const next = legs[idx + 1];
            const isLast = idx === legs.length - 1;
            const transferMin = next
              ? Math.max(
                  0,
                  Math.round(
                    (Date.parse(next.departTime) - Date.parse(leg.arriveTime)) / 60000,
                  ),
                )
              : 0;
            return (
              <View key={`${leg.origin}-${idx}`}>
                <StationRow
                  time={timeOf(leg.departTime)}
                  name={leg.originLabel ?? leg.origin}
                  platform={leg.departPlatform}
                />
                <LegBodyRow leg={leg} />
                <StationRow
                  time={timeOf(leg.arriveTime)}
                  name={leg.destLabel ?? leg.destination}
                  platform={leg.arrivePlatform}
                  hideTrailingLine={isLast}
                />
                {next ? <TransferBlock minutes={transferMin} /> : null}
              </View>
            );
          })}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function StationRow({
  time,
  name,
  platform,
  hideTrailingLine,
}: {
  time: string;
  name: string;
  platform?: string;
  hideTrailingLine?: boolean;
}) {
  return (
    <View style={styles.stationRow}>
      <View style={styles.leftCol}>
        <Text style={styles.stationTime}>{time}</Text>
      </View>
      <View style={styles.rail}>
        <View style={styles.dot} />
        {hideTrailingLine ? null : <View style={styles.railLineShort} />}
      </View>
      <View style={styles.stationHeader}>
        <Text style={styles.stationName} numberOfLines={1}>
          {name}
        </Text>
        {platform ? (
          <View style={styles.platformBadge}>
            <Text style={styles.platformText}>Pl. {platform}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function LegBodyRow({ leg }: { leg: SyntheticLeg }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const lineLabel = leg.line ?? productLabel(leg.product) ?? "";
  const lineBg = productColor(leg.product);
  const stopsCount = leg.stops ?? 0;

  return (
    <View style={styles.legBodyRow}>
      <View style={styles.leftColCenter}>
        <Text style={styles.leftColText} numberOfLines={1}>
          {formatDuration(leg.durationMinutes)}
        </Text>
      </View>
      <View style={styles.rail}>
        <View style={styles.railLine} />
      </View>
      <View style={styles.legBody}>
        {lineLabel ? (
          <View style={styles.lineRow}>
            <View style={[styles.lineBadge, { backgroundColor: lineBg }]}>
              <Text style={styles.lineBadgeText}>{lineLabel}</Text>
            </View>
            {leg.fahrtNr && leg.fahrtNr !== leg.line ? (
              <Text style={styles.fahrtNr}>({leg.fahrtNr})</Text>
            ) : null}
          </View>
        ) : null}
        {leg.direction ? (
          <Text style={styles.direction}>
            {t("details.direction")} {leg.direction}
          </Text>
        ) : null}

        {stopsCount > 0 ? (
          <View>
            <Pressable
              onPress={() => setExpanded((v) => !v)}
              style={styles.stopsToggle}
              hitSlop={6}
            >
              {expanded ? (
                <ChevronUp size={14} color={C.lime} strokeWidth={2.5} />
              ) : (
                <ChevronDown size={14} color={C.lime} strokeWidth={2.5} />
              )}
              <Text style={styles.stopsToggleText}>
                {stopsCount === 1
                  ? t("details.stop.one")
                  : t("details.stop.many").replace("{count}", String(stopsCount))}
              </Text>
            </Pressable>
            {expanded && leg.stopovers && leg.stopovers.length > 0 ? (
              <View style={styles.stopoverList}>
                {leg.stopovers.map((s, i) => {
                  const stopTime = s.arrival
                    ? timeOf(s.arrival)
                    : s.departure
                    ? timeOf(s.departure)
                    : "";
                  return (
                    <View key={`${s.name}-${i}`} style={styles.stopoverRow}>
                      <View style={styles.stopoverDot} />
                      <Text style={styles.stopoverTime}>{stopTime}</Text>
                      <Text style={styles.stopoverName} numberOfLines={1}>
                        {s.name}
                      </Text>
                      {s.platform ? (
                        <Text style={styles.stopoverPlatform}>Pl. {s.platform}</Text>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TransferBlock({ minutes }: { minutes: number }) {
  const t = useT();
  return (
    <View style={styles.transferRow}>
      <View style={styles.leftCol} />
      <View style={styles.rail}>
        <View style={styles.railDottedWrap}>
          {Array.from({ length: 14 }).map((_, i) => (
            <View key={i} style={styles.railDot} />
          ))}
        </View>
      </View>
      <View style={styles.transferContent}>
        <Text style={styles.transferLabel}>{t("details.transfer")}</Text>
        <Text style={styles.transferMin}>{formatDuration(minutes)}</Text>
        <Footprints size={16} color={C.lime} strokeWidth={2.2} />
      </View>
    </View>
  );
}

const RAIL_WIDTH = 22;

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.sheet,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 32,
  },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 14 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: C.text },

  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    marginBottom: 16,
    gap: 10,
  },
  dateBadge: {
    backgroundColor: C.limeSoft,
    borderRadius: 9999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dateBadgeText: { color: C.lime, fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
  headerMeta: { color: C.text, fontSize: 13, fontWeight: "700" },

  scrollContent: { paddingHorizontal: 14, paddingBottom: 32 },

  leftCol: { width: 64, alignItems: "flex-end", paddingRight: 6 },
  leftColCenter: { width: 64, alignItems: "flex-end", justifyContent: "center", paddingRight: 6 },
  leftColText: { color: C.sub, fontSize: 11, fontWeight: "700", letterSpacing: 0.2 },

  stationRow: { flexDirection: "row", gap: 10, alignItems: "stretch" },
  legBodyRow: { flexDirection: "row", gap: 10, paddingVertical: 4 },
  rail: { width: RAIL_WIDTH, alignItems: "center" },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    borderColor: C.border,
    backgroundColor: C.sheet,
  },
  railLine: {
    flex: 1,
    width: 2,
    backgroundColor: C.border,
  },
  railLineShort: {
    flex: 1,
    width: 2,
    backgroundColor: C.border,
    marginTop: 2,
  },

  stationHeader: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 14,
    marginTop: -3,
  },
  stationTime: { color: C.text, fontSize: 16, fontWeight: "800", letterSpacing: -0.3 },
  stationName: { color: C.text, fontSize: 16, fontWeight: "700", flex: 1 },
  platformBadge: {
    backgroundColor: C.limeSoft,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 9999,
  },
  platformText: { color: C.lime, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 },

  legBody: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 16,
    padding: 12,
    gap: 10,
    marginVertical: 8,
  },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  lineBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  lineBadgeText: { color: "#FFFFFF", fontSize: 13, fontWeight: "800", letterSpacing: 0.3 },
  fahrtNr: { color: C.sub, fontSize: 13, fontWeight: "600" },
  direction: { color: C.sub, fontSize: 13, fontWeight: "500" },

  stopsToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: C.cardSoft,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9999,
  },
  stopsToggleText: { color: C.text, fontSize: 12, fontWeight: "700" },

  stopoverList: {
    marginTop: 4,
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: C.cardSoft,
    borderRadius: 12,
  },
  stopoverRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  stopoverDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: C.lime,
  },
  stopoverTime: { color: C.sub, fontSize: 12, fontWeight: "700", minWidth: 38 },
  stopoverName: { color: C.text, fontSize: 13, fontWeight: "500", flex: 1 },
  stopoverPlatform: { color: C.lime, fontSize: 11, fontWeight: "700" },

  transferRow: { flexDirection: "row", gap: 10, paddingVertical: 4 },
  railDottedWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  railDot: { width: 2, height: 2, borderRadius: 1, backgroundColor: C.sub },
  transferContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.card,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    marginVertical: 8,
  },
  transferLabel: { color: C.text, fontSize: 13, fontWeight: "800", letterSpacing: 0.2 },
  transferMin: { color: C.sub, fontSize: 13, fontWeight: "700" },
});
