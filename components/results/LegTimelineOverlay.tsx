import { memo, useCallback, useEffect, useRef, useState } from "react";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  BackHandler,
  Platform,
  useWindowDimensions,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { de, enGB, es, fr } from "date-fns/locale";
import { ChevronDown, Footprints, Clock, CircleDot, Info, Map as MapIcon } from "lucide-react-native";
import { useRouter, usePathname } from "expo-router";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { formatLocalizedDateInZone, formatTimeInZone, localTimeHint, shiftIsoByMinutes } from "@/lib/time-format";
import { changesCaption, changesText } from "@/lib/format/routeMeta";
import { LegInfo, SearchResult } from "@/types/search";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import { dragHealOffset, snapToPixel, useSheetScrollGate, useSheetSwipe } from "@/lib/ui/sheetSwipe";
import { fetchTripPolylines } from "@/lib/api/client";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import {
  JOURNEY_WARNING_COLORS,
  JourneyWarningBadge,
  JourneyWarningIcon,
} from "@/components/results/JourneyWarningBadge";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";
import { LinePill, productLabel } from "@/components/results/LinePill";

// Farbpalette aus dem App-Theme — die hellere Lime aus dem Mockup ist bewusst
// auf unsere Brand-Lime gedimmt (#7FEA4D), Card/Surface-Stufen matchen
// DetailsOverlay damit die beiden Slides visuell zusammen wirken.
const C = {
  bg: "#0D0D0D",
  sheet: "#171719",
  card: "#171719",
  cardSoft: "#212123",
  border: "#212123",
  text: "#F4F4F5",
  sub: "#8E8E93",
  subDim: "#56565C",
  lime: "#7FEA4D",
  limeSoft: "rgba(127,234,77,0.14)",
  amber: "#FFB266",
  black: "#000000",
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

// Timeline-Geometrie — alle Werte müssen synchron zueinander stimmen damit
// die Rail-Linie exakt unter den Dot-Mitten liegt.
const TIME_COL_W = 56;
const DOT = 14;
const GAP = 14;
const SIDE_PAD = 20;

function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

// TZ-bewusst (siehe DetailsOverlay): Flüge speichern "floating local time" mit
// Zone "UTC" → verbatim. Mit echter IANA-Zone (Züge) korrekt konvertiert; ohne
// Zone Fallback auf Geräte-Lokalzeit.
function timeOf(iso: string, tz?: string): string {
  try {
    return formatTimeInZone(iso, tz);
  } catch {
    return "";
  }
}

// productLabel/productColor und die Plakette stehen in `LinePill.tsx` — das
// Stadt-Blatt zeigt dieselben Linien in denselben Farben.

interface SyntheticLeg extends LegInfo {}

function buildFallbackLegs(result: SearchResult): SyntheticLeg[] {
  return [
    {
      origin: result.origin,
      destination: result.destination,
      // Ganzer Name — „Enschede, Lindestraat" ist der Halt, nicht „Enschede".
      originLabel: result.originLabel?.trim(),
      destLabel: result.destLabel?.trim(),
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
  const selectedResult = useSearchStore((s) => s.selectedResult);
  const directTripResult = useSearchStore((s) => s.directTripResult);
  const context = useSearchStore((s) => s.selectedResultContext);
  const pathname = usePathname();
  // Direct-Trip-Flow (Bus-Tap aus dem Stop-Sheet) hat Vorrang vor
  // selectedResult — sonst würde der vorher gewählte Trip aus der Such-
  // Liste die Timeline füllen statt der gerade getappten Bus-Abfahrt.
  const result = directTripResult ?? selectedResult;

  // DAUERHAFT GEMOUNTET — dasselbe Muster wie beim Detail-Overlay, und aus
  // demselben gemessenen Grund: react-native-svg gibt seine Views auf Fabric
  // beim Abbauen nicht frei. Dieser Baum trägt mehrere Symbole und baute sich
  // bei JEDEM Schließen ab, ließ also bei jedem Öffnen/Schließen Views zurück.
  // Das ist einer der Wege, auf denen die App über eine Sitzung langsamer wird.
  //
  // Statt Ein- und Ausbauen fährt das Blatt jetzt über einen eigenen Wert rein
  // und raus (siehe `open` unten) — sichtbar identisch, nur ohne Abbau.
  /**
   * Der Inhalt wird nur nachgezogen, wenn das Blatt WIRKLICH offen ist.
   *
   * Hier stand `if (result)` — ohne Bezug darauf, ob die Zeitleiste überhaupt
   * jemand sehen will. Damit hing dieser ganze Baum am Auswählen einer
   * Ticket-Karte: Jeder Druck auf „Auswählen" setzte ein anderes `selectedResult`,
   * die Kennung änderte sich, `memo` griff nicht mehr — und der komplette,
   * niemals sichtbare Zeitleisten-Baum wurde im Berührungs-Frame neu aufgebaut.
   * Das sind je nach Verbindung 45 Ansichten (Direktflug) bis über 100 (drei
   * Etappen mit Umstiegen; allein die gepunktete Linie sind acht eigene
   * Ansichten pro Umstieg). Auf Fabric läuft das Einhängen auf dem UI-Strang —
   * also genau gegen die Bewegung, die im selben Moment anläuft.
   *
   * Sichtbar war davon nichts, und genau deshalb ist es so lange
   * durchgerutscht.
   *
   * Beide Eigenschaften, für die dieser Baum gebaut ist, bleiben erhalten:
   * Einmal aufgebaut wird er nie wieder abgebaut (das SVG-Leck darunter), und
   * beim Öffnen steht der richtige Inhalt da — `selectedResult` ist dann längst
   * gesetzt, die Zeile hier holt ihn im selben Render nach. Solange zu ist,
   * behält er den letzten Inhalt, und `memo` blockt jeden weiteren Durchlauf,
   * weil die Kennung sich nicht mehr ändert.
   */
  const lastResultRef = useRef(result);
  if (result && open) lastResultRef.current = result;
  const displayResult = lastResultRef.current;
  // Wenn der Sheet aus dem Search-Flow geöffnet wurde (selectedResultContext
  // gesetzt) und wir gerade auf einer anderen Route sind (z.B. Map-Push),
  // verstecken wir den Sheet VISUELL (display:none), aber UNMOUNTEN ihn
  // NICHT. Sonst würde beim Zurückkommen die Slide-In-Animation neu
  // abspielen → laggt sichtbar während des Pop-Übergangs.
  const hiddenForOtherRoute =
    !directTripResult && context != null && pathname !== context.pathname;

  // Vor dem allerersten Öffnen: nichts rendern (kein Aufwand).
  if (!displayResult) return null;
  return (
    <LegTimelineSheet
      result={displayResult}
      open={open && result != null}
      hidden={hiddenForOtherRoute}
    />
  );
}

/**
 * memo ist hier PFLICHT, nicht Kür — dieselbe Begründung wie beim Detail-Overlay.
 *
 * Seit dieser Baum dauerhaft gemountet bleibt (gegen das SVG-Leck), hängt er an
 * einer äußeren Komponente, die `usePathname()` liest und damit bei JEDEM
 * Routen- und Tab-Wechsel neu rendert. Ohne memo würde der komplette geparkte
 * Baum bei jedem Wechsel mit durchgerendert — das Leck wäre gestopft und dafür
 * ein neuer, dauernder Kostenpunkt entstanden. Alle Props sind primitiv oder
 * stabile Referenzen, memo greift also zuverlässig.
 */
const LegTimelineSheet = memo(function LegTimelineSheet({
  result,
  open,
  hidden,
}: {
  result: SearchResult;
  open: boolean;
  hidden?: boolean;
}) {
  const palette = usePalette();
  const accent = useAccent();
  const close = useSearchStore((s) => s.closeLegTimelineOverlay);
  const setRoute = useSearchStore((s) => s.setRoute);
  const setRoutePolylines = useSearchStore((s) => s.setRoutePolylines);
  const selectedResultContext = useSearchStore((s) => s.selectedResultContext);
  const stashSurroundingsForRoute = useSearchStore((s) => s.stashSurroundingsForRoute);
  const locale = useSearchStore((s) => s.locale);
  const t = useT();
  const router = useRouter();
  const { height } = useWindowDimensions();
  const sheetHeight = height * 0.88;
  const sheetTop = height - sheetHeight;

  function onShowMap() {
    haptic("button");
    const plan = buildRoutePlan(result);
    if (!plan) return;

    if (selectedResultContext) {
      // Search-Results-Flow (User kam aus /search/results → Card → Details
      // → LegTimeline). Wir pushen eine eigene Route /search/route-map IM
      // selben Tab-Stack auf — KEIN Tab-Wechsel mehr, KEIN router.replace
      // der den Results-Screen frisch mountet (was beim Back-Navigieren
      // den ganzen Loader + Fade-In neu spielte → gefühlter Lag).
      // Results bleibt drunter gemountet, Back-Button im route-map ruft
      // router.back() → pop, fertig.
      setRoute({
        ...plan,
        previousHref: selectedResultContext,
      });
      router.push("/search/route-map");
    } else {
      // Surroundings-Flow — egal ob direct-trip (Tram/Bus-Departure) oder
      // Booking (ICE/IC vom Stop-Tap). Wir sind schon im Surroundings-Tab.
      // Stash den kompletten UI-Zustand (Slide + DetailsOverlay +
      // LegTimelineOverlay) → alles slidet/verschwindet → User sieht die
      // Route sauber auf der Karte. Back-Button (RouteBanner) restored
      // alles wieder.
      setRoute(plan);
      stashSurroundingsForRoute();
    }

    const tripIds = plan.legs.map((l) => l.tripId).filter((id): id is string => Boolean(id));
    if (tripIds.length > 0) {
      fetchTripPolylines(tripIds)
        .then((r) => setRoutePolylines(r.polylines))
        .catch(() => {});
    }
  }

  // Zurück NUR abfangen, solange das Blatt wirklich offen ist.
  //
  // Vorher hing dieser Effekt an der Existenz der Komponente — was in Ordnung
  // war, solange sie beim Schließen abgebaut wurde. Seit sie dauerhaft steht
  // (gegen das SVG-Leck), blieb die Anmeldung für immer aktiv und gab bei JEDEM
  // Zurück `true` zurück. Damit war die Zurück-Geste auf ALLEN Bildschirmen
  // geschluckt, sobald man die Zeitleiste einmal geöffnet hatte.
  useEffect(() => {
    // `hidden` MIT prüfen — beim Sprung auf die Karte bleibt dieses Blatt
    // absichtlich offen, nur unsichtbar. Ohne die Prüfung schluckte es dort den
    // Zurück-Druck.
    if (Platform.OS !== "android" || !open || hidden) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close, open, hidden]);

  // Startet unten außerhalb des Bildes — der Baum steht ab jetzt dauerhaft,
  // sichtbar wird er erst durch `open`.
  const translateY = useSharedValue(sheetHeight);
  /**
   * Ganze Gerätepixel + Selbstkorrektur beim Ziehen — beides erklärt in
   * lib/ui/sheetSwipe.ts (`snapToPixel`, `startDragHeal`).
   */
  const heal = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(translateY.value) + dragHealOffset(heal) }],
  }));
  /**
   * Die Verdunkelung hängt an der LAGE des Blattes, nicht an einem zweiten Wert.
   *
   * Sie tat rechnerisch immer schon dasselbe — dieselbe Dauer, dieselbe Kurve,
   * dieselbe Richtung —, war aber eine eigene Kurve. Beim Ziehen mit dem Finger
   * fiel das auf: Das Blatt wanderte, die Verdunkelung blieb stehen, weil sie
   * nur von den beiden Fahrten geschrieben wurde. Als Anteil der Strecke geht
   * sie nun immer mit, ohne dass jemand daran denken muss.
   */
  const backdropAnim = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, Math.max(0, translateY.value / sheetHeight)),
  }));
  // Ganz unten angekommen ⇔ unsichtbar und nicht anfassbar.
  const rootAnim = useAnimatedStyle(() => ({
    opacity: hidden || translateY.value >= sheetHeight - 1 ? 0 : 1,
  }));

  /**
   * Die Streckenliste erst NACH der Fahrt aufbauen.
   *
   * Sie ist der schwerste Teil dieses Blattes — pro Abschnitt zwei
   * Stationszeilen, ein Transportstreifen, dazu bei einer Direktfahrt die
   * ganzen Zwischenhalte, alles ohne Virtualisierung. Gebaut wird sie in genau
   * dem Commit, der die Bewegung auslöst; das eine Bild Vorlauf darunter
   * reicht dafür nicht, wenn die Fahrt viele Halte hat. Genau dann ruckelt das
   * Hereinfahren — und wer aus der Live-Tafel kommt, hat fast immer viele.
   *
   * Kopf und Zusammenfassung stehen sofort, nur die Liste kommt am Ende der
   * Bewegung dazu. Dasselbe Muster nutzt das Detail-Blatt seit Längerem und
   * begründet es dort ausführlich.
   */
  const [atRest, setAtRest] = useState(false);
  useEffect(() => {
    if (!open) {
      setAtRest(false);
      return;
    }
    const id = setTimeout(() => setAtRest(true), SHEET_IN.duration + 20);
    return () => clearTimeout(id);
  }, [open]);

  useEffect(() => {
    if (open) {
      // Sicherung: Der Merker gehört zu GENAU einer Ausfahrt. Bliebe er aus
      // irgendeinem Grund stehen, übersprünge die nächste Ausfahrt ihre
      // Bewegung — das Blatt bliebe sichtbar stehen. Beim Öffnen ist er in
      // jedem Fall gegenstandslos.
      settlingRef.current = false;
      // Wie bei den anderen Push-Übergängen erst starten, wenn der JS-Thread
      // frei ist — sonst läuft die Bewegung gegen den Commit an, der den Inhalt
      // aufbaut (gemessen: das schlechteste Bild fiel dadurch von 25ms auf 8ms).
      // Siehe DetailsOverlay: dauerhaft gemountet, also kein Aufbau-Commit, auf
      // den zu warten wäre. Ein Bild Vorlauf statt einer Warteschleife.
      const id = requestAnimationFrame(() => {
        // KRITISCH GEDÄMPFT (dampingRatio 1) — kein Überschwingen.
        //
        // Hier stand zuerst die Feder des Wisch-Abbruchs (damping 22,
        // stiffness 220). Deren Dämpfungsgrad liegt bei rund 0,74, sie schwingt
        // also über — beim Zurückschnappen nach einem Wisch ist das gewollt,
        // beim Reinkommen federte das Blatt dadurch sichtbar nach. Vorher lag
        // hier eine Zeitkurve über 350ms, die das nicht tat.
        // Zeitkurve statt Feder: Eine kritisch gedämpfte Feder derselben Dauer
        // sieht ähnlich aus, ist es aber nicht — sie nähert sich dem Ziel
        // asymptotisch, während die Kurve des Such-Blattes exakt endet. Neben
        // einem anderen Blatt fällt genau dieser Auslauf auf.
        markSheetMoving();
        translateY.value = withTiming(0, SHEET_IN);
      });
      return () => cancelAnimationFrame(id);
    }
    /**
     * Auch die AUSFAHRT anmelden.
     *
     * Sie tat es nicht — angemeldet war nur der Hinweg. Damit galt der
     * Bildschirm während der ganzen Rückfahrt als „ruhig", und alles, was auf
     * diese Meldung wartet, um NICHT in eine laufende Bewegung zu fallen (etwa
     * das Zurücksetzen des Datumswählers), lief genau dort hinein. Dieselbe
     * Asymmetrie ist in `overlayCover` für die Push-Wege schon einmal
     * ausformuliert worden: „Angemeldet wurden anfangs nur die vier HINwege."
     */
    /**
     * Fährt die Wisch-Geste schon, wird hier NICHT noch einmal angesetzt.
     *
     * Sie stößt ihre Ausfahrt im Bild des Loslassens an, auf dem UI-Strang —
     * anders bliebe das Blatt genau dann stehen, wenn der Finger das Glas
     * verlässt (Sprung auf den JS-Strang plus ein React-Durchgang). Eine zweite
     * Kurve von hier aus liefe gegen sie an: Sie setzte von der inzwischen
     * erreichten Stelle mit voller Dauer neu an, sichtbar als Tempo-Wechsel.
     */
    if (settlingRef.current) {
      settlingRef.current = false;
      return undefined;
    }
    markSheetMoving(SHEET_OUT.duration);
    translateY.value = withTiming(sheetHeight, SHEET_OUT);
    return undefined;
  }, [open, sheetHeight, translateY]);

  /**
   * Gezogen wird am ganzen Blatt, und die Streckenliste behält ihr Scrollen.
   *
   * Zwei Eigenheiten bleiben, wie sie waren:
   *
   *  - `enabled(open)`: Das Blatt ist dauerhaft gemountet. Ein dauerhaft
   *    scharfer Erkenner konkurrierte sonst mit der Zurück-Geste des
   *    Bildschirms darunter.
   *  - Die Ausfahrt fährt die GESTE, nicht der Effekt oben: im Bild des
   *    Loslassens, auf dem UI-Strang. Der Effekt hält sich über `settlingRef`
   *    heraus — zwei Kurven auf demselben Wert wären als Tempo-Wechsel am Ende
   *    der Wischbewegung zu sehen.
   */
  const gate = useSheetScrollGate();
  /** Zeigt dem Effekt oben an, dass die Ausfahrt bereits läuft. */
  const settlingRef = useRef(false);
  const dismissBySwipe = useCallback(() => {
    // Angemeldet hat die Geste die Fahrt schon selbst — hier bleibt die
    // Buchhaltung: Der Effekt oben darf sie nicht ein zweites Mal ansetzen.
    settlingRef.current = true;
    close();
  }, [close]);
  const panGesture = useSheetSwipe({
    y: translateY,
    travel: sheetHeight,
    onDismiss: dismissBySwipe,
    enabled: open,
    gate,
    heal,
    // Die Ausfahrt hängt am Offen-Sein — die Geste hält sich dann heraus.
    closing: !open,
  });

  const dateLocale = DATE_LOCALES[locale] ?? enGB;
  const legs = result.legs && result.legs.length > 0 ? result.legs : buildFallbackLegs(result);

  // Kompakter Stat-Format „Do, 21. Mai" — Wochentags-Abkürzung + Tag + Monat.
  // In der Zone des Abfahrtshalts, wie die Uhrzeit daneben: Mit der Gerätezone
  // stand bei einer Abfahrt kurz nach Mitternacht Ortszeit der Vortag da.
  const summaryDateStr = (() => {
    try {
      return formatLocalizedDateInZone(result.departTime, result.originTz, "EEE, d. MMM", dateLocale);
    } catch {
      return "";
    }
  })();
  const departTime = (() => {
    try {
      return formatTimeInZone(result.departTime, result.originTz);
    } catch {
      return "";
    }
  })();

  // Umstiege der Verbindung (beim Flug: Stopps) — siehe `changesText`.
  const stopLabel = changesText(result.mode, result.stops, t);
  const stopsAccent = result.stops === 0 ? accent.solid : C.amber;
  /**
   * „Ortszeit (UTC+1)" — nur, wenn die Zeiten der Halte NICHT der Uhr des
   * Geräts entsprechen. Jede Zeit unten steht in der Zone IHRES Halts; wer in
   * Deutschland eine Fahrt in Oldham ansieht, soll „15:33" nicht für deutsche
   * Zeit halten.
   */
  const zoneHint = localTimeHint(
    [result.originTz, result.destinationTz, ...legs.flatMap((l) => [l.originTz, l.destTz])],
    t,
    Date.parse(result.departTime) || Date.now(),
  );

  return (
    <Animated.View
      style={[
        StyleSheet.absoluteFillObject,
        { zIndex: 300, elevation: 32 },
        rootAnim,
      ]}
      pointerEvents={hidden || !open ? "none" : "auto"}
    >
      <Animated.View style={[styles.backdrop, backdropAnim]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[styles.sheet, { backgroundColor: palette.s1 }, sheetAnim, { top: sheetTop }]}
      >
        {/* Nur noch Zeichen, nicht mehr Griff — gezogen wird überall. */}
        <View style={styles.handleWrap}>
          <View style={styles.handle} />
        </View>

        {/* Stat-Box (Date | Departure | Stops). Symmetrische Anordnung:
            Date linksbündig, Uhrzeit zentriert, Stops rechtsbündig — gleicher
            Abstand vom linken wie vom rechten Rand. Keine Trenner-Dots, weil
            sie die Symmetrie optisch brechen würden. */}
        <View style={[styles.summaryBox, { backgroundColor: palette.s2 }]}>
          <SummaryStat
            label={t("details.summary.date")}
            value={summaryDateStr}
            align="start"
          />
          <SummaryStat
            icon={<Clock size={14} color={C.text} strokeWidth={2} />}
            label={t("details.summary.departure")}
            value={departTime}
            align="center"
          />
          <SummaryStat
            icon={<CircleDot size={14} color={stopsAccent} strokeWidth={2} />}
            label={changesCaption(result.mode, t)}
            value={stopLabel}
            accentColor={stopsAccent}
            align="end"
          />
        </View>
        {zoneHint ? (
          <View style={styles.zoneHint}>
            <Clock size={12} color={C.sub} strokeWidth={2} />
            <Text style={styles.zoneHintText} numberOfLines={1}>
              {zoneHint}
            </Text>
          </View>
        ) : null}

        {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am
            Blatt jedes Scrollen ab. */}
        <GestureDetector gesture={gate.native}>
        <Animated.ScrollView
          ref={gate.ref}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          onScroll={gate.onScroll}
          scrollEventThrottle={16}
          // Kein Überzieh-Schimmer oben: Dort übernimmt ab sofort das Blatt.
          overScrollMode="never"
          bounces={false}
        >
          {/* Rückfall des Abfahrts-Tipps (StopDetailSheet): Gesucht war ein
              Ticket, gefunden nur die Fahrt. Dezent, aber gesagt. */}
          {result.timelineNotice === "noTicketOffer" ? (
            <View style={[styles.notice, { backgroundColor: palette.s2 }]}>
              <Info size={15} color={C.sub} strokeWidth={2.2} />
              <Text style={styles.noticeText}>{t("details.noTicketOffer")}</Text>
            </View>
          ) : null}
          <View style={styles.timeline}>
            {/* Vertical lime rail behind all dots — abs-positioned, exakt
                ausgerichtet auf die Dot-Mitten via SIDE_PAD + TIME_COL_W + GAP + DOT/2 */}
            <View style={[styles.timeRail, { backgroundColor: accent.solid }]} pointerEvents="none" />

            {atRest ? legs.map((leg, idx) => {
              const next = legs[idx + 1];
              const prev = legs[idx - 1];
              // Gefährdeter Anschluss: am Umstieg-Block vor dieser Fahrt — gibt es
              // keinen (ein Fußweg ist der Umstieg), dann an der Fahrt selbst.
              const transferBefore = !!prev && !prev.walking && !leg.walking;
              const isFirstLeg = idx === 0;
              const isLastLeg = idx === legs.length - 1;
              // Umstiegszeit aus den IST-Zeiten (Soll + Verspätung). Mit den
              // Sollzeiten allein stand bei einem Anschluss, der nur dank
              // Verspätung besteht, „0 min" — Werl → Greven: RB 59 an 20:28,
              // RE 7 Soll 19:43, Ist 20:32 → echt 4 min.
              const transferMin = next
                ? Math.max(
                    0,
                    Math.round(
                      (Date.parse(next.departTime) +
                        Math.max(0, next.departDelayMinutes ?? 0) * 60000 -
                        (Date.parse(leg.arriveTime) + Math.max(0, leg.arriveDelayMinutes ?? 0) * 60000)) /
                        60000,
                    ),
                  )
                : 0;
              // Ein Fußweg ZWISCHEN zwei Fahrten braucht keine eigenen
              // Stationszeilen: seine Endpunkte sind exakt die Ankunfts- bzw.
              // Abfahrtsstation der Nachbar-Legs, die ihre Zeilen ohnehin
              // rendern. Ohne diese Regel steht dieselbe Station viermal da
              //   09:44 Buchs SG / 09:58 Buchs SG / 10:00 Buchs Bhf / 10:00 Buchs Bhf
              // statt zweimal. An den REISE-ENDEN muss der Fußweg seine Zeile
              // dagegen zeigen — dort hat er keinen Nachbarn (Start „Zürich HB“,
              // Ziel „Zürich Brunau“).
              const showOrigin = !leg.walking || isFirstLeg;
              const showDest = !leg.walking || isLastLeg;
              // Zone DIESES Halts, nicht die der Gesamtreise.
              //
              // Vorher stand hier result.originTz für JEDE Abfahrt und
              // result.destinationTz für JEDE Ankunft. Bei einer Reise über eine
              // Zeitzonengrenze (Dortmund → London) wurde damit die Ankunft des
              // ersten Legs — in Brüssel — in LONDON-Zeit angezeigt, also eine
              // Stunde zu früh. Die Endzeiten stimmten, darum fiel es kaum auf;
              // die Umstiege dazwischen waren falsch.
              //
              // Fallback auf die Reise-Zone, falls ein Provider keine Leg-Zone
              // mitgibt (Flüge: dort ist die Zone bewusst "UTC", weil die Zeiten
              // als Wall-Clock ankommen — der Fallback zeigt sie verbatim, richtig).
              const legDepTz = leg.originTz ?? result.originTz;
              const legArrTz = leg.destTz ?? result.destinationTz;
              return (
                <View key={`${leg.origin}-${idx}`}>
                  {showOrigin ? (
                    <StationRow
                      time={timeOf(leg.departTime, legDepTz)}
                      delayed={
                        (leg.departDelayMinutes ?? 0) > 0
                          ? timeOf(shiftIsoByMinutes(leg.departTime, leg.departDelayMinutes!), legDepTz)
                          : undefined
                      }
                      name={leg.originLabel ?? leg.origin}
                      platform={leg.departPlatform}
                      terminal={isFirstLeg}
                    />
                  ) : null}
                  <TransportSegment
                    leg={leg}
                    atRiskBadge={leg.warning === "connectionAtRisk" && !transferBefore}
                  />
                  {showDest ? (
                    <StationRow
                      time={timeOf(leg.arriveTime, legArrTz)}
                      delayed={
                        (leg.arriveDelayMinutes ?? 0) > 0
                          ? timeOf(shiftIsoByMinutes(leg.arriveTime, leg.arriveDelayMinutes!), legArrTz)
                          : undefined
                      }
                      name={leg.destLabel ?? leg.destination}
                      platform={leg.arrivePlatform}
                      terminal={isLastLeg}
                    />
                  ) : null}
                  {/* Grenzt ein Fußweg-Leg an, ist DER bereits der Umstieg —
                      ein zusätzlicher „Umstieg 0 Min"-Block wäre nur Rauschen. */}
                  {next && !leg.walking && !next.walking ? (
                    <TransferSegment
                      minutes={transferMin}
                      isFlight={leg.product === "flight"}
                      atRisk={next.warning === "connectionAtRisk"}
                    />
                  ) : null}
                </View>
              );
            }) : null}
          </View>

          {/* Show-on-Map-Button — identischer Style + Press-Ripple wie der
              Details-anzeigen-Button im DetailsOverlay (Ghost-Pille mit Lime-
              Label). Liegt im ScrollView damit's mit dem Inhalt scrollt statt
              fest am Boden. */}
          <RippleTouch onPress={onShowMap} style={[styles.mapBtn, { borderColor: palette.border }]}>
            <MapIcon size={15} color={accent.solid} strokeWidth={2.5} />
            <Text style={[styles.mapBtnLabel, { color: accent.solid }]}>{t("details.showmap")}</Text>
          </RippleTouch>
        </Animated.ScrollView>
        </GestureDetector>
      </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
});

