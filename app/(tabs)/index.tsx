import { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StatusBar,
  StyleSheet,
  ImageBackground,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Bell,
  Plane,
  Train,
  Bus,
  Ship,
  Heart,
  ChevronDown,
  ChevronUp,
  type LucideIcon,
} from "lucide-react-native";
import { SearchBar } from "@/components/SearchBar";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { RecentCard } from "@/components/home/RecentCard";
import { useSearchStore } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";

// === Design Tokens ============================================================
const C = {
  bg: "#1A1A1A",
  surface1: "#1F1F20",
  surface2: "#242425",
  surface3: "#2A2A2C",
  border: "#2E2E30",
  lime: "#7FEA4D",
  limePressed: "#3ED35A",
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  gray3: "#56565C",
  black: "#000000",
};

const FONT = {
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
  extrabold: "800" as const,
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

type CategoryId = "ocean" | "mountain" | "forest" | "city";

interface Destination {
  id: string;
  city: string;
  country: string;
  priceFrom: number;
  currency: string;
  imageUrl: string;
  popular?: boolean;
  mode: TravelMode;
}

const DESTINATIONS: Destination[] = [
  {
    id: "ny",
    city: "New York",
    country: "USA",
    priceFrom: 456,
    currency: "USD",
    imageUrl: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=900&q=80",
    popular: true,
    mode: "FLIGHT",
  },
  {
    id: "tenerife",
    city: "Teneriffa",
    country: "Spanien",
    priceFrom: 89,
    currency: "EUR",
    imageUrl: "https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=900&q=80",
    popular: true,
    mode: "FLIGHT",
  },
  {
    id: "bangkok",
    city: "Bangkok",
    country: "Thailand",
    priceFrom: 598,
    currency: "EUR",
    imageUrl: "https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=900&q=80",
    mode: "FLIGHT",
  },
  {
    id: "berlin",
    city: "Berlin",
    country: "Deutschland",
    priceFrom: 29,
    currency: "EUR",
    imageUrl: "https://images.unsplash.com/photo-1587330979470-3016b6702d89?w=900&q=80",
    mode: "TRAIN",
  },
];

// === Subcomponents ============================================================

function Header() {
  return (
    <View style={styles.headerRow}>
      <Text style={styles.logoHeading}>
        B<Text style={styles.logoAccent}>i</Text>nch
      </Text>
      <RippleTouch
        style={styles.bell}
        hitSlop={6}
        accessibilityLabel="Notifications"
        borderless
      >
        <Bell size={19} color={C.white} />
        <View style={styles.bellDot} />
      </RippleTouch>
    </View>
  );
}

const TRANSPORT: { id: TravelMode; labelKey: string; icon: LucideIcon }[] = [
  { id: "FLIGHT", labelKey: "mode.flights", icon: Plane },
  { id: "TRAIN", labelKey: "mode.trains", icon: Train },
  { id: "BUS", labelKey: "mode.buses", icon: Bus },
  { id: "CRUISE", labelKey: "mode.cruises", icon: Ship },
];

function TransportTabs() {
  const t = useT();
  const active = useSearchStore((s) => s.activeMode);
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);

  return (
    <View style={styles.tabsRow}>
      {TRANSPORT.map(({ id, labelKey, icon: Icon }) => {
        const on = active === id;
        return (
          <RippleTouch
            key={id}
            style={[styles.tab, { backgroundColor: on ? "transparent" : C.surface2 }]}
            onPress={() => {
              haptic("button");
              openSearchOverlay(id);
            }}
          >
            {on && <GradientFill />}
            <Icon size={24} color={on ? C.black : C.white} strokeWidth={1.8} />
            <Text
              numberOfLines={1}
              style={[styles.tabLabel, { color: on ? C.black : C.white, fontWeight: on ? "700" : "600" }]}
            >
              {t(labelKey)}
            </Text>
          </RippleTouch>
        );
      })}
    </View>
  );
}

function SectionHeaderSmall({ title, onViewAll }: { title: string; onViewAll?: () => void }) {
  const t = useT();
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitleSmall}>{title}</Text>
      <Pressable hitSlop={8} onPress={onViewAll}>
        <Text style={styles.actionLink}>{t("home.viewall")}</Text>
      </Pressable>
    </View>
  );
}

const CATEGORIES: { id: CategoryId; labelKey: string }[] = [
  { id: "ocean", labelKey: "home.category.beach" },
  { id: "mountain", labelKey: "home.category.mountain" },
  { id: "forest", labelKey: "home.category.nature" },
  { id: "city", labelKey: "home.category.city" },
];

