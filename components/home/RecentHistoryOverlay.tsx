import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
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
import { usePalette } from "@/lib/theme/appBg";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import Animated, {
  FadeIn,
  FadeOut,
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
import { scaledStyles } from "@/lib/ui/compact";

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
  const palette = usePalette();
  const close = useSearchStore((s) => s.closeRecentHistoryOverlay);
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const t = useT();
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      requestClose();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  const sheetHeight = width * 1.168;
  const sheetTop = Math.max(0, height - sheetHeight);

  /**
   * Hereinfahren über einen eigenen Wert statt über `entering`.
   *
   * Derselbe Grund wie beim Blatt „Ticket hinzufügen", und dieselbe Beobachtung:
   * `SlideInDown` beginnt in DEM Commit, in dem der Baum entsteht — und dieser
   * Baum entsteht komplett neu, denn die Hülle darüber liefert `null`, solange
   * das Blatt zu ist. Auf Fabric werden die Ansichten dabei zuerst an ihrem
   * ENDplatz eingehängt und erst danach von der Animation zurückgesetzt; trifft
   * das ein Bild schlecht, sieht man den Inhalt kurz oben stehen, bevor er von
   * unten hereinfährt.
   *
   * Die Höhe steht hier von vornherein fest (fixes Seitenverhältnis), es braucht
   * also keine Messung wie dort: geparkt auf `sheetHeight`, ein Bild später los.
   *
   * `exiting` bleibt, wo es ist. Anders als beim Ticket-Blatt liegt dieses hier
   * nicht in einem eigenen Fenster, das beim Schließen sofort verschwindet —
   * Reanimated kann die Ausblend-Bewegung also tatsächlich zu Ende fahren, und
   * sie ist auch zu sehen.
   */
  /**
   * Schließen wie beim Blatt „Ticket hinzufügen" — dieselbe Bauart, nicht nur
   * dieselben Zahlen.
   *
   * Beide fuhren mit derselben Dauer und derselben Kurve herein, fühlten sich
   * aber verschieden an, weil das HINAUSfahren verschieden gebaut war: hier über
   * eine Aussprung-Animation, dort über denselben Wert wie das Hereinfahren.
   * Eine Aussprung-Animation startet erst, wenn React den Baum abbaut, und
   * Reanimated hält die native Ansicht danach noch fest — sie setzt also später
   * an und endet später als die Bewegung, die man erwartet.
   *
   * Jetzt gilt für beide Richtungen derselbe Wert und derselbe Weg: hinausfahren,
   * und erst danach abmelden.
   */
  const closingRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const translateY = useSharedValue(sheetHeight);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      markSheetMoving();
      translateY.value = withTiming(0, SHEET_IN);
    });
    return () => cancelAnimationFrame(id);
  }, [translateY]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    markSheetMoving();
    translateY.value = withTiming(sheetHeight, SHEET_OUT);
    closeTimer.current = setTimeout(close, SHEET_OUT.duration);
  }, [close, sheetHeight, translateY]);

  /** Nur den Abschluss planen — die Wisch-Geste fährt selbst, auf dem UI-Strang. */
  const scheduleClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    closeTimer.current = setTimeout(close, SHEET_OUT.duration);
  }, [close]);

  /**
   * In `useMemo` — sonst entsteht der Erkenner bei jedem Render neu.
   *
   * Jedes neue `Gesture.Pan()`-Objekt muss der Detektor gegen seinen nativen
   * Gegenpart abgleichen und neu einrichten. Die anderen Blätter der App haben
   * das längst; diese drei waren übrig.
   */
  const panGesture = useMemo(() =>
    Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetY(-8)
    .onUpdate((e) => {
      translateY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (e.translationY > 110 || e.velocityY > 700) {
        // Bewegung SOFORT von hier, auf dem UI-Strang — der Finger ist gerade
        // erst weg. Abgemeldet wird erst danach; identisch zum Ticket-Blatt.
        translateY.value = withTiming(sheetHeight, SHEET_OUT);
        runOnJS(scheduleClose)();
      } else {
        translateY.value = withSpring(0, { damping: 22, stiffness: 220 });
      }
    }),
  [sheetHeight, translateY, scheduleClose]);

  const [confirmVisible, setConfirmVisible] = useState(false);
  const handleClear = () => {
    haptic("button");
    if (recentSearches.length === 0) return;
    setConfirmVisible(true);
  };
  const handleConfirmClear = () => {
    setConfirmVisible(false);
    clearRecentSearches();
    close();
  };

  return (
    <View style={StyleSheet.absoluteFillObject}>
      <Animated.View
        // Mit dem Blatt, nicht daneben: 250/200 gegen 300/260 hieß, dass
        // Hintergrund und Blatt nicht zusammen ankommen.
        entering={FadeIn.duration(SHEET_IN.duration)}
        exiting={FadeOut.duration(SHEET_OUT.duration)}
        style={styles.backdrop}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} />
      </Animated.View>
      <Animated.View
        style={[styles.sheet, { backgroundColor: palette.s1 }, sheetAnim, { top: sheetTop }]}
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
              { backgroundColor: palette.s2 },
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

      <ClearSearchHistoryAlert
        visible={confirmVisible}
        onCancel={() => setConfirmVisible(false)}
        onConfirm={handleConfirmClear}
        title={t("home.recent.clear.title")}
        message={t("home.recent.clear.body")}
        confirmLabel={t("home.recent.clear.confirm")}
        cancelLabel={t("home.recent.clear.cancel")}
      />
    </View>
  );
}

const styles = scaledStyles({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Farbe kommt zur Laufzeit aus der Palette (siehe Render).
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
