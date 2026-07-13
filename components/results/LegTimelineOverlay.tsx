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
import { ChevronDown, Footprints, Clock, CircleDot, Map as MapIcon } from "lucide-react-native";
import { useRouter, usePathname } from "expo-router";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { formatTimeInZone, shiftIsoByMinutes } from "@/lib/time-format";
import { LegInfo, SearchResult } from "@/types/search";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import { fetchTripPolylines } from "@/lib/api/client";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";

// Farbpalette aus dem App-Theme — die hellere Lime aus dem Mockup ist bewusst
// auf unsere Brand-Lime gedimmt (#7FEA4D), Card/Surface-Stufen matchen
// DetailsOverlay damit die beiden Slides visuell zusammen wirken.
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
  const selectedResult = useSearchStore((s) => s.selectedResult);
  const directTripResult = useSearchStore((s) => s.directTripResult);
  const context = useSearchStore((s) => s.selectedResultContext);
  const pathname = usePathname();
  // Direct-Trip-Flow (Bus-Tap aus dem Stop-Sheet) hat Vorrang vor
  // selectedResult — sonst würde der vorher gewählte Trip aus der Such-
  // Liste die Timeline füllen statt der gerade getappten Bus-Abfahrt.
  const result = directTripResult ?? selectedResult;
  if (!open || !result) return null;
  // Wenn der Sheet aus dem Search-Flow geöffnet wurde (selectedResultContext
  // gesetzt) und wir gerade auf einer anderen Route sind (z.B. Map-Push),
  // verstecken wir den Sheet VISUELL (display:none), aber UNMOUNTEN ihn
  // NICHT. Sonst würde beim Zurückkommen die Slide-In-Animation neu
  // abspielen → laggt sichtbar während des Pop-Übergangs.
  const hiddenForOtherRoute =
    !directTripResult && context != null && pathname !== context.pathname;
  return <LegTimelineSheet result={result} hidden={hiddenForOtherRoute} />;
}

