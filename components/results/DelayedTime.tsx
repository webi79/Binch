import { View, Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";

/**
 * Zeigt eine Zeit mit optionaler Verspätung: liegt eine Verspätung vor, wird
 * die neue Ist-Zeit klein (rot) über die rot durchgestrichene Fahrplanzeit
 * gesetzt. Ohne Verspätung nur die normale Zeit im übergebenen Style.
 */
export function DelayedTime({
  scheduled,
  delayed,
  style,
  align = "flex-start",
}: {
  /** Fahrplanzeit (bereits zonen-korrekt formatiert). */
  scheduled: string;
  /** Neue Ist-Zeit (formatiert) — wenn gesetzt, liegt eine Verspätung vor. */
  delayed?: string;
  style?: StyleProp<TextStyle>;
  align?: "flex-start" | "flex-end" | "center";
}) {
  if (!delayed) return <Text style={style}>{scheduled}</Text>;
  return (
    <View style={{ alignItems: align }}>
      <Text style={s.delayed}>{delayed}</Text>
      <Text style={[style, s.struck]}>{scheduled}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  delayed: { color: "#FF3B5C", fontSize: 12, fontWeight: "800", letterSpacing: -0.3, lineHeight: 15 },
  struck: { color: "#FF3B5C", textDecorationLine: "line-through" },
});
