import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Dimensions, Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Trash2, X } from "lucide-react-native";
import {
  NotificationsEmpty,
  type NotificationsEmptyVariant,
} from "@/components/home/NotificationsEmpty";
import { ClearSearchHistoryAlert } from "@/components/ui/ClearSearchHistoryAlert";
import { SHEET_TITLE } from "@/components/ui/SheetModal";
import { SHEET_IN } from "@/lib/nav/overlayCover";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER, SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { useSheetSwipe } from "@/lib/ui/sheetSwipe";
import { useSearchStore } from "@/stores/searchStore";

const C = {
  white: "#F4F4F5",
  /** Der X-Knopf trägt in Ortswähler, Bo und Spracheingabe denselben Ton. */
  closeIcon: "#E5E7EB",
  /** Papierkorb-Rot — derselbe Wert wie im Verlaufs-Blatt. */
  danger: "#FF3B5C",
};

/**
 * Die Fensterhöhe EINMAL beim Laden, wie bei beiden Wählern.
 *
 * Nicht die Gerätehöhe (die enthält Status- und Navigationsleiste, das wären bei
 * gleicher Dauer rund 9% mehr Tempo) und nicht laufend gelesen: Unter
 * `adjustResize` schrumpft sie mit der Tastatur, und dann führe das Blatt beim
 * nächsten Öffnen eine andere Strecke.
 */
const WINDOW_H = Dimensions.get("window").height;

/** Obere Ecken des Blattes — derselbe Radius wie an allen Blättern der App. */
const SHEET_RADIUS = 28;

/**
 * Die drei leeren Zustände — bei jedem Öffnen ein anderer.
 *
 * `nextVariant` würfelt bewusst nur unter den ANDEREN: Bei drei Möglichkeiten
 * käme rein zufällig im Schnitt jedes dritte Mal dieselbe wieder, und zweimal
 * hintereinander dasselbe Bild liest sich nicht als Abwechslung, sondern als
 * kaputter Zufall.
 */
const VARIANTS: NotificationsEmptyVariant[] = ["ghostRows", "zero", "boIcon"];

function randomVariant(): NotificationsEmptyVariant {
  return VARIANTS[Math.floor(Math.random() * VARIANTS.length)];
}

function nextVariant(current: NotificationsEmptyVariant): NotificationsEmptyVariant {
  const others = VARIANTS.filter((v) => v !== current);
  return others[Math.floor(Math.random() * others.length)];
}

/**
 * Das Benachrichtigungs-Blatt hinter der Glocke im Landingscreen.
 *
 * DREI Dinge sind hier absichtlich so und nicht anders:
 *
 * **Die Fahrt kommt aus `useSheetSlide`.** Kein eigener Wert, keine eigene
 * Kurve, keine eigene Dauer — dieselbe Funktion, die Ort- und Datumswähler
 * fahren. Genau dafür gibt es sie: Die drei Blätter waren einmal
 * auseinandergelaufen (250 gegen 300ms, Geräte- gegen Fensterhöhe), und das war
 * der Unterschied zwischen „elegant" und „ruckelt". Ein viertes Blatt mit
 * eigenen Zahlen hätte dieselbe Sammlung wieder aufgemacht.
 *
 * **Es fährt NICHT bis nach oben.** Die Oberkante bleibt an der Unterkante der
 * Kopfzeile des Landingscreens stehen, also genau dort, wo darunter die
 * Suchleiste beginnt — die ist damit vollständig verdeckt, „Binch" und die
 * Glocke bleiben stehen. Der Wert dafür ist hergeleitet (`HOME_HEADER_H` im
 * Raster), nicht abgemessen: Ändert jemand den Takt der Kopfzeile, wandert die
 * Kante mit.
 *
 * Und er kommt beim ÖFFNEN vom Landingscreen, nicht von hier. Die Kopfzeile ist
 * kein festes Chrome — sie liegt in dessen Scroll-Fläche und wandert mit. Als
 * feste Zahl gerechnet hielt das Blatt stur bei „ungescrollt", und wer die
 * Glocke antippte, während sie schon ein Stück hochgewandert war, sah über dem
 * Blatt einen Streifen der Suchleiste. Siehe `notificationsRestY`.
 *
 * **Es liegt am Wurzel-Layout, nicht im Landingscreen.** Nur von dort deckt es
 * die Tab-Leiste mit ab; im Tab läge es darunter, und man könnte während des
 * offenen Blattes den Tab wechseln.
 */
