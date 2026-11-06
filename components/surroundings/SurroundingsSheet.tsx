import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { softSheetMotion } from "@/lib/nav/overlayCover";
import { haptic } from "@/lib/haptics";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  useWindowDimensions,
  Pressable,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
} from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";
import {
  Train,
  Bus,
  TramFront,
  Plane,
  Ship,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react-native";
import { SubwayIcon } from "@/components/ui/SubwayIcon";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useT } from "@/lib/i18n/useT";
import { MarkerKind, SheetMode, StopListItem } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { SPACE, TITLE_GAP, GROUP_GAP, GUTTER, ITEM_GAP } from "@/lib/theme/spacing";
import {
  dragHealOffset,
  snapToPixel,
  settleHeal,
  startDragHeal,
  useSheetScrollGate,
} from "@/lib/ui/sheetSwipe";
import { SHEET_TABS_HEIGHT, SheetTabs } from "@/components/surroundings/SheetTabs";
import { SHEET_HEAD_TOP, SheetHandle } from "@/components/ui/SheetModal";
import { chromeShift, travelBottom } from "@/lib/surroundings/mapChrome";
import {
  stopSheetHeal,
  stopSheetSnap,
  stopSheetY,
} from "@/components/surroundings/stopSheetAnimation";
import { reportSurroundingsTarget } from "@/lib/surroundings/mapViewport";
import { TRANSIT_COLOR, tint } from "@/lib/theme/transitColors";
import { slideTiming } from "@/lib/nav/slideMotion";

const LIME = "#7FEA4D";
const LIME_SUB = "rgba(127,234,77,0.18)";
/**
 * Chip-Styling pro Marker-Typ — in den Farben der Verkehrsmittel der ganzen App
 * (lib/theme/transitColors.ts), getönt. U-Bahn und Tram sind zu dunkel für ein
 * farbiges Symbol auf dunklem Grund: dort Symbol weiß auf ihrer Tönung.
 */
const KIND_CHIP_STYLE: Record<string, { bg: string; fg: string }> = {
  train: { bg: tint(TRANSIT_COLOR.regional, 0.18), fg: TRANSIT_COLOR.regional },
  subway: { bg: tint(TRANSIT_COLOR.subway, 0.5), fg: "#FFFFFF" },
  tram: { bg: "rgba(255,255,255,0.10)", fg: "#FFFFFF" },
  // airport entfernt — wird zur Laufzeit aus accent berechnet (siehe useAccent).
  bus: { bg: tint(TRANSIT_COLOR.bus, 0.22), fg: TRANSIT_COLOR.bus },
  cruise: { bg: tint(TRANSIT_COLOR.ferry, 0.2), fg: TRANSIT_COLOR.ferry },
};
const C = {
  bg: "#171719",
  border: "#212123",
  white: "#F4F4F5",
  g1: "#C4C4C8",
  g2: "#8E8E93",
  g3: "#56565C",
  s2: "#171719",
  s3: "#212123",
  s4: "#2D2D31",
};

/**
 * Fläche des Blattes: die Hintergrundfarbe wie im Rest der App (`s1`), Karten
 * und Chips eine Stufe darüber (`s2`) — wie unter „Geplant". Auf "s2" gestellt
 * hebt sich das Blatt von Karte und Tab-Leiste ab; Karten und Chips rücken dann
 * von selbst auf `s3`. (03.11.2026: erst s2 probiert, Nutzer wollte zurück.)
 */
const SURFACE = "s1" as "s1" | "s2";
type Palette = ReturnType<typeof usePalette>;
const sheetTone = (p: Palette) => p[SURFACE];
const cardTone = (p: Palette) => (SURFACE === "s2" ? p.s3 : p.s2);

/** Der Kasten vorn in der Karte — dieselben Farben wie die Kästen auf der Karte (assets/marker-icons/box-*.png). */
const LEAD_COLOR: Record<MarkerKind, string | null> = {
  train: TRANSIT_COLOR.regional,
  subway: TRANSIT_COLOR.subway,
  bus: TRANSIT_COLOR.bus,
  tram: TRANSIT_COLOR.tram,
  cruise: TRANSIT_COLOR.ferry,
  // Akzent — kommt zur Laufzeit aus `useAccent`.
  airport: null,
};

const KIND_ICON: Record<MarkerKind, LucideIcon> = {
  train: Train,
  subway: SubwayIcon, // „U" wie auf der Karte
  bus: Bus,
  tram: TramFront,
  airport: Plane,
  cruise: Ship,
};

/**
 * Die neue Liste kommt, wenn die Kamera angekommen ist. Der Flug beim Wechsel
 * dauert 0,9 s (`cameraMove` in MapSurface.tsx, acht Stufen Zoom) und startet
 * zwei Bilder nach der Wahl.
 */
const LIST_SETTLE_MS = 1100;

