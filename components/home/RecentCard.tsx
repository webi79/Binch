import { memo, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useRouter } from "expo-router";
import { Plane, Train, Bus, Ship, ChevronRight, Trash2, type LucideIcon } from "lucide-react-native";
import { format, parseISO } from "date-fns";
import { de as deLocale, enUS, es as esLocale, fr as frLocale, type Locale as DateLocale } from "date-fns/locale";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, RecentSearch } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { GradientFill } from "@/components/ui/GradientFill";
import { haptic } from "@/lib/haptics";

const C = {
  surface1: "#1F1F20",
  surface2: "#242425",
  // green entfernt — Akzent kommt via useAccent() bzw. GradientFill.
  white: "#FFFFFF",
  gray1: "#C8C8CC",
  gray2: "#8A8A90",
  gray3: "#56565C",
  delete: "#E5484D",
};

const MODE_ICON: Record<TravelMode, LucideIcon> = {
  FLIGHT: Plane,
  TRAIN: Train,
  BUS: Bus,
  CRUISE: Ship,
};

const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

/** Wie weit die Card im Delete-Mode nach links rutscht (= Breite der Lösch-
 *  Zone die rechts dahinter sichtbar wird). */
const DELETE_WIDTH = 80;

/** Threshold für „User wischt nach rechts zum Abbrechen". Wenn die translationX
 *  beim Pan-Ende größer als das ist, animieren wir zurück auf 0 und verlassen
 *  den Delete-Mode. Sonst snap zurück auf -DELETE_WIDTH. */
const CANCEL_THRESHOLD = 30;

/** Animations-Konstanten als Module-Level damit Worklets sie sauber via
 *  Closure pullen können (sonst stolpert Reanimated bei In-Component-
 *  Konstanten manchmal über den Capture). */
const ANIM_MS = 220;
const EASING_OUT = Easing.out(Easing.quad);

