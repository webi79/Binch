import { memo, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { Star, Train, Bus, TramFront, Plane, Ship, type LucideIcon } from "lucide-react-native";
import {
  fetchStopArrivals,
  fetchStopDepartures,
  fetchTripDetail,
  searchByMode,
  type StopBoardItem,
  type StopBoardResponse,
  type TripDetailResponse,
} from "@/lib/api/client";
import { useSearchStore, type SelectedStop } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import type { MarkerKind } from "@/lib/surroundings/mockData";
import { registerStopSheetAnimation } from "./stopSheetAnimation";
import { stopToLocation } from "@/lib/surroundings/savedStation";
import { haptic } from "@/lib/haptics";
import { showAlert } from "@/lib/alert";
import type { SearchResult, TravelMode } from "@/types/search";

const SAVED_GOLD = "#FFC107";

/**
 * Slide-Up-Sheet mit Abfahrten/Ankünften zur ausgewählten Haltestelle.
 *
 * Globales Overlay (rendered in app/_layout.tsx) — sitzt damit ÜBER der
 * FloatingTabBar und allen Tab-Pages. Liest den ausgewählten Stop aus dem
 * searchStore (gesetzt vom Marker-Tap im Surroundings-Tab). Schließen via
 * Drag-Down — kein Back-Pfeil, der Hintergrund bleibt sichtbar.
 *
 * Snap-Punkte:
 *   - Mid: ~Mitte des Screens (Standard beim Öffnen)
 *   - Full: gleiche Höhe wie SurroundingsSheet im Full-Snap (oberer Rand
 *     knapp unter dem Top-Inset)
 */

const C = {
  bg: "#1F1F20",
  border: "#2E2E30",
  white: "#FFFFFF",
  g1: "#C4C4C8",
  g2: "#8A8A90",
  g3: "#56565C",
};
const LIME = "#7FEA4D"; // Brand-Grün — gleiches Akzent wie aktive Tabs im SurroundingsSheet
const TRAIN_YELLOW = "#FFD60A";
const TRAIN_YELLOW_BG = "rgba(255,214,10,0.18)";
const BUS_PURPLE = "#9D5FE0";
const BUS_PURPLE_BG = "rgba(157,95,224,0.22)";
const SUBWAY_BLUE_BG = "rgba(31,58,138,0.30)";
const TRAM_DARK_BG = "rgba(255,255,255,0.10)";

const KIND_ICON: Record<MarkerKind, LucideIcon> = {
  train: Train,
  subway: Train,
  bus: Bus,
  tram: TramFront,
  airport: Plane,
  cruise: Ship,
};
const KIND_STYLE: Record<MarkerKind, { fg: string; bg: string; tKey: string }> = {
  train: { fg: TRAIN_YELLOW, bg: TRAIN_YELLOW_BG, tKey: "stop.kind.train" },
  subway: { fg: "#FFFFFF", bg: SUBWAY_BLUE_BG, tKey: "stop.kind.subway" },
  bus: { fg: BUS_PURPLE, bg: BUS_PURPLE_BG, tKey: "stop.kind.bus" },
  tram: { fg: "#FFFFFF", bg: TRAM_DARK_BG, tKey: "stop.kind.tram" },
  airport: { fg: "#7FEA4D", bg: "rgba(127,234,77,0.18)", tKey: "stop.kind.airport" },
  cruise: { fg: "#6B95B5", bg: "rgba(107,149,181,0.20)", tKey: "stop.kind.cruise" },
};

type BoardTab = "departures" | "arrivals";

function formatDistance(m: number | undefined, t: (k: string) => string): string {
  if (m === undefined) return "";
  if (m < 1000) return `${Math.round(m)} ${t("stop.distance.m_away")}`;
  return `${(m / 1000).toFixed(1)} ${t("stop.distance.km_away")}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const ACCENT_DELAY = "#F26565";

/** Product-String → TravelMode.
 *
 *  Reihenfolge & Permissivität: erst die EINDEUTIGEN Mode-Marker (Bus, Coach,
 *  Flight) — wenn die matchen, geht's da hin. Sonst ist alles andere
 *  schienen-/transit-artig → TRAIN. Damit fangen wir auch Profile mit
 *  eigenen Begriffen ab (Rejseplanen: `lokaltog`/`s-tog`/`metro`, PKP:
 *  `kolej`/`pociag`, OEBB: `tram`/`subway`/`suburban`, etc.) ohne jedes
 *  Vokabular einzeln zu pflegen. Ferry/Ship → unsupported (null), bekommt
 *  später ggf. eigene Mode. */
function productToSearchMode(product: string | null): TravelMode | null {
  if (!product) return null;
  const p = product.toLowerCase();
  if (/(bus|coach)/.test(p)) return "BUS";
  if (/(flight|air)/.test(p)) return "FLIGHT";
  if (/(ferry|ship)/.test(p)) return null;
  return "TRAIN";
}

/** Checked ob ein Stop in unserer DE-Coverage liegt (für Booking-Flow). Nur
 *  DE-Stops können sinnvoll durch die DB-Navigator-Suche; alles andere muss
 *  durch den Trip-Detail-Flow (Schedule-Anzeige ohne Booking).
 *
 *  Erkennung gleich wie auf der Server-Seite (`profileForStop`):
 *   - `gtfs:de:` Präfix
 *   - `sta:80xxxxx` UIC-Country 80
 *   - rohe 7-Stellen-ID startend mit 80 */
function isDeStop(code: string): boolean {
  if (/^gtfs:de:/i.test(code)) return true;
  return /^(?:sta:|dbrest:)?80\d{5,7}$/i.test(code);
}

/** Normalisiert eine Linien-Kennung für den Vergleich: „RB 59" und „RB59"
 *  und „rb59" sollen alle matchen. */
function normalizeLine(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Sammelt ALLE möglichen Linien-Identifiers eines Search-Results: die
 *  zusammengefassten Felder (`flightNumber`) UND alle Legs (line + fahrtNr).
 *  Warum alle Legs? Wenn die HAFAS-Routenplanung einen kurzen S-Bahn-Hop
 *  voranstellt um an die richtige Bahnsteig-Ebene zu kommen, ist die vom
 *  User getappte Linie nicht in `legs[0]` sondern erst in `legs[1]`. */
function resultLineCandidates(r: SearchResult): string[] {
  const out: string[] = [];
  if (r.flightNumber) out.push(r.flightNumber);
  if (r.legs) {
    for (const leg of r.legs) {
      if (leg.line) out.push(leg.line);
      if (leg.fahrtNr) out.push(leg.fahrtNr);
    }
  }
  return out;
}

/** Wandelt die Server-Trip-Detail-Antwort in einen SearchResult um, damit
 *  LegTimelineOverlay (das auf `SearchResult.legs` operiert) das direkt
 *  konsumieren kann. Booking-Felder (price, redirectToken, bookingToken,
 *  deepLink) bleiben leer/0 — der Direct-Trip-Flow zeigt eh nur die
 *  Timeline, kein Buchungs-UI. */
function tripDetailToSearchResult(detail: TripDetailResponse): SearchResult {
  return {
    id: detail.id,
    mode: detail.mode,
    provider: "db-vendo",
    origin: detail.origin,
    destination: detail.destination,
    originLabel: detail.originLabel,
    destLabel: detail.destLabel,
    departTime: detail.departTime,
    arriveTime: detail.arriveTime,
    originTz: detail.originTz,
    destinationTz: detail.destinationTz,
    durationMinutes: detail.durationMinutes,
    stops: detail.stops,
    stopLabels: detail.stopLabels,
    legs: detail.legs.map((l) => ({
      origin: l.origin,
      destination: l.destination,
      originLabel: l.originLabel,
      destLabel: l.destLabel,
      originLat: l.originLat,
      originLng: l.originLng,
      destLat: l.destLat,
      destLng: l.destLng,
      departTime: l.departTime,
      arriveTime: l.arriveTime,
      durationMinutes: l.durationMinutes,
      departPlatform: l.departPlatform,
      arrivePlatform: l.arrivePlatform,
      line: l.line,
      product: l.product,
      fahrtNr: l.fahrtNr,
      direction: l.direction,
      stops: l.stops,
      stopovers: l.stopovers,
      tripId: l.tripId,
    })),
    price: 0,
    currency: "EUR",
    redirectToken: "",
    flightNumber: detail.line ?? detail.fahrtNr,
  };
}

/** Findet das Search-Result das am besten zur Departure passt.
 *
 *  Strategie (kombiniert Linie + Zeit, damit weder „ICE 603 18:29 statt 16:29"
 *  durchrutscht noch echte Treffer wegen 1-Minuten-Wackler von HAFAS abgelehnt
 *  werden):
 *    1. Bevorzugt: Linien-Match + Zeit innerhalb 30 Min — selbe Linie, gleiche
 *       Stunde, deckt HAFAS-Time-Wackler ab (Planzeit vs. Real-Zeit, kleine
 *       Drift). 30 Min ist eng genug, dass ein anderer Lauf derselben Linie
 *       (RE 7 alle 2 h) nicht mehr matcht.
 *    2. Fallback: kein Linien-Match, aber Zeit innerhalb 5 Min — z.B. wenn
 *       der Provider die Linie aus irgendeinem Grund anders benennt, die
 *       Abfahrt aber unverkennbar dieselbe ist.
 *  Sonst: undefined → Caller zeigt Alert. */
// Beide Toleranzen STRIKT (3 Min). Wenn HAFAS uns nicht GENAU den Zug zurück-
// gibt den der User getappt hat (innerhalb von 3 Min), lehnen wir ab. Ohne
// das hatten wir den Bug: User tappt RB98 13:28, Booking-Screen zeigt RB98
// 13:32 — verwirrend. Lieber „nicht gefunden" als falsche Zeit anzeigen.
const LINE_MATCH_TIME_TOLERANCE_MS = 3 * 60_000;
const TIME_FALLBACK_TOLERANCE_MS = 3 * 60_000;

function findBestMatch(results: SearchResult[], item: StopBoardItem): SearchResult | undefined {
  if (results.length === 0) return undefined;
  const targetMs = Date.parse(item.plannedTime);
  const itemLine = normalizeLine(item.line);
  let bestWithLine: SearchResult | undefined;
  let bestWithLineDiff = Infinity;
  let bestAny: SearchResult | undefined;
  let bestAnyDiff = Infinity;
  for (const r of results) {
    const diff = Math.abs(Date.parse(r.departTime) - targetMs);
    if (diff < bestAnyDiff) {
      bestAny = r;
      bestAnyDiff = diff;
    }
    if (itemLine) {
      const lineMatch = resultLineCandidates(r).some(
        (cand) => normalizeLine(cand) === itemLine,
      );
      if (lineMatch && diff < bestWithLineDiff) {
        bestWithLine = r;
        bestWithLineDiff = diff;
      }
    }
  }
  if (bestWithLine && bestWithLineDiff <= LINE_MATCH_TIME_TOLERANCE_MS) return bestWithLine;
  if (bestAny && bestAnyDiff <= TIME_FALLBACK_TOLERANCE_MS) return bestAny;
  return undefined;
}

function StopBoardRow({
  item,
  platformPrefix,
  loading,
  onPress,
}: {
  item: StopBoardItem;
  platformPrefix: string;
  loading: boolean;
  onPress: () => void;
}) {
  const delay = item.delayMinutes ?? 0;
  const delayColor = delay > 0 ? ACCENT_DELAY : delay < 0 ? LIME : C.g2;
  // Pressable mit FUNCTION-style (`({pressed}) => [...]`) hat die Box-Styles
  // bei manchen RN-Versionen verschluckt — wir nutzen state-based opacity.
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.row, pressed ? { opacity: 0.7 } : null]}
    >
      <View style={styles.rowTime}>
        <Text style={styles.timeText}>{formatTime(item.plannedTime)}</Text>
        {delay !== 0 && (
          <Text style={[styles.delayText, { color: delayColor }]}>
            {delay > 0 ? `+${delay}` : `${delay}`}
          </Text>
        )}
      </View>
      <View style={styles.rowMain}>
        <View style={styles.lineRow}>
          <Text style={styles.lineText} numberOfLines={1}>
            {item.line}
          </Text>
          {item.platform && (
            <Text style={styles.platformText} numberOfLines={1}>
              {platformPrefix} {item.platform}
            </Text>
          )}
        </View>
        <Text style={styles.directionText} numberOfLines={1}>
          {item.direction || "—"}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator color={C.g1} size="small" style={{ marginLeft: 8 }} />
      ) : null}
    </Pressable>
  );
}

/**
 * Permanent gemounteter Sheet-Container. Anstatt jedes Mal beim Marker-Tap
 * neu zu mounten (was useQuery/useGesture/useSharedValue-Setup verursacht
 * und den Slide-Start verzögert), bleibt der Container immer da — wir
 * animieren nur die translateY. Damit ist der Slide-In instant nach dem Tap.
 *
 * Wenn `selectedStop` null ist, parkt das Sheet off-screen unten.
 * Sobald ein Stop ankommt, animiert es zu snap.mid.
 *
 * `displayStop` hält den letzten gültigen Stop fest — damit beim Schließen
 * der Inhalt während der Slide-Out-Animation noch sichtbar bleibt.
 */
function StopDetailSheetInner() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  const selectedStop = useSearchStore((s) => s.selectedStop);
  const clearSelectedStop = useSearchStore((s) => s.clearSelectedStop);
  const savedStations = useSearchStore((s) => s.savedStations);
  const toggleSavedStation = useSearchStore((s) => s.toggleSavedStation);
  const selectResult = useSearchStore((s) => s.selectResult);
  const setSelectedResultPending = useSearchStore((s) => s.setSelectedResultPending);
  const clearSelectedResult = useSearchStore((s) => s.clearSelectedResult);
  const openDirectTrip = useSearchStore((s) => s.openDirectTrip);

  // Pro-Row-Loading-State für die „Tap auf Departure → Buchung wählen"-Flow.
  // Wir tracken nur EINEN aktiven Search gleichzeitig — Doppel-Taps blockt
  // das `disabled`-Prop in der Row.
  const [loadingDepartureId, setLoadingDepartureId] = useState<string | null>(null);

  // displayStop = der zuletzt sichtbare Stop. Beim Slide-Out hilft das, den
  // Inhalt sichtbar zu halten bis die Animation durch ist.
  const [displayStop, setDisplayStop] = useState<SelectedStop | null>(null);

  // Sobald ein neuer Stop ankommt, übernehmen wir ihn sofort als displayStop.
  // Beim Schließen lassen wir displayStop noch ~Animation-Dauer stehen.
  useEffect(() => {
    if (selectedStop) setDisplayStop(selectedStop);
  }, [selectedStop]);

  // Beim Open: stop = selectedStop (sofort sichtbar, ohne useEffect-Lag).
  // Beim Close: selectedStop wird null, aber displayStop hält den letzten
  // Inhalt für die Slide-Out-Animation → Sheet wirkt nicht „leer" beim Zumachen.
  const stop = selectedStop ?? displayStop;
  const kinds: MarkerKind[] =
    stop?.kinds && stop.kinds.length > 0 ? (stop.kinds as MarkerKind[]) : ["bus"];
  const [activeKind, setActiveKind] = useState<MarkerKind>(kinds[0] ?? "bus");
  const [tab, setTab] = useState<BoardTab>("departures");

  // bodyReady: erst NACH der Slide-In-Animation auf true → vermeidet visuelles
  // Ruckeln wenn die Departures-Liste mitten in der Slide-Animation reinpoppt.
  // Header (Name + Distanz) bleibt immer sichtbar, weil dort kein Layout-Shift
  // passieren kann.
  const [bodyReady, setBodyReady] = useState(false);

  useEffect(() => {
    if (selectedStop) {
      const ks =
        selectedStop.kinds && selectedStop.kinds.length > 0
          ? (selectedStop.kinds as MarkerKind[])
          : (["bus"] as MarkerKind[]);
      setActiveKind(ks[0]);
      setTab("departures");
    }
  }, [selectedStop?.code]);

  // Tap auf einen Departure-Eintrag → DetailsOverlay slidet SOFORT von rechts
  // rein mit einem Stub-Result (Origin/Destination/Zeit/Linie aus dem Departure).
  // Im Hintergrund läuft die echte Search-API — sobald die Antwort da ist,
  // ersetzen wir das Stub-Result mit dem Match. Während der Wait-Zeit zeigt
  // DetailsOverlay Skeleton-Cards in der Provider-Sektion (siehe
  // `selectedResultPending`-Flag im Store).
  const onSelectDeparture = (item: StopBoardItem) => {
    if (!stop) return;
    const mode = productToSearchMode(item.product);
    if (!mode) return; // Ferry o.ä. → keine Ticket-Suche verfügbar
    const directionText = item.direction?.trim();
    if (!directionText) return;
    haptic("button");

    // BUS-Mode: kein Booking-DetailsOverlay sondern direkt LegTimeline. Wir
    // brauchen weder Journey-Suche noch Provider-Matching — die `tripId` aus
    // dem StopBoard reicht um via `/api/trips/:id/detail` alle Stops + Zeiten
    // zu holen. Ein einzelner billiger HAFAS-Call statt eines vollen
    // /journeys-Search. Für ÖPNV-Buslinien (wo wir eh keine Preise haben) ist
    // das Booking-UI nicht hilfreich, der User sieht nur die Stops.
    // Trip-Detail-Flow für ALLES außer DE-Zügen:
    //   - BUS (egal welches Land): Stadtbusse sind nirgends online buchbar
    //   - Nicht-DE Train: unser Booking-Provider (dbVendo) kennt nur DE, eine
    //     Booking-Suche würde fehlschlagen — also lieber direkt Trip-Detail
    //     mit dem richtigen HAFAS-Profil (oebb/pkp/cfl/rejseplanen)
    // Nur DE-Zug bleibt im klassischen Booking-Flow weil's da den DB-Navigator-
    // Deeplink gibt.
    const useDirectTripFlow = mode === "BUS" || !isDeStop(stop.code);
    if (useDirectTripFlow) {
      // hafasId aus der Board-Antwort: damit der Server den Trip auf den
      // User-Halt slicen kann (volle Linie A→Z vs. User steigt erst in der
      // Mitte ein → wir wollen User-Halt → Endstation anzeigen).
      const fromStopId = data?.stop.hafasId ?? undefined;
      // stopCode mitschicken — daraus leitet der Server das HAFAS-Profile ab
      // (DE → dbrest, AT/PL/LU/DK → in-process hafas-client). Ohne den würde
      // ein österreichischer Trip durch das DB-Profile geleitet und 404 liefern.
      setLoadingDepartureId(item.id);
      void (async () => {
        try {
          const detail = await fetchTripDetail(item.id, { fromStopId, stopCode: stop.code });
          const result = tripDetailToSearchResult(detail);
          openDirectTrip(result);
        } catch {
          showAlert(
            t("stop.departure.notfound.title"),
            t("stop.departure.notfound.body"),
          );
        } finally {
          setLoadingDepartureId(null);
        }
      })();
      return;
    }

    // Origin-Code: für Flight = IATA aus `airport:IATA`, sonst Stop-Code as is.
    const originMatch = stop.code.match(/^airport:([A-Z0-9]{3,4})$/i);
    const origin = originMatch ? originMatch[1]!.toUpperCase() : stop.code;
    const departDate = item.plannedTime.slice(0, 10);

    // Stub-Result aus den vorhandenen Departure-Daten — reicht für die obere
    // Hälfte des DetailsOverlay (City-Names, Datum, Abfahrtszeit, Line).
    // arriveTime + price + bookingToken fehlen → Provider-Sektion bleibt
    // Skeleton bis das echte Result da ist.
    const stub: SearchResult = {
      id: `pending:${item.id}`,
      mode,
      provider: mode === "FLIGHT" ? "google-flights" : "db-vendo",
      origin,
      destination: directionText,
      originLabel: stop.label ?? origin,
      destLabel: directionText,
      departTime: item.plannedTime,
      arriveTime: item.plannedTime, // unbekannt — Provider füllt
      durationMinutes: 0,
      stops: 0,
      stopLabels: [],
      price: 0,
      currency: "EUR",
      redirectToken: "",
      flightNumber: item.line ?? undefined,
    };

    // Instant: DetailsOverlay slidet rein, Pending=true. Stop-Sheet bleibt
    // OFFEN dahinter — damit der User beim Schließen des Overlays direkt
    // wieder in der Departures-Liste landet.
    selectResult(stub, 1);
    setSelectedResultPending(true);
    setLoadingDepartureId(item.id);

    // Background-Search — fire-and-forget, kein await blockiert den Slide.
    void (async () => {
      let match: SearchResult | undefined;
      let failed = false;
      try {
        const res = await searchByMode(
          {
            mode,
            origin,
            destination: directionText,
            originLabel: stop.label,
            destLabel: directionText,
            departDate,
            // Ziel-Zeit als Hint für den Server: zentriere das Suchfenster auf
            // genau diesen Zug. Ohne das landet ein Zug 4h in der Zukunft evtl.
            // außerhalb der HAFAS-10er-Result-Page und wir finden ihn nie.
            departTime: item.plannedTime,
            passengers: 1,
            currency: "EUR",
          },
          // Cache umgehen — der Server-Cache-Key enthält departTime nicht,
          // sonst würde eine frühere Allgemein-Suche (z.B. um 14:00 mit
          // Ergebnissen ab 14:00) den 16:29-Tap fälschlich bedienen.
          { nocache: true },
        );
        match = findBestMatch(res.results, item);
      } catch {
        failed = true;
      }
      setLoadingDepartureId(null);
      if (match) {
        // Stub durch echtes Result ersetzen — DetailsOverlay re-rendert mit
        // den korrekten Daten + dem bookingToken (für Multi-Provider-Liste).
        selectResult(match, 1);
        setSelectedResultPending(false);
        return;
      }
      // Kein verlässlicher Treffer (Linie+Zeit) gefunden ODER Search-Error.
      // WICHTIG: nicht das Stub-Result stehen lassen — das zeigt "16:15→16:15"
      // mit duplizierter Abfahrts-/Ankunftszeit, was den User verwirrt. Lieber
      // den Overlay zumachen und sagen was los ist; der StopDetailSheet
      // bleibt dahinter offen, der User landet zurück auf der Departures-
      // Liste und kann's nochmal versuchen oder normal suchen.
      clearSelectedResult();
      if (!failed) {
        // BUS-Mode kommt hier nicht an (wird oben kurzgeschlossen), also nur
        // der generische „nicht gefunden"-Text — TRAIN/FLIGHT-Fehlschlag heißt
        // meist „Suche hat zu wenig Treffer geliefert".
        showAlert(t("stop.departure.notfound.title"), t("stop.departure.notfound.body"));
      }
    })();
  };

  const queryFn = tab === "departures" ? fetchStopDepartures : fetchStopArrivals;
  const { data, isLoading, isError } = useQuery<StopBoardResponse>({
    queryKey: ["stopBoard", stop?.code ?? "_none_", tab],
    queryFn: () => queryFn(stop!.code),
    // Fetch erst sobald die Slide-Animation durch ist UND ein Stop aktiv ist.
    // Vorher würde das Result die Layout-Shift mitten in der Animation
    // verursachen.
    enabled: !!selectedStop && !!stop && bodyReady,
    staleTime: 45 * 1000,
    refetchOnMount: "always",
    retry: 1,
  });

  const items: StopBoardItem[] = useMemo(() => {
    const all = data?.results ?? [];
    if (kinds.length < 2) return all;
    return all.filter((it) => productMatchesKind(it.product, activeKind));
  }, [data, kinds.length, activeKind]);

  // Snap-Punkte (gleich wie SurroundingsSheet): full (oben), mid (halb),
  // sheetHeight = komplett off-screen unten.
  const snap = useMemo(() => {
    const fullTop = Math.max(60, insets.top + 12);
    const sheetHeight = screenHeight - fullTop;
    const midVisible = Math.min(sheetHeight - 80, Math.max(420, screenHeight * 0.5));
    return {
      sheetHeight,
      full: 0,
      mid: Math.max(0, sheetHeight - midVisible),
    };
  }, [screenHeight, insets.top]);

  // Start: off-screen unten. Beim Selectstop animieren wir zu mid.
  const translateY = useSharedValue(snap.sheetHeight);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  // Open/close animation getrieben durch selectedStop. 350ms matched die
  // Slide-Dauer der anderen Overlays in der App.
  //
  // useLayoutEffect statt useEffect: läuft synchron VOR dem Paint, sodass
  // das withTiming sofort nach dem Render-Commit auf der UI-Thread startet —
  // kein „React-commit → useEffect → bridge"-Frame-Lag mehr. Damit fühlt sich
  // der Slide-Trigger genauso instant an wie bei den Layout-Animation-Overlays
  // (SlideInDown, Landing-„Alle anzeigen").
  // Animations-Controller registrieren — der Marker-Tap-Handler triggert
  // die Slide-In dann DIREKT auf der UI-Thread (siehe stopSheetAnimation.ts),
  // ohne auf den React-Render-Zyklus zu warten.
  useEffect(() => {
    return registerStopSheetAnimation({
      translateY,
      getMid: () => snap.mid,
      getSheetHeight: () => snap.sheetHeight,
    });
  }, [snap.mid, snap.sheetHeight]);

  // bodyReady-Gate + close-Animation. Beim Öffnen läuft die translateY-
  // Animation schon (vom Tap-Handler getriggert), wir setzen hier nur den
  // bodyReady-Timer. Beim Schließen müssen wir die Animation selbst feuern.
  useLayoutEffect(() => {
    if (selectedStop) {
      setBodyReady(false);
      translateY.value = withTiming(snap.mid, { duration: 350 }, (finished) => {
        if (finished) runOnJS(setBodyReady)(true);
      });
    } else {
      setBodyReady(false);
      translateY.value = withTiming(
        snap.sheetHeight,
        { duration: 350 },
        (finished) => {
          if (finished) runOnJS(setDisplayStop)(null);
        },
      );
    }
  }, [selectedStop, snap.mid, snap.sheetHeight]);

  const startY = useSharedValue(0);
  const pan = Gesture.Pan()
    .onStart(() => {
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      const next = startY.value + e.translationY;
      translateY.value = Math.max(snap.full, next);
    })
    .onEnd((e) => {
      const final = startY.value + e.translationY;
      const closeThreshold = snap.mid + (snap.sheetHeight - snap.mid) * 0.35;
      if (final > closeThreshold || e.velocityY > 800) {
        // Schließen → Store leeren, useEffect oben kümmert sich um Animation.
        runOnJS(clearSelectedStop)();
        return;
      }
      const points = [snap.full, snap.mid];
      let closest = points[0];
      let bestDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p - final);
        if (d < bestDist) {
          bestDist = d;
          closest = p;
        }
      }
      if (e.velocityY < -800) closest = snap.full;
      else if (e.velocityY > 200 && final > snap.mid * 0.6) closest = snap.mid;
      translateY.value = withTiming(closest, { duration: 180, easing: Easing.out(Easing.quad) });
    });

  // Sheet bleibt PERMANENT gemountet — auch wenn nichts ausgewählt ist
  // (translateY = sheetHeight = off-screen). Dadurch entfällt der React-
  // Mount-Cost beim ersten Marker-Tap; nur die translateY-Animation läuft.
  // Inhalt nur rendern wenn stop existiert (spart Re-Renders der Liste etc.).
  return (
    <>
      {/* Backdrop — fängt Taps außerhalb des Sheets. Reicht NUR bis kurz
          über die FloatingTabBar, damit der User dort weiter tappen kann
          ohne erst das Sheet schließen zu müssen. */}
      {selectedStop && (
        <Pressable
          style={[
            StyleSheet.absoluteFill,
            { bottom: 96 + insets.bottom },
          ]}
          onPress={clearSelectedStop}
          accessibilityLabel="Close stop details"
        />
      )}
      <Animated.View
        pointerEvents={selectedStop ? "auto" : "none"}
        style={[
          styles.sheet,
          {
            top: Math.max(60, insets.top + 12),
            height: snap.sheetHeight,
            paddingBottom: insets.bottom + 12,
          },
          sheetAnim,
        ]}
      >
        {stop && (
          <>
            <GestureDetector gesture={pan}>
              <View style={styles.handleZone}>
                <View style={styles.handle} />
              </View>
            </GestureDetector>

            {/* Header: Name, Distanz, Favoriten-Stern. Schließen per Drag-Down
                oder Tap auf den Backdrop. */}
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {stop.label}
                </Text>
                {stop.distanceMeters !== undefined && (
                  <Text style={styles.headerSubtitle}>
                    {formatDistance(stop.distanceMeters, t)}
                  </Text>
                )}
              </View>
              {(() => {
                // Hier brauchen wir die normalisierte Code-Form (siehe
                // stopToLocation), damit „save in Surroundings" und „save in
                // Search-Picker" auf demselben Eintrag landen — sonst hätte
                // der User zwei verschiedene Saved-States für dieselbe Station.
                const asLocation = stop ? stopToLocation(stop) : null;
                const saved = asLocation
                  ? savedStations.some((s) => s.code === asLocation.code)
                  : false;
                return (
                  <Pressable
                    hitSlop={12}
                    style={styles.headerFav}
                    onPress={() => {
                      if (!asLocation) return;
                      haptic("button");
                      toggleSavedStation(asLocation);
                    }}
                    accessibilityLabel={saved ? "Unsave station" : "Save station"}
                  >
                    <Star
                      size={22}
                      color={saved ? SAVED_GOLD : C.white}
                      fill={saved ? SAVED_GOLD : "transparent"}
                    />
                  </Pressable>
                );
              })()}
            </View>

            {/* Mode-Pillen (nur bei multi-modalen Stops sichtbar). */}
            {bodyReady && kinds.length >= 2 && (
              <View style={styles.pillsRow}>
                {kinds.map((k) => {
                  const style = KIND_STYLE[k];
                  const Icon = KIND_ICON[k];
                  const active = activeKind === k;
                  return (
                    <Pressable
                      key={k}
                      onPress={() => setActiveKind(k)}
                      style={[
                        styles.pill,
                        {
                          backgroundColor: active ? style.bg : "transparent",
                          borderColor: style.bg,
                        },
                      ]}
                    >
                      <Icon size={14} color={active ? style.fg : C.g1} strokeWidth={2.2} />
                      <Text style={[styles.pillText, { color: active ? style.fg : C.g1 }]}>
                        {t(style.tKey)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            )}

            {/* Tabs Departures/Arrivals — aktiver Tab kriegt grünen Underline.
                Auch hinter `bodyReady` gegated weil bei Single-Mode-Stops die
                Pillen fehlen und sonst die Tabs alleine während der Slide-In
                rein-poppen. */}
            {bodyReady && (
              <View style={styles.tabsRow}>
                {(["departures", "arrivals"] as const).map((b) => {
                  const active = tab === b;
                  return (
                    <Pressable key={b} onPress={() => setTab(b)} style={styles.tab}>
                      <Text style={[styles.tabText, active ? styles.tabActive : styles.tabInactive]}>
                        {t(b === "departures" ? "stop.tab.departures" : "stop.tab.arrivals")}
                      </Text>
                      {active && <View style={styles.tabUnderline} />}
                    </Pressable>
                  );
                })}
              </View>
            )}

            <View style={styles.body}>
              {!bodyReady ? null : isLoading ? (
                <ActivityIndicator color={C.g1} style={{ marginTop: 24 }} />
              ) : isError || items.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>
                    {t(
                      tab === "departures"
                        ? "stop.empty.departures.title"
                        : "stop.empty.arrivals.title",
                    )}
                  </Text>
                  <Text style={styles.emptyBody}>
                    {t(
                      tab === "departures"
                        ? "stop.empty.departures.body"
                        : "stop.empty.arrivals.body",
                    )}
                  </Text>
                </View>
              ) : (
                <ScrollView
                  contentContainerStyle={styles.list}
                  showsVerticalScrollIndicator
                >
                  {items.slice(0, 6).map((it, i) => (
                    <StopBoardRow
                      key={`${it.id}-${i}`}
                      item={it}
                      platformPrefix={t("stop.platform.prefix")}
                      loading={loadingDepartureId === it.id}
                      onPress={() => onSelectDeparture(it)}
                    />
                  ))}
                </ScrollView>
              )}
            </View>
          </>
        )}
      </Animated.View>
    </>
  );
}

function productMatchesKind(product: string | null, kind: MarkerKind): boolean {
  if (!product) return true;
  const p = product.toLowerCase();
  switch (kind) {
    case "train":
      return /national|regional|suburban|express|rail/.test(p);
    case "subway":
      return /subway|metro|u-bahn|ubahn/.test(p);
    case "tram":
      return /tram|stadtbahn/.test(p);
    case "bus":
      return /bus|coach/.test(p);
    case "airport":
      return /flight|air/.test(p);
    case "cruise":
      return /ferry|ship/.test(p);
    default:
      return true;
  }
}

/** Globales Overlay — wird in app/_layout.tsx einmal gerendert (damit's ÜBER
 *  FloatingTabBar liegt). Inner-Component bleibt permanent gemountet sobald
 *  einmal ein Stop angetappt wurde, damit der nächste Slide-In keine
 *  React-Mount-Latenz hat. */
export const StopDetailSheet = memo(function StopDetailSheet() {
  return <StopDetailSheetInner />;
});

const styles = StyleSheet.create({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: C.bg,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: C.border,
    overflow: "hidden",
    // hoch genug, dass das Sheet über FloatingTabBar + andere Overlays sitzt.
    zIndex: 100,
    elevation: 16,
  },
  handleZone: { paddingTop: 10, paddingBottom: 8, alignItems: "center" },
  // Weißer Handle wie in den anderen Slides (vorher grau).
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: C.white, opacity: 0.9 },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 12,
    gap: 12,
  },
  headerText: { flex: 1 },
  headerTitle: { color: C.white, fontSize: 20, fontWeight: "700" },
  headerSubtitle: { color: C.g1, fontSize: 14, marginTop: 4 },
  headerFav: { paddingTop: 4 },

  pillsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  pill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 7,
    borderRadius: 9999,
    borderWidth: 1,
  },
  pillText: { fontSize: 13, fontWeight: "600" },

  tabsRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 24,
  },
  tab: { paddingVertical: 8, position: "relative" },
  tabText: { fontSize: 17, fontWeight: "700" },
  tabActive: { color: C.white },
  tabInactive: { color: C.g3 },
  // Active-Tab-Underline: Brand-Grün (vorher rot).
  tabUnderline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: LIME,
    borderRadius: 2,
  },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  empty: { alignItems: "center", paddingTop: 32, paddingHorizontal: 24 },
  emptyTitle: { color: C.white, fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: C.g1, fontSize: 15, marginTop: 6, textAlign: "center", lineHeight: 22 },

  list: { gap: 12, paddingBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
  },
  rowTime: { width: 64 },
  timeText: { color: C.white, fontSize: 16, fontWeight: "700" },
  delayText: { fontSize: 13, fontWeight: "600", marginTop: 2 },
  rowMain: { flex: 1, gap: 2 },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  lineText: { color: C.white, fontSize: 15, fontWeight: "600" },
  platformText: { color: C.g2, fontSize: 12, fontWeight: "500" },
  directionText: { color: C.g1, fontSize: 14 },
});
