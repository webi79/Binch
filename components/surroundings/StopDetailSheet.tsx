import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { TITLE_GAP, GROUP_GAP, SECTION_GAP } from "@/lib/theme/spacing";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import { PUSH_SPRING, SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import { isSheetDragging, isTransitionBusy, setSheetDragging } from "@/lib/nav/transitionBusy";
import {
  View,
  Text,
  ActivityIndicator,
  BackHandler,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  scrollTo,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  FadeInDown,
  LayoutAnimationConfig,
  LinearTransition,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { Train, Bus, TramFront, Ship, Undo2, type LucideIcon } from "lucide-react-native";
import Svg, { Circle, Path } from "react-native-svg";
import {
  fetchStopArrivals,
  fetchStopDepartures,
  fetchTripDetail,
  searchByMode,
  type StopBoardItem,
  type StopBoardResponse,
  type TripDetailResponse,
} from "@/lib/api/client";
import { useSearchStore, type SelectedCity, type SelectedStop } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import type { MarkerKind } from "@/lib/surroundings/mockData";
import {
  registerStopSheetAnimation,
  settleStopSheet,
  stopSheetCollapsed,
  stopSheetHeal,
  stopSheetSnap,
  stopSheetY,
} from "./stopSheetAnimation";
import { isMapMoving, reportStopSheetTarget } from "@/lib/surroundings/mapViewport";
import { CityTripBody } from "@/components/surroundings/CityTripBody";
import { stopToLocation } from "@/lib/surroundings/savedStation";
import { platformPrefixFor } from "@/lib/surroundings/standLabel";
import { haptic } from "@/lib/haptics";
import { showConnectionNotFound } from "@/lib/connectionNotFoundAlert";
import type { SearchResult, TravelMode } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";
import { SaveStarButton } from "@/components/surroundings/SaveStarButton";
import { WalkIcon } from "@/components/ui/WalkIcon";
import { iconForProduct } from "@/components/results/LinePill";
import type { SharedValue } from "react-native-reanimated";
import { LiveButton, useLiveClock } from "@/components/live/LiveButton";
import { probeFrames, probeMark } from "@/lib/live/probe";
import { airportByIata } from "@/lib/live/model";
import { TRANSIT_COLOR, transitCategory } from "@/lib/theme/transitColors";
import type { LiveSession } from "@/lib/live/types";
import { router } from "expo-router";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { daysFromToday, formatLocalizedDateInZone, formatTimeInZone, localTimeHint, shiftIsoByMinutes } from "@/lib/time-format";
import { de, enGB, es, fr } from "date-fns/locale";
import {
  dragHealOffset,
  snapToPixel,
  startDragHeal,
  SWIPE_ACTIVATE,
  SWIPE_OUT,
  useSheetScrollGate,
  type SheetScrollGate,
} from "@/lib/ui/sheetSwipe";
import { slideTiming } from "@/lib/nav/slideMotion";
import { StatePanel } from "@/components/ui/StatePanel";
import { LoadGate } from "@/components/ui/LoadGate";
import { SheetLoader } from "@/components/surroundings/SheetLoader";
import { SheetHandle } from "@/components/ui/SheetModal";

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

// Surface-Stack: bg → surface2 (Cards) → surface3 (Pressed-State). border
// rahmt Hero-Card subtil ein. Gleiche Werte wie in ClearSearchHistoryAlert
// + RecentHistoryOverlay damit das Material konsistent ist.
const C = {
  bg: "#171719",
  surface2: "#171719",
  surface3: "#212123",
  border: "#212123",
  white: "#F4F4F5",
  g1: "#C4C4C8",
  g2: "#8E8E93",
  g3: "#56565C",
};
// Akzent-Tokens kommen jetzt aus useAccent() — die Hard-Coded LIME-/SUBTLE-/
// BORDER-Werte sind raus damit die Slide automatisch die User-Wahl
// (Lime/Mint/Iris) erbt. Components die im StyleSheet noch statisch waren,
// nutzen jetzt inline-style mit accent.* statt diesen Konstanten.


type BoardTab = "departures" | "arrivals";

/**
 * DIE VERKEHRSARTEN DER TAFEL als Filter-Kästen — wie DB Navigator und Google
 * Maps: Das Blatt zeigt, was an diesem Halt fährt („RE/RB", „S-Bahn", „Bus"…),
 * und ein Tipp auf einen Kasten blendet diese Art aus (die Farbe geht) bzw.
 * wieder ein. Ein FILTER, kein Umschalter — mehrere Arten zugleich; sobald
 * etwas ausgeblendet ist, holt der Pfeil rechts alles zurück. Vorher gab es nur
 * bei Halten mit mehreren Arten Pillen, und die schalteten zwischen ihnen um.
 *
 * Feiner als die Arten der Karte (`MarkerKind`): Fern-, Regional- und S-Bahn-
 * Züge sind dort alle „Zug", hier getrennt — aus dem Produkt jeder Fahrt.
 * Transitous liefert deutsche S-Bahnen als `metro`.
 */
type BoardCategory = "longDistance" | "regional" | "suburban" | "subway" | "tram" | "bus" | "ferry" | "other";
const CATEGORY_ORDER: readonly BoardCategory[] = [
  "longDistance", "regional", "suburban", "subway", "tram", "bus", "ferry", "other",
];
/** Füllung in der Farbe der Verkehrsart — wie überall in der App (lib/theme/transitColors.ts). */
const CATEGORY: Record<BoardCategory, { tKey: string; color: string; Icon?: LucideIcon; letter?: string }> = {
  longDistance: { tKey: "stop.cat.longDistance", color: TRANSIT_COLOR.longDistance, Icon: Train },
  regional: { tKey: "stop.cat.regional", color: TRANSIT_COLOR.regional, Icon: Train },
  suburban: { tKey: "stop.cat.suburban", color: TRANSIT_COLOR.suburban, letter: "S" },
  subway: { tKey: "stop.cat.subway", color: TRANSIT_COLOR.subway, letter: "U" },
  tram: { tKey: "stop.cat.tram", color: TRANSIT_COLOR.tram, Icon: TramFront },
  bus: { tKey: "stop.cat.bus", color: TRANSIT_COLOR.bus, Icon: Bus },
  ferry: { tKey: "stop.cat.ferry", color: TRANSIT_COLOR.ferry, Icon: Ship },
  other: { tKey: "stop.cat.other", color: TRANSIT_COLOR.other, Icon: Train },
};
const NO_CATS: ReadonlySet<BoardCategory> = new Set();
/** Symbol und Schrift auf den Linien-Plaketten — weiß wie auf den Kästen der Karte. */
const BADGE_INK = "#FFFFFF";

/** Die Art einer Fahrt der Tafel — Ersatzbusse („Bus RB59") zählen als Bus. */
function categoryOf(item: StopBoardItem): BoardCategory {
  const c = transitCategory(item.product, item.line);
  return c === "flight" ? "other" : c;
}

/** Welche Arten auf den Tafeln vorkommen — in fester Reihenfolge. */
function categoriesOf(...boards: (StopBoardResponse | undefined)[]): BoardCategory[] {
  const seen = new Set<BoardCategory>();
  for (const b of boards) for (const it of b?.results ?? []) seen.add(categoryOf(it));
  return CATEGORY_ORDER.filter((c) => seen.has(c));
}

/** Die Plakette einer Linie in der Farbe ihrer Verkehrsart (Flüge: Akzent). */
function lineColor(item: StopBoardItem, flight: string): string {
  const c = transitCategory(item.product, item.line);
  return c === "flight" ? flight : TRANSIT_COLOR[c];
}

function formatDistance(m: number | undefined, t: (k: string) => string): string {
  if (m === undefined) return "";
  if (m < 1000) return `${Math.round(m)} ${t("stop.distance.m_away")}`;
  return `${(m / 1000).toFixed(1)} ${t("stop.distance.km_away")}`;
}

// Transit-Zeiten zeigen wir IMMER im 24h-Format (17:33) statt 12h mit AM/PM.
// Das gilt unabhängig von der Device-Locale — bei englischer System-Sprache
// würde toLocaleTimeString sonst „5:33 PM" liefern was im Bahn-Kontext
// unüblich ist und einen visuellen Layout-Sprung bringt (4 Stellen vs 7).
// `hourCycle: "h23"` zwingt 24h und 2-Ziffer-Stunde (00-23).
const TIME_FORMAT_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
};

/**
 * Uhrzeit in der ORTSZEIT DES HALTS (`tz` aus der Tafel-Antwort), wie überall
 * in der App (lib/time-format.ts). Hier stand die Uhr des Geräts: In Oldham
 * zeigte die Tafel „16:33" (deutsche Zeit) und die Zeitleiste derselben Fahrt
 * „15:33" (britische). Ohne Zone — alte Server-Antwort — bleibt es beim Gerät.
 */
function formatTime(iso: string, tz?: string): string {
  if (tz) return formatTimeInZone(iso, tz);
  const d = new Date(iso);
  return d.toLocaleTimeString("de-DE", TIME_FORMAT_OPTS);
}

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

/**
 * Tag einer Tafel-Zeile, wenn sie NICHT heute fährt (Ortszeit des Halts):
 * „Morgen", sonst der Wochentag („Mo."); heute: null. An selten bedienten
 * Halten reichen die nächsten Abfahrten über Tage — nachgezählt an einer
 * Stichprobe über 16 Länder: 40 von 248 Halten, und „05:41" am Montag las sich
 * wie heute früh. `short`: immer der Wochentag (passt in den Ring).
 */
function boardDayLabel(
  iso: string,
  tz: string | undefined,
  locale: string,
  tomorrow: string,
  short = false,
): string | null {
  const days = daysFromToday(iso, tz);
  if (days === 0) return null;
  if (days === 1 && !short) return tomorrow;
  return formatLocalizedDateInZone(iso, tz, "EEE", DATE_LOCALES[locale as keyof typeof DATE_LOCALES] ?? enGB);
}

/** ISO-Zeit + Delay-Minuten → tatsächliche Abfahrtszeit als „HH:MM"-String.
 *  Wird unter der durchgestrichenen Planzeit angezeigt wenn die Abfahrt
 *  verspätet ist. */
function addDelayToTime(iso: string, delayMin: number, tz?: string): string {
  return formatTime(shiftIsoByMinutes(iso, delayMin), tz);
}

/** Minuten bis zur Abfahrt. Inklusive Delay damit der Hero-Ring auch
 *  korrekt schrumpft wenn der Zug 4 Min Verspätung hat. Negative Werte
 *  (Abfahrt liegt in der Vergangenheit) klemmen wir auf 0 fest. */
function minutesUntil(iso: string, delayMin: number): number {
  const target = Date.parse(iso) + delayMin * 60_000;
  const now = Date.now();
  return Math.max(0, Math.round((target - now) / 60_000));
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

/** Lokaler ÖPNV (U-Bahn/S-Bahn/Tram) hat KEINE individuelle Online-Buchung —
 *  läuft im Verbund-Tarif. Diese Trips gehören durch den Trip-Detail-Flow
 *  (LegTimeline mit allen Stops) statt durch die Booking-Suche.
 *
 *  HAFAS-Product-Tags die hier matchen:
 *    - subway, metro, u-bahn  → U-Bahn
 *    - suburban, s-bahn       → S-Bahn (Verbund-Tarif)
 *    - tram, light_rail       → Tram/Stadtbahn
 *  Nicht hier: national/regional/express → echte Fernzüge mit DB-Buchung */
function isLocalTransitProduct(product: string | null): boolean {
  if (!product) return false;
  const p = product.toLowerCase();
  return /(subway|metro|u-?bahn|tram|stadtbahn|light.?rail|s-?bahn|suburban)/.test(p);
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
    // EINE Fahrt — keine Umstiege. `stops` der Verbindung zählt Umstiege, die
    // Zwischenhalte stehen am Leg. Ältere Server schickten hier deren Zahl,
    // und die Zeitleiste zeigte „29 Stopps · Umstieg".
    stops: 0,
    stopLabels: [],
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
      // Zone DIESES Halts — ohne sie fiele die Zeitleiste auf die der Reise
      // zurück (bei einer Fahrt über eine Zeitzonengrenze falsch).
      originTz: l.originTz,
      destTz: l.destTz,
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
// Gestaffelte Toleranzen je nach Match-Stärke. Stärkeres Signal = mehr
// Spielraum bei der Zeit. Begründung:
//  - Line+Direction-Match (15 Min): U5 nach Laimer Platz um 20:45 vs HAFAS
//    20:47 ist ziemlich sicher derselbe Zug — kein anderer U5 nach Laimer
//    Platz fährt 2 Min später (Takt ist 5-10 Min).
//  - Line-only-Match (5 Min): Linie matched aber Richtung unbekannt. Etwas
//    strenger weil bei dichten Takten (RB98 alle 30min) Verwechslung möglich.
//  - Time-only (3 Min): schwächstes Signal, sehr strikt.
const LINE_AND_DIR_MATCH_TOLERANCE_MS = 15 * 60_000;
const LINE_MATCH_TIME_TOLERANCE_MS = 5 * 60_000;
const TIME_FALLBACK_TOLERANCE_MS = 3 * 60_000;

/** Normalisiert Richtung-Strings für Vergleich. „München Laimer Platz" und
 *  „Laimer Platz" sollen matchen — wir vergleichen via Substring-Inklusion
 *  nach Normalisierung. */
function normalizeDirection(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[(),.]/g, "").trim();
}

function directionMatches(itemDir: string, resultDir: string | null | undefined): boolean {
  const a = normalizeDirection(itemDir);
  const b = normalizeDirection(resultDir);
  if (!a || !b) return false;
  // Substring beidseitig — „Laimer Platz" matched „Laimer Platz, München".
  return a === b || a.includes(b) || b.includes(a);
}

function findBestMatch(results: SearchResult[], item: StopBoardItem): SearchResult | undefined {
  if (results.length === 0) return undefined;
  const targetMs = Date.parse(item.plannedTime);
  const itemLine = normalizeLine(item.line);
  const itemDir = item.direction ?? "";
  // 3 Buckets nach Match-Stärke:
  //   1. Linie + Richtung + Zeit  → stärkstes Signal (z.B. U5 nach Laimer Platz
  //      um 20:45 — kann nicht versehentlich mit U5 nach Neuperlach matchen)
  //   2. Linie + Zeit              → falls Direction-Field unzuverlässig ist
  //   3. Zeit only                  → letzter Fallback
  let bestWithLineAndDir: SearchResult | undefined;
  let bestWithLineAndDirDiff = Infinity;
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
      if (lineMatch) {
        if (diff < bestWithLineDiff) {
          bestWithLine = r;
          bestWithLineDiff = diff;
        }
        // Richtungs-Check: r.legs[0].direction ist die Headsign-Endstation
        // des ersten Train-Legs. Falls keine legs vorhanden, fallback auf
        // destLabel des Results.
        const resultDir = r.legs?.[0]?.direction ?? r.destLabel ?? null;
        if (itemDir && directionMatches(itemDir, resultDir) && diff < bestWithLineAndDirDiff) {
          bestWithLineAndDir = r;
          bestWithLineAndDirDiff = diff;
        }
      }
    }
  }
  if (bestWithLineAndDir && bestWithLineAndDirDiff <= LINE_AND_DIR_MATCH_TOLERANCE_MS) return bestWithLineAndDir;
  if (bestWithLine && bestWithLineDiff <= LINE_MATCH_TIME_TOLERANCE_MS) return bestWithLine;
  if (bestAny && bestAnyDiff <= TIME_FALLBACK_TOLERANCE_MS) return bestAny;
  return undefined;
}

/** Live-Knopf nur an Fahrten, die in diesem Fenster ab- oder ankommen. */
const LIVE_PAST_MS = 30 * 60_000;
const LIVE_AHEAD_MS = 90 * 60_000;

/** Doppel-Tipp-Sperre im Direkt-Weg: die Zeitgrenze von `fetchTripDetail`
 *  (12 s) plus Reserve. Gelöst wird sie, sobald die Antwort da ist. */
const DIRECT_TAP_LOCK_MS = 12_500;

/**
 * Wartet, bis die Einfahrt des Detail-Blatts durch ist — `PUSH_SPRING` plus die
 * Reserve von `markTransitionBusy`, und solange danach noch etwas fährt etwas
 * länger, höchstens anderthalb Sekunden ab dem Tipp.
 *
 * Eintreffende Daten gehören nicht in die Fahrt. Die Tipp-Suchen antworteten
 * laut Server-Log nach 0,1–0,4 s (aus dem Zwischenspeicher noch schneller), die
 * Einfahrt dauert 0,43 s. Die Ersetzung des Platzhalters rendert das ganze
 * Detail-Blatt neu — ein Commit mitten in der Bewegung, und jeder Commit
 * schreibt die Reanimated-Werte erst ein, zwei Bilder später zurück
 * (feedback_reanimated_commit_race). Wer langsamer antwortet, wartet hier gar
 * nicht.
 */
async function afterDetailsPush(tapAt: number): Promise<void> {
  const earliest = tapAt + PUSH_SPRING.duration + 80;
  const latest = tapAt + 1_500;
  for (;;) {
    const now = Date.now();
    if (now >= latest || (now >= earliest && !isTransitionBusy())) return;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(16, Math.min(earliest - now, 100))),
    );
  }
}

