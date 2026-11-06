/**
 * Bos START — unter seiner Begrüßung, solange der Chat frisch ist (Entwurf
 * „Bo-Tab · Start"): eine Karte für heute und vier Vorschläge, die zeigen, was
 * Bo kann. Verschwindet mit der ersten eigenen Nachricht.
 *
 * „Heute": die letzte Lage aus einer geplanten Aufgabe (Bo hat sie ohnehin
 * schon geprüft — kostet nichts), sonst die nächste gespeicherte Reise der
 * kommenden sieben Tage. Gibt es beides nicht, gibt es keine Karte.
 *
 * Keine Daueranimation: Der Bereich steht in Bos Liste, und über Bos Ausfahrt
 * liegt eine GPU-Textur, die jede laufende Animation darunter in jedem Bild
 * ungültig machen würde (siehe die Tipp-Punkte im Bildschirm). Die einzige
 * Bewegung ist das kurze Gehen vor der ersten Nachricht (`leaveStartPanel`).
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { de, enUS, es, fr } from "date-fns/locale";
import { Clock, Compass, MapPin, Search, Train, type LucideIcon } from "lucide-react-native";
import { boTasksKeyFor, fetchBoTasks, type BoTask } from "@/lib/api/chats";
import { whenLabel } from "@/lib/assistant/taskFormat";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { scaledStyles } from "@/lib/ui/compact";
import { SPACE, ITEM_GAP, TITLE_GAP, GROUP_GAP } from "@/lib/theme/spacing";

const C = {
  white: "#F4F4F5",
  sub: "#C8C8CC",
  g2: "#8E8E93",
  g3: "#56565C",
  warn: "#F5A142",
};
const DATE_LOCALES = { de, en: enUS, fr, es } as const;
const WEEK_MS = 7 * 86_400_000;

/** So lange blendet der Bereich aus, bevor die erste Nachricht einzieht. */
export const START_LEAVE_MS = 130;

const leaveListeners = new Set<() => void>();

/**
 * Den Bereich ausblenden. `false`: Es steht gerade keiner da, niemand muss warten.
 * Ein Verteiler, weil der Bereich in einer Listen-Blase steckt (dieselbe
 * Begründung wie bei den Tipp-Punkten im Bildschirm).
 */
export function leaveStartPanel(): boolean {
  for (const fn of leaveListeners) fn();
  return leaveListeners.size > 0;
}

export type StartAction =
  | { kind: "send"; text: string }
  | { kind: "prefill"; text: string }
  | { kind: "openTask"; taskId: string };

/**
 * Die Aufgaben erst holen, wenn keine Fahrt läuft: Bos Bildschirm wird vor dem
 * Öffnen gebaut, und eine Antwort, die mitten in seiner Einfahrt ankommt, wäre
 * ein Durchgang in der Bewegung.
 */
function useQuietReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tryReady = () => {
      if (isTransitionBusy()) {
        timer = setTimeout(tryReady, 400);
        return;
      }
      setReady(true);
    };
    timer = setTimeout(tryReady, 900);
    return () => clearTimeout(timer);
  }, []);
  return ready;
}