function LegTimelineSheet({ result, hidden }: { result: SearchResult; hidden?: boolean }) {
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

  // Kompakter Stat-Format „Do, 21. Mai" — Wochentags-Abkürzung + Tag + Monat.
  const summaryDateStr = (() => {
    try {
      return format(parseISO(result.departTime), "EEE, d. MMM", { locale: dateLocale });
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

  const stopLabel =
    result.stops === 0
      ? t("details.stop.zero")
      : result.stops === 1
      ? t("details.stop.one")
      : t("details.stop.many").replace("{count}", String(result.stops));
  const stopsAccent = result.stops === 0 ? accent.solid : C.amber;

  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        { zIndex: 300, elevation: 32, opacity: hidden ? 0 : 1 },
      ]}
      pointerEvents={hidden ? "none" : "auto"}
    >
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

        {/* Stat-Box (Date | Departure | Stops). Symmetrische Anordnung:
            Date linksbündig, Uhrzeit zentriert, Stops rechtsbündig — gleicher
            Abstand vom linken wie vom rechten Rand. Keine Trenner-Dots, weil
            sie die Symmetrie optisch brechen würden. */}
        <View style={styles.summaryBox}>
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
            label={t("details.summary.stops")}
            value={stopLabel}
            accentColor={stopsAccent}
            align="end"
          />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.timeline}>
            {/* Vertical lime rail behind all dots — abs-positioned, exakt
                ausgerichtet auf die Dot-Mitten via SIDE_PAD + TIME_COL_W + GAP + DOT/2 */}
            <View style={[styles.timeRail, { backgroundColor: accent.solid }]} pointerEvents="none" />

            {legs.map((leg, idx) => {
              const next = legs[idx + 1];
              const isFirstLeg = idx === 0;
              const isLastLeg = idx === legs.length - 1;
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
                    time={timeOf(leg.departTime, result.originTz)}
                    delayed={
                      (leg.departDelayMinutes ?? 0) > 0
                        ? timeOf(shiftIsoByMinutes(leg.departTime, leg.departDelayMinutes!), result.originTz)
                        : undefined
                    }
                    name={leg.originLabel ?? leg.origin}
                    platform={leg.departPlatform}
                    terminal={isFirstLeg}
                  />
                  <TransportSegment leg={leg} />
                  <StationRow
                    time={timeOf(leg.arriveTime, result.destinationTz)}
                    delayed={
                      (leg.arriveDelayMinutes ?? 0) > 0
                        ? timeOf(shiftIsoByMinutes(leg.arriveTime, leg.arriveDelayMinutes!), result.destinationTz)
                        : undefined
                    }
                    name={leg.destLabel ?? leg.destination}
                    platform={leg.arrivePlatform}
                    terminal={isLastLeg}
                  />
                  {/* Grenzt ein Fußweg-Leg an, ist DER bereits der Umstieg —
                      ein zusätzlicher „Umstieg 0 Min"-Block wäre nur Rauschen. */}
                  {next && !leg.walking && !next.walking ? (
                    <TransferSegment
                      minutes={transferMin}
                      isFlight={leg.product === "flight"}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>

          {/* Show-on-Map-Button — identischer Style + Press-Ripple wie der
              Details-anzeigen-Button im DetailsOverlay (Ghost-Pille mit Lime-
              Label). Liegt im ScrollView damit's mit dem Inhalt scrollt statt
              fest am Boden. */}
          <RippleTouch onPress={onShowMap} style={styles.mapBtn}>
            <MapIcon size={15} color={accent.solid} strokeWidth={2.5} />
            <Text style={[styles.mapBtnLabel, { color: accent.solid }]}>{t("details.showmap")}</Text>
          </RippleTouch>
        </ScrollView>
      </Animated.View>
    </View>
  );
}

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
      <View style={[styles.dot, { borderColor: accent.solid }, terminal && { backgroundColor: accent.solid }]} />
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

function TransportSegment({ leg }: { leg: SyntheticLeg }) {
  const accent = useAccent();
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
          <View style={styles.transferCard}>
            <View style={[styles.walkBadge, { backgroundColor: accent.subtle }]}>
              <Footprints size={16} color={accent.solid} strokeWidth={2.2} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.transferTitle}>{t("details.walk")}</Text>
              <Text style={styles.transferMeta}>{formatDuration(leg.durationMinutes)}</Text>
            </View>
          </View>
        </View>
      </View>
    );
  }

  const lineLabel = leg.line ?? productLabel(leg.product) ?? "";
  const lineColor = productColor(leg.product);
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
        <View style={styles.transportCard}>
          <View style={styles.transportHeader}>
            {lineLabel ? (
              <View style={[styles.linePill, { backgroundColor: lineColor }]}>
                <Text style={styles.linePillText}>{lineLabel}</Text>
              </View>
            ) : null}
            {leg.fahrtNr && leg.fahrtNr !== leg.line ? (
              <Text style={styles.codeText}>({leg.fahrtNr})</Text>
            ) : null}
          </View>
          {destinationLabel ? (
            <Text style={styles.destinationText}>
              <Text style={{ color: C.sub }}>{t("details.toward")} </Text>
              {destinationLabel}
            </Text>
          ) : null}
          {stops > 0 ? (
            <Pressable onPress={() => setOpen((v) => !v)} style={styles.stopsToggle} hitSlop={6}>
              <View style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}>
                <ChevronDown size={13} color={accent.solid} strokeWidth={2.5} />
              </View>
              <Text style={[styles.stopsToggleText, { color: accent.solid }]}>
                {stops === 1
                  ? t("details.stop.one")
                  : t("details.stop.many").replace("{count}", String(stops))}
              </Text>
            </Pressable>
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

function TransferSegment({ minutes, isFlight }: { minutes: number; isFlight?: boolean }) {
  const accent = useAccent();
  const t = useT();
  return (
    <View style={styles.segment}>
      <View style={styles.timeCol} />
      <View style={styles.dotSpacer}>
        <DottedLine />
      </View>
      <View style={styles.segmentBody}>
        <View style={styles.transferCard}>
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
  timeLabelStruck: { color: "#8A8A90", textDecorationLine: "line-through" },
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
  linePill: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 10 },
  linePillText: { fontSize: 12, fontWeight: "800", color: C.text, letterSpacing: -0.2 },
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
