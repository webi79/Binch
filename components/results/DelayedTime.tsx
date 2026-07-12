import { View, Text, StyleSheet, type StyleProp, type TextStyle } from "react-native";

/**
 * Zeit mit optionaler Verspätung: liegt eine vor, wird die neue Ist-Zeit klein
 * (rot) über die durchgestrichene, ausgegraute Fahrplanzeit gesetzt. Ohne
 * Verspätung nur die normale Zeit im übergebenen Style.
 *
 * Die Ist-Zeit ist ABSOLUT positioniert (out of flow) → die Zeile wird nicht
 * höher, die Card verrutscht nicht, egal ob eine Verspätung vorliegt oder nicht.
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
  const pos = align === "flex-end" ? s.right : align === "center" ? s.center : s.left;
  return (
    <View>
      <Text style={[s.delayed, pos]} numberOfLines={1}>
        {delayed}
      </Text>
      <Text style={[style, s.struck]}>{scheduled}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  delayed: {
    position: "absolute",
    bottom: "100%", // direkt über die Fahrplanzeit, ohne Layout-Höhe zu ändern
    color: "#FF3B5C",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: -0.3,
  },
  left: { left: 0 },
  right: { right: 0 },
  center: { left: 0, right: 0, textAlign: "center" },
  // Durchgestrichene Fahrplanzeit: ausgegraut (NICHT rot) — nur die neue Zeit
  // sticht rot heraus.
  struck: { color: "#8A8A90", textDecorationLine: "line-through" },
});
