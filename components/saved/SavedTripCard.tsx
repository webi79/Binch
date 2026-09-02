/**
 * SavedTripCard — Ultra-leichte Card für den Saved-Tab.
 *
 * Speziell schlank gehalten weil native bottom tabs den Saved-Tab nach dem
 * ersten Besuch PERMANENT mounted halten. ResultCard hat viele Reanimated-
 * Hooks, useQueryClient, useRouter etc — bei mehreren Cards akkumuliert
 * das genug Overhead um Landing-Scroll spürbar zu verlangsamen.
 *
 * Hier: NUR React-Native-View + Text + Pressable, kein Reanimated, kein
 * QueryClient, kein Router (Actions via `useSearchStore.getState()`).
 */

import { memo, useMemo } from "react";
import { preloadDetails } from "@/lib/nav/detailsPreload";
import { startDetailsPush } from "@/lib/nav/overlayCover";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { Heart, Plane, Train, Bus, Ship, ChevronRight } from "lucide-react-native";
import type { SavedTrip } from "@/types/saved";
import type { TravelMode } from "@/types/search";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { formatTimeInZone, formatDateInZone } from "@/lib/time-format";
import { displayCode } from "@/lib/results/logos";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  card: "#171719",
  border: "#212123",
  text: "#F4F4F5",
  sub: "#8E8E93",
  subDim: "#56565C",
  black: "#000000",
};