function CategoryChips({ value, onChange }: { value: CategoryId; onChange: (id: CategoryId) => void }) {
  const t = useT();
  return (
    <View style={styles.chipsRow}>
      {CATEGORIES.map((it) => {
        const on = value === it.id;
        return (
          <RippleTouch
            key={it.id}
            style={[styles.chip, { backgroundColor: on ? "transparent" : C.surface2 }]}
            onPress={() => {
              haptic("button");
              onChange(it.id);
            }}
          >
            {on && <GradientFill />}
            <Text
              style={[
                styles.chipLabel,
                { color: on ? C.black : C.white, fontWeight: on ? "700" : "600" },
              ]}
            >
              {t(it.labelKey)}
            </Text>
          </RippleTouch>
        );
      })}
    </View>
  );
}

const HEART_RED = "#FF3B5C";

function DestinationCard({ d }: { d: Destination }) {
  const t = useT();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  const favoriteIds = useSearchStore((s) => s.favoriteResultIds);
  const toggleFavorite = useSearchStore((s) => s.toggleFavorite);
  const saved = favoriteIds.includes(d.id);

  const scale = useSharedValue(1);
  const cardAnim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handleLike = (e: { stopPropagation?: () => void }) => {
    e.stopPropagation?.();
    haptic("button");
    const justSaved = !saved;
    toggleFavorite(d.id);
    if (justSaved) {
      scale.value = withSequence(
        withTiming(0.92, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 320, easing: Easing.elastic(1.5) })
      );
    }
  };

  return (
    <Animated.View style={cardAnim}>
      <RippleTouch
        style={styles.card}
        onPress={() => {
          haptic("button");
          openSearchOverlay(d.mode);
        }}
      >
        <ImageBackground
          source={{ uri: d.imageUrl }}
          style={styles.cardBg}
          imageStyle={{ borderRadius: 28 }}
        >
          <LinearGradient
            colors={["rgba(0,0,0,0.05)", "rgba(0,0,0,0.15)", "rgba(0,0,0,0.85)"]}
            locations={[0, 0.45, 1]}
            style={[StyleSheet.absoluteFill, { borderRadius: 28 }]}
          />
          <RippleTouch
            borderless
            hitSlop={8}
            style={styles.heartBtn}
            onPress={handleLike}
          >
            <Heart
              size={18}
              color={saved ? HEART_RED : C.white}
              fill={saved ? HEART_RED : "transparent"}
            />
          </RippleTouch>
          <View style={styles.cardBottom}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={styles.countryPill}>
                <GradientFill />
                <Text style={styles.countryPillText}>{d.country}</Text>
              </View>
              <Text style={styles.cityText} numberOfLines={1}>
                {d.city}
              </Text>
              <Text style={styles.priceLine}>
                {t("home.popular.from")}{" "}
                <Text style={styles.priceValue}>{d.priceFrom}</Text>{" "}
                <Text style={{ color: C.gray1 }}>{d.currency}</Text>
              </Text>
            </View>
            <RippleTouch
              style={styles.cta}
              onPress={(e) => {
                e.stopPropagation?.();
                haptic("important");
                openSearchOverlay(d.mode);
              }}
            >
              <GradientFill />
              <Text style={styles.ctaText}>{t("home.book")}</Text>
            </RippleTouch>
          </View>
        </ImageBackground>
      </RippleTouch>
    </Animated.View>
  );
}

const RECENT_COLLAPSED = 3;
const RECENT_EXPANDED = 8;

