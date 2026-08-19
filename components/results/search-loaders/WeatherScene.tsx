/**
 * „Wetter am Ziel" — Bo fliegt ins Warme, Sonne + Wetter-Chip am Ziel.
 */
import { View, Text, StyleSheet } from "react-native";
import Svg, { Path } from "react-native-svg";
import Animated from "react-native-reanimated";
import { Bo } from "@/components/assistant/Bo";
import { useT } from "@/lib/i18n/useT";
import { useAccent } from "@/lib/theme/accent";
import {
  Sun,
  WeatherChip,
  MapPin,
  Cloud,
  useArcMotion,
  useArcStyle,
  SCENE_W,
  SCENE_H,
} from "./SearchSceneChrome";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  destLabel: string;
}

export function WeatherScene({ destLabel }: Props) {
  const accent = useAccent();
  const t = useT();
  const p = useArcMotion(5000);
  // Anker = Bos Körpermitte (size 86): ~ (43, 70)
  const flyerStyle = useArcStyle(p, 43, 70);

  const shortDest = destLabel.length > 18 ? destLabel.slice(0, 16) + "…" : destLabel;

  return (
    <View style={{ width: SCENE_W, height: SCENE_H }}>
      <View style={[styles.cloud, { top: 30, left: 36 }]}>
        <Cloud w={84} />
      </View>
      <View style={[styles.cloud, { top: 96, left: 150 }]}>
        <Cloud w={100} />
      </View>

      <View style={{ position: "absolute", top: 4, right: 2 }}>
        <Sun size={64} accent={accent.solid} />
      </View>
      <View style={{ position: "absolute", top: 14, left: 6 }}>
        <WeatherChip temp="24°" place={shortDest} cond="Sonnig" accent={accent.solid} />
      </View>

      <Svg width={SCENE_W} height={SCENE_H} style={StyleSheet.absoluteFill}>
        <Path d="M30,170 Q150,40 270,170" stroke="#2E2E30" strokeWidth={3} fill="none" />
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
        <MapPin size={26} color="#8A8A90" />
      </View>
      <View style={{ position: "absolute", left: 256, top: 156 }}>
        <MapPin size={26} color={accent.solid} />
      </View>
      <Text style={[styles.code, { left: 8, top: 186, color: "#8A8A90" }]}>{t("loader.from")}</Text>
      <Text style={[styles.code, { left: 250, top: 186, color: accent.solid }]}>
        NACH
      </Text>

      <Animated.View style={[styles.flyer, flyerStyle]} pointerEvents="none">
        <Bo state="happy" size={86} />
      </Animated.View>
    </View>
  );
}

const styles = scaledStyles({
  flyer: { position: "absolute", top: 0, left: 0 },
  cloud: { position: "absolute" },
  code: { position: "absolute", fontSize: 11, fontWeight: "700" },
});