/** Kleines Walk-Männchen für die Subtitle-Zeile (Distanz zum Stop).
 *  Lucide hat kein Walking-Person-Icon, daher inline-SVG. Form orientiert sich
 *  an der WerlAbfahrten-Vorlage: kleiner Kopf-Kreis, Körper als Strich-Pfade
 *  für Beine/Arme. strokeLinecap=round damit das Männchen bei 14px-Größe
 *  weich aussieht und nicht pixelig. */
// Das Geh-Symbol steht in components/ui/WalkIcon.tsx — das Stadt-Blatt nimmt es auch.

// `iconForProduct` steht in components/results/LinePill.tsx — die Plaketten des
// Stadt-Blatts brauchen dieselbe Zuordnung.

/** Card-Row im neuen Hero-Design — eine Departure pro Card.
 *  Layout: Zeit-Block links (Plan + ggf. Real durchgestrichen), Lime-Line-
 *  Badge in der Mitte, Direction + Platform rechts. Anti-Patterns die ich
 *  vermieden habe: keine Border (sonst wirkt's bei vielen Cards untereinander
 *  unruhig), keine Underline auf Time damit das Strikethrough für Delay
 *  eindeutig ist. */
function StopBoardRow({
  item,
  tz,
  dayLabel,
  platformPrefix,
  loading,
  onPress,
  onLive,
  liveLabel,
  liveClock,
}: {
  item: StopBoardItem;
  /** Ortszeit-Zone des Halts — siehe `formatTime`. */
  tz?: string;
  /** „Morgen"/„Mo." — nur wenn die Zeile nicht heute fährt (`boardDayLabel`). */
  dayLabel?: string | null;
  platformPrefix: string;
  loading: boolean;
  onPress: () => void;
  /** Live verfolgen — nur bei Fahrten, die gerade fahren oder bald kommen. */
  onLive?: () => void;
  liveLabel?: string;
  /** Gemeinsamer Takt aller Live-Knöpfe der Tafel (`useLiveClock`). */
  liveClock?: SharedValue<number>;
}) {
  const accent = useAccent();
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product, item.line);
  const badge = lineColor(item, accent.dark);
  return (
    <RippleTouch
      onPress={onPress}
      disabled={loading}
      /**
       * Welle statt `Pressable` — beim Ziehen des Blattes landet der Finger
       * meist genau hier. `Pressable` führt einen React-Zustand „gedrückt" und
       * rendert beim Aufsetzen und beim Abbruch neu; dieser Durchgang fiel in den
       * Anfang der Bewegung und setzte das Blatt kurz zurück (siehe
       * `startDragHeal` in lib/ui/sheetSwipe.ts). Die native Welle braucht
       * keinen Durchgang — wie die Kacheln im Ticket-Blatt.
       */
      style={styles.cardRow}
    >
      {/* Zeit-Block: Planzeit oben, bei Delay durchgestrichen + Real-Zeit
          in Delay-Farbe darunter. Pünktlich → nur Planzeit, kein zweiter
          Eintrag (vermeidet redundantes Doppel-Time). */}
      <View style={styles.cardTime}>
        {dayLabel ? (
          <Text style={styles.cardDay} numberOfLines={1}>
            {dayLabel}
          </Text>
        ) : null}
        <Text
          style={[
            styles.cardTimeText,
            delay > 0 ? styles.cardTimeStrike : null,
          ]}
        >
          {formatTime(item.plannedTime, tz)}
        </Text>
        {delay > 0 && (
          <Text style={styles.cardTimeReal}>
            {addDelayToTime(item.plannedTime, delay, tz)}
          </Text>
        )}
      </View>

      {/* Linien-Plakette mit Symbol — in der Farbe der Verkehrsart, wie überall. */}
      <View style={[styles.cardLineBadge, { backgroundColor: badge, borderColor: badge }]}>
        <ModeIcon size={14} color={BADGE_INK} strokeWidth={2.2} />
        <Text style={[styles.cardLineBadgeText, { color: BADGE_INK }]} numberOfLines={1}>
          {item.line}
        </Text>
      </View>

      <View style={styles.cardRight}>
        <Text style={styles.cardDirection} numberOfLines={1}>
          {item.direction || "—"}
        </Text>
        {item.platform ? (
          <Text style={styles.cardPlatform} numberOfLines={1}>
            {platformPrefix} {item.platform}
          </Text>
        ) : null}
      </View>

      {loading ? (
        <ActivityIndicator color={C.g1} size="small" style={{ marginLeft: 8 }} />
      ) : onLive ? (
        <LiveButton onPress={onLive} label={liveLabel ?? ""} clock={liveClock} />
      ) : null}
    </RippleTouch>
  );
}

/** Hero-Card für die NÄCHSTE Abfahrt. Hat einen Countdown-Ring links der
 *  proportional zu den verbleibenden Minuten füllt (15 Min = voller Ring,
 *  0 Min = leerer Ring). Rechts: Line-Badge, „NÄCHSTE"-Label, Destination,
 *  Real-Zeit + Platform.
 *
 *  Warum 15 Min als Ring-Skala? Default-View-Zeitspanne ist meistens ~30-60
 *  Min; 15 Min als Maximum gibt einen visuell deutlichen Drop wenn der nächste
 *  Bus in 12 Min kommt vs 5 Min. Größer würde der Ring meist ~voll wirken. */
