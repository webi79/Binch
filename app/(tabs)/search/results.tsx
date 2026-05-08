import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  Plane,
  Train,
  Bus,
  Ship,
  ArrowLeftRight,
  SlidersHorizontal,
  RotateCcw,
  WifiOff,
  type LucideIcon,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { TravelMode, SearchResult, SearchResponse } from "@/types/search";
import { searchByMode } from "@/lib/api/client";
import { ResultCard } from "@/components/results/ResultCard";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";

type SortKey = "cheapest" | "fastest" | "direct";

const C = {
  bg: "#1A1A1A",
  card: "#1F1F20",
  border: "#2E2E30",
  surface3: "#2A2A2C",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const priceForSort = (p: number) => (p > 0 ? p : Number.POSITIVE_INFINITY);

function sortResults(list: SearchResult[], sort: SortKey): SearchResult[] {
  const copy = [...list];
  switch (sort) {
    case "fastest":
      return copy.sort((a, b) => a.durationMinutes - b.durationMinutes);
    case "direct":
      return copy
        .filter((r) => r.stops === 0)
        .sort((a, b) => priceForSort(a.price) - priceForSort(b.price));
    default:
      return copy.sort((a, b) => priceForSort(a.price) - priceForSort(b.price));
  }
}

function shortCity(label: string): string {
  return label.split(",")[0]?.trim() ?? label;
}

/**
 * Returns a clean display code or empty string if the code is an internal
 * provider id (e.g. `dbrest:8006342`). Internal ids never reach the UI —
 * the city label takes the headline slot in that case.
 */
function displayCode(code: string): string {
  if (!code) return "";
  if (code.includes(":")) return "";
  // Heuristic: real airport / station codes are short alphanumerics.
  if (code.length > 6) return "";
  return code;
}

export default function ResultsScreen() {
  const router = useRouter();
  const t = useT();
  const [sort, setSort] = useState<SortKey>("cheapest");

  const p = useLocalSearchParams<{
    mode: string;
    origin: string;
    destination: string;
    originLabel?: string;
    destLabel?: string;
    departDate: string;
    returnDate?: string;
    tripType?: string;
    passengers?: string;
    currency?: string;
  }>();

  const mode = (p.mode ?? "FLIGHT") as TravelMode;
  const origin = p.origin ?? "";
  const destination = p.destination ?? "";
  const originLabel = p.originLabel ?? origin;
  const destLabel = p.destLabel ?? destination;
  const departDate = p.departDate ?? "";
  const returnDate = p.returnDate ?? "";
  const passengers = Number(p.passengers ?? "1");
  const currency = p.currency ?? "EUR";

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery<SearchResponse>({
    queryKey: ["search", mode, origin, destination, departDate, returnDate, passengers, currency],
    queryFn: () =>
      searchByMode({
        mode,
        origin,
        destination,
        originLabel,
        destLabel,
        departDate,
        returnDate: returnDate || undefined,
        passengers,
        currency,
      }),
    enabled: Boolean(origin && destination && departDate),
    retry: 1,
  });

  const sorted = useMemo(() => sortResults(data?.results ?? [], sort), [data, sort]);

  const tabs: { key: SortKey; labelKey: string }[] = [
    { key: "cheapest", labelKey: "results.sort.cheapest" },
    { key: "fastest", labelKey: "results.sort.fastest" },
    { key: "direct", labelKey: "results.sort.direct" },
  ];

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.routePanel}>
        <View style={styles.routeRow}>
          <RouteSide
            code={mode === "FLIGHT" ? displayCode(origin) : ""}
            city={shortCity(originLabel)}
            align="flex-start"
          />
          <RouteIndicator mode={mode} loading={isLoading} />
          <RouteSide
            code={mode === "FLIGHT" ? displayCode(destination) : ""}
            city={shortCity(destLabel)}
            align="flex-end"
          />
        </View>

        <View style={styles.routeFooter}>
          <View style={[styles.routeFooterBtn, styles.routeFooterBtnSearch]}>
            <Text style={styles.routeFooterText}>
              {isLoading
                ? t("results.searching")
                : `${sorted.length} ${t("results.count")}`}
            </Text>
            {isLoading ? <LoadingDots /> : null}
          </View>
          <RippleTouch
            onPress={() => {
              haptic("button");
              router.back();
            }}
            style={[styles.routeFooterBtn, styles.routeFooterBtnChange]}
          >
            <Text style={styles.routeFooterText}>{t("results.change")}</Text>
            <ArrowLeftRight color={C.text} size={14} />
          </RippleTouch>
        </View>
      </View>

      <View style={styles.tabsRow}>
        {tabs.map((tab) => {
          const active = sort === tab.key;
          return (
            <Pressable
              key={tab.key}
              onPress={() => {
                haptic("button");
                setSort(tab.key);
              }}
              style={styles.tabBtn}
            >
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t(tab.labelKey)}
              </Text>
              {active ? <View style={styles.tabUnderline} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.tabsSpacer} />
        <RippleTouch hitSlop={6} borderless style={styles.filterBtn}>
          <SlidersHorizontal color={C.text} size={16} />
        </RippleTouch>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.lime} size="large" />
        </View>
      ) : isError ? (
        <View style={styles.errorWrap}>
          <View style={styles.errorIcon}>
            <WifiOff size={32} color={C.lime} strokeWidth={2} />
          </View>
          <Text style={styles.errorTitle}>{t("results.error")}</Text>
          <Text style={styles.errorBody}>{t("results.error.body")}</Text>
          {error instanceof Error ? (
            <Text style={styles.errorDetail} numberOfLines={3}>
              {error.message}
            </Text>
          ) : null}
          <RippleTouch
            onPress={() => {
              haptic("button");
              refetch();
            }}
            style={styles.retryBtn}
          >
            <GradientFill />
            <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
            <Text style={styles.retryBtnText}>{t("results.retry")}</Text>
          </RippleTouch>
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <ResultCard result={item} passengers={passengers} />}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => {
                haptic("button");
                refetch();
              }}
              tintColor={C.lime}
              colors={[C.lime]}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>{t("results.empty")}</Text>
              <RippleTouch
                onPress={() => {
                  haptic("button");
                  refetch();
                }}
                style={styles.retryBtn}
              >
                <GradientFill />
                <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
                <Text style={styles.retryBtnText}>{t("results.retry")}</Text>
              </RippleTouch>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

function RouteSide({
  code,
  city,
  align,
}: {
  code: string;
  city: string;
  align: "flex-start" | "flex-end";
}) {
  const hasCode = code.length > 0;
  return (
    <View style={[styles.routeSide, { alignItems: align }]}>
      {hasCode ? (
        <>
          <Text
            style={[styles.routeCode, { textAlign: align === "flex-end" ? "right" : "left" }]}
            adjustsFontSizeToFit
            numberOfLines={1}
            minimumFontScale={0.6}
          >
            {code}
          </Text>
          <Text style={[styles.routeCity, { textAlign: align === "flex-end" ? "right" : "left" }]}>
            {city}
          </Text>
        </>
      ) : (
        <Text
          style={[styles.routeCityBig, { textAlign: align === "flex-end" ? "right" : "left" }]}
          adjustsFontSizeToFit
          numberOfLines={2}
          minimumFontScale={0.6}
        >
          {city}
        </Text>
      )}
    </View>
  );
}

function RouteIndicator({ mode, loading }: { mode: TravelMode; loading: boolean }) {
  const Icon = MODE_ICON[mode] ?? Plane;
  const rot = useSharedValue(0);

  useEffect(() => {
    if (loading) {
      rot.value = 0;
      rot.value = withRepeat(
        withTiming(1, { duration: 1800, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      rot.value = withTiming(0, { duration: 200 });
    }
  }, [loading, rot]);

  const lineAnim = useAnimatedStyle(() => ({
    opacity: 0.5 + 0.5 * Math.abs(Math.sin(rot.value * Math.PI)),
  }));

  return (
    <View style={styles.indicatorWrap}>
      <Animated.View style={[styles.indicatorLine, lineAnim]} />
      <View style={styles.indicatorDot} />
      <View style={styles.indicatorBadge}>
        <GradientFill />
        <Icon color={C.black} size={16} strokeWidth={2.2} />
      </View>
      <View style={styles.indicatorDot} />
      <Animated.View style={[styles.indicatorLine, lineAnim]} />
    </View>
  );
}

function LoadingDots() {
  const a = useSharedValue(0);
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
  }, [a]);
  const s1 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0) }));
  const s2 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.33) }));
  const s3 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.66) }));
  return (
    <View style={styles.dotsRow}>
      <Animated.View style={[styles.smallDot, s1]} />
      <Animated.View style={[styles.smallDot, s2]} />
      <Animated.View style={[styles.smallDot, s3]} />
    </View>
  );
}

