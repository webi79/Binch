import { View, Text } from "react-native";
import { AlertTriangle, XCircle } from "lucide-react-native";
import { scaledStyles } from "@/lib/ui/compact";
import type { JourneyWarning } from "@/types/search";

/**
 * Farben der Warnungen — dieselben wie die übrigen Echtzeit-Signale:
 * Orange („alert" im Detail-Blatt) für einen gefährdeten Anschluss, das Rot der
 * Verspätungen (DelayedTime) für einen Ausfall. Ruhig gehalten: getönte Fläche,
 * kein Vollton.
 */
export const JOURNEY_WARNING_COLORS: Record<JourneyWarning, { fg: string; bg: string }> = {
  connectionAtRisk: { fg: "#FF7A59", bg: "rgba(255,122,89,0.14)" },
  cancelled: { fg: "#FF3B5C", bg: "rgba(255,59,92,0.14)" },
};

export function JourneyWarningIcon({ warning, size = 13 }: { warning: JourneyWarning; size?: number }) {
  const color = JOURNEY_WARNING_COLORS[warning].fg;
  return warning === "cancelled" ? (
    <XCircle size={size} color={color} strokeWidth={2.4} />
  ) : (
    <AlertTriangle size={size} color={color} strokeWidth={2.4} />
  );
}

/** Kleine Pille mit Symbol + Text, im Stil der Zeit-/Umstiegs-Abzeichen. */
export function JourneyWarningBadge({ warning, label }: { warning: JourneyWarning; label: string }) {
  const { fg, bg } = JOURNEY_WARNING_COLORS[warning];
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <JourneyWarningIcon warning={warning} />
      <Text style={[s.text, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const s = scaledStyles({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    borderRadius: 9999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  text: { fontSize: 12, fontWeight: "700", letterSpacing: -0.1 },
});
