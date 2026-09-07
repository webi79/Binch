import { useEffect, useState, useRef, useCallback } from "react";
import { SHEET_IN, SHEET_OUT, markSheetMoving } from "@/lib/nav/overlayCover";
import {
  StyleSheet,
  View,
  BackHandler,
  Platform,
  Text,
  Pressable,
  useWindowDimensions,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import { SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { Trash2 } from "lucide-react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { RecentCard } from "@/components/home/RecentCard";
import { scaledStyles } from "@/lib/ui/compact";
import { SWIPE_OUT, useSheetScrollGate, useSheetSwipe } from "@/lib/ui/sheetSwipe";

/**
 * Bottom-sheet overlay showing the full recent-search history.
 * Visual styling mirrors AddTicketModal: dimmed backdrop, dark sheet
 * (#171719) with 28px top radius, drag-handle indicator, tap backdrop
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

  /**
   * Nur den Abschluss planen — die Wisch-Geste fährt selbst, auf dem UI-Strang.
   *
   * Die Dauer kommt von ihr mit: Der Abwurf nimmt die kürzere Kurve
   * (`SWIPE_OUT`), weil der Finger den halben Weg schon gemacht hat. Vorher
   * stand hier die volle Ausfahrt — dieses Blatt war damit das einzige, das
   * nach dem Loslassen noch gemächlich weiterkroch.
   */
  const scheduleClose = useCallback(
    (afterMs: number = SHEET_OUT.duration) => {
      if (closingRef.current) return;
      closingRef.current = true;
      closeTimer.current = setTimeout(close, afterMs);
    },
    [close],
  );

  /**
   * Gezogen wird am ganzen Blatt — und der Torhüter ist hier Pflicht.
   *
   * Dieses Blatt ist zum größten Teil Liste, und die ist regelmäßig länger als
   * die Fläche. Ohne die gleichzeitige Anmeldung bräche das Anspringen der
   * Wisch-Geste jedes Scrollen ab; ohne den Scroll-Stand risse eine Liste in
   * der Mitte das ganze Blatt mit nach unten. Beides steckt in
   * `useSheetScrollGate`.
   */
  const gate = useSheetScrollGate();
  const panGesture = useSheetSwipe({
    y: translateY,
    travel: sheetHeight,
    onDismiss: scheduleClose,
    gate,
  });

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
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[styles.sheet, { backgroundColor: palette.s1 }, sheetAnim, { top: sheetTop }]}
        >
          {/* Nur noch Zeichen, nicht mehr Griff — gezogen wird überall. */}
          <View style={styles.handleWrap}>
            <View style={styles.handle} />
          </View>
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
          {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am
              Blatt jedes Scrollen ab. */}
          <GestureDetector gesture={gate.native}>
            <Animated.ScrollView
            ref={gate.ref}
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              onScroll={gate.onScroll}
              scrollEventThrottle={16}
              // Kein Überzieh-Schimmer oben: Dort übernimmt ab sofort das Blatt.
              overScrollMode="never"
              bounces={false}
            >
              {recentSearches.map((s) => (
                <RecentCard key={s.id} search={s} bordered />
              ))}
            </Animated.ScrollView>
          </GestureDetector>
        </Animated.View>
      </GestureDetector>

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
    // 8 statt 6 — auf dem Raster, und der größere Titel braucht etwas mehr Luft.
    marginBottom: 8,
  },
  /** Aufschrift des Blattes — dieselbe wie in jedem anderen (SHEET_TITLE). */
  title: { ...SHEET_TITLE, flex: 1 },
  trashBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#171719",
  },
  subtitle: { ...SHEET_SUBTITLE, marginBottom: 16, paddingHorizontal: 20 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 24 },
});
