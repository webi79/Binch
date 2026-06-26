/**
 * „Verbindung nicht gefunden"-Modal mit Papierflieger-Illustration.
 *
 * Globally mounted in app/_layout.tsx — getriggert via
 * `showConnectionNotFound()` aus lib/connectionNotFoundAlert.ts.
 *
 * Ersetzt den vorherigen generischen showAlert-Dialog für diesen spezifischen
 * Fall (Stop-Tap matched keine buchbare Verbindung). Eigener Modal weil's
 * eine Illustration + zwei klare CTAs braucht statt einer Button-Liste.
 */
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import Svg, { Circle, Defs, G, Path, RadialGradient, Stop } from "react-native-svg";
import { useConnectionNotFoundStore } from "@/lib/connectionNotFoundAlert";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";

// Binch v2 Design-Tokens — sind aus app-internem Theme abgeleitet (tailwind
// brand.lime = #7FEA4D, brand.dark = #1A1A1A). Wir halten sie hier lokal
// damit das Modal self-contained bleibt.
const tokens = {
  surface2: "#242425",
  borderSoft: "rgba(255,255,255,0.08)",
  scrim: "rgba(0,0,0,0.55)",
  lime: "#7FEA4D",
  limePressed: "#3ED35A",
  limeSubtle: "rgba(127,234,77,0.18)",
  textPrimary: "#FFFFFF",
  textSecondary: "#C8C8CC",
  bg: "#1A1A1A",
} as const;

/** Papierflieger mit Akzent-Farbe + gestrichelter Flugbahn. SVG damit's auf
 *  allen Display-Densities scharf bleibt — kein PNG-Asset nötig. Akzent
 *  kommt via prop damit Hook-Aufruf nur auf Top-Level passiert. */
const PaperPlaneIllustration: React.FC<{ size?: number; color: string }> = ({ size = 104, color }) => {
  const w = size;
  const h = size * 0.75;
  return (
    <Svg width={w} height={h} viewBox="0 0 160 120" fill="none">
      <Path
        d="M 12 96 C 28 86, 42 92, 50 80 S 68 56, 84 60 S 108 78, 120 64"
        stroke={color}
        strokeWidth={2}
        strokeDasharray="3 5"
        strokeLinecap="round"
        opacity={0.7}
      />
      <G transform="translate(112 44) rotate(-22)">
        <Path
          d="M 0 14 L 32 0 L 22 14 L 32 28 Z"
          fill={color}
          stroke={tokens.bg}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        <Path d="M 22 14 L 0 14" stroke={tokens.bg} strokeWidth={1.5} />
      </G>
      <Circle cx={22} cy={36} r={2} fill={color} opacity={0.5} />
      <Circle cx={142} cy={22} r={1.6} fill={color} opacity={0.4} />
      <Circle cx={60} cy={22} r={1.4} fill="#FFFFFF" opacity={0.3} />
    </Svg>
  );
};

const IllustrationHalo: React.FC<{ color: string }> = ({ color }) => (
  <View style={styles.haloWrap} pointerEvents="none">
    <Svg width={96} height={96} viewBox="0 0 96 96">
      <Defs>
        <RadialGradient id="halo" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <Stop offset="100%" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={48} cy={48} r={48} fill="url(#halo)" />
    </Svg>
  </View>
);

