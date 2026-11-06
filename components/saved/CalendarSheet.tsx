/**
 * Der KALENDER des Gespeichert-Reiters — ein Blatt von unten hinter dem Knopf
 * oben rechts (dort, wo im Startbildschirm die Glocke sitzt).
 *
 * FAHRT, RUHEHÖHE, VERDUNKELUNG UND WISCH-GESTE sind die des Mitteilungs-Blatts
 * (components/home/NotificationsSheet.tsx) — dieselbe `useSheetSlide`, dieselbe
 * Kurve, dieselbe Strecke. Die Oberkante bleibt an der Unterkante der Kopfzeile
 * stehen (`HOME_HEADER_H`: Die Kopfzeile des Reiters hat denselben Takt wie die
 * des Startbildschirms), Überschrift und Knopf bleiben darüber sichtbar. Der
 * Kalender ist beim Öffnen schon gebaut und fährt mit hoch — gebaut wird beim
 * Aufsetzen des Fingers auf den Knopf (`prepareCalendar`), nicht beim App-Start.
 *
 * SCHICHTUNG: über der Tab-Leiste, aber UNTER den Detail-Blättern (Reise,
 * Ticket) — anders als das Mitteilungs-Blatt, das über allem liegt. Ein Tipp
 * auf eine Reise im Kalender öffnet ihre Details darüber; zurück steht man
 * wieder im Kalender. Deshalb hängt es in app/_layout.tsx vor `DetailsOverlay`
 * und trägt keine Android-Höhe.
 *
 * MONATSWECHSEL SENKRECHT (Wunsch des Nutzers, 29.10.2026): Der alte Monat
 * gleitet nach oben aus seinem Feld, der neue kommt von unten nach; rückwärts
 * gespiegelt. Ein Feld, das abschneidet, statt Überblenden an Ort und Stelle —
 * so überlagern sich nie zwei Zahlenraster. Deshalb auch ⌃/⌄ statt ‹/›. Kein
 * Wischen über das Raster: Senkrecht gehört die Bewegung dem Blatt (nach unten
 * schließen, wie beim Mitteilungs-Blatt).
 *
 * Eine Reise steht an IHREM Tag: in der Ortszeit des Abfahrtsorts, nicht in
 * der des Handys. Wer in New York um 23 Uhr abfliegt, fliegt am selben Abend,
 * auch wenn in Berlin schon der nächste Tag ist. Reisen mit unbekannter Uhrzeit
 * (`dateOnly`) stehen an ihrem Datum.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  runOnUI,
  scrollTo,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type EntryExitAnimationFunction,
} from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { addDays, addMonths, format, isSameMonth, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { de as deLocale, enUS, es as esLocale, fr as frLocale } from "date-fns/locale";
import { formatInTimeZone } from "date-fns-tz";
import { ChevronDown, ChevronUp, Ticket as TicketIcon, X } from "lucide-react-native";
import { ResultCard } from "@/components/results/ResultCard";
import { TicketCard } from "@/components/saved/TicketCard";
import { ENTRY } from "@/components/saved/IntroRow";
import { FadePress } from "@/components/ui/FadePress";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SHEET_HEAD_TOP, SHEET_TITLE } from "@/components/ui/SheetModal";
import { overlayCover, SHEET_IN, SHEET_OUT, UNDERLAY_TRAVEL_FRAC } from "@/lib/nav/overlayCover";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { openRouteMap } from "@/lib/nav/openRouteMap";
import { onPathnameChange, useRouteMirror } from "@/lib/nav/routeMirror";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import { slideTiming } from "@/lib/nav/slideMotion";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER, HOME_HEADER_H, SPACE, ITEM_GAP } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import {
  dragHealOffset,
  snapToPixel,
  useSheetScrollGate,
  useSheetSwipe,
  type SheetScrollGate,
} from "@/lib/ui/sheetSwipe";
import { useSearchStore, type Locale } from "@/stores/searchStore";
import type { SavedTrip, Ticket } from "@/types/saved";

const C = {
  white: "#F4F4F5",
  sub: "#C8C8CC",
  g2: "#8E8E93",
  g3: "#56565C",
  /** Der X-Knopf trägt in allen Blättern denselben Ton. */
  closeIcon: "#E5E7EB",
};

/** Fensterhöhe einmal beim Laden — wie im Mitteilungs-Blatt (Begründung dort). */
const WINDOW_H = Dimensions.get("window").height;
const WINDOW_W = Dimensions.get("window").width;
/** Ruhestellung — als Konstante, damit das Worklet kein neues Objekt pro Bild baut. */
const NO_PARALLAX = { transform: [{ translateX: 0 }] } as const;
/** Obere Ecken — derselbe Radius wie an allen Blättern der App. */
const SHEET_RADIUS = 28;

