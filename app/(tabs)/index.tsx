import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  StatusBar,
  StyleSheet,
  ImageBackground,
  useWindowDimensions,
  Platform,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
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
import { OnFocusLost } from "@/lib/nav/FocusSentinel";
import {
  resultsPush,
  pushProgress,
  UNDERLAY_TRAVEL_FRAC,
} from "@/lib/nav/overlayCover";
import { isSearchHandoff } from "@/lib/nav/searchHandoff";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  Easing,
} from "react-native-reanimated";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { HomeContentDepth } from "@/components/search/HomeLaunchDepth";
import { GUTTER, SPACE, HEADING_TOP, HEADING_GAP, useNavbarSpace } from "@/lib/theme/spacing";
import { ScreenHeading, HEADING_LINE_HEIGHT } from "@/components/ui/ScreenHeading";
import { MOTION } from "@/lib/motion";
import { subscribeLayer, prepareLayer } from "@/lib/nav/transitionLayer";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { RecentCard } from "@/components/home/RecentCard";
import { useSearchStore, type SearchOverlayLaunch } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { useAccent } from "@/lib/theme/accent";
import { useAppBg, usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

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

/**
 * Die Scroll-Fläche des Landingscreens — und für die Dauer eines Übergangs eine
 * GPU-Textur.
 *
 * Ohne sie zeichnet Android diesen Baum in JEDEM Bild der Bewegung neu, während
 * er per Parallax zur Seite wandert. Am Ticket-Blatt ist das mit ~14,7ms gegen
 * ein 8,3ms-Budget vermessen — jedes zweite Bild fällt aus. Als Textur ist ein
 * Bild nur noch ein Kopiervorgang.
 *
 * NUR während des Übergangs: Eine dauernde Textur über einer scrollenden Fläche
 * müsste bei jedem Scroll-Bild neu entstehen und wäre schlimmer als keine.
 *
 * EIGENE KOMPONENTE, damit der Zustandswechsel beim Fingerdruck nur diesen
 * Knoten trifft. Läge er im Landingscreen selbst, rendete dessen ganzer Baum im
 * Berührungs-Frame neu.
 */
function ParallaxScroll({
  style,
  contentContainerStyle,
  children,
}: {
  style: StyleProp<ViewStyle>;
  contentContainerStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [layered, setLayered] = useState(false);
  useEffect(() => subscribeLayer("home", setLayered), []);

  /**
   * Der Parallax liegt HIER, nicht im Landingscreen — und er läuft nur, wenn
   * dieser Bildschirm überhaupt die Unterlage ist.
   *
   * Zwei Dinge daran sind wichtig:
   *
   * 1. Er liest `resultsPush` nur, wenn das Such-Blatt NICHT offen ist. Sucht
   *    man aus dem Such-Blatt heraus, liegt das bildschirmfüllend über dem
   *    Landingscreen — die Unterlage ist dann das Blatt, nicht dieser Baum. Der
   *    Auswerter lief trotzdem jedes Bild und schrieb einen Transform auf eine
   *    vollständig verdeckte Scroll-Fläche. Was das Worklet nicht liest,
   *    abonniert es auch nicht: Bei offenem Blatt läuft er gar nicht erst mit.
   *
   * 2. Er steht in DIESER kleinen Komponente. Im Landingscreen selbst hätte das
   *    Abonnement auf den Zustand des Blattes dessen kompletten Baum bei jedem
   *    Öffnen und Schließen neu gerendert — genau im Bild des Übergangs. Das ist
   *    derselbe Grund, aus dem der Textur-Schalter hier liegt und nicht dort.
   */
  const searchClosed = useSearchStore((st) => st.searchOverlayMode == null);
  const { width: screenW } = useWindowDimensions();
  const parallaxStyle = useAnimatedStyle(
    () =>
      searchClosed
        ? {
            transform: [
              { translateX: pushProgress(resultsPush.value) * screenW * UNDERLAY_TRAVEL_FRAC },
            ],
          }
        : NO_HOME_PARALLAX,
    [searchClosed, screenW],
  );
  return (
    <Animated.ScrollView
      // Reanimated setzt auf seinen Scroll-Flächen ungefragt scrollEventThrottle=1
      // (component/ScrollView.js), also EIN Ereignis pro Bild — bei 120Hz 120 pro
      // Sekunde zum JS-Thread. Diese Fläche hat aber gar keinen onScroll-Handler
      // (der Parallax hängt an geteilten Werten auf dem UI-Thread), die Ereignisse
      // sind also restlos Abfall. Explizit gesetzt heißt: weg damit.
      scrollEventThrottle={16}
      style={[style, parallaxStyle]}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      renderToHardwareTextureAndroid={Platform.OS === "android" && layered}
    >
      {children}
    </Animated.ScrollView>
  );
}

/** Ruhestellung des Parallax — als Konstante, kein neues Objekt pro Auswertung. */
const NO_HOME_PARALLAX = { transform: [{ translateX: 0 }] } as const;

/** Kantenlänge der Glocke rechts in der Kopfzeile (siehe styles.bell). */
const BELL_SIZE = 44;
/** Um so viel überragt die Glocke die Textzeile nach oben UND unten. */
const BELL_OVERHANG = (BELL_SIZE - HEADING_LINE_HEIGHT) / 2;

// === Subcomponents ============================================================

function Header() {
  const accent = useAccent();
  const palette = usePalette();
  return (
    <View style={styles.headerRow}>
      <ScreenHeading>
        B<Text style={{ color: accent.solid }}>i</Text>nch
      </ScreenHeading>
      <RippleTouch
        style={[styles.bell, { backgroundColor: palette.s2 }]}
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

/** Press-Feedback der Kategorie-Kacheln (HyperOS-Gefühl): beim Antippen leicht
 *  zusammendrücken. Interaktive Elemente brauchen sofortige Rückmeldung → hohe
 *  Steifigkeit beim Reindrücken; das Zurückfedern darf weicher sein. */
const TILE_PRESS_SCALE = 0.93;
const TILE_PRESS_IN = { damping: 18, stiffness: 320, mass: 0.7 };
const TILE_PRESS_OUT = { damping: 15, stiffness: 200, mass: 0.8 };

/** Eckenradius der großen Reiseziel-Karten. Wird auf JEDE Ebene der Karte einzeln
 *  angewandt (Bild, Verlauf, Container) statt per `overflow: "hidden"` — siehe
 *  styles.card. */
const CARD_RADIUS = 28;

const TRANSPORT: { id: TravelMode; labelKey: string; icon: LucideIcon }[] = [
  { id: "FLIGHT", labelKey: "mode.flights", icon: Plane },
  { id: "TRAIN", labelKey: "mode.trains", icon: Train },
  { id: "BUS", labelKey: "mode.buses", icon: Bus },
  { id: "CRUISE", labelKey: "mode.cruises", icon: Ship },
];

function TransportTile({
  id,
  labelKey,
  Icon,
}: {
  id: TravelMode;
  labelKey: string;
  Icon: LucideIcon;
}) {
  const t = useT();
  const palette = usePalette();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  // Die Kachel wird NICHT mehr ausgeblendet.
  //
  // Sie verschwand, sobald der Launch lief — weil eine gleich große Deckfläche
  // pixelgenau an ihre Stelle trat und von dort auf Vollbild wuchs. Diese Fläche
  // gibt es nicht mehr: Der Such-Screen fährt jetzt als Blatt von unten herein
  // und schiebt sich über den Landingscreen. Bliebe das Ausblenden stehen,
  // klaffte während der Bewegung ein Loch im Kachelraster — sichtbar, weil der
  // Landingscreen unter dem hereinfahrenden Blatt bis zuletzt zu sehen ist.
  // Kein natives Messen: das Kachel-Rect kommt aus dem Press-Event. pageX/pageY
  // (Tap in Fensterkoordinaten) minus locationX/locationY (Tap-Position in der
  // Kachel) = obere linke Ecke; Größe aus onLayout.
  const size = useRef({ w: 0, h: 0 });

  // Press-Feedback wie auf HyperOS: die Kachel wird beim Antippen physisch
  // zusammengedrückt. Der Launch startet danach aus GENAU dieser gedrückten
  // Größe (siehe TILE_PRESS_SCALE unten) — dadurch wirkt das Icon wie ein
  // Objekt mit Masse, das sich zum Fenster aufzieht, statt wie ein Rechteck,
  // das plötzlich skaliert.
  const press = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  // Rect wird aus dem ROHEN Touch-Down der äußeren View gelesen. TouchableNative-
  // Feedback (Android) füllt locationX/Y in seinen synthetischen Press-Events
  // NICHT zuverlässig (kommt ~0) → x = pageX − 0 = Tap-Punkt statt Kachel-Ecke.
  // onTouchStart der View liefert pageX/pageY UND locationX/locationY korrekt,
  // relativ zu genau dieser View — und die View ist noch unskaliert.
  const launchRect = useRef<SearchOverlayLaunch | null>(null);

  const capture = (e: GestureResponderEvent) => {
    const { pageX, pageY, locationX, locationY } = e.nativeEvent;
    const { w, h } = size.current;
    if (w > 0 && h > 0 && pageX != null && locationX != null) {
      // In GEDRÜCKTER Größe merken. Der Kommentar oben behauptet das bereits,
      // `onLayout` liefert aber die ungedrückte: Der Druck ist ein Transform und
      // ändert das Layout nicht. Das Letzte, was man sieht, ist die Kachel bei
      // 93 % — der erste Frame der Box war 100 %, also ein Sprung um 7 % in einem
      // Bild, an Kante und Beschriftung sichtbar.
      const pw = w * TILE_PRESS_SCALE;
      const ph = h * TILE_PRESS_SCALE;
      launchRect.current = {
        x: pageX - locationX + (w - pw) / 2,
        y: pageY - locationY + (h - ph) / 2,
        w: pw,
        h: ph,
        color: palette.s2,
      };
    }
  };

  const launch = () => {
    // Läuft schon ein Launch, nichts tun. Sonst startet der zweite Tipp den
    // Zustandsautomaten neu (`session`-Bump) — die schon wachsende Box
    // verschwindet für ein Bild und fängt von vorn an. Das Fenster dafür ist
    // real: Bis der Commit durch ist, steht der Overlay-Root noch auf
    // `pointerEvents: none`, die Kacheln darunter sind also weiter tippbar.
    if (useSearchStore.getState().searchOverlayMode != null) return;
    haptic("button");
    openSearchOverlay(id, launchRect.current ?? undefined);
  };

  return (
    <Animated.View
      // opacity 0 SOFORT beim Launch dieser Kachel: der Splash übernimmt.
      style={[styles.tabWrap, pressStyle]}
      onLayout={(e) => {
        size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
      }}
      onTouchStart={capture}
    >
      {/* Reines Pressable statt RippleTouch → auf diesen vier Launch-Kacheln
          GAR KEIN Material-Ripple mehr. Das helle Default-Ripple zündete beim
          Tap und blitzte 1-2 Frames vor dem Splash am Rand durch (das
          „gelegentliche Aufblitzen von der Box"); rippleColor="transparent"
          reichte nicht, weil die native Ripple-Drawable trotzdem lief. Das
          physische Zusammendrücken (press-scale) ist das eigentliche Feedback. */}
      <Pressable
        style={[styles.tab, styles.tabIdle, { backgroundColor: palette.s2 }]}
        onPress={launch}
        onPressIn={() => {
          press.value = withSpring(TILE_PRESS_SCALE, TILE_PRESS_IN);
        }}
        onPressOut={() => {
          press.value = withSpring(1, TILE_PRESS_OUT);
        }}
      >
        {/* pointerEvents none: der Touch soll IMMER auf die Kachel treffen,
            nie auf Icon/Label. Sonst ist locationX relativ zum kleinen Kind
            (Icon liegt zentral) → x = pageX - locationX falsch bei Mitte-Tap. */}
        <View pointerEvents="none" style={styles.tabContent}>
          <Icon size={24} color={C.white} strokeWidth={1.8} />
          <Text numberOfLines={1} style={[styles.tabLabel, styles.tabLabelIdle]}>
            {t(labelKey)}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

function TransportTabs() {
  return (
    <View style={styles.tabsRow}>
      {TRANSPORT.map(({ id, labelKey, icon }) => (
        <TransportTile key={id} id={id} labelKey={labelKey} Icon={icon} />
      ))}
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
  const palette = usePalette();
  const t = useT();
  return (
    <View style={styles.chipsRow}>
      {CATEGORIES.map((it) => {
        const on = value === it.id;
        return (
          <RippleTouch
            key={it.id}
            style={[styles.chip, { backgroundColor: on ? "transparent" : palette.s2 }]}
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

/** Startzustand der Einblendung — siehe Begründung am JSX unten. */
const CARD_ENTER_FROM = { opacity: 0, transform: [{ translateY: 24 }] } as const;

const DestinationCard = memo(function DestinationCard({ d }: { d: Destination }) {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const openSearchOverlay = useSearchStore((s) => s.openSearchOverlay);
  // WICHTIG: selektiv abonnieren — sonst löst JEDER Favorite-Toggle einen
  // Re-Render ALLER DestinationCards aus. Wir interessieren uns nur dafür ob
  // GENAU DIESE Destination gespeichert ist; Zustand's shallow-compare
  // verhindert dann den Re-Render wenn sich nur fremde Favoriten ändern.
  const saved = useSearchStore((s) => s.favoriteResultIds.includes(d.id));
  const toggleFavorite = useSearchStore((s) => s.toggleFavorite);

  // Bild-Source STABIL memoisieren: sonst entsteht bei jedem Render ein neues
  // `{uri}`-Objekt → RN-Image kann das Bild neu laden → sichtbares Flackern.
  const imageSource = useMemo(
    () => (typeof d.imageUrl === "number" ? d.imageUrl : { uri: sizedImageUrl(d.imageUrl) }),
    [d.imageUrl],
  );

  const scale = useSharedValue(1);
  /**
   * Einblenden beim Entstehen — selbst getrieben statt über `entering`.
   *
   * `entering={FadeIn}` stand hier und tat nichts Sichtbares. Reanimateds
   * Ein-/Aussprung-Animationen hängen daran, dass Fabric den Einbau der Ansicht
   * als solchen meldet; in einer Liste innerhalb einer bewegten ScrollView kommt
   * das nicht verlässlich an. Ein eigener Wert, der im Mount-Effekt losläuft,
   * hängt an nichts davon — dasselbe Muster, mit dem in dieser App auch alle
   * anderen Mikro-Bewegungen laufen.
   *
   * Der `key` der Karte enthält die Kategorie: Beim Wechsel entstehen die vier
   * Karten neu, dieser Effekt läuft also erneut.
   */
  const enter = useSharedValue(0);
  useEffect(() => {
    enter.value = 0;
    enter.value = withTiming(1, { duration: MOTION.duration, easing: MOTION.easing });
  }, [enter]);
  const cardAnim = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [
      // Von unten herein: 24px Weg, gemeinsam mit der Deckkraft. Vorher lief nur
      // die Deckkraft über 260ms — auf einer fast bildschirmhohen Bildkarte ist
      // das kaum zu sehen, weil sich die Fläche selbst nicht ändert. Der kurze
      // Weg macht daraus eine erkennbare Bewegung, ohne dass die Karte „fällt".
      { translateY: (1 - enter.value) * 24 },
      { scale: scale.value },
    ],
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
    // Nur Deckkraft, keine Bewegung: Die Karten sind fast bildschirmhoch, und
    // etwas in dieser Größe zu verschieben liest sich als Nachladen statt als
    // Übergang. Siehe `enter` oben.
    /**
     * Der Startzustand steht auch STATISCH da, nicht nur im Worklet.
     *
     * Genau hier kam das Aufblitzen beim Kategorie-Wechsel her. Der `key` der
     * Karte enthält die Kategorie, beim Wechsel entstehen also vier neue
     * Ansichten — und Fabric hängt sie mit ihrem STATISCHEN Stil ein. Der
     * animierte Stil kommt vom UI-Strang und greift erst, wenn der einmal
     * durchgelaufen ist. Fällt das ungünstig, steht die fertige Karte für ein
     * Bild vollständig sichtbar da, bevor sie auf Deckkraft 0 zurückgesetzt wird
     * und von unten hereinfährt.
     *
     * Dieselbe Ursache wie bei den Ein-Sprung-Animationen in den Blättern, nur
     * andersherum sichtbar: Dort blitzte der Inhalt am Endplatz auf, hier die
     * ganze Karte. Steht der Startzustand schon im statischen Stil, gibt es kein
     * Bild mehr, in dem etwas anderes zu sehen wäre — der animierte Stil
     * überschreibt ihn, sobald er greift.
     */
    <Animated.View style={[CARD_ENTER_FROM, cardAnim]}>
      <RippleTouch
        style={[styles.card, { backgroundColor: palette.s2 }]}
        onPress={() => {
          haptic("button");
          openSearchOverlay(d.mode);
        }}
      >
        <ImageBackground
          source={imageSource}
          style={styles.cardBg}
          // Androids Default-Einblend-Fade (~300ms) AUS: Sonst fadet jedes
          // (Nach-)Laden sichtbar ein → wirkt auf den Karten wie ein Flackern,
          // vor allem wenn während der Expand-Animation ein Bild (nach-)lädt.
          fadeDuration={0}
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
  const appBg = useAppBg();
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const navbarSpace = useNavbarSpace();
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const openRecentHistoryOverlay = useSearchStore((s) => s.openRecentHistoryOverlay);

  // Tab gewechselt, WÄHREND die Suche offen ist → sofort schließen, ohne
  // Rück-Expansion (die Kachel ist auf dem neuen Tab gar nicht sichtbar).
  //
  // Bewusst HIER (Fokus-Verlust) und nicht im tabPress: tabPress feuert VOR dem
  // Wechsel — das Overlay gäbe den Landingscreen frei und man sähe ihn kurz
  // aufblitzen. Der Fokus-Verlust kommt NACH dem Wechsel, das Overlay deckt bis
  // dahin, und darunter liegt schon der neue Tab.
  //
  // Geprüft wird der echte Fokus-VERLUST (war fokussiert → ist es nicht mehr),
  // nicht bloß „nicht fokussiert": Sonst würde eine Suche, die aus einem anderen
  // Screen geöffnet wird (NotFound aus der Ergebnisliste), sofort zuklappen.
  // Als <OnFocusLost/> unten im JSX statt useIsFocused() hier: Der Hook an
  // dieser Stelle rendete den kompletten Home-Baum zweimal pro Tab-Wechsel neu
  // — genau im Wechsel-Frame. Die Sentinel-Komponente rendert nur sich selbst.
  const { width: screenW } = useWindowDimensions();

  const closeOpenSearchOnLeave = useCallback(() => {
    const store = useSearchStore.getState();
    // Läuft gerade die Übergabe an die Ergebnisse („Preis vergleichen")? Dann
    // NICHT schließen: Der Such-Screen soll unter der reinslidenden Ergebnis-
    // Liste stehenbleiben. Geschlossen wird er dort, sobald die Slide deckt.
    if (isSearchHandoff()) return;
    if (store.searchOverlayMode == null) return;
    // SOFORT schließen — bewusst KEIN Timer. Ein Delay hier (auch nur ~180ms,
    // um den Tab-Crossfade abzudecken) fühlt sich als Input-Lag an: Man tippt
    // den Tab und es passiert sichtbar nichts. Responsivität schlägt das
    // kurze Durchblitzen des Hintergrunds.
    store.closeSearchOverlay(true);
  }, []);
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


  // Keine gestaffelte Einblend-Welle mehr, und inzwischen auch keine Überblendung
  // der Leiste: Der Tab-Wechsel schaltet direkt um, der Inhalt ist dabei sofort
  // vollständig da (siehe _layout.tsx).
  return (
    <>
    <OnFocusLost run={closeOpenSearchOnLeave} />
    {/* HomeContentDepth: NUR der Home-Inhalt dunkelt beim Launch ab (Dim) —
        die native Tab-Bar bleibt statisch. */}
    <HomeContentDepth>
    <View style={[styles.root, { backgroundColor: appBg }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      {/* Unterlay-Parallax: Tippt man im Verlauf auf eine Reise, slidet die
          Ergebnis-Liste von rechts darüber — der Landingscreen rückt dabei ein
          Stück mit, wie bei allen anderen Push-Übergängen.
          Der Stil hängt DIREKT an der Scroll-Fläche (sie ist ohnehin eine
          Animated.ScrollView). Ein eigener Wrapper-Knoten darum hatte das
          Scrollen wieder ruckeln lassen: Android muss eine transformierte
          Ebene um eine scrollende Liste beim Scrollen mit-compositen. */}
      <ParallaxScroll
        style={styles.scroll}
        // Platz für die durchsichtige Leiste — zur Laufzeit, weil er von der
        // sicheren Fläche des Geräts abhängt (siehe useNavbarSpace).
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top, paddingBottom: navbarSpace }]}
      >
          {/* Der Header animiert NICHT mit. Dauerhafte Chrome-Elemente (Logo,
              Titel, Tab-Bar) sollen stehen — wandern sie mit, sieht es aus, als
              fiele die ganze Seite von oben herein, statt dass sich der Inhalt
              setzt. Die Welle beginnt darunter. */}
          <Header />

            <SearchBar
              style={[styles.searchBarSpacing, { borderWidth: 1.5, borderColor: "rgba(255,255,255,0.14)" }]}
              /**
               * Die Textur für den Landingscreen beim AUFSETZEN anlegen.
               *
               * Bo liegt als durchsichtiges Blatt über dem Stapel, dieser
               * Bildschirm bleibt darunter also sichtbar UND wird in jedem Bild
               * seiner Einfahrt neu gezeichnet. Der Weg zur Ergebnisliste macht
               * das seit Längerem (`RecentCard`), der zu Bo nicht — dabei ist
               * hier mehr zu zeichnen.
               */
              onTouchStart={() => prepareLayer("home")}
              /**
               * NUR navigieren — die Fahrt startet Bo selbst, nach seinem
               * ersten Bild.
               *
               * Vorher lief die Kurve hier los und der Bildschirm baute sich
               * mitten in ihr auf. Die Begründung steht ausführlich am
               * Gegenstück in `app/assistant.tsx`; kurz: Jedes andere Blatt der
               * App fährt erst, wenn es fertig gezeichnet ist, und genau daran
               * lag es, dass sich dieses hier anders anfühlte.
               */
              onPress={() => {
                router.navigate("/assistant");
              }}
              onMicPress={() => {
                router.navigate({ pathname: "/assistant", params: { autoVoice: "1" } });
              }}
            />

          
            <TransportTabs />

          {recentSearches.length > 0 && (
            // Kein ScrollReveal um den GANZEN Block — sonst blenden die Karten
            // doppelt ein (der Block als Ganzes und jede Karte einzeln). Der
            // Container bleibt statisch, nur Kopf und Karten kommen in der Welle.
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

            {/* „Alle anzeigen" ist raus — es führte nirgendwohin (leerer
                Pressable ohne onPress), und die vier Kategorie-Chips darunter
                sind ohnehin der Weg zu mehr Zielen. */}
            <View style={styles.popularHeader}>
              <Text style={styles.sectionTitle}>{t("home.destinations.title")}</Text>
            </View>

            <CategoryChips value={category} onChange={setCategory} />
            <View style={{ height: 14 }} />

          {/* Alle Karten faden GLEICHZEITIG — gleicher Index, kein `+ i`.
              Einzeln kaskadierend wirkten sie unruhig: Die Karten sind groß,
              fast bildschirmhoch, und eine Welle über Elemente dieser Größe liest
              sich nicht als Rhythmus, sondern als Nachladen. Die Welle davor
              (Suchleiste → Tabs → Recents → Überschrift → Chips) trägt die
              Bewegung; die Karten sind ihr Schlusspunkt, nicht ihre Fortsetzung.

              Bewusst KEIN gemeinsamer Wrapper um den Block: Der wäre mehrere
              Bildschirme hoch, und das Offscreen-Compositing (nötig, damit der
              Verlauf mit der Karte fadet statt danach) müsste einen entsprechend
              riesigen Puffer anlegen. So komponiert jede Karte nur ihre eigene
              Fläche — und sie faden trotzdem synchron.

              Der `key` enthält die Kategorie: Beim Wechsel entstehen die Karten
              neu und faden als Block ein (waveBase → kein Vorlauf, auf den zu
              warten wäre). Das ersetzt den früheren Slide-nach-links/rechts. */}
          {destinations.map((d) => (
              // key MIT Kategorie — er fehlte, obwohl der Kommentar darüber
              // ausdrücklich mit ihm argumentiert. React glich die vier Karten
              // damit nach POSITION statt nach Identität ab: Beim Kategorie-
              // Wechsel tauschte nur die Bildquelle im Bestand, statt dass neue
              // Karten entstehen — und `memo` konnte gar nicht greifen.
              <DestinationCard key={`${category}-${d.id}`} d={d} />

          ))}
      </ParallaxScroll>
    </View>
    </HomeContentDepth>
    </>
  );
}

// === Styles ===================================================================
const styles = scaledStyles({
  root: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  // paddingBottom: 0 — die Nav-Bar reserviert ihren eigenen Platz unter der
  // ScrollView (überlagert sie nicht). Der `card.marginBottom: 16` ist also
  // direkt der sichtbare Abstand zwischen letzter Card und Nav-Bar. Damit
  // matchen Inter-Card-Spacing (16dp) und Card-zu-Nav-Bar-Spacing (16dp)
  // geräteunabhängig.
  scrollContent: {},

  // Header
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: GUTTER,
    // Der Takt liegt komplett HIER, nicht halb im Scroll-Inhalt: Der trägt nur
    // noch die sichere Fläche (insets.top), diese Zeile den Rest.
    //
    // Abzüglich BELL_OVERHANG — und genau das fehlte, weshalb das Logo trotz
    // gleicher Zahlen tiefer saß als „Saved" und „Profil": In dieser Zeile steht
    // rechts die Glocke, und die ist mit 44 höher als die Textzeile mit 32. Die
    // Zeile ist damit 44 hoch, und `alignItems: "center"` schiebt den Text um die
    // halbe Differenz nach unten. Der Abstand stimmte also — nur nicht zum Text,
    // sondern zur Glocke. Die Kompensation zieht ihn wieder heraus, oben wie
    // unten, sodass Text und Abstand exakt auf denselben Werten landen wie in
    // den anderen Tabs.
    paddingTop: HEADING_TOP - BELL_OVERHANG,
    paddingBottom: HEADING_GAP - BELL_OVERHANG,
  },
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
  searchBarSpacing: { marginHorizontal: GUTTER, marginBottom: 12 },

  // Transport tabs
  tabsRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: GUTTER,
    paddingBottom: 8,
  },
  tabWrap: { flex: 1 },
  tabContent: { alignItems: "center", justifyContent: "center", gap: 6 },
  tabIdle: { backgroundColor: C.surface2 },
  tabLabelIdle: { color: C.white, fontWeight: "600" },
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
    paddingHorizontal: GUTTER,
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
    marginHorizontal: GUTTER,
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
    paddingHorizontal: GUTTER,
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
    paddingHorizontal: GUTTER,
    paddingTop: 4,
    paddingBottom: 4,
  },
  chip: {
    flex: 1,
    borderRadius: 9999,
    paddingVertical: 10,
    paddingHorizontal: SPACE.sm,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  chipLabel: { fontSize: 13, letterSpacing: -0.1 },

  // Destination card
  card: {
    marginHorizontal: GUTTER,
    marginBottom: 16,
    borderRadius: CARD_RADIUS,
    // EIN Clip für ALLE Ebenen. Der Versuch, stattdessen jede Ebene einzeln zu
    // runden (Bild via imageStyle + Verlauf separat), erzeugte an den UNTEREN
    // Ecken einen dünnen hellen Saum: Die getrennt gerundeten Ebenen treffen sich
    // dort nicht pixelgenau, und der hellere Karten-Hintergrund blitzte durch.
    // Der clipToOutline-Konflikt mit einem Ancestor-Transform ist stattdessen
    // gelöst, indem die Reveal-Welle große Karten GAR NICHT mehr bewegt (nur
    // noch einblendet) — siehe `large` in lib/motion.tsx.
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
    paddingHorizontal: SPACE.sm,
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
    paddingHorizontal: SPACE.lg,
    overflow: "hidden",
  },
  ctaText: { fontSize: 13, fontWeight: FONT.bold, color: C.black, letterSpacing: -0.13 },
});