export function NotificationsSheet() {
  const t = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const open = useSearchStore((s) => s.notificationsOpen);
  const close = useSearchStore((s) => s.closeNotifications);
  const clearItems = useSearchStore((s) => s.clearNotifications);
  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * Die LAGE des Blattes ist fest, sein RUHEPUNKT wandert.
   *
   * Beides auseinanderzuhalten ist der Kern dieser Datei. Das Blatt wird immer
   * an derselben Stelle aufgebaut — direkt unter der sicheren Fläche, also so
   * hoch, wie es überhaupt stehen darf. Wo es zur Ruhe kommt, entscheidet der
   * Landingscreen beim Antippen der Glocke: an der Unterkante seiner Kopfzeile,
   * und die wandert beim Scrollen mit.
   *
   * Der Ruhepunkt ist deshalb eine ZUSÄTZLICHE Verschiebung, kein anderer
   * Aufbau. Zwei Dinge fallen damit weg, die sonst Ärger machen: Die Höhe des
   * Blattes ändert sich nie (kein Neuvermessen beim Öffnen), und die STRECKE
   * der Fahrt ist immer dieselbe — ob gescrollt oder nicht, die Bewegung sieht
   * identisch aus.
   */
  const top = insets.top;
  /** Der Parkplatz ist die eigene Höhe: So steht es geschlossen ganz unter dem Bild. */
  const park = Math.max(1, WINDOW_H - top);
  const restY = useSearchStore((s) => s.notificationsRestY);

  // `style` der gemeinsamen Fahrt bleibt ungenutzt: Sie schreibt nur `y`, und
  // der Transform unten setzt sich aus `y` UND dem Ruhepunkt zusammen.
  const { y, run, adopt, parkNow, warm } = useSheetSlide("notifications", park);

  /**
   * Fahrt PLUS Ruhepunkt in einem Transform.
   *
   * `useSheetSlide` fährt immer auf 0 zu — das ist gut so, es ist dieselbe
   * Funktion wie bei beiden Wählern und darf für dieses eine Blatt nicht
   * angefasst werden. Der Ruhepunkt kommt deshalb hier obendrauf, statt in der
   * gemeinsamen Fahrt. Geparkt steht das Blatt dadurch sogar noch etwas tiefer
   * als sonst; unter dem Bild ist unter dem Bild.
   */
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: y.value + restY }],
  }));

  /**
   * Gewürfelt wird WÄHREND des Renderns, nicht in einem Effekt.
   *
   * Das ist hier kein Kunststück, sondern der Punkt: Ein Effekt läuft NACH dem
   * Durchgang, in dem `open` kippt — der Wechsel des Bildes wäre also ein
   * zweiter Durchgang, und der fiele genau in den Anlauf der Fahrt. Setzt man
   * den Zustand im selben Durchgang, wiederholt React ihn sofort und schreibt
   * erst danach in den Baum: ein einziger Commit, und der liegt vollständig vor
   * der Bewegung.
   *
   * Damit steht die neue Variante schon fertig da, wenn die Kurve ein Bild
   * später losläuft.
   */
  const [variant, setVariant] = useState<NotificationsEmptyVariant>(randomVariant);
  const shownFor = useRef(open);
  if (shownFor.current !== open) {
    shownFor.current = open;
    if (open) setVariant(nextVariant);
  }

  /**
   * Die Verdunkelung hängt am SELBEN Wert wie die Fahrt.
   *
   * Kein zweiter Wert, keine zweite Kurve: Sie ist schlicht der zurückgelegte
   * Anteil der Strecke. Damit kann sie gar nicht aus dem Takt geraten, und sie
   * kostet nichts — es ist dasselbe Worklet.
   */
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - y.value / park }));

  /**
   * Den echten Weg EINMAL kalt anlaufen lassen — sonst ruckelt das erste Öffnen.
   *
   * Wirklich nur einmal: `warm` bekommt mit `park` eine neue Kennung, und es
   * setzt das Blatt auf den Parkplatz zurück. Ohne den Merker risse eine späte
   * Änderung der sicheren Fläche ein offenes Blatt zu. (`park` hängt nur noch an
   * der sicheren Fläche, nicht mehr am Ruhepunkt — der ist seit der Trennung
   * von Lage und Ruhepunkt kein Teil der Strecke mehr.)
   */
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current) return;
    /**
     * EIN Bild später — sonst löscht das Parken den Anlauf sofort wieder.
     *
     * Die Effekte laufen in der Reihenfolge, in der sie hier stehen, und der
     * dritte ruft beim Aufbau `parkNow()`. Das bricht eine laufende Kurve ab —
     * also genau die, die der Anlauf gerade eingereiht hat, bevor sie ihr erstes
     * Bild bekommt. Der Anlauf wäre damit wirkungslos, und das erste Öffnen
     * ruckelte weiter. Beide Wähler stoßen ihn aus demselben Grund über ein Bild
     * an (`LocationPicker`, `BinchDatePicker`).
     */
    /** Der Merker gehört IN den Rückruf: Vorher gesetzt und das Bild danach
     *  abgeräumt (geänderter Parkplatz), stiege der zweite Lauf am Merker aus —
     *  der Anlauf fände dann nie statt. */
    const id = requestAnimationFrame(() => {
      warmed.current = true;
      warm();
    });
    return () => cancelAnimationFrame(id);
  }, [warm]);

  /**
   * Nur bei echtem WECHSEL fahren.
   *
   * `run` bekommt eine neue Kennung, sobald sich `park` ändert (die sichere
   * Fläche trifft erst nach dem ersten Durchgang ein). Ohne diesen Merker liefe
   * die Fahrt dann ein zweites Mal los, mit unverändertem Zustand — mitten in
   * die schon laufende Bewegung hinein.
   */
  const lastOpen = useRef(false);
  /** Wann die Einfahrt begonnen hat — siehe `dismissFromScrim`. */
  const enteredAt = useRef(0);
  useEffect(() => {
    if (lastOpen.current === open) return;
    lastOpen.current = open;
    if (open) enteredAt.current = Date.now();
    run(open);
  }, [open, run]);

  /**
   * Wisch nach unten schließt — dieses Blatt hatte als einziges gar keine Geste.
   *
   * Die Ausfahrt fährt die GESTE, im Bild des Loslassens, auf dem UI-Strang.
   * Das war zuerst anders herum gebaut — die Geste meldete nur `close()`, und
   * die gemeinsame Fahrt übernahm. Dazwischen lagen aber drei Dinge: der Sprung
   * auf den JS-Strang, ein React-Durchgang für den geänderten Zustand und das
   * Bild Vorlauf, das `run` bewusst einlegt. Das Blatt blieb dadurch in genau
   * dem Moment stehen, in dem der Finger das Glas verließ.
   *
   * Damit die gemeinsame Fahrt trotzdem Bescheid weiß, bekommt sie die Bewegung
   * als BUCHUNG (`adopt`) — und `lastOpen` wird von Hand nachgezogen, damit der
   * Effekt darunter dieselbe Ausfahrt nicht ein zweites Mal ansetzt. Zwei
   * Kurven auf demselben Wert wären als Tempo-Wechsel zu sehen.
   *
   * Die Verdunkelung geht ohne Zutun mit: Sie hängt am selben Wert (siehe
   * `scrimStyle`). Beim Ziehen hellt sich der Landingscreen also schon auf,
   * bevor losgelassen wird.
   */
  const dismissBySwipe = useCallback(
    (durationMs: number, fromY: number) => {
      adopt(false, durationMs, fromY);
      lastOpen.current = false;
      close();
    },
    [adopt, close],
  );
  const panGesture = useSheetSwipe({
    y,
    travel: park,
    onDismiss: dismissBySwipe,
    // Das Blatt hängt dauerhaft am Wurzel-Layout. Ein dauerhaft scharfer
    // Erkenner läge über dem ganzen Landingscreen — auch geschlossen.
    enabled: open,
  });

  /** Geänderter Parkplatz (sichere Fläche trifft ein) — neu parken, solange zu. */
  useEffect(() => {
    if (!open) parkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [park]);

  /** Zurück-Taste schließt das Blatt, statt den Tab zu verlassen. */
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [open, close]);

  const dismiss = () => {
    haptic("button");
    close();
  };

  /**
   * IMMER fragen — auch wenn die Liste gerade leer ist.
   *
   * Das Verlaufs-Blatt sperrt seinen Papierkorb bei leerer Liste, und ich hatte
   * das mit übernommen. Hier ergibt es etwas anderes: Benachrichtigungen
   * erzeugt bisher niemand, die Liste ist also IMMER leer — der Knopf war damit
   * dauerhaft tot, und ein Knopf, der nie reagiert, ist kein sparsames
   * Verhalten, sondern ein kaputter Knopf.
   */
  const requestClear = () => {
    haptic("button");
    setConfirmClear(true);
  };

  /**
   * Tippen NEBEN das Blatt — zählt erst, wenn es oben steht.
   *
   * Die Fläche dafür deckt den ganzen Bildschirm ab, also auch die Stelle, an
   * der die Glocke sitzt, und sie ist von der ersten Millisekunde an
   * berührbar. Wer zweimal schnell auf die Glocke tippt — was man tut, wenn
   * man denkt, der erste Tipp sei nicht angekommen —, traf mit dem zweiten
   * bereits diese Fläche und schloss das Blatt wieder, bevor es oben war.
   */
  const dismissFromScrim = () => {
    if (Date.now() - enteredAt.current < SHEET_IN.duration) return;
    dismiss();
  };

  return (
    /**
     * Die Berührungs-Sperre sitzt auf DIESER Hülle, nicht auf einem der beiden
     * bewegten Knoten.
     *
     * Sie wechselt genau in dem Durchgang, in dem die Fahrt beginnt, und ein
     * Eigenschafts-Wechsel ist auf Fabric ein Commit auf ebendem Knoten, den
     * Reanimated dort Bild für Bild beschreibt. Auf der ruhenden Hülle wirkt er
     * unverändert — und geschlossen muss er sein, denn die Verdunkelung liegt
     * über dem ganzen Bild, auch wenn sie unsichtbar ist.
     */
    <View
      style={[StyleSheet.absoluteFillObject, styles.layer]}
      pointerEvents={open ? "auto" : "none"}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFillObject, styles.scrim, scrimStyle]}
      />
      {/* Tippen neben das Blatt (auf Kopfzeile oder Verdunkelung) schließt. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t("common.close")}
        onPress={dismissFromScrim}
      />

      <GestureDetector gesture={panGesture}>
      <Animated.View
        style={[styles.sheet, { top, backgroundColor: palette.s1 }, sheetStyle]}
      >
        <View style={styles.header}>
          {/**
            * `Pressable` statt `RippleTouch` — dieselbe Begründung wie am
            * X-Knopf des Ortswählers: Dieser Knopf STARTET die Ausfahrt, und
            * der native Wellen-Effekt ist eine 300 bis 400ms lange
            * Zeichen-Animation mitten auf dem Blatt, das sich in derselben Zeit
            * bewegt. Sie liefe über die volle Dauer der Rückfahrt dagegen an.
            */}
          <Pressable
            onPress={dismiss}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <X color={C.closeIcon} size={26} />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>
            {t("notifications.title")}
          </Text>
          {/* Papierkorb wie im Verlaufs-Blatt: 44er Kreis auf `s2`, rotes
              Symbol. Ohne Ausgrauen — siehe `requestClear`. */}
          <Pressable
            onPress={requestClear}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("notifications.clear.title")}
            style={({ pressed }) => [
              styles.trashBtn,
              { backgroundColor: palette.s2 },
              { opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Trash2 size={20} color={C.danger} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Leerer Zustand. `active` NUR solange das Blatt offen ist: Es hängt
            dauerhaft am Wurzel-Layout, und die Schleifen der Varianten liefen
            sonst die ganze Sitzung über mit. */}
        <NotificationsEmpty variant={variant} active={open} />
      </Animated.View>
      </GestureDetector>

      {/* Derselbe Dialog wie beim Leeren des Suchverlaufs — dieselbe Karte,
          derselbe rote Symbolkreis, dieselben zwei Knöpfe. Nur der Text spricht
          von Benachrichtigungen statt von Suchen; „Suchverlauf löschen?" über
          einer Liste von Benachrichtigungen wäre schlicht falsch. */}
      <ClearSearchHistoryAlert
        visible={confirmClear}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false);
          clearItems();
        }}
        title={t("notifications.clear.title")}
        message={t("notifications.clear.body")}
        confirmLabel={t("notifications.clear.confirm")}
        cancelLabel={t("notifications.clear.cancel")}
      />
    </View>
  );
}

