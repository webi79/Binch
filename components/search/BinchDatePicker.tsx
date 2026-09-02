/**
 * BinchDatePicker — Slide-Up Overlay für Datum + Zeit Auswahl.
 *
 * Always-Mounted Pattern wie LocationPicker (offset/opacity SharedValues):
 *  - Picker ist beim App-Start IMMER im Tree → kein Cold-Start-Lag beim
 *    ersten Open
 *  - Tap → useEffect fires → withTiming auf UI-Thread startet SOFORT
 *  - Content immer fertig gerendert während des Slides
 *
 * Calendar ist via FlatList virtualisiert + Infinite-Scroll:
 *  - Initial nur 3 Monate gemountet (~90 Cells statt 180+)
 *  - Beim Scrollen ans untere Ende werden mehr Monate nachgeladen
 *  - DayCell als React.memo damit Selection-Changes nur 2 Cells re-rendern
 */
import { memo, useCallback, useMemo, useState, type ReactNode, useRef } from "react";
import { subscribeLayer, holdLayer, rearmLayer } from "@/lib/nav/transitionLayer";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { PICKER_IN, PICKER_OUT } from "@/lib/nav/overlayCover";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { showAlert } from "@/lib/alert";
import { setSheetMoving } from "@/lib/nav/searchHandoff";
import {
  Dimensions,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import { FlashList } from "@shopify/flash-list";
import { usePressBounce } from "@/lib/motion";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useEffect } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X, Clock } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { haptic } from "@/lib/haptics";
import { SlidingPanels } from "@/components/ui/SlidingPanels";
import {
  TimeSheetGate,
  DEFAULT_TIME,
  openTimeSheet,
  closeTimeSheet,
} from "./TimeSheet";
import { scaledStyles } from "@/lib/ui/compact";
import { useSearchStore } from "@/stores/searchStore";

const C = {
  bg: "#0D0D0D",
  surface1: "#171719",
  surface2: "#171719",
  surface3: "#212123",
  border: "#212123",
  white: "#F4F4F5",
  gray200: "#C8C8CC",
  gray300: "#8E8E93",
  gray500: "#56565C",
  gray700: "#2D2D31",
};

const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const WD_MON = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WD_SUN = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WD_FULL = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

const CHEAP_DAY = 80;
const CHEAP_MONTH = 70;
// Wir bieten — wie die großen Apps — ein rollierendes 12-Monats-Fenster ab dem
// aktuellen Monat an (Juni → bis Ende Mai nächsten Jahres). Alle 12 sofort laden
// (kein Infinite-Scroll) → KEINE setLoadedMonths-Re-Renders mehr während des
// Scrollens (die recreaten months/monthLayouts mitten im Scroll = Ruckler).
const INITIAL_MONTHS = 12;
const LOAD_MORE_MONTHS = 12;
const MAX_MONTHS = 12;

const pad = (n: number) => String(n).padStart(2, "0");

function priceFor(y: number, m: number, d: number): number {
  const seed = Math.abs(((y * 372 + m * 31 + d) * 2654435761) % 100000);
  const dow = new Date(y, m, d).getDay();
  let p = 58 + (seed % 92);
  if (dow === 0 || dow === 5 || dow === 6) p += 16;
  return Math.round(p);
}
function monthFrom(y: number, m: number): number {
  const seed = Math.abs(((y * 372 + m * 31 + 7) * 40503) % 100000);
  return 50 + (seed % 52);
}

/**
 * Der Parkplatz — EXAKT wie beim Such-Blatt.
 *
 * Dort steht `Dimensions.get("window").height`, einmal beim Laden gelesen
 * (`SearchHeroOverlay`: `const { height: SH } = Dimensions.get("window")`).
 * Ich hatte hier die GERÄTE-höhe genommen, um sicher unter den Bildrand zu
 * kommen — das sind auf einem üblichen Gerät 72 Punkte mehr. Bei gleicher Dauer
 * heißt mehr Weg schlicht mehr Geschwindigkeit: 92 statt 85 Punkte pro Bild.
 * Genau solche 9% sind der Unterschied zwischen „läuft wie das andere" und
 * „wirkt hektischer".
 *
 * Einmal beim Laden gelesen ist auch die Fenster-Höhe unbedenklich: Zu dem
 * Zeitpunkt gibt es keine Tastatur, die sie verkleinern könnte.
 */

const PARK_Y = Dimensions.get("window").height;

/**
 * Innenabstände der Scroll-Flächen als KONSTANTEN.
 *
 * Als Literal im JSX ist jedes davon bei jedem Durchgang ein frisches Objekt —
 * und damit ein geänderter Stil-Prop auf dem Scroll-Container, den Fabric
 * committen muss. Dieser Wähler rendert bei jeder Monats-Bewegung und jeder
 * Auswahl neu; die Werte selbst haben sich dabei nie geändert.
 */
const PAD_BOTTOM_120 = { paddingBottom: 120 } as const;
const PAD_H20_B120 = { paddingHorizontal: 20, paddingBottom: 120 } as const;

type Mode = "specific" | "flexible";

/**
 * Der Text der Preis-Meldung.
 *
 * Bewusst vorsichtig formuliert: Es sind Schätzungen aus vergangenen Suchen,
 * keine buchbaren Preise. Im Projekt gilt „wir schätzen keine Preise" für
 * ANGEBOTE — hier steht ausdrücklich dabei, dass es welche sind, und genau
 * deshalb ist der Hinweis überhaupt nötig.
 */
const ESTIMATED_PRICE_NOTE =
  "Geschätzte günstigste Preise pro Person, ohne Gewähr. Der tatsächliche Preis steht erst in den Suchergebnissen.";
type Sel = { y: number; m: number; d: number } | null;
type MonthBlock = { y: number; m: number; weeks: ({ d: number } | null)[][] };
// Für FlashList flachgeklopft: jede Zeile ist entweder ein Monats-Label ODER
// eine Wochen-Zeile (7 Zellen). So recycelt FlashList winzige Einheiten (7 Zellen
// statt 42) → minimale JS-Render-Arbeit pro Recycle = flüssiges Scrollen.
type CalRow =
  | { kind: "label"; key: string; label: string; first: boolean }
  | { kind: "week"; key: string; y: number; m: number; cells: ({ d: number } | null)[] };

export interface BinchDatePickerProps {
  visible: boolean;
  /** Liegt der Inhalt im Baum? Siehe Host — Aufbau im Leerlauf, danach fest. */
  mounted: boolean;
  /** Zählt je Öffnung hoch, schon beim BERÜHREN — siehe Host. */
  session: number;
  onClose: () => void;
  minimumDate?: Date;
  initialDate?: Date | null;
  initialMode?: Mode;
  minuteStep?: number;
  startMonday?: boolean;
  onConfirmDate?: (v: { year: number; month: number; day: number; hour: number; minute: number }) => void;
  onConfirmMonth?: (v: { year: number; month: number }) => void;
  fieldLabel?: string;
  title?: string;
}

/**
 * GEMERKT — sonst rendert der ganze Wähler im ersten Bild der Ausfahrt neu.
 *
 * Der Wirt hört am Speicher; das Bestätigen schreibt Ergebnis und Auftrag in
 * einem Zug, also genau dann, wenn die Rückfahrt losläuft. Er rendert dabei
 * dieselben Eigenschaften noch einmal — ohne Schranke lief der komplette Baum
 * dieses Wählers trotzdem durch, samt Einbau-Schritten auf dem UI-Strang.
 *
 * Alle Eigenschaften sind stabil: Speicher-Aktionen, Werte aus dem gemerkten
 * Auftrag, und die Zahlen für Sichtbarkeit und Sitzung wechseln inzwischen
 * ausschließlich außerhalb der Bewegung.
 */
