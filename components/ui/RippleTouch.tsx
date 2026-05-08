import { type ReactNode } from "react";
import {
  Pressable,
  TouchableNativeFeedback,
  Platform,
  View,
  type StyleProp,
  type ViewStyle,
  type PressableProps,
  type GestureResponderEvent,
} from "react-native";

type StyleCallback = (state: { pressed: boolean }) => StyleProp<ViewStyle>;

interface Props {
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  hitSlop?: PressableProps["hitSlop"];
  accessibilityLabel?: string;
  disabled?: boolean;

  /** Hintergrundfarbe des Buttons. Bestimmt Ripple-Tönung (default: passend für Dark-UI). */
  rippleColor?: string;
  /** Borderless-Ripple — kreisförmig über Bounds hinaus (für Icon-Buttons ohne sichtbaren Container). */
  borderless?: boolean;
  /** Native-Wind className (auf Android wird sie auf den inneren View gesetzt, auf iOS auf Pressable). */
  className?: string;
  /** Style. Falls Funktion `({pressed}) => ...`: auf Android nehmen wir die `pressed=false`-Variante. */
  style?: StyleProp<ViewStyle> | StyleCallback;
  children?: ReactNode;
}

/**
 * Plattform-konsistenter Click-Button.
 *
 * Android: rendert `TouchableNativeFeedback` mit Material-Ripple. Wir nutzen
 * NICHT `Pressable.android_ripple` weil NativeWind v4's `jsxImportSource` den
 * Prop in der JSX-Interop schluckt — Ripples werden so unsichtbar.
 *
 * iOS: regulares `Pressable` (kein nativer Ripple bei Apple — würde gegen
 * Plattform-Konventionen verstoßen). iOS-Feedback (Opacity) kommt vom
 * Aufrufer-Style, falls gewünscht.
 *
 * Layout bleibt identisch — der TouchableNativeFeedback-Wrapper auf Android
 * rendert den Inhalt unverändert mit dem übergebenen `style`/`className`.
 */
export function RippleTouch({
  onPress,
  onLongPress,
  hitSlop,
  accessibilityLabel,
  disabled,
  rippleColor,
  borderless = false,
  className,
  style,
  children,
}: Props) {
  if (Platform.OS === "android") {
    const flatStyle: StyleProp<ViewStyle> =
      typeof style === "function" ? style({ pressed: false }) : style;
    const color = rippleColor ?? "rgba(255,255,255,0.42)";
    // `overflow: hidden` triggers RN's `setClipToOutline(true)` auf dem View,
    // sodass die Foreground-Ripple-Drawable die `borderRadius`-Form respektiert
    // und nicht über abgerundete Ecken hinausbreit. Bei Borderless-Ripple
    // (Icon-Buttons) NICHT clippen — der Ripple soll dort kreisförmig über
    // die Bounds hinausgehen, das ist der Sinn von borderless.
    const clipStyle: ViewStyle = borderless ? {} : { overflow: "hidden" };
    return (
      <TouchableNativeFeedback
        onPress={onPress}
        onLongPress={onLongPress}
        hitSlop={hitSlop}
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        background={TouchableNativeFeedback.Ripple(color, borderless)}
        useForeground={true}
        delayPressIn={50}
      >
        <View style={[flatStyle, clipStyle]} className={className}>
          {children}
        </View>
      </TouchableNativeFeedback>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={hitSlop}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      delayLongPress={500}
      unstable_pressDelay={50}
      style={style as PressableProps["style"]}
      className={className as never}
    >
      {children}
    </Pressable>
  );
}
