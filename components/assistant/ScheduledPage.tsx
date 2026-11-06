/**
 * „GEPLANT" — Bos eigener Bereich für Aufgaben, die er selbst ausführt
 * (server/src/routes/boTasks.ts). Geöffnet aus der Schublade, er tritt im Fenster
 * an die Stelle des Chats.
 *
 * Höchstens fünf Aufgaben laufen gleichzeitig, pausierte zählen nicht. Die Leiste
 * zeigt das als fünf Plätze: Sie füllt und leert sich, die Zahl rollt mit. Bei
 * einer neuen Aufgabe fährt erst das Blatt hinaus, dann zieht die Karte ein, und
 * erst dann füllt sich der Platz — eine Bewegung nach der anderen. Sind alle
 * belegt, wird der Knopf zur Aussage, und ein Tipp darauf erklärt, was zu tun ist.
 *
 * Angelegt und geändert wird im Blatt (`TaskSheet.tsx`), Bo kann dasselbe im Chat
 * vorschlagen. Jede Zeile sagt, wann zuletzt geprüft wurde: „Lage unbekannt" ist
 * ein eigener, ehrlicher Zustand und nie „alles gut".
 */
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import * as Notifications from "expo-notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, Plus } from "lucide-react-native";
import {
  boTasksKeyFor,
  fetchBoTasks,
  isTaskLimitError,
  updateBoTask,
  type BoTask,
  type BoTaskStatus,
} from "@/lib/api/chats";
import { useBoView } from "@/lib/assistant/boView";
import { GridLoader } from "@/components/ui/GridLoader";
import { GateFade, GateLoader, useLoadGate } from "@/components/ui/LoadGate";
import {
  onTaskRemoved,
  openTaskSheet,
  type TaskDraft,
  type TaskPlace,
} from "@/lib/assistant/taskSheet";
import { notifyLabel, scheduleLabel, whenLabel } from "@/lib/assistant/taskFormat";
import { ensurePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { showAlert } from "@/lib/alert";
import { showStatusToast } from "@/components/ui/StatusToast";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { BinchSwitch } from "@/components/ui/BinchSwitch";
import { ENTRY, INTRO_TOTAL, IntroRow } from "@/components/saved/IntroRow";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { FIELD_H, GUTTER, SPACE, ITEM_GAP, TITLE_GAP, GROUP_GAP } from "@/lib/theme/spacing";
import { StatePanel } from "@/components/ui/StatePanel";

const C = {
  white: "#F4F4F5",
  sub: "#C8C8CC",
  g2: "#8E8E93",
  g3: "#56565C",
  warn: "#F5A142",
  raised: "#2C2C2F",
};

type T = ReturnType<typeof useT>;

/** Zeilenhöhen der rollenden Zahlen — der Weg der Verschiebung, deshalb schon skaliert. */
const DIGIT_H = ms(22);
const FREE_H = ms(20);
const CTA_H = ms(FIELD_H);

const ROLL = { duration: 320, easing: Easing.out(Easing.cubic) };
const FILL = { duration: 340, easing: Easing.out(Easing.cubic) };
const CROSS = { duration: 220, easing: Easing.out(Easing.quad) };
/**
 * Geht eine Karte, rücken die anderen über den UI-Strang nach: EIN Commit am
 * Anfang, danach kein Layout mehr je Bild. Eine animierte Höhe lief dagegen jedes
 * Bild durch den Schattenbaum, und genau das ruckelte.
 */
const ROW_SLIDE = LinearTransition.duration(280).easing(Easing.out(Easing.cubic));
const ROW_OUT = FadeOut.duration(140);
/** Erst nach dem Nachrücken abgleichen, sonst fällt die Antwort als Commit mitten hinein. */
const RESYNC_AFTER_MS = 600;
const ENTER = { duration: ENTRY.duration, easing: Easing.out(Easing.cubic) };
/** Die Leiste folgt der Karte: Sie läuft erst los, wenn die fast steht. */
const METER_DELAY_MS = 260;

/** Farbe des Punkts je Lage — „unbekannt" bewusst neutral, nie grün. */
function statusColor(status: BoTaskStatus | null, accent: string): string {
  if (status === "ok") return accent;
  if (status === "issue") return C.warn;
  return C.g3;
}

/**
 * Wann der nächste Lauf ist — als die Uhrzeit, die man eingestellt hat.
 *
 * Der Lauf „um 8" startet am Server bis zu zwei Minuten früher (damit nicht alle
 * Aufgaben in derselben Sekunde anfragen). Angezeigt wird trotzdem 8:00; nur ein
 * Lauf der Wache steht mit seiner echten Uhrzeit da.
 */
export function nextRunIso(task: BoTask): string | null {
  if (!task.nextRunAt) return null;
  const at = new Date(task.nextRunAt);
  const [h, m] = task.time.split(":").map(Number);
  const planned = new Date(at);
  planned.setHours(h ?? 0, m ?? 0, 0, 0);
  const ahead = planned.getTime() - at.getTime();
  return ahead >= 0 && ahead <= 125_000 ? planned.toISOString() : task.nextRunAt;
}

/** Die Zeile unten in der Karte: wann zuletzt geprüft, und was dabei herauskam. */
function statusLine(task: BoTask, locale: string, t: T): string {
  if (!task.active) return t("bo.scheduled.paused");
  if (!task.lastRunAt) return t("bo.scheduled.never");
  const when = whenLabel(task.lastRunAt, locale, t);
  if (task.lastStatus === "ok") return `${when} · ${t("bo.scheduled.status.ok")}`;
  if (task.lastStatus === "unknown") return `${when} · ${t("bo.scheduled.status.unknown")}`;
  return `${when} · ${task.lastSummary ?? ""}`;
}

/**
 * Ist die Seite gerade zu sehen? Gewählt UND Bo-Fenster offen — das Fenster
 * bleibt nach dem ersten Bau eingehängt, die Seite nach dem ersten Öffnen auch.
 *
 * Als Haken in zwei winzigen Knoten statt oben in der Seite: Öffnen und
 * Schließen des Fensters rendert dann nur sie neu, nicht die ganze Liste —
 * mitten in die Einfahrt des Fensters gehört kein großer Durchgang.
 */
function useOnScreen(): boolean {
  const open = useSearchStore((s) => s.assistantOpen);
  return useBoView() === "scheduled" && open;
}
function OnScreenStatePanel(props: Omit<ComponentProps<typeof StatePanel>, "active">) {
  return <StatePanel {...props} active={useOnScreen()} />;
}
function OnScreenLoader() {
  return <GridLoader active={useOnScreen()} />;
}

export const ScheduledPage = memo(function ScheduledPage({ bottomInset }: { bottomInset: number }) {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const visible = useBoView() === "scheduled";
  const query = useQuery({
    queryKey: boTasksKeyFor(userId),
    queryFn: fetchBoTasks,
    enabled: userId != null,
    staleTime: 15_000,
  });
  /** Erstes Laden nach der einen Regel (`LoadGate`): Lader erst nach 2 s, dann mindestens zwei Durchläufe, Inhalt weich. */
  const gate = useLoadGate(userId != null && !query.data && !query.isError);

  if (!userId) {
    return (
      <View style={styles.center}>
        <OnScreenStatePanel
          bo="waving"
          title={t("bo.scheduled.loginTitle")}
          body={t("bo.scheduled.login")}
          action={t("bo.scheduled.loginAction")}
          onAction={() => {
            haptic("button");
            useSearchStore.getState().openAuthOverlay();
          }}
        />
      </View>
    );
  }
  if (gate.phase !== "content") {
    return (
      <View style={styles.center}>
        <GateLoader phase={gate.phase} onLeft={gate.onLeft}>
          <OnScreenLoader />
        </GateLoader>
      </View>
    );
  }
  if (!query.data) {
    return (
      <GateFade fresh={gate.fresh} style={styles.center}>
        {query.isError ? (
          // Ehrlich „Nochmal versuchen" — Herunterziehen gibt es hier nicht mehr (weißer Blitz).
          <OnScreenStatePanel
            art="offline"
            surface={palette.bg}
            title={t("state.error.title")}
            body={t("bo.scheduled.errorBody")}
            action={t("state.retry")}
            busy={query.isFetching}
            onAction={() => {
              haptic("button");
              void query.refetch();
            }}
          />
        ) : null}
      </GateFade>
    );
  }
  return (
    <GateFade fresh={gate.fresh} style={styles.fill}>
      <Loaded
        tasks={query.data.tasks}
        limit={query.data.limit}
        visible={visible}
        bottomInset={bottomInset}
      />
    </GateFade>
  );
});

function Loaded({
  tasks,
  limit,
  visible,
  bottomInset,
}: {
  tasks: BoTask[];
  limit: number;
  visible: boolean;
  bottomInset: number;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const active = tasks.filter((x) => x.active).length;
  const full = active >= limit;
  const activeRef = useRef(active);
  activeRef.current = active;

  /** Die Karten ziehen ein, sobald die Seite da ist — dieselbe Welle wie unter „Gespeichert". */
  const intro = useSharedValue(0);
  useEffect(() => {
    if (!visible) return;
    intro.value = 0;
    intro.value = withTiming(1, { duration: INTRO_TOTAL, easing: Easing.linear });
  }, [visible, intro]);

  /** Die Leiste zeigt den Stand mit Abstand — erst die Karte, dann der Platz. */
  const [shown, setShown] = useState(active);
  useEffect(() => {
    if (active === shown) return;
    const id = setTimeout(() => setShown(active), METER_DELAY_MS);
    return () => clearTimeout(id);
  }, [active, shown]);

  const glow = useSharedValue(0);
  const flash = useCallback(() => {
    glow.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 420 }));
  }, [glow]);
  /** Der letzte Platz: einmal kurz aufleuchten, mehr nicht. */
  const wasFull = useRef(shown >= limit);
  useEffect(() => {
    const now = shown >= limit;
    if (now && !wasFull.current) flash();
    wasFull.current = now;
  }, [shown, limit, flash]);

  /** Alle Plätze belegt: Die Leiste leuchtet auf, ein Dialog sagt, was zu tun ist. */
  const nudge = useCallback(() => {
    haptic("important");
    flash();
    showAlert(t("bo.task.fullTitle").replace("{max}", String(limit)), t("bo.task.fullBody"));
  }, [flash, limit, t]);

  /** Ein Schalter, der sofort umspringt und bei einem Fehler zurückfällt. */
  const toggle = useCallback(
    async (task: BoTask, next: boolean) => {
      if (next && activeRef.current >= limit) {
        nudge();
        return;
      }
      haptic("button");
      const key = boTasksKeyFor(userId);
      const prev = queryClient.getQueryData<{ tasks: BoTask[]; limit: number }>(key);
      if (prev) {
        queryClient.setQueryData(key, { ...prev, tasks: prev.tasks.map((x) => (x.id === task.id ? { ...x, active: next } : x)) });
      }
      try {
        await updateBoTask(task.id, { active: next });
      } catch (e) {
        if (prev) queryClient.setQueryData(key, prev);
        if (isTaskLimitError(e)) nudge();
        else showAlert(t("bo.task.toggleFailedTitle"), t("bo.task.toggleFailedBody"));
      }
      void queryClient.invalidateQueries({ queryKey: key });
    },
    [limit, nudge, queryClient, t, userId],
  );

  /** Das Blatt ist unten: Die Zeile geht, die anderen rücken nach (`ROW_SLIDE`). */
  useEffect(
    () =>
      onTaskRemoved((id) => {
        const key = boTasksKeyFor(userId);
        queryClient.setQueryData<{ tasks: BoTask[]; limit: number }>(key, (prev) =>
          prev ? { ...prev, tasks: prev.tasks.filter((x) => x.id !== id) } : prev,
        );
        setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), RESYNC_AFTER_MS);
      }),
    [queryClient, userId],
  );

  /** Was schon einmal da war, zieht nicht noch einmal ein. */
  const seen = useRef(new Set(tasks.map((x) => x.id)));
  const scrollRef = useRef<ScrollView>(null);
  const count = useRef(tasks.length);
  useEffect(() => {
    for (const x of tasks) seen.current.add(x.id);
    if (tasks.length > count.current) scrollRef.current?.scrollToEnd({ animated: true });
    count.current = tasks.length;
  }, [tasks]);

  const openNew = useCallback(() => {
    if (activeRef.current >= limit) {
      nudge();
      return;
    }
    haptic("button");
    openTaskSheet({ kind: "new" });
  }, [limit, nudge]);

  return (
    <>
      <View style={styles.head}>
        {/* Die Erklärung braucht man am Anfang, danach steht sie nur im Weg. */}
        {tasks.length === 0 ? <Text style={styles.subtitle}>{t("bo.scheduled.subtitle")}</Text> : null}
        <TaskMeter count={shown} limit={limit} glow={glow} />
        <NotifyBanner visible={visible} />
      </View>

      {tasks.length === 0 ? (
        <EmptyTemplates t={t} />
      ) : (
        <ScrollView
          ref={scrollRef}
          style={styles.fill}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          overScrollMode="never"
        >
          {tasks.map((task, i) => (
            <Animated.View key={task.id} layout={ROW_SLIDE} exiting={ROW_OUT}>
              <IntroRow index={i} intro={intro}>
                <TaskRow task={task} isNew={!seen.current.has(task.id)} onToggle={toggle} t={t} />
              </IntroRow>
            </Animated.View>
          ))}
        </ScrollView>
      )}

      <View style={[styles.footer, { paddingBottom: bottomInset }]}>
        <NewTaskButton full={shown >= limit && full} limit={limit} onPress={openNew} />
      </View>
    </>
  );
}

