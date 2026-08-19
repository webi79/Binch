import { useEffect, useRef } from "react";
import { Text, TextInput, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useRouter } from "expo-router";
import { Search as SearchIcon } from "lucide-react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { useSearchStore } from "@/stores/searchStore";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { scaledStyles } from "@/lib/ui/compact";

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
  /**
   * Rohes Berührungs-Ereignis, durchgereicht an den Knopf.
   *
   * Für Vorbereitungen, die schon beim Aufsetzen laufen müssen — etwa das
   * Anlegen einer GPU-Ebene, deren Aufbau nicht in den Start einer Bewegung
   * fallen darf.
   */
  onTouchStart?: () => void;
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

/**
 * Bo, klein und statisch.
 *
 * Die Silhouette ist NICHT nachgezeichnet, sondern exakt dieselben Pfaddaten wie
 * die große Figur in `components/assistant/Bo.tsx` — Kuppe mit Radius 72, vier
 * Zipfel am Saum. Ein selbst gezeichneter Geist sah daneben immer etwas anders
 * aus; so ist es dieselbe Figur, nur kleiner.
 *
 * Statt die Zahlen auf ein 24er-Raster umzurechnen (und dabei Rundungsfehler
 * einzubauen), steht Bos eigener Bildausschnitt im `viewBox`. Die Augen sind
 * runde Kreise statt der hohen Ellipsen der großen Figur: Auf 18px lesen sich
 * Ellipsen als Schlitze, Kreise als freundlicher Blick.
 *
 * Bewusst NICHT die echte `Bo`-Komponente: Die ist eine vollständige, animierte
 * Figur mit mehreren Endlos-Worklets — für einen Knopf, der dauerhaft im
 * Landingscreen steht, wäre das grotesk teuer.
 *
 * Auf MODULEBENE, nicht in der Komponente: Dort entstünde bei jedem Render ein
 * neuer Komponententyp, und React baut den Teilbaum darunter dann jedes Mal neu
 * auf statt ihn abzugleichen.
 */
function BoMark() {
  return (
    <Svg width={19} height={19} viewBox="20 42 160 188">
      {/* Körper — 1:1 aus Bo.tsx: Kuppe (A 72 72) und vier Zipfel (Q). */}
      <Path
        d="M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z"
        fill={COLORS.black}
      />
      {/* Augen: an Bos Position (cx 76/124), rund statt hoch-oval. */}
      <Circle cx="76" cy="120" r="15" fill="#FFFFFF" />
      <Circle cx="124" cy="120" r="15" fill="#FFFFFF" />
      {/* Die kleinen Glanzpunkte machen den Blick weich — dieselbe Idee wie bei
          der großen Figur, nur größer im Verhältnis, damit sie hier trägt. */}
      <Circle cx="82" cy="113" r="5" fill={COLORS.black} opacity={0.55} />
      <Circle cx="130" cy="113" r="5" fill={COLORS.black} opacity={0.55} />
    </Svg>
  );
}

export function SearchBar(props: Props) {
  const palette = usePalette();
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
      {/* Bo als Symbol — kein Standard-Geist aus dem Symbolsatz.
          Der hatte die Strichstärke und die nüchterne Form aller anderen Symbole
          und las sich damit als „irgendein Piktogramm". Dieser hier ist eine
          gefüllte Silhouette mit Zipfelsaum und großen Augen, also erkennbar
          dieselbe Figur, die im Chat antwortet. */}
      <BoMark />
    </RippleTouch>
  ) : null;

  if (isInput) {
    return (
      <View style={[styles.bar, { backgroundColor: palette.s2 }, style]}>
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
      style={[styles.bar, { backgroundColor: palette.s2 }, style]}
      onPress={props.onPress ?? (() => router.navigate("/search"))}
      onTouchStart={"onTouchStart" in props ? props.onTouchStart : undefined}
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

const styles = scaledStyles({
  bar: {
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
