import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useAccent } from "@/lib/theme/accent";

// Referenz-Stops der Lime-Palette (falls irgendwo als Konstante gebraucht).
// Die App rendert Akzentflächen aktuell FLACH — siehe GradientFill.
export const BRAND_GRADIENT = ["#A6F37A", "#7FEA4D", "#4FB42B"] as const;
export const BRAND_GRADIENT_PRESSED = ["#7FEA4D", "#4FB42B"] as const;

interface Props {
  style?: StyleProp<ViewStyle>;
  pressed?: boolean;
}

/**
 * Absolute-fill Akzentfläche. Trotz des historischen Namens rendert sie FLACH
 * (eine Akzentfarbe statt 135°-Verlauf) — bewusste Design-Entscheidung für ein
 * ruhigeres, moderneres UI. Liest den User-Akzent live via useAccent; `pressed`
 * dunkelt für Press-Feedback ab. Als erstes Kind in einen `overflow: "hidden"`-
 * Container legen.
 *
 * (Zurück auf Verlauf: wieder ein <LinearGradient colors={accent.gradient}>
 *  rendern — die Caller bleiben unverändert.)
 */
export function GradientFill({ style, pressed = false }: Props) {
  const accent = useAccent();
  return (
    <View
      style={[
        StyleSheet.absoluteFillObject,
        { backgroundColor: pressed ? accent.dark : accent.solid },
        style,
      ]}
    />
  );
}