/** Zeilenhöhe des Rasters, Auswahl-Kreis und Fenster der Monatsüberschrift — vor der Skalierung. */
const CELL_H = 46;
const LABEL_H = 28;
/** Senkrechter Abstand der Markierung zum Zellrand — 2 × 2 Punkte Luft zwischen zwei Wochen. */
const MARK_INSET_Y = 2;
/** Wellen kleiner als die randlose Vorgabe (die reicht bis in die Ecken): Pfeile, „Heute". */
const NAV_RIPPLE = 17;
const TODAY_RIPPLE = 22;
/**
 * Wege des Monatswechsels, SKALIERT: Sie werden direkt als Lage gesetzt und
 * laufen durch kein Stilblatt (wie `HOME_HEADER_H`). Genau eine Feldhöhe — der
 * neue Monat steht beim Start direkt unter dem alten.
 */
const GRID_TRAVEL = ms(CELL_H) * 6;
const LABEL_TRAVEL = ms(LABEL_H);
/**
 * Dieselbe Kurve wie die Seiten-Übergänge der App (`EMPHASIZED` in
 * lib/nav/overlayCover.ts), etwas kürzer — es bewegt sich ein Feld, kein
 * Bildschirm.
 */
const MONTH_SLIDE = { duration: 380, easing: Easing.bezier(0.4, 0, 0.2, 1) };

/** Sichtbarkeit nach Lage: im Feld voll, auf dem Weg hinaus schon blasser. */
function pageOpacity(p: number): number {
  "worklet";
  return Math.max(0, 1 - Math.abs(p) * 0.85);
}

const DATE_LOCALES = { de: deLocale, en: enUS, fr: frLocale, es: esLocale } as const;
/** Tagesüberschrift je Sprache — „d. MMMM" ist deutsch, nicht allgemein. */
const DAY_TITLE: Record<Locale, string> = {
  de: "EEEE, d. MMMM",
  en: "EEEE, MMMM d",
  fr: "EEEE d MMMM",
  es: "EEEE, d 'de' MMMM",
};

type Entry = { kind: "trip"; at: number; trip: SavedTrip } | { kind: "ticket"; at: number; ticket: Ticket };

/** Der Tag einer Abfahrt in der Ortszeit des Abfahrtsorts (siehe Dateikopf). */
function dayKey(iso: string, tz: string | undefined, dateOnly?: boolean): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  if (dateOnly) return iso.slice(0, 10);
  try {
    return tz ? formatInTimeZone(new Date(ms), tz, "yyyy-MM-dd") : format(new Date(ms), "yyyy-MM-dd");
  } catch {
    return format(new Date(ms), "yyyy-MM-dd");
  }
}

/** Alles nach Tag gruppiert, je Tag nach Uhrzeit. */
function groupByDay(trips: SavedTrip[], tickets: Ticket[]): Map<string, Entry[]> {
  const map = new Map<string, Entry[]>();
  const add = (key: string | null, e: Entry) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  };
  for (const trip of trips) {
    add(dayKey(trip.departTime, trip.originTz, trip.dateOnly), { kind: "trip", at: Date.parse(trip.departTime), trip });
  }
  for (const ticket of tickets) {
    if (!ticket.departTime) continue;
    add(dayKey(ticket.departTime, ticket.originTz), { kind: "ticket", at: Date.parse(ticket.departTime), ticket });
  }
  for (const list of map.values()) list.sort((a, b) => a.at - b.at);
  return map;
}

/**
 * Die Markierung des gewählten Tages geht weich auf, die alte blendet zugleich
 * ab — kaum Bewegung, kein Federn: ruhig, wie der Rest des Blattes.
 */
const selectIn: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.92 }] },
    animations: {
      opacity: withTiming(1, { duration: 150 }),
      transform: [{ scale: withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) }) }],
    },
  };
};
const selectOut: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 1 },
    animations: { opacity: withTiming(0, { duration: 140 }) },
  };
};

/**
 * Die Einträge eines Tages fliegen von unten herein, einer nach dem anderen —
 * mit denselben Zahlen wie die Karten der Gespeichert-Liste (`ENTRY`).
 */
function entryIn(i: number) {
  return FadeInDown.duration(ENTRY.duration)
    .delay(ENTRY.delay + i * ENTRY.stagger)
    .easing(Easing.out(Easing.cubic))
    .withInitialValues({ opacity: 0, transform: [{ translateY: ENTRY.rise }] });
}
const ENTRY_OUT = FadeOut.duration(120);
const TITLE_IN = FadeIn.duration(220);

