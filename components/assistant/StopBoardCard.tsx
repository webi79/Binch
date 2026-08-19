/**
 * Inline-Variante der StopDetailSheet für den Chat. Anders als das Sheet
 * öffnet sich hier kein Slide — die Karte sitzt als statisches Element im
 * Chat-Verlauf und zeigt:
 *   - Tab-Switcher (Abfahrten | Ankünfte)
 *   - Hero: Nächste Abfahrt mit Countdown-Ring + Linie + Ziel + Zeit
 *   - Kompakte Liste der nächsten ~6 Treffer
 *
 * Daten kommen direkt von /api/stops/:code/{departures|arrivals} (gleiche
 * Endpoints die das Sheet auch nutzt). Tab-Switch löst einen neuen Fetch
 * aus — kein Chat-Roundtrip nötig.
 *
 * Bewusst NICHT übernommen vom Sheet: Gestures, Trip-Detail-Navigation,
 * Map-Marker-Kontext. Im Chat tappt der User nur — wer Details will, sucht
 * die Verbindung über Bo direkt oder im Search-Tab.
 */
import { memo, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "@react-navigation/native";
import { useSearchStore } from "@/stores/searchStore";
import { openStopSheet } from "@/components/surroundings/stopSheetAnimation";
import { haptic } from "@/lib/haptics";
import { useNowTicker } from "@/lib/ui/nowTicker";
import Svg, { Circle } from "react-native-svg";
import { Plane, Train, Bus, Ship, ChevronRight, type LucideIcon } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import {
  fetchStopDepartures,
  fetchStopArrivals,
  type StopBoardItem,
  type StopBoardResponse,
} from "@/lib/api/client";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  card: "#1F1F20",
  cardAlt: "#242425",
  border: "#2E2E30",
  text: "#FFFFFF",
  sub: "#8A8A90",
  subDim: "#56565C",
  delay: "#FF7A6B",
};

type BoardKind = "departures" | "arrivals";

interface Props {
  stop: { code: string; label: string };
  initialBoard: BoardKind;
  /** Vom Server bereits geladene Tafel — spart die eigene Abfrage. */
  initialData?: StopBoardResponse;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function addDelayToTime(iso: string, delayMin: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  d.setMinutes(d.getMinutes() + delayMin);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function iconForProduct(product: string | null): LucideIcon {
  const p = (product ?? "").toLowerCase();
  if (p.includes("bus")) return Bus;
  if (p.includes("ferry") || p.includes("cruise")) return Ship;
  if (p.includes("flight") || p.includes("plane")) return Plane;
  return Train;
}

function StopBoardCardInner({ stop, initialBoard, initialData }: Props) {
  const accent = useAccent();
  const t = useT();
  const palette = usePalette();
  const [board, setBoard] = useState<BoardKind>(initialBoard);

  // useQuery mit per-Board-Key — Tab-Switch lädt aus Cache wenn schon
  // gefetcht, sonst frischer Call. 30s staleTime damit der User keine
  // Refetches pro Re-Render bekommt.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["assistant.stopboard", stop.code, board],
    queryFn: () =>
      board === "departures" ? fetchStopDepartures(stop.code) : fetchStopArrivals(stop.code),
    staleTime: 30_000,
    /**
     * Was der Server schon geholt hat, wird nicht noch einmal geholt.
     *
     * Der Chat-Agent lädt die Tafel inzwischen selbst — er muss sie lesen
     * können, um „wann fährt der nächste Zug" zu beantworten. Diese Zeilen
     * kommen mit der Nachricht mit; ohne sie hier einzusetzen, liefe für
     * dieselbe Tafel eine ZWEITE Abfrage nach oben, und daran hängt das
     * DB-Kontingent von 60 Anfragen pro Minute.
     *
     * Nur für die Richtung, die der Server geladen hat — der Wechsel auf die
     * andere Registerkarte holt wie bisher frisch.
     */
    initialData: board === initialBoard ? initialData : undefined,
    initialDataUpdatedAt: initialData ? Date.now() : undefined,
  });

  const items = data?.results ?? [];
  const first = items[0];

  const tabLabel = (kind: BoardKind) =>
    kind === "departures" ? t("stop.tab.departures") : t("stop.tab.arrivals");