// === Screen ===================================================================
export default function HomeScreen() {
  const t = useT();
  const insets = useSafeAreaInsets();
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const openRecentHistoryOverlay = useSearchStore((s) => s.openRecentHistoryOverlay);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [category, setCategory] = useState<CategoryId>("ocean");
  const visibleRecents = recentSearches.slice(
    0,
    recentExpanded ? RECENT_EXPANDED : RECENT_COLLAPSED
  );
  const canExpand = recentSearches.length > RECENT_COLLAPSED;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 8 }]}
        showsVerticalScrollIndicator={false}
      >
          <Header />
          <SearchBar style={styles.searchBarSpacing} />
          <TransportTabs />

          {recentSearches.length > 0 && (
            <View style={styles.recentSection}>
              <SectionHeaderSmall
                title={t("home.recent.title")}
                onViewAll={() => {
                  haptic("button");
                  openRecentHistoryOverlay();
                }}
              />
              {visibleRecents.map((s, idx) =>
                idx < RECENT_COLLAPSED ? (
                  <RecentCard key={s.id} search={s} />
                ) : (
                  <Animated.View
                    key={s.id}
                    entering={FadeInDown.duration(220)}
                    exiting={FadeOutUp.duration(180)}
                  >
                    <RecentCard search={s} />
                  </Animated.View>
                )
              )}
              {canExpand && (
                <Animated.View layout={LinearTransition.duration(220)}>
                  <RippleTouch
                    style={styles.recentToggle}
                    onPress={() => {
                      haptic("button");
                      setRecentExpanded((v) => !v);
                    }}
                  >
                    <Text style={styles.recentToggleText}>
                      {recentExpanded ? t("home.recent.showLess") : t("home.recent.showMore")}
                    </Text>
                    {recentExpanded ? (
                      <ChevronUp size={14} color={C.lime} strokeWidth={2.5} />
                    ) : (
                      <ChevronDown size={14} color={C.lime} strokeWidth={2.5} />
                    )}
                  </RippleTouch>
                </Animated.View>
              )}
            </View>
          )}

          <Animated.View layout={LinearTransition.duration(220)}>
            <View style={styles.popularHeader}>
              <Text style={styles.sectionTitle}>{t("home.destinations.title")}</Text>
              <Pressable hitSlop={8}>
                <Text style={styles.actionLink}>{t("home.viewall")}</Text>
              </Pressable>
            </View>
            <CategoryChips value={category} onChange={setCategory} />
            <View style={{ height: 14 }} />
            {DESTINATIONS.map((d) => (
              <DestinationCard key={d.id} d={d} />
            ))}
          </Animated.View>
      </ScrollView>
    </View>
  );
}

// === Styles ===================================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 130 },

  // Header
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingTop: 8,
    paddingBottom: 14,
  },
  logoHeading: { fontSize: 26, fontWeight: "900", letterSpacing: -0.6, color: C.white },
  logoAccent: { color: C.lime },
  bell: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  bellDot: {
    position: "absolute",
    top: 9,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#B6F44A",
    borderWidth: 2,
    borderColor: C.surface2,
  },

  // SearchBar spacing
  searchBarSpacing: { marginHorizontal: 22, marginBottom: 12 },

  // Transport tabs
  tabsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
  tab: {
    flex: 1,
    borderRadius: 22,
    paddingVertical: 14,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  tabLabel: { fontSize: 12, letterSpacing: -0.1 },

  // Recent
  recentSection: { paddingTop: 18, paddingBottom: 4 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 12,
    paddingHorizontal: 22,
  },
  sectionTitleSmall: {
    fontSize: 20,
    fontWeight: FONT.bold,
    color: C.white,
    letterSpacing: -0.5,
  },
  actionLink: { fontSize: 13, fontWeight: FONT.semibold, color: C.lime },

  recentToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 12,
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 8,
    borderRadius: 16,
  },
  recentToggleText: { fontSize: 13, fontWeight: FONT.semibold, color: C.lime },

  // Popular header
  popularHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 22,
    paddingTop: 20,
    paddingBottom: 14,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: FONT.bold,
    color: C.white,
    letterSpacing: -0.5,
  },

  // Category chips
  chipsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 22,
    paddingTop: 4,
    paddingBottom: 4,
  },
  chip: {
    flex: 1,
    borderRadius: 9999,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  chipLabel: { fontSize: 13, letterSpacing: -0.1 },

  // Destination card
  card: {
    marginHorizontal: 22,
    marginBottom: 16,
    borderRadius: 28,
    overflow: "hidden",
    height: 320,
    backgroundColor: C.surface2,
  },
  cardBg: { flex: 1, justifyContent: "flex-end" },
  heartBtn: {
    position: "absolute",
    top: 14,
    right: 14,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(20,20,20,0.55)",
    alignItems: "center",
    justifyContent: "center",
  },
  cardBottom: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: 12,
    padding: 18,
  },
  countryPill: {
    alignSelf: "flex-start",
    borderRadius: 9999,
    paddingVertical: 4,
    paddingHorizontal: 9,
    marginBottom: 8,
    overflow: "hidden",
  },
  countryPillText: {
    fontSize: 10,
    fontWeight: FONT.bold,
    color: C.black,
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  cityText: {
    fontSize: 26,
    fontWeight: FONT.bold,
    color: C.white,
    letterSpacing: -0.78,
    lineHeight: 28,
    textShadowColor: "rgba(0,0,0,0.45)",
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 2 },
  },
  priceLine: { fontSize: 13, color: C.gray1, marginTop: 6 },
  priceValue: { color: C.lime, fontSize: 16, fontWeight: FONT.extrabold },
  cta: {
    borderRadius: 9999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    overflow: "hidden",
  },
  ctaText: { fontSize: 13, fontWeight: FONT.bold, color: C.black, letterSpacing: -0.13 },
});
