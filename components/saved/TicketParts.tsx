/**
 * Geteilte Bordkarten-Teile — werden vom TicketCard (Übersicht) und vom
 * TicketDetailOverlay (Detail-Slide) gemeinsam verwendet. Damit ist der
 * obere Teil der Bordkarte garantiert identisch in beiden Screens.
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import {
  Plane,
  TrainFront,
  Bus,
  Ship,
  type LucideIcon,
} from "lucide-react-native";
import { Ticket } from "@/types/saved";
import { TravelMode } from "@/types/search";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { formatTimeInZone } from "@/lib/time-format";
import { intlLocale } from "@/lib/i18n/intl";

const C = {
  bg: "#1A1A1A",
  surface: "#242425",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  dashed: "#3A3A3E",
  white: "#FFFFFF",
  gray200: "#C8C8CC",
  gray300: "#8A8A90",
  gray400: "#56565C",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: TrainFront,
  BUS: Bus,
  CRUISE: Ship,
};

function formatDuration(minutes: number | undefined): string {
  if (!minutes || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

interface StatItem {
  label: string;
  value: string;
}

/** Mode-spezifische Stats-Slots (3 Stück) — leere Slots zeigen "—". */
function statsForTicket(ticket: Ticket): StatItem[] {
  const seat = ticket.seat ?? "—";
  const wagon = ticket.wagon ?? "—";
  const carrierOrFlight = ticket.flightNumber ?? ticket.carrier ?? "—";
  const cls = ticket.travelClass ?? "—";
  switch (ticket.mode) {
    case "TRAIN":
      return [
        { label: "Wagen", value: wagon },
        { label: "Zug", value: carrierOrFlight },
        { label: "Sitz", value: seat },
      ];
    case "FLIGHT":
      return [
        { label: "Klasse", value: cls },
        { label: "Flug", value: carrierOrFlight },
        { label: "Sitz", value: seat },
      ];
    case "BUS":
      return [
        { label: "Reihe", value: wagon },
        { label: "Linie", value: carrierOrFlight },
        { label: "Sitz", value: seat },
      ];
    case "CRUISE":
      return [
        { label: "Deck", value: wagon },
        { label: "Kabine", value: seat },
        { label: "Klasse", value: cls },
      ];
  }
}

/** Buchungsreferenz: bookingRef > flightNumber > originalName > "—". */
export function bookingRefFor(ticket: Ticket): string {
  return (
    ticket.bookingRef ??
    ticket.flightNumber ??
    ticket.originalName?.replace(/\.pdf$/i, "") ??
    "—"
  );
}

/**
 * Oberer Teil der Bordkarte (Passagier, Zeiten, Timeline, Route, Buchungsref,
 * Stats). Identisch zwischen Card und Detail.
 */