const BinchDatePickerInner = function BinchDatePicker({
  visible,
  mounted,
  session,
  onClose,
  minimumDate,
  initialDate,
  initialMode = "specific",
  minuteStep = 5,
  startMonday = true,
  onConfirmDate,
  onConfirmMonth,
  fieldLabel = "Abreise",
  title = "Reisedatum",
}: BinchDatePickerProps) {
  const palette = usePalette();
  const accent = useAccent();
  const { height: screenH } = useWindowDimensions();

  // Slide-Pattern wie LocationPicker — always-mounted, offset/opacity via
  // SharedValue + withTiming. Tap → useEffect → withTiming auf UI-Thread.
  const {
    y: offset,
    style: wrapStyle,
    run: runSheet,
    parkNow,
    warm: warmSlide,
  } = useSheetSlide("pickerDate", PARK_Y);
  // Pre-warm: einmaliger no-op withTiming am Mount damit Reanimated v4
  // die Worklets JIT-kompiliert BEVOR der User zum ersten Mal tippt.
  // Ohne pre-warm ist der erste richtige Slide messbar stuttery (cold
  // start kann auf Android 50-100ms kosten).
  useEffect(() => {
    /**
     * Kalt-Anlauf mit der ECHTEN Vorgabe, nicht mit `{ duration: 1 }`.
     *
     * Hier stand eine 1ms-Bewegung mit Standardkurve. Die parkt das Blatt zwar
     * korrekt, läuft aber durch einen ANDEREN Code-Pfad als die spätere echte
     * Fahrt: `PICKER_IN` trägt eine Bézier-Kurve, und deren Aufbau passiert dann
     * beim ersten echten Öffnen. Genau deshalb ruckelt es beim ersten Mal am
     * stärksten.
     *
     * Das Such-Blatt macht das seit Längerem richtig und begründet es wörtlich:
     * „Beide laufen mit den ECHTEN Konfigurationen, damit wirklich derselbe Pfad
     * durchlaufen wird und nicht bloß ein ähnlicher."
     *
     * Der Weg ist verschwindend klein und liegt außerhalb des Bildes — sichtbar
     * ist davon nichts, gewärmt wird trotzdem der richtige Pfad.
     */
    // EIN BILD später — der Parkplatz-Effekt weiter unten läuft beim Aufsetzen
    // ebenfalls und bräche den Anlauf sonst im selben Durchgang ab (dieselbe
    // Begründung wie im Ortswähler).
    /**
     * Der Anlauf kommt aus der gemeinsamen Fahrt (`warmSlide`) — sonst wärmt er
     * eine andere Funktion als die, die später wirklich fährt.
     */
    const id = requestAnimationFrame(() => warmSlide());
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Die Ebene gilt für die DAUER DER BEWEGUNG — in beide Richtungen.
   *
   * Vorher hing sie allein an `prepareLayer` (Berührung des Feldes). Das deckt
   * das Hereinfahren ab, aber nicht das Hinausfahren: Die Vorbereitung verfällt
   * nach 1,4 Sekunden von selbst, und in einem Picker ist man länger. Jedes
   * Schließen lief damit ganz ohne Ebene — und über der Ansicht steht
   * ausdrücklich, dass genau das schon einmal messbare Bildverluste erzeugt hat.
   *
   * Beides zusammen ist richtig: `prepareLayer` legt sie im Berührungsfenster an
   * (dort sind die 66ms Aufbau umsonst), und dieser Zustand hält sie über beide
   * Fahrten. Was die Vorbereitung schon angelegt hat, wird dadurch nicht neu
   * gebaut — es bleibt einfach bestehen.
   *
   * DAUERHAFT darf sie nicht sein, und das ist der Grund, warum hier vorher
   * `elevation: 32` stand und wieder wegmusste: Unter ihr scrollt eine Liste.
   * Eine Ebene über einer scrollenden Fläche muss bei jedem Scroll-Bild neu
   * entstehen — schlimmer als gar keine.
   */
  // KEIN eigenes Bild-Handle mehr: Das Warten auf das nächste Bild steckt
  // in `useSheetSlide` — beide Wähler nutzen dasselbe.
  const [moving, setMoving] = useState(false);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdLayerFor = (ms: number) => {
    setMoving(true);
    if (moveTimer.current) clearTimeout(moveTimer.current);
    moveTimer.current = setTimeout(() => setMoving(false), ms + 80);
  };
  /**
   * Sicherheitsnetz für die Fahrt-Meldung.
   *
   * Der Rückruf am Ende der Kurve läuft NICHT, wenn die Bewegung abgebrochen
   * wird (zweiter Tipp, Schließen mittendrin). Ohne dieses Netz bliebe die
   * Meldung dauerhaft auf „fährt", und die Übergabe-Textur würde nie wieder
   * freigegeben — der Such-Bildschirm bliebe eine bildschirmfüllende GPU-Fläche,
   * die bei jeder Eingabe neu rastert. Genau dieser Fehler ist in
   * `searchHandoff` für den anderen Weg schon ausformuliert.
   */
  const movingGuard = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armMovingGuard = (ms: number) => {
    if (movingGuard.current) clearTimeout(movingGuard.current);
    movingGuard.current = setTimeout(() => setSheetMoving(false, "pickerDate"), ms + 200);
  };
  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
      if (movingGuard.current) clearTimeout(movingGuard.current);
    },
    [],
  );

  /**
   * Nur auf einen echten WECHSEL reagieren — nicht auf jedes Auslösen.
   *
   * Zwei Fälle liefen hier bisher falsch mit:
   *
   *  1. Der allererste Durchgang. Beide Wähler hängen dauerhaft am Baum, und
   *     beide fielen beim Start in den Schließen-Zweig: Sie meldeten „fährt",
   *     forderten eine Ebene an und gaben sie 420ms später wieder frei —
   *     mitten in den Start der App hinein, ohne dass sich etwas bewegt hätte.
   *  2. `screenH` steht in den Abhängigkeiten. Ändert sich das Fenstermaß,
   *     während der Wähler OFFEN ist (Tastatur mit `adjustResize`,
   *     geteilter Bildschirm), lief der Zweig erneut — und schob das Blatt
   *     einmal komplett aus dem Bild und wieder herein.
   */
  const wasVisible = useRef<boolean | null>(null);
  /**
   * Die Bewegung startet DIREKT aus dem Speicher — ohne auf ein Rendern zu
   * warten. Das ist der Weg des Such-Blattes.
   *
   * Sie hing bisher am `visible`-Prop, also am Ergebnis eines Durchgangs durch
   * React: Speicher schreiben → Host rendert → Wähler rendert (kompletter Baum)
   * → Effekt → ein Bild → Kurve. Der teure Teil lag damit unmittelbar vor dem
   * Start, und auf Fabric fallen die Einbau-Schritte dazu auf denselben Strang
   * wie die Bewegung.
   *
   * Jetzt hört das Blatt selbst zu. Der Rückruf läuft in DEMSELBEN Aufruf, der
   * den Speicher beschreibt — noch vor jedem Rendern. Das Prop kommt ein Bild
   * später nach und trägt nur noch, was React braucht (siehe Host).
   */
  const runSlide = useRef<(v: boolean) => void>(() => {});
  useEffect(
    () =>
      useSearchStore.subscribe((st, prev) => {
        const now = st.datePickerRequest !== null;
        const was = prev.datePickerRequest !== null;
        if (now !== was) runSlide.current(now);
      }),
    [],
  );

  /**
   * Die eigentliche Fahrt — aufgerufen vom Speicher-Abonnement oben, nicht von
   * einem Rendern. Beide Richtungen laufen identisch aufgebaut: Ebene halten,
   * anmelden, EIN Bild zeichnen lassen, dann die Kurve. Genau die Reihenfolge
   * des Such-Blattes.
   */
  /**
   * Die Fahrt selbst kommt aus `useSheetSlide` — EINE Quelle für alle Blätter.
   *
   * Hier bleibt nur, was diesem Wähler eigen ist: die Ebene halten, den
   * Wächter scharf stellen und die Unterlage mitnehmen. Strecke, Kurve, Dauer,
   * Reihenfolge und Anmeldung stecken in der gemeinsamen Fahrt und können
   * dadurch nicht mehr abweichen.
   */
  const slide = useCallback(
    (show: boolean) => {
      const cfg = show ? PICKER_IN : PICKER_OUT;
      /**
       * Fehlt die Ebene, bekommt die Fahrt ein Bild Vorlauf.
       *
       * Ihr Aufbau ist im Projekt mit 66ms vermessen, die Fahrt dauert 260ms
       * über die volle Fensterhöhe — ohne Vorlauf fehlen am Anfang rund neun
       * Bilder, und die Kurve springt sichtbar hinein. Über den X-Knopf steht
       * die Ebene längst vom Aufsetzen des Fingers; die Zurück-Geste hat diesen
       * Moment nicht.
       */
      /**
       * Beim ÖFFNEN die Ebene halten, beim SCHLIESSEN wieder scharf stellen.
       *
       * Sie wurde beim Berühren angefordert und verfällt nach 1,4 Sekunden von
       * selbst — also mitten hinein, während man im Wähler steht und die Liste
       * scrollt. Danach fehlt sie zusätzlich der Ausfahrt. Detail-, Ticket- und
       * Such-Blatt halten ihre Unterlagen-Textur genau so; die Wähler hielten
       * als einzige ihre eigene nicht.
       */
      if (show) holdLayer("pickerDate");
      else rearmLayer("pickerDate");
      const needsLayer = !layeredRef.current;
      if (needsLayer) holdLayerFor(cfg.duration + (show ? 16 : 0));
      armMovingGuard(cfg.duration);
      if (needsLayer) {
        requestAnimationFrame(() => runSheet(show));
        return;
      }
      runSheet(show);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runSheet],
  );
  runSlide.current = slide;

  /**
   * Beim allerersten Durchgang nur PARKEN.
   *
   * Es bewegt sich nichts, es wird also auch nichts gemeldet — sonst gälte der
   * Bildschirm beim Start der App als „fährt".
   */
  useEffect(() => {
    if (wasVisible.current !== null) {
      wasVisible.current = visible;
      return;
    }
    wasVisible.current = visible;
    if (!visible) parkNow();
  }, [visible, offset, screenH]);

  /**
   * Bei geändertem Fenstermaß neu parken, solange geschlossen.
   *
   * Der Parkplatz ist die Fensterhöhe. Ändert die sich, während der Wähler
   * unten steht (Tastatur unter `adjustResize`, geteilter Bildschirm), bliebe
   * der alte Wert stehen — und ein deckendes Blatt lugte unten ins Bild und
   * schluckte Berührungen.
   */
  /**
   * KEIN Neu-Parken bei geändertem Fenstermaß mehr.
   *
   * Hier stand ein Effekt, der bei einer Änderung `parkNow()` rief — und der
   * schreibt die beim Laden gemerkte Höhe zurück, also genau den Wert, den er
   * korrigieren sollte. Er konnte nichts bewirken.
   *
   * Die Ausrichtung ist auf Hochkant festgelegt; die Fensterhöhe ändert sich zur
   * Laufzeit nur durch die Tastatur, und die verkleinert sie — der Parkplatz
   * liegt dann also weiter unten als nötig, nie zu hoch. Sichtbar werden kann
   * dabei nichts.
   */

  // Picker selbst NUR translateY, KEINE Opacity — sonst fadet er beim
  // Slide-Out (160ms) schneller weg als er translatet (280ms) und der
  // User sieht nur einen Disappear-Effekt statt einem Slide. Mit reinem
  // translateY ist der Picker während der gesamten 280ms voll sichtbar
  // bis er off-screen ist.
  const [layered, setLayered] = useState(false);
  // Spiegel für den Fahrt-Rückruf: Der läuft aus einem Abonnement heraus und
  // säße sonst auf dem Stand des Durchgangs, in dem er angelegt wurde.
  const layeredRef = useRef(false);
  layeredRef.current = layered;
  useEffect(() => subscribeLayer("pickerDate", setLayered), []);



  /**
   * Die Zurück-Taste hängt am SPEICHER, nicht an der verzögerten Sichtbarkeit.
   *
   * `visible` kippt inzwischen erst nach dem Ende der Fahrt — in den 300ms
   * davor deckte das Blatt schon den ganzen Bildschirm, hatte aber keinen
   * Abfangring. Zuständig war dann der des Such-Blattes: Eine Zurück-Geste
   * während der Einfahrt schloss also die SUCHE, während der Wähler deckend
   * liegen blieb. Aus der Umgebungs-Karte gab es gar keinen — dort wurde der
   * Reiter verlassen.
   *
   * Angemeldet wird, solange der Inhalt im Baum liegt; ob wirklich offen ist,
   * entscheidet der Speicher im Moment des Drucks. Kein Rendern, keine
   * Verzögerung.
   */
  useEffect(() => {
    if (Platform.OS !== "android" || !mounted) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (useSearchStore.getState().datePickerRequest === null) return false;
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [mounted, onClose]);

  return (
    <>
            {/*
        KEINE Verdunkelungs-Ebene mehr — und das ist der zweite strukturelle
        Unterschied zum Such-Blatt, das als Vorbild dient.

        Hier lag eine bildschirmfüllende Fläche mit `rgba(0,0,0,0.75)`, deren
        Deckkraft über die volle Fahrt von 0 auf 1 lief. Das kostet dreifach:

          • ein zweiter vollflächiger Auswerter pro Bild, zusätzlich zum Blatt
          • ein vollflächiger Alpha-Durchgang in JEDEM Bild
          • und das Schwerste: Solange oben etwas Halbdurchsichtiges liegt, kann
            Android die Fläche darunter nicht als verdeckt überspringen. Der
            Himmel-und-Dünen-SVG des Such-Bildschirms musste also die ganzen
            300ms mitgezeichnet werden, statt nach den ersten Bildern
            wegzufallen.

        Das Such-Blatt im Landingscreen hat nichts dergleichen: Es ist deckend
        und verdeckt schlicht, was darunter liegt. Genau dieses Verhalten war
        gewünscht.

        Sichtbar war die Verdunkelung ohnehin nur während der Fahrt — sobald das
        Blatt oben steht, deckt es alles ab.
      */}

      <Animated.View
        // Wie im Ortswähler: nicht zusammenfalten lassen, damit die
        // Textur-Anforderung sicher an DIESEM Knoten hängt.
        collapsable={false}
        /**
         * Textur NUR über das Modul — angelegt, wenn der Finger das Datumsfeld
         * berührt, also VOR der Bewegung.
         *
         * Der Kommentar darunter erklärt richtig, warum `elevation` hier weg
         * musste (unsichtbarer Schatten, aber Layer-Zwang bei jedem Scroll-Bild).
         * Daraus wurde aber „gar keine Ebene", und damit wird dieses
         * bildschirmfüllende Blatt in JEDEM Bild seiner Fahrt neu gezeichnet —
         * 14,7ms gegen ein Budget von 8,3ms. Der Schatten bleibt weg, die Ebene
         * kommt zurück: nur für die Dauer der Bewegung, angelegt im Berührungs-
         * Fenster davor, und danach wieder abgeräumt, damit das Scrollen im
         * Kalender sie nicht Bild für Bild neu erzeugen muss.
         */
            style={[
          StyleSheet.absoluteFillObject,
          // KEIN elevation mehr: das Sheet ist Vollbild + opak (deckt alles ab),
          // ein 32dp-Android-Schatten ist unsichtbar (Ränder offscreen), zwingt
          // aber die ganze View samt scrollendem FlashList-Inhalt auf einen
          // Hardware-Layer → jeder Scroll-Frame = Layer-Recomposite + Shadow-Pass
          // = UI-Thread-Last. Stacking macht render-order + zIndex.
          {
            zIndex: 9999,
            backgroundColor: palette.s1,
            // Siehe Ortswähler: `zIndex` allein reicht auf Android nicht, wenn
            // Geschwister am Wurzel-Layout eine Höhe tragen (16 bis 32).
            elevation: 40,
            // Höhe nur für die Sortierung, kein Schatten — er wäre unsichtbar
            // (Vollbild, deckend, Ränder offscreen), würde aber in jedem Bild
            // der Fahrt über die ganze Kontur gerechnet. Siehe Ortswähler.
            shadowColor: "transparent",
          },
          wrapStyle,
        ]}
      >
        {/**
          * `pointerEvents` sitzt hier statt auf der animierten View — dieselbe
          * Begründung wie im Ortswähler: Ein Eigenschafts-Wechsel auf dem
          * animierten Knoten ist auf Fabric ein Commit gegen die laufende
          * Bewegung.
          */}
        {/**
          * KEIN `pointerEvents` mehr — geparkt liegt das Blatt außerhalb des
          * Bildes und kann ohnehin nichts abfangen.
          *
          * Gegatet hing es an der verzögerten Sichtbarkeit: Nach dem Ende der
          * Einfahrt stand das Blatt dadurch mehrere Bilder lang sichtbar, aber
          * tot — kein Tippen in die Leiste, keine Zeile, kein X. Und jeder
          * Wechsel wäre ein Commit gewesen, den wir aus der Fahrt heraushalten
          * wollen.
          */}
        {/**
          * Die Textur sitzt auf DIESER Hülle, nicht auf dem animierten Knoten.
          *
          * Der Schalter kippt genau dann, wenn die Fahrt anfängt — und ein
          * Eigenschafts-Wechsel auf dem animierten Knoten ist auf Fabric ein
          * Commit gegen ebendie Bewegung, die Reanimated dort Bild für Bild
          * schreibt (dieselbe Begründung wie bei `pointerEvents` darüber). Auf
          * der Hülle wirkt er unverändert: Sie trägt den gesamten schweren
          * Inhalt, der animierte Knoten darüber zeichnet nur noch eine
          * deckende Fläche und verschiebt die fertige Textur.
          */}
        <View
          style={StyleSheet.absoluteFill}
          collapsable={false}
          renderToHardwareTextureAndroid={Platform.OS === "android" && (layered || moving)}
        >
        {mounted && (
        <DatePickerContent
        accentSolid={accent.solid}
        accentSubtle={accent.subtle}
        accentBorder={accent.border}
        accentTextOnSolid={accent.textOnSolid}
        onClose={onClose}
        minimumDate={minimumDate}
        initialDate={initialDate}
        initialMode={initialMode}
        minuteStep={minuteStep}
        startMonday={startMonday}
        onConfirmDate={onConfirmDate}
        onConfirmMonth={onConfirmMonth}
        fieldLabel={fieldLabel}
        title={title}
          sessionKey={session}
          open={visible}
        />
        )}
        </View>
      </Animated.View>
    </>
  );
};

export const BinchDatePicker = memo(BinchDatePickerInner);

interface ContentProps {
  accentSolid: string;
  accentSubtle: string;
  accentBorder: string;
  accentTextOnSolid: string;
  onClose: () => void;
  minimumDate?: Date;
  initialDate?: Date | null;
  initialMode: Mode;
  minuteStep: number;
  startMonday: boolean;
  onConfirmDate?: (v: { year: number; month: number; day: number; hour: number; minute: number }) => void;
  onConfirmMonth?: (v: { year: number; month: number }) => void;
  fieldLabel: string;
  title: string;
  sessionKey: number;
  /**
   * Offen? Wird NUR fürs Zurücksetzen beim Schließen gebraucht.
   *
   * Gefahrlos als Eigenschaft, seit der Wirt sie erst nach dem Ende der
   * Bewegung umschaltet — der Wechsel kann also nicht mehr in die Fahrt fallen.
   */
  open: boolean;
}

/**
 * Gemerkt — sonst baut JEDER Durchgang des Elternteils den ganzen Kalender neu.
 *
 * Der Elternteil rendert bei jedem `setLayered` (Fingerdruck), bei jedem
 * `setMoving` (Start und Ende beider Fahrten) und beim Umschalten von
 * `visible`. Ohne diese Schranke hing an jedem dieser Durchgänge der komplette
 * Inhalt: eine Liste über 84 Wochenzeilen, zwölf Monatskarten, die Reiter, die
 * Schiebe-Ebenen und das Zeit-Blatt. Einer davon fällt beim Schließen genau in
 * die Ausfahrt.
 *
 * Die Eigenschaften sind alle stabil (Speicher-Aktionen und Modul-Konstanten),
 * nur `sessionKey` wechselt — und das soll es auch.
 */
const DatePickerContent = memo(function DatePickerContent({
  accentSolid,
  accentSubtle,
  accentBorder,
  accentTextOnSolid,
  onClose,
  minimumDate,
  initialDate,
  initialMode,
  minuteStep,
  startMonday,
  onConfirmDate,
  onConfirmMonth,
  fieldLabel,
  title,
  sessionKey,
  open,
}: ContentProps) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [sel, setSel] = useState<Sel>(() => {
    if (!initialDate) return null;
    return { y: initialDate.getFullYear(), m: initialDate.getMonth(), d: initialDate.getDate() };
  });
  const [hour, setHour] = useState(initialDate?.getHours() ?? DEFAULT_TIME.hour);
  const [minute, setMinute] = useState(initialDate?.getMinutes() ?? DEFAULT_TIME.minute);
  /**
   * Stabil — sonst ist das `memo()` um `ModeTabs` wirkungslos.
   *
   * Als Pfeilfunktion am Ort war die Eigenschaft bei JEDEM Durchgang neu, und
   * damit rendern die Reiter samt ihrem gleitenden Balken jedes Mal mit. Genau
   * dieser Baum liegt beim Öffnen und Schließen neben der Fahrt.
   */
  const onModeChange = useCallback((m: Mode) => {
    haptic("button");
    setMode(m);
  }, []);
  const weiterBounce = usePressBounce();
  const [selMonthKey, setSelMonthKey] = useState<string | null>(null);
  // Infinite Scroll — startet bei INITIAL_MONTHS, lädt LOAD_MORE_MONTHS
  // bei jedem onEndReached.
  const [loadedMonths, setLoadedMonths] = useState(INITIAL_MONTHS);

  // Beim Open: initialDate sofort übernehmen wenn vorhanden. Wenn der User
  // schon mal eine Date confirmed hat, soll die hier hervorgehoben sein.
  // Das ist nur 1 Cell-Highlight (React.memo greift) → kein Stutter.
  useEffect(() => {
    if (sessionKey === 0) return;
    if (initialDate) {
      /**
       * Nur setzen, wenn sich wirklich etwas ändert.
       *
       * `setSel({...})` legte hier bei JEDEM Öffnen ein neues Objekt an — auch
       * dann, wenn dasselbe Datum schon ausgewählt war. Ein neues Objekt heißt
       * neue Kennung, und daran hängen sowohl die Zeichenfunktion der
       * Kalenderliste als auch ihre Zusatzangabe: Die Liste rendert damit ALLE
       * gemounteten Wochenzeilen neu, und zwar in genau dem Bild, in dem die
       * Bewegung anläuft.
       *
       * Das erklärt auch, warum es sich „mal so, mal so" anfühlte: Beim allerersten
       * Öffnen ist noch kein Datum gesetzt, da fällt es nicht an — ab dem zweiten
       * jedes Mal.
       */
      const y = initialDate.getFullYear();
      const m = initialDate.getMonth();
      const d = initialDate.getDate();
      setSel((prev) => (prev && prev.y === y && prev.m === m && prev.d === d ? prev : { y, m, d }));
      setHour(initialDate.getHours());
      setMinute(initialDate.getMinutes());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Beim CLOSE (320ms nach Slide-Out): ALLES auf Defaults zurück. Dadurch
  // wird die unbestätigte sel (= User hat im Kalender getippt aber nicht
  // "Weiter" gedrückt) verworfen. Beim nächsten Open ist State sauber.
  // 320ms = Slide-Out-Duration + Puffer → User sieht den Reset nicht
  // (Picker ist da schon off-screen).
  /**
   * Zurücksetzen: abgeleitete Frist UND nicht während einer Bewegung.
   *
   * Zwei Probleme steckten in der festen 320:
   *
   * 1. Die Zahl war an die Ausfahrt gekoppelt, ohne es zu sagen. Die dauert
   *    inzwischen 260ms statt 280 — der Puffer schrumpfte still mit, und beim
   *    nächsten Wechsel wäre er negativ geworden. Dann sähe man den Kalender
   *    zurückspringen, während er noch sichtbar ist.
   *
   * 2. Schwerer: Dieses Zurücksetzen ändert sechs Zustände auf einmal und
   *    rendert damit den gesamten Kalender neu — die Monatsliste, die geladenen
   *    Monate, alle gemounteten Tageszellen. Der Zeitgeber lief blind. Wer den
   *    Datumswähler schließt und gleich darauf das Startfeld antippt, bekam den
   *    Neuaufbau des einen Blattes MITTEN in die Einfahrt des anderen — beide
   *    hängen als Geschwister dauerhaft im Baum. Genau das Muster „meistens
   *    flüssig, manchmal hakt es".
   *
   * Läuft gerade etwas, wird der Versuch verschoben statt ausgeführt. Der
   * Zeitstempel dahinter verfällt von selbst, es kann also nichts hängen
   * bleiben.
   */
  useEffect(() => {
    // Zurückgesetzt wird beim SCHLIESSEN — und `visible` kippt inzwischen erst
    // nach der Ausfahrt, liegt also ohnehin außerhalb der Bewegung.
    if (open) return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (isTransitionBusy()) {
        // Dieser Wiederversuch fällt in eine laufende Fahrt — absichtlich und
        // unbedenklich: Er vergleicht einen Zeitstempel und legt sich wieder
        // hin. Kein Rendern, kein Einbau, kein Layout. Nur das ZURÜCKSETZEN
        // selbst darf nicht hineinfallen, und genau davor schützt er.
        timer = setTimeout(attempt, 120);
        return;
      }
      /**
       * `sel` wird NICHT mehr geleert — und das ist die Bedingung dafür, dass
       * der Wächter beim nächsten Öffnen überhaupt greifen kann.
       *
       * Er vergleicht dort `prev` mit dem neuen Datum und behält bei Gleichheit
       * die alte Kennung. Wurde hier vorher auf `null` zurückgesetzt, war `prev`
       * beim nächsten Öffnen immer `null`, der Vergleich lief also garantiert
       * ins Leere und legte ein neues Objekt an — womit die gesamte
       * Kalenderliste im Öffnungs-Commit neu rendert. Der Wächter war damit
       * wirkungslos, obwohl er richtig geschrieben ist.
       *
       * Stehen bleiben darf der Wert gefahrlos: Beim nächsten Öffnen setzt ihn
       * der Auftrag ohnehin neu, und ohne Auftrag ist das Blatt unsichtbar.
       */
      /**
       * Die Auswahl gehört mit zurückgesetzt.
       *
       * Sie stand nicht mehr in dieser Liste, und die Übernahme beim Öffnen
       * schreibt nur, WENN ein Datum übergeben wird. Bei einem leeren Feld
       * blieb die alte Auswahl also stehen: Ein Datum, das jemand angetippt und
       * dann abgebrochen hat, war beim nächsten Öffnen wieder markiert — samt
       * freigeschaltetem „Weiter". Genau das, was der Kommentar über diesem
       * Block als Zweck angibt.
       */
      setSel(null);
      setHour(DEFAULT_TIME.hour);
      setMinute(DEFAULT_TIME.minute);
      // Gehörte nie in diese Liste: Wer die Uhrzeit-Auswahl offen hatte und den
      // Wähler über die Zurück-Geste verließ, bekam sie beim nächsten Öffnen
      // sofort wieder vorgesetzt.
      closeTimeSheet();
      setMode(initialMode);
      setLoadedMonths(INITIAL_MONTHS);
      setSelMonthKey(null);
    };
    /**
     * Erst NACH dem Ende der gemeldeten Bewegung anlaufen.
     *
     * `markSheetMoving` meldet bis `Dauer + 80`; der erste Versuch lag mit
     * `+60` also zwangsläufig noch mitten drin und kostete garantiert einen
     * Nachschlag von 120ms. Damit stand das Fenster, in dem ein abgebrochenes
     * Datum noch markiert ist, bei rund 456ms statt 320 — lang genug, um es
     * beim schnellen Wiederöffnen zu sehen.
     */
    timer = setTimeout(attempt, PICKER_OUT.duration + 140);
    return () => clearTimeout(timer);
  }, [open, initialMode]);

  const today = useMemo(() => {
    const d = minimumDate ?? new Date();
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
  }, [minimumDate]);
  const startYear = today.y;
  const startMonth = today.m;

  const weekdays = startMonday ? WD_MON : WD_SUN;
  const todayVal = today.y * 372 + today.m * 31 + today.d;

  // Monate werden lazy berechnet — nur die `loadedMonths` ersten kommen
  // tatsächlich in die FlatList. Beim Scrollen kommt mehr dazu.
  const months = useMemo<MonthBlock[]>(() => {
    const blocks: MonthBlock[] = [];
    for (let k = 0; k < loadedMonths; k++) {
      const y = startYear + Math.floor((startMonth + k) / 12);
      const m = (startMonth + k) % 12;
      const firstDow = new Date(y, m, 1).getDay();
      const lead = startMonday ? (firstDow + 6) % 7 : firstDow;
      const dim = new Date(y, m + 1, 0).getDate();
      const cells: ({ d: number } | null)[] = [];
      for (let i = 0; i < lead; i++) cells.push(null);
      for (let d = 1; d <= dim; d++) cells.push({ d });
      while (cells.length % 7 !== 0) cells.push(null);
      const weeks: ({ d: number } | null)[][] = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      blocks.push({ y, m, weeks });
    }
    return blocks;
  }, [startYear, startMonth, loadedMonths, startMonday]);

  // Monate → flache Liste aus Label- + Wochen-Zeilen (FlashList-Items).
  const rows = useMemo<CalRow[]>(() => {
    const out: CalRow[] = [];
    months.forEach((mo, k) => {
      out.push({ kind: "label", key: `L${mo.y}-${mo.m}`, label: MONTHS[mo.m]!, first: k === 0 });
      mo.weeks.forEach((week, wi) => {
        out.push({ kind: "week", key: `W${mo.y}-${mo.m}-${wi}`, y: mo.y, m: mo.m, cells: week });
      });
    });
    return out;
  }, [months]);

  const monthCards = useMemo(() => {
    const cards: { key: string; y: number; m: number; from: number }[] = [];
    for (let k = 0; k < MAX_MONTHS; k++) {
      const y = startYear + Math.floor((startMonth + k) / 12);
      const m = (startMonth + k) % 12;
      cards.push({ key: `${y}-${m}`, y, m, from: monthFrom(y, m) });
    }
    return cards;
  }, [startYear, startMonth]);

  const hasDate = sel != null;
  const hasSelection = mode === "flexible" ? selMonthKey != null : hasDate;
  const selTime = `${pad(hour)}:${pad(minute)}`;
  const selFull = hasDate
    ? `${WD_FULL[new Date(sel!.y, sel!.m, sel!.d).getDay()]}, ${sel!.d}. ${MONTHS[sel!.m]}`
    : "";

  let bottomTitle: string;
  if (mode === "flexible") {
    if (selMonthKey) {
      const [yy, mmn] = selMonthKey.split("-").map(Number);
      bottomTitle = `${MONTHS[mmn]} ${yy}`;
    } else bottomTitle = "Reisemonat wählen";
  } else {
    bottomTitle = hasDate ? `${selFull} · ${selTime} Uhr` : "Abreisedatum wählen";
  }

  /**
   * Das Öffnen läuft NICHT über den Zustand dieses Bauteils.
   *
   * Ein `setState` hier baut den gesamten Kalender neu auf — zwölf Monate, die
   * Reiter, die Schiebe-Ebenen —, und dieser Durchgang läge unmittelbar vor der
   * Einfahrt des Blattes. Zu sehen ist von alledem nichts; hinter der
   * Verdunkelung ändert sich nichts. Der Merker liegt deshalb in `TimeSheet`,
   * und daran hängt dort nur ein einziger, winziger Knoten.
   */
  const openTime = useCallback(() => {
    if (sel == null) return;
    haptic("button");
    openTimeSheet();
  }, [sel]);

  /** Fest — sonst baut das Blatt bei jedem Durchgang seine Rückmeldung neu ein. */
  const applyTime = useCallback((h: number, m: number) => {
    setHour(h);
    setMinute(m);
  }, []);

  // Stabiler onDayPress damit DayCell-memo greift.
  const onDayPress = useCallback((y: number, m: number, d: number) => {
    haptic("button");
    setSel({ y, m, d });
  }, []);

  const onWeiter = () => {
    haptic("button");
    if (mode === "flexible" && selMonthKey) {
      const [yy, mmn] = selMonthKey.split("-").map(Number);
      onConfirmMonth?.({ year: yy, month: mmn });
    } else if (sel) {
      onConfirmDate?.({ year: sel.y, month: sel.m, day: sel.d, hour, minute });
    }
  };

  // Infinite Scroll Handler — wird bei ~50% des unteren Endes der FlatList
  // gefeuert und lädt mehr Monate nach.
  const onEndReached = useCallback(() => {
    setLoadedMonths((prev) => Math.min(prev + LOAD_MORE_MONTHS, MAX_MONTHS));
  }, []);

  const renderRow = useCallback(
    ({ item }: { item: CalRow }) => {
      if (item.kind === "label") {
        return (
          <Text style={[s.monthLabel, { marginTop: item.first ? 4 : 20, paddingHorizontal: 20 }]}>
            {item.label}
          </Text>
        );
      }
      const { y, m, cells } = item;
      return (
        <View style={[s.dayRow, { paddingHorizontal: 20 }]}>
          {cells.map((cell, ci) => {
            if (!cell) return <View key={ci} style={s.dayCell} />;
            const d = cell.d;
            const isSel = !!sel && sel.y === y && sel.m === m && sel.d === d;
            const isToday = y === today.y && m === today.m && d === today.d;
            const isPast = y * 372 + m * 31 + d < todayVal;
            const price = priceFor(y, m, d);
            return (
              <DayCell
                key={ci}
                y={y}
                m={m}
                d={d}
                price={price}
                isSel={isSel}
                isToday={isToday}
                isPast={isPast}
                cheap={price < CHEAP_DAY}
                accentSolid={accentSolid}
                accentTextOnSolid={accentTextOnSolid}
                onPress={onDayPress}
              />
            );
          })}
        </View>
      );
    },
    [sel, today, todayVal, accentSolid, accentTextOnSolid, onDayPress],
  );

  // getItemType: FlashList recycelt Label- und Wochen-Zeilen getrennt (eigene
  // Recycling-Pools) → optimales Wiederverwenden gleichartiger Views.
  const getItemType = useCallback((item: CalRow) => item.kind, []);

  const keyExtractor = useCallback((item: CalRow) => item.key, []);

  return (
    <View style={[s.root, { backgroundColor: "transparent" }]}>
      {/* Header — Padding-Top: safe-area + 24 (entspricht pt-6 vom Saved-
          Tab) damit alles unter der Statusbar liegt. Title-Style matched
          den "Saved"-Header (26px, font-black, tracking-tight). */}
      <View style={[s.header, { paddingTop: insets.top + 24 }]}>
        <Pressable
          style={[s.closeBtn, { backgroundColor: palette.s2 }]}
          // Die Ebene für die AUSFAHRT schon beim Aufsetzen anlegen — für die
          // Einfahrt tut das `prepareLayer` beim Berühren des Feldes seit
          // Längerem, der Rückweg hatte diesen Vorlauf nie und baute die
          // Textur im ersten Bild der Bewegung auf.
          onPressIn={() => prepareLayer("pickerDate")}
          onPress={onClose}
          hitSlop={8}
        >
          <X color={C.white} size={18} strokeWidth={2.4} />
        </Pressable>
        <Text style={s.title}>{title}</Text>
      </View>

      {/* Tabs — Design wie SearchHero's toggleRow: borderRadius 14 außen,
          11 innen, padding 4. Active-Indicator gleitet smooth zwischen den
          Tabs via Reanimated SharedValue (kein abrupter Background-Swap). */}
      <ModeTabs
        mode={mode}
        accentSolid={accentSolid}
        accentTextOnSolid={accentTextOnSolid}
        onChange={onModeChange}
      />

      {/* Pager-Style: beide Sections side-by-side in einem breiten Container
          der als Ganzes translateX'd wird. Kein flackerndes Reposition mehr
          der inneren Elemente während der Animation.

          Die Abreise-Box ist TEIL des Specific-Panels (nicht mehr darüber mit
          display:none) → sie slidet beim Wechsel zu Flexibel sauber mit raus,
          statt abrupt zu verschwinden + einen Layout-Sprung auszulösen. */}
      <SlidingPanels activeIndex={mode === "specific" ? 0 : 1}>
        <View style={{ flex: 1 }}>
          <Pressable style={[s.field, { backgroundColor: palette.s2 }]} onPress={openTime}>
            <View style={{ flex: 1 }}>
              <Text style={s.fieldLabel}>{fieldLabel}</Text>
              {hasDate ? (
                <Text style={s.fieldValue}>{selFull}</Text>
              ) : (
                <Text style={s.fieldPlaceholder}>Datum wählen</Text>
              )}
            </View>
            {hasDate && (
              <View style={[s.timeChip, { backgroundColor: accentSubtle }]}>
                <Clock color={accentSolid} size={13} strokeWidth={2.4} />
                <Text style={[s.timeChipTxt, { color: accentSolid }]}>{selTime}</Text>
              </View>
            )}
          </Pressable>
          <View style={[s.weekRow, { borderTopColor: palette.border }]}>
            {weekdays.map((wd) => (
              <Text key={wd} style={s.weekday}>{wd}</Text>
            ))}
          </View>
          {/* FlashList statt FlatList: RECYCELT die Monats-Views beim Scrollen
              (wie native Listen / Skyscanner) statt sie zu mounten/unmounten →
              kein Mount-Churn = butterweiches Scrollen. v2 misst selbst, daher
              kein getItemLayout/estimatedItemSize. Muss in einem Container mit
              definierter Höhe sitzen → flex:1-Wrapper. */}
          <View style={{ flex: 1 }}>
            <FlashList
              data={rows}
              keyExtractor={keyExtractor}
              renderItem={renderRow}
              getItemType={getItemType}
              // Begrenzt den gemounteten Puffer (FlashList-v2-Analogon zu
              // windowSize) → weniger Wochen-Zeilen gleichzeitig im nativen Tree.
              drawDistance={200}
              // FlashList memoisiert Items intern — ohne extraData würde die
              // Auswahl-Markierung beim Tippen eines Tags NICHT aktualisieren.
              extraData={sel}
              // friert das Panel ein sobald auf Flexibel gewechselt wird.
              scrollEnabled={mode === "specific"}
              onEndReached={onEndReached}
              onEndReachedThreshold={0.5}
              contentContainerStyle={PAD_BOTTOM_120}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>

        <View style={{ flex: 1 }}>
          <View style={s.flexHead}>
            <Text style={s.flexTitle}>Monat</Text>
            {/* Schließt einfach — wer „jederzeit" sucht, will kein Datum. */}
            <Pressable
              hitSlop={8}
              onPress={() => {
                haptic("button");
                onClose();
              }}
            >
              <Text style={[s.flexLink, { color: accentSolid }]}>Jederzeit suchen</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={PAD_H20_B120}
            showsVerticalScrollIndicator={false}
            // Nur aktiv im Flexibel-Mode — friert das offscreen-Panel ein.
            scrollEnabled={mode === "flexible"}
          >
            <View style={s.cardGrid}>
              {monthCards.map((mc) => {
                const isSel = selMonthKey === mc.key;
                const cheap = mc.from < CHEAP_MONTH;
                return (
                  <Pressable
                    key={mc.key}
                    style={[
                      s.monthCard,
                      { backgroundColor: palette.s2 },
                      isSel && { backgroundColor: accentSubtle, borderWidth: 1, borderColor: accentBorder },
                    ]}
                    onPress={() => {
                      haptic("button");
                      setSelMonthKey(mc.key);
                    }}
                  >
                    <Text style={s.cardName}>{MONTHS[mc.m]}</Text>
                    <Text style={[s.cardPrice, cheap && { color: accentSolid }]}>
                      ab {mc.from} €
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </SlidingPanels>

      {/* Bottom Bar */}
      {/**
        * Der untere Abstand kommt aus der SICHEREN FLÄCHE, nicht aus einer
        * festen Zahl.
        *
        * Im Stilblatt standen 28 Punkte. Die reichen bei Gesten-Navigation
        * (rund 24) gerade so, bei einer Leiste mit drei Knöpfen (bis 48) nicht
        * — dort lag „Weiter" schon immer halb dahinter, und mit der Skalierung
        * auf kleinen Geräten wurde aus den 28 noch weniger. Die Leiste weiß
        * selbst, wie hoch sie ist; genau dafür gibt es den Wert.
        */}
      <View
        style={[
          s.bottomBar,
          { backgroundColor: palette.s1, paddingBottom: insets.bottom + 14 },
        ]}
      >
        <View style={{ flex: 1 }}>
          <Text style={s.bottomTitle} numberOfLines={1}>{bottomTitle}</Text>
          {/**
            * Antippbar — der Hinweis erklärt sich sonst nicht.
            *
            * „Geschätzte Preise" mit einem i daneben sieht aus wie etwas, das
            * man antippen kann; bisher passierte nichts. Die Meldung läuft über
            * dieselbe Stelle wie alle anderen in der App (`showAlert`), damit
            * sie auch aussieht wie alle anderen — ein eigener Dialog an dieser
            * einen Stelle wäre genau die Uneinheitlichkeit, die man später
            * mühsam wieder einsammelt.
            */}
          <Pressable
            style={s.estRow}
            hitSlop={8}
            onPress={() => {
              haptic("button");
              showAlert("Geschätzte Preise", ESTIMATED_PRICE_NOTE, [
                { text: "Verstanden" },
              ]);
            }}
          >
            <Text style={s.estTxt}>Geschätzte Preise</Text>
            <View style={[s.infoDot, { backgroundColor: palette.s3 }]}><Text style={s.infoTxt}>i</Text></View>
          </Pressable>
        </View>
        {hasSelection && (
          <Animated.View style={weiterBounce.style}>
            <Pressable
              style={[s.weiter, { backgroundColor: accentSolid }]}
              onPress={onWeiter}
              onPressIn={() => {
                // Wie am X-Knopf: Textur für die Rückfahrt im Berührungsfenster
                // anlegen. „Weiter" ist der häufigste Weg hier heraus.
                prepareLayer("pickerDate");
                weiterBounce.onPressIn();
              }}
              /**
               * `settle()` statt `onPressOut` — dieser Knopf löst eine Fahrt aus.
               *
               * `PRESS_OUT` ist unterdämpft und schwingt rund 430ms nach, also
               * fast die ganze Ausfahrt. Der Knopf liegt dabei auf einer Fläche,
               * die für die Bewegung als GPU-Textur eingefroren ist — eine Ebene
               * mit sich änderndem Inhalt muss aber in JEDEM Bild neu gerastert
               * werden. Die Feder kostet dort also nicht nur nichts, sie macht
               * die Textur wertlos.
               *
               * Genau dafür steht `settle()` in `lib/motion.tsx` bereit, samt
               * dieser Begründung. Benutzt hat es bisher nur die Ergebniskarte.
               */
              onPressOut={weiterBounce.settle}
            >
              <Text style={[s.weiterTxt, { color: accentTextOnSolid }]}>Weiter</Text>
            </Pressable>
          </Animated.View>
        )}
      </View>

      {/* Uhrzeit — dasselbe Blatt von unten wie Reisende und Klasse. */}
      <TimeSheetGate
        hour={hour}
        minute={minute}
        minuteStep={minuteStep}
        onApply={applyTime}
      />
    </View>
  );
});

// ----------------------------------------------------------------------
// ModeTabs — Tabs mit slidendem Active-Indicator (SearchHero-Design).
// Box-Style: 14/11px borderRadius, padding 4. Indicator translateX
// animated via withTiming für smooth aber snappy Wechsel.
// ----------------------------------------------------------------------
interface ModeTabsProps {
  mode: Mode;
  accentSolid: string;
  accentTextOnSolid: string;
  onChange: (m: Mode) => void;
}

const ModeTabs = memo(function ModeTabs({
  mode,
  accentSolid,
  accentTextOnSolid,
  onChange,
}: ModeTabsProps) {
  const palette = usePalette();
  const [trackWidth, setTrackWidth] = useState(0);
  // Indicator-Breite = halbe Track-Breite minus die 4px Padding auf jeder Seite
  const indicatorWidth = Math.max(0, (trackWidth - 8) / 2);
  // 0 = "specific" (links), 1 = "flexible" (rechts)
  const progress = useSharedValue(mode === "specific" ? 0 : 1);
  useEffect(() => {
    progress.value = withTiming(mode === "specific" ? 0 : 1, {
      duration: 240,
      easing: Easing.out(Easing.cubic),
    });
  }, [mode, progress]);

  /**
   * `width` gehört NICHT in den animierten Stil.
   *
   * Es ist hier gar nicht animiert — es ist eine gemessene Zahl. Steht sie
   * trotzdem darin, fällt der ganze Stil aus Reanimateds synchronem Weg heraus:
   * Auf Android dürfen nur bestimmte Eigenschaften direkt an die native View
   * (`transform` gehört dazu, `width` nicht), alles andere läuft pro Bild über
   * einen Klon des Schattenbaums samt Yoga-Durchlauf. Der Reiter-Wechsel hat
   * damit 240ms lang den teuren Weg genommen, obwohl sich nur eine
   * Verschiebung ändert.
   */
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.value * indicatorWidth }],
  }));
  const indicatorSize = useMemo(() => ({ width: indicatorWidth }), [indicatorWidth]);

  return (
    <View
      style={[s.tabs, { backgroundColor: palette.s2 }]}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      <Animated.View
        style={[
          s.tabIndicator,
          { backgroundColor: accentSolid },
          indicatorSize,
          indicatorStyle,
        ]}
      />
      <Pressable style={s.tab} onPress={() => onChange("specific")}>
        <Text
          style={[
            s.tabTxt,
            mode === "specific" && { color: accentTextOnSolid },
          ]}
        >
          Feste Daten
        </Text>
      </Pressable>
      <Pressable style={s.tab} onPress={() => onChange("flexible")}>
        <Text
          style={[
            s.tabTxt,
            mode === "flexible" && { color: accentTextOnSolid },
          ]}
        >
          Flexibel
        </Text>
      </Pressable>
    </View>
  );
});

interface DayCellProps {
  y: number;
  m: number;
  d: number;
  price: number;
  isSel: boolean;
  isToday: boolean;
  isPast: boolean;
  cheap: boolean;
  accentSolid: string;
  accentTextOnSolid: string;
  onPress: (y: number, m: number, d: number) => void;
}

const DayCell = memo(function DayCell({
  y,
  m,
  d,
  price,
  isSel,
  isToday,
  isPast,
  cheap,
  accentSolid,
  accentTextOnSolid,
  onPress,
}: DayCellProps) {
  const handlePress = useCallback(
    () => onPress(y, m, d),
    [onPress, y, m, d],
  );
  return (
    <Pressable
      style={[
        s.dayCell,
        isSel && { backgroundColor: accentSolid },
        !isSel && isToday && { borderWidth: 1.5, borderColor: accentSolid },
      ]}
      disabled={isPast}
      onPress={handlePress}
    >
      {/* Tag + Preis in EINEM Text-Node (verschachtelt) statt zwei separaten
          Text-Views → eine native View weniger pro Zelle. Bei ~56 Zellen spart
          das ~56 Views/Frame auf dem UI-Thread. */}
      <Text
        style={[
          s.dayNum,
          { textAlign: "center" },
          isSel
            ? { color: accentTextOnSolid, fontWeight: "800" }
            : isPast
            ? s.dayNumPast
            : s.dayNumNormal,
        ]}
      >
        {d}
        {!isPast && (
          <Text
            style={[
              s.dayPrice,
              isSel
                ? { color: "rgba(0,0,0,0.62)" }
                : cheap
                ? { color: accentSolid }
                : s.dayPriceNormal,
            ]}
          >
            {"\n"}
            {price} €
          </Text>
        )}
      </Text>
    </Pressable>
  );
});

const s = scaledStyles({
  root: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingBottom: 14,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  // Matched die "Saved"-Überschrift aus app/(tabs)/saved.tsx:
  //   text-[26px] font-black text-white tracking-tight
  title: { fontSize: 26, fontWeight: "900", color: C.white, letterSpacing: -0.6 },

  // Tabs — matched SearchHero's toggleRow: 14px außen, 11px innen, padding 4
  tabs: {
    marginHorizontal: 16,
    marginBottom: 14,
    flexDirection: "row",
    backgroundColor: C.surface2,
    borderRadius: 14,
    padding: 4,
    position: "relative",
  },
  // Slidender Active-Indicator. Absolute positioniert, top/bottom 4 = padding
  // des Containers; left 4; translateX wird in der Animated.View gesetzt.
  tabIndicator: {
    position: "absolute",
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: 11,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 11, alignItems: "center" },
  tabTxt: { fontSize: 13, fontWeight: "700", color: C.gray300 },

  field: {
    marginHorizontal: 20,
    marginBottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingLeft: 18,
    paddingRight: 16,
    backgroundColor: C.surface1,
    borderRadius: 18,
  },
  fieldLabel: { fontSize: 11, color: C.gray300, fontWeight: "600", letterSpacing: 0.4 },
  fieldValue: { fontSize: 17, color: C.white, fontWeight: "700", marginTop: 1, letterSpacing: -0.2 },
  fieldPlaceholder: { fontSize: 17, color: C.gray500, fontWeight: "600", marginTop: 1, letterSpacing: -0.2 },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 9999,
  },
  timeChipTxt: { fontSize: 15, fontWeight: "800" },

  body: { flex: 1 },
  weekRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.surface2,
  },
  weekday: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "600", color: C.gray500 },

  monthLabel: { fontSize: 24, lineHeight: 30, includeFontPadding: false, fontWeight: "800", color: C.white, letterSpacing: -0.4, marginBottom: 8 },
  dayRow: { flexDirection: "row", marginBottom: 3 },
  dayCell: {
    flex: 1,
    minHeight: 52,
    marginHorizontal: 1.5,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  dayNum: { fontSize: 15, fontWeight: "600" },
  dayNumNormal: { color: C.white },
  dayNumPast: { color: C.gray700 },
  dayPrice: { fontSize: 10.5, fontWeight: "600", marginTop: 1 },
  dayPriceNormal: { color: C.gray300 },

  flexHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  flexTitle: { fontSize: 22, fontWeight: "800", color: C.white, letterSpacing: -0.4 },
  flexLink: { fontSize: 14, fontWeight: "700", textDecorationLine: "underline" },
  cardGrid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  monthCard: {
    width: "48%",
    minHeight: 112,
    marginBottom: 12,
    paddingVertical: 18,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: C.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  cardName: { fontSize: 19, color: C.white, fontWeight: "700", letterSpacing: -0.2 },
  cardPrice: { fontSize: 13, fontWeight: "600", color: C.gray300, marginTop: 5 },

  bottomBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 28,
    backgroundColor: C.bg,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  bottomTitle: { fontSize: 13, color: C.white, fontWeight: "700" },
  estRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  estTxt: { fontSize: 12, color: C.gray300, fontWeight: "600", textDecorationLine: "underline" },
  infoDot: {
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: C.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  infoTxt: { fontSize: 10, color: C.gray300, fontWeight: "700" },
  weiter: { paddingVertical: 15, paddingHorizontal: 30, borderRadius: 9999 },
  weiterTxt: { fontSize: 15, fontWeight: "700" },

});