export function CalendarSheet() {
  const t = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const open = useSearchStore((s) => s.calendarOpen);
  const prepared = useSearchStore((s) => s.calendarPrepared);
  const close = useSearchStore((s) => s.closeCalendar);

  // Lage fest unter der sicheren Fläche, Ruhepunkt an der Kopfzeile — siehe Mitteilungs-Blatt.
  const top = insets.top;
  const park = Math.max(1, WINDOW_H - top);
  const restY = HOME_HEADER_H;
  const { y, run, adopt, parkNow, warm, heal } = useSheetSlide("calendar", park);

  // Ganze Gerätepixel + Selbstkorrektur beim Ziehen — siehe lib/ui/sheetSwipe.ts.
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(y.value + restY) + dragHealOffset(heal) }],
  }));
  // Die Verdunkelung hängt am selben Wert wie die Fahrt.
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - y.value / park }));
  /**
   * Öffnet sich darüber eine Reise oder ein Ticket, weicht der Reiter darunter
   * nach links aus (Parallaxe der Unterlage). Das Blatt gehört dann zur
   * Unterlage und weicht mit — sonst stünde es still, während der abgedunkelte
   * Reiter darunter wegrutscht. Nur offen: geschlossen gibt es nichts zu zeigen.
   */
  const parallax = useAnimatedStyle(
    () =>
      open
        ? { transform: [{ translateX: overlayCover.value * WINDOW_W * UNDERLAY_TRAVEL_FRAC }] }
        : NO_PARALLAX,
    [open],
  );

  /** Den echten Weg einmal kalt anlaufen lassen — ein Bild später (siehe Mitteilungs-Blatt). */
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current) return;
    const id = requestAnimationFrame(() => {
      warmed.current = true;
      warm();
    });
    return () => cancelAnimationFrame(id);
  }, [warm]);

  /** Nur bei echtem Wechsel fahren — `run` bekommt mit `park` eine neue Kennung. */
  const lastOpen = useRef(false);
  const enteredAt = useRef(0);
  useEffect(() => {
    if (lastOpen.current === open) return;
    lastOpen.current = open;
    if (open) enteredAt.current = Date.now();
    run(open);
  }, [open, run]);

  /** Wisch nach unten schließt — die Geste fährt die Ausfahrt selbst (siehe Mitteilungs-Blatt). */
  const gate = useSheetScrollGate();
  const dismissBySwipe = useCallback(
    (durationMs: number, fromY: number) => {
      adopt(false, durationMs, fromY);
      lastOpen.current = false;
      close();
    },
    [adopt, close],
  );
  const panGesture = useSheetSwipe({
    y,
    travel: park,
    onDismiss: dismissBySwipe,
    enabled: open,
    gate,
    heal,
    closing: !open,
  });

  /** Geänderter Parkplatz (sichere Fläche trifft ein) — neu parken, solange zu. */
  useEffect(() => {
    if (!open) parkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [park]);

  /**
   * Öffnet sich die Ergebnisliste (Tipp auf eine Preis-Alarm-Meldung, während
   * der Kalender offen ist), läge sie im Wurzel-Layout UNTER diesem Blatt — es
   * macht ihr Platz.
   */
  useEffect(
    () =>
      useSearchStore.subscribe((st, prev) => {
        if (st.calendarOpen && st.resultsParams && st.resultsParams !== prev.resultsParams) st.closeCalendar();
      }),
    [],
  );

  /**
   * Geht im Navigations-Stapel ein Bildschirm auf (Routen-Karte aus Details
   * oder Zeitleiste heraus), läge er UNTER diesem Blatt — dann sofort weg, ohne
   * Fahrt: In dem Moment liegen ohnehin die Details darüber, und die verstecken
   * sich beim selben Wechsel. Der Routen-Knopf der Karte im Kalender schließt
   * vorher MIT Fahrt (siehe `CalendarTrip`), dort greift das hier nicht mehr.
   */
  const mirror = useRouteMirror();
  const openedOn = useRef<string | null>(null);
  useEffect(() => {
    if (open) openedOn.current = mirror.current.pathname;
  }, [open, mirror]);
  useEffect(
    () =>
      onPathnameChange((pathname) => {
        const st = useSearchStore.getState();
        if (!st.calendarOpen || pathname === openedOn.current) return;
        lastOpen.current = false;
        parkNow();
        st.closeCalendar();
      }),
    [parkNow],
  );

  /** Zurück-Taste schließt das Blatt. Offene Details melden sich später an und gehen vor. */
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, close]);

  const dismiss = useCallback(() => {
    haptic("button");
    close();
  }, [close]);

  /** Tippen neben das Blatt zählt erst, wenn es oben steht (Doppeltipp auf den Knopf). */
  const dismissFromScrim = () => {
    if (Date.now() - enteredAt.current < SHEET_IN.duration) return;
    dismiss();
  };

  return (
    // Berührungs-Sperre auf der ruhenden Hülle, nicht auf den bewegten Knoten.
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "auto" : "none"}>
      <Animated.View style={[StyleSheet.absoluteFill, parallax]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.scrim, scrimStyle]} />
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={dismissFromScrim}
      />
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.sheet, { top, backgroundColor: palette.s1 }, sheetStyle]}>
          {prepared ? (
            <CalendarBody
              onClose={dismiss}
              gate={gate}
              // Das Blatt reicht um den Ruhepunkt unter den Bildrand — so viel mehr Luft unten.
              bottomPad={restY + insets.bottom + SPACE.xxl}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>
      </Animated.View>
    </View>
  );
}