const styles = scaledStyles({
  /**
   * Höhe nur für die SORTIERUNG, kein Schatten.
   *
   * `zIndex` allein reicht auf Android nicht, sobald Geschwister am
   * Wurzel-Layout eine Höhe tragen (16 bis 32) — ohne eigene zeichnete sich das
   * Blatt darunter. Der Schatten dazu wäre über die volle Kontur in JEDEM Bild
   * der Fahrt zu rechnen; die Trennung zum Landingscreen leisten die runden
   * Ecken und die Verdunkelung darüber.
   *
   * 36 statt der 40 der beiden Wähler: Die dürfen darüber liegen, sie können
   * aus dem Such-Blatt heraus über diesem geöffnet werden.
   */
  layer: { zIndex: 9000, elevation: 36, shadowColor: "transparent" },
  scrim: { backgroundColor: "rgba(0,0,0,0.6)" },

  /** `top` kommt zur Laufzeit dazu — es hängt an der sicheren Fläche. */
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    /**
     * KEIN `overflow: "hidden"`.
     *
     * Runde Ecken kosten auf RN 0.81 ohnehin einen Pfad-Clip pro Bild
     * (`BackgroundStyleApplicator` legt ihn jedes Mal neu an) — das Clippen der
     * KINDER käme als zweiter Durchgang obendrauf, über die volle Fahrt. Es
     * bringt hier nichts: Weder Kopfzeile noch leerer Zustand reichen bis in
     * die Ecken.
     */
  },

  /**
   * Maße aus dem ORTSWÄHLER, nicht aus dem Datumswähler.
   *
   * Die beiden Blätter waren sich hier nie einig, und dieses hatte den falschen
   * von beiden übernommen. Der Ortswähler ist der Vorbild-Fall: `gap: 12`,
   * seitlich 20 (der Rand jedes Bildschirms), unten 16.
   *
   * `paddingTop` ist der einzige Wert, der nicht abgeschrieben werden konnte:
   * Der Ortswähler steht am oberen Bildschirmrand und braucht seine 56 zum
   * größten Teil für die Statusleiste. Dieses Blatt fängt darunter an, hat also
   * gar keine zu überbrücken. 24 ist die Luft, die der Datumswähler ÜBER seiner
   * sicheren Fläche lässt — dieselbe Menge, nur ohne den Sockel darunter.
   */
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: GUTTER,
    paddingTop: SPACE.xxl,
    paddingBottom: SPACE.lg,
  },
  /**
   * 24/600 — und ausdrücklich NICHT `ScreenHeading`.
   *
   * Hier stand die Tab-Überschrift (26/900), die Komponente für „Binch",
   * „Saved" und „Profil". Die gehört an den Kopf eines TABS; ein Blatt, das sich
   * darüberlegt, ist keiner. Der Ortswähler setzt seinen Titel mit 24 und
   * halbfett, und genau so liest er sich auch: als Aufschrift des Blattes, nicht
   * als zweite Bildschirm-Überschrift über der ersten.
   */
  title: { ...SHEET_TITLE, flex: 1 },
  trashBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },

});
