/**
 * Das BLATT der geplanten Aufgaben: anlegen, ändern, Verlauf einer Aufgabe.
 *
 * FAHRT, RUHEHÖHE, VERDUNKELUNG UND WISCH-GESTE sind die des Kalender-Blatts
 * (components/saved/CalendarSheet.tsx), also auch die des Mitteilungs-Blatts. Es
 * hängt wie sie an der Wurzel: Der Ortswähler muss darüber aufgehen können, und
 * der liegt dort.
 *
 * DIE BEDIENUNG KOMMT AUS DER SUCHE, nicht aus einem Nachbau:
 *  - Von/Nach sind die Felder des Such-Blatts samt Tausch-Knopf und öffnen
 *    denselben Ortswähler.
 *  - Die Uhrzeit ist das Räder-Blatt des Datumswählers (`TimeSheet`), geöffnet
 *    über dasselbe Feld mit Zeit-Chip.
 *  - Gewählte Tage sehen aus wie der gewählte Tag im Datumswähler.
 *
 * Reihenfolge beim Anlegen und Löschen: erst das Netz, dann fährt das Blatt
 * hinaus, und erst wenn es unten ist, tut sich etwas an der Liste darunter
 * (`ScheduledPage`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, BackHandler, Dimensions, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  type EntryExitAnimationFunction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import Svg, { Ellipse, Path } from "react-native-svg";
import { Activity, ArrowUpDown, Clock, MapPin, Pencil, RotateCw, Train, Trash2, X } from "lucide-react-native";
import {
  boTaskRunsKeyFor,
  boTasksKeyFor,
  createBoTask,
  deleteBoTask,
  fetchBoTaskRuns,
  fetchBoTasks,
  isTaskLimitError,
  runBoTask,
  updateBoTask,
  type BoTask,
  type BoTaskNotify,
  type BoTaskRun,
  type BoTaskTrip,
  type BoTaskStatus,
} from "@/lib/api/chats";
import {
  announceTaskRemoved,
  closeTaskSheet,
  openTaskSheet,
  requestAskBo,
  useTaskSheet,
  type TaskPlace,
  type TaskSheetRequest,
  type TaskSheetSlot,
} from "@/lib/assistant/taskSheet";
import { daysLabel, deviceTimezone, scheduleLabel, whenLabel } from "@/lib/assistant/taskFormat";
import { nextRunIso } from "@/components/assistant/ScheduledPage";
import { formatTimeInZone } from "@/lib/time-format";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";
import { HOME_HEADER_H, FIELD_H, GUTTER, SPACE, TITLE_GAP, GROUP_GAP, SECTION_GAP, ITEM_GAP } from "@/lib/theme/spacing";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";
import { preloadLocationPicker } from "@/lib/nav/pickerPreload";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { dragHealOffset, snapToPixel, useSheetScrollGate, useSheetSwipe, type SheetScrollGate } from "@/lib/ui/sheetSwipe";
import { ensurePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { showAlert } from "@/lib/alert";
import { FadePress } from "@/components/ui/FadePress";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { SHEET_HEAD_TOP, SHEET_TITLE } from "@/components/ui/SheetModal";
import { ChoiceSegment, DangerButton } from "@/components/settings/SettingsBlocks";
import { TimeSheet } from "@/components/search/TimeSheet";
import { ms, scaledStyles } from "@/lib/ui/compact";

const C = {
  white: "#F4F4F5",
  sub: "#C8C8CC",
  g2: "#8E8E93",
  g3: "#56565C",
  error: "#FF7A6B",
  warn: "#F5A142",
  raised: "#2C2C2F",
  closeIcon: "#E5E7EB",
};

type T = ReturnType<typeof useT>;

const WINDOW_H = Dimensions.get("window").height;
const SHEET_RADIUS = 28;
/** Dasselbe Raster wie im Datumswähler. */
const MINUTE_STEP = 5;
/** Wie weit die Karte unter dem Blatt wartet, bis es unten ist. */
const AFTER_SHEET_MS = SHEET_OUT.duration + 40;
/** Die „Bis"-Zeile: Alles darunter rückt über den UI-Strang, ohne Layout je Bild. */
const FORM_SLIDE = LinearTransition.duration(220).easing(Easing.out(Easing.cubic));
const WATCH_IN = FadeIn.duration(180);
const WATCH_OUT = FadeOut.duration(120);
const SWAP_TURN = { duration: 260, easing: Easing.out(Easing.cubic) };
const BODY_IN = FadeIn.duration(180);

/** Mo = 1 … So = 64 — wie am Server. */
const WEEKDAYS = 31;
const DAILY = 127;

const pad2 = (n: number) => String(n).padStart(2, "0");
const toHm = (hour: number, minute: number) => `${pad2(hour)}:${pad2(minute)}`;
function parseHm(hm: string): { hour: number; minute: number } {
  const [hour = 0, minute = 0] = hm.split(":").map(Number);
  return { hour, minute };
}
/** Eine Stunde später, höchstens bis kurz vor Mitternacht. */
function laterHm(hm: string): string {
  const { hour, minute } = parseHm(hm);
  return hour >= 23 ? "23:55" : toHm(hour + 1, minute);
}

function autoTitle(time: string, t: T): string {
  const hour = parseHm(time).hour;
  if (hour < 11) return t("bo.task.auto.morning");
  if (hour < 15) return t("bo.task.auto.midday");
  return t("bo.task.auto.afternoon");
}