function pulse(t: number, phase: number): number {
  "worklet";
  const x = (t + phase) % 1;
  return Math.max(0, Math.sin(x * Math.PI));
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  routePanel: {
    backgroundColor: C.card,
    borderRadius: 24,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 16,
    gap: 14,
  },
  routeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeSide: { flex: 1.3, minWidth: 0 },
  routeCode: { color: C.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.8 },
  routeCity: { color: C.sub, fontSize: 13, marginTop: 2 },
  routeCityBig: {
    color: C.text,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 26,
  },

  indicatorWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minWidth: 90,
  },
  indicatorLine: {
    flex: 1,
    height: 0,
    borderTopWidth: 1.5,
    borderColor: C.subDim,
    borderStyle: "dashed",
  },
  indicatorDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.subDim },
  indicatorBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },

  routeFooter: { flexDirection: "row", gap: 10 },
  routeFooterBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 40,
    borderRadius: 9999,
  },
  routeFooterBtnSearch: { backgroundColor: C.surface3 },
  routeFooterBtnChange: { backgroundColor: C.surface3 },
  routeFooterText: { color: C.text, fontSize: 13, fontWeight: "600" },

  dotsRow: { flexDirection: "row", gap: 3, marginLeft: 4 },
  smallDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: C.lime },

  tabsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 12,
    gap: 22,
  },
  tabBtn: { paddingVertical: 4 },
  tabText: { color: C.sub, fontSize: 14, fontWeight: "600" },
  tabTextActive: { color: C.lime, fontWeight: "700" },
  tabUnderline: {
    height: 2,
    borderRadius: 2,
    backgroundColor: C.lime,
    marginTop: 6,
  },
  tabsSpacer: { flex: 1 },
  filterBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },

  listContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 110 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  errorIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(127,234,77,0.10)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  errorTitle: { color: C.text, fontWeight: "700", fontSize: 18, letterSpacing: -0.3 },
  errorBody: {
    color: C.sub,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    marginHorizontal: 8,
  },
  errorDetail: { color: C.subDim, fontSize: 11, textAlign: "center", marginTop: -4 },
  retryBtn: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 9999,
    overflow: "hidden",
  },
  retryBtnText: { color: C.black, fontWeight: "700", fontSize: 14 },
  emptyWrap: { paddingVertical: 60, alignItems: "center", gap: 14 },
  emptyText: { color: C.sub },
});
