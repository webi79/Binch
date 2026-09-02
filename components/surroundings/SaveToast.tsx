/**
 * SaveToast — dunkle Bestätigungs-Karte mit Häkchen, Titel/Untertitel.
 * Fährt von oben ein, bleibt kurz, fährt wieder aus. Farben aus useAccent().
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  visible: boolean;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  duration?: number;
  topOffset?: number;
  onHide?: () => void;
  onAction?: () => void;
}

export function SaveToast({
  visible,
  title,
  subtitle,
  actionLabel,
  duration = 2200,
  topOffset = 64,
  onHide,
  onAction,
}: Props) {
  const accent = useAccent();
  const palette = usePalette();
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;
    Animated.timing(anim, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.back(1.4)),
      useNativeDriver: true,
    }).start();
    const hideTimer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: 260,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => onHide?.());
    }, duration);
    return () => clearTimeout(hideTimer);
  }, [visible, duration, anim, onHide]);

  if (!visible) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.wrap, { top: topOffset, opacity: anim, transform: [{ translateY }] }]}
    >
      {/* Schwebende Meldung — derselbe Ton wie der gespeicherte-Trip-Toast. */}
      <View style={[styles.card, { backgroundColor: palette.s2 }]}>
        <View style={[styles.check, { backgroundColor: accent.solid }]}>
          <Svg width={22} height={22} viewBox="0 0 24 24">
            <Path
              d="M20 6L9 17l-5-5"
              fill="none"
              stroke="#08110C"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        </View>

        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {actionLabel && onAction ? (
          <Pressable onPress={onAction} hitSlop={8}>
            <Text style={styles.action}>{actionLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    </Animated.View>
  );
}

const styles = scaledStyles({
  wrap: { position: "absolute", left: 14, right: 14, zIndex: 50 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: 20,
    backgroundColor: "#171719",
    shadowColor: "#000",
    shadowOpacity: 0.6,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  check: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: { flex: 1, minWidth: 0 },
  title: { color: "#F4F4F5", fontSize: 15, fontWeight: "700", lineHeight: 18 },
  subtitle: { color: "#8E8E93", fontSize: 11, fontWeight: "600", letterSpacing: 0.6, marginTop: 3 },
  action: { color: "#F4F4F5", fontSize: 14, fontWeight: "600", textDecorationLine: "underline" },
});