/** Die fünf Plätze: Zahl, freie Plätze, Leiste. */
const TaskMeter = memo(function TaskMeter({
  count,
  limit,
  glow,
}: {
  count: number;
  limit: number;
  glow: SharedValue<number>;
}) {
  const t = useT();
  const accent = useAccent();
  const digitY = useSharedValue(-count * DIGIT_H);
  const freeY = useSharedValue(-count * FREE_H);
  useEffect(() => {
    digitY.value = withTiming(-count * DIGIT_H, ROLL);
    freeY.value = withTiming(-count * FREE_H, ROLL);
  }, [count, digitY, freeY]);
  const digitStyle = useAnimatedStyle(() => ({ transform: [{ translateY: digitY.value }] }));
  const freeStyle = useAnimatedStyle(() => ({ transform: [{ translateY: freeY.value }] }));

  const slots = Array.from({ length: limit + 1 }, (_, i) => i);
  const freeLabel = (used: number) => {
    const free = limit - used;
    if (free === 0) return t("bo.scheduled.free.none");
    if (free === 1) return t("bo.scheduled.free.one");
    return t("bo.scheduled.free.many").replace("{n}", String(free));
  };

  return (
    <View
      style={styles.meter}
      accessible
      accessibilityLabel={`${t("bo.scheduled.count").replace("{n}", String(count)).replace("{max}", String(limit))}, ${freeLabel(count)}`}
    >
      <View style={styles.meterRow}>
        <View style={styles.meterCount}>
          <View style={digitBox}>
            <Animated.View style={digitStyle}>
              {slots.map((n) => (
                <Text key={n} style={[styles.meterText, digitRow]}>
                  {n}
                </Text>
              ))}
            </Animated.View>
          </View>
          <Text style={[styles.meterText, digitRow]}>{t("bo.scheduled.of").replace("{max}", String(limit))}</Text>
        </View>
        <View style={freeBox}>
          <Animated.View style={freeStyle}>
            {slots.map((n) => (
              <Text key={n} style={[styles.meterFree, freeRow]} numberOfLines={1}>
                {freeLabel(n)}
              </Text>
            ))}
          </Animated.View>
        </View>
      </View>
      <View style={styles.segments}>
        {Array.from({ length: limit }, (_, i) => (
          <MeterSegment key={i} on={i < count} glow={glow} color={accent.solid} />
        ))}
      </View>
    </View>
  );
});

