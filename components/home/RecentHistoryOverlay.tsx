import { useEffect } from "react";
import {
  StyleSheet,
  View,
  BackHandler,
  Platform,
  ScrollView,
  Text,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { showAlert } from "@/lib/alert";
import Animated, {
  FadeIn,
  FadeOut,
  SlideInDown,
  SlideOutDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Trash2 } from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { RecentCard } from "@/components/home/RecentCard";

/**
 * Bottom-sheet overlay showing the full recent-search history.
 * Visual styling mirrors AddTicketModal: dimmed backdrop, dark sheet
 * (#1F1F20) with 28px top radius, drag-handle indicator, tap backdrop
 * to dismiss. Sheet height locked to width:height = 1:1.168 aspect ratio.
 */
export function RecentHistoryOverlay() {
  const open = useSearchStore((s) => s.recentHistoryOverlayOpen);
  if (!open) return null;
  return <RecentHistorySheet />;
}

function RecentHistorySheet() {
  const close = useSearchStore((s) => s.closeRecentHistoryOverlay);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const t = useT();
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const translateY = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const sheetHeight = width * 1.168;
  const sheetTop = Math.max(0, height - sheetHeight);

  const panGesture = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetY(-8)
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 700) {
        translateY.value = withTiming(sheetHeight, { duration: 220 });
        runOnJS(close)();
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
      }
    });

  const handleClear = () => {
    haptic("button");
    if (recentSearches.length === 0) return;
    showAlert(
      t("home.recent.clear.title"),
      t("home.recent.clear.body"),
      [
        { text: t("home.recent.clear.cancel"), style: "cancel" },
        {
          text: t("home.recent.clear.confirm"),
          style: "destructive",
          onPress: () => {
            haptic("important");
            clearRecentSearches();
            close();
          },
        },
      ]
    );
  };

  return (
    <View style={StyleSheet.absoluteFillObject}>
      <Animated.View
        entering={FadeIn.duration(250)}
        exiting={FadeOut.duration(200)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <Animated.View
        entering={SlideInDown.duration(350)}
        exiting={SlideOutDown.duration(350)}
        style={[styles.sheet, sheetAnim, { top: sheetTop }]}
      >
        <GestureDetector gesture={panGesture}>
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
        </GestureDetector>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t("home.recent.title")}</Text>
          <Pressable
            onPress={handleClear}
            hitSlop={10}
            disabled={recentSearches.length === 0}
            style={({ pressed }) => [
              styles.trashBtn,
              { opacity: recentSearches.length === 0 ? 0.35 : pressed ? 0.6 : 1 },
            ]}
            accessibilityLabel={t("home.recent.clear.title")}
          >
            <Trash2 size={20} color="#FF3B5C" strokeWidth={2} />
          </Pressable>
        </View>
        <Text style={styles.subtitle}>{t("home.recent.subtitle")}</Text>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {recentSearches.map((s) => (
            <RecentCard key={s.id} search={s} bordered />
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1F1F20",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 40,
  },
  handleWrap: { alignItems: "center", paddingTop: 12, paddingBottom: 16 },
  handle: { width: 40, height: 4, borderRadius: 9999, backgroundColor: "#FFFFFF" },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 6,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#FFFFFF",
    flex: 1,
  },
  trashBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#131313",
  },
  subtitle: {
    fontSize: 13,
    color: "#8A8A90",
    marginBottom: 18,
    lineHeight: 18,
    paddingHorizontal: 20,
  },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
});
