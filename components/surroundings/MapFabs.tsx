import { View, StyleSheet } from "react-native";
import { Layers, Activity, Crosshair } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";

const WHITE = "#F4F4F5";

interface Props {
  topInset: number;
  trafficOn: boolean;
  satelliteOn: boolean;
  onToggleLayers: () => void;
  onToggleTraffic: () => void;
  onLocate: () => void;
  /** Ortung läuft — Knopf gedimmt, damit niemand ins Leere tippt. */
  locating?: boolean;
}

export function MapFabs({
  topInset,
  trafficOn,
  satelliteOn,
  onToggleLayers,
  onToggleTraffic,
  onLocate,
  locating,
}: Props) {
  const accent = useAccent();
  return (
    <View style={[styles.col, { top: topInset + 70 }]} pointerEvents="box-none">
      <Fab active={satelliteOn} onPress={onToggleLayers} activeColor={accent.solid}>
        <Layers size={20} color={satelliteOn ? accent.solid : WHITE} strokeWidth={2} />
      </Fab>
      <Fab active={trafficOn} onPress={onToggleTraffic} activeColor={accent.solid}>
        <Activity size={20} color={trafficOn ? accent.solid : WHITE} strokeWidth={2} />
      </Fab>
      <Fab onPress={onLocate} dimmed={locating}>
        <Crosshair size={20} color={accent.solid} strokeWidth={2} />
      </Fab>
    </View>
  );
}

function Fab({
  children,
  onPress,
  active,
  activeColor,
  dimmed,
}: {
  children: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  activeColor?: string;
  dimmed?: boolean;
}) {
  return (
    <RippleTouch
      style={[
        styles.fab,
        active && activeColor ? { borderColor: activeColor } : null,
        dimmed ? { opacity: 0.5 } : null,
      ]}
      borderless
      onPress={onPress}
    >
      {children}
    </RippleTouch>
  );
}

const styles = scaledStyles({
  col: {
    position: "absolute",
    right: 16,
    rowGap: 10,
    zIndex: 25,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(13,13,13,0.92)",
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
  // fabActive entfernt — borderColor wird inline aus accent.solid gesetzt.
});
