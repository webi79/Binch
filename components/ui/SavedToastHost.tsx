import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeInUp, FadeOutDown, FadeOutUp } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BookmarkCheck } from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";

// Farb-Palette: matched die Card-Farben aus ResultCard (`surface2 #242425`,
// `border #2E2E30`) und die Brand-Lime aus dem Rest der App (`#7FEA4D`).
// Bewusst NICHT die neonige Lime `#D4FF3F` aus dem Design-Mockup übernommen
// — die kollidiert mit den Result-Card-Akzenten an anderen Stellen.
const C = {
  surface: "#242425",
  border: "#2E2E30",
  white: "#FFFFFF",
  gray300: "#8A8A90",
  lime: "#7FEA4D",
  black: "#0A0A0A",
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
  const clearSelectedResult = useSearchStore((s) => s.clearSelectedResult);
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
    // Navigation ZUERST: Tab-Wechsel + SavedScreen-Mount + FloatingTabBar-
    // Indicator-Slide bekommen einen ungestörten Render-Commit.
    router.navigate("/(tabs)/saved");
    // DetailsOverlay-Clear erst im NÄCHSTEN Frame — sonst kämpft das
    // DetailsContent-Unmount mit der Tab-Switch-Arbeit im selben Commit
    // (= Stutter im Indicator + Saved-Screen-Layout-Jitter). 2 RAFs gibt
    // dem nativen Layout-Pass Zeit zu settlen bevor wir Details rausnehmen.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => clearSelectedResult());
    });
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
          {/* Lime-Badge mit Bookmark+Check-Icon — visuelles Anchor für „etwas
              wurde abgespeichert". 44×44 wie im Design-Mockup, harmoniert mit
              dem 28×28 Provider-Logo der Result-Cards (größer weil Toast eine
              Notification ist, kein In-Content-Element). */}
          <View style={styles.iconBadge}>
            <BookmarkCheck size={22} color={C.black} strokeWidth={2.2} />
          </View>

          <View style={styles.textCol}>
            <Text style={styles.title} numberOfLines={1}>
              {t("toast.saved.title")}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              <Text style={styles.from}>{t("results.from")} </Text>
              <Text style={styles.price}>
                {toast.price.toFixed(0)} {toast.currency.toUpperCase()}
              </Text>
            </Text>
          </View>

          <Pressable
            onPress={onView}
            hitSlop={10}
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={t("toast.saved.view")}
          >
            <Text style={styles.ctaLabel}>{t("toast.saved.view")}</Text>
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
    backgroundColor: C.surface,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 12,
    gap: 12,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.lime,
    alignItems: "center",
    justifyContent: "center",
  },
  textCol: { flex: 1, minWidth: 0 },
  title: {
    color: C.white,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.15,
    lineHeight: 18,
  },
  meta: {
    color: C.gray300,
    fontSize: 13,
    fontWeight: "500",
    marginTop: 3,
  },
  from: { color: C.gray300, fontSize: 13, fontWeight: "500" },
  price: { color: C.lime, fontSize: 13, fontWeight: "700" },
  cta: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  ctaLabel: {
    color: C.white,
    fontWeight: "700",
    fontSize: 14,
    letterSpacing: -0.14,
    textDecorationLine: "underline",
  },
});
