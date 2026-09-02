import { View, Text, StyleSheet } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useT } from "@/lib/i18n/useT";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  title: string;
  /** Anzahl der Waypoints insgesamt (inkl. Origin/Destination). */
  waypointCount: number;
  /** Tap = Route schließen + zurück zum vorherigen Screen. */
  onBack: () => void;
  topInset: number;
}

/**
 * Schwebendes Banner oben — Back-Arrow links auf SearchBar-Höhe, daneben
 * Route-Titel und Anzahl der Umstiege (Origin/Destination zählen nicht).
 */
export function RouteBanner({ title, waypointCount, onBack, topInset }: Props) {
  const t = useT();
  const transferCount = Math.max(0, waypointCount - 2);
  const transferText =
    transferCount === 0
      ? t("surroundings.route.direct")
      : `${transferCount} ${transferCount === 1 ? t("surroundings.route.transfer.one") : t("surroundings.route.transfer.many")}`;

  return (
    <View style={[styles.wrap, { top: topInset + 8 }]} pointerEvents="box-none">
      <RippleTouch onPress={onBack} hitSlop={8} style={styles.backBtn}>
        <ArrowLeft color="#F4F4F5" size={20} strokeWidth={2.2} />
      </RippleTouch>
      <View style={styles.titleBox}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {transferText}
        </Text>
      </View>
    </View>
  );
}

const styles = scaledStyles({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 30,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 12,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(27,27,27,0.95)",
    borderColor: "#212123",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  titleBox: {
    flex: 1,
    backgroundColor: "rgba(27,27,27,0.95)",
    borderColor: "#212123",
    borderWidth: 1,
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 8,
    rowGap: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: "700",
    color: "#F4F4F5",
    letterSpacing: -0.2,
  },
  subtitle: {
    fontSize: 11,
    color: "#8E8E93",
    fontWeight: "500",
  },
});