/** Die Stelle in der Liste aktualisieren, ohne auf das Netz zu warten — die Karte zieht sonst erst danach ein. */
function useTaskList() {
  const queryClient = useQueryClient();
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  return useMemo(() => {
    const key = boTasksKeyFor(userId);
    return {
      key,
      refresh: () => void queryClient.invalidateQueries({ queryKey: key }),
      add: (task: BoTask) => {
        queryClient.setQueryData<{ tasks: BoTask[]; limit: number }>(key, (prev) =>
          prev ? { ...prev, tasks: [...prev.tasks, task] } : prev,
        );
      },
    };
  }, [queryClient, userId]);
}

export function TaskSheetHost({ slot = "main" }: { slot?: TaskSheetSlot }) {
  const t = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { request, session } = useTaskSheet(slot);
  const open = request !== null;
  /** Der letzte Auftrag bleibt stehen, sonst verschwände der Inhalt mitten im Hinausfahren. */
  const lastRef = useRef<TaskSheetRequest | null>(request);
  if (request) lastRef.current = request;
  const shown = lastRef.current;

  // Lage fest unter der sicheren Fläche, Ruhepunkt an der Kopfzeile — siehe Kalender-Blatt.
  const top = insets.top;
  const park = Math.max(1, WINDOW_H - top);
  const restY = HOME_HEADER_H;
  const { y, run, adopt, parkNow, warm, heal } = useSheetSlide(slot === "edit" ? "taskEdit" : "taskSheet", park);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(y.value + restY) + dragHealOffset(heal) }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - y.value / park }));

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
    else Keyboard.dismiss();
    run(open);
  }, [open, run]);

  /** Wisch nach unten schließt — die Geste fährt die Ausfahrt selbst (siehe Mitteilungs-Blatt). */
  const gate = useSheetScrollGate();
  const dismissBySwipe = useCallback(
    (durationMs: number, fromY: number) => {
      adopt(false, durationMs, fromY);
      lastOpen.current = false;
      Keyboard.dismiss();
      closeTaskSheet(slot);
    },
    [adopt],
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

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeTaskSheet(slot);
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const dismiss = useCallback(() => {
    haptic("button");
    closeTaskSheet(slot);
  }, []);

  /** Tippen neben das Blatt zählt erst, wenn es oben steht (Doppeltipp auf die Karte). */
  const dismissFromScrim = () => {
    if (Date.now() - enteredAt.current < SHEET_IN.duration) return;
    dismiss();
  };

  // Das Blatt reicht um den Ruhepunkt unter den Bildrand — so viel mehr Luft unten.
  const bottomPad = restY + insets.bottom + SPACE.lg;

  return (
    // Berührungs-Sperre auf der ruhenden Hülle, nicht auf den bewegten Knoten.
    <View
      style={[StyleSheet.absoluteFillObject, styles.layer, slot === "edit" && styles.layerTop]}
      pointerEvents={open ? "auto" : "none"}
    >
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFillObject, styles.scrim, scrimStyle]} />
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={dismissFromScrim}
      />
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.sheet, { top, backgroundColor: palette.s1 }, sheetStyle]}>
          {shown ? (
            // Nur beim Wechsel im offenen Blatt blenden; beim Öffnen fährt der Inhalt fertig mit hoch.
            <Animated.View key={session} entering={lastOpen.current ? BODY_IN : undefined} style={styles.body}>
              {shown.kind === "detail" ? (
                <DetailBody taskId={shown.taskId} onClose={dismiss} gate={gate} bottomPad={bottomPad} t={t} />
              ) : (
                <FormBody request={shown} slot={slot} onClose={dismiss} gate={gate} bottomPad={bottomPad} t={t} />
              )}
            </Animated.View>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function SheetHeader({
  title,
  onClose,
  t,
  action,
  children,
}: {
  title: string;
  onClose: () => void;
  t: T;
  /** Ein Symbol-Knopf links vom X (Ändern) — ohne Kreis, wie das X. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      {/* Titel und Knöpfe auf EINER Mittellinie — wie im Mitteilungs- und Kalender-Blatt. */}
      <View style={styles.headRow}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {action}
        {/* `FadePress` statt Welle: Dieser Knopf startet die Ausfahrt (siehe Mitteilungs-Blatt). */}
        <FadePress onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={t("common.close")}>
          <X color={C.closeIcon} size={26} />
        </FadePress>
      </View>
      {children}
    </View>
  );
}

/* ------------------------------------------------------------------ Formular */

function FormBody({
  request,
  slot,
  onClose,
  gate,
  bottomPad,
  t,
}: {
  request: Extract<TaskSheetRequest, { kind: "new" | "edit" }>;
  slot: TaskSheetSlot;
  onClose: () => void;
  gate: SheetScrollGate;
  bottomPad: number;
  t: T;
}) {
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const list = useTaskList();
  const editing = request.kind === "edit" ? request.task : null;
  const draft = request.kind === "new" ? request.draft : undefined;

  const [title, setTitle] = useState(editing?.title ?? draft?.title ?? "");
  const [origin, setOrigin] = useState<TaskPlace | null>(
    editing ? { code: editing.origin, label: editing.originLabel } : (draft?.origin ?? null),
  );
  const [destination, setDestination] = useState<TaskPlace | null>(
    editing ? { code: editing.destination, label: editing.destLabel } : (draft?.destination ?? null),
  );
  const [days, setDays] = useState(editing?.days ?? draft?.days ?? WEEKDAYS);
  /** „Eigene" gewählt, auch wenn die Tage gerade einer Vorgabe entsprechen. */
  const [custom, setCustom] = useState(false);
  const [time, setTime] = useState(editing?.time ?? draft?.time ?? "08:00");
  const initialUntil = editing?.watchUntil ?? draft?.watchUntil ?? null;
  const [watch, setWatch] = useState(initialUntil !== null);
  const [until, setUntil] = useState(initialUntil ?? laterHm(editing?.time ?? draft?.time ?? "08:00"));
  const [notify, setNotify] = useState<BoTaskNotify>(editing?.notify ?? draft?.notify ?? "always");
  const [picker, setPicker] = useState<"time" | "until" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tasks = useQuery({
    queryKey: boTasksKeyFor(userId),
    queryFn: fetchBoTasks,
    enabled: userId != null,
    staleTime: 15_000,
  });
  const active = tasks.data?.tasks.filter((x) => x.active).length ?? 0;
  const limit = tasks.data?.limit ?? 5;

  const preset = custom || (days !== WEEKDAYS && days !== DAILY) ? "custom" : days === DAILY ? "daily" : "weekdays";

  const swapTurn = useSharedValue(0);
  const swapTarget = useRef(0);
  const swapStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${swapTurn.value}deg` }] }));
  const swap = () => {
    haptic("button");
    swapTarget.current += 180;
    swapTurn.value = withTiming(swapTarget.current, SWAP_TURN);
    setOrigin(destination);
    setDestination(origin);
  };

  const prepareRoute = (field: "from" | "to") => {
    preloadLocationPicker({ sessionKey: 0, field, mode: "TRAIN", suggested: POPULAR_LOCATIONS.TRAIN });
    requestAnimationFrame(() => prepareLayer("pickerLocation"));
  };
  const pickRoute = (field: "from" | "to") => {
    haptic("button");
    Keyboard.dismiss();
    useSearchStore.getState().openLocationPicker({
      field,
      mode: "TRAIN",
      suggested: POPULAR_LOCATIONS.TRAIN,
      onSelect: (loc) => {
        const place = { code: loc.code, label: loc.label };
        if (field === "from") setOrigin(place);
        else setDestination(place);
      },
    });
  };

  const openTime = (which: "time" | "until") => {
    haptic("button");
    Keyboard.dismiss();
    setPicker(which);
  };
  const applyTime = (hour: number, minute: number) => {
    const next = toHm(hour, minute);
    if (picker === "until") {
      setUntil(next);
      return;
    }
    setTime(next);
    if (until <= next) setUntil(laterHm(next));
  };

  const ready =
    origin !== null &&
    destination !== null &&
    origin.code !== destination.code &&
    days !== 0 &&
    (!watch || until > time);

  const submit = async () => {
    if (!ready || busy) return;
    Keyboard.dismiss();
    haptic("button");
    setBusy(true);
    setError(null);
    const fields = {
      title: title.trim() || autoTitle(time, t),
      origin: origin.code,
      destination: destination.code,
      originLabel: origin.label,
      destLabel: destination.label,
      days,
      time,
      watchUntil: watch ? until : null,
      notify,
    };
    try {
      // Erlaubnis + Kanal VOR der ersten Meldung — sonst käme sie stumm an.
      await ensurePushToken();
      if (editing) {
        await updateBoTask(editing.id, fields);
        haptic("important");
        closeTaskSheet(slot);
        list.refresh();
        return;
      }
      const { task } = await createBoTask(
        { kind: "route_status", ...fields },
        { timezone: deviceTimezone(), locale, conversationId: null },
      );
      haptic("important");
      closeTaskSheet(slot);
      setTimeout(() => {
        list.add(task);
        list.refresh();
      }, AFTER_SHEET_MS);
    } catch (e) {
      setBusy(false);
      setError(t(isTaskLimitError(e) ? "bo.task.limit" : "bo.task.failed"));
    }
  };

  const pickerIsUntil = picker === "until";
  const pickerValue = parseHm(pickerIsUntil ? until : time);

  return (
    <>
      <SheetHeader title={t(editing ? "bo.task.editTitle" : "bo.task.newTitle")} onClose={onClose} t={t}>
        {editing ? null : (
          <View style={styles.slotRow}>
            <View style={styles.slots}>
              {Array.from({ length: limit }, (_, i) => (
                <View
                  key={i}
                  style={[styles.slot, { backgroundColor: i <= active ? accent.solid : C.raised }, i === active && styles.slotNext]}
                />
              ))}
            </View>
            <Text style={styles.slotText}>
              {t("bo.task.slot").replace("{n}", String(Math.min(active + 1, limit))).replace("{max}", String(limit))}
            </Text>
          </View>
        )}
      </SheetHeader>

      {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am Blatt jedes Scrollen ab. */}
      <GestureDetector gesture={gate.native}>
        <Animated.ScrollView
          ref={gate.ref}
          style={styles.fill}
          contentContainerStyle={styles.form}
          showsVerticalScrollIndicator={false}
          onScroll={gate.onScroll}
          scrollEventThrottle={16}
          overScrollMode="never"
          bounces={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.field, styles.inset, { backgroundColor: palette.s2 }]}>
            <View style={styles.fill}>
              <Text style={styles.fieldLabel}>{t("bo.task.name")}</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={autoTitle(time, t)}
                placeholderTextColor={C.g3}
                maxLength={60}
                returnKeyType="done"
                underlineColorAndroid="transparent"
                style={styles.fieldInput}
              />
            </View>
          </View>

          <View style={[styles.routeWrap, styles.inset]}>
            <View style={styles.routeFields}>
              <RippleTouch
                style={[styles.routeField, { backgroundColor: palette.s2 }]}
                onTouchStart={() => prepareRoute("from")}
                onPress={() => pickRoute("from")}
                accessibilityRole="button"
              >
                <Train size={20} color={C.sub} strokeWidth={1.9} />
                <Text style={[styles.routeText, !origin && styles.routeTextEmpty]} numberOfLines={1}>
                  {origin ? origin.label : t("search.fromPlaceholder.train")}
                </Text>
              </RippleTouch>
              <RippleTouch
                style={[styles.routeField, { backgroundColor: palette.s2 }]}
                onTouchStart={() => prepareRoute("to")}
                onPress={() => pickRoute("to")}
                accessibilityRole="button"
              >
                <MapPin size={20} color={C.sub} strokeWidth={1.9} />
                <Text style={[styles.routeText, !destination && styles.routeTextEmpty]} numberOfLines={1}>
                  {destination ? destination.label : t("search.toPlaceholder.train")}
                </Text>
              </RippleTouch>
            </View>
            <View style={styles.routeSwapWrap}>
              <RippleTouch
                borderless
                onPress={swap}
                accessibilityRole="button"
                accessibilityLabel={t("bo.task.swap")}
                style={[styles.routeSwapBtn, { backgroundColor: accent.solid, borderColor: palette.s1 }]}
              >
                <Animated.View style={swapStyle}>
                  <ArrowUpDown size={17} color={accent.textOnSolid} strokeWidth={2.6} />
                </Animated.View>
              </RippleTouch>
            </View>
          </View>

          <View style={styles.inset}>
            <Text style={styles.label}>{t("bo.task.daysLabel")}</Text>
            <ChoiceSegment
              items={[
                { id: "weekdays" as const, label: t("bo.task.days.weekdays") },
                { id: "daily" as const, label: t("bo.task.days.daily") },
                { id: "custom" as const, label: t("bo.task.days.custom") },
              ]}
              value={preset}
              onChange={(v) => {
                haptic("tick");
                if (v === "custom") {
                  setCustom(true);
                  return;
                }
                setCustom(false);
                setDays(v === "daily" ? DAILY : WEEKDAYS);
              }}
            />
            <View style={styles.dayRow} accessibilityRole="radiogroup">
              {Array.from({ length: 7 }, (_, i) => (
                <DayChip
                  key={i}
                  label={t(`bo.task.day.${i + 1}`)}
                  on={(days & (1 << i)) !== 0}
                  onPress={() => {
                    haptic("tick");
                    setCustom(true);
                    setDays(days ^ (1 << i));
                  }}
                />
              ))}
            </View>
          </View>

          {/* Dasselbe Feld wie im Datumswähler: Text links, Zeit-Chip rechts, das ganze Feld öffnet die Räder. */}
          <Pressable style={[styles.field, styles.inset, { backgroundColor: palette.s2 }]} onPress={() => openTime("time")}>
            <View style={styles.fill}>
              <Text style={styles.fieldLabel}>{t("bo.task.timeLabel")}</Text>
              <Text style={days === 0 ? styles.fieldPlaceholder : styles.fieldValue} numberOfLines={1}>
                {days === 0 ? t("bo.task.noDays") : daysLabel(days, t)}
              </Text>
            </View>
            <TimeChip value={time} />
          </Pressable>

          <Animated.View layout={FORM_SLIDE} style={[styles.watch, styles.inset, { backgroundColor: palette.s2 }]}>
            <View style={styles.watchTop}>
              <Activity size={18} color={C.sub} strokeWidth={1.9} />
              <View style={styles.fill}>
                <Text style={styles.watchTitle}>{t("bo.task.watch")}</Text>
                <Text style={styles.watchDesc}>{t("bo.task.watchDesc")}</Text>
              </View>
              <BinchSwitch
                value={watch}
                onValueChange={(v) => {
                  haptic("button");
                  if (v && until <= time) setUntil(laterHm(time));
                  setWatch(v);
                }}
                accessibilityLabel={t("bo.task.watch")}
              />
            </View>
            {watch ? (
              <Animated.View entering={WATCH_IN} exiting={WATCH_OUT}>
                <Pressable style={[styles.watchRow, { borderTopColor: palette.s3 }]} onPress={() => openTime("until")}>
                  <Text style={styles.watchTitle}>{t("bo.task.until")}</Text>
                  <TimeChip value={until} />
                </Pressable>
              </Animated.View>
            ) : null}
          </Animated.View>

          <Animated.View layout={FORM_SLIDE} style={styles.form}>
          <View style={styles.inset}>
            <Text style={styles.label}>{t("bo.task.notifyLabel")}</Text>
            <ChoiceSegment
              items={[
                { id: "always" as const, label: t("bo.task.notify.always") },
                { id: "issues" as const, label: t("bo.task.notify.issues") },
              ]}
              value={notify}
              onChange={(v) => {
                haptic("tick");
                setNotify(v);
              }}
            />
          </View>

          <View style={styles.inset}>
            <Text style={styles.label}>{t("bo.task.previewLabel")}</Text>
            <View style={[styles.preview, { backgroundColor: palette.s2 }]}>
              <BoGlyph />
              <View style={styles.fill}>
                <View style={styles.previewHead}>
                  <Text style={styles.previewTitle} numberOfLines={1}>
                    {title.trim() || autoTitle(time, t)}
                  </Text>
                  <Text style={styles.previewTime}>{time.replace(/^0/, "")}</Text>
                </View>
                <Text style={styles.previewBody}>{t(notify === "always" ? "bo.task.preview.always" : "bo.task.preview.issues")}</Text>
                <Text style={styles.previewNote}>{t("bo.task.preview.note")}</Text>
              </View>
            </View>
          </View>

          {editing ? null : (
            <View style={styles.askBo}>
              <FadePress
                onPress={() => {
                  closeTaskSheet(slot);
                  setTimeout(requestAskBo, AFTER_SHEET_MS);
                }}
                accessibilityRole="button"
              >
                <Text style={styles.askBoText}>
                  {t("bo.task.askLead")} <Text style={[styles.askBoLink, { color: accent.solid }]}>{t("bo.task.askLink")}</Text>
                </Text>
              </FadePress>
            </View>
          )}
          </Animated.View>
        </Animated.ScrollView>
      </GestureDetector>

      <View style={[styles.footer, { paddingBottom: bottomPad }]}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <RippleTouch
          onPress={() => void submit()}
          disabled={!ready || busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: !ready || busy }}
          rippleColor="rgba(0,0,0,0.32)"
          style={[styles.apply, { backgroundColor: ready ? accent.solid : palette.s3 }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={accent.textOnSolid} />
          ) : (
            <Text style={[styles.applyText, { color: ready ? accent.textOnSolid : C.g2 }]}>
              {t(editing ? "bo.task.save" : "bo.task.create")}
            </Text>
          )}
        </RippleTouch>
      </View>

      <TimeSheet
        visible={picker !== null}
        hour={pickerValue.hour}
        minute={pickerValue.minute}
        minuteStep={MINUTE_STEP}
        title={t(pickerIsUntil ? "bo.task.untilTitle" : "bo.task.timeTitle")}
        subtitle={t(pickerIsUntil ? "bo.task.untilSub" : "bo.task.timeSub")}
        defaultTime={pickerIsUntil ? parseHm(laterHm(time)) : { hour: 8, minute: 0 }}
        onClose={() => setPicker(null)}
        onApply={applyTime}
      />
    </>
  );
}

/** Der Zeit-Chip des Datumswählers: Akzent auf zartem Grund, Uhr davor. */
function TimeChip({ value }: { value: string }) {
  const accent = useAccent();
  return (
    <View style={[styles.timeChip, { backgroundColor: accent.subtle }]}>
      <Clock color={accent.solid} size={13} strokeWidth={2.4} />
      <Text style={[styles.timeChipText, { color: accent.solid }]}>{value}</Text>
    </View>
  );
}

/** Gewählt sieht aus wie der gewählte Tag im Datumswähler; die Fläche blendet über. */
function DayChip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const palette = usePalette();
  const accent = useAccent();
  const fill = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(on ? 1 : 0, { duration: 140 });
  }, [on, fill]);
  const fillStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      style={[styles.day, { backgroundColor: palette.s2 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: accent.solid }, fillStyle]} />
      <Text style={[styles.dayText, on ? { color: accent.textOnSolid, fontWeight: "800" } : styles.dayTextOff]}>{label}</Text>
    </Pressable>
  );
}

/** Bos Umriss, klein und ruhig — für die Vorschau der Mitteilung. */
function BoGlyph() {
  return (
    <Svg width={ms(26)} height={ms(30)} viewBox="20 40 160 185" accessibilityElementsHidden>
      <Path
        d="M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z"
        fill="#F4F4F5"
      />
      <Ellipse cx={76} cy={120} rx={16} ry={21} fill="#0D0D0D" />
      <Ellipse cx={124} cy={120} rx={16} ry={21} fill="#0D0D0D" />
    </Svg>
  );
}

/* ------------------------------------------------------------------- Details */

/**
 * Der Verlauf einer Aufgabe — schlicht: Titel mit Strecke und Plan, oben das
 * Stift-Symbol neben dem X, darunter die Zeitleiste. „Jetzt prüfen" steht leise
 * an ihrer Überschrift, dort, wo sein Ergebnis erscheint.
 */
function DetailBody({
  taskId,
  onClose,
  gate,
  bottomPad,
  t,
}: {
  taskId: string;
  onClose: () => void;
  gate: SheetScrollGate;
  bottomPad: number;
  t: T;
}) {
  const accent = useAccent();
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const queryClient = useQueryClient();
  const list = useTaskList();
  const locale = useSearchStore((s) => s.locale);
  const [checking, setChecking] = useState(false);

  const tasks = useQuery({
    queryKey: boTasksKeyFor(userId),
    queryFn: fetchBoTasks,
    enabled: userId != null,
    staleTime: 15_000,
  });
  const runs = useQuery({ queryKey: boTaskRunsKeyFor(taskId), queryFn: () => fetchBoTaskRuns(taskId) });
  const task = tasks.data?.tasks.find((x) => x.id === taskId);

  if (!task) {
    return (
      <>
        <SheetHeader title={t("assistant.threads.scheduled")} onClose={onClose} t={t} />
        {tasks.isLoading ? null : <Text style={[styles.hint, styles.inset]}>{t("bo.task.gone")}</Text>}
      </>
    );
  }

  const limit = tasks.data?.limit ?? 5;
  const active = tasks.data?.tasks.filter((x) => x.active).length ?? 0;
  /** Pausiert darf sie nur laufen, solange ein Platz frei ist — der Server prüft dasselbe. */
  const blocked = !task.active && active >= limit;
  const blockedAlert = () => {
    haptic("important");
    showAlert(t("bo.task.fullTitle").replace("{max}", String(limit)), t("bo.task.fullCheckBody"));
  };

  const checkNow = async () => {
    if (checking) return;
    if (blocked) {
      blockedAlert();
      return;
    }
    haptic("button");
    setChecking(true);
    try {
      const { run } = await runBoTask(taskId);
      // Das Ergebnis kommt als neue Karte oben dazu — ohne Abruf, sonst fiele
      // dessen Commit mitten ins Nachrücken der anderen Karten.
      queryClient.setQueryData<{ runs: BoTaskRun[] }>(boTaskRunsKeyFor(taskId), (prev) => ({
        runs: [run, ...(prev?.runs ?? [])],
      }));
      setTimeout(list.refresh, CARD_MOVE.duration + 120);
    } catch (e) {
      if (isTaskLimitError(e)) blockedAlert();
      else if (e instanceof Error && e.message === "Too soon") showAlert(t("bo.task.tooSoonTitle"), t("bo.task.tooSoon"));
      else {
        showAlert(t("bo.task.checkFailedTitle"), t("bo.task.checkFailed"));
        // Drüben läuft sie womöglich weiter — dann steht das Ergebnis gleich da.
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: boTaskRunsKeyFor(taskId) }), 20_000);
      }
    } finally {
      setChecking(false);
    }
  };

  const remove = () => {
    haptic("important");
    showAlert(t("bo.task.deleteTitle"), t("bo.task.deleteBody"), [
      { text: t("bo.task.cancel"), style: "cancel" },
      {
        text: t("bo.task.deleteConfirm"),
        style: "destructive",
        onPress: () => {
          void deleteBoTask(taskId)
            .then(() => {
              closeTaskSheet("main");
              setTimeout(() => {
                if (!announceTaskRemoved(taskId)) list.refresh();
              }, AFTER_SHEET_MS);
            })
            .catch(() => showAlert(t("bo.task.deleteFailedTitle"), t("bo.task.deleteFailed")));
        },
      },
    ]);
  };

  const next = task.active ? nextRunIso(task) : null;
  const groups = groupRuns(runs.data?.runs ?? []);

  return (
    <>
      <SheetHeader
        title={task.title}
        onClose={onClose}
        t={t}
        action={
          <FadePress
            onPress={() => {
              haptic("button");
              openTaskSheet({ kind: "edit", task });
            }}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t("bo.task.edit")}
          >
            <Pencil color={C.closeIcon} size={21} strokeWidth={2} />
          </FadePress>
        }
      >
        <Text style={styles.detailRoute} numberOfLines={2}>
          {task.originLabel} → {task.destLabel}
        </Text>
        <Text style={styles.detailMeta} numberOfLines={1}>
          {scheduleLabel(task, t)} · {t(`bo.task.notifyShort.${task.notify}`)}
        </Text>
        <Text style={styles.detailMeta} numberOfLines={1}>
          {next ? t("bo.task.nextAt").replace("{when}", whenLabel(next, locale, t)) : t("bo.scheduled.paused")}
        </Text>
      </SheetHeader>

      <GestureDetector gesture={gate.native}>
        <Animated.ScrollView
          ref={gate.ref}
          style={styles.fill}
          contentContainerStyle={{ paddingBottom: bottomPad }}
          showsVerticalScrollIndicator={false}
          onScroll={gate.onScroll}
          scrollEventThrottle={16}
          overScrollMode="never"
          bounces={false}
        >
          <View style={[styles.inset, styles.historyHead]}>
            <Text style={styles.historyLabel}>{t("bo.task.history")}</Text>
            <FadePress
              onPress={() => void checkNow()}
              disabled={checking}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityState={{ disabled: blocked }}
            >
              <View style={[styles.checkPill, { backgroundColor: accent.solid }, blocked && styles.checkLinkOff]}>
                {/* Feste Fläche fürs Symbol: Der Kreisel ist größer und soll die Pille nicht verbreitern. */}
                <View style={styles.checkIcon}>
                  {checking ? (
                    <ActivityIndicator size="small" color={accent.textOnSolid} style={styles.checkSpinner} />
                  ) : (
                    <RotateCw size={14} color={accent.textOnSolid} strokeWidth={2.4} />
                  )}
                </View>
                <Text style={[styles.checkText, { color: accent.textOnSolid }]}>{t("bo.task.runNow")}</Text>
              </View>
            </FadePress>
          </View>
          {/* Beim Öffnen (und wenn der Verlauf erst nachlädt) steht alles einfach
              da; danach kommt jede neue Karte oben herein und schiebt den Rest —
              samt Löschen-Knopf — nach unten. Genau EIN Kind unter der Klammer,
              sonst hüllt Reanimated jedes einzeln ein. */}
          <LayoutAnimationConfig key={runs.isSuccess ? "ready" : "wait"} skipEntering skipExiting>
            <View collapsable={false}>
              <View style={[styles.inset, styles.runs]}>
                {groups.map((g, i) => (
                  <Animated.View key={g.key} layout={CARD_SHIFT} entering={i === 0 ? CARD_IN : undefined}>
                    <RunCard group={g} tz={task.timezone} t={t} />
                  </Animated.View>
                ))}
                {groups.length === 0 && runs.isFetched ? <Text style={styles.hint}>{t("bo.task.noRuns")}</Text> : null}
              </View>
              <Animated.View layout={CARD_SHIFT}>
                <DangerButton label={t("bo.task.delete")} Icon={Trash2} onPress={remove} />
              </Animated.View>
            </View>
          </LayoutAnimationConfig>
        </Animated.ScrollView>
      </GestureDetector>
    </>
  );
}

/** Eine neue Karte schiebt die anderen nach unten — über den UI-Strang, ohne Layout je Bild. */
const CARD_MOVE = { duration: 380, easing: Easing.bezier(0.2, 0, 0, 1) };
const CARD_SHIFT = LinearTransition.duration(CARD_MOVE.duration).easing(CARD_MOVE.easing);
const CARD_IN: EntryExitAnimationFunction = () => {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: -10 }, { scale: 0.97 }] },
    animations: {
      opacity: withTiming(1, { duration: 280 }),
      transform: [{ translateY: withTiming(0, CARD_MOVE) }, { scale: withTiming(1, CARD_MOVE) }],
    },
  };
};

interface RunGroup {
  /** Der älteste Lauf der Reihe — so bleibt die Karte dieselbe, wenn oben einer dazukommt. */
  key: string;
  newest: BoTaskRun;
  oldest: BoTaskRun;
  count: number;
}

/**
 * Gleiche Lage hintereinander wird EINE Karte („6× · 19:04–19:54"): Eine Wache,
 * die alle zehn Minuten dasselbe meldet, war sonst eine Textwand. Was man selbst
 * geprüft hat, steht immer einzeln.
 */
function groupRuns(runs: BoTaskRun[]): RunGroup[] {
  const out: RunGroup[] = [];
  for (const run of runs) {
    const prev = out[out.length - 1];
    if (
      prev &&
      run.trigger !== "manual" &&
      prev.newest.trigger === run.trigger &&
      prev.newest.status === run.status &&
      prev.newest.body === run.body
    ) {
      prev.oldest = run;
      prev.key = run.id;
      prev.count += 1;
      continue;
    }
    out.push({ key: run.id, newest: run, oldest: run, count: 1 });
  }
  return out;
}

/** Ab so viel Verspätung warnt der Server (`DELAY_MIN`) — hier dieselbe Schwelle. */
const DELAY_NOTEWORTHY = 5;
/** Mehr Fahrten machen aus der Karte eine Tafel. */
const TRIPS_SHOWN = 3;

/** Ein Lauf als Karte: Lage und Zeit oben, Bos Satz, die geprüften Fahrten, darunter woher und wie oft. */
function RunCard({ group, tz, t }: { group: RunGroup; tz: string; t: T }) {
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const run = group.newest;
  const trips = (run.facts?.trips ?? []).slice(0, TRIPS_SHOWN);
  const tone =
    run.status === "ok"
      ? { color: accent.solid, tint: accent.subtle }
      : run.status === "issue"
        ? { color: C.warn, tint: "rgba(245,161,66,0.14)" }
        : { color: C.g2, tint: palette.s3 };
  const clock = (iso: string) => format(new Date(iso), "H:mm");
  const meta = [
    group.count > 1
      ? t("bo.task.repeat")
          .replace("{n}", String(group.count))
          .replace("{from}", clock(group.oldest.ranAt))
          .replace("{to}", clock(run.ranAt))
      : null,
    t(`bo.task.run.${run.trigger}`),
    run.facts?.source === "db" ? t("bo.task.sourceDb") : run.facts?.source === "motis" ? t("bo.task.sourceOpen") : null,
    run.pushed ? t("bo.task.pushed") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.runCard, { backgroundColor: palette.s2 }]}>
      <View style={styles.runHead}>
        <View style={[styles.pill, { backgroundColor: tone.tint }]}>
          <View style={[styles.pillDot, { backgroundColor: tone.color }]} />
          <Text style={[styles.pillText, { color: tone.color }]}>{t(`bo.task.pill.${run.status}`)}</Text>
        </View>
        <Text style={styles.runWhen}>{whenLabel(run.ranAt, locale, t)}</Text>
      </View>
      <Text style={styles.runBody}>{run.body || run.title}</Text>
      {trips.length > 0 ? (
        <View style={styles.trips}>
          {trips.map((trip) => (
            <TripLine key={`${trip.line}|${trip.depart}`} trip={trip} tz={tz} t={t} />
          ))}
        </View>
      ) : null}
      {meta ? <Text style={styles.runMeta}>{meta}</Text> : null}
    </View>
  );
}

/** Eine geprüfte Fahrt: Abfahrt, Linie, Gleis — rechts, wie es um sie steht. */
function TripLine({ trip, tz, t }: { trip: BoTaskTrip; tz: string; t: T }) {
  const accent = useAccent();
  const state = trip.cancelled
    ? { text: t("results.warning.cancelled"), color: C.warn }
    : trip.delay && trip.delay > 0
      ? { text: t("bo.task.trip.delay").replace("{n}", String(trip.delay)), color: trip.delay >= DELAY_NOTEWORTHY ? C.warn : C.g2 }
      : trip.realtime
        ? { text: t("bo.task.trip.onTime"), color: accent.solid }
        : { text: t("bo.task.trip.noLive"), color: C.g2 };
  const platform = trip.platformRt ?? trip.platform;
  const moved = !!trip.platformRt && trip.platformRt !== trip.platform;
  return (
    <View style={styles.trip}>
      <Text style={[styles.tripTime, trip.cancelled && styles.tripStruck]}>{formatTimeInZone(trip.depart, tz)}</Text>
      <Text style={styles.tripLine} numberOfLines={1}>
        {trip.line}
      </Text>
      {platform ? (
        <Text style={[styles.tripPlatform, moved && { color: C.warn }]} numberOfLines={1}>
          {t("stop.platform.prefix")} {platform}
        </Text>
      ) : null}
      <Text style={[styles.tripState, { color: state.color }]} numberOfLines={1}>
        {state.text}
      </Text>
    </View>
  );
}

const styles = scaledStyles({
  /**
   * Über Bos Bühne (zIndex 50) und den Blättern am Wurzel-Layout (Höhe bis 32),
   * unter den Wählern (40) und dem Mitteilungs-Blatt (36). Die Höhe ist nur für
   * die Sortierung da, kein Schatten — siehe Mitteilungs-Blatt.
   */
  layer: { zIndex: 8000, elevation: 34, shadowColor: "transparent" },
  /** Das Blatt zum Ändern liegt über dem Verlauf. */
  layerTop: { zIndex: 8100, elevation: 35 },
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
  body: { flex: 1 },
  fill: { flex: 1, minWidth: 0 },
  inset: { marginHorizontal: GUTTER },
  spinner: { marginTop: SPACE.xl },
  hint: { fontSize: 13.5, lineHeight: 19, color: C.g2 },

  /** Maße wie die Kopfzeile des Kalender-Blatts — oben `SHEET_HEAD_TOP` wie in jedem Blatt. */
  header: { paddingHorizontal: GUTTER, paddingTop: SHEET_HEAD_TOP, paddingBottom: SPACE.lg },
  headRow: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  title: { ...SHEET_TITLE, flex: 1 },
  slotRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: SPACE.sm },
  slots: { flexDirection: "row", gap: 4 },
  slot: { width: 18, height: 4, borderRadius: 2 },
  slotNext: { opacity: 0.5 },
  slotText: { fontSize: 12.5, color: C.g2 },

  form: { gap: GROUP_GAP, paddingBottom: SPACE.lg },
  label: { fontSize: 13, fontWeight: "600", color: C.g2, marginBottom: TITLE_GAP, paddingHorizontal: SPACE.xs },

  /** Das Feld des Datumswählers — Maße, Rundung und Schrift von dort. */
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: SPACE.lg,
    borderRadius: 18,
  },
  fieldLabel: { fontSize: 11, color: C.g2, fontWeight: "600", letterSpacing: 0.4 },
  fieldValue: { fontSize: 17, color: C.white, fontWeight: "700", letterSpacing: -0.2 },
  fieldPlaceholder: { fontSize: 17, color: C.g3, fontWeight: "600", letterSpacing: -0.2 },
  fieldInput: { fontSize: 17, color: C.white, fontWeight: "700", letterSpacing: -0.2, padding: 0, includeFontPadding: false },
  timeChip: { flexDirection: "row", alignItems: "center", gap: 8, height: 38, paddingHorizontal: 16, borderRadius: 9999 },
  timeChipText: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },

  /** Die Felder des Such-Blatts, samt Tausch-Knopf über der Fuge. */
  routeWrap: { position: "relative" },
  routeFields: { gap: SPACE.sm },
  routeField: {
    height: FIELD_H,
    borderRadius: 16,
    paddingLeft: 16,
    paddingRight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minWidth: 0,
  },
  routeText: { flex: 1, fontSize: 17, fontWeight: "600", color: C.white },
  routeTextEmpty: { color: C.g2, fontWeight: "500" },
  routeSwapWrap: { position: "absolute", right: 10, top: "50%", marginTop: -22, zIndex: 3 },
  routeSwapBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 4, alignItems: "center", justifyContent: "center" },

  dayRow: { flexDirection: "row", gap: 4, marginTop: SPACE.sm },
  day: { flex: 1, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  dayText: { fontSize: 15, fontWeight: "600" },
  dayTextOff: { color: C.white },

  watch: { borderRadius: 18, overflow: "hidden" },
  watchTop: { flexDirection: "row", alignItems: "center", gap: 16, paddingLeft: SPACE.lg, paddingRight: SPACE.lg, paddingVertical: 12 },
  watchTitle: { fontSize: 15, fontWeight: "600", color: C.white, letterSpacing: -0.2 },
  watchDesc: { fontSize: 12.5, lineHeight: 17, color: C.g2, marginTop: 4 },
  watchRow: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: SPACE.lg,
    paddingRight: SPACE.lg,
    borderTopWidth: 1,
  },

  preview: { flexDirection: "row", gap: SPACE.md, paddingHorizontal: 16, paddingVertical: SPACE.md, borderRadius: 18 },
  previewHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  previewTitle: { flexShrink: 1, fontSize: 14, fontWeight: "600", color: C.white },
  previewTime: { fontSize: 12, color: C.g2 },
  previewBody: { fontSize: 13.5, lineHeight: 19, color: C.sub },
  previewNote: { fontSize: 12, color: C.g2, marginTop: SPACE.xs },

  askBo: { alignSelf: "center", paddingVertical: SPACE.xs },
  askBoText: { fontSize: 13.5, color: C.g2, textAlign: "center" },
  askBoLink: { fontWeight: "600" },

  footer: { paddingHorizontal: GUTTER, paddingTop: 8 },
  error: { fontSize: 12.5, lineHeight: 18, color: C.error, textAlign: "center", marginBottom: SPACE.sm },
  /** Der Knopf der Blätter (siehe `TimeSheet`). */
  apply: { height: 50, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  applyText: { fontSize: 16, fontWeight: "700" },

  detailRoute: { fontSize: 14, lineHeight: 19, color: C.sub, marginTop: 8 },
  detailMeta: { fontSize: 13, lineHeight: 18, color: C.g2, marginTop: 4 },

  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: TITLE_GAP },
  historyLabel: { fontSize: 13, fontWeight: "600", color: C.g2 },
  /** Wie die anderen Knöpfe: Akzentfläche, Schrift `textOnSolid` — nur als kleine Pille. */
  checkPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 32,
    paddingHorizontal: 16,
    borderRadius: 16,
    overflow: "hidden",
  },
  checkIcon: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  checkSpinner: { transform: [{ scale: 0.75 }] },
  checkLinkOff: { opacity: 0.45 },
  checkText: { fontSize: 13.5, fontWeight: "700" },

  /** Der Verlauf als Karten — Fläche und Rundung wie die Karten unter „Geplant". */
  runs: { gap: ITEM_GAP },
  runCard: { borderRadius: 20, padding: SPACE.lg, gap: SPACE.sm },
  runHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACE.sm },
  pill: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 9999 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 12, fontWeight: "700" },
  runWhen: { fontSize: 12.5, color: C.g2, fontVariant: ["tabular-nums"] },
  runBody: { fontSize: 14.5, lineHeight: 20, color: C.white },
  runMeta: { fontSize: 12, lineHeight: 17, color: C.g2 },
  /** Die geprüften Fahrten, durch eine feine Linie von Bos Satz getrennt. */
  trips: {
    gap: 8,
    paddingTop: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  trip: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  tripTime: { width: 42, fontSize: 14, fontWeight: "600", color: C.white, fontVariant: ["tabular-nums"] },
  tripStruck: { textDecorationLine: "line-through", color: C.g2 },
  tripLine: { flexShrink: 1, fontSize: 13.5, color: C.white },
  tripPlatform: { fontSize: 12.5, color: C.g2 },
  tripState: { marginLeft: "auto", paddingLeft: SPACE.sm, fontSize: 12.5, fontWeight: "600" },
});
