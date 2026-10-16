import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { SHEET_IN } from "@/lib/nav/overlayCover";
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
  ChevronRight,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useT } from "@/lib/i18n/useT";
import { MarkerKind, SheetMode, StopListItem } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { SPACE } from "@/lib/theme/spacing";
import {
  dragHealOffset,
  snapToPixel,
  startDragHeal,
  stopDragHeal,
  useSheetScrollGate,
} from "@/lib/ui/sheetSwipe";
import { SheetTabs } from "@/components/surroundings/SheetTabs";
import { chromeShift, travelBottom } from "@/lib/surroundings/mapChrome";
import {
  stopSheetHeal,
  stopSheetSnap,
  stopSheetY,
} from "@/components/surroundings/stopSheetAnimation";
import { reportSurroundingsTarget } from "@/lib/surroundings/mapViewport";

const LIME = "#7FEA4D";
const LIME_SUB = "rgba(127,234,77,0.18)";
const TRAIN_YELLOW = "#FFD60A";
const TRAIN_YELLOW_SUB = "rgba(255,214,10,0.18)";
const BUS_PURPLE = "#9D5FE0";
const BUS_PURPLE_SUB = "rgba(157,95,224,0.22)";

/** Chip-Styling pro Marker-Typ — matched die Map-Marker für visuelle Konsistenz. */
const KIND_CHIP_STYLE: Record<string, { bg: string; fg: string }> = {
  train: { bg: TRAIN_YELLOW_SUB, fg: TRAIN_YELLOW },
  // airport entfernt — wird zur Laufzeit aus accent berechnet (siehe useAccent).
  bus: { bg: BUS_PURPLE_SUB, fg: BUS_PURPLE },
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

const KIND_ICON: Record<MarkerKind, LucideIcon> = {
  train: Train,
  subway: Train, // U-Bahn nutzt Train-Icon, in der Liste durch eigenen Chip-Farbton unterschieden
  bus: Bus,
  tram: TramFront,
  airport: Plane,
  cruise: Ship,
};

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
  const accent = useAccent();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();

  // Snap points als translateY-Offsets relativ zur Top-Position des Sheets.
  // 0 = full open (Sheet bedeckt fast den ganzen Screen, oben 80px frei).
  // PEEK = Sheet zeigt nur Handle + Tabs + Title + ein Listenelement,
  // FloatingTabBar bleibt darunter sichtbar.
  const snap = useMemo(() => {
    const fullTop = Math.max(60, insets.top + 12);
    const sheetHeight = screenHeight - fullTop;
    // Platz für die Tab-Leiste. Der Wert stand fest auf 80 und stammte noch von
    // der früheren, freischwebenden Leiste; er kommt jetzt aus der Leiste selbst
    // — sonst laufen die zwei Zahlen bei der nächsten Höhenänderung auseinander.
    const tabBarSpace = TAB_BAR_H + insets.bottom;
    /**
     * Was im Ruhezustand ÜBER der Tab-Leiste stehen bleibt.
     *
     * Hier stand 51 mit dem Vermerk, die 1-Punkt-Trennlinie werde abgeschnitten.
     * Abgeschnitten wurden in Wahrheit 15 Punkte — und darin lag die
     * Unterstreichung des aktiven Reiters, also genau das Element, das anzeigt,
     * wo man gerade ist. Nachgerechnet aus den Stilen darunter:
     *
     *   Griffzone      10 (oben) +  5 (Griff) + 4 (unten)   = 19
     *   Reiter-Zeile    4 (oben) + 42 (Reiter) + 1 (Linie)  = 47
     *   Reiter selbst  12 + 18 (Symbol/Schrift) + 12        = 42
     *                                                        ----
     *                                                          66
     *
     * Die Unterstreichung sitzt am unteren Rand des Reiters, also bei 65 — und
     * lag damit vollständig hinter der Leiste. Mit der vollen Höhe sitzt sie
     * genau auf deren Oberkante, so wie gewünscht.
     */
    const HANDLE_ZONE = 10 + 5 + 4;
    const TAB_H = 12 + 18 + 12;
    const TAB_ROW = 4 + TAB_H + 1;
    const peekVisible = HANDLE_ZONE + TAB_ROW;
    const midVisible = Math.min(sheetHeight - 80, Math.max(420, screenHeight * 0.5));
    return {
      fullTop,
      sheetHeight,
      tabBarSpace,
      // Vom Sheet aus runter geschoben (positiv = weiter unten):
      full: 0,
      mid: Math.max(0, sheetHeight - midVisible - tabBarSpace),
      peek: Math.max(0, sheetHeight - peekVisible - tabBarSpace),
    };
  }, [screenHeight, insets.top, insets.bottom]);

  /**
   * Startwert UNTERHALB des Bildrands, nicht auf der Ruhestellung.
   *
   * Hier stand `snap.peek` — also genau das Ziel, das der Mount-Effekt gleich
   * darunter anfährt. Start gleich Ziel heißt: Es bewegt sich nichts. Das Blatt
   * stand von Anfang an da, die Zeitvorgabe darunter wirkte auf nichts. Vom
   * unteren Rand aus fährt es jetzt wirklich herein, mit derselben Kurve wie
   * jedes andere Blatt von unten.
   */
  const translateY = useSharedValue(snap.sheetHeight);
  /**
   * Nur-Karte-Modus: Das Blatt steht in der unteren Bildhälfte, fährt also nach
   * UNTEN hinaus — mit derselben Verschiebung wie alle anderen Teile, bis das
   * Stück, das gerade zu sehen ist, hinter dem Rand liegt (siehe
   * `lib/surroundings/mapChrome.ts`). Die eigenen Rastpunkte bleiben
   * unberührt; beim Zurückholen steht es wieder, wo es stand.
   */
  /** Selbstkorrektur beim Ziehen — siehe `startDragHeal` in lib/ui/sheetSwipe.ts. */
  const heal = useSharedValue(0);
  const sheetAnim = useAnimatedStyle(() => {
    const y = translateY.value + Math.min(chromeShift.value, snap.sheetHeight - translateY.value);
    // Auf ganze Gerätepixel — sonst zittert die Schrift beim Ziehen gegen ihre
    // Flächen (siehe `snapToPixel`).
    return { transform: [{ translateY: snapToPixel(y) + dragHealOffset(heal) }] };
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
  const stopMid = useMemo(
    () => stopSheetSnap(screenHeight, insets.top, insets.bottom).mid,
    [screenHeight, insets.top, insets.bottom],
  );
  const accessoryAnim = useAnimatedStyle(() => {
    const lift = snapToPixel(accessoryH.value + accessoryGap);
    const own = translateY.value;
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
    // Beim ersten Mount in die Ruhestellung fahren — mit derselben Vorgabe wie
    // jedes andere Blatt, das von unten hereinkommt (siehe SHEET_IN). Hier stand
    // eine eigene Feder; sie schwingt über und endet nur asymptotisch, während
    // alle anderen exakt landen.
    translateY.value = withTiming(snap.peek, SHEET_IN);
    reportSurroundingsTarget(snap.peek);
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
      stopDragHeal(heal);
    }),
  [snap, startY, base, moved, translateY, gate, heal]);

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
        { backgroundColor: palette.s1 },
        { top: Math.max(60, insets.top + 12), height: snap.sheetHeight },
        sheetAnim,
      ]}
    >
      {/* Nur noch Zeichen, nicht mehr Griff: Gezogen wird überall. Der Strich
          bleibt, weil er ansagt, DASS gezogen werden kann. */}
      <View style={styles.handleZone}>
        <View style={styles.handle} />
      </View>

      {/* Dieselbe Reiter-Reihe wie im Stadt-Blatt — siehe SheetTabs.tsx. */}
      <SheetTabs
        tabs={MODE_TABS.map(({ mode: tabMode, tKey, Icon }) => ({
          key: tabMode,
          label: t(tKey),
          Icon,
        }))}
        active={mode}
        onChange={setMode}
      />

      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        <RippleTouch style={styles.filterRow} borderless>
          <Text style={[styles.filterText, { color: accent.solid }]}>{t("surroundings.filter")}</Text>
          <SlidersHorizontal color={accent.solid} size={12} strokeWidth={2.2} />
        </RippleTouch>
      </View>

      <SelectStopContext.Provider value={onSelectStop}>
      {/* Eigener nativer Erkenner um die Liste — sonst würgt das Ziehen am
          Blatt jedes Scrollen ab. */}
      <GestureDetector gesture={gate.native}>
      <Animated.FlatList
        style={styles.scroll}
        data={items}
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