function SummaryStat({
  icon,
  value,
  label,
  accentColor,
  align,
}: {
  icon?: React.ReactNode;
  value: string;
  label: string;
  accentColor?: string;
  align: "start" | "center" | "end";
}) {
  const alignItems =
    align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center";
  return (
    <View style={[styles.summaryStat, { alignItems }]}>
      <View style={styles.summaryValueRow}>
        {icon}
        <Text
          style={[styles.summaryValue, accentColor ? { color: accentColor } : null]}
          numberOfLines={1}
        >
          {value}
        </Text>
      </View>
      <Text style={styles.summaryLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function StationRow({
  time,
  delayed,
  name,
  platform,
  terminal,
}: {
  time: string;
  /** Ist-Zeit bei Verspätung — dann wird `time` durchgestrichen und `delayed`
   *  rot darunter gesetzt. */
  delayed?: string;
  name: string;
  platform?: string;
  terminal?: boolean;
}) {
  const accent = useAccent();
  const palette = usePalette();
  return (
    <View style={styles.row}>
      {delayed ? (
        <View style={styles.timeLabelCol}>
          <Text style={[styles.timeLabel, styles.timeLabelStruck]}>{time}</Text>
          <Text style={styles.timeLabelDelayed}>{delayed}</Text>
        </View>
      ) : (
        <Text style={styles.timeLabel}>{time}</Text>
      )}
      <View style={[styles.dot, { backgroundColor: palette.s1, borderColor: accent.solid }, terminal && { backgroundColor: accent.solid }]} />
      <View style={styles.stationBody}>
        <Text style={styles.stationName} numberOfLines={1}>
          {name}
        </Text>
        {platform ? <PlatformChip value={platform} /> : null}
      </View>
    </View>
  );
}

function PlatformChip({ value }: { value: string }) {
  const t = useT();
  const accent = useAccent();
  return (
    <View style={[styles.platformChip, { backgroundColor: accent.subtle }]}>
      <Text style={[styles.platformChipText, { color: accent.solid }]}>{t("details.platform")} {value}</Text>
    </View>
  );
}

function TransportSegment({ leg, atRiskBadge }: { leg: SyntheticLeg; atRiskBadge?: boolean }) {
  const accent = useAccent();
  const palette = usePalette();
  const t = useT();
  const [open, setOpen] = useState(false);

  // Fußweg-Leg (MOTIS: „Tram bis Nachbarhalt, dann 12 min zu Fuß ans Ziel").
  // Ohne eigenen Zweig fiele hier nur ein Segment ohne Linien-Pille raus und die
  // Reise sähe aus, als endete sie am letzten Fahrzeug-Halt. Die DB zeigt den
  // Fußweg explizit — wir jetzt auch.
  if (leg.walking) {
    return (
      <View style={styles.segment}>
        <View style={styles.timeCol}>
          <Text style={styles.durationLabel}>{formatDuration(leg.durationMinutes)}</Text>
        </View>
        <View style={styles.dotSpacer}>
          <DottedLine />
        </View>
        <View style={styles.segmentBody}>
          <View style={[styles.transferCard, { borderColor: palette.border }]}>
            <View style={[styles.walkBadge, { backgroundColor: accent.subtle }]}>
              <Footprints size={16} color={accent.solid} strokeWidth={2.2} />
            </View>
            {/* Dauer steht bereits in der Zeitspalte links (wie bei allen Legs) —
                hier nicht nochmal wiederholen. */}
            <View style={{ flex: 1 }}>
              <Text style={styles.transferTitle}>{t("details.walk")}</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  const lineLabel = leg.line ?? productLabel(leg.product) ?? "";
  const stops = leg.stops ?? 0;
  const stopovers = leg.stopovers ?? [];
  // Flug: „toward" = ZIEL-Flughafen dieses Legs (leg.direction ist bei Flügen
  // die Airline — das gehört NICHT hinter „toward"). Bahn/Bus: leg.direction ist
  // der Zuglauf-Headsign (z.B. „nach München Hbf", oft über den Ausstieg hinaus)
  // = die korrekte Richtungsangabe, daher dort weiter bevorzugt.
  const destinationLabel =
    leg.product === "flight"
      ? (leg.destLabel ?? leg.destination)
      : (leg.direction ?? leg.destLabel ?? leg.destination);
  return (
    <View style={styles.segment}>
      <View style={styles.timeCol}>
        <Text style={styles.durationLabel}>{formatDuration(leg.durationMinutes)}</Text>
      </View>
      <View style={styles.dotSpacer} />
      <View style={styles.segmentBody}>
        <View style={[styles.transportCard, { backgroundColor: palette.s2, borderColor: palette.border }]}>
          <View style={styles.transportHeader}>
            {lineLabel ? (
              <LinePill label={lineLabel} product={leg.product} />
            ) : null}
            {leg.fahrtNr && leg.fahrtNr !== leg.line ? (
              <Text style={styles.codeText}>({leg.fahrtNr})</Text>
            ) : null}
          </View>
          {/* Laut Bahn fällt GENAU diese Fahrt aus bzw. ist der Umstieg in sie
              gefährdet — direkt an ihr, nicht nur oben im Blatt. */}
          {leg.warning === "cancelled" ? (
            <JourneyWarningBadge warning="cancelled" label={t("results.warning.cancelled")} />
          ) : atRiskBadge ? (
            <JourneyWarningBadge warning="connectionAtRisk" label={t("results.warning.connectionAtRisk")} />
          ) : null}
          {destinationLabel ? (
            <Text style={styles.destinationText}>
              <Text style={{ color: C.sub }}>{t("details.toward")} </Text>
              {destinationLabel}
            </Text>
          ) : null}
          {stops > 0 ? (
            <RippleTouch onPress={() => setOpen((v) => !v)} style={[styles.stopsToggle, { backgroundColor: palette.s3 }]} hitSlop={6}>
              <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
                <ChevronDown size={13} color={accent.solid} strokeWidth={2.5} />
              </View>
              <Text style={[styles.stopsToggleText, { color: accent.solid }]}>
                {stops === 1
                  ? t("details.stop.one")
                  : t("details.stop.many").replace("{count}", String(stops))}
              </Text>
            </RippleTouch>
          ) : null}
          {open && stopovers.length > 0 ? (
            <View style={styles.stopList}>
              {stopovers.map((s, i) => (
                <View key={`${s.name}-${i}`} style={styles.stopItem}>
                  <View style={styles.stopBullet} />
                  <Text style={styles.stopItemText} numberOfLines={1}>
                    {s.name}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function TransferSegment({
  minutes,
  isFlight,
  atRisk,
}: {
  minutes: number;
  isFlight?: boolean;
  /** Laut Bahn voraussichtlich nicht zu schaffen (Ist-Zeiten, siehe Server). */
  atRisk?: boolean;
}) {
  const accent = useAccent();
  const palette = usePalette();
  const t = useT();
  return (
    <View style={styles.segment}>
      <View style={styles.timeCol} />
      <View style={styles.dotSpacer}>
        <DottedLine />
      </View>
      <View style={styles.segmentBody}>
        <View style={[styles.transferCard, { borderColor: palette.border }]}>
          <View style={[styles.walkBadge, { backgroundColor: accent.subtle }]}>
            {/* Flug-Umstieg = Aufenthalt am Flughafen (Uhr), kein Fußweg zum Gleis. */}
            {isFlight ? (
              <Clock size={16} color={accent.solid} strokeWidth={2.2} />
            ) : (
              <Footprints size={16} color={accent.solid} strokeWidth={2.2} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.transferTitle}>{t("details.transfer")}</Text>
            <Text style={styles.transferMeta}>
              {formatDuration(minutes)}{" "}
              {isFlight ? t("details.transferwait") : t("details.transferwalk")}
            </Text>
            {atRisk ? (
              <View style={styles.transferRisk}>
                <JourneyWarningIcon warning="connectionAtRisk" size={12} />
                <Text style={[styles.transferRiskText, { color: JOURNEY_WARNING_COLORS.connectionAtRisk.fg }]}>
                  {t("details.transfer.atRisk")}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// Gepunktete vertikale Linie für den Transfer-Spacer — emuliert via gestapelte
// 4px-Striche, weil borderStyle:dashed bei Container-Heights variabel rendert.
function DottedLine() {
  const dashes = Array.from({ length: 8 });
  return (
    <View style={styles.dottedLineWrap}>
      {dashes.map((_, i) => (
        <View key={i} style={styles.dottedLineDash} />
      ))}
    </View>
  );
}

const styles = scaledStyles({
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
  /**
   * 12 oben, 16 unten — dieselben Zahlen wie an JEDEM anderen Griff der App
   * (`SheetModal`, Verlaufs-Blatt, Ticket-Dialog).
   *
   * Hier standen 14 unten. Zwei Punkte sieht niemand für sich genommen; sie
   * fallen erst auf, wenn zwei Blätter nacheinander aufgehen und das eine
   * minimal anders sitzt als das andere. Genau daraus entsteht der Eindruck,
   * eine App sei „nicht ganz sauber", ohne dass man sagen könnte woran.
   */
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 16 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: C.text },

  /* Stat-Box: Date | Departure | Stops */
  summaryBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 14,
    marginBottom: 16,
  },
  summaryStat: { flex: 1, flexDirection: "column", gap: 2, minWidth: 0 },
  // Ortszeit-Hinweis unter dem Kasten — klein und grau, rückt mit dem
  // eigenen Abstand an den Kasten heran (der hat unten 16).
  zoneHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginHorizontal: SIDE_PAD,
    marginTop: -8,
    marginBottom: 12,
  },
  zoneHintText: { fontSize: 11, color: C.sub, fontWeight: "500", letterSpacing: 0.1 },
  summaryValueRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  summaryValue: { fontSize: 14, fontWeight: "700", color: C.text, letterSpacing: -0.15 },
  summaryLabel: {
    fontSize: 10,
    color: C.sub,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },

  scrollContent: { paddingBottom: 32 },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginHorizontal: SIDE_PAD,
    marginTop: 4,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
  },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17, color: C.sub, fontWeight: "500" },

  /* Timeline scaffolding */
  timeline: { position: "relative", paddingTop: 4 },
  timeRail: {
    position: "absolute",
    top: 24,
    bottom: 24,
    left: SIDE_PAD + TIME_COL_W + GAP + DOT / 2 - 1.25,
    width: 2.5,
    opacity: 0.35,
    borderRadius: 2,
  },

  /* Station row */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: GAP,
    paddingHorizontal: SIDE_PAD,
    paddingVertical: 14,
    minHeight: 44,
  },
  timeLabel: {
    width: TIME_COL_W,
    fontSize: 17,
    fontWeight: "700",
    color: C.text,
    letterSpacing: -0.4,
  },
  // Nur die Fahrplanzeit ist im Flow → die Zelle bleibt einzeilig hoch und der
  // Timeline-Punkt (row alignItems:center) verrutscht NICHT bei Verspätung.
  timeLabelCol: { width: TIME_COL_W },
  // Verspätung: Fahrplanzeit ausgegraut durchgestrichen, Ist-Zeit rot darunter.
  timeLabelStruck: { color: "#8E8E93", textDecorationLine: "line-through" },
  timeLabelDelayed: {
    position: "absolute",
    top: "100%", // direkt UNTER die Fahrplanzeit, ohne Zellenhöhe zu ändern
    left: 0,
    width: TIME_COL_W,
    fontSize: 15,
    fontWeight: "800",
    color: "#FF3B5C",
    letterSpacing: -0.4,
  },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: C.bg,
    borderWidth: 2.5,
    zIndex: 1,
  },
  dotTerminal: {},
  stationBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  stationName: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: C.text,
    letterSpacing: -0.3,
  },
  platformChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,

    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(127,234,77,0.3)",
  },
  platformChipText: { fontSize: 11, fontWeight: "700" },

  /* Segment (shared by transport + transfer) */
  segment: {
    flexDirection: "row",
    gap: GAP,
    paddingHorizontal: SIDE_PAD,
    paddingBottom: 8,
  },
  // Fahrtzeit vertikal auf die Mitte des Balkens (Segment-Höhe) statt oben.
  timeCol: { width: TIME_COL_W, justifyContent: "center" },
  durationLabel: { fontSize: 12, color: C.sub, fontWeight: "600" },
  dotSpacer: { width: DOT, position: "relative" },
  segmentBody: { flex: 1 },

  /* Transport card */
  transportCard: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 20,
    padding: 14,
    gap: 10,
  },
  transportHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  codeText: { fontSize: 13, color: C.sub, fontWeight: "600" },
  destinationText: { fontSize: 13, color: C.text, fontWeight: "500" },
  stopsToggle: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: C.cardSoft,
    borderRadius: 9999,
  },
  stopsToggleText: { fontSize: 12, fontWeight: "700" },
  stopList: {
    marginTop: 2,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    gap: 7,
  },
  stopItem: { flexDirection: "row", alignItems: "center", gap: 9 },
  stopBullet: { width: 5, height: 5, borderRadius: 5, backgroundColor: C.subDim },
  stopItemText: { fontSize: 13, color: C.sub, flex: 1 },

  /* Transfer card */
  transferCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: C.border,
    borderRadius: 16,
  },
  walkBadge: {
    width: 30,
    height: 30,
    borderRadius: 10,

    alignItems: "center",
    justifyContent: "center",
  },
  transferTitle: { fontSize: 13, fontWeight: "700", color: C.text },
  transferMeta: { fontSize: 11, color: C.sub, fontWeight: "500" },
  transferRisk: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  transferRiskText: { fontSize: 12, fontWeight: "700", flexShrink: 1 },

  /* Dotted spacer line zwischen Transfer-Stationen */
  dottedLineWrap: {
    position: "absolute",
    left: DOT / 2 - 1,
    top: 4,
    bottom: 4,
    width: 2,
    justifyContent: "space-between",
  },
  dottedLineDash: { width: 2, height: 4, backgroundColor: C.sub, borderRadius: 1 },

  // Show-on-Map-Button — Style 1:1 vom „Details anzeigen"-Ghost-Button im
  // DetailsOverlay übernommen (gleiche Pille mit Lime-Label).
  mapBtn: {
    marginTop: 20,
    marginHorizontal: SIDE_PAD,
    paddingVertical: 12,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: "transparent",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  mapBtnLabel: {

    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.15,
  },
});
