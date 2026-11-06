/**
 * Stellt seinen Inhalt mittig in den Teil der Fläche, den die Tastatur NICHT
 * verdeckt.
 *
 * Warum es das braucht: Die App läuft randlos (Android edge-to-edge); das
 * Fenster wird für die Tastatur nicht kleiner. Eine Liste reicht deshalb bis
 * unter die Tastatur, und „mittig in der Liste" hieß: halb verdeckt — „Nichts
 * gefunden" stand unten am Tastaturrand, der Satz darunter war abgeschnitten
 * (05.11.2026).
 *
 * Die Fläche selbst bleibt, wie sie ist; der Inhalt steht in ihrer Mitte und
 * rückt um die halbe Überdeckung nach oben — Bild für Bild mit der Tastatur,
 * nur über die Lage (schneller Weg, kein Layout). Nie über die Oberkante der
 * Fläche hinaus: Ist der Platz zu knapp, steht er oben.
 *
 * Voraussetzung: Die Fläche reicht bis `bottomOffset` Punkte über den
 * Bildschirmrand (meist 0 — sie geht bis ganz unten). Die Tastaturhöhe zählt
 * ab dem Bildschirmrand (`lib/nav/keyboardHeight.ts`).
 */
import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { keyboardHeight } from "@/lib/nav/keyboardHeight";

export function KeyboardCenter({
  children,
  bottomOffset = 0,
  style,
}: {
  children: ReactNode;
  /** Wie weit die Unterkante der Fläche über dem Bildschirmrand liegt. */
  bottomOffset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const areaH = useSharedValue(0);
  const contentH = useSharedValue(0);
  const lift = useAnimatedStyle(() => {
    // So viel der Fläche liegt unter der Tastatur.
    const covered = Math.max(0, keyboardHeight.value - bottomOffset);
    // So weit darf der Inhalt höchstens steigen (dann steht er oben an).
    const room = Math.max(0, (areaH.value - contentH.value) / 2);
    return { transform: [{ translateY: -Math.min(covered / 2, room) }] };
  });
  return (
    <View
      style={[{ flex: 1, justifyContent: "center" }, style]}
      onLayout={(e) => {
        areaH.value = e.nativeEvent.layout.height;
      }}
    >
      <Animated.View
        style={lift}
        onLayout={(e) => {
          contentH.value = e.nativeEvent.layout.height;
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}