export const BoStartPanel = memo(function BoStartPanel({ onAction }: { onAction: (a: StartAction) => void }) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const home = useSearchStore((s) => s.homeStation);
  const trips = useSearchStore((s) => s.savedTrips);
  const tickets = useSearchStore((s) => s.tickets);
  const ready = useQuietReady();

  const leave = useSharedValue(1);
  useEffect(() => {
    const fn = () => {
      leave.value = withTiming(0, { duration: START_LEAVE_MS, easing: Easing.out(Easing.quad) });
    };
    leaveListeners.add(fn);
    return () => {
      leaveListeners.delete(fn);
    };
  }, [leave]);
  const leaveStyle = useAnimatedStyle(() => ({
    opacity: leave.value,
    transform: [{ translateY: (1 - leave.value) * 6 }],
  }));

  const tasks = useQuery({
    queryKey: boTasksKeyFor(userId),
    queryFn: fetchBoTasks,
    enabled: userId != null && ready,
    staleTime: 60_000,
  });

  /** Eine geplante Aufgabe, die heute schon gelaufen ist — ihre Lage ist „heute". */
  const todayTask = useMemo((): BoTask | null => {
    const today = new Date().toDateString();
    return (
      tasks.data?.tasks.find(
        (x) => x.active && x.lastRunAt && x.lastSummary && new Date(x.lastRunAt).toDateString() === today,
      ) ?? null
    );
  }, [tasks.data]);

  /** Sonst die nächste gespeicherte Reise der kommenden Woche. */
  const nextTrip = useMemo(() => {
    const now = Date.now();
    const all = [
      ...trips.map((x) => ({ at: Date.parse(x.departTime), origin: x.originLabel, dest: x.destLabel })),
      ...tickets.map((x) => ({
        at: x.departTime ? Date.parse(x.departTime) : NaN,
        origin: x.fromStation ?? x.fromCity ?? x.fromCode ?? "",
        dest: x.toCity ?? x.toCode ?? "",
      })),
    ].filter((x) => Number.isFinite(x.at) && x.at >= now && x.at - now <= WEEK_MS && x.origin && x.dest);
    all.sort((a, b) => a.at - b.at);
    return all[0] ?? null;
  }, [trips, tickets]);

  const dateLocale = DATE_LOCALES[locale as keyof typeof DATE_LOCALES] ?? enUS;
  const press = (a: StartAction) => {
    haptic("button");
    onAction(a);
  };

  const suggestions: { Icon: LucideIcon; tint?: string; title: string; sub: string; action: StartAction }[] = [
    {
      Icon: Search,
      title: t("assistant.start.find"),
      sub: t("assistant.start.findSub"),
      action: { kind: "prefill", text: t("assistant.start.findPrefill") },
    },
    home
      ? {
          Icon: MapPin,
          title: t("assistant.start.departures"),
          sub: t("assistant.start.departuresSub").replace("{stop}", home.label),
          action: { kind: "send", text: t("assistant.start.departuresPrompt").replace("{stop}", home.label) },
        }
      : {
          Icon: MapPin,
          title: t("assistant.start.departures"),
          sub: t("assistant.start.departuresAny"),
          action: { kind: "prefill", text: t("assistant.start.departuresPrefill") },
        },
    {
      Icon: Clock,
      tint: accent.solid,
      title: t("assistant.start.plan"),
      sub: t("assistant.start.planSub"),
      action: { kind: "send", text: t("assistant.start.planPrompt") },
    },
    {
      Icon: Compass,
      title: t("assistant.start.ideas"),
      sub: t("assistant.start.ideasSub"),
      action: { kind: "send", text: t("assistant.start.ideasPrompt") },
    },
  ];

  return (
    <Animated.View style={[styles.wrap, leaveStyle]}>
      {todayTask ? (
        <RippleTouch
          onPress={() => press({ kind: "openTask", taskId: todayTask.id })}
          accessibilityRole="button"
          style={[styles.today, { backgroundColor: palette.s2 }]}
        >
          <View style={[styles.todayIcon, { backgroundColor: palette.s3 }]}>
            <Clock size={20} color={C.white} strokeWidth={2} />
          </View>
          <View style={styles.todayText}>
            <Text style={styles.todayLabel} numberOfLines={1}>
              {todayTask.title} · {whenLabel(todayTask.lastRunAt!, locale, t)}
            </Text>
            <Text style={styles.todayValue} numberOfLines={2}>
              {todayTask.lastSummary}
            </Text>
          </View>
          <View
            style={[
              styles.dot,
              {
                backgroundColor:
                  todayTask.lastStatus === "ok" ? accent.solid : todayTask.lastStatus === "issue" ? C.warn : C.g3,
              },
            ]}
          />
        </RippleTouch>
      ) : nextTrip ? (
        <RippleTouch
          onPress={() =>
            press({
              kind: "send",
              text: t("assistant.start.tripPrompt")
                .replace("{origin}", nextTrip.origin)
                .replace("{dest}", nextTrip.dest)
                .replace("{date}", format(new Date(nextTrip.at), "EEEE d. MMMM", { locale: dateLocale })),
            })
          }
          accessibilityRole="button"
          style={[styles.today, { backgroundColor: palette.s2 }]}
        >
          <View style={[styles.todayIcon, { backgroundColor: palette.s3 }]}>
            <Train size={20} color={C.white} strokeWidth={2} />
          </View>
          <View style={styles.todayText}>
            <Text style={styles.todayLabel} numberOfLines={1}>
              {t("assistant.start.nextTrip")} · {format(new Date(nextTrip.at), "EEE d. MMM, H:mm", { locale: dateLocale })}
            </Text>
            <Text style={styles.todayValue} numberOfLines={1}>
              {nextTrip.origin} → {nextTrip.dest}
            </Text>
          </View>
        </RippleTouch>
      ) : null}

      <Text style={styles.section}>{t("assistant.start.suggestions")}</Text>
      <View style={styles.grid}>
        {suggestions.map((s) => (
          <RippleTouch
            key={s.title}
            onPress={() => press(s.action)}
            accessibilityRole="button"
            accessibilityLabel={`${s.title}: ${s.sub}`}
            style={[styles.card, { backgroundColor: palette.s2 }]}
          >
            <s.Icon size={20} color={s.tint ?? C.sub} strokeWidth={2} />
            <View style={styles.cardText}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {s.title}
              </Text>
              <Text style={styles.cardSub} numberOfLines={2}>
                {s.sub}
              </Text>
            </View>
          </RippleTouch>
        ))}
      </View>
    </Animated.View>
  );
});

const styles = scaledStyles({
  wrap: { alignSelf: "stretch", marginTop: SPACE.xs },
  today: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    borderRadius: 20,
    paddingHorizontal: SPACE.lg,
    paddingVertical: 16,
    overflow: "hidden",
  },
  todayIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  todayText: { flex: 1, minWidth: 0 },
  todayLabel: { fontSize: 12.5, color: C.g2 },
  todayValue: { fontSize: 15, lineHeight: 20, fontWeight: "600", color: C.white, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  section: { fontSize: 13, fontWeight: "600", color: C.g2, letterSpacing: 0.2, marginTop: GROUP_GAP, marginBottom: TITLE_GAP, paddingHorizontal: SPACE.xs },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: ITEM_GAP },
  card: {
    flexGrow: 1,
    flexBasis: "45%",
    borderRadius: 18,
    padding: 16,
    gap: 8,
    overflow: "hidden",
  },
  cardText: { gap: 4 },
  cardTitle: { fontSize: 14, fontWeight: "600", color: C.white },
  cardSub: { fontSize: 12.5, lineHeight: 17, color: C.g2 },
});
