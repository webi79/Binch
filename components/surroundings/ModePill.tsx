import { Text } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";
import { RippleTouch } from "@/components/ui/RippleTouch";

/**
 * Die Verkehrsmittel-Pille der Blätter auf der Karte — im Haltestellen-Blatt
 * (Zug · Bus an einem Halt) und im Stadt-Blatt (Zug · Bus · Flug). Beide nehmen
 * diese eine Pille; die Werte sind die aus `StopDetailSheet.tsx`.
 *
 * Flach: aktiv im Akzent gefüllt mit dunkler Schrift, sonst durchsichtig mit
 * grauem Rand. Beim Antippen die Welle wie an jedem Knopf der App
 * (`RippleTouch`) — auf der Akzentfläche dunkel getönt, sonst hell, damit sie
 * auf beiden zu sehen ist; der Beschnitt macht sie pillenförmig.
 *
 * `disabled` dimmt sie — sie bleibt aber antippbar, damit das Blatt sagen kann,
 * WARUM es dorthin nichts gibt (kein Zug über den Ozean, kein Flug in die
 * Nachbarstadt), statt stumm nicht zu reagieren.
 */
const BORDER = "#212123";
const WHITE = "#F4F4F5";

export function ModePill({
  Icon,
  label,
  active,
  disabled,
  onPress,
}: {
  Icon: LucideIcon;
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const accent = useAccent();
  return (
    <RippleTouch
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !!disabled }}
      accessibilityLabel={label}
      rippleColor={active ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.22)"}
      style={[
        styles.pill,
        active
          ? { backgroundColor: accent.solid, borderColor: accent.solid }
          : styles.pillInactive,
        disabled && !active ? styles.pillDisabled : null,
      ]}
    >
      <Icon size={17} color={active ? accent.textOnSolid : WHITE} strokeWidth={2.2} />
      <Text
        style={[styles.pillText, { color: active ? accent.textOnSolid : WHITE }]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </RippleTouch>
  );
}

const styles = scaledStyles({
  pill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    paddingVertical: 12,
    borderRadius: 9999,
    borderWidth: 1.5,
  },
  pillInactive: { backgroundColor: "transparent", borderColor: BORDER },
  pillDisabled: { opacity: 0.38 },
  pillText: { fontSize: 15, fontWeight: "700", letterSpacing: -0.15 },
});