/**
 * Reisen und Tickets — live nur, solange das Blatt offen ist.
 *
 * Es hängt dauerhaft am Wurzel-Layout. Ein gewöhnliches Abo weckte es bei
 * jedem Speichern irgendwo in der App (Herz in der Ergebnisliste) und baute den
 * verdeckten Kalender neu — dieselbe Falle, die der Gespeichert-Reiter mit
 * `useFocusedStoreSnapshot` umgeht. Geschlossen wird erst nachgeholt, wenn der
 * Finger auf den Knopf kommt (`calendarStamp`), also vor der Fahrt.
 */
function useCalendarData(): { trips: SavedTrip[]; tickets: Ticket[] } {
  const [data, setData] = useState(() => {
    const st = useSearchStore.getState();
    return { trips: st.savedTrips, tickets: st.tickets };
  });
  useEffect(() => {
    let prev = data;
    const unsub = useSearchStore.subscribe((st, before) => {
      if (!st.calendarOpen && st.calendarStamp === before.calendarStamp) return;
      if (st.savedTrips === prev.trips && st.tickets === prev.tickets) return;
      prev = { trips: st.savedTrips, tickets: st.tickets };
      setData(prev);
    });
    return unsub;
    // Nur einmal anmelden — `prev` führt den Stand selbst weiter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return data;
}

const CalendarBody = memo(function CalendarBody({
  onClose,
  gate,
  bottomPad,
}: {
  onClose: () => void;
  gate: SheetScrollGate;
  bottomPad: number;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const { trips, tickets } = useCalendarData();
  const dateLocale = DATE_LOCALES[locale] ?? enUS;

  const byDay = useMemo(() => groupByDay(trips, tickets), [trips, tickets]);
  const todayKey = format(new Date(), "yyyy-MM-dd");
  /** Start: der Tag der nächsten anstehenden Reise — sonst heute. */
  const startKey = useMemo(
    () => [...byDay.keys()].filter((k) => k >= todayKey).sort()[0] ?? todayKey,
    [byDay, todayKey],
  );

  const [selected, setSelected] = useState(startKey);
  /**
   * ZWEI Plätze für den Monat, beide immer gebaut: Beim Blättern bekommt der
   * verdeckte den neuen Monat (ein Durchgang), DANACH gleiten beide — der alte
   * hinaus, der neue herein. Kein Aufbau während der Bewegung.
   */
  const [slots, setSlots] = useState<[Date, Date]>(() => {
    const m = startOfMonth(parseISO(startKey));
    return [m, m];
  });
  const [front, setFront] = useState<0 | 1>(0);
  const [switchId, setSwitchId] = useState(0);
  const month = slots[front];

  // Für Rückrufe, die nicht bei jedem Durchgang neu entstehen sollen (Raster ist memoisiert).
  const frontRef = useRef<0 | 1>(0);
  const monthRef = useRef(month);
  monthRef.current = month;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const dirRef = useRef<1 | -1>(1);

  /** Lage je Platz in Feldhöhen: 0 = im Feld, +1 = darunter, −1 = darüber. */
  const pos0 = useSharedValue(0);
  const pos1 = useSharedValue(1);
  const slot0 = useAnimatedStyle(() => ({
    opacity: pageOpacity(pos0.value),
    transform: [{ translateY: pos0.value * GRID_TRAVEL }],
  }));
  const slot1 = useAnimatedStyle(() => ({
    opacity: pageOpacity(pos1.value),
    transform: [{ translateY: pos1.value * GRID_TRAVEL }],
  }));
  // Die Überschrift rollt im selben Takt in ihrem eigenen, niedrigen Fenster.
  const label0 = useAnimatedStyle(() => ({
    opacity: pageOpacity(pos0.value),
    transform: [{ translateY: pos0.value * LABEL_TRAVEL }],
  }));
  const label1 = useAnimatedStyle(() => ({
    opacity: pageOpacity(pos1.value),
    transform: [{ translateY: pos1.value * LABEL_TRAVEL }],
  }));

  const goTo = useCallback((target: Date, dir: 1 | -1) => {
    const back: 0 | 1 = frontRef.current === 0 ? 1 : 0;
    frontRef.current = back;
    dirRef.current = dir;
    setSlots((s) => (back === 0 ? [target, s[1]] : [s[0], target]));
    setFront(back);
    setSwitchId((n) => n + 1);
  }, []);

  /**
   * Die Bewegung erst NACH dem Durchgang, der den neuen Monat einsetzt:
   * vorwärts gleitet der alte nach oben hinaus und der neue kommt von unten,
   * rückwärts genau umgekehrt.
   */
  useEffect(() => {
    if (switchId === 0) return;
    const d = dirRef.current;
    const [incoming, outgoing] = frontRef.current === 0 ? [pos0, pos1] : [pos1, pos0];
    incoming.value = withSequence(withTiming(d, { duration: 0 }), withTiming(0, slideTiming(MONTH_SLIDE)));
    outgoing.value = withTiming(-d, slideTiming(MONTH_SLIDE));
  }, [switchId, pos0, pos1]);

  /**
   * Auf den Anfang zurück: nach dem Schließen, sobald das Blatt geparkt (also
   * unsichtbar) ist — beim nächsten Öffnen steht wieder die nächste Reise da.
   *
   * Über ein Abo am Speicher statt über `calendarOpen` als Eigenschaft: Sonst
   * baute sich dieser ganze Teil in genau dem Durchgang neu, der die Fahrt
   * startet.
   */
  const startKeyRef = useRef(startKey);
  startKeyRef.current = startKey;
  const reset = useCallback(() => {
    const key = startKeyRef.current;
    const m = startOfMonth(parseISO(key));
    frontRef.current = 0;
    pos0.value = 0;
    pos1.value = 1;
    setSlots([m, m]);
    setFront(0);
    setSelected(key);
  }, [pos0, pos1]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useSearchStore.subscribe((st, prev) => {
      if (st.calendarOpen === prev.calendarOpen) return;
      if (timer) clearTimeout(timer);
      timer = st.calendarOpen ? null : setTimeout(reset, SHEET_OUT.duration + 80);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [reset]);
  // Neue Reise gespeichert, während das Blatt zu ist: Start neu bestimmen.
  useEffect(() => {
    if (!useSearchStore.getState().calendarOpen) reset();
  }, [startKey, reset]);

  /** Ein anderer Tag beginnt oben — sonst stünde seine Liste so tief, wie die alte gescrollt war. */
  const { scrollY: listY, ref: listRef } = gate;
  useEffect(() => {
    runOnUI(() => {
      "worklet";
      if (listY.value > 0.5 && listRef()) scrollTo(listRef, 0, 0, false);
    })();
  }, [selected, listY, listRef]);

  const shift = useCallback(
    (delta: 1 | -1) => {
      haptic("tick");
      goTo(addMonths(monthRef.current, delta), delta);
    },
    [goTo],
  );

  const pick = useCallback(
    (d: Date) => {
      const key = format(d, "yyyy-MM-dd");
      const m = startOfMonth(d);
      const sameMonth = isSameMonth(m, monthRef.current);
      if (key === selectedRef.current && sameMonth) return;
      haptic("tick");
      if (key !== selectedRef.current) setSelected(key);
      if (!sameMonth) goTo(m, m > monthRef.current ? 1 : -1);
    },
    [goTo],
  );

  const goToday = () => pick(new Date());

  const weekdays = useMemo(() => {
    const start = startOfWeek(new Date(), { weekStartsOn: 1 });
    return Array.from({ length: 7 }, (_, i) => format(addDays(start, i), "EEEEEE", { locale: dateLocale }));
  }, [dateLocale]);

  const entries = byDay.get(selected) ?? [];
  const selectedLabel = format(parseISO(selected), DAY_TITLE[locale] ?? DAY_TITLE.en, { locale: dateLocale });
  const countLabel =
    entries.length === 1
      ? t("saved.calendar.count.one")
      : t("saved.calendar.count.many").replace("{n}", String(entries.length));
  const onToday = selected === todayKey && isSameMonth(month, parseISO(todayKey));
  /**
   * Jedem Raster nur SEINE Auswahl: Liegt der gewählte Tag in einem anderen
   * Monat, bekommt es `null` — und zeichnet bei einem Tipp nicht mit neu.
   */
  const selectedIn = (m: Date) => (selected.startsWith(format(m, "yyyy-MM")) ? selected : null);

  return (
    <>
      {/* Titel links, X rechts oben — wie die Unterseiten der Einstellungen. */}
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {t("saved.calendar.title")}
        </Text>
        {/* `FadePress` statt Welle: Dieser Knopf startet die Ausfahrt (siehe Mitteilungs-Blatt). */}
        <FadePress onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.close")}>
          <X color={C.closeIcon} size={26} />
        </FadePress>
      </View>

      <View style={[styles.card, { backgroundColor: palette.s2 }]}>
        <View style={styles.monthRow}>
          <View style={styles.monthLabelBox} pointerEvents="none">
            <Animated.Text style={[styles.monthLabel, label0]} numberOfLines={1}>
              {format(slots[0], "LLLL", { locale: dateLocale })}
              <Text style={styles.monthYear}>{format(slots[0], " yyyy")}</Text>
            </Animated.Text>
            <Animated.Text style={[styles.monthLabel, styles.overlay, label1]} numberOfLines={1}>
              {format(slots[1], "LLLL", { locale: dateLocale })}
              <Text style={styles.monthYear}>{format(slots[1], " yyyy")}</Text>
            </Animated.Text>
          </View>
          {/* Immer im Layout, nur unsichtbar und still, solange heute gewählt ist — nichts rückt. */}
          <View style={onToday ? styles.hidden : undefined} pointerEvents={onToday ? "none" : "auto"}>
            <RippleTouch
              onPress={goToday}
              hitSlop={8}
              borderless
              rippleRadius={TODAY_RIPPLE}
              accessibilityRole="button"
              accessibilityLabel={t("saved.calendar.today")}
              style={styles.todayBtn}
            >
              <Text style={styles.todayText}>{t("saved.calendar.today")}</Text>
            </RippleTouch>
          </View>
          {/* Hoch und runter, weil die Monate senkrecht wechseln. */}
          <RippleTouch
            onPress={() => shift(-1)}
            borderless
            rippleRadius={NAV_RIPPLE}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={t("saved.calendar.prev")}
            style={styles.navBtn}
          >
            <ChevronUp size={20} color={C.sub} strokeWidth={2.2} />
          </RippleTouch>
          <RippleTouch
            onPress={() => shift(1)}
            borderless
            rippleRadius={NAV_RIPPLE}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={t("saved.calendar.next")}
            style={styles.navBtn}
          >
            <ChevronDown size={20} color={C.sub} strokeWidth={2.2} />
          </RippleTouch>
        </View>

        <View style={styles.week}>
          {weekdays.map((w, i) => (
            <Text key={i} style={styles.weekday}>
              {w}
            </Text>
          ))}
        </View>

        {/**
          * Das Fenster, in dem die Monate wechseln — es schneidet ab, was
          * hinausgleitet. Beide Plätze liegen übereinander; ihre Hüllen lassen
          * Berührungen DURCH (`box-none`), nur der sichtbare nimmt sie an.
          * Ohne das fing der obere Platz jeden Tipp ab, auch mit gesperrtem
          * Inhalt — und der sichtbare Monat darunter war nicht anzutippen.
          */}
        <View style={[styles.gridBox, { height: GRID_TRAVEL }]}>
          <Animated.View pointerEvents="box-none" style={slot0}>
            <View pointerEvents={front === 0 ? "auto" : "none"}>
              <MonthGrid
                month={slots[0]}
                selected={selectedIn(slots[0])}
                todayKey={todayKey}
                marked={byDay}
                accent={accent.solid}
                onAccent={accent.textOnSolid}
                dateLocale={dateLocale}
                onPick={pick}
              />
            </View>
          </Animated.View>
          <Animated.View pointerEvents="box-none" style={[styles.overlay, slot1]}>
            <View pointerEvents={front === 1 ? "auto" : "none"}>
              <MonthGrid
                month={slots[1]}
                selected={selectedIn(slots[1])}
                todayKey={todayKey}
                marked={byDay}
                accent={accent.solid}
                onAccent={accent.textOnSolid}
                dateLocale={dateLocale}
                onPick={pick}
              />
            </View>
          </Animated.View>
        </View>
      </View>

      {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am Blatt jedes Scrollen ab. */}
      <GestureDetector gesture={gate.native}>
        <Animated.ScrollView
          ref={gate.ref}
          style={styles.list}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          onScroll={gate.onScroll}
          scrollEventThrottle={16}
          overScrollMode="never"
          bounces={false}
        >
          <Animated.View key={`head:${selected}`} entering={TITLE_IN} style={styles.dayHead}>
            <Text style={styles.dayTitle} numberOfLines={1}>
              {selectedLabel}
            </Text>
            {entries.length > 0 ? (
              // Zahl + Ticket-Symbol statt „1 Eintrag" — vorgelesen wird der Text.
              <View style={styles.countRow} accessible accessibilityLabel={countLabel}>
                <Text style={styles.countNum}>{entries.length}</Text>
                <TicketIcon size={15} color={C.g2} strokeWidth={2} />
              </View>
            ) : null}
          </Animated.View>
          {entries.length === 0 ? (
            <Animated.Text key={`empty:${selected}`} entering={entryIn(0)} style={styles.empty}>
              {byDay.size === 0 ? t("saved.calendar.emptyAll") : t("saved.calendar.emptyDay")}
            </Animated.Text>
          ) : (
            entries.map((e, i) =>
              e.kind === "trip" ? (
                <Animated.View
                  key={`${selected}:t:${e.trip.id}`}
                  entering={entryIn(i)}
                  exiting={ENTRY_OUT}
                  style={styles.item}
                >
                  <CalendarTrip trip={e.trip} />
                </Animated.View>
              ) : (
                <Animated.View
                  key={`${selected}:k:${e.ticket.id}`}
                  entering={entryIn(i)}
                  exiting={ENTRY_OUT}
                  style={styles.ticket}
                >
                  <TicketCard ticket={e.ticket} />
                </Animated.View>
              ),
            )
          )}
        </Animated.ScrollView>
      </GestureDetector>
    </>
  );
});

/**
 * Eine gespeicherte Reise im Kalender — die Karte der Liste, nur der
 * Routen-Knopf schließt zuerst das Blatt.
 *
 * Die Routen-Karte ist ein Bildschirm im Navigations-Stapel und läge sonst
 * UNTER dem Blatt (es hängt am Wurzel-Layout). Erst die Ausfahrt, dann die
 * Route — nacheinander statt übereinander. Zurück landet man im Reiter.
 * Ein Tipp auf die Karte selbst öffnet die Details dagegen ÜBER dem Kalender;
 * zurück steht man wieder in ihm.
 */
const CalendarTrip = memo(function CalendarTrip({ trip }: { trip: SavedTrip }) {
  const onShowRoute = useCallback(() => {
    haptic("button");
    if (!buildRoutePlan(trip)) return;
    useSearchStore.getState().closeCalendar();
    setTimeout(() => openRouteMap(trip), SHEET_OUT.duration + 40);
  }, [trip]);
  return <ResultCard result={trip} passengers={trip.passengers} underlay="saved" onShowRoute={onShowRoute} />;
});

/**
 * Ein Monat als Raster — immer sechs Wochen, damit nichts darunter springt.
 *
 * Markierungen wie im Kalender des Datumswählers (`DayCell` in
 * components/search/BinchDatePicker.tsx): gewählt = abgerundetes Rechteck in
 * der Akzentfarbe mit Schrift in `textOnSolid`, heute = Umrandung in der
 * Akzentfarbe. Ein Punkt unter der Zahl: An dem Tag steht eine Reise oder ein
 * Ticket.
 *
 * Die gewählte Fläche trägt ihre EIGENE Zahl und blendet über die normale —
 * würde die Zahl selbst umgefärbt, stünde sie für die Dauer des Einblendens
 * dunkel auf dunklem Grund, also kurz unsichtbar.
 */
const MonthGrid = memo(function MonthGrid({
  month,
  selected,
  todayKey,
  marked,
  accent,
  onAccent,
  dateLocale,
  onPick,
}: {
  month: Date;
  selected: string | null;
  todayKey: string;
  marked: Map<string, Entry[]>;
  accent: string;
  onAccent: string;
  dateLocale: (typeof DATE_LOCALES)[keyof typeof DATE_LOCALES];
  onPick: (d: Date) => void;
}) {
  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [month]);
  return (
    <View>
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <View key={row} style={styles.week}>
          {days.slice(row * 7, row * 7 + 7).map((d) => {
            const key = format(d, "yyyy-MM-dd");
            const inMonth = isSameMonth(d, month);
            const isSel = inMonth && key === selected;
            // Heute nur im eigenen Monat markieren — in der Überlappung am Rand
            // läse es sich, als gehöre der Tag zum gezeigten Monat.
            const isToday = inMonth && key === todayKey;
            const has = marked.has(key);
            const num = format(d, "d");
            return (
              <Pressable
                key={key}
                onPress={() => onPick(d)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSel }}
                accessibilityLabel={format(d, "EEEE, d MMMM", { locale: dateLocale })}
                style={styles.cell}
              >
                {isToday ? <View pointerEvents="none" style={[styles.mark, styles.todayRing, { borderColor: accent }]} /> : null}
                <Text style={[styles.dayText, !inMonth && styles.dayOut, inMonth && key < todayKey && styles.dayPast]}>
                  {num}
                </Text>
                {has ? <View style={[styles.dot, { backgroundColor: inMonth ? accent : C.g3 }]} /> : null}
                {isSel ? (
                  <Animated.View
                    entering={selectIn}
                    exiting={selectOut}
                    pointerEvents="none"
                    style={[styles.mark, styles.selMark, { backgroundColor: accent }]}
                  >
                    <Text style={[styles.dayText, styles.selText, { color: onAccent }]}>{num}</Text>
                    {has ? <View style={[styles.selDot, { backgroundColor: onAccent }]} /> : null}
                  </Animated.View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
});

const styles = scaledStyles({
  /** Keine Android-Höhe — die Detail-Blätter müssen darüber liegen (siehe Dateikopf). */
  scrim: { backgroundColor: "rgba(0,0,0,0.6)" },
  /** `top` kommt zur Laufzeit dazu — es hängt an der sicheren Fläche. */
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
  },
  /** Maße wie die Kopfzeile des Mitteilungs-Blatts — nur das X auf der anderen
   *  Seite. Oben `SHEET_HEAD_TOP` wie in jedem Blatt. */
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: GUTTER,
    paddingTop: SHEET_HEAD_TOP,
    paddingBottom: SPACE.lg,
  },
  title: { ...SHEET_TITLE, flex: 1 },

  /** Der Kalender als eine Karte — dieselbe Fläche und Rundung wie die Karten der Einstellungen. */
  card: {
    marginHorizontal: GUTTER,
    borderRadius: 20,
    paddingTop: SPACE.xs,
    paddingBottom: SPACE.sm,
    paddingHorizontal: SPACE.sm,
  },
  monthRow: { flexDirection: "row", alignItems: "center", paddingLeft: SPACE.sm, minHeight: 48 },
  monthLabelBox: { flex: 1, height: LABEL_H, justifyContent: "center", overflow: "hidden" },
  monthLabel: {
    fontSize: 18,
    lineHeight: LABEL_H,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.3,
    textTransform: "capitalize",
  },
  monthYear: { fontWeight: "500", color: C.g2 },
  overlay: { position: "absolute", left: 0, right: 0, top: 0 },
  hidden: { opacity: 0 },
  todayBtn: { height: 32, paddingHorizontal: SPACE.sm, justifyContent: "center", marginRight: SPACE.xs },
  todayText: { fontSize: 14, fontWeight: "600", color: C.sub },
  navBtn: { width: 38, height: 38, alignItems: "center", justifyContent: "center" },

  week: { flexDirection: "row" },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 11.5,
    fontWeight: "600",
    color: C.g3,
    letterSpacing: 0.3,
    paddingBottom: SPACE.sm,
    textTransform: "capitalize",
  },
  gridBox: { overflow: "hidden" },
  cell: { flex: 1, height: CELL_H, alignItems: "center", justifyContent: "center" },
  /** 15/600 wie die Zahlen im Datumswähler. */
  dayText: { fontSize: 15, fontWeight: "600", color: C.white, fontVariant: ["tabular-nums"] },
  dayOut: { color: C.g3 },
  dayPast: { color: C.g2 },
  /** Mittig unter der Zahl, ohne sie anzuheben — die Zahl steht exakt in der Zellmitte. */
  dot: { position: "absolute", top: CELL_H / 2 + 10, left: "50%", marginLeft: -2, width: 4, height: 4, borderRadius: 2 },
  /**
   * Fläche der Markierungen — Maße der Tageszelle im Datumswähler: Radius 13,
   * 1,5 Punkte Luft zur Nachbarzelle (dort `marginHorizontal: 1.5`).
   */
  mark: {
    position: "absolute",
    top: MARK_INSET_Y,
    bottom: MARK_INSET_Y,
    left: 1.5,
    right: 1.5,
    borderRadius: 13,
  },
  todayRing: { borderWidth: 1.5 },
  selMark: { alignItems: "center", justifyContent: "center" },
  selText: { fontWeight: "800" },
  /** Derselbe Punkt wie `dot`, nur innerhalb der Fläche gerechnet (sie beginnt `MARK_INSET_Y` tiefer). */
  selDot: {
    position: "absolute",
    top: CELL_H / 2 + 10 - MARK_INSET_Y,
    left: "50%",
    marginLeft: -2,
    width: 4,
    height: 4,
    borderRadius: 2,
  },

  list: { flex: 1 },
  dayHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.md,
    paddingHorizontal: GUTTER,
    paddingTop: SPACE.xl,
    paddingBottom: SPACE.md,
  },
  dayTitle: { flexShrink: 1, fontSize: 16, fontWeight: "700", color: C.white, letterSpacing: -0.2, textTransform: "capitalize" },
  countRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  countNum: { fontSize: 14, fontWeight: "600", color: C.g2, fontVariant: ["tabular-nums"] },
  empty: { fontSize: 14, lineHeight: 20, color: C.g2, paddingHorizontal: GUTTER },
  item: { paddingHorizontal: GUTTER, marginBottom: ITEM_GAP },
  ticket: {},
});