const digitRow = { height: DIGIT_H, lineHeight: DIGIT_H } as const;
const freeRow = { height: FREE_H, lineHeight: FREE_H } as const;
const digitBox = { height: DIGIT_H, overflow: "hidden" } as const;
const freeBox = { height: FREE_H, overflow: "hidden", flexShrink: 1 } as const;

function MeterSegment({ on, glow, color }: { on: boolean; glow: SharedValue<number>; color: string }) {
  const fill = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    fill.value = withTiming(on ? 1 : 0, FILL);
  }, [on, fill]);
  const fillStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: fill.value }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value * fill.value * 0.45 }));
  return (
    <View style={styles.segment}>
      <Animated.View style={[styles.segmentFill, { backgroundColor: color }, fillStyle]} />
      <Animated.View style={[styles.segmentFill, styles.segmentGlow, glowStyle]} />
    </View>
  );
}

/** Mitteilungen aus? Dann kann Bo sich nicht melden, und das gehört hierher. */
function NotifyBanner({ visible }: { visible: boolean }) {
  const t = useT();
  const palette = usePalette();
  const enabled = useSearchStore((s) => s.notificationsEnabled && s.boUpdatesEnabled);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    Notifications.getPermissionsAsync()
      .then((p) => {
        if (alive) setDenied(p.status !== "granted");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [visible]);

  if (enabled && !denied) return null;

  const enable = async () => {
    haptic("button");
    const st = useSearchStore.getState();
    st.setNotificationsEnabled(true);
    st.setBoUpdatesEnabled(true);
    const res = await ensurePushToken();
    if (res.ok) {
      setDenied(false);
      showStatusToast("notifyOn");
    }
    else if (res.reason === "denied") void Linking.openSettings();
  };

  return (
    <View style={[styles.banner, { backgroundColor: palette.s2 }]}>
      <BellOff size={18} color={C.warn} strokeWidth={2} />
      <Text style={styles.bannerText}>{t("bo.scheduled.notifyOff")}</Text>
      <RippleTouch onPress={() => void enable()} accessibilityRole="button" style={[styles.bannerBtn, { backgroundColor: palette.s3 }]}>
        <Text style={styles.bannerBtnText}>{t("bo.scheduled.notifyOn")}</Text>
      </RippleTouch>
    </View>
  );
}

function EmptyTemplates({ t }: { t: T }) {
  const palette = usePalette();
  const home = useSearchStore((s) => s.homeStation);
  const work = useSearchStore((s) => s.workStation);
  const place = (loc: typeof home): TaskPlace | null => (loc ? { code: loc.code, label: loc.label } : null);
  const templates: { title: string; sub: string; draft: TaskDraft }[] = [
    {
      title: t("bo.scheduled.template.morningTitle"),
      sub: t("bo.scheduled.template.morningSub"),
      draft: { title: t("bo.task.auto.morning"), origin: place(home), destination: place(work), days: 31, time: "08:00", notify: "always" },
    },
    {
      title: t("bo.scheduled.template.eveningTitle"),
      sub: t("bo.scheduled.template.eveningSub"),
      draft: {
        title: t("bo.task.auto.evening"),
        origin: place(work),
        destination: place(home),
        days: 31,
        time: "16:30",
        watchUntil: "18:30",
        notify: "issues",
      },
    },
    {
      title: t("bo.scheduled.template.sundayTitle"),
      sub: t("bo.scheduled.template.sundaySub"),
      draft: { title: t("bo.task.auto.sunday"), origin: place(home), destination: place(work), days: 64, time: "19:00", notify: "always" },
    },
  ];
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{t("bo.scheduled.emptyTitle")}</Text>
      <Text style={styles.emptyText}>{t("bo.scheduled.emptyText")}</Text>
      {templates.map((x) => (
        <RippleTouch
          key={x.title}
          onPress={() => {
            haptic("button");
            openTaskSheet({ kind: "new", draft: x.draft });
          }}
          accessibilityRole="button"
          style={[styles.template, { backgroundColor: palette.s2 }]}
        >
          <Text style={styles.templateTitle}>{x.title}</Text>
          <Text style={styles.templateSub}>{x.sub}</Text>
        </RippleTouch>
      ))}
    </View>
  );
}