const MODE_ICON = { FLIGHT: Plane, TRAIN: Train, BUS: Bus, CRUISE: Ship };
const MODE_COLOR: Record<TravelMode, { bg: string; fg: string }> = {
  FLIGHT: { bg: "#7FEA4D", fg: "#000000" },
  TRAIN: { bg: "#FFD60A", fg: "#000000" },
  BUS: { bg: "#9D5FE0", fg: "#FFFFFF" },
  CRUISE: { bg: "#6B95B5", fg: "#FFFFFF" },
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

interface Props {
  trip: SavedTrip;
}

function SavedTripCardInner({ trip }: Props) {
  const palette = usePalette();
  const t = useT();
  const accent = useAccent();
  const ModeIcon = MODE_ICON[trip.mode] ?? Plane;
  const modeColor = MODE_COLOR[trip.mode];

  // Alle abgeleiteten Werte einmalig pro Trip berechnen.
  const { departStr, arriveStr, dateStr, originLabel, destLabel, stopLabel } =
    useMemo(() => {
      const dep = trip.dateOnly
        ? "—"
        : formatTimeInZone(trip.departTime, trip.originTz);
      const arr = trip.dateOnly
        ? "—"
        : formatTimeInZone(trip.arriveTime, trip.destinationTz);
      const date = formatDateInZone(trip.departTime, trip.originTz);
      const origCode = trip.mode === "FLIGHT" ? displayCode(trip.origin) : "";
      const destCode = trip.mode === "FLIGHT" ? displayCode(trip.destination) : "";
      const origin =
        origCode || trip.originLabel?.split(",")[0]?.trim() || trip.origin;
      const dest =
        destCode || trip.destLabel?.split(",")[0]?.trim() || trip.destination;
      const stops =
        trip.stops === 0
          ? t("details.stop.zero")
          : trip.stops === 1
          ? t("details.stop.one")
          : t("details.stop.many").replace("{count}", String(trip.stops));
      return {
        departStr: dep,
        arriveStr: arr,
        dateStr: date,
        originLabel: origin,
        destLabel: dest,
        stopLabel: stops,
      };
    }, [trip, t]);

  const onTap = () => {
    haptic("important");
    // Bewegung zuerst, Speicher ein Bild danach — dieselbe Begründung wie an
    // der Ergebnis-Karte: Der Commit läuft synchron zu Ende, die Bewegung wird
    // nur eingereiht. Ohne den Abstand steht der Aufbau des Detail-Blattes vor
    // ihr statt neben ihr.
    startDetailsPush();
    requestAnimationFrame(() => {
      useSearchStore.getState().selectResult(trip, trip.passengers ?? 1);
    });
  };

  const onUnsave = () => {
    haptic("button");
    useSearchStore.getState().toggleSavedTrip(trip, trip.passengers ?? 1);
  };

  return (
    <View style={[styles.card, { backgroundColor: palette.s2 }]}>
      <View style={styles.headerRow}>
        <View style={[styles.modeBadge, { backgroundColor: modeColor.bg }]}>
          <ModeIcon color={modeColor.fg} size={16} />
        </View>
        <Text style={styles.provider} numberOfLines={1}>
          {trip.provider}
        </Text>
        <Pressable onPress={onUnsave} hitSlop={10} style={styles.heartBtn}>
          <Heart color="#FF3B5C" fill="#FF3B5C" size={18} />
        </Pressable>
      </View>

      <View style={styles.timeRow}>
        <Text style={styles.timeBig}>{departStr}</Text>
        <View style={styles.middle}>
          <Text style={styles.duration}>{formatDuration(trip.durationMinutes)}</Text>
          <View style={styles.lineWrap}>
            <View style={[styles.dot, { backgroundColor: accent.solid }]} />
            <View style={styles.line} />
            <View style={[styles.dot, { backgroundColor: accent.solid }]} />
          </View>
          <Text style={styles.stops} numberOfLines={1}>
            {stopLabel}
          </Text>
        </View>
        <Text style={[styles.timeBig, { textAlign: "right" }]}>{arriveStr}</Text>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.metaCol}>
          <Text style={styles.metaCode} numberOfLines={1}>
            {originLabel}
          </Text>
          <Text style={styles.metaDate}>{dateStr}</Text>
        </View>
        <View style={[styles.metaCol, { alignItems: "flex-end" }]}>
          <Text style={[styles.metaCode, { textAlign: "right" }]} numberOfLines={1}>
            {destLabel}
          </Text>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.footerRow}>
        <Text style={[styles.priceText, { color: accent.solid }]}>
          <Text style={styles.priceLabel}>{t("results.from")} </Text>
          {trip.price.toFixed(0)}
          <Text style={styles.priceCurrency}>  {trip.currency.toUpperCase()}</Text>
        </Text>
        <Pressable
          /**
           * Die Textur des Reiters entsteht beim AUFSETZEN des Fingers.
           *
           * Sie fehlte hier VOLLSTÄNDIG — als einziger der Wege in ein
           * Detail-Blatt. Der Saved-Reiter wurde damit während der ganzen
           * Bewegung jedes Bild neu gezeichnet, während er als Unterlage
           * mitwandert. Das ist der Unterschied zum Landingscreen, wo es
           * funktioniert: Dort wird sie angefordert, hier nicht.
           *
           * `onTouchStart` und nicht `onPressIn`: Die Karte liegt in einer
           * Liste, und ein Druck-Beginn dort wird oft ein Scrollen. Das reine
           * Berührungs-Ereignis beansprucht die Geste nicht.
           */
          onTouchStart={() => {
            prepareLayer("saved");
            // Detail-Blatt im Berührungsfenster bauen, nicht im Loslass-Bild.
            preloadDetails(trip);
          }}
          onPress={onTap}
          style={({ pressed }) => [
            styles.cta,
            { backgroundColor: accent.solid, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={styles.ctaText}>{t("results.select")}</Text>
          <ChevronRight color={C.black} size={14} strokeWidth={2.5} />
        </Pressable>
      </View>
    </View>
  );
}

// Memoized — re-rendert nur wenn der Trip-Object-Ref wechselt (durch
// savedTrips Array-Update mit dem gleichen Trip wäre derselbe Ref).
export const SavedTripCard = memo(SavedTripCardInner);

const styles = scaledStyles({
  card: {
    backgroundColor: C.card,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
    paddingVertical: 14,
    paddingHorizontal: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 12,
  },
  modeBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  provider: {
    flex: 1,
    color: C.text,
    fontSize: 14,
    fontWeight: "600",
  },
  heartBtn: { padding: 2 },
  timeRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  timeBig: {
    flex: 1,
    color: C.text,
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  middle: {
    flex: 1,
    alignItems: "center",
  },
  duration: { color: C.sub, fontSize: 11, fontWeight: "500" },
  lineWrap: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    paddingHorizontal: 4,
    marginTop: 2,
    marginBottom: 2,
  },
  dot: { width: 5, height: 5, borderRadius: 3 },
  line: { flex: 1, height: 1, backgroundColor: C.border, marginHorizontal: 2 },
  stops: { color: C.sub, fontSize: 11, fontWeight: "500" },
  metaRow: { flexDirection: "row", alignItems: "center" },
  metaCol: { flex: 1 },
  metaCode: { color: C.sub, fontSize: 12, fontWeight: "600" },
  metaDate: { color: C.subDim, fontSize: 11, fontWeight: "500", marginTop: 2 },
  divider: {
    height: 1,
    backgroundColor: C.border,
    marginVertical: 12,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  priceText: { fontSize: 18, fontWeight: "800" },
  priceLabel: { color: C.sub, fontSize: 11, fontWeight: "500" },
  priceCurrency: { color: C.sub, fontSize: 11, fontWeight: "500" },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  ctaText: { color: C.black, fontSize: 13, fontWeight: "700" },
});
