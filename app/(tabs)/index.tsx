import { memo, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
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
import { useRouter } from "expo-router";
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
import { RevealScrollView, ScreenEntrance, ScrollReveal } from "@/lib/motion";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { RecentCard } from "@/components/home/RecentCard";
import { useSearchStore } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";

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
  // String = Remote-URL (Unsplash etc.), number = lokales require()-Asset.
  imageUrl: string | number;
  popular?: boolean;
  mode: TravelMode;
}

// Stock-Daten pro Kategorie. Echte Backend-Anbindung folgt — diese Listen
// dienen erstmal nur dazu, das visuelle Verhalten (Slide-Animation,
// Kategorie-Switch) zu simulieren.
const DESTINATIONS_BY_CATEGORY: Record<CategoryId, Destination[]> = {
  ocean: [
    {
      id: "tenerife",
      city: "Teneriffa",
      country: "Spanien",
      priceFrom: 89,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1593693397690-362cb9666fc2?w=900&q=80",
      popular: true,
      mode: "FLIGHT",
    },
    {
      id: "bali",
      city: "Bali",
      country: "Indonesien",
      priceFrom: 612,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "mykonos",
      city: "Mykonos",
      country: "Griechenland",
      priceFrom: 219,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1601581875309-fafbf2d3ed3a?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "maldives",
      city: "Malediven",
      country: "Indischer Ozean",
      priceFrom: 749,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1514282401047-d79a71a590e8?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  mountain: [
    {
      id: "zermatt",
      city: "Zermatt",
      country: "Schweiz",
      priceFrom: 119,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1530122037265-a5f1f91d3b99?w=900&q=80",
      popular: true,
      mode: "TRAIN",
    },
    {
      id: "innsbruck",
      city: "Innsbruck",
      country: "Österreich",
      priceFrom: 69,
      currency: "EUR",
      imageUrl: require("@/assets/destinations/innsbruck.jpg"),
      mode: "TRAIN",
    },
    {
      id: "chamonix",
      city: "Chamonix",
      country: "Frankreich",
      priceFrom: 99,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1551524559-8af4e6624178?w=900&q=80",
      mode: "TRAIN",
    },
    {
      id: "banff",
      city: "Banff",
      country: "Kanada",
      priceFrom: 689,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1561134643-668f9057cce4?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  forest: [
    {
      id: "blackforest",
      city: "Schwarzwald",
      country: "Deutschland",
      priceFrom: 49,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=900&q=80",
      mode: "TRAIN",
    },
    {
      id: "patagonia",
      city: "Patagonien",
      country: "Argentinien",
      priceFrom: 899,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1483683804023-6ccdb62f86ef?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "lapland",
      city: "Lappland",
      country: "Finnland",
      priceFrom: 329,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "costarica",
      city: "Costa Rica",
      country: "Mittelamerika",
      priceFrom: 599,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1518182170546-07661fd94144?w=900&q=80",
      mode: "FLIGHT",
    },
  ],
  city: [
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
      id: "tokyo",
      city: "Tokio",
      country: "Japan",
      priceFrom: 689,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=900&q=80",
      mode: "FLIGHT",
    },
    {
      id: "berlin",
      city: "Berlin",
      country: "Deutschland",
      priceFrom: 29,
      currency: "EUR",
      imageUrl: "https://images.unsplash.com/photo-1560969184-10fe8719e047?w=900&q=80",
      mode: "TRAIN",
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
  ],
};

// === Subcomponents ============================================================

function Header() {
  const accent = useAccent();
  return (
    <View style={styles.headerRow}>
      <Text style={styles.logoHeading}>
        B<Text style={[styles.logoAccent, { color: accent.solid }]}>i</Text>nch
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
  const accent = useAccent();
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitleSmall}>{title}</Text>
      <Pressable hitSlop={8} onPress={onViewAll}>
        <Text style={[styles.actionLink, { color: accent.solid }]}>{t("home.viewall")}</Text>
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

// Unsplash-URLs sind mit w=900 hinterlegt — die Karte ist aber nur ~340px breit
// (×2 für Retina ≈ 700px). RNs Image dekodiert Remote-Bilder in VOLLER Quell-
// Auflösung (kein Auto-Downsampling), d.h. 900px-JPEGs zu dekodieren kostet beim
// Scrollen spürbar. Wir verkleinern die angefragte Breite auf 700 → ~40% weniger
// Pixel zu dekodieren, ohne sichtbaren Schärfeverlust. (Echter Fix wäre expo-image
// mit Disk-Cache + exaktem Downsampling — separate Dependency.)
function sizedImageUrl(url: string): string {
  return url.replace(/([?&]w=)\d+/, "$1700");
}

const DestinationCard = memo(function DestinationCard({ d }: { d: Destination }) {
  const t = useT();
  const accent = useAccent();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  // WICHTIG: selektiv abonnieren — sonst löst JEDER Favorite-Toggle einen
  // Re-Render ALLER DestinationCards aus. Wir interessieren uns nur dafür ob
  // GENAU DIESE Destination gespeichert ist; Zustand's shallow-compare
  // verhindert dann den Re-Render wenn sich nur fremde Favoriten ändern.
  const saved = useSearchStore((s) => s.favoriteResultIds.includes(d.id));
  const toggleFavorite = useSearchStore((s) => s.toggleFavorite);

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
          source={typeof d.imageUrl === "number" ? d.imageUrl : { uri: sizedImageUrl(d.imageUrl) }}
          style={styles.cardBg}
        >
          <LinearGradient
            colors={["rgba(0,0,0,0.05)", "rgba(0,0,0,0.15)", "rgba(0,0,0,0.85)"]}
            locations={[0, 0.45, 1]}
            style={StyleSheet.absoluteFill}
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
                <Text style={[styles.priceValue, { color: accent.solid }]}>{d.priceFrom}</Text>{" "}
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
});

const RECENT_COLLAPSED = 3;
const RECENT_EXPANDED = 8;

// === Screen ===================================================================
export default function HomeScreen() {
  const accent = useAccent();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const openRecentHistoryOverlay = useSearchStore((s) => s.openRecentHistoryOverlay);
  const [recentExpanded, setRecentExpanded] = useState(false);
  const [category, setCategory] = useState<CategoryId>("ocean");
  // Der Slide-nach-links/rechts beim Kategorie-Wechsel ist raus — die Karten
  // kaskadieren jetzt einzeln (ScrollReveal, key enthält die Kategorie). Damit
  // entfällt auch die ganze Buchhaltung, WANN der Slide feuern durfte: Sie war
  // nur nötig, weil `entering` bei jedem Refocus mit dem Scroll auf dem
  // UI-Thread kollidierte.
  const destinations = DESTINATIONS_BY_CATEGORY[category];
  const visibleRecents = recentSearches.slice(
    0,
    recentExpanded ? RECENT_EXPANDED : RECENT_COLLAPSED
  );
  const canExpand = recentSearches.length > RECENT_COLLAPSED;

  return (
    // ScreenEntrance: Die Sektionen blenden bei JEDEM Fokus dieses Tabs
    // gestaffelt ein, nicht nur beim ersten Mount — die Tabs bleiben gemountet,
    // ein mount-basiertes `entering` würde beim Wechsel nie feuern.
    <ScreenEntrance>
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <RevealScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 8 }]}
        showsVerticalScrollIndicator={false}
      >
          {/* Der Header animiert NICHT mit. Dauerhafte Chrome-Elemente (Logo,
              Titel, Tab-Bar) sollen stehen — wandern sie mit, sieht es aus, als
              fiele die ganze Seite von oben herein, statt dass sich der Inhalt
              setzt. Die Welle beginnt darunter. */}
          <Header />
          <ScrollReveal index={0}>
            <SearchBar
              style={[styles.searchBarSpacing, { borderWidth: 1.5, borderColor: "rgba(255,255,255,0.14)" }]}
              onPress={() => router.navigate("/assistant")}
              onMicPress={() =>
                router.navigate({ pathname: "/assistant", params: { autoVoice: "1" } })
              }
            />
          </ScrollReveal>
          <ScrollReveal index={1}>
            <TransportTabs />
          </ScrollReveal>

          {recentSearches.length > 0 && (
            // Kein ScrollReveal um den GANZEN Block — sonst blenden die Karten
            // doppelt ein (der Block als Ganzes und jede Karte einzeln). Der
            // Container bleibt statisch, nur Kopf und Karten kommen in der Welle.
            <View style={styles.recentSection}>
              <ScrollReveal index={2}>
                <SectionHeaderSmall
                  title={t("home.recent.title")}
                  onViewAll={() => {
                    haptic("button");
                    openRecentHistoryOverlay();
                  }}
                />
              </ScrollReveal>
              {visibleRecents.map((s, idx) =>
                idx < RECENT_COLLAPSED ? (
                  // Einzeln statt als Block — wie die Kacheln in den
                  // Einstellungen. Der Index läuft hinter dem Sektionskopf (2)
                  // weiter, damit die Welle durchgeht.
                  <ScrollReveal key={s.id} index={3 + idx}>
                    <RecentCard search={s} />
                  </ScrollReveal>
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
                // KEIN layout={LinearTransition} mehr — sonst flog der
                // Button bei jeder neuen Recent-Search von oben rein (weil
                // sich die List-Höhe ändert und der Button seine Position
                // animiert). Statisch positioniert: kein Re-Anim wenn man
                // vom Results zurück zum Landing kommt.
                <RippleTouch
                  style={styles.recentToggle}
                  onPress={() => {
                    haptic("button");
                    setRecentExpanded((v) => !v);
                  }}
                >
                  <Text style={[styles.recentToggleText, { color: accent.solid }]}>
                    {recentExpanded ? t("home.recent.showLess") : t("home.recent.showMore")}
                  </Text>
                  {recentExpanded ? (
                    <ChevronUp size={14} color={accent.solid} strokeWidth={2.5} />
                  ) : (
                    <ChevronDown size={14} color={accent.solid} strokeWidth={2.5} />
                  )}
                </RippleTouch>
              )}
            </View>
          )}

          {/* Plain View statt Animated.View+LinearTransition — die Layout-
              Animation war zwar selten aktiv (Section-Height ändert sich kaum
              zwischen Categories), aber Reanimated installiert pro-Frame
              onLayout-Listener auf jedem layout-Prop, was während Scroll
              spürbare Frame-Drops im ScrollView verursachte. Ohne
              LinearTransition snappt die Höhe direkt — kaum sichtbarer
              Verlust, viel smoother Scroll. */}
          <ScrollReveal index={3}>
            <View style={styles.popularHeader}>
              <Text style={styles.sectionTitle}>{t("home.destinations.title")}</Text>
              <Pressable hitSlop={8}>
                <Text style={[styles.actionLink, { color: accent.solid }]}>{t("home.viewall")}</Text>
              </Pressable>
            </View>
          </ScrollReveal>

          <ScrollReveal index={4}>
            <CategoryChips value={category} onChange={setCategory} />
            <View style={{ height: 14 }} />
          </ScrollReveal>

          {/* Jede Karte blendet EINZELN ein — vorher kam der ganze Block als ein
              Klotz, und genau das fiel im Vergleich zu Settings (wo jede Kachel
              einzeln kommt) als grober auf.

              Der `key` enthält die Kategorie: Beim Wechsel entstehen die Karten
              neu, sind sofort im Bild und kaskadieren dadurch von selbst. Das
              ersetzt den bisherigen Slide-nach-links/rechts — eine Bewegung
              statt zweier konkurrierender, und dieselbe wie überall sonst in der
              App. (Der alte Slide steckte in SlideInRight/SlideInLeft; wenn du
              die Richtungs-Geste vermisst, hole ich sie zurück.) */}
          {destinations.map((d, i) => (
            <ScrollReveal key={`${category}-${d.id}`} index={5 + i}>
              <DestinationCard d={d} />
            </ScrollReveal>
          ))}
      </RevealScrollView>
    </View>
    </ScreenEntrance>
  );
}

// === Styles ===================================================================
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  // paddingBottom: 0 — die Nav-Bar reserviert ihren eigenen Platz unter der
  // ScrollView (überlagert sie nicht). Der `card.marginBottom: 16` ist also
  // direkt der sichtbare Abstand zwischen letzter Card und Nav-Bar. Damit
  // matchen Inter-Card-Spacing (16dp) und Card-zu-Nav-Bar-Spacing (16dp)
  // geräteunabhängig.
  scrollContent: { paddingBottom: 0 },

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
  logoAccent: {},
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
    fontSize: 26,
    fontWeight: FONT.extrabold,
    color: C.white,
    letterSpacing: -0.6,
  },
  actionLink: { fontSize: 13, fontWeight: FONT.semibold },

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
  recentToggleText: { fontSize: 13, fontWeight: FONT.semibold },

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
    fontSize: 26,
    fontWeight: FONT.extrabold,
    color: C.white,
    letterSpacing: -0.6,
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
  priceValue: { fontSize: 16, fontWeight: FONT.extrabold },
  cta: {
    borderRadius: 9999,
    paddingVertical: 12,
    paddingHorizontal: 18,
    overflow: "hidden",
  },
  ctaText: { fontSize: 13, fontWeight: FONT.bold, color: C.black, letterSpacing: -0.13 },
});
