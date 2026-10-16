import type { ReactNode } from "react";
import { Pressable, type GestureResponderEvent, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

/**
 * Ein Knopf, der beim Drücken leicht verblasst — für die X-Knöpfe der Blätter.
 *
 * WARUM NICHT `style={({ pressed }) => …}`: Diese Form kommt an einer
 * `Pressable` in dieser App gar nicht an — NativeWinds JSX-Umschreibung
 * verschluckt sie stumm. Die X-Knöpfe trugen genau das und zeigten beim
 * Drücken nie eine Rückmeldung.
 *
 * WARUM NICHT `RippleTouch`: Diese Knöpfe STARTEN die Ausfahrt ihres Blattes,
 * und die Welle ist eine 300 bis 400 ms lange Zeichen-Animation auf einer
 * Fläche, die sich in derselben Zeit bewegt.
 *
 * Die Deckkraft läuft über einen geteilten Wert, auf dem UI-Strang — ohne
 * React-Durchgang, der mitten in den Beginn der Ausfahrt fiele.
 */
export function FadePress({
  children,
  pressedOpacity = 0.7,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, "style" | "children"> & {
  children: ReactNode;
  /** Deckkraft, solange der Finger liegt. */
  pressedOpacity?: number;
}) {
  const opacity = useSharedValue(1);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Pressable
      {...rest}
      onPressIn={(e: GestureResponderEvent) => {
        opacity.value = withTiming(pressedOpacity, { duration: 60 });
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        opacity.value = withTiming(1, { duration: 140 });
        onPressOut?.(e);
      }}
    >
      <Animated.View style={fade}>{children}</Animated.View>
    </Pressable>
  );
}
