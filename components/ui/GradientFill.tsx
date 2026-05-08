import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";

export const BRAND_GRADIENT = ["#B6F44A", "#7FEA4D", "#3ED35A"] as const;
export const BRAND_GRADIENT_PRESSED = ["#7FEA4D", "#3ED35A"] as const;

interface Props {
  style?: StyleProp<ViewStyle>;
  pressed?: boolean;
}

/** Absolute-fill brand gradient (135°). Place as first child inside an
 *  `overflow: "hidden"` parent. */
export function GradientFill({ style, pressed = false }: Props) {
  return (
    <LinearGradient
      colors={pressed ? [...BRAND_GRADIENT_PRESSED] : [...BRAND_GRADIENT]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFillObject, style]}
    />
  );
}
