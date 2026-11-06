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
import { RippleTouch } from "@/components/ui/RippleTouch";
import { SheetHandle, SHEET_SUBTITLE, SHEET_TITLE } from "@/components/ui/SheetModal";
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
import { GROUP_GAP, GUTTER, ITEM_GAP, SECTION_GAP, SPACE } from "@/lib/theme/spacing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dragHealOffset, snapToPixel, SWIPE_OUT, useSheetScrollGate, useSheetSwipe } from "@/lib/ui/sheetSwipe";
import { slideTiming } from "@/lib/nav/slideMotion";

/**
 * Bottom-sheet overlay showing the full recent-search history.
 * Visual styling mirrors AddTicketModal: dimmed backdrop, sheet in `s1`
 * with 28px top radius, drag-handle indicator, tap backdrop to dismiss.
 * Sheet height locked to width:height = 1:1.168 aspect ratio.
 *
 * Der KOPF ist seit 05.11.2026 Maß für Maß der jedes anderen Blattes
 * (`SheetModal`): Griff-Zone 12/4/16, Titel, 8, Untertitel, 16, Inhalt. Hier
 * stand eine Titelzeile mit 8 Polster oben und unten plus 8 Abstand — der
 * Titel saß 8 tiefer als in jedem anderen Blatt, der Untertitel 8 weiter weg.
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
  const insets = useSafeAreaInsets();
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
  /**
   * Ganze Gerätepixel + Selbstkorrektur beim Ziehen — beides erklärt in
   * lib/ui/sheetSwipe.ts (`snapToPixel`, `startDragHeal`).
   */
  const heal = useSharedValue(0);
  /** Wird von woanders geschlossen — die Wisch-Geste hält sich dann heraus (`closing` in useSheetSwipe). */
  const closingSv = useSharedValue(false);
  const sheetAnim = useAnimatedStyle(() => ({
    transform: [{ translateY: snapToPixel(translateY.value) + dragHealOffset(heal) }],
  }));
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      markSheetMoving();
      translateY.value = withTiming(0, slideTiming(SHEET_IN));
    });
    return () => cancelAnimationFrame(id);
  }, [translateY]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    markSheetMoving();
    closingSv.value = true;
    translateY.value = withTiming(sheetHeight, slideTiming(SHEET_OUT));
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
      closingSv.value = true;
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
    heal,
    closing: closingSv,
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
          style={[
            styles.sheet,
            // Unten die Navigationsleiste freihalten — das Blatt reicht bis an
            // den Bildschirmrand (randlos), die Liste soll vor ihr enden.
            { backgroundColor: palette.s1, paddingBottom: insets.bottom },
            sheetAnim,
            { top: sheetTop },
          ]}
        >
          {/* Nur noch Zeichen, nicht mehr Griff — gezogen wird überall. Griff
              und Abstand zum Titel wie in jedem Blatt (`SheetHandle`). */}
          <SheetHandle />
          <View style={styles.titleRow}>
            <Text style={styles.title}>{t("home.recent.title")}</Text>
            {/* Keine sichtbare Fläche, nur die Welle — dieselbe Begründung wie
                am Papierkorb der Meldungs-Slide. Der abgeblendete Zustand
                bleibt, er hängt an den Daten und nicht am Finger. */}
            <RippleTouch
              onPress={handleClear}
              hitSlop={10}
              borderless
              disabled={recentSearches.length === 0}
              style={[styles.trashBtn, recentSearches.length === 0 && { opacity: 0.35 }]}
              accessibilityLabel={t("home.recent.clear.title")}
            >
              <Trash2 size={20} color="#FF3B5C" strokeWidth={2} />
            </RippleTouch>
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
                <RecentCard key={s.id} search={s} />
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
  },
  /** Titel und Papierkorb auf einer Mittellinie; 8 bis zum Untertitel wie in
   *  jedem Blatt (`title.marginBottom` dort). */
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: GUTTER,
    marginBottom: SPACE.sm,
  },
  /** Aufschrift des Blattes — dieselbe wie in jedem anderen (SHEET_TITLE). */
  title: { ...SHEET_TITLE, flex: 1 },
  /**
   * Wie der Papierkorb des Mitteilungs-Blatts: keine Fläche, nur die randlose
   * Welle; so hoch wie das Symbol, bündig am rechten Rand. Die Trefferfläche
   * kommt aus `hitSlop`.
   */
  trashBtn: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  subtitle: { ...SHEET_SUBTITLE, marginBottom: GROUP_GAP, paddingHorizontal: GUTTER },
  scroll: { flex: 1 },
  /** Ende der Liste: SECTION_GAP sichtbar — die letzte Karte bringt ITEM_GAP mit. */
  scrollContent: { paddingBottom: SECTION_GAP - ITEM_GAP },
});
