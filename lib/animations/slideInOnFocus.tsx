import { ReactNode, useEffect, useState } from "react";
import { StyleProp, ViewStyle } from "react-native";
import Animated, {
  SlideInRight,
  SlideInLeft,
  SlideInUp,
  SlideInDown,
} from "react-native-reanimated";
import { useIsFocused } from "@react-navigation/native";

type Direction = "right" | "left" | "bottom" | "top";

const ENTERING = {
  right: SlideInRight,
  left: SlideInLeft,
  bottom: SlideInDown,
  top: SlideInUp,
} as const;

export interface SlideInOptions {
  /**
   * Side the screen flies in from. Default "right" (slides from right edge → left).
   * Use "bottom" for a modal-style upward slide.
   */
  from?: Direction;
  /**
   * Animation duration in ms. Default 350 (matches the native modal
   * slide-up used for the voice screen).
   */
  duration?: number;
}

interface Props extends SlideInOptions {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * Wraps a screen so it slides in every time it gains focus.
 *
 * Implementation: tracks focus via `useIsFocused`, bumps an internal key on
 * every focus gain, and lets Reanimated's `entering` animation run on the
 * fresh remount. This works on lazy bottom-tabs where the screen normally
 * mounts only once — a focus-driven re-mount forces the entering animation
 * to re-run.
 */
export function SlideInOnFocus({ children, style, from = "right", duration = 350 }: Props) {
  const focused = useIsFocused();
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    if (focused) setRenderKey((k) => k + 1);
  }, [focused]);

  const entering = ENTERING[from].duration(duration);

  return (
    <Animated.View
      key={renderKey}
      entering={entering}
      style={[{ flex: 1 }, style]}
    >
      {children}
    </Animated.View>
  );
}
