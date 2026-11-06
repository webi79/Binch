/**
 * PENDELN mit einem Tipp — „Zur Arbeit" und „Nach Hause".
 *
 * Steht auf dem Startbildschirm, sobald Zuhause UND Arbeit festgelegt sind
 * (Profil → Einstellungen → Reisen). Ein Tipp sucht die Strecke ab JETZT, mit
 * den Reisenden und der Klasse aus den Einstellungen — derselbe Weg wie eine
 * Karte aus „Zuletzt gesucht" (lib/search/launchResults.ts).
 *
 * Zug, außer beide Orte sind Bushalte: Pendeln heißt hier fast immer Bahn,
 * und die Zugsuche nimmt Bus und Tram für die letzte Meile ohnehin mit.
 */
import { memo } from "react";
import { View, Text } from "react-native";
import { format } from "date-fns";
import { ArrowRight, Briefcase, House, type LucideIcon } from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { launchResults } from "@/lib/search/launchResults";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { scaledStyles } from "@/lib/ui/compact";
import { GUTTER, ITEM_GAP, GROUP_GAP } from "@/lib/theme/spacing";
import type { Location } from "@/types/search";

const WHITE = "#F4F4F5";
const G2 = "#8E8E93";

function commuteParams(from: Location, to: Location): Record<string, string> {
  const st = useSearchStore.getState();
  const mode = from.type === "BUS" && to.type === "BUS" ? "BUS" : "TRAIN";
  const now = new Date();
  return {
    mode,
    origin: from.code,
    destination: to.code,
    originLabel: from.label,
    destLabel: to.label,
    departDate: format(now, "yyyy-MM-dd"),
    departTime: now.toISOString(),
    tripType: "oneway",
    passengers: String(st.defaultPassengers),
    currency: st.currency,
    ...(mode === "TRAIN" ? { travelClass: st.defaultTrainClass } : {}),
  };
}

export const CommuteRow = memo(function CommuteRow() {
  const t = useT();
  const home = useSearchStore((s) => s.homeStation);
  const work = useSearchStore((s) => s.workStation);
  if (!home || !work || home.code === work.code) return null;
  return (
    <View style={styles.row}>
      <CommuteCard Icon={Briefcase} title={t("home.commute.toWork")} to={work} from={home} />
      <CommuteCard Icon={House} title={t("home.commute.toHome")} to={home} from={work} />
    </View>
  );
});

function CommuteCard({ Icon, title, from, to }: { Icon: LucideIcon; title: string; from: Location; to: Location }) {
  const palette = usePalette();
  return (
    <RippleTouch
      onPress={() => {
        haptic("button");
        launchResults(commuteParams(from, to));
      }}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${from.label} – ${to.label}`}
      style={[styles.card, { backgroundColor: palette.s2 }]}
    >
      <View style={[styles.icon, { backgroundColor: palette.s3 }]}>
        <Icon size={18} color={WHITE} strokeWidth={2} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.routeRow}>
          <Text style={styles.route} numberOfLines={1}>
            {to.label}
          </Text>
        </View>
      </View>
      <ArrowRight size={14} color={G2} strokeWidth={2.2} />
    </RippleTouch>
  );
}

const styles = scaledStyles({
  row: { flexDirection: "row", gap: ITEM_GAP, paddingHorizontal: GUTTER, paddingTop: GROUP_GAP },
  card: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 12,
    overflow: "hidden",
  },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: "700", color: WHITE, letterSpacing: -0.2 },
  routeRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  route: { flexShrink: 1, fontSize: 12, color: G2 },
});