export function ConnectionNotFoundHost(): React.ReactElement {
  const visible = useConnectionNotFoundStore((s) => s.visible);
  const mode = useConnectionNotFoundStore((s) => s.mode);
  const onSearchCallback = useConnectionNotFoundStore((s) => s.onSearch);
  const customTitle = useConnectionNotFoundStore((s) => s.title);
  const customMessage = useConnectionNotFoundStore((s) => s.message);
  const dismiss = useConnectionNotFoundStore((s) => s.dismiss);
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  const activeMode = useSearchStore((s) => s.activeMode);
  const clearSelectedStop = useSearchStore((s) => s.clearSelectedStop);
  const t = useT();
  const accent = useAccent();

  const title = customTitle ?? t("connectionNotFound.title");
  const message = customMessage ?? t("connectionNotFound.body");

  const handleSearch = () => {
    haptic("button");
    dismiss();
    // Stop-Detail-Sheet schließen falls offen — sonst bleibt's hinter dem
    // Search-Hero stehen und scheint nach dem User-Tap noch davor sichtbar.
    clearSelectedStop();
    if (onSearchCallback) {
      onSearchCallback();
      return;
    }
    // Default: Search-Hero öffnen, vor-gefiltert auf den Mode der das Modal
    // ausgelöst hat (z.B. User tappte einen Bus → Bus-Suche). Falls kein
    // Mode mitkam, nehmen wir den Store-aktiven Mode (was eh meistens passt).
    openSearchOverlay(mode ?? activeMode);
  };

  const handleClose = () => {
    haptic("button");
    dismiss();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Dialog schließen"
          onPress={handleClose}
        />
        <Animated.View
          // „Aufplop"-Animation: leichtes Zoom-In von 0.92 → 1.0, kein
          // Spring-Bounce (sieht sonst gummi-artig aus). 200ms easeOut für
          // ein knackiges Auftauchen, 140ms beim Schließen.
          entering={ZoomIn.duration(200)}
          exiting={ZoomOut.duration(140)}
          style={styles.cardWrap}
        >
          {/* Card eat presses so taps inside don't close the modal */}
          <Pressable onPress={() => {}} style={styles.card}>
            <View style={styles.illustrationSlot}>
              <IllustrationHalo color={accent.solid} />
              <View style={styles.illustrationInner}>
                <PaperPlaneIllustration size={104} color={accent.solid} />
              </View>
            </View>

            <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.4}>
              {title}
            </Text>

            <Text style={styles.body} maxFontSizeMultiplier={1.5}>
              {message}
            </Text>

            {/* Primary CTA — als View statt Pressable damit der
                Hintergrund DEFINITIV rendert. Pressable's function-style war
                hier irgendwie tot (auch ohne Pressed-State noch). View +
                onTouch via äußerem Touchable. */}
            <View style={[styles.primaryButton, { backgroundColor: accent.solid }]}>
              <Pressable
                accessibilityRole="button"
                onPress={handleSearch}
                android_ripple={{ color: "rgba(0,0,0,0.15)" }}
                style={styles.primaryButtonTouch}
              >
                <Text style={[styles.primaryButtonLabel, { color: accent.textOnSolid }]}>{t("connectionNotFound.searchCta")}</Text>
              </Pressable>
            </View>

            <View style={styles.secondaryButton}>
              <Pressable
                accessibilityRole="button"
                onPress={handleClose}
                style={styles.secondaryButtonTouch}
              >
                <Text style={styles.secondaryButtonLabel}>{t("connectionNotFound.laterCta")}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: tokens.scrim,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  } as ViewStyle,
  cardWrap: {
    width: "100%",
    maxWidth: 420,
  } as ViewStyle,
  card: {
    backgroundColor: tokens.surface2,
    borderRadius: 28,
    paddingTop: 28,
    paddingHorizontal: 24,
    paddingBottom: 20,
    borderWidth: 1,
    borderColor: tokens.borderSoft,
    alignItems: "stretch",
  } as ViewStyle,
  illustrationSlot: {
    width: 96,
    height: 96,
    alignSelf: "center",
    marginBottom: 12,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  haloWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  illustrationInner: {
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  title: {
    fontSize: 20,
    fontWeight: "700",
    lineHeight: 24,
    letterSpacing: -0.4,
    color: tokens.textPrimary,
    textAlign: "center",
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 21,
    color: tokens.textSecondary,
    textAlign: "center",
    paddingHorizontal: 4,
    marginBottom: 22,
  },
  // Identisch zum „Preise vergleichen"-CTA in SearchHero.tsx — solides Lime,
  // borderRadius 16, paddingVertical 17, centered Text.
  // Background-Color am View-Wrapper (nicht am Pressable) — Pressable hatte
  // einen Edge-Case wo backgroundColor nicht rendert wenn als style-function
  // angegeben. View ist garantiert.
  // backgroundColor inline mit accent.solid am View gesetzt.
  primaryButton: {
    borderRadius: 16,
    alignSelf: "stretch",
    marginTop: 4,
    marginBottom: 4,
    overflow: "hidden",
  } as ViewStyle,
  primaryButtonTouch: {
    paddingVertical: 17,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  primaryButtonLabel: {
    fontSize: 17,
    fontWeight: "700",
    color: "#000",
    textAlign: "center",
  },
  secondaryButton: {
    alignSelf: "stretch",
  } as ViewStyle,
  secondaryButtonTouch: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  } as ViewStyle,
  secondaryButtonLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: tokens.textSecondary,
    textAlign: "center",
  },
});
