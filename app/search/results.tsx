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
  Train,
  Bus,
  ArrowLeftRight,
  ArrowUpDown,
  SlidersHorizontal,
  RotateCcw,
  WifiOff,
} from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import Animated, {
  FadeIn,
  FadeOut,
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
import { MOTION, revealEntering } from "@/lib/motion";
import { GUTTER } from "@/lib/theme/spacing";

type SortKey = "cheapest" | "fastest" | "direct";

const C = {
  bg: "#1A1A1A",
  card: "#1F1F20",
  border: "#2E2E30",
  surface3: "#2A2A2C",
  text: "#FFFFFF",
  gray200: "#C8C8CC",
  sub: "#8A8A90",
  subDim: "#56565C",
  lime: "#7FEA4D",
  black: "#000000",
};

// Max. gleichzeitig gerenderte Treffer. Die Suche liefert oft 100+ Flüge —
// alle zu rendern laggt den Client. Wir zeigen PAGE_SIZE, halten den Rest im
// Speicher und enthüllen pro „Mehr"-Tap die nächsten PAGE_SIZE (instant, KEIN
// Re-Request). Erst wenn alle geladenen Treffer sichtbar sind, wird frisch
// nachgeladen.
const PAGE_SIZE = 20;

/**
 * Preislose Treffer (Zug ohne bahn.de-Anreicherung → price 0) hinten einsortieren.
 *
 * WICHTIG: kein `Infinity`. Zwei preislose Treffer ergäben `Infinity - Infinity`
 * = NaN, und ein Comparator, der NaN liefert, ist undefiniertes Verhalten — die
 * Reihenfolge kann beliebig verwürfelt werden. Genau das träfe die Zug-Liste, in
 * der aktuell ALLE Preise 0 sind: das serverseitige Ranking nach
 * Verbindungsqualität wäre dahin. Mit einem endlichen Wert vergleichen sie
 * gleich (0) → der stabile Array.sort erhält die Server-Reihenfolge.
 */
const priceForSort = (p: number) => (p > 0 ? p : Number.MAX_SAFE_INTEGER);

function sortResults(list: SearchResult[], sort: SortKey): SearchResult[] {
  const copy = [...list];
  // Gleichstand → frühere Abfahrt zuerst. Ohne Tiebreak entschiede allein die
  // (zufällige) Eingangsreihenfolge.
  const byDeparture = (a: SearchResult, b: SearchResult) =>
    Date.parse(a.departTime) - Date.parse(b.departTime);
  const byPrice = (a: SearchResult, b: SearchResult) =>
    priceForSort(a.price) - priceForSort(b.price);

  switch (sort) {
    case "fastest":
      return copy.sort((a, b) => a.durationMinutes - b.durationMinutes || byDeparture(a, b));
    // Preis-Sortierungen bewusst OHNE weiteren Tiebreak: bei Gleichstand (alle
    // Zug-Preise 0) bleibt so die Server-Reihenfolge nach Verbindungsqualität
    // erhalten — das ist die sinnvollste Anzeige, solange es keine Preise gibt.
    case "direct":
      return copy.filter((r) => r.stops === 0).sort(byPrice);
    default:
      return copy.sort(byPrice);
  }
}

/**
 * Vorher: `label.split(",")[0]` — alles nach dem ersten Komma weg.
 *
 * Das zerstört genau die Information, um die es geht. Deutsche ÖPNV-Halte heißen
 * „Stadt, Halt": Aus „Werl, Krankenhaus" → „Werl, Rathaus" wurde in der Kopfzeile
 * „Werl → Werl". Die Suche lief korrekt (13 Treffer, 9 Min), aber der User sah
 * eine Suche von einem Ort zu sich selbst und musste annehmen, wir hätten seine
 * Auswahl verworfen.
 *
 * Ein Land steht in unseren Labels nie hinter dem Komma (`country` ist eine
 * eigene Spalte) — es gab also nichts abzuschneiden. Der Header klemmt lange
 * Namen bereits selbst (numberOfLines=2 + adjustsFontSizeToFit).
 */
function stationLabel(label: string): string {
  return label.trim();
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
    departTime?: string;
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

  // Richtung tauschen. Wir schreiben die Route-Params um (origin↔destination,
  // Labels mit), sonst nichts. Die useQuery unten ist auf origin/destination
  // gekeyed → der Params-Wechsel löst automatisch eine neue Suche mit
  // vertauschter Strecke aus, kein manuelles refetch nötig.
  const handleSwap = useCallback(() => {
    // Haptik + Rotation + Spam-Lock macht die RouteHeader (doSwap) selbst; hier
    // nur noch der eigentliche Routentausch. Läuft eine rAF später (siehe
    // doSwap), damit die Rotation vor dem Query-Remount startet.
    if (!origin || !destination) return;
    router.setParams({
      origin: destination,
      destination: origin,
      originLabel: destLabel,
      destLabel: originLabel,
    });
  }, [router, origin, destination, originLabel, destLabel]);
  const departDate = p.departDate ?? "";
  // Uhrzeit aus dem Datums-/Zeit-Picker (UTC-ISO). Muss in JEDEN Query-Key und
  // jeden Suchaufruf — sonst sucht der Server ab einer Default-Zeit statt ab
  // dem gewünschten Zeitpunkt, und zwei Suchen derselben Strecke zu
  // verschiedenen Uhrzeiten würden sich gegenseitig aus dem Cache bedienen.
  const departTime = p.departTime ?? "";
  const returnDate = p.returnDate ?? "";
  const passengers = Number(p.passengers ?? "1");
  const currency = p.currency ?? "EUR";
  const travelClass = p.travelClass ?? "";

  // Flag dass die NÄCHSTE queryFn-Ausführung den Server-Cache umgeht.
  // Initial-Load nutzt Cache (schnell + spart Provider-Anfrage), Refresh per
  // Pull-Down / Refresh-Button nutzt nocache=1 (frische Preise).
  const forceFreshRef = useRef(false);


  const { data, isLoading, isFetching, isError, error, refetch, isRefetching } = useQuery<SearchResponse>({
    queryKey: ["search", mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass],
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
          ...(departTime ? { departTime } : {}),
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
    () => ["search", mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass],
    [mode, origin, destination, departDate, departTime, returnDate, passengers, currency, travelClass],
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
          ...(departTime ? { departTime } : {}),
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
  }, [mode, origin, destination, originLabel, destLabel, departDate, departTime, returnDate, passengers, currency, travelClass, queryKey, queryClient]);

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
          ...(departTime ? { departTime } : {}),
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
        <RouteHeader
          fromLabel={stationLabel(originLabel)}
          toLabel={stationLabel(destLabel)}
          // An !showResults, NICHT isLoading: showResults wird bei JEDEM
          // Routenwechsel (auch Swap) auf false gesetzt und der Loader läuft
          // mindestens einen Zyklus. isLoading dagegen ist beim Swap zu einer
          // gecachten Gegenrichtung false — dann blieb der alte Zählerstand
          // stehen statt der Lade-Welle. So läuft die Welle im Header genau,
          // während unten der Such-Loader läuft.
          loading={!showResults}
          busy={!showResults}
          resultCount={sorted.length}
          accentSolid={accent.solid}
          accentSubtle={accent.subtle}
          onSwap={handleSwap}
          onChange={() => {
            haptic("button");
            router.back();
          }}
        />

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
        // exiting: Der Loader verschwand bisher HART — Boo war da, im nächsten
        // Frame stand die Liste. Genau dieser Schnitt liest sich als „Aufploppen",
        // egal wie sauber die Liste danach einblendet. Jetzt blendet er aus,
        // während die Karten von unten hochwandern: eine Bewegung, keine zwei.
        <Animated.View
          entering={FadeIn.duration(220)}
          exiting={FadeOut.duration(MOTION.duration / 2)}
          style={{ flex: 1 }}
        >
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
          {/* Die rohe Fehlermeldung ist Entwickler-Text: unübersetzt (kommt aus
              lib/api/client.ts), enthält die interne Server-URL und braucht drei
              Zeilen, die das Layout auseinanderziehen. Dem User sagen Titel und
              Text oben bereits alles. Im Dev-Build bleibt sie zum Debuggen. */}
          {__DEV__ && error instanceof Error ? (
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
            totalCount={outboundSorted.length}
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
            totalCount={returnSorted.length}
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
          totalCount={outboundSorted.length}
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

/**
 * Verbindungs-Header (vertikales Design): Abfahrt oben, Ziel darunter, eine
 * gestrichelte Route durch beide Felder, ein Akzent-Swap-Button, der die Route
 * dreht, plus Meta-Zeile mit Ergebniszahl und „Ändern".
 *
 * Übernommen aus einer externen Design-Vorlage, aber an unsere Prinzipien
 * angepasst: Akzent-System statt Lime, fontWeight statt Inter-fontFamily, alle
 * Strings über useT, Tokens fürs Spacing — und die Swap-Rotation auf Reanimated,
 * weil klassisches RN-Animated (useNativeDriver) auf der New Architecture am
 * Startwert hängen bleibt.
 */
// Marker-Mitte: Feld-paddingLeft (18) + halbe Marker-Spalte (6).
const RH_RAIL_X = 24;
// Feld-paddingVertical (18) + halbe Textzeile (lineHeight 26 → 13) = 31.
const RH_RAIL_INSET_Y = 31;
// Dauer der Swap-Icon-Drehung. Der eigentliche Routentausch startet danach,
// damit die Drehung ungestört durchläuft (siehe doSwap).
const SWAP_ROTATE_MS = 320;

function RouteHeader({
  fromLabel,
  toLabel,
  loading,
  busy,
  resultCount,
  accentSolid,
  accentSubtle,
  onSwap,
  onChange,
}: {
  fromLabel: string;
  toLabel: string;
  loading: boolean;
  /** Suche läuft → Swap gesperrt (Abuse-Schutz) und Button gedimmt. */
  busy: boolean;
  resultCount: number;
  accentSolid: string;
  accentSubtle: string;
  onSwap: () => void;
  onChange: () => void;
}) {
  const t = useT();
  const [fieldsHeight, setFieldsHeight] = useState(0);
  // Dreht bei jedem Tausch um 180°. Reanimated, nicht RN-Animated (siehe oben).
  //
  // Timing 1:1 vom Search-Hero (SearchHero.tsx handleSwap): 320 ms easeOutCubic.
  //
  // Target über einen Ref, NICHT spin.value + 180: Bei Doppelklick während der
  // Drehung hätte spin.value einen interpolierten Zwischenwert (z.B. 90°), und
  // +180 ergäbe 270 statt 360 — die zweite Drehung ruckelte. Der Ref
  // inkrementiert immer sauber um 180.
  const spin = useSharedValue(0);
  const spinTarget = useRef(0);
  const swapIconStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  // Spam-/Abuse-Schutz: Jeder Swap löst eine echte Suche aus (Netzwerk, DB-
  // Kontingent). Ein synchrones Lock verhindert, dass man den Button schneller
  // drückt, als die Suche fertig wird — inkl. Doppel-Tap im SELBEN Frame, den
  // ein State-/Prop-Guard nicht abfängt (der aktualisiert sich erst nach dem
  // Render). Freigegeben wird erst, wenn die laufende Suche durch ist (busy →
  // false), also frühestens nach einem vollen Loader-Zyklus.
  const swapLock = useRef(false);
  useEffect(() => {
    if (!busy) swapLock.current = false;
  }, [busy]);

  // Timer, der die eigentliche Suche NACH der Drehung startet. Beim Unmount
  // abbrechen, sonst feuert setParams evtl. auf einer schon verlassenen Route.
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (swapTimer.current) clearTimeout(swapTimer.current);
  }, []);

  const doSwap = () => {
    if (swapLock.current || busy) return;
    swapLock.current = true;
    haptic("button");
    spinTarget.current += 180;
    spin.value = withTiming(spinTarget.current, {
      duration: SWAP_ROTATE_MS,
      easing: Easing.out(Easing.cubic),
    });
    // Die schwere Kette (Params-Wechsel → Query-Refetch → Boo-Loader-Mount, 33
    // Reanimated-Hooks) startet ERST NACH der Drehung. Feuert sie währenddessen,
    // jankt der Mount mitten in die Rotation („smooth, dann stockt es") — genau
    // das war das Problem. Ein rAF reichte nicht. So läuft die Rotation komplett
    // unabhängig auf dem UI-Thread, wie im Hero (der beim Swap nur leichtes
    // lokales State-Update macht). Der Preis: die Suche startet ~300 ms später —
    // unmerklich, und die Drehung liest sich ohnehin als „löst den Tausch aus".
    swapTimer.current = setTimeout(() => onSwap(), SWAP_ROTATE_MS);
  };

  const railHeight = Math.max(0, fieldsHeight - RH_RAIL_INSET_Y * 2);

  return (
    <View style={styles.routePanel}>
      <View style={styles.rhFieldsWrap}>
        {/* Gestrichelte Route durch beide Felder — als gestrichelter Border einer
            2px breiten View, kein SVG nötig. */}
        {railHeight > 0 ? (
          <View
            pointerEvents="none"
            style={[styles.rhRail, { top: RH_RAIL_INSET_Y, height: railHeight }]}
          />
        ) : null}

        <View
          style={styles.rhFields}
          onLayout={(e) => setFieldsHeight(e.nativeEvent.layout.height)}
        >
          {/* Abfahrt */}
          <View style={styles.rhField}>
            <View style={styles.rhMarkerCol}>
              <View style={styles.rhOriginDot} />
            </View>
            <Text
              style={styles.rhStation}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {fromLabel}
            </Text>
          </View>

          {/* Ziel */}
          <View style={styles.rhField}>
            <View style={styles.rhMarkerCol}>
              <View style={[styles.rhDestGlow, { backgroundColor: accentSubtle }]}>
                <View style={[styles.rhDestPin, { backgroundColor: accentSolid }]} />
              </View>
            </View>
            <Text
              style={styles.rhStation}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {toLabel}
            </Text>
          </View>
        </View>

        {/* Swap-Button — überlappt beide Felder rechts, Rand in Kartenfarbe für
            die „ausgestanzt"-Optik. Es rotiert NUR das Icon, nicht der ganze
            Button: Den umrandeten, overflow:hidden-geclippten Button pro Frame zu
            drehen zwang Android zum Neurastern (wie beim Schatten) und ruckelte —
            der Hero dreht ebenfalls nur das Icon. */}
        <View style={[styles.rhSwapWrap, busy && styles.rhSwapWrapBusy]}>
          <RippleTouch
            borderless
            onPress={doSwap}
            style={[styles.rhSwapBtn, { backgroundColor: accentSolid }]}
            accessibilityLabel={t("results.change")}
          >
            <Animated.View style={swapIconStyle}>
              <ArrowUpDown color={C.black} size={20} strokeWidth={2.6} />
            </Animated.View>
          </RippleTouch>
        </View>
      </View>

      {/* Meta-Zeile: Ergebniszahl links in einer Box, „Ändern" rechts — beide
          dieselbe Pill-Optik. */}
      <View style={styles.rhMetaRow}>
        <View style={styles.rhCountPill}>
          <Text style={styles.rhCountText} numberOfLines={1}>
            {loading ? t("results.searching") : `${resultCount} ${t("results.count")}`}
          </Text>
          {loading ? <LoadingDots /> : null}
        </View>
        <RippleTouch onPress={onChange} style={styles.rhChangeBtn}>
          <Text style={styles.rhChangeText}>{t("results.change")}</Text>
          <ArrowLeftRight color={C.text} size={14} />
        </RippleTouch>
      </View>
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
  /** Wie viele Treffer INSGESAMT vorliegen (`data` ist auf visibleCount beschnitten).
   *  Liegt mehr vor als sichtbar ist, gibt es etwas aufzudecken — auch in Modi
   *  ohne Server-Pagination. */
  totalCount: number;
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
  totalCount,
  accentSolid,
  tEmpty,
  tRetry,
  tLater,
  tMore,
  tLoading,
}: ResultsListViewProps) {
  // Mehr Treffer geladen als sichtbar? Dann kann der Footer sie lokal aufdecken.
  const hasHidden = totalCount > data.length;
  const showFooter =
    data.length > 0 && (hasHidden || mode === "TRAIN" || mode === "FLIGHT");

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
        // Dieselbe Welle wie in den Tabs (lib/motion.tsx) — vorher hatte der
        // Ergebnis-Screen ein eigenes Timing (50ms Versatz, 320ms, großer
        // FadeInDown-Weg) und fühlte sich dadurch an wie eine andere App.
        <Animated.View entering={revealEntering(index)}>
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
        // Zwei Gründe für den Footer, vorher nur einer:
        //
        // 1. Es liegen mehr Treffer vor als sichtbar sind (die Liste wird auf
        //    PAGE_SIZE=20 beschnitten). Der Button deckt sie lokal auf, ohne Netz.
        //    Das galt bisher NUR für TRAIN/FLIGHT — bei einer Bus-Suche mit 23
        //    Treffern waren die letzten drei schlicht unerreichbar, weil der
        //    Footer nie gerendert wurde. (Das Aufdecken selbst konnte
        //    handleShowMore längst — es fehlte nur der Knopf dafür.)
        // 2. Der Modus kann serverseitig nachladen (Zug: HAFAS-„später",
        //    Flug: frische Suche).
        showFooter ? (
          <View style={styles.laterWrap}>
            <RippleTouch
              onPress={loadMore}
              disabled={isLoadingMore}
              style={({ pressed }) => [styles.laterBtn, pressed && { opacity: 0.85 }]}
            >
              <GradientFill />
              <Text style={styles.laterBtnText}>
                {isLoadingMore ? tLoading : hasHidden || mode === "FLIGHT" ? tMore : tLater}
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
    marginHorizontal: GUTTER,
    marginTop: 12,
    // KEIN gap mehr: Der Abstand zur Meta-Zeile kommt allein aus deren
    // marginTop. Vorher addierten sich gap (14) UND marginTop (12) zu 26 px
    // oben, während unten nur die 16 px paddingBottom standen — der „Ändern"-
    // Button klebte sichtbar näher am unteren Rand. Jetzt rundum 16.
    padding: 16,
  },
  // ── RouteHeader (vertikales Design) ──────────────────────────────────────
  rhFieldsWrap: { position: "relative" },
  rhFields: { gap: 8 },
  rhRail: {
    position: "absolute",
    left: RH_RAIL_X - 1,
    width: 0,
    borderLeftWidth: 2,
    borderColor: C.subDim,
    borderStyle: "dashed",
    zIndex: 1,
  },
  rhField: {
    backgroundColor: C.bg,
    borderRadius: 18,
    paddingVertical: 18,
    paddingLeft: 18,
    paddingRight: 80,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minWidth: 0,
  },
  rhMarkerCol: { width: 12, alignItems: "center", zIndex: 2 },
  rhOriginDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 2.5,
    borderColor: C.sub,
    backgroundColor: C.bg,
  },
  rhDestGlow: {
    width: 19,
    height: 19,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: -4,
  },
  rhDestPin: { width: 11, height: 11, borderRadius: 6 },
  rhStation: {
    flex: 1,
    fontSize: 22,
    fontWeight: "800",
    letterSpacing: -0.44,
    color: C.text,
    lineHeight: 26,
  },
  rhSwapWrap: {
    position: "absolute",
    right: 6,
    top: "50%",
    marginTop: -27,
    zIndex: 3,
  },
  // Während eine Suche läuft: Swap gesperrt → sichtbar gedimmt, damit der
  // no-op-Tap nicht wie ein toter Button wirkt.
  rhSwapWrapBusy: { opacity: 0.5 },
  // Flacher Akzent-Kreis wie im Hero: backgroundColor kommt inline (accentSolid),
  // KEIN overflow:hidden und KEIN GradientFill-Kind. Genau die zwei sorgten dafür,
  // dass Android den geclippten Container jedes Mal neu compositete, wenn das Icon
  // darin rotierte — das war das Ruckeln. Der 5px-Rand in Kartenfarbe bleibt (die
  // „ausgestanzt"-Optik) und stört die Rotation nicht, weil er nichts clippt.
  rhSwapBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    borderWidth: 5,
    borderColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  rhMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 16,
    gap: 10,
  },
  // Ergebniszahl und „Ändern" teilen sich die Zeile hälftig: beide flex:1, also
  // gleich breit bis zur Mitte, Inhalt zentriert. Der 10-px-gap der Zeile trennt
  // sie, links und rechts hält das routePanel-Padding (16) den Rand.
  rhCountPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minWidth: 0,
    backgroundColor: C.surface3,
    borderRadius: 9999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  rhCountText: { flexShrink: 1, fontSize: 13, fontWeight: "600", color: C.gray200 },
  rhChangeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    backgroundColor: C.surface3,
    borderRadius: 9999,
    paddingVertical: 9,
    paddingHorizontal: 15,
  },
  rhChangeText: { fontSize: 12, fontWeight: "700", color: C.text },

  dotsRow: { flexDirection: "row", gap: 3, marginLeft: 4 },
  smallDot: { width: 4, height: 4, borderRadius: 2 },

  // Hin/Rück-Toggle — visuell wie im Saved-Tab (Reise/Tickets-Segment):
  // dunkler Pill-Container, aktive Pille mit Lime-Background.
  dirToggleWrap: { paddingHorizontal: GUTTER, paddingTop: 12 },
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
    paddingHorizontal: GUTTER,
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

  listContent: { paddingHorizontal: GUTTER, paddingTop: 4, paddingBottom: 110 },
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
    paddingHorizontal: GUTTER,
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