/** Eine Zeile der Liste: Sie zieht ein, wenn sie neu ist. */
function TaskRow({
  task,
  isNew,
  onToggle,
  t,
}: {
  task: BoTask;
  isNew: boolean;
  onToggle: (task: BoTask, next: boolean) => void;
  t: T;
}) {
  const enter = useSharedValue(isNew ? 0 : 1);
  useEffect(() => {
    if (isNew) enter.value = withTiming(1, ENTER);
    // Nur beim Einhängen — danach zählt die Zeile nicht mehr als neu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rowStyle = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * ENTRY.rise }],
  }));
  return (
    <Animated.View style={[styles.row, rowStyle]}>
      <TaskCard task={task} onToggle={onToggle} t={t} />
    </Animated.View>
  );
}

function TaskCard({ task, onToggle, t }: { task: BoTask; onToggle: (task: BoTask, next: boolean) => void; t: T }) {
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const dim = useSharedValue(task.active ? 1 : 0.5);
  useEffect(() => {
    dim.value = withTiming(task.active ? 1 : 0.5, CROSS);
  }, [task.active, dim]);
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const next = task.active ? nextRunIso(task) : null;
  return (
    <RippleTouch
      onPress={() => {
        haptic("button");
        openTaskSheet({ kind: "detail", taskId: task.id });
      }}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      rippleColor="rgba(255,255,255,0.08)"
      style={[styles.card, { backgroundColor: palette.s2 }]}
    >
      <View style={styles.cardTop}>
        <Animated.View style={[styles.cardText, dimStyle]}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {task.title}
          </Text>
          <Text style={styles.cardRoute} numberOfLines={1}>
            {task.originLabel} → {task.destLabel}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {scheduleLabel(task, t)} · {notifyLabel(task, t)}
          </Text>
        </Animated.View>
        <BinchSwitch
          value={task.active}
          onValueChange={(v) => onToggle(task, v)}
          accessibilityLabel={`${task.title} ${t("bo.task.active")}`}
        />
      </View>
      <View style={[styles.cardStatus, { borderTopColor: palette.s3 }]}>
        <View style={[styles.dot, { backgroundColor: task.active ? statusColor(task.lastStatus, accent.solid) : C.g3 }]} />
        <Text style={[styles.statusText, !task.active && styles.statusMuted]} numberOfLines={1}>
          {statusLine(task, locale, t)}
        </Text>
        {next ? (
          <Text style={styles.next} numberOfLines={1}>
            {whenLabel(next, locale, t)}
          </Text>
        ) : null}
      </View>
    </RippleTouch>
  );
}

