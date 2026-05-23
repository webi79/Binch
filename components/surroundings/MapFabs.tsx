import { View, StyleSheet } from "react-native";
import { Layers, Activity, Crosshair } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";

const LIME = "#7FEA4D";
const WHITE = "#FFFFFF";

interface Props {
  topInset: number;
  trafficOn: boolean;
  satelliteOn: boolean;
  onToggleLayers: () => void;
  onToggleTraffic: () => void;
  onLocate: () => void;
}

export function MapFabs({
  topInset,
  trafficOn,
  satelliteOn,
  onToggleLayers,
  onToggleTraffic,
  onLocate,
}: Props) {
  return (
    <View style={[styles.col, { top: topInset + 70 }]} pointerEvents="box-none">
      <Fab active={satelliteOn} onPress={onToggleLayers}>
        <Layers size={20} color={satelliteOn ? LIME : WHITE} strokeWidth={2} />
      </Fab>
      <Fab active={trafficOn} onPress={onToggleTraffic}>
        <Activity size={20} color={trafficOn ? LIME : WHITE} strokeWidth={2} />
      </Fab>
      <Fab onPress={onLocate}>
        <Crosshair size={20} color={LIME} strokeWidth={2} />
      </Fab>
    </View>
  );
}

function Fab({
  children,
  onPress,
  active,
}: {
  children: React.ReactNode;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <RippleTouch
      style={[styles.fab, active && styles.fabActive]}
      borderless
      onPress={onPress}
    >
      {children}
    </RippleTouch>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: "rgba(26,26,26,0.92)",
    borderColor: "#2E2E30",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  fabActive: {
    borderColor: LIME,
  },
});
