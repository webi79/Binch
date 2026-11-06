import { memo, useEffect, useState, useMemo } from "react";
import { ITEM_GAP } from "@/lib/theme/spacing";
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
import { recentClassKey, recentDepartTime, recentRelaunchParams } from "@/lib/search/recentSearch";
import { de as deLocale, enUS, es as esLocale, fr as frLocale, type Locale as DateLocale } from "date-fns/locale";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore, RecentSearch } from "@/stores/searchStore";
import { TravelMode } from "@/types/search";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { launchResults } from "@/lib/search/launchResults";
import { scaledStyles } from "@/lib/ui/compact";

// Die Doppeltipp-Sperre liegt in lib/search/launchResults.ts — gemeinsam mit den Pendel-Knöpfen.

const C = {
  surface1: "#171719",
  surface2: "#171719",
  white: "#F4F4F5",
  gray1: "#C8C8CC",
  gray2: "#8E8E93",
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

function RecentCardInner({ search }: { search: RecentSearch }) {
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
  /**
   * Was gesucht wurde: Tag, gewählte Uhrzeit, bei Hin- und Rückreise beide
   * Tage — vorher stand hier nur der Hinreisetag.
   */
  const dateLabel = (() => {
    const day = (iso: string) => {
      try {
        return format(parseISO(iso), "d. MMM", { locale: dateLocale });
      } catch {
        return iso;
      }
    };
    const time = recentDepartTime(search);
    const first = time ? `${day(search.departDate)} ${format(time, "HH:mm")}` : day(search.departDate);
    return search.returnDate ? `${first} – ${day(search.returnDate)}` : first;
  })();
  const paxLabel = `${search.passengers} ${
    search.passengers === 1 ? t("search.passenger.singular") : t("search.passenger.plural")
  }`;
  // Die GESUCHTE Klasse — hier stand fest „Economy" bzw. „2. Klasse".
  const classLabel = t(recentClassKey(search));
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
    // Dieselbe Suche wie damals — mit Klasse und Uhrzeit; ein vergangener
    // Reisetag rückt auf heute (lib/search/recentSearch.ts).
    const rp = recentRelaunchParams(search);
    // Sofort öffnen — ohne Router; die Route wird nachgezogen, sobald die
    // Bewegung durch ist (siehe pendingResultsRoute im Store). Sperre und
    // Reihenfolge in lib/search/launchResults.ts.
    if (!launchResults(rp)) return;
    // Nur schließen, wenn wirklich etwas offen ist: Ein ungeschütztes set()
    // weckt jeden Abonnenten — im Berührungs-Frame, direkt vor dem Start.
    if (useSearchStore.getState().recentHistoryOverlayOpen) closeRecentHistoryOverlay();
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
            <Trash2 size={20} color="#F4F4F5" strokeWidth={2.2} />
            <Text style={styles.deleteBtnText}>{t("history.delete")}</Text>
          </Pressable>
        </View>
      )}

      {/* Vordergrund: die eigentliche Card. Pan-Gesture für Swipe-To-Cancel. */}
      <GestureDetector gesture={pan}>
        <Animated.View style={cardAnim}>
          <RippleTouch
            style={[
              styles.recentCard,
              // Eine Karte auf dem Bildschirm ist eine BOX, kein Blatt —
              // deshalb `s2`. Im Verlaufs-Blatt genauso: Das Blatt ist `s1`,
              // die Karte hebt sich ohne Rahmen ab (der Rahmen stammte aus der
              // Zeit, als das Blatt selbst `s2` war, und war nur noch Unruhe).
              { backgroundColor: palette.s2 },
            ]}
            onPress={onCardPress}
            onLongPress={enterDeleteMode}
          >
            {/* Liegt AUF der Karte, also `s3`. Stand hier auf `s2` — demselben
                Ton wie die Karte — und war dadurch unsichtbar. */}
            <View style={[styles.recentIconWrap, { backgroundColor: palette.s3 }]}>
              <Icon size={20} color={C.gray1} strokeWidth={2} />
            </View>
            <View style={styles.recentText}>
              <Text style={styles.recentRoute} numberOfLines={1}>
                {formatEndpoint(search.origin)} – {formatEndpoint(search.destination)}
              </Text>
              <Text style={styles.recentMeta} numberOfLines={1}>
                {dateLabel} · {paxLabel} · {classLabel}
              </Text>
            </View>
            {/**
              * Rechts nur noch der Pfeil, mittig zur Zeile — wie in den
              * Einstellungs-Zeilen (16, `#56565C`).
              *
              * Hier stand eine Akzent-Pille mit dem Währungs-Code („EUR"),
              * darunter der Pfeil. Die Pille sah aus wie ein Preis, sagte aber
              * keinen; sie nahm dem Streckennamen Platz (er wurde früher
              * gekürzt) und schob den Pfeil aus der Mitte in die Ecke. Die
              * Währung gehört zu den Such-Einstellungen und wird beim erneuten
              * Suchen weiter mitgenommen (`recentRelaunchParams`).
              */}
            <ChevronRight size={16} color={C.gray3} strokeWidth={2} />
          </RippleTouch>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

/** Abstand zur nächsten Karte — fährt beim Löschen mit auf null. */
const CARD_GAP = ITEM_GAP;

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
  /**
   * Die Zone beginnt NICHT am linken Rand — und das ist der Rest des
   * Ecken-Problems.
   *
   * Der Kommentar am Mount-auf-Abruf oben stimmt, aber er deckt nur die halbe
   * Ursache: Solange die Karte noch nahe ihrer Ruhelage steht (die ersten
   * Bilder nach dem langen Druck und die letzten beim Zurückgleiten), liegen
   * zwei gerundete Rechtecke mit demselben Radius exakt übereinander. Die
   * Kantenglättung der oberen Ecke ist teildurchsichtig — darunter kommt Rot
   * durch. Sichtbar wurde das links oben und unten, weil rechts ohnehin Rot
   * hingehört.
   *
   * Weiter links als die Wischstrecke (80) wird nie etwas aufgedeckt. Die Zone
   * kann dort also gefahrlos enden, und hinter den linken Ecken der Karte
   * liegt wieder der Bildschirm statt Rot.
   */
  deleteZone: {
    position: "absolute",
    top: 0,
    left: 24,
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
    color: "#F4F4F5",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  recentCard: {
    backgroundColor: C.surface1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  /** 40er-Kachel mit 12er-Radius — die Stufe der Symbol-Kacheln auf Karten. */
  recentIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  recentText: { flex: 1, minWidth: 0 },
  /** 15/600 über 13 — Name und Angaben klar getrennt, beide gut lesbar. */
  recentRoute: { fontSize: 15, fontWeight: "600", color: C.white, letterSpacing: -0.1 },
  recentMeta: { fontSize: 13, color: C.gray2, marginTop: 4 },
});

// Memo-Wrapper: bei einer Liste von 5+ Recent-Cards verhindert das, dass alle
// Cards bei jedem Home-Render neu zeichnen. Nur wenn `search` (das Trip-Objekt
// selbst) sich ändert, wird die einzelne Card aktualisiert.
export const RecentCard = memo(RecentCardInner);
