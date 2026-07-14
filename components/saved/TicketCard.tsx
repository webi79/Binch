/**
 * Übersichts-Karte für ein gespeichertes Ticket (Bordkarten-Design).
 * Oberer Teil = `TicketHead` (geteilt mit dem Detail-Slide), darunter
 * Perforation + Countdown bis Abfahrt. Tap öffnet den Detail-Slide via
 * Store-Action `openTicketDetail`.
 */
import { memo, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { format, parseISO } from "date-fns";
import { de, enGB, es, fr } from "date-fns/locale";
import { showAlert } from "@/lib/alert";
import { Ticket } from "@/types/saved";
import { useT } from "@/lib/i18n/useT";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { deleteTicketFiles } from "@/lib/saved/ticketImages";
import {
  TicketHead,
  Perforation,
  ProgressBar,
  useDepartureCountdown,
  bookingRefFor,
} from "./TicketParts";

const C = {
  bg: "#1A1A1A",
  surface: "#242425",
  white: "#FFFFFF",
  gray300: "#8A8A90",
  gray400: "#56565C",
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

function TicketCardInner({ ticket }: { ticket: Ticket }) {
  const t = useT();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const openTicketDetail = useSearchStore((s) => s.openTicketDetail);
  const removeTicket = useSearchStore((s) => s.removeTicket);

  const dateLocale = DATE_LOCALES[locale] ?? enGB;

  // Header-Datum + Abfahrtszeit ("22. Aug · 07:25").
  const headerLine = useMemo(() => {
    if (!ticket.departTime) return "";
    try {
      const d = parseISO(ticket.departTime);
      const date = format(d, "d. MMM", { locale: dateLocale });
      const time = format(d, "HH:mm");
      return `${date} · ${time}`;
    } catch {
      return "";
    }
  }, [ticket.departTime, dateLocale]);

  // Titel: "FromCity — ToCity" (em-dash mit Spaces, matched das Template-
  // Design). Fallback auf Codes wenn keine Cities geparst wurden.
  const title = useMemo(() => {
    const from = ticket.fromCity ?? ticket.fromCode ?? "—";
    const to = ticket.toCity ?? ticket.toCode ?? "—";
    return `${from} — ${to}`;
  }, [ticket.fromCity, ticket.fromCode, ticket.toCity, ticket.toCode]);

  const countdown = useDepartureCountdown(ticket.departTime);

  const departAtLine = useMemo(() => {
    if (!ticket.departTime) return "";
    try {
      const d = parseISO(ticket.departTime);
      return t("saved.ticket.depart.at").replace("{time}", format(d, "HH:mm"));
    } catch {
      return "";
    }
  }, [ticket.departTime, t]);

  const onPress = () => {
    haptic("button");
    openTicketDetail(ticket);
  };

  const onLongPress = () => {
    haptic("important");
    const label =
      ticket.carrier ?? ticket.originalName ?? bookingRefFor(ticket) ?? "ticket";
    showAlert(
      t("saved.ticket.delete.title"),
      t("saved.ticket.delete.body").replace("{label}", label),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.delete"),
          style: "destructive",
          onPress: () => {
            // Bild-/PDF-Dateien best-effort mitlöschen, damit das Document-
            // Directory nicht mit verwaisten Dateien zumüllt.
            deleteTicketFiles(ticket);
            removeTicket(ticket.id);
          },
        },
      ],
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        {headerLine ? <Text style={styles.date}>{headerLine}</Text> : null}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
      </View>

      {/* RippleTouch mit transparentem Ripple — der Card-Style bleibt 100%
          erhalten (TouchableNativeFeedback wrapper auf Android, plus
          overflow:hidden Clip am inner View). Visueller Ripple ist aus
          (transparent) damit's bei LongPress nicht als Welle stehen bleibt. */}
      <RippleTouch
        onPress={onPress}
        onLongPress={onLongPress}
        style={styles.card}
        rippleColor="transparent"
      >
        <TicketHead ticket={ticket} />

        {/* Perforation als DIREKTER Child der Card — damit die left:-9/right:-9
            Notch-Kreise von card.overflow:hidden sauber an den Card-Rändern
            geclippt werden (halbe Kreise die wie ausgestanzt aussehen). Mit
            einem Padding-Wrapper wäre der Clip-Anker falsch positioniert. */}
        <Perforation notchColor={C.bg} />

        <View style={styles.countdown}>
          <View style={styles.countdownTop}>
            <Text style={styles.now}>{t("saved.ticket.now")}</Text>
            <Text style={styles.endsAt}>{departAtLine}</Text>
          </View>
          <View style={styles.countdownMain}>
            <Text style={styles.checkIn}>
              {countdown.isDeparted
                ? t("saved.ticket.departed")
                : t("saved.ticket.depart.in")}
            </Text>
            {!countdown.isDeparted ? (
              <Text style={[styles.checkInValue, { color: accent.solid }]}>
                {countdown.label}
              </Text>
            ) : null}
          </View>
          <ProgressBar value={countdown.progress} />
        </View>
      </RippleTouch>

      <Text style={styles.hint}>{t("saved.ticket.openHint")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: GUTTER, marginBottom: 8 },
  headerRow: {
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 8,
  },
  date: { fontSize: 13, color: C.gray300, fontWeight: "500" },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.5,
    marginTop: 2,
  },

  card: {
    backgroundColor: C.surface,
    borderRadius: 24,
    overflow: "hidden",
  },

  countdown: { paddingHorizontal: SPACE.lg, paddingTop: 20, paddingBottom: 18 },
  countdownTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  now: { fontSize: 13, color: C.gray300, fontWeight: "600" },
  endsAt: { fontSize: 12, color: C.gray300 },
  countdownMain: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: 5,
  },
  checkIn: {
    fontSize: 22,
    fontWeight: "800",
    color: C.white,
    letterSpacing: -0.6,
    flexShrink: 1,
  },
  checkInValue: {
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.8,
  },

  hint: {
    textAlign: "center",
    fontSize: 12,
    color: C.gray400,
    fontWeight: "500",
    paddingVertical: 12,
  },
});

// Memo-Wrapper: bei einer Liste von Tickets verhindert das, dass alle Cards
// bei jedem Re-Render der Saved-Screen neu zeichnen. Nur die geänderte Card
// re-rendert (z.B. wenn Ticket gelöscht wird).
export const TicketCard = memo(TicketCardInner);
