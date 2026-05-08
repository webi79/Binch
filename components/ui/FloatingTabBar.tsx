import { useRouter, useSegments } from "expo-router";
import { View, Pressable, StyleSheet, useWindowDimensions } from "react-native";
import { Home, Tag, Calendar, User, type LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useEffect, useRef } from "react";
import { haptic } from "@/lib/haptics";
import { useSearchStore } from "@/stores/searchStore";
import { GradientFill } from "@/components/ui/GradientFill";

const C = {
  lime: "#7FEA4D",
  black: "#000000",
  bar: "#242425",
  gray2: "#8A8A90",
};

type TabKey = "index" | "surroundings" | "saved" | "settings";

const TAB_ROUTES: { key: TabKey; path: string; Icon: LucideIcon }[] = [
  { key: "index", path: "/(tabs)", Icon: Home },
  { key: "surroundings", path: "/(tabs)/surroundings", Icon: Tag },
  { key: "saved", path: "/(tabs)/saved", Icon: Calendar },
  { key: "settings", path: "/(tabs)/settings", Icon: User },
];

const CIRCLE_SIZE = 52;
const BAR_PAD_TOP = 6;

export function FloatingTabBar() {
  const router = useRouter();
  const segments = useSegments();
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const closeSearchOverlay = useSearchStore((s) => s.closeSearchOverlay);

  const last = segments[segments.length - 1] ?? "";
  const tabFromSegment: TabKey | null =
    last === "surroundings" ? "surroundings"
    : last === "saved" ? "saved"
    : last === "settings" ? "settings"
    : segments.includes("(tabs)") ? "index"
    : null;

  const lastTabRef = useRef<TabKey>("index");
  if (tabFromSegment) lastTabRef.current = tabFromSegment;
  const activeTab = tabFromSegment ?? lastTabRef.current;
  const activeIndex = TAB_ROUTES.findIndex((r) => r.key === activeTab);

  const slotWidth = screenWidth / TAB_ROUTES.length;
  const circleX = useSharedValue(activeIndex * slotWidth + (slotWidth - CIRCLE_SIZE) / 2);

  useEffect(() => {
    circleX.value = withSpring(
      activeIndex * slotWidth + (slotWidth - CIRCLE_SIZE) / 2,
      { damping: 18, stiffness: 180, mass: 0.6 }
    );
  }, [activeIndex, slotWidth, circleX]);

  const circleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: circleX.value }],
  }));

  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      <View style={[styles.bar, { paddingBottom: insets.bottom + 6 }]}>
        <Animated.View
          pointerEvents="none"
          style={[styles.activeCircle, circleStyle]}
        >
          <GradientFill />
        </Animated.View>
        {TAB_ROUTES.map(({ key, path, Icon }, idx) => {
          const focused = idx === activeIndex;
          return (
            <Pressable
              key={key}
              onPress={() => {
                haptic("button");
                closeSearchOverlay();
                router.navigate(path as never);
              }}
              style={styles.slot}
            >
              <Icon
                size={22}
                color={focused ? C.black : C.gray2}
                fill="transparent"
                strokeWidth={focused ? 2.6 : 1.8}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    backgroundColor: C.bar,
    paddingTop: BAR_PAD_TOP,
  },
  slot: {
    flex: 1,
    height: CIRCLE_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  activeCircle: {
    position: "absolute",
    top: BAR_PAD_TOP,
    left: 0,
    width: CIRCLE_SIZE,
    height: CIRCLE_SIZE,
    borderRadius: CIRCLE_SIZE / 2,
    overflow: "hidden",
  },
});
