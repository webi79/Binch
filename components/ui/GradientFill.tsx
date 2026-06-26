import { LinearGradient } from "expo-linear-gradient";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useAccent } from "@/lib/theme/accent";

// Fallback-Werte für Caller die Gradient-Stops ohne den Hook brauchen
// (z.B. wenn der Import als Konstante statt im Render-Tree benutzt wird).
// In den meisten Fällen verwenden Components GradientFill direkt — dort
// kommt der dynamische Akzent automatisch via useAccent.
export const BRAND_GRADIENT = ["#A6F37A", "#7FEA4D", "#4FB42B"] as const;
export const BRAND_GRADIENT_PRESSED = ["#7FEA4D", "#4FB42B"] as const;

interface Props {
  style?: StyleProp<ViewStyle>;
  pressed?: boolean;
}

/** Absolute-fill brand gradient (135°). Place as first child inside an
 *  `overflow: "hidden"` parent. Liest den User-gewählten Akzent live —
 *  TabBar/CTAs ändern Farbe sobald der User im Settings-Screen wechselt. */
export function GradientFill({ style, pressed = false }: Props) {
  const accent = useAccent();
  const colors = pressed
    ? ([accent.solid, accent.dark] as [string, string])
    : (accent.gradient as readonly [string, string, string]);
  return (
    <LinearGradient
      colors={colors as unknown as readonly [string, string, ...string[]]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[StyleSheet.absoluteFillObject, style]}
    />
  );
}
