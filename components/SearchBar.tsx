import { useEffect, useRef } from "react";
import { Text, TextInput, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Search as SearchIcon, Mic } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";

const COLORS = {
  surface: "#242425",
  // lime entfernt — GradientFill liest den User-Akzent via useAccent().
  black: "#000000",
  white: "#FFFFFF",
  gray2: "#8A8A90",
  gray3: "#56565C",
};

interface CommonProps {
  /** i18n key for the placeholder. Defaults to `home.search.placeholder`. */
  placeholderKey?: string;
  /** Optional leading label (e.g. "From", "To") rendered before the input. */
  leadingLabel?: string;
  /** Hide the mic button (e.g. inside the voice screen itself). */
  showMic?: boolean;
  /** Override the mic-button action (defaults to `/search/voice`). */
  onMicPress?: () => void;
  /** Extra style applied to the outer pill (margins/positioning). */
  style?: StyleProp<ViewStyle>;
}

interface PressProps extends CommonProps {
  /** Tap handler. If not given, navigates to `/search`. */
  onPress?: () => void;
  value?: undefined;
  onChangeText?: undefined;
  autoFocus?: undefined;
}

interface InputProps extends CommonProps {
  /** Controlled value — switches the bar into text-input mode. */
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
  /** Delay (ms) bevor der Focus auf das Input gesetzt wird. Nützlich wenn
   *  der SearchBar in einem Modal/Slide-In sitzt — sofortiges autoFocus
   *  triggert das Keyboard parallel zum Slide, was auf Android beim ersten
   *  Mal spürbares Lag macht. Mit Delay startet das Keyboard erst NACH dem
   *  Slide. */
  autoFocusDelay?: number;
  onPress?: undefined;
}

type Props = PressProps | InputProps;

export function SearchBar(props: Props) {
  const t = useT();
  const router = useRouter();
  const openVoiceOverlay = useSearchStore((s) => s.openVoiceOverlay);
  const inputRef = useRef<TextInput>(null);

  // Verzögertes autoFocus: wenn autoFocusDelay gesetzt ist, fokussieren
  // wir manuell via setTimeout statt mit nativem autoFocus-Prop. Damit
  // wird der Keyboard-Cold-Start nicht parallel zum Slide-In ausgeführt.
  // Außerdem reagiert das Effect auch wenn autoFocus von false→true togglet
  // (z.B. weil ein parent-Overlay sichtbar wird) → wir können dann ein
  // immer-gemountetes Picker-Overlay realisieren.
  const inputAutoFocusDelay =
    "autoFocusDelay" in props ? props.autoFocusDelay : undefined;
  const inputAutoFocus = "autoFocus" in props ? props.autoFocus : undefined;
  const hasInputValue = props.value !== undefined;
  useEffect(() => {
    if (!hasInputValue) return;
    if (inputAutoFocus !== true) {
      // autoFocus=false oder undefined → Input blur (z.B. wenn Overlay
      // unsichtbar wird) damit das Keyboard sich schließt.
      inputRef.current?.blur();
      return;
    }
    if (inputAutoFocusDelay === undefined) {
      // Nativer autoFocus übernimmt — der useEffect macht hier nichts.
      return;
    }
    const id = setTimeout(() => {
      inputRef.current?.focus();
    }, inputAutoFocusDelay);
    return () => clearTimeout(id);
  }, [hasInputValue, inputAutoFocus, inputAutoFocusDelay]);
  const {
    placeholderKey = "home.search.placeholder",
    leadingLabel,
    showMic = true,
    onMicPress,
    style,
  } = props;

  const isInput = "value" in props && props.value !== undefined;
  const placeholder = t(placeholderKey);

  const mic = showMic ? (
    <RippleTouch
      style={styles.micButton}
      hitSlop={6}
      borderless
      onPress={(e) => {
        e.stopPropagation?.();
        if (onMicPress) onMicPress();
        else openVoiceOverlay();
      }}
      accessibilityLabel={t("mode.voice")}
    >
      <GradientFill />
      <Mic size={17} color={COLORS.black} strokeWidth={1.8} />
    </RippleTouch>
  ) : null;

  if (isInput) {
    return (
      <View style={[styles.bar, style]}>
        <SearchIcon size={18} color={COLORS.gray2} />
        {leadingLabel && <Text style={styles.leadingLabel}>{leadingLabel}</Text>}
        <TextInput
          ref={inputRef}
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={placeholder}
          placeholderTextColor={COLORS.gray3}
          style={styles.input}
          autoCorrect={false}
          // Nativer autoFocus nur wenn KEIN Delay konfiguriert ist.
          // Sonst übernimmt der useEffect oben das Fokussieren.
          autoFocus={inputAutoFocus === true && inputAutoFocusDelay === undefined}
        />
        {mic}
      </View>
    );
  }

  return (
    <RippleTouch
      style={[styles.bar, style]}
      onPress={props.onPress ?? (() => router.navigate("/search"))}
    >
      <SearchIcon size={18} color={COLORS.gray2} />
      {leadingLabel && <Text style={styles.leadingLabel}>{leadingLabel}</Text>}
      <Text style={styles.placeholder} numberOfLines={1}>
        {placeholder}
      </Text>
      {mic}
    </RippleTouch>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: COLORS.surface,
    borderRadius: 9999,
    paddingLeft: 18,
    paddingRight: 8,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  leadingLabel: { fontSize: 14, color: COLORS.white, fontWeight: "500" },
  placeholder: { flex: 1, fontSize: 14, color: COLORS.gray2, fontWeight: "400", paddingVertical: 10 },
  input: { flex: 1, fontSize: 14, color: COLORS.white, fontWeight: "400", paddingVertical: 10 },
  micButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
