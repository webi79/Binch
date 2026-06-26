/**
 * SavedToastHost — "Ticket gespeichert" Toast-Popup (Premium-Glide).
 *
 *  - Toast gleitet von oben rein (Overshoot-Bezier) wenn savedToast gesetzt
 *  - Nach Slide-Ende: Glow-Ring pulst einmal, Häkchen zeichnet sich
 *  - Hold ~2.6s, dann automatisch ausgleiten
 *  - User kann auf "Ansehen" tippen → Navigation + Cleanup
 *
 * Mount/Unmount-Pattern: solange kein Toast aktiv ist, ist nichts gemountet.
 * Keine Reanimated-Subscriptions, keine GestureDetector-Native-Recognizers
 * im Leerlauf.
 */

import { useCallback, useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Keyframe,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";

const AnimatedPath = Animated.createAnimatedComponent(Path);

const HOLD_MS = 2600;
const SLIDE_DURATION = 380;
const RING_DURATION = 420;
const CHECK_DURATION = 280;
const CHECK_LEN = 26;

const SURFACE = "#2A2A2C";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT_PRIMARY = "#FFFFFF";
const TEXT_TERTIARY = "#8A8A90";
const ICON_INK = "#123007";

const toastEntering = new Keyframe({
  0: { opacity: 0, transform: [{ translateY: -200 }] },
  100: {
    opacity: 1,
    transform: [{ translateY: 0 }],
    easing: Easing.bezier(0.18, 0.9, 0.22, 1.04),
  },
}).duration(SLIDE_DURATION);

// KEIN exiting Keyframe — Reanimated hielt sonst die native View 140ms
// nach dem Unmount fest und das verzögert Tab-Switch + Overlay-Cleanup.
// Toast verschwindet jetzt instant beim Unmount.

export function SavedToastHost() {
  const toast = useSearchStore((s) => s.savedToast);
  if (!toast) return null;
  return <Toast key={toast.key} />;
}

function Toast() {
  const hide = useSearchStore((s) => s.hideSavedToast);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const t = useT();
  const accent = useAccent();
  // Store-Daten zu Mount-Zeit einlesen, danach nicht mehr subscriben —
  // die Toast-Lebenszeit ist von außen kontrolliert (HOLD_MS oder Klick).
  const toastData = useSearchStore.getState().savedToast;
  const clearSelectedResult = useSearchStore.getState().clearSelectedResult;

  const ring = useSharedValue(0);
  const check = useSharedValue(0);

  useEffect(() => {
    // Innere Animationen erst nach Slide-In starten (UI-Thread via withDelay).
    ring.value = withDelay(
      SLIDE_DURATION,
      withTiming(1, { duration: RING_DURATION, easing: Easing.out(Easing.ease) }),
    );
    check.value = withDelay(
      SLIDE_DURATION,
      withTiming(1, { duration: CHECK_DURATION, easing: Easing.out(Easing.cubic) }),
    );
    const dismiss = setTimeout(hide, HOLD_MS);
    return () => {
      clearTimeout(dismiss);
      cancelAnimation(ring);
      cancelAnimation(check);
    };
  }, [ring, check, hide]);

  const onPressCta = useCallback(() => {
    haptic("button");
    cancelAnimation(ring);
    cancelAnimation(check);
    // Flag setzen damit der results-Screen seine 260ms Slide-Out-Animation
    // überspringt — sonst läuft die parallel zu Tab-Switch + Overlay-Unmount
    // = UI-Thread-Spike. Modal pop'pt instant, kein Konflikt.
    useSearchStore.getState().setBypassResultsSlideOut(true);
    hide();
    // dismissTo statt navigate: dismisst die Modal-Schichten UND switcht
    // die Tab in EINER atomaren Aktion. Vorher (router.navigate) machte
    // expo-router das in zwei separaten State-Updates, was dazu führte dass
    // der User einen Frame lang den Home-Tab sah (= Reanimated unfreeze
    // + Re-Mount-Churn) BEVOR der Saved-Tab fokussiert wurde.
    router.dismissTo("/(tabs)/saved");
    // KEINE direkte clearSelectedResult-Aufrufung mehr! Der DetailsContent-
    // Subtree ist riesig (useQuery + viele Reanimated-Hooks + ScrollView).
    // Ein synchrones Unmount während der Tab-Switch + Modal-Pop läuft,
    // war wahrscheinlich der UI-Thread-Spike der die App permanent laggig
    // anfühlen ließ. Stattdessen 2s deferred — bis dahin hat der User sich
    // visuell schon längst auf der Saved-Tab eingelebt, und das Unmount
    // passiert unsichtbar im Hintergrund.
    setTimeout(() => clearSelectedResult(), 2000);
  }, [ring, check, hide, router, clearSelectedResult]);

  const ringStyle = useAnimatedStyle(() => {
    const r = ring.value;
    const scale =
      r < 0.35 ? 0.7 + (r / 0.35) * 0.3 : 1 + ((r - 0.35) / 0.65) * 0.5;
    const opacity =
      r < 0.2 ? (r / 0.2) * 0.9 : 0.9 * (1 - (r - 0.2) / 0.8);
    return { opacity, transform: [{ scale }] };
  });

  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_LEN * (1 - check.value),
  }));

  if (!toastData) return null;

  const numStr = toastData.price.toFixed(0);
  const ccy = toastData.currency.toUpperCase();
  const pre = `${t("results.from").toUpperCase()} `;
  const post = ` ${ccy}`;

  return (
    <View
      pointerEvents="box-none"
      style={[StyleSheet.absoluteFillObject, styles.host]}
    >
      <Animated.View
        entering={toastEntering}
        style={[styles.layer, { top: (insets.top || 0) + 10 }]}
      >
        <View style={styles.toast}>
            <View style={styles.iconWrap}>
              <Animated.View
                style={[
                  styles.ring,
                  { borderColor: accent.solid },
                  ringStyle,
                ]}
              />
              <View
                style={[styles.iconBox, { backgroundColor: accent.solid }]}
              >
                <Svg width={34} height={34} viewBox="0 0 24 24">
                  <AnimatedPath
                    d="M6 12.5 l4 4 l8 -8.5"
                    fill="none"
                    stroke={ICON_INK}
                    strokeWidth={4.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray={CHECK_LEN}
                    animatedProps={checkProps}
                  />
                </Svg>
              </View>
            </View>

            <View style={styles.body}>
              <Text style={styles.title} numberOfLines={1}>
                {t("toast.saved.title")}
              </Text>
              <Text style={styles.sub} numberOfLines={1}>
                {pre}
                <Text style={[styles.subStrong, { color: accent.solid }]}>
                  {numStr}
                </Text>
                {post}
              </Text>
            </View>

            <TouchableOpacity onPress={onPressCta} hitSlop={10}>
              <Text style={styles.cta}>{t("toast.saved.view")}</Text>
            </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    zIndex: 1000,
    elevation: 32,
  },
  layer: {
    position: "absolute",
    left: 14,
    right: 14,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: SURFACE,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 14,
    paddingLeft: 14,
    paddingRight: 18,
    shadowColor: "#000",
    shadowOpacity: 0.55,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 16 },
    elevation: 32,
  },
  iconWrap: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 66,
    height: 66,
    borderRadius: 22,
    borderWidth: 2,
  },
  iconBox: {
    width: 54,
    height: 54,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: TEXT_PRIMARY,
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  sub: {
    color: TEXT_TERTIARY,
    fontSize: 14,
    fontWeight: "600",
    marginTop: 2,
  },
  subStrong: {
    fontWeight: "800",
  },
  cta: {
    color: TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    textDecorationLine: "underline",
    paddingHorizontal: 4,
  },
});
