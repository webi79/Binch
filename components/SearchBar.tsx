import { Text, TextInput, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Search as SearchIcon, Mic } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";

const COLORS = {
  surface: "#242425",
  lime: "#7FEA4D",
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
  onPress?: undefined;
}

type Props = PressProps | InputProps;

export function SearchBar(props: Props) {
  const t = useT();
  const router = useRouter();
  const openVoiceOverlay = useSearchStore((s) => s.openVoiceOverlay);
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
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={placeholder}
          placeholderTextColor={COLORS.gray3}
          style={styles.input}
          autoCorrect={false}
          autoFocus={props.autoFocus}
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