  return (
    <View style={[styles.card, { backgroundColor: palette.s1, borderColor: palette.border }]}>
      {/**
        * Kopfzeile ÖFFNET das Halt-Blatt — das war das einzige Element im Chat,
        * das auf einen Tipp nicht reagiert hat.
        *
        * Dasselbe Blatt wie auf der Karte: Es liegt global im Wurzel-Layout,
        * also auch über Bo. Die Bewegung wird im Berührungs-Bild angestoßen
        * (`openStopSheet` läuft auf dem UI-Strang), der Inhalt parallel über den
        * Speicher — genau der Weg, den der Marker-Tipp auf der Karte nimmt.
        */}
      <Pressable
        onPress={() => {
          haptic("button");
          useSearchStore.getState().selectStop({ code: stop.code, label: stop.label });
          openStopSheet();
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        accessibilityRole="button"
        accessibilityLabel={stop.label}
      >
        <View style={styles.headRow}>
          <Text style={styles.stopLabel} numberOfLines={1}>
            {stop.label}
          </Text>
          <ChevronRight size={18} color={C.sub} strokeWidth={2.2} />
        </View>
      </Pressable>

      {/* Tab-Switcher Departures / Arrivals */}
      <View style={styles.tabs}>
        {(["departures", "arrivals"] as const).map((kind) => {
          const on = board === kind;
          return (
            <Pressable
              key={kind}
              onPress={() => setBoard(kind)}
              style={[
                styles.tab,
                { backgroundColor: palette.s2, borderColor: palette.border },
                on && { backgroundColor: accent.subtle, borderColor: accent.border },
              ]}
            >
              <Text style={[styles.tabText, { color: on ? accent.solid : C.sub }]}>
                {tabLabel(kind)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={accent.solid} size="small" />
        </View>
      ) : isError ? (
        <Text style={styles.emptyText}>{t("assistant.error.generic")}</Text>
      ) : items.length === 0 ? (
        <Text style={styles.emptyText}>
          {board === "departures" ? t("stop.empty.departures.title") : t("stop.empty.arrivals.title")}
        </Text>
      ) : (
        <>
          {first && (
            <Hero item={first} accentSolid={accent.solid} fetchedAt={data?.fetchedAt} />
          )}
          {/* Liste der nächsten ~5 weiteren — schon ohne first */}
          {items.slice(1, 6).map((item) => (
            <Row key={item.id} item={item} accentSolid={accent.solid} accentSubtle={accent.subtle} accentBorder={accent.border} />
          ))}
        </>
      )}
    </View>
  );
}

function Hero({
  item,
  accentSolid,
  fetchedAt,
}: {
  item: StopBoardItem;
  accentSolid: string;
  fetchedAt: string | undefined;
}) {
  const palette = usePalette();
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product);
  const isFocused = useIsFocused();

  const expectedMs = Date.parse(item.plannedTime) + delay * 60_000;
  /**
   * Countdown über den GEMEINSAMEN Zeitgeber, und nur solange es etwas zu
   * zählen gibt.
   *
   * Der Riegel auf den Fokus war richtig, aber zu kurz gegriffen: Er hielt das
   * Zählen im Hintergrund an, nicht aber im Vordergrund — und dort bleibt jede
   * jemals abgefragte Tafel im Verlauf gemountet. Bei zehn Stationen liefen
   * zehn eigene Sekunden-Zeitgeber, jeder mit eigenem Zustand und eigenem
   * SVG-Render. Das wächst mit jeder Frage an Bo.
   *
   * Der zweite Riegel ist die Abfahrt selbst: Ist sie über eine Minute durch,
   * steht die Anzeige ohnehin fest (0 Min, Ring voll). Weiterzurechnen ändert
   * dann nichts mehr.
   */
  const ticking = isFocused && Date.now() - expectedMs < 60_000;
  const ticked = useNowTicker(ticking);
  /**
   * Läuft nicht mitgezählt, wird frisch abgelesen.
   *
   * Sonst hängen die beiden Zeilen darüber schief zueinander: Der Riegel prüft
   * gegen die echte Uhr, die Anzeige rechnete mit dem letzten Takt. Wer die
   * Karte um 10:01 verlässt und um 10:40 zurückkommt, hat einen abgefahrenen
   * Zug — der Riegel greift korrekt, aber die Anzeige stand noch auf 10:01 und
   * behauptete „in 4 Min". Mit der echten Uhr kommt heraus, was der Kommentar
   * beim Riegel ohnehin annimmt: 0 Min, Ring voll.
   */
  const now = ticking ? ticked : Date.now();
  const mins = Math.max(0, Math.ceil((expectedMs - now) / 60_000));
  const baselineMs = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  const baseline = Number.isFinite(baselineMs) ? baselineMs : now;
  const totalMs = Math.max(1_000, expectedMs - baseline);
  const elapsedMs = now - baseline;
  const frac = Math.min(1, Math.max(0, elapsedMs / totalMs));

  const RING_R = 28;
  const CIRC = 2 * Math.PI * RING_R;
  const realTime =
    delay > 0 ? addDelayToTime(item.plannedTime, delay) : formatTime(item.plannedTime);
  const subText =
    delay > 0
      ? `${realTime} · +${delay} Min${item.platform ? ` · ${item.platform}` : ""}`
      : `${realTime}${item.platform ? ` · ${item.platform}` : ""}`;

  return (
    <View style={[styles.hero, { backgroundColor: palette.s2 }]}>
      <View style={styles.heroRing}>
        <Svg width={70} height={70} viewBox="0 0 70 70">
          <Circle cx={35} cy={35} r={RING_R} fill="none" stroke={C.border} strokeWidth={5} />
          <Circle
            cx={35}
            cy={35}
            r={RING_R}
            fill="none"
            stroke={accentSolid}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - frac)}
            transform="rotate(-90 35 35)"
          />
        </Svg>
        <View style={styles.heroRingCenter} pointerEvents="none">
          <Text style={styles.heroRingMin}>{mins}</Text>
          <Text style={styles.heroRingLabel}>Min</Text>
        </View>
      </View>

      <View style={styles.heroBody}>
        <View style={styles.heroBadgeRow}>
          <ModeIcon size={13} color={accentSolid} strokeWidth={2.2} />
          <Text style={[styles.heroLine, { color: accentSolid }]} numberOfLines={1}>
            {item.line}
          </Text>
        </View>
        <Text style={styles.heroDest} numberOfLines={1}>
          {item.direction || "—"}
        </Text>
        <Text
          style={[styles.heroSub, delay > 0 && { color: C.delay }]}
          numberOfLines={1}
        >
          {subText}
        </Text>
      </View>
    </View>
  );
}

function Row({
  item,
  accentSolid,
  accentSubtle,
  accentBorder,
}: {
  item: StopBoardItem;
  accentSolid: string;
  accentSubtle: string;
  accentBorder: string;
}) {
  const delay = item.delayMinutes ?? 0;
  const ModeIcon = iconForProduct(item.product);
  return (
    <View style={styles.row}>
      <View style={styles.rowTime}>
        <Text style={[styles.rowTimeText, delay > 0 && styles.rowTimeStrike]}>
          {formatTime(item.plannedTime)}
        </Text>
        {delay > 0 && (
          <Text style={[styles.rowTimeReal, { color: C.delay }]}>
            {addDelayToTime(item.plannedTime, delay)}
          </Text>
        )}
      </View>
      <View style={[styles.rowLineBadge, { backgroundColor: accentSubtle, borderColor: accentBorder }]}>
        <ModeIcon size={11} color={accentSolid} strokeWidth={2.2} />
        <Text style={[styles.rowLineBadgeText, { color: accentSolid }]} numberOfLines={1}>
          {item.line}
        </Text>
      </View>
      <Text style={styles.rowDirection} numberOfLines={1}>
        {item.direction || "—"}
      </Text>
    </View>
  );
}

export const StopBoardCard = memo(
  StopBoardCardInner,
  (prev, next) => prev.stop.code === next.stop.code && prev.initialBoard === next.initialBoard,
);

const styles = scaledStyles({
  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    gap: 10,
  },
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  stopLabel: {
    // Nimmt den Platz neben dem Pfeil — sonst schiebt ein langer Name ihn raus.
    flex: 1,
    color: C.text,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.2,
  },

  tabs: { flexDirection: "row", gap: 6 },
  tab: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 9999,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
  },
  tabText: { fontSize: 12, fontWeight: "600" },

  loadingWrap: { paddingVertical: 24, alignItems: "center" },
  emptyText: {
    color: C.sub,
    fontSize: 13,
    paddingVertical: 16,
    textAlign: "center",
  },

  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: C.cardAlt,
    borderRadius: 14,
    padding: 10,
  },
  heroRing: {
    width: 70,
    height: 70,
    alignItems: "center",
    justifyContent: "center",
  },
  heroRingCenter: { position: "absolute", alignItems: "center", justifyContent: "center" },
  heroRingMin: { color: C.text, fontSize: 20, fontWeight: "800" },
  heroRingLabel: { color: C.sub, fontSize: 9, letterSpacing: 0.6, marginTop: -2 },
  heroBody: { flex: 1, gap: 3 },
  heroBadgeRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  heroLine: { fontSize: 13, fontWeight: "700" },
  heroDest: { color: C.text, fontSize: 14, fontWeight: "600" },
  heroSub: { color: C.sub, fontSize: 12 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  rowTime: { width: 52, gap: 1 },
  rowTimeText: { color: C.text, fontSize: 13, fontWeight: "600" },
  rowTimeStrike: { textDecorationLine: "line-through", color: C.subDim },
  rowTimeReal: { fontSize: 11, fontWeight: "600" },
  rowLineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 9999,
    borderWidth: 1,
    minWidth: 48,
    justifyContent: "center",
  },
  rowLineBadgeText: { fontSize: 11, fontWeight: "700" },
  rowDirection: { flex: 1, color: C.sub, fontSize: 12 },
});