export function TicketHead({ ticket }: { ticket: Ticket }) {
  const t = useT();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const Icon = MODE_ICON[ticket.mode];

  const departStr = useMemo(
    () =>
      ticket.departTime
        ? formatTimeInZone(ticket.departTime, ticket.originTz, intlLocale(locale))
        : "—",
    [ticket.departTime, ticket.originTz, locale],
  );
  const arriveStr = useMemo(
    () =>
      ticket.arriveTime
        ? formatTimeInZone(ticket.arriveTime, ticket.destinationTz, intlLocale(locale))
        : "—",
    [ticket.arriveTime, ticket.destinationTz, locale],
  );

  const stats = statsForTicket(ticket);
  const fromCity = ticket.fromCity ?? ticket.fromCode ?? "—";
  const toCity = ticket.toCity ?? ticket.toCode ?? "—";
  // Wenn der Parser keinen Station-Namen ausgelesen hat, fällt's auf den
  // Code zurück (z.B. "WRO" als Unter-Zeile) damit die Zeile nicht leer ist.
  const fromStation = ticket.fromStation ?? ticket.fromCode ?? "";
  const toStation = ticket.toStation ?? ticket.toCode ?? "";

  return (
    <View style={styles.headPad}>
      <View style={{ marginBottom: 16 }}>
        <Text style={styles.eyebrow}>{t("saved.ticket.passenger").toUpperCase()}</Text>
        <Text style={styles.passenger}>{ticket.passenger ?? "—"}</Text>
      </View>

      <View style={styles.timesRow}>
        <Text style={styles.timeSide}>{departStr}</Text>
        <Text style={styles.duration}>{formatDuration(ticket.durationMinutes)}</Text>
        <Text style={styles.timeSide}>{arriveStr}</Text>
      </View>

      <View style={styles.timeline}>
        <View style={[styles.dot, { backgroundColor: accent.solid }]} />
        <View style={styles.dash} />
        <View style={styles.glyph}>
          <Icon size={17} color={accent.solid} strokeWidth={1.8} />
        </View>
        <View style={styles.dash} />
        <View style={[styles.dot, { backgroundColor: C.dashed }]} />
      </View>

      <View style={styles.routeRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.city} numberOfLines={1}>
            {fromCity}
          </Text>
          {fromStation ? (
            <Text style={styles.station} numberOfLines={1}>
              {fromStation}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", flex: 1, marginLeft: 12 }}>
          <Text style={styles.city} numberOfLines={1}>
            {toCity}
          </Text>
          {toStation ? (
            <Text style={styles.station} numberOfLines={1}>
              {toStation}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={styles.divider} />

      <Text style={styles.eyebrow}>{t("saved.ticket.bookingRef").toUpperCase()}</Text>
      <Text style={styles.booking}>{bookingRefFor(ticket)}</Text>

      <View style={styles.statsRow}>
        {stats.map((s, i) => (
          <Fragment key={s.label}>
            {i > 0 && <View style={styles.statDivider} />}
            <View style={styles.stat}>
              <Text style={styles.eyebrow}>{s.label.toUpperCase()}</Text>
              <Text style={styles.statValue} numberOfLines={1}>
                {s.value}
              </Text>
            </View>
          </Fragment>
        ))}
      </View>
    </View>
  );
}

/** Perforations-Linie mit ausgestanzten Kerben an den Karten-Rändern. */
export function Perforation({ notchColor = C.bg }: { notchColor?: string }) {
  return (
    <View style={styles.perfWrap}>
      <View style={[styles.notch, styles.notchLeft, { backgroundColor: notchColor }]} />
      <View style={[styles.notch, styles.notchRight, { backgroundColor: notchColor }]} />
      <View style={styles.perfLine} />
    </View>
  );
}

/** Countdown-Fortschrittsbalken (0..1). */
export function ProgressBar({ value, fill }: { value: number; fill?: string }) {
  const accent = useAccent();
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <View style={styles.track}>
      <View
        style={[
          styles.fill,
          { width: `${pct}%`, backgroundColor: fill ?? accent.solid },
        ]}
      />
    </View>
  );
}

/**
 * Hook: berechnet live den Countdown bis zur Abfahrt. Tickt sekundengenau
 * solange das Ticket in der Zukunft liegt. Liefert formatierten Wert
 * + Progress 0..1 (relativ zu 24h vor Abfahrt = 0, Abfahrt = 1).
 */
export function useDepartureCountdown(departTime?: string) {
  const [now, setNow] = useState(() => Date.now());
  const departMs = useMemo(() => {
    if (!departTime) return null;
    const t = Date.parse(departTime);
    return Number.isFinite(t) ? t : null;
  }, [departTime]);

  useEffect(() => {
    if (!departMs) return;
    // Wenn die Abfahrt schon in der Vergangenheit ist, brauchen wir kein
    // Sekunden-Ticken (würde nur unnötig Re-Renders triggern).
    if (departMs - now < 0) return;
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [departMs, now]);

  if (!departMs) return { label: "—", isPast: false, isDeparted: false, progress: 0 };

  const diffMs = departMs - now;
  if (diffMs <= 0) {
    return { label: "0m", isPast: true, isDeparted: true, progress: 1 };
  }

  const totalMin = Math.floor(diffMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const label =
    h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;

  // Progress: 24h vor Abfahrt = 0.0, Abfahrt = 1.0. Vorher (>24h) bleibt 0.
  const DAY = 24 * 60 * 60 * 1000;
  const progress =
    diffMs >= DAY ? 0 : 1 - diffMs / DAY;

  return { label, isPast: false, isDeparted: false, progress };
}

const styles = StyleSheet.create({
  headPad: { padding: 18 },
  eyebrow: {
    fontSize: 11,
    color: C.gray300,
    letterSpacing: 0.5,
    fontWeight: "600",
  },
  passenger: {
    fontSize: 18,
    fontWeight: "700",
    color: C.white,
    marginTop: 3,
  },

  timesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  timeSide: { fontSize: 13, color: C.gray300 },
  duration: { fontSize: 14, fontWeight: "700", color: C.white },

  timeline: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 10,
    marginBottom: 14,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dash: {
    flex: 1,
    height: 1,
    borderTopWidth: 1.5,
    borderTopColor: C.dashed,
    borderStyle: "dashed",
    marginHorizontal: 8,
  },
  glyph: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },

  routeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  city: {
    fontSize: 22,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.4,
  },
  station: { fontSize: 12, color: C.gray300, marginTop: 2 },

  divider: { height: 1, backgroundColor: C.border, marginVertical: 16 },
  booking: {
    fontSize: 18,
    fontWeight: "800",
    color: C.white,
    marginTop: 3,
    letterSpacing: -0.2,
  },

  statsRow: { flexDirection: "row", marginTop: 16 },
  stat: { flex: 1, alignItems: "center" },
  statDivider: { width: 1, backgroundColor: C.border },
  statValue: {
    fontSize: 18,
    fontWeight: "800",
    color: C.white,
    marginTop: 3,
  },

  perfWrap: { height: 2, justifyContent: "center" },
  notch: {
    position: "absolute",
    top: -8,
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  notchLeft: { left: -9 },
  notchRight: { right: -9 },
  perfLine: {
    borderTopWidth: 2,
    borderTopColor: C.border,
    borderStyle: "dashed",
    marginHorizontal: 18,
  },

  track: {
    height: 8,
    borderRadius: 9999,
    backgroundColor: C.surface3,
    marginTop: 12,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 9999 },
});
