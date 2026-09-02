/**
 * Übersichts-Karte für ein gespeichertes Ticket (Bordkarten-Design).
 * Oberer Teil = `TicketHead` (geteilt mit dem Detail-Slide), darunter
 * Perforation + Countdown bis Abfahrt. Tap öffnet den Detail-Slide via
 * Store-Action `openTicketDetail`.
 */
import { memo, useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
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
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { startTicketPush } from "@/lib/nav/overlayCover";
import { deleteTicketFiles } from "@/lib/saved/ticketImages";
import {
  TicketHead,
  Perforation,
  ProgressBar,
  useDepartureCountdown,
  bookingRefFor,
} from "./TicketParts";
import { scaledStyles } from "@/lib/ui/compact";

const C = {
  bg: "#0D0D0D",
  surface: "#171719",
  white: "#F4F4F5",
  gray300: "#8E8E93",
  gray400: "#56565C",
  // Farbe der ausgestanzten Perforationskerben. NICHT der reine Hintergrund:
  // Die Karte schwebt jetzt (Schatten), und in ein Loch einer schwebenden Karte
  // fällt Schatten — die Kerbe muss also dunkler sein als der freie Hintergrund,
  // sonst wirkt sie als flacher heller Kreis, der den Schatten am Rand
  // unterbricht.
  //
  // Die Zahl ist gerechnet, nicht gegriffen: Der dunkelste Schatten-Layer ist
  // rgba(0,0,0,0.42), voll deckend also 58 % des Grundes — so dunkel wird er
  // aber NIE sichtbar, weil der Weichzeichner ihn verteilt. Die dunkelste
  // tatsächlich sichtbare Stelle liegt bei rund 15 % Schatten, und 85 % des
  // Hintergrunds #0D0D0D sind #0B0B0B.
  //
  // (Vor der neuen Palette stand hier #161616 — dieselbe Rechnung auf dem
  // damaligen Grund #1A1A1A.)
  notchShadow: "#0B0B0B",
};

const DATE_LOCALES = { en: enGB, de, fr, es } as const;

function TicketCardInner({ ticket }: { ticket: Ticket }) {
  const palette = usePalette();
  // Die Notch-Kreise stanzen die Karte aus; sichtbar wird der Screen-Grund,
  // leicht abgedunkelt durch den Kartenschatten. Bei echtem Schwarz gibt es
  // nichts mehr abzudunkeln — dann direkt der Grund.
  const notchBehind = palette.bg === "#000000" ? palette.bg : C.notchShadow;
  const t = useT();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const openTicketDetail = useSearchStore.getState().openTicketDetail;
  const removeTicket = useSearchStore.getState().removeTicket;

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

  /**
   * Die Textur des Reiters entsteht beim AUFSETZEN des Fingers.
   *
   * Sie stand im Loslassen — entgegen der Regel des Moduls, das den Aufbau mit
   * 66ms beziffert und deshalb ausdrücklich den Fingerdruck vorschreibt. So
   * fielen 66ms genau in die Bilder, in denen die Bewegung anlaufen soll, und
   * das ausgerechnet bei dem Übergang, der als der glatte gilt. Zwischen
   * Aufsetzen und Loslassen liegen 80 bis 150ms, die ohnehin verstreichen.
   *
   * `onTouchStart` am Rahmen, NICHT `onPressIn`: Diese Karte liegt in einer
   * Liste, und ein Druck-Beginn dort wird oft ein Scrollen. Das reine
   * Berührungs-Ereignis beansprucht die Geste nicht und stört das Scrollen
   * nicht — dieselbe Lösung wie am „Auswählen"-Knopf der Ergebnis-Karte.
   */
  const onTouchStart = () => {
    prepareLayer("saved");
  };

  const onPress = () => {
    // Bewegung ZUERST — sie war die einzige Seitwärts-Slide, die erst nach dem
    // Commit anlief. Siehe startTicketPush.
    startTicketPush();
    haptic("button");
    requestAnimationFrame(() => openTicketDetail(ticket));
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
      {/* cardShadow trägt den Schatten und sitzt NICHT auf der Karte selbst:
          Die braucht overflow:"hidden" für die Perforationskreise, und das
          schnitte einen Außenschatten weg. Gleicher Radius, damit der Schatten
          den runden Ecken folgt.

          Der Rahmen darum (`shadowClip`) ist weg. Er machte nur die
          Hardware-Textur groß genug für den Schatten — die Textur gibt es nicht
          mehr (sie invalidierte sich bei jeder Inhaltsänderung selbst), also
          blieben Innenabstand und negativer Rand übrig, die sich exakt
          aufhoben. */}
      <View style={styles.cardShadow} onTouchStart={onTouchStart}>
      <RippleTouch
        onPress={onPress}
        onLongPress={onLongPress}
        style={[styles.card, { backgroundColor: palette.s2 }]}
        rippleColor="transparent"
      >
        <TicketHead ticket={ticket} />

        {/* Perforation als DIREKTER Child der Card — damit die left:-9/right:-9
            Notch-Kreise von card.overflow:hidden sauber an den Card-Rändern
            geclippt werden (halbe Kreise die wie ausgestanzt aussehen). Mit
            einem Padding-Wrapper wäre der Clip-Anker falsch positioniert. */}
        <Perforation notchColor={notchBehind} />

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
      </View>

      <Text style={styles.hint}>{t("saved.ticket.openHint")}</Text>
    </View>
  );
}

const styles = scaledStyles({
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

  // Mehrschichtiger Schatten (Fabric-boxShadow, dasselbe Modell wie CSS:
  // offsetX offsetY blur spread color). Bewusst ZUSAMMENGEZOGEN: Die Vorlage warf
  // mit 32 px Versatz / 80 px Blur weit nach unten und zog dadurch einen langen
  // Verlauf. Kleinere Versätze und engere Blurs lassen den Schatten die Karte
  // umschließen, statt nach unten auszulaufen — die drei Lagen und die
  // abgestufte Opazität bleiben.
  //   0 10px 24px -8px rgba(0,0,0,.42)  — Abwurf, jetzt kurz
  //   0  5px 14px -6px rgba(0,0,0,.26)  — mittlere Lage
  //   0  2px  6px      rgba(0,0,0,.18)  — enge Kantenabhebung
  cardShadow: {
    borderRadius: 24,
    // EINE Schicht statt drei. Jede Schicht ist ein eigener weicher Verlauf über
    // die volle Kartenbreite, den die GPU beim Zeichnen mit dem Untergrund
    // mischt — beim Scrollen und bei jeder Karten-Animation erneut. Drei davon
    // übereinander kosteten das Dreifache für einen Unterschied, den man im
    // direkten Vergleich nicht sieht: Die mittlere Schicht liegt fast deckungs-
    // gleich unter der ersten, die dritte (2px, ohne Ausbreitung) verschwindet
    // hinter der Kartenkante. Die eine hier ist die Summe: etwas kräftiger
    // (0.55 statt 0.42) und dafür enger gezogen.
    boxShadow: "0px 8px 20px -6px rgba(0, 0, 0, 0.55)",
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