function NextHero({
  item,
  tz,
  dayLabel,
  ringDayLabel,
  fetchedAt,
  platformPrefix,
  nextLabel,
  ontimeLabel,
  loading,
  onPress,
  onLive,
  liveLabel,
  liveClock,
}: {
  item: StopBoardItem;
  /** Ortszeit-Zone des Halts — der Ring zählt Minuten und braucht sie nicht. */
  tz?: string;
  /** „Morgen"/„Mo." vor der Uhrzeit, wenn die Fahrt nicht heute ist. */
  dayLabel?: string | null;
  /** Wochentag IM Ring statt der Minuten — „5700 Min" sagt niemandem etwas. */
  ringDayLabel?: string | null;
  fetchedAt: string | undefined;
  platformPrefix: string;
  nextLabel: string;
  ontimeLabel: string;
  loading: boolean;
  onPress: () => void;
  /** Live verfolgen — siehe `StopBoardRow`. */
  onLive?: () => void;
  liveLabel?: string;
  liveClock?: SharedValue<number>;
}) {
  const accent = useAccent();
  const palette = usePalette();
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product, item.line);
  const badge = lineColor(item, accent.dark);

  // Live-Ticker: alle 1 s neu rendern damit Ring sekundengenau wandert.
  // Nur aktiv wenn das Sheet WIRKLICH offen ist (selectedStop != null) —
  // sonst tick't das Interval auch nach Slide-Out weiter (displayStop hält
  // den Stop für die Animation noch fest → NextHero bleibt gemountet) und
  // erzeugt 1 Re-Render pro Sekunde im Hintergrund.
  const sheetOpen = useSearchStore((s) => s.selectedStop !== null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sheetOpen) return;
    /**
     * Kein Takt, während etwas fährt.
     *
     * Er rendert diese Zeile jede Sekunde neu, samt ihrem SVG-Ring — und
     * animierte SVG-Eigenschaften machen die ganze Fläche ungültig. Bei einem
     * Takt pro Sekunde gegen Fahrten von 300 bis 430ms trifft das regelmäßig,
     * aber eben nicht immer: wieder ein „manchmal".
     *
     * Bo hat für genau dieses Problem längst einen geteilten, geprüften Takt
     * (`lib/ui/nowTicker.ts`); dieses Blatt hat seinen eigenen behalten. Die
     * Prüfung wird hier nachgezogen, ohne die Sekunden-Genauigkeit anzutasten:
     * Übersprungen wird nur der eine Takt, der nächste kommt in einer Sekunde.
     */
    const id = setInterval(() => {
      /**
       * Auch WÄHREND EINES ZIEHENS aussetzen — das fehlte.
       *
       * `isTransitionBusy` meldet nur programmierte Fahrten. Ein Finger am
       * Blatt meldet dort nichts, also lief der Takt mitten im Ziehen weiter —
       * und zeichnete die ganze Liste samt SVG-Ringen neu, während sie unter
       * dem Finger wanderte. Das war das sichtbare Springen der Elemente.
       */
      // Und nicht, solange die Karte fährt oder ausrollt: Ein Durchgang dort
      // zeichnet unter der TextureView-Karte das ganze Fenster mit.
      if (isTransitionBusy() || isSheetDragging() || isMapMoving()) return;
      // Eingeklappt ist die Tafel unsichtbar — kein Neuzeichnen für niemanden.
      // Nach dem Aufziehen kommt der nächste Takt binnen einer Sekunde.
      if (stopSheetCollapsed.value) return;
      setNow(Date.now());
    }, 1_000);
    return () => clearInterval(id);
  }, [sheetOpen]);

  const expectedMs = Date.parse(item.plannedTime) + delay * 60_000;
  // Display-Minuten mit ceil damit „in 5 sec" noch als 1 Min angezeigt wird
  // (nicht „0 Min" obwohl er noch fährt).
  const mins = Math.max(0, Math.ceil((expectedMs - now) / 60_000));

  // Baseline = Server-fetchedAt-Zeitpunkt (NICHT „erste Sicht im Sheet").
  // Begründung: User-Mental-Model ist „Zug kommt in 40 Min, ich warte 20,
  // also Ring bei 50%" — die 40 Min sind die Restzeit zum Zeitpunkt als die
  // Daten geholt wurden. Wenn der User die Slide erst nach 20 Min öffnet,
  // ist der Ring schon entsprechend gefüllt statt bei 0 zu starten.
  // Fallback auf `now` wenn fetchedAt fehlt/unparsbar → Ring startet bei 0,
  // gleiches Verhalten wie vorher.
  const baselineMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  const baseline = Number.isFinite(baselineMs) ? baselineMs : now;
  // max(1000, …) verhindert /0 wenn die Daten gerade erst geholt wurden
  // und expectedMs <= baseline. Ring zeigt dann direkt sinnvolle Fraktion.
  const totalMs = Math.max(1_000, expectedMs - baseline);
  const elapsedMs = now - baseline;

  const RING_R = 34;
  const CIRC = 2 * Math.PI * RING_R;
  // Ring-Fill: bei Daten-Fetch=0%, bei Abfahrt=100%. Linear über die echte
  // Wartezeit. Per-Sekunde-Update über `now` → sichtbare Bewegung.
  const frac = Math.min(1, Math.max(0, elapsedMs / totalMs));
  const clock = delay > 0 ? addDelayToTime(item.plannedTime, delay, tz) : formatTime(item.plannedTime, tz);
  const realTime = dayLabel ? `${dayLabel} ${clock}` : clock;
  const subText = delay > 0
    ? `${realTime} · +${delay} Min${item.platform ? ` · ${platformPrefix} ${item.platform}` : ""}`
    : `${realTime} · ${ontimeLabel}${item.platform ? ` · ${platformPrefix} ${item.platform}` : ""}`;
  return (
    <RippleTouch
      onPress={onPress}
      disabled={loading}
      // Welle statt React-Zustand „gedrückt" — Begründung an `StopBoardRow`.
      style={[styles.hero, { backgroundColor: palette.s2 }]}
    >
      <View style={styles.heroRing}>
        {/* So groß wie seine Hülle: Die schrumpft auf kurzen Geräten mit
            (`scaledStyles`), der Ring stand fest auf 84 — Zahl und „Min" saßen
            dann in der kleineren Hülle zentriert, also neben der Ringmitte. */}
        <Svg width={RING_BOX} height={RING_BOX} viewBox="0 0 84 84">
          <Circle cx={42} cy={42} r={RING_R} fill="none" stroke={C.border} strokeWidth={6} />
          <Circle
            cx={42}
            cy={42}
            r={RING_R}
            fill="none"
            stroke={accent.solid}
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - frac)}
            // -90deg-Rotation um den Center damit der Ring oben (12 Uhr) startet
            // statt rechts (3 Uhr — SVG-Default).
            transform={`rotate(-90 42 42)`}
          />
        </Svg>
        <View style={styles.heroRingCenter} pointerEvents="none">
          {ringDayLabel ? (
            <Text style={styles.heroRingDay} numberOfLines={1}>
              {ringDayLabel}
            </Text>
          ) : (
            <>
              {/* Drei, vier Ziffern kleiner — sonst stießen sie oben fast an
                  den Ring („280"), während zwei Ziffern rundum Luft haben. */}
              <Text
                style={[
                  styles.heroRingMin,
                  mins >= 1000 ? styles.heroRingMinXs : mins >= 100 ? styles.heroRingMinSm : null,
                ]}
              >
                {mins}
              </Text>
              <Text style={styles.heroRingLabel}>Min</Text>
            </>
          )}
        </View>
      </View>

      <View style={styles.heroBody}>
        <View style={styles.heroBadgeRow}>
          <View style={[styles.cardLineBadge, { backgroundColor: badge, borderColor: badge }]}>
            <ModeIcon size={14} color={BADGE_INK} strokeWidth={2.2} />
            <Text style={[styles.cardLineBadgeText, { color: BADGE_INK }]} numberOfLines={1}>
              {item.line}
            </Text>
          </View>
          <Text style={styles.heroNextLabel}>{nextLabel}</Text>
          {/* Oben rechts, auf der Höhe der Plakette — nicht mittig neben der
              Karte, wo er mit dem Text um Platz stritt. */}
          {onLive && !loading ? (
            <View style={styles.heroLive}>
              <LiveButton onPress={onLive} label={liveLabel ?? ""} clock={liveClock} />
            </View>
          ) : null}
        </View>
        <Text style={styles.heroDest} numberOfLines={1}>
          {item.direction || "—"}
        </Text>
        <Text
          style={[styles.heroSub, delay > 0 ? { color: ACCENT_DELAY } : null]}
          numberOfLines={1}
        >
          {subText}
        </Text>
      </View>

      {loading ? (
        <ActivityIndicator color={C.g1} size="small" style={{ marginLeft: 4 }} />
      ) : null}
    </RippleTouch>
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
  const palette = usePalette();
  const t = useT();
  /** Sprache der App — für den Wochentag an Tafel-Zeilen, die nicht heute fahren. */
  const locale = useSearchStore((s) => s.locale);
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const accent = useAccent();

  const selectedStop = useSearchStore((s) => s.selectedStop);
  const clearSelectedStop = useSearchStore((s) => s.clearSelectedStop);
  /**
   * Die zweite Belegung dieser Fläche: eine angetippte STADT. Sie schließt sich
   * mit der Haltestelle aus (siehe `selectCity` im Store); die Hülle — Bewegung,
   * Rastpunkte, Wisch-Geste — ist dieselbe, nur der Inhalt und die mittlere
   * Höhe unterscheiden sich.
   */
  const selectedCity = useSearchStore((s) => s.selectedCity);
  const clearSelectedCity = useSearchStore((s) => s.clearSelectedCity);
  /** Schließt, was gerade offen ist — Haltestelle oder Stadt. */
  const closeSheet = useCallback(() => {
    clearSelectedStop();
    clearSelectedCity();
  }, [clearSelectedStop, clearSelectedCity]);
  /**
   * Die Zurück-Taste schließt das Blatt — Haltestelle wie Stadt. Keines von
   * beiden hat einen Hintergrund, der Tipps abfängt (siehe unten); ohne sie
   * bliebe nur das Herunterwischen.
   */
  const sheetOpen = selectedStop != null || selectedCity != null;
  useEffect(() => {
    if (!sheetOpen) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSheet();
      return true;
    });
    return () => sub.remove();
  }, [sheetOpen, closeSheet]);
  /**
   * Liegt ein deckendes Blatt darüber (Detail-Blatt, Zeitleiste,
   * Ergebnisliste)? Dann gibt dieses Blatt seine Höhe ab.
   *
   * Android sortiert Geschwister nach `elevation` VOR `zIndex`. Das
   * Detail-Blatt fällt in Ruhe auf Höhe 0 (Schattenpass sparen), die
   * Ergebnisliste hat gar keine — dieses Blatt (20) zeichnete sich dann mit
   * seiner halben Höhe über sie, sobald sie standen. Abgegeben heißt: Die
   * Reihenfolge im Wurzel-Layout gilt, und dort liegen sie alle nach ihm.
   * Umgeschaltet wird, bevor sie hereinfahren — dieses Blatt steht dann still.
   */
  const covered = useSearchStore(
    (s) =>
      s.selectedResult != null ||
      s.legTimelineOverlayOpen ||
      s.directTripResult != null ||
      s.resultsParams != null,
  );
  const savedStations = useSearchStore((s) => s.savedStations);
  const toggleSavedStation = useSearchStore((s) => s.toggleSavedStation);
  const showStationToast = useSearchStore((s) => s.showStationToast);
  const openPendingResult = useSearchStore((s) => s.openPendingResult);
  const settlePendingResult = useSearchStore((s) => s.settlePendingResult);
  const openDirectTrip = useSearchStore((s) => s.openDirectTrip);

  /**
   * Lade-Kreisel in der Zeile — nur noch für den DIREKT-Weg, wo das Blatt
   * sichtbar bleibt, bis die Fahrt da ist. Im Buchungs-Weg deckt das
   * Detail-Blatt die Zeile sofort zu; der Zustand kostete dort nur zwei
   * Durchgänge des ganzen Blattes, der zweite mitten in der Einfahrt.
   */
  const [loadingDepartureId, setLoadingDepartureId] = useState<string | null>(null);
  /** Laufende Nummer des zuletzt angetippten Abfahrts-Eintrags. */
  const departureReqRef = useRef(0);
  /**
   * Sperre gegen Doppel-Tipps auf DIESELBE Zeile — als Ref, nicht als Zustand:
   * `disabled` aus dem Zustand trägt im selben Bild noch den alten Wert, zwei
   * schnelle Tipps kamen beide durch (zwei Suchen, Bahn-Kontingent).
   */
  const tapLockRef = useRef<{ id: string; until: number; stub?: SearchResult } | null>(null);

  // displayStop = der zuletzt sichtbare Stop. Beim Slide-Out hilft das, den
  // Inhalt sichtbar zu halten bis die Animation durch ist.
  const [displayStop, setDisplayStop] = useState<SelectedStop | null>(null);
  /** Wie `displayStop`: hält die Stadt über die Ausfahrt sichtbar. */
  const [displayCity, setDisplayCity] = useState<SelectedCity | null>(null);
  /**
   * Übernommen IM RENDERN, nicht in einem Effekt — das war ein Ruckler.
   *
   * Der Effekt setzte den neuen Inhalt erst nach dem Commit des Tipps: ein
   * zweiter Durchgang durchs ganze Blatt samt zweitem Commit, und der fiel
   * mitten in die Einfahrt, wo sie am schnellsten ist. Ein Commit während
   * einer Fahrt trägt die Lage des Blattes ein, die beim Einhängen schon ein,
   * zwei Bilder alt ist (siehe `startDragHeal` in lib/ui/sheetSwipe.ts) — das
   * Blatt sprang zurück. So wiederholt React nur diese Funktion, bevor es die
   * Kinder rendert: EIN Commit. Gebraucht wird der Wert ohnehin erst beim
   * Schließen; offen zeigt das Blatt `selectedStop` bzw. `selectedCity` selbst.
   */
  if (selectedStop && displayStop !== selectedStop) setDisplayStop(selectedStop);
  if (selectedCity && displayCity !== selectedCity) setDisplayCity(selectedCity);
  useEffect(() => {
    if (selectedCity) return;
    const timer = setTimeout(() => setDisplayCity(null), 420);
    return () => clearTimeout(timer);
  }, [selectedCity]);

  // Beim Schließen lassen wir displayStop die Slide-Out-Dauer (350ms) stehen
  // und geben ihn DANACH frei. Ohne das Freigeben bliebe der komplette
  // Sheet-Inhalt (Header-SVGs, Boards, Save-Stern) für immer im versteckten,
  // TRANSFORMIERTEN Root-Sheet gemountet — Fabric compositet solchen Content
  // bei jeder Overlay-Animation app-weit mit (→ Location-/DatePicker-Lag).
  useEffect(() => {
    if (selectedStop) return;
    const timer = setTimeout(() => setDisplayStop(null), 420);
    return () => clearTimeout(timer);
  }, [selectedStop]);

  // Beim Open: stop = selectedStop (sofort sichtbar, ohne useEffect-Lag).
  // Beim Close: selectedStop wird null, aber displayStop hält den letzten
  // Inhalt für die Slide-Out-Animation → Sheet wirkt nicht „leer" beim Zumachen.
  // Eine offene Stadt verdrängt den Nachhall einer eben geschlossenen
  // Haltestelle und umgekehrt — es steht immer genau ein Inhalt im Blatt.
  const stop = selectedStop ?? (selectedCity ? null : displayStop);
  const city = selectedCity ?? (selectedStop ? null : displayCity);
  /** Was das Blatt gerade trägt — daran hängen Öffnen, Schließen und Höhe. */
  const target = selectedStop ?? selectedCity;
  /**
   * Wechselt der Inhalt bei OFFENEM Blatt (Stadt → Stadt, Haltestelle →
   * Haltestelle, und beides gemischt)? Dann fährt nichts herein — siehe den
   * Effekt darunter. Gemerkt beim Rendern, gelesen im Effekt (dort ist der
   * vorige Stand schon überschrieben).
   *
   * Haltestelle → Haltestelle gehört seit dieser Runde dazu: Das Blatt hat
   * keinen abdeckenden Hintergrund mehr, die Karte dahinter bleibt bedienbar —
   * und damit tippt man bei offenem Blatt die nächste Haltestelle an. Vorher
   * fing der Hintergrund diesen Tipp ab und schloss nur.
   */
  const prevTargetRef = useRef<SelectedStop | SelectedCity | null>(null);
  const cityToCityRef = useRef(false);
  /** Öffnet das Blatt in diesem Durchgang (vorher war nichts drin)? — für den Riegel unten. */
  let openingNow = false;
  if (target !== prevTargetRef.current) {
    const prev = prevTargetRef.current;
    cityToCityRef.current = prev != null && target != null;
    prevTargetRef.current = target;
    openingNow = prev == null && target != null;
  }
  const kinds: MarkerKind[] =
    stop?.kinds && stop.kinds.length > 0 ? (stop.kinds as MarkerKind[]) : ["bus"];
  /** Flughafen: Die Tafel sind Flüge — eigene Live-Ansicht, keine Filter-Kästen. */
  const isAirport = kinds[0] === "airport";
  /**
   * Ankünfte erst laden, wenn man sie einmal ansieht. Beide Tafeln stehen
   * nebeneinander (`SlidingPanels`), aber eine zweite Anfrage für jeden
   * geöffneten Halt wäre Last ohne Nutzen — bis dahin zeigt die Ankunftsseite
   * den Ladekreis, und die Anfrage startet mit dem Tipp auf den Reiter.
   *
   * Angefragt wird mit dem Tipp (`requestArrivals`), GEZEIGT erst, wenn die
   * Tafel drüben angekommen ist (`onBoardSettled`) — siehe `BoardSwitch`.
   * Gemerkt mit dem Code des Halts: Ein neuer Halt beginnt im selben Durchgang
   * ohne, nicht erst nach einem Effekt.
   */
  const [arrivalsFor, setArrivalsFor] = useState<string | null>(null);
  const arrivalsWanted = !!stop && arrivalsFor === stop.code;
  /**
   * Ausgeblendete Verkehrsarten (Filter-Kästen) — für beide Tafeln, je Halt.
   * Ebenfalls mit dem Code: Sonst stünde der Zurück-Pfeil des vorigen Halts
   * ein Bild lang im Kopf des neuen.
   */
  const [hidden, setHidden] = useState<{ code: string | null; cats: ReadonlySet<BoardCategory> }>({
    code: null,
    cats: NO_CATS,
  });
  const hiddenCats = stop && hidden.code === stop.code ? hidden.cats : NO_CATS;

  // bodyReady: erst NACH der Slide-In-Animation auf true → vermeidet visuelles
  // Ruckeln wenn die Departures-Liste mitten in der Slide-Animation reinpoppt.
  // Header (Name + Distanz) bleibt immer sichtbar, weil dort kein Layout-Shift
  // passieren kann.
  const [bodyReady, setBodyReady] = useState(false);
  // Geöffnet, während die vorige Ausfahrt noch lief: Der Riegel fällt erst,
  // wenn das Blatt draußen ist (siehe Schließen unten) — hier also gleich,
  // sonst baute dieser Durchgang die Tafeln des neuen Halts auf und der Effekt
  // sie im selben Bild wieder ab.
  if (openingNow && bodyReady) setBodyReady(false);

  // Tap auf einen Departure-Eintrag → DetailsOverlay slidet SOFORT von rechts
  // rein mit einem Stub-Result (Origin/Destination/Zeit/Linie aus dem Departure).
  // Im Hintergrund läuft die echte Search-API — sobald die Antwort da ist,
  // ersetzen wir das Stub-Result mit dem Match. Während der Wait-Zeit zeigt
  // DetailsOverlay Skeleton-Cards in der Provider-Sektion (siehe
  // `selectedResultPending`-Flag im Store).
  //
  // GRUNDSATZ: Eine Abfahrt, die auf der Tafel steht, endet nie als
  // „versteckt". Findet die Buchungssuche sie nicht oder scheitert sie, zeigt
  // der Rückfall die Fahrt selbst — Direkt-Weg, alle Halte, ohne Preis und ohne
  // Buchung. Belegt (Server-DB, 30 Tage): 7 von 51 Tipp-Suchen enthielten den
  // getippten Zug nicht, jedes Mal ein VERSPÄTETER Zug nach seiner Planzeit
  // (Werl, RB 59 16:46 +5, getippt 16:50). Der Server sortiert nach Planzeit
  // aus (`dropDeparted`), die Tafel zeigt den Zug bis zur echten Abfahrt.

  /**
   * Die Fahrt selbst, ab diesem Halt bis zur Endstation — Direkt-Weg und
   * Rückfall des Buchungs-Wegs. DE-Tafeln liefern MOTIS-Kennungen, die der
   * Server ohne Bahn-Kontingent auflöst (routes/trips.ts, `fetchTripBody`).
   * Zeilen der Ankunftstafel: die Fahrt von ihrer Herkunft BIS hierher.
   */
  const loadTrip = (item: StopBoardItem, at: SelectedStop, board: BoardTab) =>
    fetchTripDetail(item.id, {
      // hafasId aus der Board-Antwort: damit der Server den Trip auf den
      // User-Halt slicen kann (volle Linie A→Z vs. User steigt erst in der
      // Mitte ein → wir wollen User-Halt → Endstation anzeigen).
      fromStopId: data?.stop.hafasId ?? undefined,
      // Label als Fallback, falls die ID nicht in den Trip-Stopovers
      // matched (BVG/VBB-Bus-Stops haben oft uneindeutige IDs zwischen
      // unserem Resolver und HAFAS-Trip-Body).
      fromStopLabel: at.label,
      // stopCode mitschicken — daraus leitet der Server das HAFAS-Profile ab
      // (DE → dbrest, AT/PL/LU/DK → in-process hafas-client). Ohne den würde
      // ein österreichischer Trip durch das DB-Profile geleitet und 404 liefern.
      stopCode: at.code,
      // Board-Direction mitgeben damit das Trip-Detail dieselbe
      // Destination zeigt wie die Card die der User getappt hat.
      // HAFAS' trip.direction weicht manchmal vom Board-Direction
      // ab (M21 Berlin: Board zeigt „Charlottenburg, Goerdelersteg",
      // trip.direction ist „S+U Jungfernheide").
      direction: item.direction,
      // Auf der Ankunftstafel ist `direction` die HERKUNFT des Zugs.
      board,
      // Die Zeit der Zeile — bei Fahrten aus den Länder-Fahrplänen (GTFS)
      // bestimmt sie den Betriebstag (Nachtfahrt heute oder gestern).
      atTime: item.plannedTime,
    }).then(tripDetailToSearchResult);

  /**
   * Die Fahrt ließ sich nicht laden — ein LADEFEHLER, keine Aussage über die
   * Verbindung. Hier stand „Diese Verbindung versteckt sich", auch bei 404,
   * 429 oder Zeitlimit für eine Abfahrt, die sichtbar auf der Tafel steht.
   */
  const showTripLoadError = (mode: TravelMode) =>
    showConnectionNotFound({
      mode,
      title: t("connectionNotFound.loadError.title"),
      message: t("connectionNotFound.loadError.body"),
    });

  /**
   * LIVE VERFOLGEN — der Knopf an der Zeile. Nur, wo es etwas zu sehen gibt:
   * Die Fahrt kommt in den nächsten anderthalb Stunden oder ist gerade
   * vorbei (dann fährt sie noch weiter), sie fällt nicht aus, und ein Flug
   * hat beide Flughäfen und eine Abflugzeit (daraus wird gerechnet).
   */
  /** Ein Takt für alle Live-Knöpfe der Tafel — läuft nur bei offenem, nicht eingeklapptem Blatt. */
  const liveClock = useLiveClock(selectedStop != null, stopSheetCollapsed);
  const canLive = (it: StopBoardItem): boolean => {
    if (it.cancelled) return false;
    const at = Date.parse(it.plannedTime) + (it.delayMinutes ?? 0) * 60_000;
    const now = Date.now();
    if (!(at > now - LIVE_PAST_MS && at < now + LIVE_AHEAD_MS)) return false;
    if (isAirport) {
      const f = it.flight;
      return !!f && (f.depE ?? f.depP) != null && !!airportByIata(f.from) && !!airportByIata(f.to);
    }
    return !!it.id;
  };
  const startLiveFor = (it: StopBoardItem, board: BoardTab) => {
    probeMark("start-tap");
    probeFrames("start", 4000);
    if (!stop) return;
    haptic("button");
    // Auf der Ankunftstafel ist `direction` die HERKUNFT — dann lieber das
    // Fahrtziel aus den Live-Daten (leer lassen, das Banner nimmt es von dort).
    const direction = board === "departures" ? it.direction : "";
    const iata = stop.code.replace(/^airport:/i, "").toUpperCase();
    const session: LiveSession =
      isAirport && it.flight
        ? {
            kind: "flight",
            flight: it.flight,
            line: it.line,
            direction,
            boardIndex: it.flight.from === iata ? 0 : it.flight.to === iata ? 1 : null,
          }
        : {
            kind: "trip",
            tripId: it.id,
            stopCode: stop.code,
            atTime: it.plannedTime,
            line: it.line,
            product: it.product,
            direction,
            tz: boardTz,
          };
    const st = useSearchStore.getState();
    // Tafel über Bo geöffnet: Bo schließen — die Karte gehört jetzt dem Fahrzeug.
    if (st.assistantOpen) st.closeAssistant();
    st.startLive(session);
    // Auf die Karte — ist sie schon vorn, bleibt alles, wie es ist. Bewusst
    // kein `usePathname`: Dieses Blatt ist global und würde sonst bei jedem
    // Seitenwechsel neu rendern.
    router.navigate("/(tabs)/surroundings");
  };

  /** `board`: die Tafel, von der die Zeile stammt — beide stehen nebeneinander. */
  const onSelectDeparture = (item: StopBoardItem, board: BoardTab) => {
    if (!stop) return;
    const mode = productToSearchMode(item.product);
    if (!mode) return; // Ferry o.ä. → keine Ticket-Suche verfügbar
    const directionText = item.direction?.trim();
    if (!directionText) return;
    const lock = tapLockRef.current;
    if (
      lock &&
      lock.id === item.id &&
      Date.now() < lock.until &&
      // Im Buchungs-Weg nur, solange der eigene Platzhalter noch offen ist —
      // wer sofort zurückging, darf dieselbe Zeile gleich wieder antippen.
      (!lock.stub || useSearchStore.getState().selectedResult === lock.stub)
    ) {
      return;
    }
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
    // Trip-Detail-Flow statt Booking-Flow für:
    //   - BUS (alle Stadtbusse — ÖPNV ohne Online-Buchung)
    //   - U-Bahn/S-Bahn/Tram (gleiche Logik — Verbund-Tarif)
    //   - Nicht-DE Stops (unsere Booking-Suche kann die nicht handhaben)
    // Übrig bleibt: DE National/Regional Trains → Booking-Flow mit
    // DB-Navigator-Deeplink-Support.
    const useDirectTripFlow =
      // ANKUNFT: Die Richtung der Zeile ist die HERKUNFT des Zugs. Der
      // Buchungs-Weg suchte damit eine Fahrt von hier ZUR Herkunft — die
      // Gegenrichtung, und meist ein ganz anderer Zug, der zufällig um diese
      // Zeit abfuhr. Ankünfte zeigen deshalb immer die Fahrt selbst.
      board === "arrivals" ||
      mode === "BUS" ||
      isLocalTransitProduct(item.product) ||
      !isDeStop(stop.code);
    /**
     * EINE laufende Nummer für beide Wege, vergeben im Handler — nicht erst
     * nach einem `await`. Die Gegenproben danach lesen den Ref, nie die
     * Closure (siehe feedback_await_guard_stale_closure).
     */
    const req = ++departureReqRef.current;
    if (useDirectTripFlow) {
      tapLockRef.current = { id: item.id, until: Date.now() + DIRECT_TAP_LOCK_MS };
      setLoadingDepartureId(item.id);
      /**
       * Gehört die Antwort noch zu dem, was man sieht? Zwei Busabfahrten schnell
       * nacheinander: ohne Nummer gewann die LANGSAMERE Antwort. Und nach dem
       * Schließen der Haltestelle (oder dem Wechsel zu einer anderen) ging die
       * Zeitleiste sonst trotzdem noch auf.
       */
      const directStop = stop.code;
      const stillCurrent = () =>
        req === departureReqRef.current &&
        useSearchStore.getState().selectedStop?.code === directStop;
      void (async () => {
        try {
          const trip = await loadTrip(item, stop, board);
          if (!stillCurrent()) return;
          openDirectTrip(trip);
        } catch {
          if (!stillCurrent()) return;
          // Mode mitschicken (BUS in diesem Branch) damit „Zur Suche" direkt
          // den Bus-Tab öffnet, nicht irgendeine Suche.
          showTripLoadError(mode);
        } finally {
          if (req === departureReqRef.current) {
            setLoadingDepartureId(null);
            tapLockRef.current = null;
          }
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
      // Zone der Tafel: Ohne sie stand die Abfahrt im Detail-Blatt bis zum
      // Eintreffen des Treffers in der Zeit des GERÄTS — in der Zeile darunter
      // aber in Ortszeit (auf einem Gerät außerhalb der Halt-Zone „14:33" statt „15:33").
      originTz: data?.stop?.tz,
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
    // wieder in der Departures-Liste landet. EIN Schreibvorgang statt zwei,
    // kein Lade-Zustand in diesem Blatt (die Zeile ist gleich zugedeckt).
    const tapAt = Date.now();
    tapLockRef.current = { id: item.id, until: tapAt + PUSH_SPRING.duration, stub };
    /**
     * Einen noch laufenden Direkt-Weg (Bus/Tram eben angetippt) hat dieser Tipp
     * überholt (`req`). Dessen `finally` räumt den Kreisel nur als NEUESTER
     * ab — ohne diese Zeile drehte seine Zeile weiter und blieb gesperrt
     * (`disabled`), bis irgendwann ein anderer Direkt-Weg fertig wurde. Steht
     * kein Kreisel, ist das derselbe Wert und rendert nichts.
     */
    setLoadingDepartureId(null);
    openPendingResult(stub);
    /**
     * Zeigt das Detail-Blatt noch GENAU diesen Platzhalter, und ist dieser Tipp
     * der neueste? Identität statt Kennung — `pending:${item.id}` ist bei
     * einem erneuten Tipp auf dieselbe Abfahrt gleich. Wer das Blatt
     * geschlossen hat, bekommt es nicht Sekunden später wieder aufgemacht.
     */
    const shown = () =>
      req === departureReqRef.current && useSearchStore.getState().selectedResult === stub;

    // Background-Search — fire-and-forget, kein await blockiert den Slide.
    void (async () => {
      let match: SearchResult | undefined;
      try {
        const res = await searchByMode({
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
        });
        /**
         * KEIN `nocache` mehr.
         *
         * Begründet war er damit, dass der Server-Cache die Uhrzeit nicht
         * kenne. Das gilt nicht mehr: `cacheKey` und `loadFromCache`
         * (server/src/services/searchService.ts) tragen `departTime`. Dafür
         * hing jeder Tipp am engen nocache-Budget des Servers (6 pro Minute
         * und IP, routes/search.ts): Ab dem siebten Tipp kam binnen
         * Millisekunden 429, und das Blatt schloss sich mitten in seiner
         * Einfahrt — 39-mal an zwei Testabenden in den Logs. Ein erneuter Tipp
         * auf dieselbe Abfahrt kommt jetzt aus dem Zwischenspeicher: sofort
         * und ohne Bahn-Kontingent.
         */
        match = findBestMatch(res.results, item);
      } catch {
        // Netz, Zeitlimit, 429: kein Grund mehr, das Blatt zu schließen — der
        // Rückfall unten zeigt die Fahrt trotzdem.
      }
      // Kein Treffer: die Fahrt selbst holen, parallel zum Rest der Einfahrt.
      const tripPromise = match || !shown() ? null : loadTrip(item, stop, board).catch(() => null);
      await afterDetailsPush(tapAt);
      if (!shown()) return;
      if (match) {
        // Stub durch echtes Result ersetzen — DetailsOverlay re-rendert mit
        // den korrekten Daten + dem bookingToken (für Multi-Provider-Liste).
        //
        // Ohne Abfahrts-Verspätung (db-vendo liefert keine, und ein Treffer
        // aus dem Zwischenspeicher trägt nie eine) gilt die der Tafel: Es ist
        // dieselbe Fahrt, und genau diese Zahl hat der Nutzer eben angetippt.
        const boardDelay = item.delayMinutes ?? 0;
        settlePendingResult(stub, {
          result:
            match.departDelayMinutes == null && boardDelay > 0
              ? { ...match, departDelayMinutes: boardDelay }
              : match,
        });
        return;
      }
      const trip = tripPromise ? await tripPromise : null;
      if (!shown()) return;
      if (trip) {
        // Kein Buchungstreffer: Das Detail-Blatt fährt hinaus, die Zeitleiste
        // derselben Fahrt herein — wie bei Bus und Tram. Kein Preis, keine
        // Buchung; das Stop-Sheet bleibt darunter offen.
        //
        // Anders als bei Bus und Tram hat der Nutzer hier aber ein TICKET
        // erwartet (Zug, Buchungs-Weg). Ohne Satz dazu wirkt die Zeitleiste
        // wie ein Fehler — `timelineNotice` sagt, warum er sie sieht. Nur in
        // diesem Rückfall; der Direkt-Weg (`openDirectTrip`) setzt ihn nie.
        settlePendingResult(stub, { directTrip: { ...trip, timelineNotice: "noTicketOffer" } });
        return;
      }
      // Weder Treffer noch Fahrt: den Platzhalter nicht stehen lassen (er
      // zeigt „16:15→16:15") — schließen und ehrlich sagen, was los ist.
      if (settlePendingResult(stub, null)) showTripLoadError(mode);
    })();
  };

  // Fetch erst sobald die Slide-Animation durch ist UND ein Stop aktiv ist.
  // Vorher würde das Result die Layout-Shift mitten in der Animation
  // verursachen. Ankünfte zusätzlich erst auf Wunsch (`arrivalsWanted`).
  const boardEnabled = !!selectedStop && !!stop && bodyReady;
  const depQuery = useQuery<StopBoardResponse>({
    queryKey: ["stopBoard", stop?.code ?? "_none_", "departures"],
    queryFn: () => fetchStopDepartures(stop!.code),
    enabled: boardEnabled,
    staleTime: 45 * 1000,
    refetchOnMount: "always",
    retry: 1,
  });
  const arrQuery = useQuery<StopBoardResponse>({
    queryKey: ["stopBoard", stop?.code ?? "_none_", "arrivals"],
    queryFn: () => fetchStopArrivals(stop!.code),
    enabled: boardEnabled && arrivalsWanted,
    staleTime: 45 * 1000,
    refetchOnMount: "always",
    retry: 1,
    // Bis sie gezeigt werden, weckt die Anfrage das Blatt nicht — siehe
    // `requestArrivals`.
    notifyOnChangeProps: arrivalsWanted ? undefined : [],
  });
  const queryClient = useQueryClient();
  /**
   * Der Tipp auf „Ankünfte": die Tafel schon anfragen, aber noch nicht zeigen.
   *
   * Vorher schaltete der Tipp die Abfrage direkt ein — ihr Start und eine
   * schnelle Antwort legten je einen Durchgang durchs ganze Blatt mitten in
   * die Fahrt, und die Liste baute sich darin auf. Das war das Ruckeln beim
   * ERSTEN Wechsel. Jetzt läuft die Anfrage still (`notifyOnChangeProps`),
   * und gezeigt wird ab der Ankunft (`onBoardSettled`) — mit Daten, wenn sie
   * schon da sind, sonst mit dem Ladekreis bis dahin.
   */
  const requestArrivals = useCallback(() => {
    if (!stop || !boardEnabled || arrivalsWanted) return;
    const code = stop.code;
    void queryClient.prefetchQuery({
      queryKey: ["stopBoard", code, "arrivals"],
      queryFn: () => fetchStopArrivals(code),
      staleTime: 45 * 1000,
      retry: 1,
    });
  }, [stop, boardEnabled, arrivalsWanted, queryClient]);
  /** Die Tafel steht — erst jetzt die Ankünfte zeigen. */
  const onBoardSettled = useCallback(
    (index: number) => {
      if (index === 1 && stop) setArrivalsFor(stop.code);
    },
    [stop],
  );
  /** Angaben zum HALT (Zone, Zusatz, HAFAS-Kennung) — gleich auf beiden Tafeln. */
  const data = depQuery.data ?? arrQuery.data;

  /**
   * Ortszeit-Zone des Halts — kommt mit der Tafel (Server, aus der Lage). Alle
   * Uhrzeiten des Blatts stehen in ihr, wie in der Zeitleiste dahinter; der
   * Hinweis „Ortszeit (UTC+1)" erscheint nur, wenn sie von der Uhr des Geräts
   * abweicht. Der Countdown-Ring zählt Minuten und braucht keine Zone.
   */
  const boardTz = data?.stop?.tz;
  const zoneHint = useMemo(() => (boardTz ? localTimeHint([boardTz], t) : null), [boardTz, t]);
  /** Steig bzw. Gleis eines einzelnen Steigs und der Zusatz bei gleichnamigem Nachbarn — vom Marker bzw. aus der Suche, sonst aus der Tafel. */
  const stopPlatform = stop?.platform ?? data?.stop?.platform;
  const stopExtra = stop?.detail ?? data?.stop?.detail;

  /**
   * Die laufende MINUTE — nur für das Aussortieren abgefahrener Züge.
   *
   * Eine Tafel kommt bis zu einer Viertelstunde aus dem Zwischenspeicher des
   * Servers, und bleibt man am Blatt, altert sie weiter. Sie zeigte damit
   * Abfahrten, die längst weg waren. Einmal pro Minute statt pro Sekunde (den
   * Sekundentakt hat nur die oberste Zeile), und wie dort nicht in eine Fahrt,
   * ein Ziehen oder eine Kartenbewegung hinein — dann eine Sekunde später.
   */
  /**
   * Die Uhr der Tafel — sie schlägt zur nächsten ABFAHRT, nicht zur vollen
   * Minute. Vorher stand der große Kasten bis zu einer Minute auf „0 Min" und
   * verschwand dann schlagartig; jetzt geht er in dem Moment, in dem die Zahl 0
   * erreicht, und die anderen rücken nach (siehe `renderBoard`).
   */
  const [boardNow, setBoardNow] = useState(() => Date.now());
  /** Die Tafeln für die Uhr — gelesen erst im Wecker, darum als Ablage. */
  const boardsRef = useRef<(StopBoardResponse | undefined)[]>([]);
  useEffect(() => {
    if (!selectedStop) return;
    let id: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => {
      id = setTimeout(() => {
        if (isTransitionBusy() || isSheetDragging() || isMapMoving()) {
          schedule(1_000);
          return;
        }
        setBoardNow(Date.now());
        schedule(msToNextDeparture(boardsRef.current, Date.now()));
      }, ms);
    };
    // Beim Öffnen nachziehen (das Blatt stand womöglich lange zu) — aber erst
    // NACH der Einfahrt: Ein Durchgang mitten in ihr ist genau das Zucken, das
    // wir überall vermeiden. Die Tafel selbst kommt ohnehin erst danach.
    schedule(SHEET_IN.duration + 50);
    return () => clearTimeout(id);
    // Neue Daten: neu stellen — eine Verspätung verschiebt die nächste Abfahrt.
  }, [selectedStop, depQuery.data, arrQuery.data]);

  /**
   * Nur was noch kommt: Abfahrten (bzw. Ankünfte) ab der laufenden Minute,
   * mit Verspätung gerechnet. Ein Zug um 14:26 steht bis 14:26:59 da — als
   * „jetzt" —, danach ist er weg. Vergangene braucht niemand.
   */
  boardsRef.current = [depQuery.data, arrQuery.data];
  const depAll = useMemo(() => upcomingOf(depQuery.data, boardNow), [depQuery.data, boardNow]);
  const arrAll = useMemo(() => upcomingOf(arrQuery.data, boardNow), [arrQuery.data, boardNow]);

  /**
   * Geht einer offenen Tafel der Vorrat aus (weniger als fünf kommende), still
   * nachladen. Bisher lud sie nur beim Öffnen — wer am Blatt blieb, sah die
   * Abfahrten eine nach der anderen verschwinden, bis die Tafel leer war. Die
   * Antwort kommt erst in einer ruhigen Lage in die Tafel (keine Fahrt, kein
   * Ziehen, Karte steht): Ein Durchgang mitten in einer Bewegung ist genau das
   * Zucken, das wir überall vermeiden. Der Minutentakt oben wartet schon auf so
   * eine Lage, darum hängt das hier an ihm.
   */
  const refilling = useRef<string | null>(null);
  useEffect(() => {
    if (!stop || !boardEnabled) return;
    const code = stop.code;
    const boards = [
      { kind: "departures" as const, query: depQuery, left: depAll.length, load: fetchStopDepartures },
      ...(arrivalsWanted ? [{ kind: "arrivals" as const, query: arrQuery, left: arrAll.length, load: fetchStopArrivals }] : []),
    ];
    for (const b of boards) {
      const had = b.query.data?.results.length ?? 0;
      const key = `${code}|${b.kind}`;
      if (had === 0 || b.left >= Math.min(5, had) || Date.now() - b.query.dataUpdatedAt < 60_000) continue;
      if (refilling.current === key) continue;
      refilling.current = key;
      b.load(code)
        .then((fresh) => {
          const apply = () => {
            if (isTransitionBusy() || isSheetDragging() || isMapMoving()) {
              setTimeout(apply, 250);
              return;
            }
            queryClient.setQueryData(["stopBoard", code, b.kind], fresh);
          };
          apply();
        })
        .catch(() => {})
        .finally(() => {
          if (refilling.current === key) refilling.current = null;
        });
    }
    // Nur der Minutentakt löst das aus — nicht jede neue Tafel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardNow]);
  /** Die Filter-Kästen: was an diesem Halt fährt (beide Tafeln, sobald geladen). */
  const categories = useMemo(
    () => (isAirport ? [] : categoriesOf(depQuery.data, arrQuery.data)),
    [isAirport, depQuery.data, arrQuery.data],
  );
  const depItems = useMemo(() => withoutHidden(depAll, hiddenCats), [depAll, hiddenCats]);
  const arrItems = useMemo(() => withoutHidden(arrAll, hiddenCats), [arrAll, hiddenCats]);
  /** Der Filter gehört mit zur Lieferung: Umschalten baut die Tafel neu auf, statt Abfahrten fliegen zu lassen. */
  const filterKey = useMemo(() => [...hiddenCats].sort().join(","), [hiddenCats]);
  /**
   * Eine Art aus- bzw. wieder einblenden. Die letzte sichtbare bleibt: Ganz
   * ohne Arten stünde nur eine leere Tafel da.
   */
  const stopCode = stop?.code ?? null;
  const toggleCategory = useCallback(
    (c: BoardCategory) => {
      if (!stopCode) return;
      setHidden((prev) => {
        const next = new Set(prev.code === stopCode ? prev.cats : NO_CATS);
        if (next.has(c)) next.delete(c);
        else if (categories.filter((x) => !next.has(x)).length > 1) next.add(c);
        else return prev;
        return { code: stopCode, cats: next };
      });
      haptic("button");
    },
    [categories, stopCode],
  );
  const showAllCategories = useCallback(() => {
    haptic("button");
    setHidden({ code: null, cats: NO_CATS });
  }, []);

  // Snap-Punkte (gleich wie SurroundingsSheet): full (oben), mid (halb),
  // sheetHeight = komplett off-screen unten.
  //
  // Gerechnet an EINER Stelle (`stopSheetSnap`) — die Karte braucht die Höhe
  // des Stadt-Blatts auch, um die Route darüber einzurücken. Für die
  // Haltestelle sind es dieselben Werte wie bisher.
  const baseSnap = useMemo(
    () => stopSheetSnap(screenHeight, insets.top, insets.bottom),
    [screenHeight, insets.top, insets.bottom],
  );
  /**
   * Haltestelle und Stadt: EXAKT dieselben Rastpunkte — dieselbe Fläche soll
   * mit beiden Inhalten gleich groß sein.
   */
  const snap = baseSnap;

  // Start: off-screen unten. Beim Selectstop animieren wir zu mid.
  //
  // Der Wert liegt auf Modulebene (`stopSheetY`), weil der Standort-Knopf im
  // Karten-Tab ihm folgt. Die Ruhestellung wird hier einmal gesetzt — das
  // Blatt hängt dauerhaft am Wurzel-Layout und ist beim Anlegen geschlossen.
  const translateY = stopSheetY;
  useLayoutEffect(() => {
    translateY.value = snap.sheetHeight;
    // Nur beim Anlegen — danach gehört der Wert den Bewegungen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * Zeigt dem Effekt unten an, dass die Ausfahrt schon läuft.
   *
   * Sie gehört der Wisch-Geste, sobald man das Blatt hinunterzieht: Die stößt
   * sie im Bild des Loslassens an, auf dem UI-Strang. Ginge sie stattdessen wie
   * bisher über den Store und den Effekt, lägen ein Sprung auf den JS-Strang
   * und ein React-Durchgang dazwischen — das Blatt bliebe genau dann stehen,
   * wenn der Finger das Glas verlässt.
   */
  const settlingRef = useRef(false);
  /**
   * Auf GANZE Gerätepixel gerundet — das Zittern beim Ziehen.
   *
   * Das Blatt folgt dem Finger in Bruchteilen eines Pixels. Android setzt
   * Schrift senkrecht aber immer auf ganze Pixel, Flächen und Ränder dagegen
   * geglättet dazwischen: Bei jedem Bild sprang die Schrift um ein Pixel gegen
   * ihre Pille, ihre Zeile, ihre Trennlinie. Gemeldet als „die Elemente in der
   * Slide zittern". Gerundet bewegt sich alles gemeinsam; ein Pixel sind bei
   * dieser Dichte rund ein Drittel Punkt — die Bewegung bleibt so weich wie
   * vorher.
   */
  // Plus Selbstkorrektur beim Ziehen — siehe `startDragHeal` in lib/ui/sheetSwipe.ts.
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(translateY.value) + dragHealOffset(stopSheetHeal) }],
  }));
  /**
   * Die Liste scrollt NUR, wenn das Blatt ganz oben steht.
   *
   * Damit verschwindet der Wettstreit, der beim Ziehen sichtbar wurde: Der
   * native Scroller bekommt dieselbe Berührung ab wie die Zieh-Geste und
   * versuchte mitzuscrollen, während das Blatt wanderte — korrigiert wurde das
   * bisher nachträglich, also in jedem Bild gegen ihn an. Abgeschaltet gibt es
   * nichts mehr zu korrigieren.
   *
   * Es ändert NICHTS am Verhalten, und das ist der Punkt: Schon vorher konnte
   * man die Liste unterhalb des oberen Rastpunkts nicht scrollen — jede Geste
   * dort bewegt das Blatt (siehe `onUpdate`: der Zweig, der die Liste gewinnen
   * lässt, verlangt einen Scroll-Stand über null, und den gibt es dort nie).
   * Die Regel stand also längst in der Logik; sie wird hier nur ausgesprochen,
   * wo der Scroller sie auch hört.
   *
   * Als ANIMIERTE Eigenschaft, nicht als Zustand: Ein Zustand wäre ein
   * React-Durchgang mitten in der Bewegung — genau das, was hier abgestellt
   * werden soll. So läuft es auf dem UI-Strang und rendert nichts.
   *
   * Die halbe Punkt Toleranz fängt Rundung ab; die Einrast-Bewegung landet
   * exakt auf `snap.full`, die Liste ist danach also verlässlich wieder frei.
   */
  /**
   * STADT-BLATT: Die Liste scrollt schon in der MITTE.
   *
   * Gemeldet als „man kann die Ergebnisse nicht scrollen". Die Regel oben
   * stammt von der Abfahrtsliste, die in der Mitte fast ganz zu sehen ist. Die
   * Verbindungen einer Stadt sind länger, und in der Mitte stehen davon zwei bis
   * drei — wer weiter will, soll scrollen, nicht erst das Blatt aufziehen.
   * Aufziehen geht über Kopf und Pillen; nach unten schließt die Liste, sobald
   * sie oben steht (siehe `onUpdate` der Geste).
   *
   * Als geteilter Wert, weil die Geste auf dem UI-Strang läuft.
   */
  const cityMode = useSharedValue(false);
  useEffect(() => {
    cityMode.value = city != null;
  }, [city, cityMode]);
  /**
   * Gehört die laufende Geste dem BLATT? Dann darf die Liste nicht scrollen —
   * sie bekommt dieselbe Berührung ab und liefe sonst gegen das Blatt an.
   * Gesetzt einmal zu Beginn der Geste (siehe `onStart`).
   */
  const sheetOwnsGesture = useSharedValue(false);
  /** Gehört die laufende Geste der LISTE (Stadt-Blatt)? Dann bleibt das Blatt stehen. */
  const listOwnsGesture = useSharedValue(false);
  /**
   * Schließt das Blatt gerade — per Zurück-Taste, durch den Wisch oder weil die
   * Auswahl von woanders geleert wurde? Dann hält sich die Geste heraus.
   *
   * Wer das Blatt festhielt, während es von woanders geschlossen wurde, bekam
   * im nächsten Bild die Lage des Fingers zurückgeschrieben: Die Ausfahrt brach
   * ab, ihr Abschluss räumte den Inhalt nie ab, und beim Loslassen rastete ein
   * logisch geschlossenes Blatt mit dem alten Inhalt wieder ein. Gesetzt VOR
   * der Ausfahrt (siehe den Effekt unten) — beide Schreibvorgänge kommen in
   * dieser Reihenfolge auf dem UI-Strang an.
   */
  const closing = useSharedValue(false);
  /** Hat DIESE Geste das Blatt übernommen (angesprungen, als es nicht schloss)? */
  const grabbed = useSharedValue(false);
  const listProps = useAnimatedProps(() => ({
    // Stadt: frei, außer das Blatt fährt gerade — dann liefe sie dagegen an.
    scrollEnabled: cityMode.value
      ? !sheetOwnsGesture.value && translateY.value <= snap.mid + 0.5
      : translateY.value <= snap.full + 0.5,
  }));
  /** Dasselbe für die Ankunftsliste — je Liste eine eigene Bindung. */
  const arrListProps = useAnimatedProps(() => ({
    scrollEnabled: translateY.value <= snap.full + 0.5,
  }));

  /**
   * DIE UNTERE STUFE — eingeklappt (Nutzer 05.11.2026): Herunterwischen legt
   * das Blatt unten ab, zu sehen bleiben Name, Art, Filter-Kästen und Reiter;
   * weiter hinunter ist es weg. Wie Googles Orts-Blatt.
   *
   * Wie tief, hängt am Kopf, und der wird GEMESSEN (Unterkante der Reiter bzw.
   * der Trennlinie im Stadt-Blatt) statt geschätzt: Filter-Kästen, eine
   * zweizeilige Unterzeile und der Ortszeit-Hinweis ändern seine Höhe.
   * Darunter GROUP_GAP Luft und die sichere Fläche. 0 = noch nicht vermessen —
   * dann gibt es die Stufe nicht, und Herunterwischen schließt wie bisher.
   *
   * Als geteilter Wert, weil die Geste auf dem UI-Strang rechnet.
   */
  const peekY = useSharedValue(0);
  const peekGap = ms(GROUP_GAP);
  const peekFadeLen = ms(PEEK_FADE);
  const onHeadLayout = useCallback(
    (headBottom: number) => {
      const next = snap.sheetHeight - (headBottom + peekGap + insets.bottom);
      const prev = peekY.value;
      if (Math.abs(next - prev) < 0.5) return;
      peekY.value = next;
      // Liegt das Blatt gerade eingeklappt da, folgt es dem neuen Kopf (etwa
      // wenn die Filter-Kästen nachkommen) — sonst schnitte es ihn ab.
      //
      // NIE, während es schließt: Die Ausfahrt startet an genau dieser Stelle,
      // und ihr erstes Bild bewegt kaum. Ein Kopf, der sich im selben Moment
      // neu vermisst (der Inhalt wechselt beim Schließen), hätte sie sonst
      // abgebrochen und das Blatt zurück auf die Stufe geholt.
      if (prev > 0 && !closing.value && Math.abs(translateY.value - prev) < 1) {
        translateY.value = withTiming(next, { duration: 180, easing: Easing.out(Easing.quad) });
        settleStopSheet(180);
        reportStopSheetTarget(next);
      }
    },
    [snap.sheetHeight, peekGap, insets.bottom, peekY, translateY, closing],
  );
  /**
   * Eingeklappt ist die Liste UNSICHTBAR: Sonst stünde über der
   * Navigationsleiste ein angeschnittener Streifen der ersten Zeile. Beim
   * Aufziehen blendet sie über die ersten 48 Punkte ein. Nur Deckkraft, auf dem
   * UI-Strang.
   */
  const peekFade = useAnimatedStyle(() => {
    const p = peekY.value;
    if (p <= 0) return { opacity: 1 };
    const o = (p - translateY.value) / peekFadeLen;
    return { opacity: o <= 0 ? 0 : o >= 1 ? 1 : o };
  });
  /**
   * „Eingeklappt" für alle, die dann aussetzen sollen (`stopSheetCollapsed`):
   * ab der eingeklappten Stufe abwärts, solange das Blatt nicht ganz zu ist.
   * Nur ein geteilter Wert — kein React-Durchgang beim Ein- und Ausklappen.
   */
  const closedAt = snap.sheetHeight;
  useAnimatedReaction(
    () => {
      const p = peekY.value;
      const y = translateY.value;
      return p > 0 && y >= p - 1 && y < closedAt - 1;
    },
    (now, prev) => {
      if (now !== prev) stopSheetCollapsed.value = now;
    },
    [closedAt],
  );
  /**
   * Ein Reiter, eingeklappt angetippt: Das Blatt geht auf die Mitte — sonst
   * wechselte die Tafel unsichtbar unter dem Rand.
   */
  const expandFromPeek = useCallback(() => {
    const p = peekY.value;
    if (p <= 0 || closing.value || translateY.value < p - 1) return;
    markSheetMoving(SHEET_IN.duration);
    translateY.value = withTiming(snap.mid, slideTiming(SHEET_IN));
    settleStopSheet(SHEET_IN.duration);
    reportStopSheetTarget(snap.mid);
  }, [peekY, translateY, snap.mid, closing]);

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
      getMid: () => baseSnap.mid,
      getSheetHeight: () => baseSnap.sheetHeight,
    });
  }, [baseSnap]);

  // bodyReady-Riegel + Schließ-Bewegung. Beim Öffnen läuft die Bewegung schon
  // (aus dem Tipp-Handler, siehe openStopSheet) — hier wird nur der Inhalt
  // freigegeben. Beim Schließen fahren wir sie selbst.
  useLayoutEffect(() => {
    closing.value = target == null;
    if (target) {
      /**
       * Wechselt nur der INHALT (Stadt oder Haltestelle), während das Blatt
       * schon offen ist, fährt nichts herein — also auch kein Riegel: Er ließe den Inhalt eine
       * Einfahrt lang verschwinden, die gar nicht stattfindet, und das Blatt
       * blitzte leer auf. Gemeldet als „die Elemente springen beim Wechsel der
       * Stadt".
       */
      if (cityToCityRef.current) {
        cityToCityRef.current = false;
        /**
         * Nicht sperren — aber die Freigabe NEU stellen.
         *
         * Kam der Wechsel noch während der Einfahrt (innerhalb von
         * `SHEET_IN`), hat React eben den Zeitgeber der vorigen Runde
         * abgeräumt; ohne neuen bliebe der Inhalt für immer gesperrt. Genau das
         * war das Blatt, das die Route auf der Karte zeigte und darunter nichts
         * — die Suche kam aus dem Zwischenspeicher und brauchte die Freigabe
         * nicht, die Liste schon. Ist der Inhalt längst frei, ist das hier ein
         * Aufruf ohne Wirkung.
         */
        const id = setTimeout(() => setBodyReady(true), SHEET_IN.duration);
        return () => clearTimeout(id);
      }
      setBodyReady(false);
      // Sicherung: gehört zu genau einer Ausfahrt (siehe unten). Bliebe er
      // stehen, übersprünge die nächste ihre Bewegung.
      settlingRef.current = false;
      /**
       * Die Einfahrt wird hier NICHT mehr gestartet.
       *
       * Sie läuft schon — `openStopSheet()` schickt sie im Berührungs-Frame los.
       * Ein zweiter Start setzte die Kurve von der inzwischen erreichten
       * Position neu an, mit anderer Dauer: sichtbar als Sprung mitten in der
       * Bewegung. Der Kommentar hier behauptete genau das, was der Code daneben
       * nicht tat.
       *
       * Bleibt der Riegel für den Inhalt. Er hing am Abschluss-Rückruf der
       * Bewegung, den es hier nicht mehr gibt — deshalb über die Dauer. Der
       * Zeitgeber wird beim Wechsel abgeräumt.
       */
      const id = setTimeout(() => {
        /**
         * Die Tafel-Uhr im selben Durchgang nachziehen, der den Inhalt
         * freigibt: So zeigt die erste Liste nach der Einfahrt schon nur, was
         * noch kommt, und der Nachzug-Takt danach ändert nichts mehr.
         *
         * Bisher geschah das beim Tipp. War seit dem letzten Öffnen eine
         * Minute vergangen, rendete das ganze Blatt dort ein zweites Mal, und
         * der Commit rückte weiter in die Einfahrt (siehe `displayStop`).
         */
        setBoardNow(Date.now());
        setBodyReady(true);
      }, SHEET_IN.duration);
      return () => clearTimeout(id);
    } else {
      /**
       * Der Inhalt fährt MIT hinaus — der Riegel fällt erst, wenn das Blatt
       * draußen ist (im Abschluss unten bzw. in der Wisch-Geste).
       *
       * Hier stand `setBodyReady(false)`: Im ersten Bild der Ausfahrt wurden
       * Filter-Kästen und beide Tafeln (bis 2 × 25 Zeilen mit SVG-Ringen)
       * abgebaut — die Liste verschwand sichtbar, und der große Durchgang fiel
       * genau in den Anfang der Bewegung: das Ruckeln beim Ausfahren. Das
       * Verschieben selbst zeichnet nichts neu; mitfahren kostet nichts.
       */
      // Das Blatt geht — der freie Ausschnitt der Karte wächst (Kamera).
      reportStopSheetTarget(null);
      // Fährt die Wisch-Geste schon, wird hier NICHT neu angesetzt: Eine zweite
      // Kurve auf demselben Wert setzte von der erreichten Stelle mit voller
      // Dauer an — sichtbar als Tempo-Wechsel mitten in der Ausfahrt.
      if (settlingRef.current) {
        settlingRef.current = false;
        return undefined;
      }
      // Anmelden wie jede andere Fahrt (die Wisch-Geste tut es in
      // `closeBySwipe`): Takte und nachgereichte Daten warten, bis das Blatt
      // draußen ist — fehlte für Zurück-Taste und Tipp auf die Karte.
      markSheetMoving(SHEET_OUT.duration);
      translateY.value = withTiming(
        snap.sheetHeight,
        slideTiming(SHEET_OUT),
        (finished) => {
          if (finished) {
            runOnJS(setBodyReady)(false);
            runOnJS(setDisplayStop)(null);
            runOnJS(setDisplayCity)(null);
          }
        },
      );
      settleStopSheet(SHEET_OUT.duration);
      return undefined;
    }
  }, [target, snap.mid, snap.sheetHeight]);

  const startY = useSharedValue(0);
  /**
   * In `useMemo` — und hier fällt es besonders ins Gewicht.
   *
   * Dieses Blatt hängt dauerhaft am Wurzel-Layout und rendert, solange es offen
   * ist, jede Sekunde neu (der Ticker für die Abfahrtszeiten). Bei jedem
   * Durchlauf entstand bisher ein neues `Gesture.Pan()`-Objekt, das der Erkenner
   * gegen seinen nativen Gegenpart abgleichen und neu einrichten muss.
   */
  /**
   * Der Torhüter für die Abfahrtsliste — siehe `lib/ui/sheetSwipe.ts`.
   *
   * Das Blatt lässt sich seit dieser Runde überall anfassen, nicht mehr nur am
   * Strich oben. Über der Liste heißt das: Sie scrollt wie bisher, und erst
   * wenn sie oben steht, übernimmt das Blatt. `base` zieht dabei den Weg ab,
   * den der Finger fürs Scrollen gebraucht hat — sonst spränge das Blatt in dem
   * Moment, in dem die Liste oben ankommt, um die ganze Scroll-Strecke.
   */
  const gate = useSheetScrollGate();
  /**
   * Die Ankunftsliste hat ihren eigenen — beide Listen stehen nebeneinander
   * (`SlidingPanels`), und die Blatt-Geste fragt den der Liste, die der Finger
   * berührt (nur die sichtbare kann es sein).
   */
  const arrGate = useSheetScrollGate();
  /**
   * Scroll-Stand zurück auf null, sobald eine andere Liste im Blatt steht —
   * andere Haltestelle, andere Stadt, anderer Reiter, oder das Blatt geht zu.
   *
   * Der Torhüter ist EINER für beide Inhalte, und eine neu eingehängte Liste
   * meldet ihren Stand erst beim ersten Scrollen. Stand er noch auf dem Wert
   * der vorigen Liste (z. B. 350 aus dem Stadt-Blatt), hielt das Blatt die neue
   * Abfahrtsliste für gescrollt: Ziehen darüber tat nichts, gezogen werden
   * konnte nur noch am Kopf.
   */
  useEffect(() => {
    gate.scrollY.value = 0;
    arrGate.scrollY.value = 0;
  }, [target, gate, arrGate]);
  const base = useSharedValue(0);
  /** Hat sich das BLATT in dieser Geste bewegt (nicht nur die Liste)? */
  const sheetMoved = useSharedValue(false);
  /** Buchhaltung zum Wisch-Abwurf — die Bewegung selbst läuft schon. */
  const closeBySwipe = useCallback(() => {
    settlingRef.current = true;
    markSheetMoving(SWIPE_OUT.duration);
    closeSheet();
  }, [closeSheet]);
  /** Wo der Finger aufsetzte, und ob über diese Berührung schon entschieden ist. */
  const touchStartY = useSharedValue(0);
  const decided = useSharedValue(false);
  const pan = useMemo(() =>
    Gesture.Pan()
    /**
     * Erst ab acht Punkten Weg ist es ein Ziehen — und dann wird ENTSCHIEDEN,
     * wem die Berührung gehört, von Hand statt über `activeOffsetY`.
     *
     * Ohne die Schwelle nähme das Blatt jedem Knopf darunter die Berührung ab —
     * am Griff allein war das egal, auf der ganzen Fläche ist es der
     * Unterschied zwischen „Abfahrt antippen" und „Blatt verschieben". Beide
     * Richtungen, denn hier wird auch nach OBEN gezogen (auf `full`).
     *
     * STADT-BLATT, Finger auf der Liste: Nach OBEN gehört der Zug der Liste,
     * nach unten auch, solange sie gescrollt ist — das Blatt gibt dann SOFORT
     * ab (`fail`), und die Liste scrollt allein. Kopf, Unterzeile und Pillen
     * bleiben stehen, die Verbindungen laufen unter der Kante hindurch.
     *
     * Vorher sprang das Blatt auch hier an und lief gleichzeitig mit der Liste
     * (beide als gleichzeitig angemeldet); welche von beiden die Bewegung zeigte,
     * entschied eine Regel im ersten Bild. Gemeldet als „ich kann nicht nach
     * oben scrollen, um die anderen Routen anzuschauen". Ein Blatt, das gar
     * nicht erst anspringt, kann der Liste nichts mehr wegnehmen — so hält es
     * auch das Ticket-Blatt (`failOffsetY` in `useSheetSwipe`).
     */
    .manualActivation(true)
    .onTouchesDown((e) => {
      // Nur der ERSTE Finger beginnt eine neue Entscheidung. Ein zweiter
      // setzte sie sonst zurück, und ein spätes `fail()` träfe eine schon
      // laufende Geste.
      if (e.numberOfTouches !== 1) return;
      const t = e.allTouches[0];
      if (t) touchStartY.value = t.absoluteY;
      decided.value = false;
    })
    .onTouchesMove((e, manager) => {
      if (decided.value) return;
      const t = e.allTouches[0];
      if (!t) return;
      const dy = t.absoluteY - touchStartY.value;
      if (Math.abs(dy) < SWIPE_ACTIVATE) return;
      decided.value = true;
      if (cityMode.value && gate.onList.value && (dy < 0 || gate.scrollY.value > 0.5)) {
        manager.fail();
        return;
      }
      manager.activate();
    })
    .simultaneousWithExternalGesture(gate.native, arrGate.native)
    /**
     * Anfang und Ende des Ziehens melden — GENAU ZWEIMAL, nicht pro Bild.
     *
     * Daran hängt der Sekundentakt der Abfahrtsliste: Er darf nicht mitten in
     * ein Ziehen fallen, sonst zeichnet er die Liste unter dem Finger neu.
     * `onBegin`/`onFinalize` statt `onStart`/`onEnd`, weil sie auch dann
     * feuern, wenn die Geste die Acht-Punkte-Schwelle gar nicht überschreitet —
     * ein Tipp, der zum Ziehen werden könnte, zählt schon dazu.
     */
    .onBegin(() => {
      startDragHeal(stopSheetHeal);
      runOnJS(setSheetDragging)(true);
    })
    .onStart((e) => {
      // Ein Blatt, das gerade schließt, lässt sich nicht fangen (`closing`).
      if (closing.value) return;
      grabbed.value = true;
      startY.value = translateY.value;
      base.value = e.translationY;
      sheetMoved.value = false;
      /**
       * Stadt-Blatt: Springt die Geste an, gehört sie dem BLATT — bis zum
       * Loslassen. Was der Liste gehört, hat schon `onTouchesMove` abgegeben.
       *
       * Einmal pro Geste entschieden, nicht Bild für Bild: Beim langsamen Ziehen
       * wackelt der Finger um einen Punkt hin und her, und eine Entscheidung je
       * Bild ließ abwechselnd die Liste scrollen und das Blatt fahren
       * („die Elemente zittern").
       */
      listOwnsGesture.value = false;
      sheetOwnsGesture.value = cityMode.value;
    })
    .onUpdate((e) => {
      if (!grabbed.value || closing.value) return;
      // Stadt-Blatt: Gehört die Geste der Liste, bleibt das Blatt stehen; der
      // Nullpunkt wandert mit.
      if (listOwnsGesture.value) {
        startY.value = translateY.value;
        base.value = e.translationY;
        return;
      }
      // `onList`: nur eine Berührung, die AUF der Liste liegt (sonst
      // sperrte eine gescrollte Abfahrtsliste auch das Ziehen am Kopf).
      if (
        (gate.onList.value && gate.scrollY.value > 0.5) ||
        (arrGate.onList.value && arrGate.scrollY.value > 0.5)
      ) {
        // Die Liste scrollt noch — das Blatt bleibt stehen, der Nullpunkt geht mit.
        startY.value = translateY.value;
        base.value = e.translationY;
        return;
      }
      const next = startY.value + (e.translationY - base.value);
      translateY.value = Math.max(snap.full, next);
      if (Math.abs(translateY.value - startY.value) > 0.5) sheetMoved.value = true;
      /**
       * Liste festhalten, solange sich das Blatt WIRKLICH bewegt.
       *
       * Sie bekommt dieselbe Berührung ab (beide Erkenner sind als gleichzeitig
       * angemeldet) und scrollte sonst unter dem wandernden Blatt mit. Die
       * Bedingung ist wichtig: Steht das Blatt schon ganz oben und der Finger
       * geht weiter hoch, bewegt es sich nicht — dann gehört die Bewegung der
       * Liste, und festhalten dürfte man sie nicht.
       */
      /**
       * Nur korrigieren, wenn die Liste tatsächlich verrutscht IST.
       *
       * Hier stand der Aufruf unbedingt — also in jedem Bild eines Ziehens,
       * auch wenn die Liste längst auf null stand. Das ist nicht nur
       * überflüssig: Der native Scroller bekommt dieselbe Berührung ab, und
       * ein „setze auf null" in jedem Bild arbeitet gegen ihn an, statt ihn
       * einmal festzuhalten. Sichtbar wird daraus ein Zittern der Zeilen.
       *
       * Der Test auf die Verknüpfung gehört dazu: Ohne Abfahrten zeigt dieses
       * Blatt gar keine Liste, und Reanimated schriebe pro Bild eine Warnung.
       * Die Ankunftsliste nur, wenn der Finger auf ihr liegt.
       */
      if (Math.abs(translateY.value - startY.value) > 0.5) {
        if (gate.scrollY.value > 0.5 && gate.ref()) scrollTo(gate.ref, 0, 0, false);
        if (arrGate.onList.value && arrGate.scrollY.value > 0.5 && arrGate.ref()) {
          scrollTo(arrGate.ref, 0, 0, false);
        }
      }
    })
    .onEnd((e) => {
      if (!grabbed.value || closing.value) return;
      const final = startY.value + (e.translationY - base.value);
      /**
       * Rastpunkte: ganz offen, Mitte und — sobald der Kopf vermessen ist —
       * eingeklappt (`peekY`). Liegt „eingeklappt" nicht deutlich unter der
       * Mitte (kurzer Bildschirm, hoher Kopf), gibt es die Stufe nicht.
       */
      const peek = peekY.value;
      const hasPeek = peek > snap.mid + PEEK_MIN_STEP;
      const lowest = hasPeek ? peek : snap.mid;
      const closeThreshold = lowest + (snap.sheetHeight - lowest) * 0.35;
      /**
       * Der Schwung allein schließt nur ein Blatt, das sich auch bewegt hat.
       *
       * Sonst schlösse ein kräftiger Wisch IN der Abfahrtsliste das Blatt: Der
       * Erkenner läuft dabei mit (beide sind als gleichzeitig angemeldet),
       * bewegt nichts — und läse am Ende trotzdem die Geschwindigkeit des
       * Listen-Wischs.
       */
      const moved = Math.abs(translateY.value - startY.value) > 0.5;
      /**
       * Mit Schwung geschlossen wird nur von der UNTERSTEN Stufe aus — von
       * weiter oben legt derselbe Wisch das Blatt eine Stufe tiefer ab (Nutzer:
       * „runterwischen, landet unten; ganz runter, ist es weg"). Weit genug
       * gezogen schließt es von überall.
       */
      const fromLowest = startY.value >= lowest - 1 || final > lowest;
      if (final > closeThreshold || (moved && e.velocityY > 800 && fromLowest)) {
        // Ausfahrt SOFORT von hier, auf dem UI-Strang — der Finger ist gerade
        // erst weg. Der Store wird daneben geleert; der Effekt oben hält sich
        // über `settlingRef` heraus.
        // SOFORT als „schließt" markieren, hier auf dem UI-Strang: Bis der Store
        // geleert und der Effekt gelaufen ist, vergehen je nach Last 50–200 ms.
        // Griff man in diesem Fenster wieder zu, brach die Geste die Ausfahrt ab
        // — und das logisch geschlossene Blatt blieb unter dem Finger stehen.
        closing.value = true;
        translateY.value = withTiming(snap.sheetHeight, SWIPE_OUT, (finished) => {
          "worklet";
          if (finished) {
            runOnJS(setBodyReady)(false);
            runOnJS(setDisplayStop)(null);
            runOnJS(setDisplayCity)(null);
          }
        });
        runOnJS(closeBySwipe)();
        return;
      }
      const points = hasPeek ? [snap.full, snap.mid, peek] : [snap.full, snap.mid];
      let closest = points[0];
      let bestDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p - final);
        if (d < bestDist) {
          bestDist = d;
          closest = p;
        }
      }
      // Hat nur die Liste gescrollt, bleibt das Blatt, wo es ist — sonst risse
      // ein kräftiger Listen-Wisch es nach oben.
      if (cityMode.value && !sheetMoved.value) return;
      if (e.velocityY < -800) {
        // Hoch geschnippt: aus der eingeklappten Lage auf die Mitte, sonst ganz auf.
        closest = hasPeek && startY.value > snap.mid + 1 && final > snap.mid ? snap.mid : snap.full;
      } else if (e.velocityY > 200 && moved) {
        /**
         * Herunter geschnippt: eine Stufe unter der, von der man kam. Von ganz
         * oben auf die Mitte (bei kurzem Weg nur mit kräftigem Schwung — sonst
         * kippte ein Zucken an der Listenkante das Blatt), wer dabei schon unter
         * der Mitte ist, gleich eingeklappt; von der Mitte abwärts eingeklappt.
         * Geschlossen hat das oben schon die unterste Stufe.
         */
        if (startY.value < snap.mid - 1) {
          if (hasPeek && final > snap.mid + 1) closest = peek;
          else if (e.velocityY > 800 || final > snap.mid * 0.6) closest = snap.mid;
        } else if (hasPeek) {
          closest = peek;
        }
      }
      translateY.value = withTiming(closest, { duration: 180, easing: Easing.out(Easing.quad) });
      runOnJS(reportStopSheetTarget)(closest);
    })
    /**
     * EIN `onFinalize` für BEIDE Aufräumarbeiten — und das ist kein Stilfrage.
     *
     * Ein zweiter Aufruf von `.onFinalize()` ERSETZT den ersten, er ergänzt ihn
     * nicht. Das „Ziehen beendet" stand zwischenzeitlich in einem eigenen
     * Aufruf weiter oben und wäre damit nie gelaufen: Der Merker wäre
     * hängengeblieben, und der Sekundentakt der Abfahrtszeiten hätte nach jeder
     * Berührung fünfzehn Sekunden lang ausgesetzt (so lange, bis der Merker von
     * selbst verfällt). Ein Fehler, den man nicht sieht — man wartet nur
     * vergeblich darauf, dass die Minuten weiterzählen.
     *
     * ERSTENS: den Merker „Finger liegt auf der Liste" löschen. Der native
     * Erkenner der Liste tut das selbst — aber nur, wenn es ihn beim Loslassen
     * noch gibt. Wird sie mitten in einer Berührung abgebaut, bliebe er stehen
     * und die Liste beanspruchte danach jede Geste.
     *
     * ZWEITENS: das Ziehen abmelden, damit der Takt wieder laufen darf.
     */
    .onFinalize(() => {
      grabbed.value = false;
      gate.onList.value = false;
      sheetOwnsGesture.value = false;
      listOwnsGesture.value = false;
      // DRITTENS: Statt den Puls abzustellen, läuft er als Nachlauf weiter —
      // über das Einrasten bzw. die Ausfahrt (höchstens `SWIPE_OUT`) hinaus.
      // Ein Durchgang, der in der Fahrt angestoßen wurde und erst danach auf
      // den Schirm kommt, ließ sonst das Auswahlfenster dahinter unter dem Rand
      // liegen (siehe `settleStopSheet`).
      settleStopSheet(SWIPE_OUT.duration);
      runOnJS(setSheetDragging)(false);
    }),
  [snap, startY, translateY, base, gate, arrGate, closeBySwipe, sheetMoved, cityMode, sheetOwnsGesture, listOwnsGesture, touchStartY, decided, closing, grabbed, peekY]);

  /** Die Reiter — fest, die Umschaltung vergleicht ihre Einträge nicht neu. */
  const boardTabs = useMemo(
    () => [
      { id: "departures", label: t("stop.tab.departures") },
      { id: "arrivals", label: t("stop.tab.arrivals") },
    ],
    [t],
  );

  /**
   * EINE TAFEL — Abfahrten oder Ankünfte. Beide stehen nebeneinander im Blatt
   * (`SlidingPanels`) und fahren beim Wechsel gemeinsam; jede hat ihre eigene
   * Liste mit eigenem Torhüter (`g`) für die Blatt-Geste.
   */
  /** Wo Kasten und erste Zeile stehen — daraus der Weg der Zeile, die zum Kasten wird. */
  const promote = useRef<Record<BoardTab, { hero: number; row: number }>>({
    departures: { hero: 0, row: 0 },
    arrivals: { hero: 0, row: 0 },
  });
  /** Der zuletzt gezeigte Kasten je Tafel — wechselt er bei derselben Lieferung, ist er abgefahren. */
  const seenHero = useRef<Record<BoardTab, SeenHero | null>>({ departures: null, arrivals: null });
  const departed = useRef<Record<BoardTab, Departed | null>>({ departures: null, arrivals: null });
  const renderBoard = (
    board: BoardTab,
    q: UseQueryResult<StopBoardResponse>,
    list: StopBoardItem[],
    total: number,
    g: SheetScrollGate,
    lp: typeof listProps,
    wanted: boolean,
  ) => {
    const keys = boardKeys(list.slice(0, 6));
    // Eine Lieferung = dieselben Daten unter demselben Filter. Nur wenn darin
    // der vorderste Eintrag wechselt, ist wirklich etwas abgefahren — alles
    // andere (andere Station, neue Daten, Filter) steht einfach neu da.
    const gen = `${q.dataUpdatedAt}|${filterKey}`;
    const seen = seenHero.current[board];
    if (list.length > 0) {
      if (seen && seen.gen === gen && seen.key !== keys[0]) {
        departed.current[board] = {
          key: seen.key,
          item: seen.item,
          row: seen.row,
          heroY: promote.current[board].hero,
          rowY: promote.current[board].row,
          gen,
          at: Date.now(),
        };
      }
      seenHero.current[board] = { key: keys[0]!, item: list[0]!, row: list[1] ?? null, gen };
    }
    const gone = departed.current[board];
    const ghost = gone && gone.gen === gen && Date.now() - gone.at < PROMOTE.duration + 120 ? gone : null;
    const heroFor = (item: StopBoardItem) => (
      <NextHero
        item={item}
        tz={boardTz}
        dayLabel={boardDayLabel(item.plannedTime, boardTz, locale, t("stop.day.tomorrow"))}
        ringDayLabel={boardDayLabel(item.plannedTime, boardTz, locale, t("stop.day.tomorrow"), true)}
        fetchedAt={q.data?.fetchedAt}
        platformPrefix={platformPrefixFor(t, item.product)}
        nextLabel={t("stop.section.next")}
        ontimeLabel={t("stop.section.ontime")}
        loading={loadingDepartureId === item.id}
        onPress={() => onSelectDeparture(item, board)}
        onLive={canLive(item) ? () => startLiveFor(item, board) : undefined}
        liveLabel={t("live.button")}
        liveClock={liveClock}
      />
    );
    const rowFor = (it: StopBoardItem) => (
      <StopBoardRow
        item={it}
        tz={boardTz}
        dayLabel={boardDayLabel(it.plannedTime, boardTz, locale, t("stop.day.tomorrow"))}
        platformPrefix={platformPrefixFor(t, it.product)}
        loading={loadingDepartureId === it.id}
        onPress={() => onSelectDeparture(it, board)}
        onLive={canLive(it) ? () => startLiveFor(it, board) : undefined}
        liveLabel={t("live.button")}
        liveClock={liveClock}
      />
    );
    return (
    <View style={styles.boardPanel}>
      {/* Lader erst nach 2 s, dann mindestens zwei volle Durchläufe, weich
          hinaus und die Tafel weich herein (`LoadGate`, Nutzerwunsch
          04.11.2026) — mittig im SICHTBAREN Teil des Blattes (`SheetLoader`).
          Die Ankünfte werden erst auf Tipp angefragt: Bis dahin steht dort
          nichts (kein Lader, der hinter der Abfahrtstafel unsichtbar liefe),
          danach beginnt ihr Tor von vorn. */}
      {!wanted ? (
        <View style={styles.boardContent} />
      ) : (
      <LoadGate loading={q.isLoading} fill loader={<SheetLoader />} contentStyle={styles.boardContent}>
      {() => q.isError ? (
        // FEHLER ist nicht LEER. Vorher lief beides in denselben Zweig —
        // ein Netz-Aussetzer behauptete dann „Keine Abfahrten", also eine
        // Falschaussage über den Fahrplan. Jetzt sagen wir, dass WIR
        // nichts laden konnten, und bieten einen Retry an.
        <StatePanel
          compact
          art="offline"
          // Der Reiter sagt, WAS nicht kam — vorher stand auch über den
          // Ankünften „Abfahrten nicht ladbar".
          title={t(board === "departures" ? "stop.error.title" : "stop.error.arrivals.title")}
          body={t("results.error.body")}
          action={t("state.retry")}
          busy={q.isFetching}
          onAction={() => void q.refetch()}
        />
      ) : list.length === 0 ? (
        total > 0 ? (
          // Es gäbe Fahrten — nur nicht für die gewählten Arten.
          <View style={styles.empty}>
            <Text style={styles.emptyBody}>{t("stop.empty.filtered")}</Text>
          </View>
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {t(
                board === "departures"
                  ? "stop.empty.departures.title"
                  : "stop.empty.arrivals.title",
              )}
            </Text>
            <Text style={styles.emptyBody}>
              {t(
                board === "departures"
                  ? "stop.empty.departures.body"
                  : "stop.empty.arrivals.body",
              )}
            </Text>
          </View>
        )
      ) : (
        <GestureDetector gesture={g.native}>
        <Animated.ScrollView
          // Neue Haltestelle oder anderer Reiter = neue Liste, oben
          // beginnend — passend zum zurückgesetzten Scroll-Stand
          // (siehe den Torhüter `g`).
          key={`${stop!.code}|${board}`}
          ref={g.ref}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator
          // Scrollt nur am oberen Rastpunkt — siehe `listProps`.
          animatedProps={lp}
          onScroll={g.onScroll}
          scrollEventThrottle={16}
          // Kein Überzieh-Schimmer oben: Dort übernimmt das Blatt.
          overScrollMode="never"
          bounces={false}
        >
          {/* Hero = nächste Abfahrt mit Countdown-Ring. „Danach"-Label
              nur rendern wenn es noch weitere Items gibt, sonst wirkt
              die Section-Headline einsam. */}
          {/* Zeiten eines anderen, nahen Halts — ehrlich sagen, von welchem. */}
          {q.data?.stop.servedBy ? (
            <Text style={styles.servedByHint} numberOfLines={2}>
              {t("stop.servedBy")
                .replace("{name}", q.data.stop.servedBy.name)
                .replace("{m}", String(q.data.stop.servedBy.distanceM))}
            </Text>
          ) : null}
          {/* Der Schlüssel wechselt mit jeder NEUEN Datenlieferung: Dann steht die
              Liste ohne Bewegung neu da (Ein- und Ausblenden übersprungen). Nur
              eine Abfahrt bei denselben Daten läuft als Animation — sonst
              schrumpfte beim Wechsel der Station der alte Kasten davon.
              Kein `exiting` hier: Reanimated spielte es beim Wechsel der Station
              trotz `skipExiting` ab (alles zoomte weg). Was abfährt, fliegt
              deshalb als eigener Geist davon (`BoardGhost`). */}
          <LayoutAnimationConfig key={gen} skipEntering>
          <View>
          {ghost ? (
            <BoardGhost key={`ghost:${ghost.key}`} top={ghost.heroY} fly>
              {heroFor(ghost.item)}
            </BoardGhost>
          ) : null}
          {ghost?.row ? (
            <BoardGhost key={`ghostrow:${ghost.key}`} top={ghost.rowY}>
              {rowFor(ghost.row)}
            </BoardGhost>
          ) : null}
          <Animated.View
            key={`hero:${keys[0]}`}
            entering={heroInFrom(promote.current[board].row - promote.current[board].hero)}
            onLayout={(e) => {
              promote.current[board].hero = e.nativeEvent.layout.y;
            }}
          >
          {heroFor(list[0]!)}
          </Animated.View>
          {list.length > 1 && (
            <Animated.View layout={BOARD_SHIFT}>
              <Text style={styles.danachLabel}>{t("stop.section.later")}</Text>
            </Animated.View>
          )}
          {list.slice(1, 6).map((it, i) => (
            <Animated.View
              key={keys[i + 1]}
              layout={BOARD_SHIFT}
              entering={ROW_IN}
              onLayout={
                i === 0
                  ? (e) => {
                      promote.current[board].row = e.nativeEvent.layout.y;
                    }
                  : undefined
              }
            >
            {rowFor(it)}
            </Animated.View>
          ))}
          </View>
          </LayoutAnimationConfig>
        </Animated.ScrollView>
        </GestureDetector>
      )}
      </LoadGate>
      )}
    </View>
    );
  };

  // Sheet bleibt PERMANENT gemountet — auch wenn nichts ausgewählt ist
  // (translateY = sheetHeight = off-screen). Dadurch entfällt der React-
  // Mount-Cost beim ersten Marker-Tap; nur die translateY-Animation läuft.
  // Inhalt nur rendern wenn stop existiert (spart Re-Renders der Liste etc.).
  return (
    <>
      {/* KEIN Hintergrund, der Tipps abfängt — weder bei der Stadt noch bei
          der Haltestelle. Die Karte darüber bleibt bedienbar: verschieben,
          heranzoomen, die nächste Haltestelle oder eine graue Alternative
          antippen — wie bei Google. Geschlossen wird durch Herunterwischen
          oder die Zurück-Taste.

          Bei der Haltestelle lag hier bis eben eine Fläche bis knapp über die
          Tab-Leiste, die jeden Tipp auf die Karte schluckte und das Blatt
          schloss. Gemeldet als „vereinheitlichen, wie beim Stadt-Blatt". */}
      <GestureDetector gesture={pan}>
      <Animated.View
        pointerEvents={target ? "auto" : "none"}
        style={[
          styles.sheet,
          { backgroundColor: palette.s1 },
          {
            top: Math.max(60, insets.top + 12),
            height: snap.sheetHeight,
            paddingBottom: insets.bottom + 12,
          },
          covered ? styles.sheetCovered : null,
          sheetAnim,
        ]}
      >
        {city ? (
          <>
            <SheetHandle />
            <CityTripBody
              /**
               * Je Stadt NEU aufgebaut. Sonst lief nach einem Stadtwechsel ein
               * Durchgang mit dem Verkehrsmittel der vorigen Stadt (z. B. Flug) —
               * und damit eine Suche, bevor der Wechsel auf Zug griff.
               */
              key={`${city.name}|${city.latitude.toFixed(4)}|${city.longitude.toFixed(4)}`}
              city={city}
              bodyReady={bodyReady}
              gate={gate}
              listProps={listProps}
              // In der Mitte liegt dieser Teil des Blattes unter dem Bildrand —
              // so viel Luft braucht die Liste unten, damit die letzte Zeile
              // dort ganz heraufscrollt.
              listBottomInset={snap.mid}
              onHeadLayout={onHeadLayout}
              bodyStyle={peekFade}
            />
          </>
        ) : stop && (
          <>
            {/* Nur noch Zeichen, nicht mehr Griff: Der Erkenner sitzt am ganzen
                Blatt (siehe `pan`). Der Strich bleibt, weil er ansagt, DASS
                gezogen werden kann. Griff + Abstand zum Titel wie in jedem
                Blatt (`SheetHandle`, `SHEET_HEAD_TOP`). */}
            <SheetHandle />

            {/* Header: Name, Distanz + Venue-Typ, Favoriten-Stern.
                Subtitle-Format: „163 m entfernt · Bahnhof" — Venue-Typ kommt
                aus den `kinds` (erstes Element = Primary-Kind, sortiert nach
                Häufigkeit am Server). Wenn distance fehlt, zeigen wir nur
                den Venue-Typ. */}
            <View style={styles.header}>
              <View style={styles.headerText}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {stop.label}
                </Text>
                {(() => {
                  const primaryKind = kinds[0];
                  const venue = primaryKind ? t(`stop.venue.${primaryKind}`) : "";
                  const dist = stop.distanceMeters !== undefined ? formatDistance(stop.distanceMeters, t) : "";
                  /**
                   * Steig und Zusatz in DIESER Zeile, keine eigene Plakette mehr:
                   * „461 m entfernt · Tramhalt · Gl. 5". Das Wort davor wie in den
                   * Zeilen der Tafel (`platformPrefixFor`). Der Zusatz bei
                   * gleichnamigem Nachbarn („Rochdale Road · Stop RA") dahinter —
                   * nie im Namen selbst.
                   */
                  const place = stopPlatform ? `${platformPrefixFor(t, primaryKind)} ${stopPlatform}` : "";
                  const sub = [dist, venue, place, stopExtra].filter(Boolean).join(" · ");
                  if (!sub) return null;
                  return (
                    <View style={styles.headerSubtitleRow}>
                      <View style={styles.headerSubtitleIcon}>
                        <WalkIcon size={14} color={C.g1} />
                      </View>
                      <Text style={styles.headerSubtitle} numberOfLines={2}>
                        {sub}
                      </Text>
                    </View>
                  );
                })()}
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
                // Die unsichtbare Luft des Knopfes wieder herausziehen, damit
                // der Stern an seiner SICHTBAREN Kante ausgerichtet ist —
                // Begründung an `STAR_INSET`.
                return (
                  <View style={{ marginTop: -STAR_INSET, marginRight: -STAR_INSET }}>
                    <StarOrReset
                      // Je Halt neu: Der Pfeil eines gefilterten Halts fährt
                      // beim Wechsel nicht erst hinaus.
                      key={stop.code}
                      filtered={hiddenCats.size > 0}
                      saved={saved}
                      onSavedChange={(willSave) => {
                        if (!asLocation) return;
                        toggleSavedStation(asLocation);
                        if (willSave) {
                          showStationToast(t("surroundings.stationsaved"), asLocation.label);
                        }
                      }}
                      onReset={showAllCategories}
                      resetLabel={t("stop.filter.reset")}
                    />
                  </View>
                );
              })()}
            </View>

            {/* Was an diesem Halt fährt — Kästen als Filter (siehe `CATEGORY`).
                Schon während die Tafel lädt, steht die Zeile in voller Höhe da:
                Sonst sprängen Umschaltung und Liste nach unten, sobald sie kommt. */}
            {bodyReady && !isAirport && (categories.length > 0 || depQuery.isLoading) && (
              <View style={styles.catRow}>
                {categories.map((c) => (
                  <CategoryChip
                    key={c}
                    cat={c}
                    label={t(CATEGORY[c].tKey)}
                    active={!hiddenCats.has(c)}
                    interactive={categories.length > 1}
                    onToggle={toggleCategory}
                  />
                ))}
              </View>
            )}

            {/* Abfahrten | Ankünfte — eine Blase, die wandert, wie im
                Gespeichert-Tab; die Listen darunter fahren mit. */}
            {bodyReady ? (
              <BoardSwitch
                // Je Halt neu — jeder beginnt mit den Abfahrten.
                key={stop.code}
                tabs={boardTabs}
                zoneHint={zoneHint}
                onArrivalsTap={requestArrivals}
                onTabPress={expandFromPeek}
                onHeadLayout={onHeadLayout}
                bodyStyle={peekFade}
                onSettled={onBoardSettled}
                departures={renderBoard("departures", depQuery, depItems, depAll.length, gate, listProps, true)}
                arrivals={renderBoard("arrivals", arrQuery, arrItems, arrAll.length, arrGate, arrListProps, arrivalsWanted)}
              />
            ) : (
              <View style={styles.body} />
            )}
          </>
        )}
      </Animated.View>
      </GestureDetector>
    </>
  );
}

