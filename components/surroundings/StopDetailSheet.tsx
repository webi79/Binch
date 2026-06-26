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
import { useSearchStore, type SelectedStop } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import type { MarkerKind } from "@/lib/surroundings/mockData";
import { registerStopSheetAnimation } from "./stopSheetAnimation";
import { stopToLocation } from "@/lib/surroundings/savedStation";
import { haptic } from "@/lib/haptics";
import { showConnectionNotFound } from "@/lib/connectionNotFoundAlert";
import type { SearchResult, TravelMode } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";

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

// Surface-Stack: bg → surface2 (Cards) → surface3 (Pressed-State). border
// rahmt Hero-Card subtil ein. Gleiche Werte wie in ClearSearchHistoryAlert
// + RecentHistoryOverlay damit das Material konsistent ist.
const C = {
  bg: "#1F1F20",
  surface2: "#242425",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  white: "#FFFFFF",
  g1: "#C4C4C8",
  g2: "#8A8A90",
  g3: "#56565C",
};
// Akzent-Tokens kommen jetzt aus useAccent() — die Hard-Coded LIME-/SUBTLE-/
// BORDER-Werte sind raus damit die Slide automatisch die User-Wahl
// (Lime/Mint/Iris) erbt. Components die im StyleSheet noch statisch waren,
// nutzen jetzt inline-style mit accent.* statt diesen Konstanten.
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("de-DE", TIME_FORMAT_OPTS);
}

/** ISO-Zeit + Delay-Minuten → tatsächliche Abfahrtszeit als „HH:MM"-String.
 *  Wird unter der durchgestrichenen Planzeit angezeigt wenn die Abfahrt
 *  verspätet ist. */
function addDelayToTime(iso: string, delayMin: number): string {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + delayMin);
  return d.toLocaleTimeString("de-DE", TIME_FORMAT_OPTS);
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

/** Kleines Walk-Männchen für die Subtitle-Zeile (Distanz zum Stop).
 *  Lucide hat kein Walking-Person-Icon, daher inline-SVG. Form orientiert sich
 *  an der WerlAbfahrten-Vorlage: kleiner Kopf-Kreis, Körper als Strich-Pfade
 *  für Beine/Arme. strokeLinecap=round damit das Männchen bei 14px-Größe
 *  weich aussieht und nicht pixelig. */
