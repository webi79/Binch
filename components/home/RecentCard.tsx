import { memo, useEffect, useState, useMemo } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
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
import { prepareLayer, releaseLayer } from "@/lib/nav/transitionLayer";
import { startResultsPush } from "@/lib/nav/overlayCover";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Die Doppeltipp-Sperre gilt für ALLE Verlaufskarten gemeinsam.
 *
 * Sie lag als `useRef` in der Karte, war also eine Sperre je Exemplar — und
 * schützte damit genau nicht gegen den Fall, den ihr eigener Kommentar
 * beschreibt: Karte A antippen, dann während der Bewegung Karte B. B hat eine
 * eigene, ungesetzte Sperre, der Aufruf geht durch, `startResultsPush()` läuft
 * ein zweites Mal — und der setzt den Fortschritt auf 0 zurück. Die schon halb
 * hereingefahrene Liste springt hart nach rechts aus dem Bild und fährt neu
 * ein, mit den Parametern der zweiten Karte, die mitten in der Bewegung
 * überschrieben wurden.
 *
 * Auf Modulebene gibt es dieses Loch nicht. Der Such-Screen hat dasselbe
 * Problem nicht, weil es dort nur einen Knopf gibt.
 */
let openLocked_ = false;
function openLocked(): boolean {
  return openLocked_;
}
function lockOpen(): void {
  openLocked_ = true;
}
function unlockOpen(): void {
  openLocked_ = false;
}

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
  const palette = usePalette();
  const t = useT();
  const router = useRouter();
  const locale = useSearchStore((s) => s.locale);
  const closeRecentHistoryOverlay = useSearchStore((s) => s.closeRecentHistoryOverlay);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  // Gemessene Höhe der Karte — Ausgangswert fürs Zusammenfahren.
  const cardH = useSharedValue(0);
  const collapse = useSharedValue(1);
  const [collapsing, setCollapsing] = useState(false);
  const collapseStyle = useAnimatedStyle(() => ({
    height: cardH.value * collapse.value,
    marginBottom: CARD_GAP * collapse.value,
    opacity: collapse.value,
  }));
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
    // Zwei getrennte Schritte, und zwar in dieser Reihenfolge:
    //
    //   1. Die Karte trägt sich nach links aus.
    //   2. ERST DANN schließt sich die Lücke, die sie hinterlässt.
    //
    // Vorher gab es nur Schritt 1, und der Eintrag verschwand mitten in der
    // Bewegung aus dem Speicher. Die Karte wurde damit schlagartig aus dem
    // Layout genommen und alles darunter sprang hoch — die Bewegung nach links
    // sah man dann gar nicht mehr zu Ende. Genau das wirkte kaputt.
    translateX.value = withTiming(-400, { duration: 220, easing: EASING_OUT }, (finished) => {
      "worklet";
      if (finished) runOnJS(setCollapsing)(true);
    });
  }

  // Schritt 2: Höhe und Außenabstand auf null fahren. Weil das echte Layout-
  // Werte sind, rückt alles darunter währenddessen von selbst nach oben — und
  // zwar stetig statt in einem Satz. Entfernt wird der Eintrag erst am Ende,
  // wenn die Lücke schon zu ist; dadurch gibt es keinen Sprung mehr.
  useEffect(() => {
    if (!collapsing) return;
    /**
     * Die Textur des Landingscreens MUSS hier weg.
     *
     * Angefordert hat sie das Aufsetzen des Fingers auf diese Karte (siehe
     * `onTouchStart` unten) — gedacht für den Fall, dass daraus ein Tipp auf die
     * Suche wird. Aus einem Langdruck plus Tipp auf den Mülleimer wird stattdessen
     * DIESE Animation, und die ist der denkbar schlechteste Inhalt für eine
     * gehaltene Ebene: Sie fährt `height` und `marginBottom` auf null, also echte
     * Layout-Werte. Jedes Bild ist damit ein Yoga-Durchgang, der den Inhalt der
     * Scroll-Fläche verändert — und macht die bildschirmfüllende Textur darüber
     * jedes Mal ungültig. Sie wird dann in jedem Bild neu gezeichnet UND neu
     * hochgeladen (14,7ms gegen 8,3ms Budget), statt einmal.
     *
     * Ohne Ebene ist es die gewöhnliche Layout-Animation, die sie vorher war.
     */
    releaseLayer("home");
    collapse.value = withTiming(0, { duration: 220, easing: EASING_OUT }, (finished) => {
      "worklet";
      if (finished) runOnJS(removeRecentSearch)(search.id);
    });
  }, [collapsing, collapse, removeRecentSearch, search.id]);

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
  /**
   * In `useMemo` — sonst entsteht der Erkenner bei jedem Render neu.
   *
   * Jedes neue `Gesture.Pan()`-Objekt muss der Detektor gegen seinen nativen
   * Gegenpart abgleichen und neu einrichten. Die anderen Blätter der App haben
   * das längst; diese drei waren übrig.
   */
  const pan = useMemo(() =>
    Gesture.Pan()
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
    }),
  [deleteMode, cardH, collapse, translateX, startX, removeRecentSearch, search.id]);

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
      // Den Code nur anhängen, wenn er nicht schon drinsteht.
      //
      // Das Backend baut die Flug-Labels bereits als „Name (IATA)"
      // (`server/src/db/seed.ts`). Blind angehängt stand hier deshalb immer
      // „Rome Fiumicino (FCO) (FCO)". Geprüft wird auf die geklammerte Form,
      // nicht auf ein bloßes Vorkommen der drei Buchstaben — sonst schluckt
      // ein Ort wie „Bari" seinen eigenen Code BRI nicht, aber „Cork (ORK)"
      // verlöre ihn wegen des Treffers in „Cork".
      if (!isCleanCode(e.code)) return city;
      return city.includes(`(${e.code})`) ? city : `${city} (${e.code})`;
    }
    return e.label;
  };

  function open() {
    // Doppeltipp-Sperre, wie am Suchen-Knopf: Ein zweiter Tipp riefe
    // `startResultsPush()` erneut auf, das setzt den Wert auf 0 zurück — die
    // schon reingefahrene Liste springt hart nach rechts aus dem Bild — und legte
    // zusätzlich eine zweite Route samt zweiter Suche an.
    //
    // 400ms statt 900: Ein echter Doppeltipp liegt darunter. Bei 900 war der
    // Knopf danach spürbar tot — zurück und sofort dieselbe Karte nochmal tippen
    // ging nicht, und das liest sich als kaputter Knopf, nicht als Schutz.
    if (openLocked()) return;
    lockOpen();
    setTimeout(unlockOpen, 400);

    // SOFORT navigieren, parallel das Overlay schließen. Vorher
    // setTimeout 280ms = spürbarer Input-Lag. Die Slide-Out des Overlays
    // läuft auf der UI-Thread (Reanimated), parallel zur Slide-In des
    // Results-Screens (auch UI-Thread, via InteractionManager+rAF in
    // app/search/results.tsx) → kein Konflikt mehr.
    // Nur schließen, wenn wirklich etwas offen ist: Ein ungeschütztes set()
    // weckt jeden Abonnenten — und das im Berührungs-Frame, direkt bevor die
    // Navigation startet. Dasselbe Muster wie beim Tab-Tipp in (tabs)/_layout.
    if (useSearchStore.getState().recentHistoryOverlayOpen) closeRecentHistoryOverlay();
    // Sofort öffnen — ohne Router. Die Route wird nachgezogen, sobald die
    // Bewegung durch ist (siehe pendingResultsRoute im Store).
      // Textur des Landingscreens anlegen, solange der Finger gerade abhebt.
      //
      // Das fehlte, und es ist der ganze Unterschied zum Saved-Tab — dem einzigen
      // Übergang, den der Nutzer von sich aus „smooth" nennt. Dort steht
      // `prepareLayer("saved")` genau hier, im bestätigten Tipp (TicketCard).
      // Hier stand nichts: Der Ergebnis-Bildschirm HÄLT die Textur des
      // Landingscreens (`holdLayer("home")`) und gibt sie wieder frei — nur
      // angefordert hat sie nie jemand, und `holdLayer` legt bewusst keine an.
      // Der Landingscreen wurde also während der ganzen Bewegung jedes Bild neu
      // gezeichnet: bildschirmfüllend, mit Bildern und Verläufen. Das sind die
      // Mikro-Ruckler, die aus dem Landingscreen blieben, im Saved-Tab aber nicht.
      //
      // Im FINGERDRUCK darf das nicht stehen — dort wird jede Berührung zur
      // Textur, auch die, die in Wirklichkeit ein Scrollen wird, und das Anlegen
      // und Abräumen fiel dann in den Scroll-Start. Im bestätigten Tipp gibt es
      // dieses Problem nicht: Er feuert nur, wenn wirklich getippt wurde.
      // Angefordert wird sie beim AUFSETZEN (siehe `onTouchStart` am Rahmen
      // unten). Hier stand sie im bestätigten Tipp, also im Loslassen — damit
      // fiel der 66ms-Aufbau in den Berührungs-Frame und lief noch, als die
      // Bewegung schon startete.
    const rp = {
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
      } as Record<string, string>;
    // Ein Bild Abstand zwischen Textur-Flip und Öffnen.
    //
    // React fasst sonst beides in EINEN Commit: die Unterlage wird auf eine
    // Hardware-Ebene gehoben UND der Ergebnis-Baum sichtbar gemacht. Zwei
    // bildschirmfüllende Aufbauten im selben Bild, direkt bevor die Bewegung
    // anläuft. Beim Ticket-Übergang liegen genau deshalb zwei Commits
    // dazwischen — und der gilt als der glatte.
    /**
     * Die Bewegung ZUERST — vor allem, was danach kommt.
     *
     * Sie startete bisher im Ergebnis-Bildschirm, in einem Effekt. Der läuft
     * aber erst, NACHDEM die beiden Schreibvorgänge darunter jeden Abonnenten
     * geweckt und Fabric den ganzen Ergebnis-Baum sichtbar gemacht haben. Genau
     * diese Strecke lag zwischen Finger und erster Regung, und in ihr steckten
     * auch die Mikro-Ruckler: Die Bewegung fing an, während der Commit noch
     * lief.
     */
    startResultsPush();
    /**
     * Die beiden Schreibvorgänge ein Bild später — wie am Suchen-Knopf.
     *
     * `setResultsParams` macht die Ergebnis-Ansicht sichtbar: über 2000 Zeilen,
     * dauerhaft an der Wurzel. Der Commit dazu läuft bei einem Loslass-Ereignis
     * SYNCHRON noch in diesem Aufruf zu Ende, während `startResultsPush` seine
     * Bewegung nur einreiht und sie erst im Microtask danach zugestellt wird.
     * Die Reihenfolge oben half also nichts: Erst lief der ganze Aufbau, dann
     * erst fuhr etwas los.
     *
     * Der Such-Screen legt dieselben zwei Aufrufe längst in ein Bild Abstand;
     * dieser Pfad war als einziger nicht nachgezogen.
     */
    requestAnimationFrame(() => {
      useSearchStore.getState().setPendingResultsRoute(rp);
      useSearchStore.getState().setResultsParams(rp);
    });
  }

  return (
    // Wrapper hat overflow:hidden + borderRadius damit beim Sliden nach links
    // nicht über den linken Rand der Card-Position hinausragt UND die Lösch-
    // Zone sauber durch die rounded Corner abgegrenzt wird.
    <Animated.View
      style={[styles.cardWrap, collapsing && collapseStyle]}
      // Solange nicht zusammengefahren wird, halten wir die aktuelle Höhe fest.
      onLayout={(e) => {
        if (!collapsing) cardH.value = e.nativeEvent.layout.height;
      }}
    >
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
        {/* Textur des Landingscreens beim AUFSETZEN anfordern — nicht im
            bestätigten Tipp. Dort fiel der 66ms-Aufbau in den Berührungs-Frame
            und lief noch, als die Bewegung schon startete. Die Ticket-, Reise-
            und Ergebnis-Karte machen es längst so. `onTouchStart` und nicht
            `onPressIn`: In einer Liste wird ein Druck-Beginn oft ein Scrollen,
            und das reine Berührungs-Ereignis beansprucht die Geste nicht. */}
        <Animated.View style={cardAnim} onTouchStart={() => prepareLayer("home")}>
          <RippleTouch
            style={[
              styles.recentCard,
              { backgroundColor: palette.s1 },
              bordered && [styles.recentCardBordered, { borderColor: palette.border }],
            ]}
            onPress={onCardPress}
            onLongPress={enterDeleteMode}
          >
            <View style={[styles.recentIconWrap, { backgroundColor: palette.s2 }]}>
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
    </Animated.View>
  );
}

/** Abstand zur nächsten Karte — fährt beim Löschen mit auf null. */
const CARD_GAP = 8;

const styles = scaledStyles({
  cardWrap: {
    marginHorizontal: 20,
    marginBottom: CARD_GAP,
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
