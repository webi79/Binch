import { useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { CommonActions, useNavigation } from "@react-navigation/native";
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
  LinearTransition,
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
  const navigation = useNavigation();
  const t = useT();
  const [sort, setSort] = useState<SortKey>("cheapest");

  // Stack auf [results] reduzieren — vor dem Push aus dem Home-Tab landet
  // expo-router temporär bei `[index, results]` (index ist die Initial-Route
  // des Search-Stacks). Ohne Reset würde der Back-Swipe von results in den
  // SearchHero (index) pop'pen statt aus dem Search-Stack rauszugehen.
  // Mit dem Reset auf nur `[results]` exitet der Back-Swipe direkt zum
  // (tabs)-Parent → Landing-Page.
  useEffect(() => {
    const state = navigation.getState();
    if (!state || state.routes.length <= 1) return;
    const current = state.routes[state.index];
    if (!current) return;
    navigation.dispatch(
      CommonActions.reset({
        index: 0,
        routes: [{ name: current.name, params: current.params as object | undefined }],
      }),
    );
  }, [navigation]);

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
    travelClass?: string;
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
  const travelClass = p.travelClass ?? "";

  // Flag dass die NÄCHSTE queryFn-Ausführung den Server-Cache umgeht.
  // Initial-Load nutzt Cache (schnell + spart Provider-Anfrage), Refresh per
  // Pull-Down / Refresh-Button nutzt nocache=1 (frische Preise).
  const forceFreshRef = useRef(false);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery<SearchResponse>({
    queryKey: ["search", mode, origin, destination, departDate, returnDate, passengers, currency, travelClass],
    queryFn: () => {
      const opt = forceFreshRef.current ? { nocache: true } : undefined;
      forceFreshRef.current = false;
      return searchByMode(
        {
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          returnDate: returnDate || undefined,
          passengers,
          currency,
          travelClass: travelClass || undefined,
        },
        opt,
      );
    },
    enabled: Boolean(origin && destination && departDate),
    retry: 1,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const refreshFresh = () => {
    forceFreshRef.current = true;
    return refetch();
  };

  // Silent Background-Refresh: alle 5 Min frische Preise vom SERVER-Cache
  // holen — ohne `nocache`. Das ist clever weil:
  //   1. Server hat eh schon SWR-Logik: bei >50% TTL läuft ein Refresh im
  //      Hintergrund → Cache wird automatisch frisch gehalten
  //   2. Client-Poll triggert eigene Provider-Calls NICHT → ein User der den
  //      Screen lange offen lässt verbraucht KEINE Provider-Quota
  //   3. Mehrere User auf derselben Route teilen sich den Server-Cache → eine
  //      Provider-Anfrage pro Route pro TTL-Window, völlig unabhängig von Usern
  //
  // Effekt: Preise sind nie älter als TTL/2 (≈ Flight 5min, Bus 15min, Train 2h)
  // OHNE dass die User-Anzahl die Kosten skaliert.
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["search", mode, origin, destination, departDate, returnDate, passengers, currency, travelClass],
    [mode, origin, destination, departDate, returnDate, passengers, currency, travelClass],
  );

  useEffect(() => {
    if (!origin || !destination || !departDate) return;
    const intervalMs = 5 * 60 * 1000; // 5 Min

    const doSilentRefresh = async () => {
      if (AppState.currentState !== "active") return;
      try {
        // OHNE nocache — wir holen vom Server-Cache, der via SWR
        // automatisch frisch gehalten wird.
        const fresh = await searchByMode({
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          returnDate: returnDate || undefined,
          passengers,
          currency,
          travelClass: travelClass || undefined,
        });
        queryClient.setQueryData(queryKey, fresh);
      } catch {
        // Refresh fehlgeschlagen → bestehende Daten bleiben.
      }
    };

    const id = setInterval(doSilentRefresh, intervalMs);
    // Auch beim Foreground-Switch refreshen (User hatte App im Hintergrund).
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void doSilentRefresh();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [mode, origin, destination, originLabel, destLabel, departDate, returnDate, passengers, currency, travelClass, queryKey, queryClient]);

  // Hin- oder Rückreise-Ansicht. Nur für Train/Bus relevant — Flüge bekommen
  // keine separaten Rück-Treffer (SerpAPI/Google Flights pre-bundled die schon
  // serverseitig). Default: Hinreise.
  const [direction, setDirection] = useState<"OUTBOUND" | "RETURN">("OUTBOUND");

  // „Später"-Pagination (nur TRAIN): zusätzliche Verbindungen die per HAFAS-
  // laterRef nachgeladen wurden, plus der aktuelle Token für den nächsten
  // Klick. Reset bei jedem Such-Wechsel — geknüpft an `data?.fetchedAt` damit
  // ein frischer Server-Refresh den lokalen Pagination-State leert.
  const [extraResults, setExtraResults] = useState<SearchResult[]>([]);
  const [paginationToken, setPaginationToken] = useState<string | undefined>(undefined);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const dataFetchedAt = data?.fetchedAt;
  useEffect(() => {
    setExtraResults([]);
    setPaginationToken(data?.paginationToken);
  }, [dataFetchedAt, data?.paginationToken]);

  const loadMore = async () => {
    if (!paginationToken || isLoadingMore) return;
    setIsLoadingMore(true);
    haptic("button");
    try {
      const next = await searchByMode(
        {
          mode,
          origin,
          destination,
          originLabel,
          destLabel,
          departDate,
          returnDate: returnDate || undefined,
          passengers,
          currency,
          travelClass: travelClass || undefined,
        },
        { paginationToken },
      );
      setExtraResults((prev) => [...prev, ...next.results]);
      setPaginationToken(next.paginationToken);
    } catch {
      // Bei Fehler den Token behalten — User kann erneut auf „Später" tippen.
    } finally {
      setIsLoadingMore(false);
    }
  };

  const allResults = [...(data?.results ?? []), ...extraResults];
  const hasReturnLeg = allResults.some((r) => r.direction === "RETURN");
  const showDirectionToggle =
    Boolean(returnDate) && hasReturnLeg && (mode === "TRAIN" || mode === "BUS");

  const sorted = useMemo(() => {
    // Defensive Dedupe auf id — falls der Server mal doppelte IDs liefert
    // (z.B. alter Cache vor Server-Restart), schützt das vor FlatList-Crash
    // mit "two children with the same key".
    const dedupeById = (list: SearchResult[]): SearchResult[] => {
      const seen = new Set<string>();
      const out: SearchResult[] = [];
      for (const r of list) {
        const key = `${r.direction ?? "OUTBOUND"}-${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return out;
    };

    if (!showDirectionToggle) {
      const onlyOutbound = allResults.filter((r) => r.direction !== "RETURN");
      return sortResults(dedupeById(onlyOutbound), sort);
    }
    const filtered = allResults.filter((r) =>
      direction === "RETURN" ? r.direction === "RETURN" : r.direction !== "RETURN",
    );
    return sortResults(dedupeById(filtered), sort);
  }, [allResults, sort, direction, showDirectionToggle]);

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

      {showDirectionToggle ? (
        <View style={styles.dirToggleWrap}>
          <View style={styles.dirToggle}>
            {(["OUTBOUND", "RETURN"] as const).map((id) => {
              const active = direction === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => {
                    haptic("button");
                    setDirection(id);
                  }}
                  style={[styles.dirSeg, active && styles.dirSegActive]}
                >
                  <Text style={active ? styles.dirSegTextActive : styles.dirSegText}>
                    {t(id === "OUTBOUND" ? "results.direction.outbound" : "results.direction.return")}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

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
              // Hitbox vergrößern, ohne die visuellen Buttons aufzublasen.
              // top/bottom großzügig (vertikaler Platz ist da), left/right
              // moderat (sonst überlappen die Hitboxen den 22px-Gap).
              hitSlop={{ top: 14, bottom: 14, left: 10, right: 10 }}
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
              refreshFresh();
            }}
            style={styles.retryBtn}
          >
            <GradientFill />
            <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
            <Text style={styles.retryBtnText}>{t("results.retry")}</Text>
          </RippleTouch>
        </View>
      ) : (
        <Animated.FlatList
          // Bei Direction-Wechsel (Hin/Rück) UND bei neuen Suchergebnissen
          // komplett remounten — `data?.fetchedAt` ändert sich pro Server-
          // Response, damit feuert die `itemLayoutAnimation` nicht für die
          // initialen 8 Cards einer frischen Suche (sonst sliden die Cards
          // ins Layout, und während der User auf "Auswählen" klickt kämpfen
          // diese Layout-Animationen mit dem DetailsOverlay-Slide).
          // Innerhalb derselben Daten + Direction läuft der Sort-Reorder
          // weiter smooth.
          key={`${direction}-${data?.fetchedAt ?? ""}`}
          data={sorted}
          // Defensiv mit Direction-Prefix: garantiert eindeutig auch wenn
          // Outbound- und Return-Backend-IDs jemals kollidieren sollten.
          keyExtractor={(r) => `${r.direction ?? "OUTBOUND"}-${r.id}`}
          renderItem={({ item }) => <ResultCard result={item} passengers={passengers} />}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          contentContainerStyle={styles.listContent}
          // Sliding-Reorder beim Sort-Wechsel (Cheapest/Fastest/Direct):
          // Reanimated trackt jede Ticket-Card per `keyExtractor` und animiert
          // sie smooth von alter zu neuer Position. Dauer passend zu den
          // anderen App-Animationen (Home-Slide, Details-Slide).
          itemLayoutAnimation={LinearTransition.duration(320)}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => {
                haptic("button");
                refreshFresh();
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
                  refreshFresh();
                }}
                style={styles.retryBtn}
              >
                <GradientFill />
                <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
                <Text style={styles.retryBtnText}>{t("results.retry")}</Text>
              </RippleTouch>
            </View>
          }
          ListFooterComponent={
            mode === "TRAIN" && paginationToken && sorted.length > 0 ? (
              <View style={styles.laterWrap}>
                <RippleTouch
                  onPress={loadMore}
                  disabled={isLoadingMore}
                  style={({ pressed }) => [styles.laterBtn, pressed && { opacity: 0.85 }]}
                >
                  <GradientFill />
                  <Text style={styles.laterBtnText}>
                    {isLoadingMore ? t("results.loading") : t("results.later")}
                  </Text>
                </RippleTouch>
              </View>
            ) : null
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

  // Hin/Rück-Toggle — visuell wie im Saved-Tab (Reise/Tickets-Segment):
  // dunkler Pill-Container, aktive Pille mit Lime-Background.
  dirToggleWrap: { paddingHorizontal: 16, paddingTop: 12 },
  dirToggle: {
    flexDirection: "row",
    backgroundColor: "#242425",
    borderRadius: 16,
    padding: 4,
  },
  dirSeg: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  dirSegActive: { backgroundColor: C.lime },
  dirSegText: { color: "#8A8A90", fontSize: 13, fontWeight: "500" },
  dirSegTextActive: { color: "#000000", fontSize: 13, fontWeight: "700" },

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

  /* „Später"-Pagination-Button am Listenende */
  laterWrap: { paddingTop: 16, paddingBottom: 8, alignItems: "center" },
  laterBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 9999,
    overflow: "hidden",
  },
  laterBtnText: { color: C.black, fontWeight: "800", fontSize: 14, letterSpacing: -0.1 },
});
