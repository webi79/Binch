import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";

const C = {
  bg: "#161617",
  border: "#2A2A2C",
  text: "#FFFFFF",
  sub: "#8A8A90",
  lime: "#7FEA4D",
};

const AUTO_DISMISS_MS = 3500;

export function SavedToastHost() {
  const toast = useSearchStore((s) => s.savedToast);
  const position = useSearchStore((s) => s.savedToastPosition);

  if (!toast) return null;
  return <Toast key={toast.key} position={position} />;
}

function Toast({ position }: { position: "top" | "bottom" }) {
  const toast = useSearchStore((s) => s.savedToast);
  const hide = useSearchStore((s) => s.hideSavedToast);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const timer = setTimeout(hide, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [hide]);

  if (!toast) return null;

  const onView = () => {
    haptic("button");
    hide();
    router.navigate("/(tabs)/saved");
  };

  const Entering = position === "top" ? FadeInUp : FadeInDown;
  const Exiting = position === "top" ? FadeOutUp : FadeOutDown;

  const containerStyle = [
    styles.container,
    position === "top"
      ? { top: insets.top + 10 }
      : { bottom: insets.bottom + 96 },
  ];

  return (
    <View pointerEvents="box-none" style={[StyleSheet.absoluteFillObject, styles.host]}>
      <Animated.View
        entering={Entering.duration(280)}
        exiting={Exiting.duration(220)}
        style={containerStyle}
      >
        <View style={styles.toast}>
          <View style={styles.textCol}>
            <Text style={styles.title} numberOfLines={1}>
              {t("toast.saved.title")}
            </Text>
            <Text style={styles.priceLine} numberOfLines={1}>
              <Text style={styles.from}>{t("results.from")} </Text>
              <Text style={styles.price}>
                {toast.price.toFixed(0)} {toast.currency.toUpperCase()}
              </Text>
            </Text>
          </View>
          <Pressable onPress={onView} hitSlop={10} style={styles.viewBtn}>
            <Text style={styles.viewText}>{t("toast.saved.view")}</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { zIndex: 1000 },
  container: {
    position: "absolute",
    left: 16,
    right: 16,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  textCol: { flex: 1, minWidth: 0 },
  title: {
    color: C.text,
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  priceLine: { marginTop: 2 },
  from: { color: C.sub, fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  price: { color: C.lime, fontSize: 14, fontWeight: "800", letterSpacing: -0.2 },
  viewBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  viewText: {
    color: C.text,
    fontSize: 14,
    fontWeight: "700",
    textDecorationLine: "underline",
  },
});