/**
 * Ein Kasten der Tafel: Symbol | Name. An = in der Farbe der Art, aus = nur
 * der weiße Rahmen (die Farbe geht, die Fahrten dieser Art auch). Antippbar
 * nur, wenn es mehrere Arten gibt — sonst zeigt er nur, was hier fährt.
 */
const CategoryChip = memo(function CategoryChip({
  cat,
  label,
  active,
  interactive,
  onToggle,
}: {
  cat: BoardCategory;
  label: string;
  active: boolean;
  interactive: boolean;
  onToggle: (c: BoardCategory) => void;
}) {
  const def = CATEGORY[cat];
  const Icon = def.Icon;
  const onPress = useCallback(() => onToggle(cat), [onToggle, cat]);
  return (
    <RippleTouch
      onPress={interactive ? onPress : undefined}
      disabled={!interactive}
      accessibilityRole={interactive ? "button" : "text"}
      accessibilityLabel={label}
      accessibilityState={interactive ? { selected: active } : undefined}
      style={[styles.catChip, { backgroundColor: active ? def.color : "transparent" }]}
    >
      {def.letter ? (
        <Text style={styles.catLetter}>{def.letter}</Text>
      ) : Icon ? (
        <Icon color="#FFFFFF" size={20} strokeWidth={2.2} />
      ) : null}
      <View style={styles.catSep} />
      <Text style={styles.catLabel} numberOfLines={1}>
        {label}
      </Text>
    </RippleTouch>
  );
});

