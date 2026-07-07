import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, InteractionManager } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
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
  FadeIn,
  FadeInDown,
  LinearTransition,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { TravelMode, SearchResult, SearchResponse } from "@/types/search";
import { searchByMode } from "@/lib/api/client";
import { ResultCard } from "@/components/results/ResultCard";
import { RandomSearchLoader } from "@/components/results/search-loaders/RandomSearchLoader";
import { useT } from "@/lib/i18n/useT";
import { overlayCover, UNDERLAY_TRAVEL_FRAC, PUSH_DURATION, PUSH_IN_EASING, POP_DURATION, POP_EASING } from "@/lib/nav/overlayCover";
import { useSearchStore } from "@/stores/searchStore";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import { tripSignature } from "@/lib/results/signature";
import { useAccent } from "@/lib/theme/accent";

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

// Max. gleichzeitig gerenderte Treffer. Die Suche liefert oft 100+ Flüge —
// alle zu rendern laggt den Client. Wir zeigen PAGE_SIZE, halten den Rest im
// Speicher und enthüllen pro „Mehr"-Tap die nächsten PAGE_SIZE (instant, KEIN
// Re-Request). Erst wenn alle geladenen Treffer sichtbar sind, wird frisch
// nachgeladen.
const PAGE_SIZE = 20;

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
  const accent = useAccent();
  const router = useRouter();
  const navigation = useNavigation();
  const t = useT();
  const [sort, setSort] = useState<SortKey>("cheapest");

  // Slide-In identisch zu DetailsOverlay „Buchung wählen": Reanimated-
  // Worklet auf UI-Thread, Animation startet erst NACH dem ersten Paint
  // (rAF), sodass JS-Thread die Zeit hat den schweren Subtree (useQuery,
  // RandomSearchLoader-Worklets, Reset-Effect, etc.) zu mounten BEVOR die
  // Animation läuft. Sonst stutter't der Slide weil JS noch beschäftigt ist
  // während UI-Thread-Worklets rendern wollen.
  const screenWidth = useWindowDimensions().width;
  const slideX = useSharedValue(screenWidth);
  // slideX = eigener Slide-In der Results; overlayCover = Parallax, wenn ein
  // Detail-Overlay DARÜBER reinslidet (verschiebt nur diesen Screen, nicht den
  // ganzen Stack → leichter Baum, kein teures Re-Record des MainActivity-Trees).
  const slideStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: slideX.value + overlayCover.value * screenWidth * UNDERLAY_TRAVEL_FRAC },
    ],
  }));
  useEffect(() => {
    // Slide-Start verzögern bis JS-Thread idle ist (= Loader fertig
    // gemountet, SVG-Tree und Shared-Values alle erzeugt). Sonst konkurriert
    // das Mounten der Scene mit dem Slide-Worklet auf dem UI-Thread →
    // Frame-Drops. InteractionManager wartet auf das Ende aller laufenden
    // Interactions und führt dann den Callback aus.
    // Fallback-Timeout (140ms) für den Worst-Case wo InteractionManager
    // ewig wartet — sonst würde sich der Screen nicht öffnen.
    let started = false;
    const triggerSlide = () => {
      if (started) return;
      started = true;
      slideX.value = withTiming(
        0,
        { duration: PUSH_DURATION, easing: PUSH_IN_EASING },
        (finished) => {
          // Slide fertig → Loader-Animationen können losgehen (paused-flag
          // unten wird durch contentReady gesteuert).
          if (finished) runOnJS(setContentReady)(true);
        },
      );
    };
    // Wir warten auf einen 2-Frame-Delay (rAF×rAF) statt sofort: gibt
    // React zwei Commit-Passes Zeit den schweren Subtree (useQuery,
    // RandomSearchLoader, ResultCards) zu mounten BEVOR der Slide
    // loslegt. Sonst kämpft die withTiming-Worklet mit dem Mount-Work.
    // InteractionManager + 220ms Fallback fängt langsame Geräte ab.
    const handle = InteractionManager.runAfterInteractions(() => {
      requestAnimationFrame(() => requestAnimationFrame(triggerSlide));
    });
    const fallback = setTimeout(triggerSlide, 220);
    return () => {
      handle.cancel();
      clearTimeout(fallback);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // contentReady wird unten exakt am Slide-Ende via withTiming-Callback
  // gesetzt — damit start die Loader-Animation millisekundengenau dann,
  // wenn der Slide fertig ist. Kein hartcodiertes setTimeout(320) das je
  // nach Mount-Speed zu früh oder zu spät feuern könnte.
  const [contentReady, setContentReady] = useState(false);

  // Slide-Out: wenn der User wegnavigiert (Back-Gesture, Hardware-Back,
  // router.back), intercepten wir via beforeRemove, blocken den Default-Pop,
  // animieren slideX zurück auf screenWidth und dispatchen dann die
  // Original-Aktion. Gleiches Pattern wie DetailsOverlay.
  const isClosingRef = useRef(false);
  useEffect(() => {
    const unsub = navigation.addListener("beforeRemove", (e) => {
      if (isClosingRef.current) return;
      // Wenn von außen (z.B. "Ansehen"-Click im SavedToast) angefragt wurde,
      // die Slide-Out-Animation zu überspringen: Flag konsumieren, Default-
      // Aktion durchlassen. Modal pop'pt instant, kein UI-Thread-Konflikt
      // mit dem parallel laufenden Tab-Switch + Overlay-Unmount.
      const store = useSearchStore.getState();
      if (store.bypassResultsSlideOut) {
        store.setBypassResultsSlideOut(false);
        return; // beforeRemove default = pop sofort
      }
      e.preventDefault();
      isClosingRef.current = true;
      slideX.value = withTiming(
        screenWidth,
        { duration: POP_DURATION, easing: POP_EASING },
        (finished) => {
          if (finished) {
            runOnJS(navigation.dispatch)(e.data.action);
          }
        },
      );
    });
    return unsub;
  }, [navigation, screenWidth, slideX]);

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


  const { data, isLoading, isFetching, isError, error, refetch, isRefetching } = useQuery<SearchResponse>({
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
    // Query erst feuern wenn Slide-In durch ist (contentReady=true). Sonst
    // startet die queryFn + Promise + spätere setState-Cascade mitten im
    // Slide — und auch wenn das nur ein paar ms ist, jeder kleine JS-Tick
    // während der Animation kann die Slide-Worklet-Schedules stören.
    enabled: Boolean(origin && destination && departDate) && contentReady,
    retry: 1,
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // 'always' statt false — auch bei vorhandenem Cache wird im Hintergrund
    // refetched. Das verhindert den Bug wo der User Cache mit leerem Result
    // sieht (z.B. von früherem Provider-Fail) und sofort die Empty-State-UI
    // angezeigt bekommt statt erst den Loader. Mit 'always' bleibt
    // isFetching=true während des Refetch und der Loader bleibt sichtbar.
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  // Loader spielt seine Animation in Loops; bei jedem vollen Cycle-Ende
  // feuert er einen Puls. Wir transitionen nur dann auf die Tickets wenn
  // die Query KOMPLETT settled ist — kein laufender Initial-Load, kein
  // laufender Retry (React-Query macht bei retry:1 automatisch einen
  // zweiten Versuch, während dem isFetching=true ist) und kein Background-
  // Refresh. Damit sieht der User nicht die Error-UI während ein Retry
  // läuft, und die Tickets erscheinen sauber wenn die Daten wirklich da
  // sind.
  const [showResults, setShowResults] = useState(false);
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;
  const isFetchingRef = useRef(isFetching);
  isFetchingRef.current = isFetching;
  const onLoaderCyclePulse = useCallback(() => {
    if (!isLoadingRef.current && !isFetchingRef.current) {
      setShowResults(true);
    }
  }, []);

  const autoRetriedRef = useRef(false);

  // Derived-State-During-Render Pattern (React-empfohlen). Wenn sich Origin/
  // Destination/Date/Mode ändern (= neue Suche), setzen wir showResults
  // direkt DURING dem Render zurück — bevor irgendwas gepainted wird. Das
  // ist strikt besser als useEffect oder useLayoutEffect: bei beiden gibt es
  // einen Frame wo der alte Zustand gerendert wird, was den Retry-Button-
  // Flash und das „Animation A → Animation B"-Stottern verursachte.
  // React schmeißt diesen Render weg und macht sofort einen neuen mit dem
  // korrekten State — kein wasted paint, kein Flicker.
  const searchKey = `${mode}|${origin}|${destination}|${departDate}`;
  const lastSearchKeyRef = useRef(searchKey);
  if (lastSearchKeyRef.current !== searchKey) {
    lastSearchKeyRef.current = searchKey;
    autoRetriedRef.current = false;
    // setState während Render: React verwirft diesen Render-Pass und
    // re-rendert sofort mit dem aktualisierten Wert. Hier IMMER false —
    // der Loader muss IMMER mindestens einen vollen Cycle laufen.
    setShowResults(false);
  }
  // Auto-Retry bei intermittierenden Provider-Fails: wenn die Suche fertig
  // ist und LEER zurückkommt (HAFAS-/dbVendo-Schluckauf bei Cross-Border-
  // Routen wie München→Prag), versuchen wir EINMAL automatisch frisch zu
  // fetchen statt sofort die „Keine Treffer"-UI anzuzeigen. Bei echtem
  // Leerstand (Strecke wirklich ohne Verbindung) bleibt's beim zweiten Mal
  // auch leer und wir zeigen die Empty-State.
  useEffect(() => {
    if (
      data &&
      data.results.length === 0 &&
      !isFetching &&
      !isLoading &&
      !autoRetriedRef.current
    ) {
      autoRetriedRef.current = true;
      forceFreshRef.current = true; // Server-Cache überspringen
      refetch();
    }
  }, [data, isFetching, isLoading, refetch]);

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
  // Wie viele Treffer aktuell sichtbar sind (Rest bleibt im Speicher). Bei jeder
  // neuen Suche zurück auf PAGE_SIZE.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const dataFetchedAt = data?.fetchedAt;
  useEffect(() => {
    setExtraResults([]);
    setPaginationToken(data?.paginationToken);
    setVisibleCount(PAGE_SIZE);
  }, [dataFetchedAt, data?.paginationToken]);

  const allResults = [...(data?.results ?? []), ...extraResults];

  const loadMore = async () => {
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    haptic("button");
    try {
      // Bevorzugt mit HAFAS-paginationToken arbeiten (echtes „laterThan").
      // Fallback wenn der Server keinen Token geliefert hat: nimm den letzten
      // sichtbaren Outbound-Treffer und such ab dessen Abfahrtszeit + 1 min.
      // So funktioniert „Später" auch dann wenn HAFAS keinen laterRef im
      // Response hatte (kommt bei manchen Routes intermittent vor).
      let opt: { paginationToken?: string; nocache?: boolean } | undefined;
      let extraDepartTime: string | undefined;
      if (mode === "FLIGHT") {
        // Flüge haben kein Pagination-Token. Die API ist nicht-deterministisch
        // (mal 8, mal 99 Treffer). „Mehr Ergebnisse" = eine FRISCHE Suche
        // (nocache) — die neuen, eindeutigen Treffer werden unten gemerged +
        // per Signatur dedupliziert. So wächst die Liste on-demand Richtung
        // Vollbild, ohne bei jeder Erstsuche Requests zu verschwenden.
        opt = { nocache: true };
      } else if (paginationToken) {
        opt = { paginationToken };
      } else {
        const lastOutbound = [...allResults]
          .reverse()
          .find((r) => r.direction !== "RETURN");
        if (lastOutbound?.departTime) {
          const t = new Date(lastOutbound.departTime);
          if (Number.isFinite(t.getTime())) {
            extraDepartTime = new Date(t.getTime() + 60_000).toISOString();
          }
        }
      }
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
          ...(extraDepartTime ? { departTime: extraDepartTime } : {}),
        },
        opt,
      );
      setExtraResults((prev) => [...prev, ...next.results]);
      setPaginationToken(next.paginationToken);
      // Frisch nachgeladene Treffer auch sichtbar machen.
      setVisibleCount((v) => v + PAGE_SIZE);
    } catch {
      // Bei Fehler den Token behalten — User kann erneut auf „Später" tippen.
    } finally {
      setIsLoadingMore(false);
    }
  };
  const hasReturnLeg = allResults.some((r) => r.direction === "RETURN");
  const showDirectionToggle =
    Boolean(returnDate) && hasReturnLeg && (mode === "TRAIN" || mode === "BUS");

  // Outbound + Return separat sortieren — beide Listen werden side-by-side
  // im SlidingPanels gemountet (analog zum Saved-Tab Reisen/Tickets-Swipe).
  // Direction-Toggle triggert nur einen translateX am SlidingPanels-Wrapper,
  // keinen FlatList-Remount.
  const { outboundSorted, returnSorted } = useMemo(() => {
    const dedupe = (list: SearchResult[]): SearchResult[] => {
      const seen = new Set<string>();
      const out: SearchResult[] = [];
      for (const r of list) {
        // Flüge: per „Mehr Ergebnisse" frisch nachgeladene Treffer haben NEUE
        // DB-IDs für denselben Flug → nach ID würde nicht dedupliziert. Daher
        // für Flüge die stabile Trip-Signatur als Schlüssel; sonst die ID.
        const key =
          mode === "FLIGHT"
            ? `${r.direction ?? "OUTBOUND"}-${tripSignature(r)}`
            : `${r.direction ?? "OUTBOUND"}-${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
      return out;
    };
    const outbound = allResults.filter((r) => r.direction !== "RETURN");
    const returnLeg = allResults.filter((r) => r.direction === "RETURN");
    return {
      outboundSorted: sortResults(dedupe(outbound), sort),
      returnSorted: sortResults(dedupe(returnLeg), sort),
    };
  }, [allResults, sort, mode]);

  // Aktive Liste für Header-Count + Empty-Detection (volle, ungeschnittene Liste).
  const sorted = showDirectionToggle
    ? direction === "RETURN"
      ? returnSorted
      : outboundSorted
    : outboundSorted;

  // "Mehr": zuerst die nächsten PAGE_SIZE aus dem bereits geladenen Set zeigen
  // (instant, kein Request). Erst wenn ALLE geladenen Treffer sichtbar sind,
  // frisch nachladen (loadMore — langsamer Pfad).
  const fullCount = Math.max(outboundSorted.length, returnSorted.length);
  const canRevealMore = visibleCount < fullCount;
  const handleShowMore = () => {
    if (canRevealMore) {
      haptic("button");
      setVisibleCount((v) => v + PAGE_SIZE);
    } else {
      loadMore();
    }
  };

  const tabs: { key: SortKey; labelKey: string }[] = [
    { key: "cheapest", labelKey: "results.sort.cheapest" },
    { key: "fastest", labelKey: "results.sort.fastest" },
    { key: "direct", labelKey: "results.sort.direct" },
  ];

  return (
    <Animated.View style={[styles.slideRoot, slideStyle]}>
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
          <SegmentedToggle
            items={[
              { id: "OUTBOUND", label: t("results.direction.outbound") },
              { id: "RETURN", label: t("results.direction.return") },
            ]}
            selectedId={direction}
            onChange={(id) => setDirection(id as "OUTBOUND" | "RETURN")}
          />
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
              <Text style={[styles.tabText, active && [styles.tabTextActive, { color: accent.solid }]]}>
                {t(tab.labelKey)}
              </Text>
              {active ? <View style={[styles.tabUnderline, { backgroundColor: accent.solid }]} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.tabsSpacer} />
        <RippleTouch hitSlop={6} borderless style={styles.filterBtn}>
          <SlidersHorizontal color={C.text} size={16} />
        </RippleTouch>
      </View>

      {!showResults ? (
        // contentReady-Gate: Scene wird ERST nach Slide-End gemountet — kein
        // Mount-Cost konkurriert mit dem Slide-Worklet → buttersmoothes
        // Slide. FadeIn-Entering blendet die Scene danach sanft rein, kein
        // hartes Pop. Identisches Pattern wie DetailsOverlay's
        // contentReady-gated ScrollView.
        !contentReady ? null : (
        <Animated.View entering={FadeIn.duration(220)} style={{ flex: 1 }}>
        <RandomSearchLoader
          originLabel={originLabel}
          destLabel={destLabel}
          onCyclePulse={onLoaderCyclePulse}
        />
        </Animated.View>
        )
      ) : isError ? (
        <View style={styles.errorWrap}>
          <View style={styles.errorIcon}>
            <WifiOff size={32} color={accent.solid} strokeWidth={2} />
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
      ) : showDirectionToggle ? (
        // Outbound + Return side-by-side im Pager — Hin/Rück-Toggle triggert
        // nur einen translateX, FlatLists bleiben gemountet → smoother
        // Swipe-Übergang analog zum Saved-Tab Reisen/Tickets-Wechsel.
        <SlidingPanels activeIndex={direction === "OUTBOUND" ? 0 : 1}>
          <ResultsListView
            data={outboundSorted.slice(0, visibleCount)}
            direction="OUTBOUND"
            fetchedAt={data?.fetchedAt ?? ""}
            passengers={passengers}
            mode={mode}
            isRefetching={isRefetching}
            refreshFresh={refreshFresh}
            isLoadingMore={isLoadingMore}
            loadMore={handleShowMore}
            accentSolid={accent.solid}
            tEmpty={t("results.empty")}
            tRetry={t("results.retry")}
            tLater={t("results.later")} tMore={t("results.more")}
            tLoading={t("results.loading")}
          />
          <ResultsListView
            data={returnSorted.slice(0, visibleCount)}
            direction="RETURN"
            fetchedAt={data?.fetchedAt ?? ""}
            passengers={passengers}
            mode={mode}
            isRefetching={isRefetching}
            refreshFresh={refreshFresh}
            isLoadingMore={isLoadingMore}
            loadMore={handleShowMore}
            accentSolid={accent.solid}
            tEmpty={t("results.empty")}
            tRetry={t("results.retry")}
            tLater={t("results.later")} tMore={t("results.more")}
            tLoading={t("results.loading")}
          />
        </SlidingPanels>
      ) : (
        <ResultsListView
          data={outboundSorted.slice(0, visibleCount)}
          direction="OUTBOUND"
          fetchedAt={data?.fetchedAt ?? ""}
          passengers={passengers}
          mode={mode}
          isRefetching={isRefetching}
          refreshFresh={refreshFresh}
          isLoadingMore={isLoadingMore}
          loadMore={handleShowMore}
          accentSolid={accent.solid}
          tEmpty={t("results.empty")}
          tRetry={t("results.retry")}
          tLater={t("results.later")} tMore={t("results.more")}
          tLoading={t("results.loading")}
        />
      )}
      </SafeAreaView>
    </Animated.View>
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
    // Cleanup beim Unmount oder loading-Wechsel — ohne das läuft das
    // withRepeat im UI-Thread weiter wenn die Komponente unmountet wird.
    return () => cancelAnimation(rot);
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
  const accent = useAccent();
  const a = useSharedValue(0);
  useEffect(() => {
    a.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false);
    // Cleanup — sonst läuft das withRepeat-Loop weiter wenn die Component
    // unmountet. Bei jedem Search-Reload mountet/unmountet LoadingDots,
    // ohne Cancel würden die Worklets sich auf der UI-Thread stapeln.
    return () => cancelAnimation(a);
  }, [a]);
  const s1 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0) }));
  const s2 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.33) }));
  const s3 = useAnimatedStyle(() => ({ opacity: 0.3 + 0.7 * pulse(a.value, 0.66) }));
  return (
    <View style={styles.dotsRow}>
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s1]} />
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s2]} />
      <Animated.View style={[styles.smallDot, { backgroundColor: accent.solid }, s3]} />
    </View>
  );
}

function pulse(t: number, phase: number): number {
  "worklet";
  const x = (t + phase) % 1;
  return Math.max(0, Math.sin(x * Math.PI));
}

interface ResultsListViewProps {
  data: SearchResult[];
  direction: "OUTBOUND" | "RETURN";
  fetchedAt: string;
  passengers: number;
  mode: TravelMode;
  isRefetching: boolean;
  refreshFresh: () => void;
  isLoadingMore: boolean;
  loadMore: () => Promise<void> | void;
  accentSolid: string;
  tEmpty: string;
  tRetry: string;
  tLater: string;
  tMore: string;
  tLoading: string;
}

/**
 * Eine FlatList-Spalte für entweder Outbound oder Return. Wird vom Pager
 * (SlidingPanels) zweimal side-by-side gerendert. Key bindet fetchedAt
 * + direction — pro Server-Response remountet die Liste, innerhalb derselben
 * Daten läuft Sort-Reorder via itemLayoutAnimation smooth.
 */
function ResultsListView({
  data,
  direction,
  fetchedAt,
  passengers,
  mode,
  isRefetching,
  refreshFresh,
  isLoadingMore,
  loadMore,
  accentSolid,
  tEmpty,
  tRetry,
  tLater,
  tMore,
  tLoading,
}: ResultsListViewProps) {
  // Entrance-Animation NUR für den initial sichtbaren Batch. Items die später
  // beim Scrollen in den virtualisierten Viewport mounten, sollen NICHT erneut
  // einfaden — das per-Item-FadeInDown bei jedem Scroll-Mount war eine Haupt-
  // Ursache fürs ruckelige Scrollen bei vielen Treffern. Nach einem kurzen
  // Fenster (500ms ab Mount/neuem Datensatz) rendern alle Items plain.
  const enteringEnabledRef = useRef(true);
  useEffect(() => {
    enteringEnabledRef.current = true;
    const id = setTimeout(() => {
      enteringEnabledRef.current = false;
    }, 500);
    return () => clearTimeout(id);
  }, [fetchedAt, direction]);

  const renderItem = useCallback(
    ({ item, index }: { item: SearchResult; index: number }) =>
      enteringEnabledRef.current ? (
        <Animated.View entering={FadeInDown.delay(Math.min(index, 7) * 50).duration(320)}>
          <ResultCard result={item} passengers={passengers} />
        </Animated.View>
      ) : (
        <ResultCard result={item} passengers={passengers} />
      ),
    [passengers],
  );

  return (
    <Animated.FlatList
      key={`${direction}-${fetchedAt}`}
      data={data}
      keyExtractor={(r) => `${r.direction ?? "OUTBOUND"}-${r.id}`}
      renderItem={renderItem}
      // Virtualisierung: ohne diese Limits rendert FlatList (default windowSize
      // 21) bei ~74 Treffern praktisch ALLE Karten gleichzeitig — jede mit
      // eigenen Reanimated-SharedValues + Logo-Images. Das war die Haupt-Ursache
      // fürs Scroll-Lag. Jetzt sind nur ~2-3 Viewports an Karten gemountet.
      initialNumToRender={5}
      maxToRenderPerBatch={6}
      windowSize={5}
      updateCellsBatchingPeriod={50}
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      contentContainerStyle={styles.listContent}
      itemLayoutAnimation={LinearTransition.duration(320)}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => {
            haptic("button");
            refreshFresh();
          }}
          tintColor={accentSolid}
          colors={[accentSolid]}
        />
      }
      ListEmptyComponent={
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>{tEmpty}</Text>
          <RippleTouch
            onPress={() => {
              haptic("button");
              refreshFresh();
            }}
            style={styles.retryBtn}
          >
            <GradientFill />
            <RotateCcw size={16} color={C.black} strokeWidth={2.4} />
            <Text style={styles.retryBtnText}>{tRetry}</Text>
          </RippleTouch>
        </View>
      }
      ListFooterComponent={
        (mode === "TRAIN" || mode === "FLIGHT") && data.length > 0 ? (
          <View style={styles.laterWrap}>
            <RippleTouch
              onPress={loadMore}
              disabled={isLoadingMore}
              style={({ pressed }) => [styles.laterBtn, pressed && { opacity: 0.85 }]}
            >
              <GradientFill />
              <Text style={styles.laterBtnText}>
                {isLoadingMore ? tLoading : mode === "FLIGHT" ? tMore : tLater}
              </Text>
            </RippleTouch>
          </View>
        ) : null
      }
    />
  );
}

const styles = StyleSheet.create({
  // slideRoot ist der Slide-Container — muss flex:1 + bg haben damit er den
  // ganzen Screen abdeckt während er von rechts reinslidet (sonst sieht der
  // User durch transparente Lücken den vorigen Tab).
  slideRoot: { flex: 1, backgroundColor: C.bg },
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
  smallDot: { width: 4, height: 4, borderRadius: 2 },

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
  dirSegActive: {},
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
  tabTextActive: { fontWeight: "700" },
  tabUnderline: {
    height: 2,
    borderRadius: 2,

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