function RecentCardInner({ search, bordered = false }: { search: RecentSearch; bordered?: boolean }) {
  const t = useT();
  const router = useRouter();
  const locale = useSearchStore((s) => s.locale);
  const closeRecentHistoryOverlay = useSearchStore((s) => s.closeRecentHistoryOverlay);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const Icon = MODE_ICON[search.mode];

  // iOS-Style „Swipe-To-Reveal-Delete": Long-Press → Card slidet -80px nach
  // links und legt die rote Lösch-Zone mit Trash-Icon dahinter frei.
  // User kann dann:
  //   1) Tap aufs Trash-Icon → Eintrag löschen
  //   2) Card nach rechts wischen (>30px Drag) → Mode abbrechen, Card zurück
  //   3) Tap auf die Card selbst → Mode abbrechen (Alternative zum Swipe)
  const [deleteMode, setDeleteMode] = useState(false);
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const cardAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  function enterDeleteMode() {
    haptic("important");
    setDeleteMode(true);
    translateX.value = withTiming(-DELETE_WIDTH, { duration: ANIM_MS, easing: EASING_OUT });
  }

  function exitDeleteMode() {
    // deleteZone SOFORT unmounten — wenn wir mit dem Animation-Callback
    // warten, bleiben die roten Rounded-Corners während des Slide-Backs
    // sichtbar (Sub-Pixel-Artefakte). Der Card slidet sauber über die nun
    // leere Wrap-Fläche zurück.
    setDeleteMode(false);
    translateX.value = withTiming(0, { duration: ANIM_MS, easing: EASING_OUT });
  }

  function handleDelete() {
    haptic("important");
    // Card kurz nach links austragen lassen (Off-Screen-Slide) bevor wir den
    // Eintrag aus dem Store entfernen. Die Component unmountet danach
    // ohnehin, die Animation überlappt den Unmount sauber.
    translateX.value = withTiming(-400, { duration: 220 });
    setTimeout(() => removeRecentSearch(search.id), 180);
  }

  function onCardPress() {
    if (deleteMode) {
      exitDeleteMode();
      return;
    }
    open();
  }

  // Pan-Gesture aktiv NUR im Delete-Mode. Wenn der User die Card nach rechts
  // zieht (translationX > CANCEL_THRESHOLD), gilt das als Abbrechen.
  // Vertikale Scroll-Bewegungen geben wir per failOffsetY an die parent-Liste
  // (FlatList) ab, damit normales Scrollen über Cards weiter funktioniert.
  const pan = Gesture.Pan()
    .enabled(deleteMode)
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((e) => {
      const next = startX.value + e.translationX;
      // Clamp: max 0 (nicht weiter rechts als Normal-Position), min
      // -DELETE_WIDTH (nicht weiter links als die Lösch-Zone breit ist).
      translateX.value = Math.max(-DELETE_WIDTH, Math.min(0, next));
    })
    .onEnd((e) => {
      if (e.translationX > CANCEL_THRESHOLD) {
        // Cancel: deleteZone SOFORT unmounten (runOnJS sync), damit die roten
        // Ecken-Pixel nicht während des Slide-Backs als Artefakte stehen
        // bleiben. withTiming statt Spring → kein Bounce am Ende.
        runOnJS(setDeleteMode)(false);
        translateX.value = withTiming(0, { duration: ANIM_MS, easing: EASING_OUT });
      } else {
        translateX.value = withTiming(-DELETE_WIDTH, { duration: ANIM_MS, easing: EASING_OUT });
      }
    });

  const dateLocale = DATE_LOCALES[locale] ?? enUS;
  const dateLabel = (() => {
    try {
      return format(parseISO(search.departDate), "d. MMM", { locale: dateLocale });
    } catch {
      return search.departDate;
    }
  })();
  const paxLabel = `${search.passengers} ${
    search.passengers === 1 ? t("search.passenger.singular") : t("search.passenger.plural")
  }`;
  const classLabel =
    search.mode === "FLIGHT" ? t("search.class.economy") : t("search.class.second");
  const isCleanCode = (code: string) =>
    code.length > 0 && code.length <= 6 && !code.includes(":");
  const formatEndpoint = (e: { code: string; label: string }) => {
    // Flug: Label ist „Stadt, Land" → Stadt (+ IATA) reicht.
    // Train/Bus/Cruise: VOLLES Label — bei „Stadt, Haltestelle" (z.B.
    // „Werl, Markt") darf der Haltestellenname NICHT abgeschnitten werden,
    // sonst wird „Werl, Markt" fälschlich zu „Werl".
    if (search.mode === "FLIGHT") {
      const city = e.label.split(",")[0]?.trim() ?? e.label;
      return isCleanCode(e.code) ? `${city} (${e.code})` : city;
    }
    return e.label;
  };

  function open() {
    // SOFORT navigieren, parallel das Overlay schließen. Vorher
    // setTimeout 280ms = spürbarer Input-Lag. Die Slide-Out des Overlays
    // läuft auf der UI-Thread (Reanimated), parallel zur Slide-In des
    // Results-Screens (auch UI-Thread, via InteractionManager+rAF in
    // app/search/results.tsx) → kein Konflikt mehr.
    closeRecentHistoryOverlay();
    router.push({
      pathname: "/search/results",
      params: {
        mode: search.mode,
        origin: search.origin.code,
        destination: search.destination.code,
        originLabel: search.origin.label,
        destLabel: search.destination.label,
        departDate: search.departDate,
        ...(search.returnDate ? { returnDate: search.returnDate } : {}),
        ...(search.tripType ? { tripType: search.tripType } : {}),
        passengers: String(search.passengers),
        currency: search.currency,
      },
    });
  }

  return (
    // Wrapper hat overflow:hidden + borderRadius damit beim Sliden nach links
    // nicht über den linken Rand der Card-Position hinausragt UND die Lösch-
    // Zone sauber durch die rounded Corner abgegrenzt wird.
    <View style={styles.cardWrap}>
      {/* Hintergrund: rote Lösch-Zone — wird NUR gerendert wenn der User
          im Delete-Mode ist. Vorher war die Zone permanent gemountet (mit
          opacity-Toggle), aber Android's GPU-Compositor rendert die
          Rounded-Corners der Zone und der Card mit Subpixel-Differenz —
          dadurch schimmerte das Rot an den Ecken durch. Mount-on-Demand
          eliminiert den Bug 100%: ohne View, ohne Bleed. */}
      {deleteMode && (
        <View style={styles.deleteZone}>
          <Pressable
            onPress={handleDelete}
            accessibilityLabel={t("history.delete")}
            accessibilityRole="button"
            style={styles.deleteBtn}
          >
            <Trash2 size={20} color="#FFFFFF" strokeWidth={2.2} />
            <Text style={styles.deleteBtnText}>{t("history.delete")}</Text>
          </Pressable>
        </View>
      )}

      {/* Vordergrund: die eigentliche Card. Pan-Gesture für Swipe-To-Cancel. */}
      <GestureDetector gesture={pan}>
        <Animated.View style={cardAnim}>
          <RippleTouch
            style={[styles.recentCard, bordered && styles.recentCardBordered]}
            onPress={onCardPress}
            onLongPress={enterDeleteMode}
          >
            <View style={styles.recentIconWrap}>
              <Icon size={20} color={C.gray1} />
            </View>
            <View style={styles.recentText}>
              <Text style={styles.recentRoute} numberOfLines={1}>
                {formatEndpoint(search.origin)} – {formatEndpoint(search.destination)}
              </Text>
              <Text style={styles.recentMeta} numberOfLines={1}>
                {dateLabel} · {paxLabel} · {classLabel}
              </Text>
            </View>
            <View style={styles.recentRight}>
              <View style={styles.pricePill}>
                <GradientFill />
                <Text style={styles.pricePillText}>{search.currency}</Text>
              </View>
              <ChevronRight size={14} color={C.gray3} />
            </View>
          </RippleTouch>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  cardWrap: {
    marginHorizontal: 20,
    marginBottom: 8,
    borderRadius: 16,
    // Wichtig: clip damit die nach links wischende Card nicht über die
    // Wrapper-Bounds hinausragt UND die rote Zone sauber rounded-corner-
    // begrenzt aussieht (sonst würden eckige Kanten überstehen wenn die
    // Card slidet).
    overflow: "hidden",
  },
  deleteZone: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: C.delete,
    borderRadius: 16,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  deleteBtn: {
    width: DELETE_WIDTH,
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  deleteBtnText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  recentCard: {
    backgroundColor: C.surface1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  recentCardBordered: {
    borderWidth: 1,
    borderColor: "#2E2E30",
  },
  recentIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  recentText: { flex: 1, minWidth: 0 },
  recentRoute: { fontSize: 14, fontWeight: "600", color: C.white },
  recentMeta: { fontSize: 12, color: C.gray2, marginTop: 3 },
  recentRight: { alignItems: "flex-end", gap: 6 },
  pricePill: {
    borderRadius: 9999,
    paddingHorizontal: 9,
    paddingVertical: 4,
    overflow: "hidden",
  },
  pricePillText: { fontSize: 11, fontWeight: "700", color: "#000" },
});

// Memo-Wrapper: bei einer Liste von 5+ Recent-Cards verhindert das, dass alle
// Cards bei jedem Home-Render neu zeichnen. Nur wenn `search` (das Trip-Objekt
// selbst) oder `bordered` sich ändert, wird die einzelne Card aktualisiert.
export const RecentCard = memo(RecentCardInner);