/** Der Knopf unten: dieselbe Stelle, zwei Aussagen. Die Beschriftung rollt, die Fläche blendet. */
function NewTaskButton({ full, limit, onPress }: { full: boolean; limit: number; onPress: () => void }) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const state = useSharedValue(full ? 1 : 0);
  useEffect(() => {
    state.value = withTiming(full ? 1 : 0, ROLL);
  }, [full, state]);
  const fillStyle = useAnimatedStyle(() => ({ opacity: 1 - state.value }));
  const labelStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -state.value * CTA_H }] }));
  return (
    <RippleTouch
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={full ? t("bo.scheduled.full").replace("{max}", String(limit)) : t("bo.scheduled.new")}
      rippleColor={full ? undefined : "rgba(0,0,0,0.32)"}
      style={[styles.cta, { backgroundColor: palette.s3 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: accent.solid }, fillStyle]} />
      <Animated.View style={labelStyle}>
        <View style={styles.ctaRow}>
          <Plus size={18} color={accent.textOnSolid} strokeWidth={2.4} />
          <Text style={[styles.ctaText, { color: accent.textOnSolid }]}>{t("bo.scheduled.new")}</Text>
        </View>
        <View style={styles.ctaRow}>
          <Text style={[styles.ctaText, styles.ctaTextFull]}>{t("bo.scheduled.full").replace("{max}", String(limit))}</Text>
        </View>
      </Animated.View>
    </RippleTouch>
  );
}

