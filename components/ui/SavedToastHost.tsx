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

import { useCallback, useEffect, useRef } from "react";
import { resultsPush, overlayCover } from "@/lib/nav/overlayCover";
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
import { usePalette } from "@/lib/theme/appBg";
import { scaledStyles } from "@/lib/ui/compact";

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

/**
 * Beide Richtungen über EIGENE Werte, keine Ein-/Aussprung-Animation.
 *
 * Hier stand ein `Keyframe` fürs Hereinfahren und ausdrücklich KEINER fürs
 * Hinausfahren — mit der Begründung, Reanimated halte die native Ansicht nach
 * dem Abbau noch 140ms fest und verzögere damit den Reiter-Wechsel. Die
 * Begründung stimmt, die Folge war aber, dass die Meldung einfach verschwand,
 * statt wieder hochzufahren.
 *
 * Mit eigenen Werten entfällt das Problem an der Wurzel: Wir bestimmen selbst,
 * wann abgebaut wird. Die Meldung fährt hinaus, und ERST DANACH verschwindet
 * sie — Reanimated hält nichts fest, weil gar keine Ein-/Aussprung-Animation
 * mehr im Spiel ist. Für den Weg über „Ansehen" bleibt es beim sofortigen
 * Abbau: Dort wird ohnehin navigiert, und dieser Wechsel soll auf nichts warten.
 */
const TOAST_TRAVEL = -200;
const TOAST_EASE = Easing.bezier(0.18, 0.9, 0.22, 1.04);

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
  const palette = usePalette();
  // Store-Daten zu Mount-Zeit einlesen, danach nicht mehr subscriben —
  // die Toast-Lebenszeit ist von außen kontrolliert (HOLD_MS oder Klick).
  const toastData = useSearchStore.getState().savedToast;
  const clearSelectedResult = useSearchStore.getState().clearSelectedResult;


  /** Position und Deckkraft der Meldung — siehe Begründung oben. */
  const ty = useSharedValue(TOAST_TRAVEL);
  const op = useSharedValue(0);
  const toastStyle = useAnimatedStyle(() => ({
    opacity: op.value,
    transform: [{ translateY: ty.value }],
  }));
  /**
   * Hinausfahren und ERST DANACH abbauen. Der Riegel fängt den Fall ab, dass
   * die Haltezeit abläuft, während schon von Hand geschlossen wurde.
   */
  const closingRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideOut = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    ty.value = withTiming(TOAST_TRAVEL, { duration: SLIDE_DURATION, easing: TOAST_EASE });
    op.value = withTiming(0, { duration: SLIDE_DURATION });
    hideTimer.current = setTimeout(hide, SLIDE_DURATION);
  }, [hide, ty, op]);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

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
    // Hereinfahren im nächsten Bild — der Baum steht dann, die Bewegung läuft
    // nicht gegen seinen Aufbau an.
    const raf = requestAnimationFrame(() => {
      ty.value = withTiming(0, { duration: SLIDE_DURATION, easing: TOAST_EASE });
      op.value = withTiming(1, { duration: SLIDE_DURATION });
    });
    const dismiss = setTimeout(slideOut, HOLD_MS);
    return () => {
      cancelAnimationFrame(raf);
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
    // Welches Ergebnis war offen, als getippt wurde? Im Handler lesen, nicht im
    // Render — dort würde es bei jedem Render überschrieben und der Wächter unten
    // verglichen gegen die NEUE Auswahl, also genau gegen die, die er schützen soll.
    const openId = useSearchStore.getState().selectedResult?.id;
    /**
     * Den Ergebnis-Bildschirm SOFORT wegstellen, bevor der Reiter wechselt.
     *
     * Die Marke oben überspringt nur seine Rückfahrt — stehen bleibt er
     * trotzdem, in voller Größe und an seiner Endposition, bis die Route beim
     * Wechsel abgeräumt wird. Der Reiter-Wechsel lief also über einen
     * bildschirmfüllenden Baum hinweg, der erst irgendwann darin verschwand.
     * Das ist das „ich bugge mich durch mehrere Reiter": Man sieht die
     * Ergebnisse, dann den darunterliegenden Reiter, dann das Ziel.
     *
     * Beides ohne Bewegung: Der Fortschritt springt auf 0 (der Baum liegt damit
     * rechts außerhalb, wo er im Ruhezustand ohnehin liegt), und der geteilte
     * Parallax-Wert geht mit, damit die Unterlage nicht verschoben stehenbleibt.
     * Sichtbar ist davon nichts — es passiert im selben Bild wie der Wechsel.
     */
    /**
     * ERST wechseln, DANN wegstellen — die Reihenfolge war falsch herum.
     *
     * Ich hatte den Ergebnis-Bildschirm vor dem Wechsel geparkt, damit der
     * Reiter-Wechsel nicht über ihn hinwegläuft. Damit lag aber für die Dauer
     * des Wechsels der Home-Reiter frei, und genau der blitzte auf. Der
     * Kommentar unten warnt seit jeher vor exakt diesem Bild.
     *
     * Richtig ist die andere Reihenfolge: Der Ergebnis-Bildschirm deckt den
     * Wechsel ab und verschwindet erst, wenn der Saved-Reiter darunter steht.
     * Zwei Bilder Abstand, weil der Wechsel selbst einen Commit braucht — dann
     * gibt es weder ein Aufblitzen noch ein Durchwandern.
     *
     * Ohne Bewegung: Der Fortschritt springt auf 0, also dorthin, wo der Baum im
     * Ruhezustand ohnehin liegt (rechts außerhalb). Der geteilte Parallax-Wert
     * geht mit, sonst bliebe die Unterlage verschoben stehen.
     */
    router.dismissTo("/(tabs)/saved");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        resultsPush.value = 0;
        overlayCover.value = 0;
        useSearchStore.getState().setResultsParams(null);
      }),
    );
    // KEINE direkte clearSelectedResult-Aufrufung mehr! Der DetailsContent-
    // Subtree ist riesig (useQuery + viele Reanimated-Hooks + ScrollView).
    // Ein synchrones Unmount während der Tab-Switch + Modal-Pop läuft,
    // war wahrscheinlich der UI-Thread-Spike der die App permanent laggig
    // anfühlen ließ. Stattdessen 2s deferred — bis dahin hat der User sich
    // visuell schon längst auf der Saved-Tab eingelebt, und das Unmount
    // passiert unsichtbar im Hintergrund.
    setTimeout(() => {
          // NUR löschen, wenn immer noch DAS Ergebnis offen ist, um das es hier
          // ging. Der Toast ist längst weg, wenn dieser Zeitgeber feuert — wer in
          // den zwei Sekunden zurück in die Liste geht und eine andere Karte
          // öffnet, bekam sein frisch geöffnetes Detail sonst kommentarlos wieder
          // zugemacht (die Aktion nullt auch die Bein-Zeitleiste mit).
          const st = useSearchStore.getState();
          if (st.selectedResult?.id !== openId) return;
          clearSelectedResult();
        }, 2000);
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
        style={[styles.layer, { top: (insets.top || 0) + 10 }, toastStyle]}
      >
        <View style={[styles.toast, { backgroundColor: palette.s3 }]}>
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

const styles = scaledStyles({
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
