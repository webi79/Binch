/**
 * Bos VORSCHLAG einer geplanten Aufgabe — die Karte unter seiner Antwort
 * (Ereignis `task_proposal`, server/src/services/chatAgent.ts).
 *
 * Angelegt wird erst mit „Anlegen": Bo darf nichts im Namen des Nutzers
 * einrichten, was ihm später Mitteilungen schickt. Wie oft gemeldet wird
 * („Immer" / „Nur bei Störung"), lässt sich hier noch umstellen; alles andere
 * sagt man Bo im Chat — er schlägt dann eine neue Karte vor.
 *
 * Schon angelegt? Beim erneuten Öffnen des Chats steht die Karte wieder da;
 * gibt es die Aufgabe (gleiche Strecke, Tage, Uhrzeit) schon, zeigt sie
 * „Angelegt" statt des Knopfs.
 */
import { memo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clock } from "lucide-react-native";
import {
  boTasksKeyFor,
  createBoTask,
  fetchBoTasks,
  isTaskLimitError,
  type BoTaskNotify,
  type TaskProposal,
} from "@/lib/api/chats";
import { scheduleLabel, deviceTimezone } from "@/lib/assistant/taskFormat";
import { ensurePushToken } from "@/lib/notifications/push";
import { useSearchStore } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { ChoiceSegment } from "@/components/settings/SettingsBlocks";
import { scaledStyles } from "@/lib/ui/compact";
import { SPACE } from "@/lib/theme/spacing";

const C = {
  white: "#F4F4F5",
  sub: "#C8C8CC",
  g2: "#8E8E93",
  error: "#FF7A6B",
};

type Phase = "idle" | "busy" | "created" | "failed" | "limit";

export const TaskProposalCard = memo(function TaskProposalCard({
  proposal,
  conversationId,
}: {
  proposal: TaskProposal;
  conversationId: string | null;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();
  const locale = useSearchStore((s) => s.locale);
  const userId = useSearchStore((s) => s.authUser?.id ?? null);
  const queryClient = useQueryClient();
  const [notify, setNotify] = useState<BoTaskNotify>(proposal.notify);
  const [phase, setPhase] = useState<Phase>("idle");

  const tasks = useQuery({
    queryKey: boTasksKeyFor(userId),
    queryFn: fetchBoTasks,
    enabled: userId != null,
    staleTime: 30_000,
  });
  const existing = tasks.data?.tasks.some(
    (x) =>
      x.origin === proposal.origin &&
      x.destination === proposal.destination &&
      x.days === proposal.days &&
      x.time === proposal.time,
  );
  const created = phase === "created" || existing === true;

  const create = async () => {
    if (phase === "busy" || created) return;
    haptic("button");
    setPhase("busy");
    try {
      // Erlaubnis + Kanal VOR der ersten Meldung — sonst käme sie stumm an.
      await ensurePushToken();
      await createBoTask({ ...proposal, notify }, { timezone: deviceTimezone(), locale, conversationId });
      setPhase("created");
      haptic("important");
      void queryClient.invalidateQueries({ queryKey: ["boTasks"] });
    } catch (e) {
      setPhase(isTaskLimitError(e) ? "limit" : "failed");
    }
  };

  const rows: [string, string][] = [
    [t("bo.task.route"), `${proposal.originLabel} → ${proposal.destLabel}`],
    [t("bo.task.when"), scheduleLabel(proposal, t)],
    [t("bo.task.checksLabel"), t("bo.task.checks")],
  ];

  return (
    <View style={[styles.card, { backgroundColor: palette.s2, borderColor: palette.s3 }]}>
      <View style={styles.head}>
        <View style={[styles.iconTile, { backgroundColor: palette.s3 }]}>
          <Clock size={20} color={accent.solid} strokeWidth={2} />
        </View>
        <View style={styles.headText}>
          <Text style={styles.label}>{t("bo.task.newLabel")}</Text>
          <Text style={styles.title} numberOfLines={1}>
            {proposal.title}
          </Text>
        </View>
      </View>

      <View style={styles.rows}>
        {rows.map(([k, v]) => (
          <View key={k} style={styles.row}>
            <Text style={styles.rowKey}>{k}</Text>
            <Text style={styles.rowValue}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.notify, created && styles.dimmed]} pointerEvents={created ? "none" : "auto"}>
        <Text style={styles.rowKey}>{t("bo.task.notifyLabel")}</Text>
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

      <Text style={styles.truth}>{t("bo.task.truth")}</Text>

      {created ? (
        <View style={styles.createdRow} accessibilityRole="text">
          <Check size={18} color={accent.solid} strokeWidth={2.4} />
          <Text style={styles.createdText}>
            {t("bo.task.created")} · {scheduleLabel(proposal, t)}
          </Text>
        </View>
      ) : (
        <>
          <RippleTouch
            onPress={() => void create()}
            disabled={phase === "busy"}
            accessibilityRole="button"
            accessibilityLabel={t("bo.task.create")}
            style={[styles.primary, { backgroundColor: accent.solid }]}
          >
            {phase === "busy" ? (
              <ActivityIndicator size="small" color={accent.textOnSolid} />
            ) : (
              <Text style={[styles.primaryText, { color: accent.textOnSolid }]}>{t("bo.task.create")}</Text>
            )}
          </RippleTouch>
          {phase === "failed" || phase === "limit" ? (
            <Text style={styles.error}>{t(phase === "limit" ? "bo.task.limit" : "bo.task.failed")}</Text>
          ) : (
            <Text style={styles.hint}>{t("bo.task.changeHint")}</Text>
          )}
        </>
      )}
    </View>
  );
});

const styles = scaledStyles({
  card: { borderWidth: 1, borderRadius: 20, padding: SPACE.lg, gap: 16, marginTop: 4 },
  head: { flexDirection: "row", alignItems: "center", gap: SPACE.md },
  iconTile: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  headText: { flex: 1, minWidth: 0 },
  label: { fontSize: 11.5, fontWeight: "600", color: C.g2, letterSpacing: 0.6 },
  title: { fontSize: 17, fontWeight: "700", color: C.white, letterSpacing: -0.2, marginTop: 4 },
  rows: { gap: 8 },
  row: { flexDirection: "row", gap: SPACE.md },
  rowKey: { width: 76, fontSize: 14, color: C.g2 },
  rowValue: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 19, color: C.white },
  notify: { gap: SPACE.sm },
  dimmed: { opacity: 0.5 },
  truth: { fontSize: 12.5, lineHeight: 18, color: C.g2 },
  primary: { height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  primaryText: { fontSize: 15, fontWeight: "700" },
  hint: { fontSize: 12.5, color: C.g2, textAlign: "center", marginTop: -4 },
  error: { fontSize: 12.5, lineHeight: 18, color: C.error, textAlign: "center", marginTop: -4 },
  createdRow: { flexDirection: "row", alignItems: "center", gap: SPACE.sm, minHeight: 46 },
  createdText: { fontSize: 15, fontWeight: "600", color: C.white },
});