const styles = scaledStyles({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: GUTTER, gap: SPACE.lg },
  centerText: { fontSize: 14, lineHeight: 20, color: C.g2, textAlign: "center" },
  retry: { padding: SPACE.md, borderRadius: 16, overflow: "hidden" },
  loginBtn: { height: 50, paddingHorizontal: SPACE.xxxl, borderRadius: 16, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  loginText: { fontSize: 16, fontWeight: "700" },

  head: { paddingHorizontal: GUTTER },
  subtitle: { fontSize: 14, lineHeight: 20, color: C.g2, marginBottom: GROUP_GAP },

  meter: {},
  meterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: SPACE.md },
  meterCount: { flexDirection: "row", alignItems: "center", gap: 4 },
  meterText: { fontSize: 15, fontWeight: "600", color: C.white, fontVariant: ["tabular-nums"], includeFontPadding: false },
  meterFree: { fontSize: 13, color: C.g2, textAlign: "right", includeFontPadding: false },
  segments: { flexDirection: "row", gap: SPACE.xs, marginTop: 8 },
  segment: { flex: 1, height: 6, borderRadius: 3, backgroundColor: C.raised, overflow: "hidden" },
  segmentFill: { ...StyleSheet.absoluteFillObject, borderRadius: 3, transformOrigin: "left center" },
  segmentGlow: { backgroundColor: "#FFFFFF" },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: SPACE.md,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 8,
    borderRadius: 16,
  },
  bannerText: { flex: 1, minWidth: 0, fontSize: 13, lineHeight: 18, color: C.sub },
  bannerBtn: { height: 36, paddingHorizontal: SPACE.md, borderRadius: 12, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  bannerBtnText: { fontSize: 13, fontWeight: "600", color: C.white },

  empty: { flex: 1, paddingHorizontal: GUTTER, paddingTop: GROUP_GAP },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: C.white, letterSpacing: -0.2 },
  emptyText: { fontSize: 14, lineHeight: 20, color: C.g2, marginTop: SPACE.xs, marginBottom: TITLE_GAP },
  template: { borderRadius: 18, paddingHorizontal: SPACE.lg, paddingVertical: 16, marginBottom: ITEM_GAP, overflow: "hidden" },
  templateTitle: { fontSize: 15, fontWeight: "600", color: C.white },
  templateSub: { fontSize: 13, lineHeight: 18, color: C.g2, marginTop: 4 },

  list: { paddingHorizontal: GUTTER, paddingTop: GROUP_GAP, paddingBottom: SPACE.xs },
  row: { paddingBottom: ITEM_GAP, overflow: "hidden" },
  card: { borderRadius: 20, paddingHorizontal: SPACE.lg, paddingTop: 16, paddingBottom: SPACE.md, overflow: "hidden" },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.md },
  cardText: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 15.5, fontWeight: "600", color: C.white },
  cardRoute: { fontSize: 13.5, color: C.sub, marginTop: 4 },
  cardMeta: { fontSize: 13, color: C.g2, marginTop: 4 },
  cardStatus: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, marginTop: 8, paddingTop: 8, borderTopWidth: 1 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { flex: 1, minWidth: 0, fontSize: 12.5, color: C.sub },
  statusMuted: { color: C.g2 },
  next: { fontSize: 12.5, color: C.g2 },

  footer: { paddingHorizontal: GUTTER, paddingTop: SPACE.sm },
  cta: { height: FIELD_H, borderRadius: 16, overflow: "hidden" },
  ctaRow: { height: FIELD_H, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.sm },
  ctaText: { fontSize: 16, fontWeight: "700" },
  ctaTextFull: { color: C.g2 },
});