function WalkIcon({ size = 14, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={13} cy={4.5} r={1.6} fill={color} />
      <Path
        d="M11 9l-2.5 2 1 4M11 9l3 1 1.5 3M11 9l-1 5-2 5M12.5 18l1.5 3"
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Pro Departure das passende Mode-Icon im Line-Badge. Greift HAFAS-Produkte
 *  ab — alles was nicht Bus/Tram/Flight/Ferry ist landet auf Train (Default
 *  für regional/national/suburban/subway/…). */
function iconForProduct(product: string | null): LucideIcon {
  if (!product) return Train;
  const p = product.toLowerCase();
  if (/bus|coach/.test(p)) return Bus;
  if (/tram|stadtbahn/.test(p)) return TramFront;
  if (/flight|air/.test(p)) return Plane;
  if (/ferry|ship/.test(p)) return Ship;
  return Train;
}

/** Card-Row im neuen Hero-Design — eine Departure pro Card.
 *  Layout: Zeit-Block links (Plan + ggf. Real durchgestrichen), Lime-Line-
 *  Badge in der Mitte, Direction + Platform rechts. Anti-Patterns die ich
 *  vermieden habe: keine Border (sonst wirkt's bei vielen Cards untereinander
 *  unruhig), keine Underline auf Time damit das Strikethrough für Delay
 *  eindeutig ist. */
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
  const accent = useAccent();
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product);
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.cardRow, pressed ? styles.cardRowPressed : null]}
    >
      {/* Zeit-Block: Planzeit oben, bei Delay durchgestrichen + Real-Zeit
          in Delay-Farbe darunter. Pünktlich → nur Planzeit, kein zweiter
          Eintrag (vermeidet redundantes Doppel-Time). */}
      <View style={styles.cardTime}>
        <Text
          style={[
            styles.cardTimeText,
            delay > 0 ? styles.cardTimeStrike : null,
          ]}
        >
          {formatTime(item.plannedTime)}
        </Text>
        {delay > 0 && (
          <Text style={styles.cardTimeReal}>
            {addDelayToTime(item.plannedTime, delay)}
          </Text>
        )}
      </View>

      {/* Accent-tinted Line-Badge mit Mode-Icon (Train/Bus/Tram etc.) */}
      <View style={[styles.cardLineBadge, { backgroundColor: accent.subtle, borderColor: accent.border }]}>
        <ModeIcon size={14} color={accent.solid} strokeWidth={2.2} />
        <Text style={[styles.cardLineBadgeText, { color: accent.solid }]} numberOfLines={1}>
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
        <ActivityIndicator color={C.g1} size="small" style={{ marginLeft: 6 }} />
      ) : null}
    </Pressable>
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
  fetchedAt,
  platformPrefix,
  nextLabel,
  ontimeLabel,
  loading,
  onPress,
}: {
  item: StopBoardItem;
  fetchedAt: string | undefined;
  platformPrefix: string;
  nextLabel: string;
  ontimeLabel: string;
  loading: boolean;
  onPress: () => void;
}) {
  const accent = useAccent();
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product);

  // Live-Ticker: alle 1 s neu rendern damit Ring sekundengenau wandert.
  // Nur aktiv wenn das Sheet WIRKLICH offen ist (selectedStop != null) —
  // sonst tick't das Interval auch nach Slide-Out weiter (displayStop hält
  // den Stop für die Animation noch fest → NextHero bleibt gemountet) und
  // erzeugt 1 Re-Render pro Sekunde im Hintergrund.
  const sheetOpen = useSearchStore((s) => s.selectedStop !== null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!sheetOpen) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
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
  const realTime = delay > 0 ? addDelayToTime(item.plannedTime, delay) : formatTime(item.plannedTime);
  const subText = delay > 0
    ? `${realTime} · +${delay} Min${item.platform ? ` · ${platformPrefix} ${item.platform}` : ""}`
    : `${realTime} · ${ontimeLabel}${item.platform ? ` · ${platformPrefix} ${item.platform}` : ""}`;
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.hero, pressed ? styles.heroPressed : null]}
    >
      <View style={styles.heroRing}>
        <Svg width={84} height={84} viewBox="0 0 84 84">
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
          <Text style={styles.heroRingMin}>{mins}</Text>
          <Text style={styles.heroRingLabel}>Min</Text>
        </View>
      </View>

      <View style={styles.heroBody}>
        <View style={styles.heroBadgeRow}>
          <View style={[styles.cardLineBadge, { backgroundColor: accent.subtle, borderColor: accent.border }]}>
            <ModeIcon size={14} color={accent.solid} strokeWidth={2.2} />
            <Text style={[styles.cardLineBadgeText, { color: accent.solid }]} numberOfLines={1}>
              {item.line}
            </Text>
          </View>
          <Text style={styles.heroNextLabel}>{nextLabel}</Text>
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
  const accent = useAccent();

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
    // Trip-Detail-Flow statt Booking-Flow für:
    //   - BUS (alle Stadtbusse — ÖPNV ohne Online-Buchung)
    //   - U-Bahn/S-Bahn/Tram (gleiche Logik — Verbund-Tarif)
    //   - Nicht-DE Stops (unsere Booking-Suche kann die nicht handhaben)
    // Übrig bleibt: DE National/Regional Trains → Booking-Flow mit
    // DB-Navigator-Deeplink-Support.
    const useDirectTripFlow =
      mode === "BUS" ||
      isLocalTransitProduct(item.product) ||
      !isDeStop(stop.code);
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
          const detail = await fetchTripDetail(item.id, {
            fromStopId,
            // Label als Fallback, falls die ID nicht in den Trip-Stopovers
            // matched (BVG/VBB-Bus-Stops haben oft uneindeutige IDs zwischen
            // unserem Resolver und HAFAS-Trip-Body).
            fromStopLabel: stop.label,
            stopCode: stop.code,
            // Board-Direction mitgeben damit das Trip-Detail dieselbe
            // Destination zeigt wie die Card die der User getappt hat.
            // HAFAS' trip.direction weicht manchmal vom Board-Direction
            // ab (M21 Berlin: Board zeigt „Charlottenburg, Goerdelersteg",
            // trip.direction ist „S+U Jungfernheide").
            direction: item.direction,
          });
          const result = tripDetailToSearchResult(detail);
          openDirectTrip(result);
        } catch {
          // Mode mitschicken (BUS in diesem Branch) damit „Zur Suche" direkt
          // den Bus-Tab öffnet, nicht irgendeine Suche.
          showConnectionNotFound({ mode });
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
        // BUS-Mode kommt hier nicht an (wird oben kurzgeschlossen), also
        // TRAIN/FLIGHT. Mode mitschicken damit „Zur Suche" direkt den
        // jeweiligen Tab öffnet.
        showConnectionNotFound({ mode });
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
                  const sub = [dist, venue].filter(Boolean).join(" · ");
                  if (!sub) return null;
                  return (
                    <View style={styles.headerSubtitleRow}>
                      <WalkIcon size={14} color={C.g1} />
                      <Text style={styles.headerSubtitle}>{sub}</Text>
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

            {/* Mode-Pillen (nur bei multi-modalen Stops sichtbar). Flat-Style:
                Aktiv = Lime-Bg + schwarzer Text, Inaktiv = transparent + weißer
                Text + grauer Border. Kein Color-Coding pro Mode mehr — das war
                visuell zu viel im engen Sheet-Header. */}
            {bodyReady && kinds.length >= 2 && (
              <View style={styles.pillsRow}>
                {kinds.map((k) => {
                  const style = KIND_STYLE[k];
                  const Icon = KIND_ICON[k];
                  if (!Icon || !style) return null;
                  const active = activeKind === k;
                  return (
                    <Pressable
                      key={k}
                      onPress={() => setActiveKind(k)}
                      style={[
                        styles.pill,
                        active
                          ? [styles.pillActive, { backgroundColor: accent.solid, borderColor: accent.solid }]
                          : styles.pillInactive,
                      ]}
                    >
                      <Icon size={17} color={active ? accent.textOnSolid : C.white} strokeWidth={2.2} />
                      <Text style={[
                        styles.pillText,
                        active ? [styles.pillTextActive, { color: accent.textOnSolid }] : styles.pillTextInactive,
                      ]}>
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
                      {active && <View style={[styles.tabUnderline, { backgroundColor: accent.solid }]} />}
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
                  {/* Hero = nächste Abfahrt mit Countdown-Ring. „Danach"-Label
                      nur rendern wenn es noch weitere Items gibt, sonst wirkt
                      die Section-Headline einsam. */}
                  <NextHero
                    item={items[0]!}
                    fetchedAt={data?.fetchedAt}
                    platformPrefix={t("stop.platform.prefix")}
                    nextLabel={t("stop.section.next")}
                    ontimeLabel={t("stop.section.ontime")}
                    loading={loadingDepartureId === items[0]!.id}
                    onPress={() => onSelectDeparture(items[0]!)}
                  />
                  {items.length > 1 && (
                    <Text style={styles.danachLabel}>{t("stop.section.later")}</Text>
                  )}
                  {items.slice(1, 6).map((it, i) => (
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
  // Row mit Walk-Icon + Text. marginTop fängt den Abstand zum Title; das Icon
  // sitzt vertikal zentriert zum 14pt-Text durch alignItems:"center".
  headerSubtitleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  headerSubtitle: { color: C.g1, fontSize: 14, fontWeight: "500" },
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
    gap: 9,
    paddingVertical: 12,
    borderRadius: 9999,
    borderWidth: 1.5,
  },
  // backgroundColor/borderColor werden inline mit accent.solid gesetzt.
  pillActive: {},
  pillInactive: { backgroundColor: "transparent", borderColor: C.border },
  pillText: { fontSize: 15, fontWeight: "700", letterSpacing: -0.15 },
  pillTextActive: { color: "#000" },
  pillTextInactive: { color: C.white },

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
  // backgroundColor inline mit accent.solid gesetzt.
  tabUnderline: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    borderRadius: 2,
  },

  body: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  empty: { alignItems: "center", paddingTop: 32, paddingHorizontal: 24 },
  emptyTitle: { color: C.white, fontSize: 18, fontWeight: "700", textAlign: "center" },
  emptyBody: { color: C.g1, fontSize: 15, marginTop: 6, textAlign: "center", lineHeight: 22 },

  // Liste: Hero hat eigenen Margin-Bottom (16), CardRows haben 10 marginBottom
  // → daher kein gap auf Container-Ebene.
  list: { paddingBottom: 24 },

  // === Hero-Card (nächste Abfahrt mit Ring-Countdown) ===
  hero: {
    marginBottom: 18,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 24,
    paddingVertical: 18,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  heroPressed: { backgroundColor: C.surface3, opacity: 0.92 },
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
  heroRingLabel: { color: C.g2, fontSize: 10, fontWeight: "600" },
  heroBody: { flex: 1, minWidth: 0 },
  heroBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
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
    marginBottom: 10,
    marginTop: 4,
  },

  // === Card-Row für die weiteren Abfahrten ===
  cardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.surface2,
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  cardRowPressed: { backgroundColor: C.surface3, opacity: 0.92 },
  cardTime: { width: 58, flexShrink: 0 },
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
    marginTop: 2,
  },
  // Lime-Tinted Badge mit Mode-Icon — gleicher Look in Hero und Cards
  // (DRY: Badge-Style ist shared zwischen NextHero + StopBoardRow).
  // backgroundColor/borderColor inline mit accent.subtle / accent.border.
  cardLineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 5,
    flexShrink: 0,
  },
  // color inline mit accent.solid.
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
  cardPlatform: { color: C.g2, fontSize: 12, fontWeight: "500", marginTop: 3 },
});
