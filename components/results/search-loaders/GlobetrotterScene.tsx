/**
 * „Globetrotter" — Bo reitet auf dem Papierflieger über den Routenbogen.
 */
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated from "react-native-reanimated";
import { Bo } from "@/components/assistant/Bo";
import { useAccent } from "@/lib/theme/accent";
import {
  PaperPlane,
  MapPin,
  Cloud,
  useArcMotion,
  useArcStyle,
  SCENE_W,
  SCENE_H,
} from "./SearchSceneChrome";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  originCode?: string;
  destCode?: string;
}

export function GlobetrotterScene({ originCode = "—", destCode = "—" }: Props) {
  const accent = useAccent();
  const p = useArcMotion(5000);
  const flyerStyle = useArcStyle(p, 70, 76);

  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      <View style={[styles.cloud, { top: 30, left: 36 }]}>
        <Cloud w={84} />
      </View>
      <View style={[styles.cloud, { top: 96, left: 150 }]}>
        <Cloud w={100} />
      </View>

      <Svg width={SCENE_W} height={SCENE_H} style={StyleSheet.absoluteFill}>
        <Path d="M30,170 Q150,40 270,170" stroke="#212123" strokeWidth={3} fill="none" />
        <Path
          d="M30,170 Q150,40 270,170"
          stroke={accent.solid}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="6 9"
          fill="none"
        />
      </Svg>

      <View style={{ position: "absolute", left: 18, top: 156 }}>
        <MapPin size={26} color="#8E8E93" />
      </View>
      <View style={{ position: "absolute", left: 256, top: 156 }}>
        <MapPin size={26} color={accent.solid} />
      </View>
      <Text style={[styles.code, { left: 8, top: 186, color: "#8E8E93" }]}>
        {originCode}
      </Text>
      <Text style={[styles.code, { left: 250, top: 186, color: accent.solid }]}>
        {destCode}
      </Text>

      <Animated.View style={[styles.flyer, flyerStyle]} pointerEvents="none">
        <View style={styles.bo}>
          <Bo state="waving" size={86} />
        </View>
        <View style={styles.plane}>
          <PaperPlane
            size={100}
            light={accent.gradient[0]}
            main={accent.solid}
            dark={accent.dark}
          />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = scaledStyles({
  flyer: { position: "absolute", top: 0, left: 0, width: 140, height: 150 },
  bo: { position: "absolute", left: 27, top: 6 },
  plane: { position: "absolute", left: 20, top: 96 },
  cloud: { position: "absolute" },
  code: { position: "absolute", fontSize: 11, fontWeight: "700" },
});
