/**
 * „Suchverlauf löschen?"-Dialog (Halo-Variante).
 *
 * Roter Halo um's Alert-Icon = destruktive Aktion. Lime-CTA bestätigt,
 * Ghost-Text-Button bricht ab. Wird in [components/home/RecentHistoryOverlay.tsx]
 * angesteuert wenn der User auf den Trash-Button im Recent-History-Sheet
 * tappt — ersetzt den vorherigen generischen `showAlert` durch ein App-
 * eigenes Modal das visuell zum Binch-Designsystem passt.
 *
 * Tokens kommen aus der App-Palette ([CLAUDE.md] brand.lime/brand.dark
 * plus die surface-Tiers aus den anderen Overlays). Destructive-Red ist
 * `#E5484D` — gleicher Wert wie der Trash-Button in der einzelnen
 * RecentCard-Swipe-Action, damit die destruktive Farb-Sprache konsistent
 * bleibt.
 */
import React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn, ZoomOut } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

const tokens = {
  surface2: "#242425",
  border: "rgba(255,255,255,0.08)",
  white: "#FFFFFF",
  gray200: "#C8C8CC",
  gray300: "#8A8A90",
  // Brand-Lime aus dem App-Theme (tailwind.config.js brand.lime).
  lime: "#7FEA4D",
  textOnLime: "#000000",
  scrim: "rgba(0,0,0,0.55)",
  // Destructive-Akzent — exakt der gleiche Wert wie der RecentCard-Swipe-
  // Trash-Button damit die destruktive Farbsprache konsistent bleibt.
  danger: "#E5484D",
} as const;

export interface ClearSearchHistoryAlertProps {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function ClearSearchHistoryAlert({
  visible,
  onCancel,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
}: ClearSearchHistoryAlertProps) {
  const accent = useAccent();
  const palette = usePalette();
  function handleConfirm() {
    haptic("important");
    onConfirm();
  }
  function handleCancel() {
    haptic("button");
    onCancel();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={handleCancel}
      statusBarTranslucent
    >
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(140)}
        style={styles.scrim}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Dialog schließen"
          onPress={handleCancel}
        />
        <Animated.View
          entering={ZoomIn.duration(200)}
          exiting={ZoomOut.duration(140)}
          style={styles.cardWrap}
        >
          {/* Inner Pressable schluckt Taps damit das Tap auf die Card nicht
              das Scrim-onPress (= Schließen) triggert. */}
          <Pressable style={[styles.card, { backgroundColor: palette.s2 }]} onPress={() => {}}>
            {/* Roter Solid-Kreis um's Icon — bewusst KEIN gefadeter Halo,
                ein einziger satter Kreis im Destructive-Rot. */}
            <View style={styles.iconCircle}>
              <AlertIcon />
            </View>

            <Text style={styles.title} maxFontSizeMultiplier={1.4}>
              {title}
            </Text>
            <Text style={styles.message} maxFontSizeMultiplier={1.5}>
              {message}
            </Text>

            {/* Primary CTA — gleiche Style-Struktur wie der „Zur Suche"-Button
                im ConnectionNotFoundModal: außen View mit Lime-bg, innen
                Pressable mit Touch+Padding. Hintergrund am View-Wrapper (nicht
                am Pressable selbst) weil React-Native auf Android einen Edge-
                Case hat wo backgroundColor in Pressable-style-functions nicht
                gerendert wird. */}
            <View style={[styles.primaryButton, { backgroundColor: accent.solid }]}>
              <Pressable
                onPress={handleConfirm}
                android_ripple={{ color: "rgba(0,0,0,0.15)" }}
                style={styles.primaryButtonTouch}
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
              >
                <Text style={[styles.primaryButtonLabel, { color: accent.textOnSolid }]}>{confirmLabel}</Text>
              </Pressable>
            </View>

            <View style={styles.secondaryButton}>
              <Pressable
                onPress={handleCancel}
                style={styles.secondaryButtonTouch}
                accessibilityRole="button"
                accessibilityLabel={cancelLabel}
              >
                <Text style={styles.secondaryButtonLabel}>{cancelLabel}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function AlertIcon() {
  // Weiße Outline + Ausrufezeichen weil der Hintergrund (iconCircle) jetzt
  // ein sattes Rot ist — Weiß auf Rot ist die maximal-kontrastige Variante.
  return (
    <Svg
      width={32}
      height={32}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tokens.white}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 8v4" />
      <Path d="M12 16h.01" />
    </Svg>
  );
}

const styles = scaledStyles({
  scrim: {
    flex: 1,
    backgroundColor: tokens.scrim,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  cardWrap: { width: "100%", maxWidth: 360 },
  card: {
    backgroundColor: tokens.surface2,
    borderColor: tokens.border,
    borderWidth: 1,
    borderRadius: 28,
    paddingTop: 28,
    paddingHorizontal: 22,
    paddingBottom: 18,
    alignItems: "center",
  },

  // Solider roter Kreis ums Icon (KEIN Halo). Größe so dass das 32px-Icon
  // mit ordentlich Air drumherum sitzt.
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: tokens.danger,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
    marginTop: 4,
  },

  title: {
    fontSize: 21,
    fontWeight: "800",
    letterSpacing: -0.6,
    color: tokens.white,
    textAlign: "center",
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    lineHeight: 21,
    color: tokens.gray300,
    textAlign: "center",
    paddingHorizontal: 6,
    marginBottom: 22,
  },

  // Primary-CTA — Style 1:1 wie der „Zur Suche"-Button im
  // ConnectionNotFoundModal: Lime-bg, borderRadius 16, fontSize 17, schwarzer
  // Text. Wrapper-View mit bg + inner Pressable-Touch (Android-bg-Edge-Case).
  // backgroundColor inline mit accent.solid gesetzt.
  primaryButton: {
    borderRadius: 16,
    alignSelf: "stretch",
    marginTop: 4,
    marginBottom: 4,
    overflow: "hidden",
  },
  primaryButtonTouch: {
    paddingVertical: 17,
    paddingHorizontal: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonLabel: {
    fontSize: 17,
    fontWeight: "700",
    color: tokens.textOnLime,
    textAlign: "center",
  },

  secondaryButton: { alignSelf: "stretch" },
  secondaryButtonTouch: {
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: tokens.gray200,
    textAlign: "center",
  },
});