/**
 * Abfahrten | Ankünfte — die Umschaltung und die beiden Tafeln darunter.
 *
 * Der gewählte Reiter lebt HIER, nicht im Blatt. Vorher lief bei jedem Wechsel
 * das ganze Blatt durch, samt beider Listen mit Ringen und Live-Knöpfen — genau
 * in dem Moment, in dem die Fahrt begann. Jetzt rendert ein Wechsel nur diese
 * Hülle: Die Tafeln kommen als fertige Elemente herein, und React lässt sie
 * unberührt. Dazu fährt die Schiene ohne Textur (`rasterize={false}`, siehe
 * SlidingPanels).
 */
function BoardSwitch({
  tabs,
  zoneHint,
  onArrivalsTap,
  onTabPress,
  onHeadLayout,
  bodyStyle,
  onSettled,
  departures,
  arrivals,
}: {
  tabs: { id: string; label: string }[];
  zoneHint: string | null;
  onArrivalsTap: () => void;
  /** Jeder Tipp auf einen Reiter — eingeklappt holt er das Blatt auf die Mitte. */
  onTabPress: () => void;
  /** Unterkante der Reiter-Zeile im Blatt — für die eingeklappte Stufe. */
  onHeadLayout: (bottom: number) => void;
  /** Deckkraft der Tafeln (eingeklappt unsichtbar), vom Blatt auf dem UI-Strang. */
  bodyStyle: StyleProp<ViewStyle>;
  onSettled: (index: number) => void;
  departures: ReactNode;
  arrivals: ReactNode;
}) {
  const [tab, setTab] = useState<BoardTab>("departures");
  const onChange = useCallback(
    (id: string) => {
      onTabPress();
      if (id === "arrivals") onArrivalsTap();
      setTab(id as BoardTab);
    },
    [onArrivalsTap, onTabPress],
  );
  return (
    <>
      <View
        style={styles.toggleRow}
        onLayout={(e) => onHeadLayout(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
      >
        <SegmentedToggle items={tabs} selectedId={tab} onChange={onChange} borderRadius={14} segmentHeight={34} />
        {/* „Ortszeit (UTC+1)" — leise unter der Umschaltung. */}
        {zoneHint ? (
          <Text style={styles.zoneHint} numberOfLines={1}>
            {zoneHint}
          </Text>
        ) : null}
      </View>
      <Animated.View style={[styles.body, bodyStyle]}>
        <SlidingPanels activeIndex={tab === "departures" ? 0 : 1} rasterize={false} onSettled={onSettled}>
          {departures}
          {arrivals}
        </SlidingPanels>
      </Animated.View>
    </>
  );
}

/** So weit rückt der Stern zur Seite, wenn der Pfeil kommt (Mitte zu Mitte). */
const RESET_SHIFT = 40;

/**
 * Eingeklappte Stufe: Mindestabstand unter der Mitte, damit es sie gibt — und
 * die Strecke, über die die Liste beim Aufziehen einblendet (beides vor `ms`).
 */
const PEEK_MIN_STEP = 48;
const PEEK_FADE = 48;
/**
 * Weich anfahren, weich ankommen. Die Kurve davor schoss in den ersten Bildern
 * los — und genau die fielen dem Umbau der Tafeln zum Opfer: Der Stern sprang
 * ein Stück und kroch dann („laggy"). Mit sanftem Anfang kostet ein spätes
 * erstes Bild nichts Sichtbares.
 */
const RESET_SWAP = { duration: 360, easing: Easing.bezier(0.4, 0, 0.2, 1) };

/**
 * STERN UND ZURÜCK-PFEIL teilen sich den Platz oben rechts.
 *
 * Ist eine Verkehrsart ausgeblendet, rollt der Pfeil auf den Platz des Sterns
 * und schiebt ihn zur Seite; ein Tipp darauf zeigt wieder alles, der Pfeil geht,
 * und der Stern rückt zurück. Beide bleiben gemountet — was zu sehen ist,
 * steuert ein Wert auf dem UI-Strang.
 *
 * Gefahren wird NACH dem Durchgang, der den Filter setzt — und ein Bild später
 * als sein Effekt. Dieser Durchgang baut beide Tafeln um, und auf Fabric wird
 * er danach auf dem UI-Strang eingehängt, demselben, auf dem die Fahrt läuft:
 * Begann sie im selben Moment, fehlten ihr die ersten Bilder. Und ein Commit
 * mitten in einer Reanimated-Fahrt schreibt deren Lage ein, zwei Bilder zu spät
 * zurück — deshalb meldet sie sich als Bewegung an (`markSheetMoving`), dann
 * setzt der Sekundentakt der Abfahrtszeiten so lange aus.
 *
 * Solange der Pfeil steht — und bis der Stern wieder zu Hause ist —, nimmt die
 * Gruppe zwei Plätze ein: Ein langer Name endet dann vor dem Stern statt unter
 * ihm. Umgestellt wird die Breite nur vor bzw. nach der Fahrt.
 */
const StarOrReset = memo(function StarOrReset({
  filtered,
  saved,
  onSavedChange,
  onReset,
  resetLabel,
}: {
  filtered: boolean;
  saved: boolean;
  onSavedChange: (willSave: boolean) => void;
  onReset: () => void;
  resetLabel: string;
}) {
  const p = useSharedValue(filtered ? 1 : 0);
  /** Den zweiten Platz halten, bis der Stern zurück ist. */
  const [holdWide, setHoldWide] = useState(filtered);
  /** Wohin zuletzt gefahren wurde — beim Einhängen gibt es nichts zu fahren. */
  const targetRef = useRef(filtered ? 1 : 0);
  useEffect(() => {
    const target = filtered ? 1 : 0;
    if (targetRef.current === target) return;
    targetRef.current = target;
    const id = requestAnimationFrame(() => {
      markSheetMoving(RESET_SWAP.duration);
      p.value = withTiming(target, RESET_SWAP, (finished) => {
        if (finished) runOnJS(setHoldWide)(filtered);
      });
    });
    return () => cancelAnimationFrame(id);
  }, [filtered, p]);
  const starStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -RESET_SHIFT * p.value }],
  }));
  const arrowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(p.value, [0, 0.6], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateX: (1 - p.value) * 12 },
      { rotate: `${(1 - p.value) * -50}deg` },
      { scale: interpolate(p.value, [0, 0.75, 1], [0.5, 1.06, 1]) },
    ],
  }));
  return (
    <View style={[STAR_GROUP, { width: filtered || holdWide ? STAR_BTN + RESET_SHIFT : STAR_BTN }]}>
      <Animated.View style={starStyle}>
        <SaveStarButton
          /**
           * Größen AUSDRÜCKLICH gesetzt, obwohl es die Vorgaben sind — die
           * Hülle rechnet mit ihnen.
           *
           * Der Knopf ist eine Trefferfläche von 46 mit einem Symbol von 30
           * darin; die Differenz von 16 verteilt sich als 8 Punkte Luft auf jede
           * Seite. Genau diese 8 zieht `headerFav` wieder heraus. Stünden die
           * Zahlen nur als Vorgaben in der Komponente, ginge die Rechnung beim
           * nächsten Anfassen dort still kaputt.
           */
          size={STAR_BTN}
          starSize={STAR_ICON}
          saved={saved}
          onChange={onSavedChange}
        />
      </Animated.View>
      <Animated.View
        style={[RESET_SLOT, arrowStyle]}
        pointerEvents={filtered ? "auto" : "none"}
        accessibilityElementsHidden={!filtered}
        importantForAccessibility={filtered ? "auto" : "no-hide-descendants"}
      >
        <RippleTouch
          onPress={onReset}
          borderless
          accessibilityRole="button"
          accessibilityLabel={resetLabel}
          style={RESET_BTN}
        >
          <Undo2 color={C.white} size={26} strokeWidth={2.2} />
        </RippleTouch>
      </Animated.View>
    </View>
  );
});

