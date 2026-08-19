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
  /** Touch-Down / Touch-Up — für physisches Press-Feedback (Zusammendrücken). */
  onPressIn?: (e: GestureResponderEvent) => void;
  onPressOut?: (e: GestureResponderEvent) => void;
  /**
   * Rohes Berührungs-Ereignis, durchgereicht.
   *
   * Gebraucht für Vorbereitungen, die schon beim AUFSETZEN laufen müssen — etwa
   * das Anlegen einer GPU-Textur, deren Aufbau im Projekt mit 66ms vermessen ist
   * und deshalb nicht in den Start einer Bewegung fallen darf. Bewusst nicht
   * `onPressIn`: Der wird hier um 50ms zurückgehalten (Scroll-Schutz), und in
   * einer Liste wird ein Druck-Beginn oft ein Scrollen. Das reine
   * Berührungs-Ereignis beansprucht die Geste nicht.
   */
  onTouchStart?: (e: GestureResponderEvent) => void;
  hitSlop?: PressableProps["hitSlop"];
  accessibilityLabel?: string;
  disabled?: boolean;

  /** Hintergrundfarbe des Buttons. Bestimmt Ripple-Tönung (default: passend für Dark-UI). */
  rippleColor?: string;
  /** Borderless-Ripple — kreisförmig über Bounds hinaus (für Icon-Buttons ohne sichtbaren Container). */
  borderless?: boolean;
  /**
   * Kein `overflow: "hidden"` setzen.
   *
   * Nötig für Elemente, die von einer Animation per TRANSFORM bewegt werden: Der
   * Clip (Android `clipToOutline`) rendert unter einem Ancestor-Transform
   * fehlerhaft — gerundete Ecken flackern und die Bewegung ruckelt. Wer das
   * setzt, muss seine Kinder selbst runden (z.B. Bild via `imageStyle`), sonst
   * ragen sie über die Ecken hinaus. Der Ripple breitet sich dann rechteckig aus.
   */
  noClip?: boolean;
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
  onPressIn,
  onPressOut,
  onTouchStart,
  hitSlop,
  accessibilityLabel,
  disabled,
  rippleColor,
  borderless = false,
  noClip = false,
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
    // noClip: bewusst ohne Clip (siehe Prop-Doku) — für per Transform bewegte
    // Elemente, wo clipToOutline sonst flackernde Ecken erzeugt.
    const clipStyle: ViewStyle = borderless || noClip ? {} : { overflow: "hidden" };
    return (
      <TouchableNativeFeedback
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        hitSlop={hitSlop}
        accessibilityLabel={accessibilityLabel}
        disabled={disabled}
        background={TouchableNativeFeedback.Ripple(color, borderless)}
        useForeground={true}
        // Verzögerung wieder drin — ihr Entfernen hat das Scrollen im
        // Landingscreen spürbar ruckeln lassen. Ohne sie startet bei JEDER
        // Berührung sofort die Ripple-Animation, auch wenn die Bewegung
        // eigentlich der Anfang einer Scroll-Geste ist; sie muss dann mitten im
        // Scroll-Start wieder abgebrochen werden. Genau diese Arbeit fällt in
        // den empfindlichsten Frame.
        //
        // Verschluckte Tipper drohen hier NICHT: TouchableNativeFeedback
        // verzögert nur das optische Feedback, `onPress` feuert beim Loslassen
        // unabhängig davon. (Anders als Pressables `unstable_pressDelay` — das
        // bleibt deshalb unten aus.) Die verschluckten Tipper von vorhin kamen
        // ohnehin aus der synchronen Store-Serialisierung, die jetzt weg ist.
        delayPressIn={50}
      >
        {/* `onTouchStart` sitzt auf der inneren Ansicht: Die native Umhüllung
            auf Android nimmt das Ereignis nicht entgegen. Wirkung ist dieselbe,
            es feuert beim Aufsetzen des Fingers. */}
        <View style={[flatStyle, clipStyle]} className={className} onTouchStart={onTouchStart}>
          {children}
        </View>
      </TouchableNativeFeedback>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      onTouchStart={onTouchStart}
      hitSlop={hitSlop}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      delayLongPress={500}
      // unstable_pressDelay ebenfalls raus, siehe Android-Zweig oben.
      style={style as PressableProps["style"]}
      className={className as never}
    >
      {children}
    </Pressable>
  );
}