/** Ob das Blatt schon einmal stand — siehe `firstMount`. */
let sheetMountedOnce = false;
const LIST_FADE_OUT = { duration: 90, easing: Easing.out(Easing.quad) };
const LIST_FADE_IN = { duration: 220, easing: Easing.out(Easing.cubic) };

const MODE_TABS: { mode: SheetMode; tKey: string; Icon: LucideIcon }[] = [
  { mode: "transit", tKey: "surroundings.mode.transit", Icon: Train },
  { mode: "airport", tKey: "surroundings.mode.airport", Icon: Plane },
  { mode: "cruise", tKey: "surroundings.mode.cruise", Icon: Ship },
];

const TITLE_KEY: Record<SheetMode, string> = {
  transit: "surroundings.title.transit",
  airport: "surroundings.title.airport",
  cruise: "surroundings.title.cruise",
};

interface Props {
  mode: SheetMode;
  setMode: (m: SheetMode) => void;
  items: StopListItem[];
  /**
   * Antippen einer Zeile. Der Bildschirm darüber entscheidet, was das heißt —
   * hier wird nur die Kennung durchgereicht, die Zeile und Kartennadel teilen.
   */
  onSelectStop: (id: string) => void;
  /**
   * Was über dem Blatt rechts schwebt — der Standort-Knopf, wie bei Google.
   *
   * Das Blatt hält es selbst, weil nur das Blatt seine Lage kennt: Es steht
   * immer denselben Abstand über der Oberkante, fährt beim Aufziehen mit und
   * blendet sich aus, sobald das Blatt über den mittleren Rastpunkt hinaus
   * steigt — dort ist die Karte zu klein, als dass der Knopf noch helfen würde,
   * und er stieße oben an die Suchleiste.
   *
   * Ist das Haltestellen- bzw. Stadt-Blatt offen und reicht höher, steht der
   * Knopf über DESSEN Kante (siehe `accessoryAnim`).
   */
  accessory?: ReactNode;
}


/** Abstand des schwebenden Knopfes zur Oberkante des Blattes — das Raster. */
const ACCESSORY_GAP = SPACE.md;
/**
 * Über welche Strecke oberhalb des mittleren Rastpunkts der Knopf ausblendet.
 * Lang genug, dass er beim Aufziehen weich geht statt zu verschwinden.
 */
const ACCESSORY_FADE = 120;

/** Nachlauf nach dem Loslassen — wie beim Haltestellen-Blatt (`settleStopSheet`). */
const SETTLE_TAIL_MS = 900;

/**
 * So weit taucht das Blatt beim Ausweichen ÜBER seine sichtbare Höhe hinaus
 * ab — sein Schatten reicht rund 40 Punkte über die Oberkante.
 */
const YIELD_SHADOW = 48;

/**
 * Wie weit dieses Blatt gerade dem Haltestellen- bzw. Stadt-Blatt ausweicht
 * (siehe unten im Blatt). Auf MODULEBENE und mit allen Größen als Argument:
 * Eine Funktion im Bauteil wäre bei jedem Durchgang eine neue — und weil die
 * Lage-Stile sie mitnehmen, legte Reanimated beide Stile bei jedem Rendern
 * neu an, samt neuem Startwert aus dem JS-Strang. Mehr Durchgänge, die eine
 * Lage zurückschreiben können, war genau das Falsche.
 */
function stopYield(own: number, stopClosed: number, sheetHeight: number): number {
  "worklet";
  const rise = Math.max(0, stopClosed - stopSheetY.value);
  return Math.min(rise, Math.max(0, sheetHeight - own) + YIELD_SHADOW);
}

/**
 * `memo`: Der Karten-Tab rendert oft (Ortung, Kamera in Ruhe, jedes Paket
 * Gleisverläufe der Stadt) — ohne Schranke lief dieses Blatt samt Liste jedes
 * Mal mit. Der Knopf darüber (`accessory`) kommt dafür fest gehalten an.
 */