function upcomingOf(board: StopBoardResponse | undefined, nowMs: number): StopBoardItem[] {
  return (board?.results ?? []).filter((it) => expectedAt(it) >= nowMs);
}

/** Wann die Fahrt wirklich fährt — Plan plus Verspätung. */
function expectedAt(it: StopBoardItem): number {
  return Date.parse(it.plannedTime) + (it.delayMinutes ?? 0) * 60_000;
}

/** Bis kurz nach der nächsten Abfahrt auf einer der Tafeln, höchstens eine Minute. */
function msToNextDeparture(boards: (StopBoardResponse | undefined)[], now: number): number {
  let next = Infinity;
  for (const b of boards) {
    for (const it of b?.results ?? []) {
      const at = expectedAt(it);
      if (at > now && at < next) next = at;
    }
  }
  return Math.min(60_000, Math.max(250, next - now + 50));
}

/**
 * Schlüssel einer Fahrt — OHNE ihren Platz in der Liste. Mit dem Platz darin
 * (bisher `${id}-${i}`) bekam beim Nachrücken jede Zeile einen neuen Schlüssel
 * und wurde neu aufgebaut, statt zu gleiten. Doppelte Kennungen bekommen eine
 * laufende Nummer, damit nichts kollidiert.
 */
function boardKeys(items: StopBoardItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const base = it.id || `${it.plannedTime}|${it.line}|${it.direction}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

/**
 * Wechsel der nächsten Fahrt — EIN Zug: Der alte Kasten gleitet nach oben unter
 * den Umschalter und blendet aus, die erste Zeile von „Später" steigt an seine
 * Stelle und wächst zum Kasten, die übrigen rücken nach, unten kommt eine neue.
 * Alles über Reanimateds Layout-Animationen: ein Commit am Anfang, danach nur
 * noch der UI-Strang.
 */
const PROMOTE = { duration: 420, easing: Easing.bezier(0.2, 0, 0, 1) };
const BOARD_SHIFT = LinearTransition.duration(PROMOTE.duration).easing(PROMOTE.easing);
const ROW_IN = FadeInDown.duration(340).delay(80);
/** Die Zeile, die zum Kasten wird, blendet an ihrer Stelle aus. */
const GHOST_FADE = { duration: 160 };

interface SeenHero {
  key: string;
  item: StopBoardItem;
  row: StopBoardItem | null;
  gen: string;
}
interface Departed extends SeenHero {
  heroY: number;
  rowY: number;
  at: number;
}

/**
 * Was abgefahren ist, als Geist an seiner alten Stelle: Der Kasten fliegt nach
 * oben hinter die Reiter, die Zeile darunter blendet aus. Ein gewöhnliches
 * Element statt `exiting` — so kann nichts davon beim Stationswechsel
 * mitspielen; es verschwindet dann einfach.
 */
function BoardGhost({ top, fly = false, children }: { top: number; fly?: boolean; children: ReactNode }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withTiming(1, fly ? PROMOTE : GHOST_FADE);
  }, [p, fly]);
  const style = useAnimatedStyle(() =>
    fly
      ? {
          opacity: Math.max(0, 1 - p.value / 0.76),
          transform: [{ translateY: -40 * p.value }, { scale: 1 - 0.08 * p.value }],
        }
      : { opacity: 1 - p.value },
  );
  return (
    <Animated.View pointerEvents="none" style={[styles.ghost, { top }, style]}>
      {children}
    </Animated.View>
  );
}
/** Der neue Kasten startet dort, wo seine Zeile stand — `dy` ist ihr gemessener Abstand. */
function heroInFrom(dy: number): EntryExitAnimationFunction {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: dy }, { scale: 0.94 }] },
      animations: {
        opacity: withTiming(1, { duration: 280 }),
        transform: [{ translateY: withTiming(0, PROMOTE) }, { scale: withTiming(1, PROMOTE) }],
      },
    };
  };
}

function withoutHidden(items: StopBoardItem[], hidden: ReadonlySet<BoardCategory>): StopBoardItem[] {
  return hidden.size === 0 ? items : items.filter((it) => !hidden.has(categoryOf(it)));
}


/** Globales Overlay — wird in app/_layout.tsx einmal gerendert (damit's ÜBER
 *  FloatingTabBar liegt). Inner-Component bleibt permanent gemountet sobald
 *  einmal ein Stop angetappt wurde, damit der nächste Slide-In keine
 *  React-Mount-Latenz hat. */
export const StopDetailSheet = memo(function StopDetailSheet() {
  return <StopDetailSheetInner />;
});

/**
 * Die Maße des Stern-Knopfes — UNSKALIERT, und das ist der Punkt.
 *
 * Sie gehen als Eigenschaften an `SaveStarButton` und landen dort in einem
 * eingebetteten Stil; `scaledStyles` fasst sie also nicht an. Der Ausgleich in
 * `headerFav` muss deshalb genauso unskaliert sein — stünde er im Stilblatt,
 * rechnete ihn die Geräte-Skalierung auf kleinen Bildschirmen herunter, während
 * die Luft im Knopf unverändert bliebe. Ein Punkt Differenz, aber genau dieselbe
 * Falle, die beim Schalter den Kreis aus der Pille hat laufen lassen.
 */
const STAR_BTN = 46;
/** Der Countdown-Ring der nächsten Abfahrt — so groß wie seine Hülle (`heroRing`, skaliert). */
const RING_BOX = ms(84);
const STAR_ICON = 30;
/** Die unsichtbare Luft je Seite — sie wird unten wieder herausgezogen. */
const STAR_INSET = (STAR_BTN - STAR_ICON) / 2;
/** Stern und Zurück-Pfeil (`StarOrReset`) — ebenso unskaliert wie der Knopf. */
const STAR_GROUP = { flexDirection: "row", justifyContent: "flex-end" } as const;
const RESET_SLOT = { position: "absolute", top: 0, right: 0, width: STAR_BTN, height: STAR_BTN } as const;
const RESET_BTN = { flex: 1, alignItems: "center", justifyContent: "center" } as const;

const styles = scaledStyles({
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: C.bg,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: "hidden",
    /**
     * KEIN Rahmen mehr — und der Grund ist derselbe wie beim Umgebungs-Blatt,
     * wo er längst steht.
     *
     * Hier lag eine Linie auf drei Seiten. Sie war nie Gestaltung, sondern ein
     * Pflaster: Eine PARTIELLE Umrandung zusammen mit `borderRadius` zeichnet
     * Android an den gerundeten Ecken fehlerhaft — dort fehlt der Hintergrund,
     * und die Karte schimmert durch. Die Linie hat das Durchschimmern verdeckt,
     * nicht behoben. Sichtbar blieb sie trotzdem, und kein anderes Blatt der App
     * trägt eine.
     *
     * Die Trennung zum Kartenbild übernimmt jetzt der Schatten nach oben —
     * Zeichen für Zeichen derselbe wie am Umgebungs-Blatt, damit die beiden
     * Blätter, die sich abwechselnd über dieselbe Karte legen, nicht
     * verschieden aussehen.
     *
     * EIN UNTERSCHIED BLEIBT, und er ist bewusst: Das Umgebungs-Blatt trägt
     * kein `overflow: "hidden"`, dieses schon (es hat Inhalt, der sonst über
     * die gerundeten Ecken liefe). Ob Android den Erhebungs-Schatten dann noch
     * zeichnet, ist je nach Version verschieden.
     *
     * Das ist verkraftbar, weil der Schatten hier NICHT die Reparatur ist,
     * sondern die Zugabe: Das Durchschimmern kam von der teilweisen Umrandung
     * selbst — sie ist die Ursache, und sie ist weg. Fällt der Schatten auf
     * einem Gerät aus, sieht die Kante flacher aus; die Karte schimmert
     * deswegen nicht wieder durch. Wer das ändern will, braucht eine eigene
     * Hülle für den Schatten, wie sie die Reisekarte benutzt — das wäre ein
     * zusätzlicher Knoten in einem Blatt, das pro Bild bewegt wird, und den
     * gibt man nicht für eine Zugabe aus.
     */
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    // hoch genug, dass das Sheet über FloatingTabBar + andere Overlays sitzt.
    zIndex: 100,
    elevation: 20,
  },
  /** Siehe `covered`: unter deckende Blätter, nach Reihenfolge statt Höhe. */
  sheetCovered: { zIndex: 0, elevation: 0 },
  /** Kein Polster oben: Die Griffzone (`SheetHandle`) endet genau am Titel. */
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingBottom: GROUP_GAP,
    gap: 12,
  },
  headerText: { flex: 1 },
  headerTitle: { color: C.white, fontSize: 20, fontWeight: "700" },
  // Row mit Walk-Icon + Text. marginTop fängt den Abstand zum Title. Das Icon
  // sitzt mittig zur ERSTEN Zeile (eigene Box in Zeilenhöhe) — bricht die Zeile
  // mit Steig und Zusatz um, rutscht es nicht zwischen die beiden Zeilen.
  headerSubtitleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 8 },
  headerSubtitleIcon: { height: 19, justifyContent: "center" },
  headerSubtitle: { flexShrink: 1, color: C.g1, fontSize: 14, lineHeight: 19, fontWeight: "500" },

  // Die Verkehrsarten als Kästen (Filter) — wie DB Navigator: weißer Rahmen,
  // an = in der Farbe der Art, aus = nur der Rahmen. Die Zeile hält ihre Höhe,
  // auch solange die Tafel noch lädt (siehe dort).
  catRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    minHeight: 48,
  },
  catChip: {
    flexDirection: "row",
    alignItems: "center",
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: "#FFFFFF",
    overflow: "hidden",
  },
  catLetter: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "900",
    minWidth: 20,
    textAlign: "center",
    includeFontPadding: false,
  },
  catSep: {
    width: 1.5,
    height: 20,
    marginHorizontal: 8,
    borderRadius: 1,
    backgroundColor: "rgba(255,255,255,0.85)",
  },
  catLabel: { color: "#FFFFFF", fontSize: 15, fontWeight: "800", letterSpacing: 0.1 },

  // Abfahrten | Ankünfte — über die volle Breite, Ortszeit darunter rechts.
  toggleRow: { paddingHorizontal: 16, gap: 8 },
  // Ortszeit-Hinweis rechts in der Reiter-Zeile — klein und grau, damit
  // „15:33" in Oldham nicht für deutsche Zeit gehalten wird.
  servedByHint: {
    color: C.g2,
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 8,
  },
  zoneHint: {
    alignSelf: "flex-end",
    color: C.g2,
    fontSize: 12,
    fontWeight: "500",
  },

  // Der Körper über die volle Breite — die beiden Tafeln fahren als Ganzes
  // (`SlidingPanels`); den Rand hält jede Tafel selbst.
  body: { flex: 1, paddingTop: GROUP_GAP },
  boardPanel: { flex: 1, paddingHorizontal: 16 },
  /** Die Tafel nach dem Laden — füllt die Fläche wie vorher direkt im Panel. */
  boardContent: { flex: 1 },
  empty: { alignItems: "center", paddingTop: SECTION_GAP, paddingHorizontal: 24 },
  emptyTitle: { color: C.white, fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: C.g1, fontSize: 15, marginTop: 8, textAlign: "center", lineHeight: 22 },

  // Liste: Hero hat eigenen Margin-Bottom (16), CardRows haben 10 marginBottom
  // → daher kein gap auf Container-Ebene.
  list: { paddingBottom: 24 },
  ghost: { position: "absolute", left: 0, right: 0 },

  // === Hero-Card (nächste Abfahrt mit Ring-Countdown) ===
  hero: {
    marginBottom: 16,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 24,
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  heroRing: { width: 84, height: 84, position: "relative" },
  heroRingCenter: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  heroRingMin: {
    color: C.white,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 28,
  },
  // Drei bzw. vier Ziffern: Der Abstand zum Ring bleibt etwa der von zweien.
  heroRingMinSm: { fontSize: 20, lineHeight: 22, letterSpacing: -0.4 },
  heroRingMinXs: { fontSize: 16, lineHeight: 18, letterSpacing: -0.3 },
  heroRingLabel: { color: C.g2, fontSize: 10, fontWeight: "600" },
  heroRingDay: {
    color: C.white,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  heroBody: { flex: 1, minWidth: 0 },
  heroBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  // Rechts außen in der Plakettenzeile; die negative Kante gleicht die
  // Tippfläche (28) an die Höhe der Plakette an, damit die Zeile nicht wächst.
  heroLive: { marginLeft: "auto", marginVertical: -2, marginRight: -4 },
  heroNextLabel: {
    color: C.g2,
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.4,
  },
  heroDest: {
    color: C.white,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.4,
    marginBottom: 4,
  },
  heroSub: { color: C.g2, fontSize: 13, fontWeight: "500" },

  // === „Danach"-Section-Header ===
  danachLabel: {
    color: C.g2,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    marginBottom: TITLE_GAP,
    marginTop: 4,
  },

  // === Card-Row für die weiteren Abfahrten ===
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.surface2,
    borderRadius: 20,
    paddingVertical: 16,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  cardTime: { width: 58, flexShrink: 0 },
  cardDay: {
    color: C.g2,
    fontSize: 11,
    fontWeight: "600",
  },
  cardTimeText: {
    color: C.white,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  cardTimeStrike: {
    color: C.g2,
    textDecorationLine: "line-through",
    textDecorationColor: C.g3,
  },
  cardTimeReal: {
    color: ACCENT_DELAY,
    fontSize: 13,
    fontWeight: "700",
    marginTop: 4,
  },
  // Linien-Plakette mit Symbol — gleicher Look in Hero und Cards
  // (DRY: Badge-Style ist shared zwischen NextHero + StopBoardRow).
  // backgroundColor/borderColor inline: die Farbe der Verkehrsart (`lineColor`).
  cardLineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  // color inline: weiß wie auf den Kästen der Karte.
  cardLineBadgeText: {
    fontSize: 13,
    fontWeight: "700",
  },
  cardRight: { flex: 1, minWidth: 0 },
  cardDirection: {
    color: C.white,
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.2,
  },
  cardPlatform: { color: C.g2, fontSize: 12, fontWeight: "500", marginTop: 4 },
});
