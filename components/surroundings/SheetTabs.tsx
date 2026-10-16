import { Pressable, Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Die Reiter der Blätter auf der Karte: Symbol, Beschriftung, darunter ein
 * Strich im Akzent unter dem aktiven.
 *
 * Stand bis eben nur im Auswahlfenster (Transit · Airport · Cruise). Das
 * Stadt-Blatt braucht dieselbe Reihe für Zug · Bus · Flug — im Referenzbild von
 * Google ist es genau diese Form (Symbol + Dauer, Strich unter dem aktiven).
 * Beide nehmen jetzt diese eine Reihe; Maße und Farben sind unverändert die
 * aus `SurroundingsSheet.tsx`.
 *
 * `hint` hängt eine Angabe an die Beschriftung („Zug · 3h 12m"). Der Reiter
 * bleibt dabei gleich breit (alle teilen sich die Zeile), es verschiebt sich
 * also nichts. `disabled` dimmt einen Reiter — antippbar bleibt er, damit das
 * Blatt sagen kann, warum es dorthin nichts gibt.
 */
const WHITE = "#F4F4F5";
const G2 = "#8E8E93";
const BORDER = "#212123";

export interface SheetTab<K extends string> {
  key: K;
  label: string;
  Icon: LucideIcon;
  hint?: string;
  disabled?: boolean;
}

export function SheetTabs<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: SheetTab<K>[];
  active: K;
  onChange: (key: K) => void;
}) {
  const accent = useAccent();
  return (
    <View style={styles.tabRow}>
      {tabs.map(({ key, label, Icon, hint, disabled }) => {
        const on = active === key;
        return (
          <Pressable
            key={key}
            style={[styles.tab, disabled && !on ? styles.tabDisabled : null]}
            onPress={() => onChange(key)}
            android_ripple={null}
            hitSlop={4}
            accessibilityRole="tab"
            accessibilityState={{ selected: on, disabled: !!disabled }}
          >
            <View style={styles.tabInner}>
              <Icon color={on ? accent.solid : G2} size={18} strokeWidth={2} />
              <Text
                style={[
                  styles.tabLabel,
                  { color: on ? WHITE : G2, fontWeight: on ? "700" : "600" },
                ]}
                numberOfLines={1}
              >
                {label}
                {hint ? <Text style={styles.tabHint}>{` · ${hint}`}</Text> : null}
              </Text>
            </View>
            {on && <View style={[styles.tabUnderline, { backgroundColor: accent.solid }]} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = scaledStyles({
  tabRow: {
    flexDirection: "row",
    borderBottomColor: BORDER,
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    alignItems: "center",
    position: "relative",
  },
  tabDisabled: { opacity: 0.38 },
  tabInner: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
  },
  tabLabel: {
    fontSize: 14,
    letterSpacing: -0.1,
  },
  tabHint: { color: G2, fontWeight: "600" },
  tabUnderline: {
    position: "absolute",
    bottom: 0,
    left: "15%",
    right: "15%",
    height: 3,
    borderRadius: 2,
  },
});