export const SurroundingsSheet = memo(function SurroundingsSheet({
  mode,
  setMode,
  items,
  onSelectStop,
  accessory,
}: Props) {
  const palette = usePalette();
  const t = useT();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  // Snap points als translateY-Offsets relativ zur Top-Position des Sheets.
  // 0 = full open (Sheet bedeckt fast den ganzen Screen, oben 80px frei).
  // PEEK = Sheet zeigt nur Handle + Tabs + Title + ein Listenelement,
  // FloatingTabBar bleibt darunter sichtbar.
  const snap = useMemo(() => {
    const fullTop = Math.max(60, insets.top + 12);
    const sheetHeight = screenHeight - fullTop;
    // Platz für die Tab-Leiste — skaliert wie die Leiste selbst (`ms`, siehe
    // `TAB_BAR_H`). Hier stand der Rohwert: Auf Geräten mit Faktor < 1 lag das
    // Blatt um die Differenz zu hoch, auf großen saßen die Chips 3 Punkte über
    // der Leiste („scheiß Spacing", 04.11.2026).
    const tabBarSpace = ms(TAB_BAR_H) + insets.bottom;
    /**
     * Was im Ruhezustand ÜBER der Tab-Leiste steht: Griffzone, Reiter-Reihe und
     * darunter Luft bis zur Leiste — `GROUP_GAP`, denn dort beginnt die nächste
     * Gruppe (die Leiste ist eine Stufe heller als das Blatt, die Chips haben
     * ihre Farbe: ohne Abstand verschmolzen sie mit ihr).
     *
     * Alles mit dem Faktor der Stilblätter (`ms` je Maß, wie `scaledStyles`):
     * Vorher standen hier Rohwerte der alten Reiter (12 + 18 + 12 + Linie), die
     * mit der Pillen-Reihe nichts mehr zu tun hatten.
     */
    const HANDLE_ZONE = ms(SHEET_HEAD_TOP);
    const peekVisible = HANDLE_ZONE + SHEET_TABS_HEIGHT + ms(GROUP_GAP);
    const midVisible = Math.min(sheetHeight - 80, Math.max(420, screenHeight * 0.5));
    return {
      fullTop,
      sheetHeight,
      tabBarSpace,
      peekVisible,
      // Vom Sheet aus runter geschoben (positiv = weiter unten):
      full: 0,
      mid: Math.max(0, sheetHeight - midVisible - tabBarSpace),
      peek: Math.max(0, sheetHeight - peekVisible - tabBarSpace),
    };
  }, [screenHeight, insets.top, insets.bottom]);

  /**
   * Wo das Blatt beim Einhängen steht.
   *
   * Mit dem Tab (erstes Einhängen): GLEICH in der Ruhestellung. Vorher fuhr es
   * vom unteren Bildrand herein — die ganze Blatthöhe (rund 750 Punkte) in
   * 300 ms, genau während die Karte ihren Stil aufbaut: „kommt so nach oben
   * geschossen … das laggt auch" (04.11.2026). Die Karte, die Leiste, alles
   * andere steht beim Tab-Wechsel einfach da — das Blatt jetzt auch.
   *
   * Später (nach Live-Ansicht oder Route, wenn das Blatt wiederkommt): kurz und
   * weich hinter der Leiste hervor, nur um das sichtbare Stück
   * (`softSheetMotion`) — die Karte steht da schon.
   */
  const firstMount = useRef(!sheetMountedOnce).current;
  const translateY = useSharedValue(firstMount ? snap.peek : snap.peek + snap.peekVisible);
  /**
   * Nur-Karte-Modus: Das Blatt steht in der unteren Bildhälfte, fährt also nach
   * UNTEN hinaus — mit derselben Verschiebung wie alle anderen Teile, bis das
   * Stück, das gerade zu sehen ist, hinter dem Rand liegt (siehe
   * `lib/surroundings/mapChrome.ts`). Die eigenen Rastpunkte bleiben
   * unberührt; beim Zurückholen steht es wieder, wo es stand.
   */
  /** Selbstkorrektur beim Ziehen — siehe `startDragHeal` in lib/ui/sheetSwipe.ts. */
  const heal = useSharedValue(0);
  /**
   * AUSWEICHEN, solange das Haltestellen- bzw. Stadt-Blatt offen ist (Nutzer
   * 05.11.2026: die Auswahl dahinter „soll nicht sichtbar sein" — auch nicht,
   * wenn jenes eingeklappt unten liegt).
   *
   * Gekoppelt an dessen Lage, Punkt für Punkt: Steigt es um d, sinkt dieses um
   * d, bis es samt Schatten unter dem Rand ist; schließt es, kommt dieses im
   * selben Maß zurück. Kein Zustand, kein Render — beide Werte leben auf dem
   * UI-Strang, die Übergabe passiert im selben Bild. Beide Blätter beginnen an
   * derselben Oberkante (`fullTop`), die Lagen sind direkt vergleichbar.
   */
  const stopSnap = useMemo(
    () => stopSheetSnap(screenHeight, insets.top, insets.bottom),
    [screenHeight, insets.top, insets.bottom],
  );
  const stopClosed = stopSnap.sheetHeight;
  const stopMid = stopSnap.mid;
  const sheetH = snap.sheetHeight;
  const sheetAnim = useAnimatedStyle(() => {
    const own = translateY.value + stopYield(translateY.value, stopClosed, sheetH);
    const y = own + Math.min(chromeShift.value, Math.max(0, sheetH - own));
    // Auf ganze Gerätepixel — sonst zittert die Schrift beim Ziehen gegen ihre
    // Flächen (siehe `snapToPixel`). Dazu BEIDE Selbstkorrekturen: die eigene
    // und die des Haltestellen-Blatts — dieses Blatt folgt dessen Lage, also
    // muss es auch nach dessen Fahrten nachgeschrieben werden
    // (`settleStopSheet`).
    return {
      transform: [
        { translateY: snapToPixel(y) + dragHealOffset(heal) + dragHealOffset(stopSheetHeal) },
      ],
    };
  });

  /**
   * Der schwebende Knopf — seine Lage folgt Bild für Bild dem Blatt.
   *
   * Nur-Karte-Modus: Das Blatt fährt nach unten hinaus, und der Knopf darüber
   * fährt mit. Weil er über der Oberkante steht, reichte das nicht: Er stünde
   * am Ende knapp über dem unteren Rand. Deshalb zusätzlich um seinen eigenen
   * Abstand samt Schatten weiter hinunter.
   *
   * Die Höhe wird gemessen (sie hängt an der Schriftskalierung), die Zahlen
   * rechnet `ms` VOR dem Worklet aus — auf dem UI-Strang gibt es nur Worklets.
   */
  const accessoryGap = ms(ACCESSORY_GAP);
  const accessoryH = useSharedValue(ms(44));
  const onAccessoryLayout = useCallback(
    (e: LayoutChangeEvent) => {
      accessoryH.value = e.nativeEvent.layout.height;
    },
    [accessoryH],
  );
  /**
   * ÜBER DEM HÖHEREN DER BEIDEN BLÄTTER.
   *
   * Das Haltestellen- bzw. Stadt-Blatt (StopDetailSheet) hängt am
   * Wurzel-Layout und liegt über diesem Bildschirm. Fuhr es herein, schob es
   * sich einfach über den Knopf — gemeldet als „der Button wird verdeckt". Jetzt
   * steht er über der Kante des Blattes, das höher reicht: Das hereinfahrende
   * Blatt nimmt ihn mit, beim Schließen sinkt er mit zurück auf dieses hier.
   * Beide Blätter beginnen an derselben Oberkante (`fullTop`), ihre Lagen sind
   * also direkt vergleichbar.
   *
   * Ausgeblendet wird nach der Regel des jeweiligen Blattes (über seinem
   * mittleren Rastpunkt) — genommen wird die strengere, damit er über einem
   * ganz aufgezogenen Blatt nie stehen bleibt.
   *
   * NUR-KARTE-MODUS: Der Knopf fährt dieselbe Verschiebung wie alles andere.
   * Steht er über dem Haltestellen-Blatt, taucht er nach seiner eigenen Höhe
   * hinter dessen Kante ab und kommt beim Zurückholen dort wieder heraus —
   * dieses Blatt gehört zum Inhalt, nicht zur Oberfläche, und bleibt stehen
   * (ein Tipp auf eine Haltestelle öffnet es auch im Nur-Karte-Modus).
   * Gemeldet wird weiter nur der Weg über DIESEM Blatt (`travelBottom`): Er
   * ist mindestens so lang, dass der Knopf danach auf jeden Fall hinter einem
   * der beiden Blätter oder unter dem Rand liegt — auch wenn das
   * Haltestellen-Blatt im Nur-Karte-Modus geschlossen wird.
   *
   * Auf ganze Gerätepixel wie die Blätter selbst, und zwar Kante und Abstand
   * EINZELN: Sonst schwankte der Abstand zur Kante beim Ziehen um ein Pixel.
   */
  const accessoryAnim = useAnimatedStyle(() => {
    const lift = snapToPixel(accessoryH.value + accessoryGap);
    // Die SICHTBARE Lage dieses Blattes — mit dem Ausweichen von oben.
    const own = translateY.value + stopYield(translateY.value, stopClosed, sheetH);
    const stop = stopSheetY.value;
    const edge = Math.min(own, stop);
    // Der Knopf fährt mit — und weiter, bis auch er hinter dem Rand ist: Er
    // steht über der Kante, sein Weg ist um diesen Abstand länger.
    const travel = snap.sheetHeight - edge + lift + 24;
    const y = edge + Math.min(chromeShift.value, travel);
    const ownFade = (own - (snap.mid - ACCESSORY_FADE)) / ACCESSORY_FADE;
    const stopFade = (stop - (stopMid - ACCESSORY_FADE)) / ACCESSORY_FADE;
    const opacity = Math.min(1, Math.max(0, Math.min(ownFade, stopFade)));
    return {
      opacity,
      transform: [
        {
          // Mit der Selbstkorrektur BEIDER Blätter: Der Knopf hängt an der
          // Kante dessen, das gerade höher reicht.
          translateY:
            snapToPixel(y) -
            lift +
            dragHealOffset(heal) +
            dragHealOffset(stopSheetHeal),
        },
        // Ganz ausgeblendet aus dem Weg — ein unsichtbarer Knopf finge sonst
        // Tipps auf die Karte ab.
        { translateX: opacity < 0.01 ? 10000 : 0 },
      ],
    };
  });
  /**
   * Den eigenen Weg melden — er hängt am Rastpunkt, ändert sich also, wenn das
   * Blatt gezogen wird. Die Verschiebung des Nur-Karte-Modus muss bis zum
   * längsten Weg aller Teile laufen (`maxTravel`).
   */
  const hasAccessory = accessory != null;
  useAnimatedReaction(
    () =>
      snap.sheetHeight -
      translateY.value +
      (hasAccessory ? accessoryH.value + accessoryGap + 24 : 0),
    (travel) => {
      travelBottom.value = travel;
    },
    [hasAccessory, snap.sheetHeight, accessoryGap],
  );

  useEffect(() => {
    sheetMountedOnce = true;
    if (!firstMount) translateY.value = withTiming(snap.peek, slideTiming(softSheetMotion(snap.peekVisible).in));
    reportSurroundingsTarget(snap.peek);
    // Nur beim Einhängen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Gezogen wird am GANZEN Blatt, nicht nur am Strich oben.
   *
   * Damit ein Tipper auf einen Reiter oder eine Zeile ein Tipper bleibt, springt
   * der Erkenner erst nach acht Punkten Weg an — bis dahin gehört die Berührung
   * dem Knopf darunter. Beide Richtungen, denn hier wird hoch UND runter
   * gezogen. Die Querschranke hält schräge Bewegungen heraus.
   *
   * Der Torhüter ist dieselbe Hilfe wie in allen anderen Blättern
   * (`lib/ui/sheetSwipe.ts`): Die Liste bekommt einen eigenen nativen Erkenner,
   * beide sind als gleichzeitig angemeldet — sonst bräche das Anspringen der
   * einen die andere ab —, und der Scroll-Stand entscheidet, wer die Bewegung
   * zeigt.
   */
  const gate = useSheetScrollGate();
  const startY = useSharedValue(0);
  const base = useSharedValue(0);
  /**
   * Hat sich das Blatt in DIESER Geste schon bewegt?
   *
   * Damit entscheidet sich, wem die Berührung gehört, und zwar EINMAL pro
   * Geste statt Bild für Bild: Solange sich nichts bewegt hat, darf die Liste
   * scrollen; sobald das Blatt einmal gewandert ist, gehört ihm der Rest der
   * Bewegung. Ohne diesen Merker entschiede allein der Scroll-Stand — und der
   * kippt genau dann, wenn der Finger wieder nach oben geht: Das Blatt bliebe
   * mitten im Zug stehen.
   *
   * Die anderen Blätter halten stattdessen die Liste fest (`scrollTo`). Das
   * geht hier nicht, weil das an einen Verweis auf die Liste gebunden ist und
   * eine `FlatList` daran abstürzt — die Begründung steht bei `ref` in
   * `useSheetScrollGate`.
   */
  const moved = useSharedValue(false);
  /**
   * In `useMemo` — sonst entsteht sie bei jedem Render neu.
   *
   * Dieser Baum rendert unter anderem dann, wenn die Karte nach einer Bewegung
   * zur Ruhe kommt und neue Daten schreibt. Jedes neue `Gesture.Pan()`-Objekt
   * muss der Erkenner gegen seinen nativen Gegenpart abgleichen und neu
   * einrichten. Die Rastpunkte sind die einzige Abhängigkeit.
   */
  const pan = useMemo(() =>
    Gesture.Pan()
    .activeOffsetY([-8, 8])
    .simultaneousWithExternalGesture(gate.native)
    .onBegin(() => {
      startDragHeal(heal);
    })
    .onStart((e) => {
      startY.value = translateY.value;
      base.value = e.translationY;
      moved.value = false;
    })
    .onUpdate((e) => {
      // `gate.onList`: Nur eine Berührung, die AUF der Liste liegt, darf sie
      // beanspruchen. Ohne das sperrte eine gescrollte Liste das ganze Blatt —
      // auch das Ziehen am Griff oder an den Reitern. Das war das „lässt sich
      // manchmal nicht aufziehen, bis man die Kategorie wechselt".
      if (!moved.value && gate.onList.value && gate.scrollY.value > 0.5) {
        // Die Liste scrollt noch — das Blatt bleibt stehen, der Nullpunkt geht
        // mit. Ohne das Mitwandern spränge es um die ganze Scroll-Strecke,
        // sobald die Liste oben ankommt.
        startY.value = translateY.value;
        base.value = e.translationY;
        return;
      }
      const next = startY.value + (e.translationY - base.value);
      translateY.value = Math.max(snap.full, Math.min(snap.peek, next));
      // Ab der ersten echten Bewegung gehört die Geste dem Blatt — siehe `moved`.
      if (Math.abs(translateY.value - startY.value) > 0.5) moved.value = true;
    })
    .onEnd((e) => {
      const final = startY.value + (e.translationY - base.value);
      const points = [snap.full, snap.mid, snap.peek];
      let closest = points[0];
      let bestDist = Infinity;
      for (const p of points) {
        const d = Math.abs(p - final);
        if (d < bestDist) {
          bestDist = d;
          closest = p;
        }
      }
      /**
       * Der Schwung zählt nur für ein Blatt, das sich auch bewegt hat.
       *
       * Sonst risse ein kräftiger Wisch IN der Liste das Blatt auf oder zu: Der
       * Erkenner läuft dabei mit, bewegt nichts — und läse am Ende trotzdem die
       * Geschwindigkeit des Listen-Wischs.
       */
      if (moved.value && e.velocityY < -800) closest = snap.full;
      else if (moved.value && e.velocityY > 800) closest = snap.peek;
      /**
       * Zeitkurve statt Feder — wie im Haltestellen-Blatt daneben.
       *
       * Die Feder hier hatte einen Dämpfungsgrad von rund 0,68 und schwang
       * damit um gut 5% über. Am obersten Rastpunkt heißt das: Das Blatt fährt
       * über seine Oberkante hinaus, und unten blitzt für ein paar Bilder die
       * Karte durch. Am Griff allein fiel das kaum auf; auf der ganzen Fläche
       * zieht man deutlich häufiger.
       */
      translateY.value = withTiming(closest, { duration: 180, easing: Easing.out(Easing.quad) });
      // Das Ziel melden — die Kamera setzt den Standort in den neuen freien
      // Ausschnitt (siehe lib/surroundings/mapViewport.ts).
      runOnJS(reportSurroundingsTarget)(closest);
    })
    /**
     * Merker „Finger liegt auf der Liste" beim Ende der Berührung löschen.
     *
     * Der native Erkenner der Liste tut das selbst — aber nur, wenn es ihn beim
     * Loslassen noch gibt. Wird sie mitten in einer Berührung abgebaut, bliebe
     * er stehen und die Liste beanspruchte danach jede Geste.
     */
    .onFinalize(() => {
      gate.onList.value = false;
      // Nachlauf statt Stopp: über das Einrasten (180 ms) hinaus nachschreiben
      // — siehe `settleHeal` in lib/ui/sheetSwipe.ts.
      settleHeal(heal, 180 + SETTLE_TAIL_MS);
    }),
  [snap, startY, base, moved, translateY, gate, heal]);

  /**
   * Beim Wechsel der Art: Die Liste tritt sofort zurück (Deckkraft, UI-Strang)
   * und wird erst NACH der Kamerafahrt getauscht, dann weich eingeblendet.
   *
   * Mit der Wahl tauschte die Liste ihre Zeilen aus — erst nur die ersten acht,
   * aber auch die wollen gebaut und eingehängt werden, und das genau, wenn die
   * Kamera losfährt, deren Kurve auf demselben UI-Strang rechnet: „laggt
   * manchmal immer noch" (04.11.2026). Jetzt bleiben während der Fahrt die
   * ALTEN Zeilen hängen (unsichtbar, unverändert — nichts zu bauen), und der
   * Tausch kommt, wenn die Kamera steht (`LIST_SETTLE_MS`). Die Liste beginnt
   * dabei oben: Der Stand der alten Liste hat mit der neuen nichts zu tun.
   */
  const [calmMode, setCalmMode] = useState(mode);
  const settling = calmMode !== mode;
  useEffect(() => {
    if (!settling) return;
    const id = setTimeout(() => setCalmMode(mode), LIST_SETTLE_MS);
    return () => clearTimeout(id);
  }, [mode, settling]);
  const calmItemsRef = useRef(items);
  if (!settling) calmItemsRef.current = items;
  const listData = settling ? calmItemsRef.current : items;
  const listRef = useRef<FlatList<StopListItem>>(null);
  const listFade = useSharedValue(1);
  const listFadeStyle = useAnimatedStyle(() => ({ opacity: listFade.value }));
  const shownModeRef = useRef(calmMode);
  useEffect(() => {
    if (settling) return;
    if (shownModeRef.current !== calmMode) {
      shownModeRef.current = calmMode;
      gate.scrollY.value = 0;
      listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }
    // Auch beim Hin-und-zurück vor dem Tausch (A → B → A): wieder einblenden.
    if (listFade.value !== 1) listFade.value = withTiming(1, LIST_FADE_IN);
  }, [settling, calmMode, gate, listFade]);
  const pickMode = useCallback(
    (m: SheetMode) => {
      // Die alte Liste tritt schon zurück, während der Umbau läuft.
      if (m !== mode) listFade.value = withTiming(0, LIST_FADE_OUT);
      setMode(m);
    },
    [mode, setMode, listFade],
  );

  const title = t(TITLE_KEY[mode]);

  return (
    <>
    {accessory ? (
      <Animated.View
        style={[styles.accessory, { top: snap.fullTop }, accessoryAnim]}
        pointerEvents="box-none"
        onLayout={onAccessoryLayout}
      >
        {accessory}
      </Animated.View>
    ) : null}
    <GestureDetector gesture={pan}>
    <Animated.View
      style={[
        styles.sheet,
        { backgroundColor: sheetTone(palette) },
        { top: Math.max(60, insets.top + 12), height: snap.sheetHeight },
        sheetAnim,
      ]}
    >
      {/* Nur noch Zeichen, nicht mehr Griff: Gezogen wird überall. Der Strich
          bleibt, weil er ansagt, DASS gezogen werden kann. */}
      <SheetHandle />

      {/* Dieselbe Reiter-Reihe wie im Stadt-Blatt — siehe SheetTabs.tsx. */}
      <SheetTabs
        tabs={MODE_TABS.map(({ mode: tabMode, tKey, Icon }) => ({
          key: tabMode,
          label: t(tKey),
          Icon,
        }))}
        active={mode}
        onChange={pickMode}
        chipColor={cardTone(palette)}
      />

      <View style={styles.titleRow}>
        <View style={styles.titleLeft}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {items.length > 0 ? (
            <View style={[styles.count, { backgroundColor: cardTone(palette) }]}>
              <Text style={styles.countText}>{items.length}</Text>
            </View>
          ) : null}
        </View>
        <RippleTouch
          style={[styles.round, { backgroundColor: cardTone(palette) }]}
          borderless
          accessibilityRole="button"
          accessibilityLabel={t("surroundings.filter")}
        >
          <SlidersHorizontal color={C.white} size={16} strokeWidth={2.2} />
        </RippleTouch>
      </View>

      <SelectStopContext.Provider value={onSelectStop}>
      {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am
          Blatt jedes Scrollen ab. */}
      <GestureDetector gesture={gate.native}>
      <Animated.FlatList
        ref={listRef as never}
        style={[styles.scroll, listFadeStyle]}
        data={listData}
        keyExtractor={keyExtractor}
        renderItem={renderStopRow}
        contentContainerStyle={{ paddingBottom: snap.tabBarSpace + 40 }}
        showsVerticalScrollIndicator={false}
        onScroll={gate.onScroll}
        scrollEventThrottle={16}
        // Kein Überzieh-Schimmer oben: Dort übernimmt ab sofort das Blatt.
        overScrollMode="never"
        bounces={false}
        // Performance: nur die sichtbaren Rows rendern statt alle 60 auf einmal.
        windowSize={5}
        maxToRenderPerBatch={8}
        initialNumToRender={8}
        /**
         * `removeClippedSubviews` MUSS bleiben — es war zwischenzeitlich
         * ausgebaut, und das war ein Fehler mit spürbarer Folge.
         *
         * Die Begründung damals: Android rechne den sichtbaren Ausschnitt beim
         * Verschieben des Blattes nicht nach. Falsch gedacht — abgehängt wird
         * relativ zum EIGENEN Ausschnitt der Liste, und der wandert mit dem
         * Blatt mit, ändert sich also gar nicht. Ohne die Option hingen dafür
         * ALLE gebauten Zeilen dauerhaft im Baum (`windowSize` 5 = fünf
         * Bildschirmhöhen, Dutzende Haltestellen mit Chips und Welle), und die
         * wurden bei JEDEM Kartenbild mit durchgegangen — die Karte ist eine
         * TextureView und zeichnet das Fenster bei jedem Bild neu. Gemeldet als
         * „die Karte ruckelt beim Ausrollen wieder stark".
         */
        removeClippedSubviews
        ListFooterComponent={
          <Text style={styles.footer}>
            {items.length} {t("surroundings.footer.suffix")}
          </Text>
        }
      />
      </GestureDetector>
      </SelectStopContext.Provider>
    </Animated.View>
    </GestureDetector>
    </>
  );
});

/**
 * Der Rückruf fürs Antippen einer Zeile — über den Kontext, nicht als Eigenschaft.
 *
 * `renderStopRow` steht bewusst auf Modulebene: Eine bei jedem Render neu
 * gebaute Zeichenfunktion nimmt der Liste jede Möglichkeit, Zeilen
 * wiederzuverwenden, und macht das `memo` an `StopRow` wertlos. Über den Inhalt
 * ändert sich weder das eine noch das andere.
 */
const SelectStopContext = createContext<(id: string) => void>(() => {});

const keyExtractor = (item: StopListItem) => item.id;
const renderStopRow = ({ item }: ListRenderItemInfo<StopListItem>) => (
  <StopRow item={item} />
);

/**
 * Eine Haltestelle als Karte (Richtung B): vorn der Kasten wie auf der Karte,
 * daneben Name und Linien, rechts die Entfernung. Keine Auswahl-Markierung —
 * ausdrücklich nicht gewünscht.
 */
const StopRow = memo(function StopRow({ item }: { item: StopListItem }) {
  const accent = useAccent();
  const palette = usePalette();
  const onSelectStop = useContext(SelectStopContext);
  const [lead, ...more] = item.kinds;
  const LeadIcon = lead ? KIND_ICON[lead] : null;
  const leadBg = lead ? (LEAD_COLOR[lead] ?? accent.solid) : null;
  const leadFg = lead === "airport" ? accent.textOnSolid : "#FFFFFF";
  const hasMeta = more.length > 0 || !!item.lines?.length || !!item.badge;
  return (
    <RippleTouch
      onPress={() => {
        haptic("button");
        onSelectStop(item.id);
      }}
      rippleColor="rgba(255,255,255,0.08)"
      accessibilityRole="button"
      style={[styles.card, { backgroundColor: cardTone(palette) }]}
    >
      {LeadIcon && leadBg ? (
        <View style={[styles.lead, { backgroundColor: leadBg }]}>
          <LeadIcon color={leadFg} size={18} strokeWidth={2} />
        </View>
      ) : null}
      <View style={styles.cardMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.name}
        </Text>
        {hasMeta ? (
          <View style={styles.kindRow}>
            {/* Weitere Verkehrsarten am selben Halt — klein, die erste steht schon vorn. */}
            {more.map((k, i) => {
              const Icon = KIND_ICON[k];
              if (!Icon) return null;
              const styled = k === "airport" ? { bg: accent.subtle, fg: accent.solid } : KIND_CHIP_STYLE[k];
              return (
                <View key={i} style={[styles.kindChip, { backgroundColor: styled?.bg ?? C.s3 }]}>
                  <Icon color={styled?.fg ?? C.white} size={12} strokeWidth={2} />
                </View>
              );
            })}
            {item.lines?.map((ln, i) => (
              <View key={`ln${i}`} style={[styles.lineBadge, { backgroundColor: ln.color }]}>
                <Text style={styles.lineBadgeText}>{ln.id}</Text>
              </View>
            ))}
            {item.badge && (
              <View style={[styles.metaBadge, { backgroundColor: palette.s3 }]}>
                <Text style={styles.metaBadgeText}>{item.badge}</Text>
              </View>
            )}
          </View>
        ) : null}
      </View>
      <Text style={styles.distance}>{item.distance}</Text>
    </RippleTouch>
  );
});

const styles = scaledStyles({
  /**
   * Der schwebende Knopf: rechts auf derselben Linie wie die Knopfreihe oben
   * (`right: 16` in MapFabs.tsx), unter dem Blatt in der Schichtung — beide
   * überlappen nie, und falls doch, gehört die Fläche dem Blatt.
   */
  accessory: {
    position: "absolute",
    right: 16,
    zIndex: 30,
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    backgroundColor: C.bg,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    // KEINE borderTopWidth mehr: Eine PARTIELLE Border (nur oben) zusammen mit
    // borderRadius rendert Android an den gerundeten Ecken fehlerhaft — dort
    // fehlte der Hintergrund und die Karte darunter schien an den oberen Ecken
    // links/rechts durch. Die optische Trennung übernimmt der Schatten unten.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 20,
    zIndex: 40,
  },
  // Reiter-Reihe: siehe SheetTabs.tsx.
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    columnGap: SPACE.md,
    paddingHorizontal: GUTTER,
    paddingTop: GROUP_GAP,
    paddingBottom: TITLE_GAP,
  },
  title: {
    fontSize: 19,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.4,
  },
  titleLeft: { flexDirection: "row", alignItems: "center", columnGap: ITEM_GAP, flexShrink: 1 },
  count: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 8,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  countText: { fontSize: 12, fontWeight: "700", color: C.g1 },
  /** Filter als runder Knopf — dieselbe Fläche wie die Karten. */
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  scroll: { flex: 1 },
  /** Haltestelle als Karte. */
  card: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 12,
    marginHorizontal: GUTTER,
    marginBottom: ITEM_GAP,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 16,
    overflow: "hidden",
  },
  /** Feiner heller Rand: Der Tram-Kasten (#2A2A2C) ginge auf der Karte sonst unter. */
  lead: {
    width: 38,
    height: 38,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  cardMain: { flex: 1, minWidth: 0, rowGap: 8 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: C.white, letterSpacing: -0.2 },
  kindChip: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  distance: { fontSize: 13.5, fontWeight: "600", color: C.white, letterSpacing: -0.2 },
  kindRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 8,
    rowGap: 8,
  },
  lineBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  lineBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  metaBadge: {
    backgroundColor: C.s3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  metaBadgeText: {
    color: C.g1,
    fontSize: 10,
    fontWeight: "600",
  },
  footer: {
    textAlign: "center",
    fontSize: 12,
    color: C.g3,
    paddingVertical: 20,
  },
});