const StopRow = memo(function StopRow({ item }: { item: StopListItem }) {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();
  const onSelectStop = useContext(SelectStopContext);
  return (
    <RippleTouch
      onPress={() => {
        haptic("button");
        onSelectStop(item.id);
      }}
      style={[styles.row, item.selected && [styles.rowSelected, { backgroundColor: palette.s2 }]]}
    >
      <View style={{ flex: 1 }}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle}>{item.name}</Text>
          {item.selected && (
            <View style={[styles.selectedBadge, { backgroundColor: accent.solid }]}>
              <Text style={styles.selectedBadgeText}>{t("surroundings.selected")}</Text>
            </View>
          )}
        </View>
        <View style={styles.kindRow}>
          {item.kinds.map((k, i) => {
            const Icon = KIND_ICON[k];
            // Unbekannte Kinds (z.B. „ferry" aus OSM-Imports, leere Strings
            // aus partiellen Daten) → Chip einfach skippen statt Render-
            // Crash mit „Cannot read property displayName of undefined".
            if (!Icon) return null;
            // Airport-Chip nutzt den User-Akzent, train/bus haben feste
            // informative Farben (Gelb/Lila) damit die Mode-Erkennung im
            // Marker erhalten bleibt.
            const styled = k === "airport"
              ? { bg: accent.subtle, fg: accent.solid }
              : KIND_CHIP_STYLE[k];
            const bg = styled?.bg ?? C.s3;
            const fg = styled?.fg ?? C.white;
            return (
              <View key={i} style={[styles.kindChip, { backgroundColor: bg }]}>
                <Icon color={fg} size={14} strokeWidth={2} />
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
      </View>
      <View style={styles.distanceCol}>
        <Text style={[styles.distance, { color: accent.solid }]}>{item.distance}</Text>
        <ChevronRight color={C.g3} size={16} strokeWidth={2.4} />
      </View>
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
  handleZone: {
    paddingTop: 10,
    paddingBottom: 4,
    alignItems: "center",
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#FFFFFF",
    opacity: 0.85,
  },
  // Reiter-Reihe: siehe SheetTabs.tsx.
  titleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 10,
  },
  title: {
    fontSize: 19,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.4,
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 4,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  filterText: {
    fontSize: 12,

    fontWeight: "600",
  },
  scroll: { flex: 1 },
  row: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: C.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    columnGap: 14,
  },
  rowSelected: { backgroundColor: C.s2 },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
    marginBottom: 8,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.2,
  },
  selectedBadge: {

    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  selectedBadgeText: {
    color: "#000",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  kindRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: 6,
    rowGap: 6,
  },
  kindChip: {
    width: 26,
    height: 26,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
  lineBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
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
    paddingVertical: 3,
    borderRadius: 6,
  },
  metaBadgeText: {
    color: C.g1,
    fontSize: 10,
    fontWeight: "600",
  },
  distanceCol: {
    alignItems: "flex-end",
    rowGap: 4,
  },
  distance: {
    fontSize: 14,
    fontWeight: "700",

    letterSpacing: -0.2,
  },
  footer: {
    textAlign: "center",
    fontSize: 12,
    color: C.g3,
    paddingVertical: 20,
  },
});

