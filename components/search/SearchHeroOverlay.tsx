import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  StyleSheet,
  View,
  BackHandler,
  Platform,
  Dimensions,
  useWindowDimensions,
  Pressable,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { ArrowLeft } from "lucide-react-native";
import { useSearchStore, type SearchOverlayLaunch } from "@/stores/searchStore";
import { getAppBg, usePalette } from "@/lib/theme/appBg";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";
import type { TravelMode } from "@/types/search";
import { SearchHero } from "@/components/search/SearchHero";
import { subscribeHandoffLayer, warmHandoffLayer, setSearchScreenOpenProbe, setSheetMoving, subscribeSheetMoving } from "@/lib/nav/searchHandoff";
import { subscribeLayer } from "@/lib/nav/transitionLayer";
import { resultsPush, heroClipPush, pickerCover, overlayCover as parallaxCover, pushProgress, UNDERLAY_TRAVEL_FRAC, SCREEN_CORNER_RADIUS, PUSH_SPRING, POP_SPRING, COVER_IN_SPRING, SHEET_IN, SHEET_OUT, markSheetMoving,
  warmPushCurves,
} from "@/lib/nav/overlayCover";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Der Such-Screen — ein Blatt, das von unten hereinfährt.
 *
 * Bewegung und Maße sind die des Anmelde-Screens (`BinchAuthScreen`): Dort steht
 * Die Zahlen und die Kurve stehen inzwischen zentral (SHEET_IN/SHEET_OUT),
 * hier dieselben Zahlen und dieselbe Kurve als geteilter Wert (`sheetY`) — dieser
 * Baum bleibt dauerhaft gemountet und kann deshalb keine Ein-/Aussprung-Animation
 * bekommen.
 *
 * VORHER stand hier ein „Launch"-Übergang: Eine leere Fläche wuchs aus der
 * angetippten Kachel auf Vollbild, ein Symbol flog von der Kachel zur
 * Bildschirmmitte, Radien und Farbe morphten unterwegs, und am Ende wurde in
 * einem Bild hart auf den Inhalt umgeschaltet. Das ist vollständig entfallen —
 * mit ihm die Kachel-Geometrie, der Splash, das fliegende Symbol, die
 * Deckungs-Werte und ihr Aufwärmlauf. Der Screen fährt jetzt als EIN Körper
 * herein, mit sichtbarem Inhalt von der ersten Millisekunde an.
 *
 * Was bleibt: Der Inhalt ist dauerhaft gemountet (sonst fiele der Aufbau in das
 * Bild, in dem die Bewegung startet), und für die Dauer der Bewegung liegt eine
 * GPU-Ebene darunter — ohne sie würde der Dünen-SVG in jedem Bild neu gerastert.
 */

const { width: SW, height: SH } = Dimensions.get("window");
// Die durchgängige App-Hintergrundfarbe (Home-Root, Root-Layout, Stack-Content
// = alle #1A1A1A). Der Splash endet genau darauf → nahtloser Content-Swap.
/** Fallback für Modul-Konstanten. Die LEBENDE Farbe kommt aus useAppBg() —
 *  die Launch-Box muss exakt den aktuellen Screen-Hintergrund treffen, sonst
 *  zeigt der Übergang eine sichtbare Stufe. */
const APP_BG = getAppBg();
const FULLSCREEN: SearchOverlayLaunch = { x: 0, y: 0, w: SW, h: SH, color: APP_BG };

/** Muss zu TRANSPORT im Home passen — der fliegende Button trägt dasselbe
 *  Label wie die Kachel, sonst bricht die Illusion beim Abheben. */

/**
 * Öffnen: ruhige, langsame Ease-Out-Kurve (easeOutCubic), KEIN Überschwingen.
 * Gleichmäßiger Anlauf, langer weicher Auslauf — die Expansion wird zu den
 * Kanten hin spürbar LANGSAMER und landet ganz sanft. Bewusst länger (700 ms)
 * als zuvor: das ist der „fließend, ein bisschen langsamer"-Wunsch.
 */
// 500 = MOTION.duration der App → mehr „Fluss"/Eleganz als die vorherigen 400,
// ohne langsam zu wirken. (Der eigentliche Smoothness-Hebel ist kein Rest-Ruckeln
// mehr, siehe splashStyle — solange das nicht 100% ist, hilft etwas mehr Zeit.)
// „Emphasized decelerate" (Material/HyperOS-Charakteristik): schießt am ANFANG
// schnell los und rollt zum Ende lang weich aus — statt easeOutCubic, das vorne
// gemächlich anläuft. Bei 20% der Zeit ist die Box hier schon ~70% groß (vorher
// ~50%). Dieselbe Kurve nutzt die App für Push-Transitions (PUSH_IN_EASING in
// lib/nav/overlayCover.ts, dort an echten Transitions nachgemessen).
// 430ms statt 500: Weil die Kurve vorne schneller ist, wirkt sie sonst zu träge;
// der Auslauf bleibt lang genug, dass das Ende weich einrastet.
/**
 * Die Bewegung des Auth-Screens, Zahl für Zahl.
 *
 * Dort stand ursprünglich `SlideInDown`/`SlideOutDown`; die Werte liegen
 * inzwischen zentral in SHEET_IN/SHEET_OUT. Reanimateds Layout-Animationen
 * benutzen als Voreinstellung `Easing.inOut(Easing.quad)` — hier ausgeschrieben,
 * weil dieser Screen dauerhaft gemountet bleibt und deshalb keine
 * Ein-/Aussprung-Animation bekommen kann. Bewegt wird stattdessen ein geteilter
 * Wert; das Ergebnis ist dasselbe.
 */
// Zentral vorgegeben — siehe SHEET_IN dort. Vorher standen die Zahlen hier.
const SLIDE_IN = SHEET_IN;
const SLIDE_OUT = SHEET_OUT;
// Weiche Splash-Ausblendung am Reveal (statt hartem Verschwinden) — deckt den
// Swap-Übergang ab, sodass ein Timing-Race nicht durchblitzt. Länger als
// WAVE_DELAY (150), damit auch der Wellen-Start noch mit-maskiert wird.
/** Schließen: dieselbe ruhige Kurve, etwas kürzer. */

/**
 * Der Content wird erst freigegeben, wenn die Expansion KOMPLETT fertig ist
 * (Completion-Callback der Kurve, p=1). Dann deckt der Splash garantiert
 * vollflächig — der harte Swap ist unsichtbar, und es kann an den Kanten
 * nichts mehr durchblitzen (das war die letzte Flacker-Quelle).
 *
 * Die Micro-Animationen kommen danach ENTSPANNT nach: erst atmet der Screen
 * kurz, dann fließen Toggle/Felder/CTA gestaffelt herein. Etwas länger (340 ms)
 * als zuvor — so klebt die Welle nicht an der schnellen Box, sondern liest sich
 * als eigener, ruhiger Moment (das „fließend, nicht snappy"-Wunsch).
 */
const WAVE_DELAY_MS = 150;

/**
 * Wärmt beim App-Start die Reanimated/Fabric-Maschinerie auf — VÖLLIG isoliert
 * vom Launch-Zustandsautomaten (fasst weder `active` noch `searchLaunch` an,
 * kann den Launch also nicht kaputtmachen, siehe der revertierte Prewarm-Bug).
 *
 * Warum nötig: Der ERSTE echte Kachel-Klick ruckelt einmalig, danach nie wieder.
 * Beweis, dass es ein GLOBALER Einmal-Warmup ist und nicht das Overlay selbst:
 * Folge-Öffnungen erzeugen dieselben Splash/Icon-Views neu und sind trotzdem
 * glatt. Kalt ist also die geteilte Infrastruktur — Reanimated installiert seine
 * Worklets beim ersten Lauf auf die UI-Thread-Runtime, Fabric legt die erste
 * Animated-View an, `interpolate`/`interpolateColor`/`withTiming` laufen zum
 * ersten Mal. Bisher fiel das mitten in die erste Animation.
 *
 * Hier laufen dieselben Code-Pfade einmal an einer unsichtbaren 1px-View, hinter
 * der 3,5s-BinchSplash — bevor der Nutzer überhaupt klicken kann. opacity bleibt
 * 0 (nie sichtbar); die Worklets laufen trotzdem, weil sich der Shared Value
 * ändert, und die View mountet → die Maschinerie ist danach warm.
 */

/**
 * Trägt den inneren Rahmen des Beschnitts — und schaltet für die Dauer der
 * Übergabe eine GPU-Textur darunter.
 *
 * Gemessen: Die Slide AUS DEM LANDINGSCREEN läuft mit 8ms pro Bild und ohne
 * Aussetzer. Dieselbe Slide aus DIESEM Screen riss auf 33-42ms aus, rund 83ms
 * nach dem Start — also kurz nach Beginn der Bewegung. Das ist die Signatur
 * eines Ebenen-Aufbaus: Android rastert den verschobenen Baum beim ersten Mal
 * komplett neu, und dieser Baum trägt die drei bildschirmfüllenden Flächen des
 * Himmel-Motivs. Wird die Textur schon beim Antippen angelegt, fällt der Wert
 * auf 8ms — die Bewegung ist dann so sauber wie die aus dem Landingscreen.
 *
 * WARUM EIGENE KOMPONENTE: Der Schalter ist ein React-Zustand, und der lag
 * zuerst im Overlay selbst. Damit rendete beim Antippen dessen kompletter,
 * schwerer Baum neu — mitten im Berührungs-Frame, und das Antippen fühlte sich
 * spürbar schlechter an. Hier oben trifft die Zustandsänderung nur noch diesen
 * einen Rahmen; die Kinder kommen unverändert von außen, React lässt sie also
 * stehen.
 *
 * WARUM HIER UND NICHT AUSSEN: Dieser Rahmen trägt zwar selbst die Gegenbewegung
 * des Beschnitts, sein INHALT steht dabei aber still — die Textur bleibt gültig.
 * Eine Ebene auf dem äußeren Rahmen wäre wertlos, weil sich darin dieser hier
 * bewegt und sie jedes Bild neu entstünde.
 *
 * WANN: Angefordert schon beim FINGERDRUCK auf „Preis vergleichen", nicht erst
 * beim fertigen Tippen (siehe prepareHandoffLayer). Zwischen Aufsetzen und
 * Loslassen liegen 80-150ms, die sonst ungenutzt verstreichen — genug, um zu
 * rastern, ohne dem Nutzer Wartezeit hinzuzufügen. Freigegeben wird sie nach dem
 * Übergang; dauerhaft müsste sie bei jeder Änderung im Formular neu entstehen.
 */
function ClipContent({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const [layered, setLayered] = useState(false);
  useEffect(() => subscribeHandoffLayer(setLayered), []);
  return (
    <Animated.View
      style={style}
      pointerEvents="box-none"
      renderToHardwareTextureAndroid={Platform.OS === "android" && layered}
    >
      {children}
    </Animated.View>
  );
}

export function SearchHeroOverlay() {
  const mode = useSearchStore((s) => s.searchOverlayMode);
  const rect = useSearchStore((s) => s.searchOverlayTileRect);
  const session = useSearchStore((s) => s.searchOverlaySession);
  const close = useSearchStore((s) => s.closeSearchOverlay);
  // Fallback-Mode für den dauerhaft gemounteten Hero, wenn gerade kein Launch
  // läuft (beim App-Start der Store-Default).
  const storeMode = useSearchStore((s) => s.activeMode);
  // LEBENDE Screen-Hintergrundfarbe: Die Box endet exakt darauf, sonst zeigt
  // der Content-Swap eine sichtbare Farbstufe.
  // Wird erst im rAF true (wenn die Expansion nachweislich läuft), nicht schon
  // beim Mount. Steuert: (1) Overlay-Sichtbarkeit — der allererste Frame nach
  // dem Mount wird versteckt, weil Reanimated den animierten Style dort noch
  // NICHT angewandt hat (sonst blitzt Splash groß / Icon zentriert auf); (2) die
  // Karten-Rundung während des Depth-Scales.
  const launchActive = useSearchStore((s) => s.launchActive);
  const setLaunchActive = useSearchStore((s) => s.setLaunchActive);
  // Der Launch endet oberhalb der nativen Tab-Bar → die Bar bleibt sichtbar und
  // wird NICHT vom Such-Screen überdeckt: NAVBAR_H ist der Streifen, den der
  // Inhalt unten freihält.
  /**
   * Der Streifen unten, den die Tab-Leiste behält.
   *
   * Kam bisher aus der gemessenen Höhe des Landingscreen-Inhalts — die war
   * „Fenster minus Leiste", weil die native Leiste ihren Platz selbst
   * reservierte und der Inhalt darüber endete. Mit der eigenen, durchscheinenden
   * Leiste bekommen die Seiten VOLLE Höhe: Die Messung liefert seither das ganze
   * Fenster, der Streifen wurde damit 0, und der Such-Screen legte sich über die
   * Leiste. Genau das war zu sehen.
   *
   * Jetzt steht die Zahl dort, wo auch die Leiste ihre Höhe herholt.
   */
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  // Die ECHTE Höhe der Leiste, nicht die aufgerundete Konstante: Leistenhöhe
  // plus die sichere Fläche, auf der sie sitzt. Mit NAVBAR_SPACE (96) endete der
  // Such-Screen zu weit oben, und in dem Streifen darunter sah man den
  // Landingscreen durchscheinen.
  const NAVBAR_H = TAB_BAR_H + insets.bottom;


  // Das Kachel-Rect steckt IM active-State (nicht in einem Shared Value): so ist
  // es beim allerersten Frame der Animation schon korrekt. Ein Shared Value
  // würde vom JS- erst einen Frame später auf den UI-Thread propagieren → das
  // Icon säße kurz an der falschen (Vollbild-)Position und „springt".
  const [active, setActive] = useState<
    { mode: TravelMode; session: number; rect: SearchOverlayLaunch } | null
  >(null);
  const [entranceTick, setEntranceTick] = useState(0);
  // Eigener Trigger für den Hintergrund (Himmel/Dünen): fadet beim REVEAL ein,
  // während die Formular-Welle (entranceTick) entspannt später kommt.
  const [bgTick, setBgTick] = useState(0);
  // Wird beim Launch-START gebumpt (Screen noch hinter dem Splash): setzt den
  // dauerhaft gemounteten Such-Screen auf „versteckt" zurück — Himmel-Scrim
  // deckend, Formular-Reveals entwaffnet. Sonst stünde beim Öffnen noch der
  // fertige Stand von letztem Mal und spränge beim Reveal sichtbar zurück.
  const [resetTick, setResetTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const revealRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 0 = Content unsichtbar (Splash deckt), 1 = Content sichtbar. Harter
   *  Schalter, KEIN Fade — der Wechsel passiert, während der Splash vollflächig
   *  darüber liegt, ist also unsichtbar (ein Fade des schweren Baums würde
   *  dagegen pro Frame einen Offscreen-Buffer erzwingen → teuer). */

  /** Splash-Deckkraft beim Reveal. 1 = deckt, fadet am Reveal weich auf 0 (statt
   *  hart zu verschwinden) → deckt einen etwaigen Swap-Timing-Race ab, sodass der
   *  Such-Screen nicht kurz durchblitzt. Nur der einfarbige Splash fadet (billig),
   *  NICHT der schwere Content-Baum. Wird bei jedem Open UND Close auf 1 zurück-
   *  gesetzt (sonst bliebe der Splash beim Schrumpfen unsichtbar). */

  /**
   * Position des Blattes: 0 = oben angekommen, SH = unterhalb des Bildes.
   *
   * Das ersetzt die gesamte Wachstums-Choreografie (Splash-Box, fliegendes
   * Symbol, Kachel-Geometrie, Radien-Morph). Der Screen ist keine Box mehr, die
   * aus einer Kachel wächst, sondern ein Blatt, das von unten hereinfährt.
   */
  const sheetY = useSharedValue(0);
  /** Läuft die Bewegung? Nur dann eine GPU-Ebene — siehe Rückruf beim Öffnen. */
  const [moving, setMoving] = useState(false);
  /**
   * Auch während ein Picker darüber fährt eine Ebene halten.
   *
   * Dieser Bildschirm ist die UNTERLAGE der Picker-Blätter, und er ist die
   * einzige, die das Such-Blatt selbst nicht hat: Wenn es aus dem Landingscreen
   * hereinfährt, liegt darunter nur der geparkte Startbildschirm. Unter einem
   * Picker liegt dagegen dieser komplette Bildschirm — inklusive des Formulars,
   * dessen Rahmen NUR OBEN gerundet ist. Für ungleichmäßige Radien kann Android
   * nicht den günstigen Umriss-Beschnitt nutzen, sondern legt einen Pfad über
   * eine bildschirmhohe Fläche, in jedem Bild. Und weil das Blatt darüber
   * verschoben wird, greift die Verdeckungs-Erkennung nicht: Die Fläche wird
   * mitgezeichnet, statt übersprungen zu werden.
   *
   * Als fertige Bitmap kostet dasselbe nur noch einen Kopiervorgang. Angefordert
   * wird sie über dieselbe Textur-Anmeldung, die die Felder beim AUFSETZEN des
   * Fingers auslösen — sie steht also, bevor die Fahrt beginnt.
   *
   * Dauerhaft darf sie nicht sein: Dann entstünde sie bei jeder Eingabe im
   * Formular neu, und genau dagegen ist die Zeile darunter geschrieben.
   */
  const [pickerBusy, setPickerBusy] = useState(false);
  useEffect(() => {
    /**
     * Auch die BEWEGUNG zählt, nicht nur die Textur-Anforderung.
     *
     * `prepareLayer` gibt nach 1,4 Sekunden selbsttätig frei. Wer länger in
     * einem Wähler bleibt — der Normalfall —, fuhr also ohne Textur auf diesem
     * Bildschirm wieder hinaus. Und ausgerechnet beim Hinausfahren wird er Bild
     * für Bild freigelegt, muss also ohnehin neu gezeichnet werden, samt des
     * ungleichmäßigen Radius, der weiter oben selbst als teuer beschrieben ist.
     *
     * Die Wähler melden ihre Fahrt bereits an (`setSheetMoving`); hier wird
     * diese Meldung nur noch mitgehört.
     */
    const flags = { loc: false, date: false, moving: false };
    const apply = () => setPickerBusy(flags.loc || flags.date || flags.moving);
    const offLoc = subscribeLayer("pickerLocation", (v) => {
      flags.loc = v;
      apply();
    });
    const offDate = subscribeLayer("pickerDate", (v) => {
      flags.date = v;
      apply();
    });
    const offMoving = subscribeSheetMoving((v) => {
      flags.moving = v;
      apply();
    });
    return () => {
      offMoving();
      offLoc();
      offDate();
    };
  }, []);

  /** 0 = Splash-Fläche deckt, 1 = weggeblendet. Nur für den Tab-Wechsel: Der
   *  Splash ist eine EINFARBIGE Fläche, sie zu faden ist billig (anders als der
   *  schwere Content-Baum, der pro Frame einen Offscreen-Buffer erzwingen würde). */
  /** 1 = Tab-Wechsel-Deckung aktiv. Blendet alles aus, was nur zur Rück-
   *  Schrumpfung gehört (Icon, Zurück-Button) — dort wird nicht geschrumpft,
   *  es stünde bloß auf der Deckfläche herum. */
  /** Sichtbarkeit auf dem UI-Thread statt über React: Ausgangsposition und
   *  Sichtbarschalten liegen damit im selben Bild. Über React committet die
   *  Sichtbarkeit womöglich erst Bilder später — dann blitzte das Blatt an
   *  seiner Zielposition auf, bevor es losfährt. */
  // winW statt des modulweiten SW: SW wird EINMAL beim Laden des Moduls
  // gelesen, also noch bevor das Fenster überhaupt vermessen ist. Weicht es
  // später auch nur um ein paar Pixel ab, laufen Beschnitt-Kante und
  // Ergebnis-Liste unterschiedlich schnell — und übrig bleibt genau ein
  // schmaler Streifen am linken Rand, in dem der Such-Screen durchscheint.
  // Der Ergebnis-Screen rechnet mit useWindowDimensions; hier muss dieselbe
  // Quelle stehen, sonst kann das nie exakt aufgehen.
  const { width: winW } = useWindowDimensions();

  const overlayVisible = useSharedValue(0);

  // WARMUP der ECHTEN Expand-Worklets (splashStyle/flyStyle/backStyle) beim
  // App-Start, hinter der 3,5s-BinchSplash. Ihr ERSTER Lauf ist sonst kalt →
  // der allererste Expand ruckelt genau WÄHREND die Box wächst (vom User
  // bestätigt). Die separate LaunchWarmup-View wärmt nur die Reanimated-Runtime
  // allgemein, nicht DIESE Worklets. Hier fahren wir searchLaunch EINMAL durch:
  // Splash/Icon sind dauerhaft gemountet, ihre Worklets laufen dabei wirklich an
  // und sind danach warm. Unsichtbar (active=null → äußere opacity 0) und fasst
  // den Zustandsautomaten NICHT an (kein setActive/session) — anders als der
  // revertierte Prewarm, kann also nichts kaputtmachen. searchLaunch ist ein
  // modulweiter Shared Value, der NUR vom Overlay gelesen wird (verifiziert).
  /**
   * Kam der Launch von einer Kachel?
   *
   * Reiseziel-Karten und der Buchen-Knopf öffnen die Suche OHNE Rechteck. Der
   * Rückfall auf FULLSCREEN bedeutet dann: Die Box steht schon im ersten Bild
   * vollflächig da, und die „Expansion" ist nur noch ein 9-%-Schrumpfen über
   * 430ms — man sah gut eine halbe Sekunde ein leeres dunkles Rechteck. Der
   * Store dokumentiert für diesen Fall „fadet fullscreen ein"; genau das machen
   * wir jetzt, statt die Wachstums-Kurve ins Leere zu fahren.
   */
  const warmedRef = useRef(false);
  useEffect(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    // Der Aufwärmlauf für das Wachstum ist entfallen — es gibt kein Wachstum
    // mehr. Die Bewegungspfade der Übergabe an die Ergebnisliste bleiben aber
    // aufzuwärmen, und die stehen weiter unten in diesem Effekt.

    // Dasselbe für die Push-Worklets (Beschnitt hier, Parallax im Landingscreen).
    // Beim ERSTEN Antippen stotterte der Parallax, beim zweiten lief er glatt —
    // das klassische Zeichen, dass beim ersten Mal noch etwas kalt ist: Der Wert
    // wurde nie animiert, also lief der Mapper nie, und Android musste die
    // betroffenen Views beim ersten Transform überhaupt erst als eigene Ebenen
    // anlegen. Beides passiert jetzt beim Start.
    //
    // Ausschlag bewusst winzig (0,002 → unter einem Zehntel Pixel Versatz): Ein
    // voller Durchlauf würde den Landingscreen sichtbar zur Seite rücken.
    //
    // ZWEI Dinge, die hier lange fehlten und den Aufwärmlauf am eigentlichen
    // Problem vorbeilaufen ließen:
    //
    //  1. FEDER statt Zeitkurve. Hier stand withTiming — alle Push-Übergänge
    //     laufen aber als withSpring, und das ist in Reanimated eine komplett
    //     eigene Implementierung mit eigenem Zustand pro Bild. Aufgewärmt wurde
    //     also ausgerechnet der Code-Pfad, den keine dieser Animationen benutzt;
    //     die Feder lief bei der ersten echten Slide zum allerersten Mal an. Das
    //     betrifft JEDE Slide gleichermaßen, egal von welchem Screen aus — genau
    //     das gemeldete Bild.
    //
    //  2. overlayCover. Aufgewärmt wurde nur resultsPush (Landingscreen). Der
    //     Parallax von Ergebnis- und Saved-Screen hängt aber an overlayCover,
    //     wenn ein Detail-Overlay darüber slidet — der Wert war beim ersten
    //     Ticket-Detail nie zuvor animiert worden.
    //
    // Beide Federn laufen mit den ECHTEN Konfigurationen, damit wirklich
    // derselbe Pfad durchlaufen wird und nicht bloß ein ähnlicher.
    resultsPush.value = 0;
    resultsPush.value = withTiming(0.002, PUSH_SPRING, (finished?: boolean) => {
      "worklet";
      // Siehe oben — und hier ist die Kante schärfer: `startResultsPush()` fasst
      // denselben Wert an. Ohne diese Prüfung federte eine echte Ergebnis-Slide,
      // die im Aufwärm-Fenster beginnt, sofort wieder auf 0 zurück.
      if (!finished) return;
      resultsPush.value = withTiming(0, POP_SPRING);
    });
    heroClipPush.value = 0;
    // Die vier ubrigen Bewegungswerte gleich mit — Detail-Blatt, Ticket-Blatt,
    // Profil-Unterschirm, Bo. Sie liefen bisher bei ihrer ERSTEN echten
    // Verwendung kalt an, jeder fur sich, und meldeten sich entsprechend als
    // „beim ersten Mal ruckelt es" zuruck.
    warmPushCurves();
    parallaxCover.value = 0;
    parallaxCover.value = withTiming(0.002, COVER_IN_SPRING, (finished?: boolean) => {
      "worklet";
      if (!finished) return;
      parallaxCover.value = 0;
    });
  }, []);

  useEffect(() => {
    if (mode) {
      // Unter den Bildrand stellen, von wo aus gleich hereingefahren wird.
      sheetY.value = SH;
      setMoving(true);
      setSheetMoving(true);
      // Den Himmel-SVG JETZT anlegen — ein Bild VOR dem Start der Bewegung.
      //
      // Er hing bisher im rAF direkt vor der Feder, und das ist der teuerste
      // Baum der App: Fabric legt in diesem einen Bild seine Zeichenfläche an,
      // und die Bewegung lief dagegen an. Genau das war der Ruckler beim
      // Hochfahren, und weil der Aufbau je nach Last mal in dieses Bild fiel und
      // mal ins nächste, trat er nur „manchmal" auf.
      //
      // Sichtbar wird dadurch nichts zu früh: Das Blatt steht zu diesem
      // Zeitpunkt noch unterhalb des Bildrands, und der Vorhang darüber ist
      // ohnehin deckend.
      //
      // NUR das Anlegen — nicht `onReveal()`. Das stand hier und hat den Himmel
      // ganz verschwinden lassen: `onReveal` lässt über `setBgTick` den Vorhang
      // ausblenden, und zwei Zeilen darunter setzt `setResetTick` ihn wieder auf
      // deckend. Aus DEMSELBEN Commit heraus laufen beide Effekte im selben
      // Durchgang, und der Reset gewinnt — der Vorhang blieb für immer zu. Das
      // Ausblenden gehört deshalb weiterhin in den rAF, einen Commit später.
      useSearchStore.getState().setSearchContentVisible(true);
      // Noch NICHT sichtbar schalten — erst der rAF (nächster Frame) macht das,
      // wenn Reanimated den Ausgangswert angewandt hat.
      setLaunchActive(false);
      /**
       * SICHTBAR schalten, BEVOR die Bewegung anläuft.
       *
       * Hier stand `0`, und sichtbar wurde erst der rAF-Rückruf unten. Damit war
       * das Vorziehen des Himmel-SVG eine Zeile weiter unten wirkungslos: Der
       * React-Commit lag zwar früher, die RASTERUNG aber nicht — und die kostet.
       * Eine Ansicht mit Deckkraft 0 zeichnet Android gar nicht erst; dieselbe
       * Begründung steht in lib/nav/searchHandoff.ts für den Kalt-Anlauf.
       * Fällig wurde dadurch alles auf einmal im ERSTEN Bild der Feder: die
       * Erstzeichnung der drei SVG-Ebenen und das Anlegen der bildschirm-
       * füllenden Hardware-Ebene (im Projekt mit 66ms vermessen).
       *
       * Sichtbar wird dadurch nichts zu früh: Das Blatt steht in dieser Zeile
       * auf `sheetY = SH`, also vollständig unterhalb des Bildrands.
       */
      overlayVisible.value = 1;
      // Zuerst zurücksetzen (Screen ist noch unsichtbar), dann öffnen.
      setResetTick((n) => n + 1);
      setActive({ mode, session, rect: rect ?? FULLSCREEN });
    } else if (active) {
      if (revealRef.current) clearTimeout(revealRef.current);
      const st = useSearchStore.getState();
      if (st.searchOverlayCloseSilent || st.searchOverlayCloseInstant) {
        // SOFORT weg — beide Fälle, ohne Rück-Expansion:
        //
        //   • STILL (Ergebnis-Liste öffnet sich): Die Liste deckt bereits den
        //     ganzen Bildschirm, hier gibt es nichts zu überblenden.
        //   • TAB-WECHSEL: Die Kachel, zu der geschrumpft würde, liegt auf dem
        //     neuen Tab gar nicht — die Animation liefe ins Leere.
        //
        // Der Tab-Wechsel hatte dafür lange einen eigenen Weg: Die einfarbige
        // Splash-Fläche blieb 140ms vollflächig stehen, blendete über 180ms aus
        // und der Baum wurde erst nach gut einer Sekunde abgeräumt. Beides hatte
        // einen Grund, und beide sind entfallen — die Deckung verbarg den nativen
        // Tab-Crossfade (den es ohne Überblendung nicht mehr gibt), das späte
        // Abräumen hielt den Commit aus der Einblend-Welle des Ziel-Tabs (die aus
        // den Tabs raus ist). Übrig blieb nur der Schaden: Nach dem Tippen stand
        // 320ms lang eine leere Fläche im Bild, bevor der Ziel-Tab sichtbar wurde.
        // Genau das fühlte sich wie Verzögerung an.
        // Beschnitt zurücksetzen, sonst bliebe dieser Screen beim nächsten Öffnen
        // seitlich verschoben stehen.
        heroClipPush.value = 0;
        sheetY.value = SH;
        overlayVisible.value = 0;
        setActive(null);
        setLaunchActive(false);
        /**
         * Die Bewegungs-Meldung MUSS auch hier zurückgenommen werden.
         *
         * Dieser Zweig schließt ohne Bewegung — abgeräumt hat er bisher alles
         * außer der Meldung. Angemeldet wird sie beim Öffnen (weiter oben);
         * wird die Einfahrt unterbrochen, läuft ihr Abschluss-Rückruf nie, und
         * die Meldung bleibt für den Rest des App-Laufs auf „fährt" stehen.
         *
         * Folgenlos war das, solange niemand darauf hörte. Inzwischen hängt die
         * Freigabe der GPU-Ebenen daran: Eine stehengebliebene Meldung hält die
         * bildschirmfüllende Textur des Such-Bildschirms dauerhaft — und über
         * einer Fläche, auf der etwas passiert, ist eine Ebene teurer als keine.
         * Das ist der neue Ruckler beim Hereinfahren der Ergebnisliste.
         */
        setMoving(false);
        setSheetMoving(false);
        // Hier sofort: In diesem Zweig ist nichts mehr zu sehen.
        useSearchStore.getState().setSearchContentVisible(false);
      } else {
        // Normal: als ein Körper nach unten hinausfahren — mit sichtbarem
        // Inhalt. Genau der Weg, den er hereingekommen ist, nur rückwärts und
        // 50ms kürzer (so macht es der Auth-Screen).
        setMoving(true);
        setSheetMoving(true);
        sheetY.value = withTiming(SH, SLIDE_OUT, (finished) => {
          if (finished) {
            overlayVisible.value = 0;
            runOnJS(setActive)(null);
            runOnJS(setLaunchActive)(false);
            runOnJS(setMoving)(false);
            runOnJS(setSheetMoving)(false);
            // ERST JETZT den Himmel abschalten — er fährt mit hinaus. Vorher
            // blieb eine schwarze Fläche übrig. Abschalten muss er trotzdem:
            // unsichtbar, aber gelayoutet kostet er dauerhaft Scroll-Leistung
            // im Landingscreen.
            runOnJS(hideSearchContent)();
          }
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, session]);

  const hideSearchContent = () => {
    // Nur, wenn inzwischen nicht schon wieder geöffnet wurde.
    if (useSearchStore.getState().searchOverlayMode != null) return;
    useSearchStore.getState().setSearchContentVisible(false);
  };

  const onReveal = () => {
    // Lebend-Prüfung: Zwischen dem Rückruf auf dem UI-Thread und der Ausführung
    // hier liegt ein JS-Task. Wird in diesem Fenster geschlossen (Tab-Wechsel,
    // Zurück, Übergabe an die Ergebnisse), lief die Freigabe des schweren SVG
    // NACH dem Schließen — es stand dann dauerhaft auf sichtbar, obwohl die Suche
    // zu ist. Genau der Zustand, der laut BinchHero „im Release verifiziert" das
    // Scrollen im Landingscreen dauerhaft ruckeln lässt. Dazu wurde ein Zeitgeber
    // gesetzt, den das Aufräumen nicht mehr erwischte.
    if (useSearchStore.getState().searchOverlayMode == null) return;
    // JETZT erst den schweren Hero-SVG einschalten (war während des Box-Wachstums
    // display:none, sonst compositet er pro Frame mit und ruckelt den Expand).
    useSearchStore.getState().setSearchContentVisible(true);
    // Hintergrund SOFORT einfaden (kein Popp), Formular-Welle entspannt später.
    setBgTick((n) => n + 1);
    // Und einmal pro App-Lauf die GPU-Ebene kalt anlaufen lassen. Sie wartet
    // selbst noch die Einblend-Welle ab — siehe dort.
    setSearchScreenOpenProbe(
      () => useSearchStore.getState().searchOverlayMode != null,
    );
    warmHandoffLayer();
    revealRef.current = setTimeout(() => setEntranceTick((n) => n + 1), WAVE_DELAY_MS);
  };

  // Läuft NACH dem Commit → der Screen ist bereits gemountet (der teure Teil
  // ist erledigt, während noch nichts animiert). Erst JETZT startet die
  // Expansion und hat den UI-Thread für sich.
  useEffect(() => {
    if (!active) return;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      // JETZT sichtbar schalten: Reanimated hat den animierten Style ab hier
      // angewandt → der Splash sitzt auf der Kachel, das Icon auch. Der versteckte
      // erste Frame (Glitch) ist übersprungen.
      setLaunchActive(true);
      sheetY.value = SH;
      markSheetMoving();
      sheetY.value = withTiming(0, SLIDE_IN, (finished) => {
        if (!finished) return;
        // Textur nur für die Dauer der Bewegung — darunter liegt der Hero-SVG,
        // dauerhaft wäre sie bei jeder Formular-Eingabe neu zu rastern.
        runOnJS(setMoving)(false);
        runOnJS(setSheetMoving)(false);
        /**
         * Sonnenaufgang und Einblend-Takt erst JETZT — nach der Bewegung.
         *
         * Vorher lief `onReveal()` im selben rAF wie der Start der Feder. Das
         * hatte zwei Folgen, die beide teuer waren:
         *
         *  • Der Sonnenaufgang (700ms, bewegt eine bildschirmfüllende Ebene)
         *    überlappte die Bewegung. Eine Hardware-Ebene ist eine gerasterte
         *    Momentaufnahme — ändert ein Nachfahre etwas, wird sie im selben
         *    Bild ungültig. Die Textur über der Bewegung war damit nicht nur
         *    wirkungslos, sondern teurer als keine.
         *  • Der Wellen-Takt löste 150ms nach dem Start einen kompletten
         *    Neuaufbau des Formulars aus, mitten in der Bewegung.
         *
         * Jetzt trägt die Bewegung einen vollständig statischen Baum — genau das
         * Modell des Anmelde-Screens, an dem sie nachgebaut ist.
         */
        runOnJS(onReveal)();
      });
    });
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (revealRef.current) clearTimeout(revealRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (Platform.OS !== "android" || !active) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [active, close]);

  // Kachel-Rect aus dem State (kein Shared-Value-Lag). In die Worklets wird es
  // als konstanter Wert eingefangen — es ändert sich pro Launch, nicht pro Frame.

  // SPLASH — DUAL-MODE, je nach Richtung (closing):
  //
  // ÖFFNEN via transform:scale (butterweich; kein Pro-Frame-Layout/Clip). Feste
  // Ecken (runde Oberkante = Geräte-Radius, EckIGE Unterkante = 0, bündig zur
  // Nav-Bar) → KEINE Radius-Animation → kein Clip-Flacker während des Wachsens.
  // Die Box-Form (rund oben, eckig unten) skaliert konsistent von Kachel → Vollbild.
  //
  // SCHLIESSEN via Layout (left/top/width/height + animierte Radien) — so schrumpft
  // die Box mit EXAKTEN, sauber runden Ecken auf die Kachel (TILE_RADIUS an allen
  // vier). transform:scale würde die Ecken nahe der Kachel non-uniform verzerren
  // (wirkt spitz). Pro-Frame-Layout ist beim Schließen unkritisch (kurz, weniger
  // beobachtet, kein Reveal danach).
  //
  // Beide Zweige liefern DIESELBEN Keys (konsistent für Reanimated). Bei p=1
  // stimmen beide überein (Vollbild, runde Oberkante, eckige Unterkante) → der
  // Übergang Öffnen→Schließen ist nahtlos.



  // Äußere Overlay-Sichtbarkeit — UI-Thread (overlayVisible), synchron mit dem
  // Wachstum. Ersetzt das frühere React-Gate `active && launchActive`.
  const outerOpacityStyle = useAnimatedStyle(() => ({ opacity: overlayVisible.value }));

  /**
   * Hereinfahren von unten UND der seitliche Beschnitt bei der Übergabe an die
   * Ergebnisliste — in EINEM Transform.
   *
   * Zwei getrennte Ansichten dafür wären eine zusätzliche bildschirmfüllende
   * Ebene, die Android bei jeder Bewegung mit-compositen müsste. Die beiden
   * Bewegungen treten ohnehin nie gleichzeitig auf.
   */
  /**
   * Dazu die Rücknahme, während ein WÄHLER darüber kommt — siehe `pickerCover`.
   *
   * Das ist die Antwort auf „warum wirkt das Such-Blatt eleganter": Es fährt
   * nicht allein. Bei den Wählern schob sich bisher eine bildschirmfüllende
   * Fläche über eine völlig stillstehende, und genau das liest sich als
   * Sprungfolge — dem Auge fehlt jeder Bezugspunkt für die Bewegung.
   *
   * Zurückweichen statt Stillstehen gibt ihn: 4% kleiner und leicht nach oben,
   * mit derselben Kurve und demselben Takt wie das Blatt. Es sind bewusst kleine
   * Werte — das ist keine eigene Bewegung, sondern der Bezug, vor dem die andere
   * abläuft.
   *
   * Kosten: EIN zusätzlicher Transform auf einer Fläche, die währenddessen
   * ohnehin als Textur gehalten wird (`moving || pickerBusy` unten) — für die
   * GPU also ein Skalieren einer fertigen Bitmap.
   */
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: sheetY.value - 10 * pickerCover.value },
      { translateX: -winW * pushProgress(heroClipPush.value) },
      { scale: 1 - 0.04 * pickerCover.value },
    ],
  }));


  // KEIN early return mehr: Der Such-Screen bleibt DAUERHAFT gemountet (siehe
  // Content-Layer unten), damit pro Launch kein teurer Mount/Unmount anfällt.
  // Immer definiert (Fallback-Mode), damit das fliegende Icon DAUERHAFT gemountet
  // bleiben kann — sonst würde es erst beim ersten Öffnen von Fabric erzeugt (=
  // kalter Erst-Klick-Ruckler im Expand). Sichtbar wird es eh nur über die
  // Shared-Value-Opacity + die äußere opacity-Gate.
  // Mode für den dauerhaft gemounteten Hero: der gerade offene, sonst der
  // zuletzt gewählte aus dem Store (beim App-Start der Default).
  const heroMode = active?.mode ?? storeMode;
  // Alle Ebenen enden oberhalb der Nav-Bar → der Streifen unten (Bar) bleibt
  // frei und die native Tab-Bar sichtbar/tappbar.
  // width: SW statt right: 0 — die Wurzel schrumpft während der Übergabe an
  // die Ergebnisse (clipStyle). Mit `right: 0` würden alle Kinder dieser
  // Breite folgen und der Inhalt pro Frame neu umbrechen; mit fester Breite
  // stehen sie still und werden nur beschnitten.
  const areaStyle = { position: "absolute" as const, top: 0, left: 0, width: winW, bottom: NAVBAR_H };

  // STATISCHE Startposition (p=0), damit der ALLERERSTE Frame korrekt sitzt:
  // Reanimated hängt den animierten Style erst ab Frame 2 an — ohne diese Basis
  // säße das Icon zentriert (das „Icon kurz in der Mitte" + Flackern). Der
  // animierte Style überschreibt sie ab Frame 2 nahtlos.
  // Beschnitt von rechts, synchron zur reinslidenden Ergebnis-Liste: Was die
  // Liste bereits bedeckt, wird hier weggeschnitten — darunter kommt genau sie
  // zum Vorschein.
  //
  // NUR über Verschiebungen, bewusst NICHT über die Breite: Breite ist eine
  // Layout-Eigenschaft — Yoga hätte pro Bild den ganzen Teilbaum neu vermessen
  // und Fabric ihn neu montiert. Genau das ruckelte. Verschiebungen laufen
  // dagegen auf dem UI-Thread, ohne Layout.
  //
  // Der Trick: Das Fenster (mit überstehendem Inhalt beschnitten) wandert nach
  // LINKS aus dem Bild, der Inhalt darin exakt gegengleich nach rechts. Der
  // Inhalt steht dadurch optisch still, sichtbar bleibt aber nur der Teil links
  // der Fenster-Kante — also genau das, was die Ergebnis-Liste noch nicht deckt.
  /**
   * Der Beschnitt bewegt sich NUR mit, wenn dieser Screen auch offen ist.
   *
   * Beide Stile lasen bisher `resultsPush` ungefiltert. Der Screen hängt aber
   * dauerhaft am Root — bei einer Suche aus dem Landingscreen wurden seine zwei
   * bildschirmfüllenden Ebenen also jedes Bild mitgeschoben, obwohl er nie offen
   * war und niemand ihn sieht. Zusammen mit Unterlage und Ergebnisliste waren das
   * vier bewegte Vollbild-Ebenen statt zwei — beim Ticket-Übergang, der als glatt
   * empfunden wird, sind es genau zwei.
   */
  // Gegenbewegung UND Parallax in EINEM Transform: Der Inhalt muss um SW*p nach
  // rechts (damit er optisch stillsteht) und um 20% davon nach links (Parallax).
  // Beides zusammengefasst spart eine animierte Ebene im schwersten Baum der App
  // — vorher lag der Parallax als eigener Transform im SearchHero darunter, also
  // ein zusätzlicher Knoten, den Android pro Bild mit-compositen musste.
  const clipContentStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          winW * pushProgress(heroClipPush.value) * (1 + UNDERLAY_TRAVEL_FRAC),
      },
    ],
  }));

  // Splash-Box: STATISCHE finale Geometrie. Bewegung macht
  // ausschließlich splashStyle via transform:scale. Oberecken fix rund (Geräte-
  // Eckenradius); die Unterecken animiert splashStyle zweiphasig (rund→eckig am
  return (
    <Animated.View
      // Sichtbarkeit über `overlayVisible` (UI-Thread) statt über React: Der
      // Ausgangswert der Bewegung und das Sichtbarschalten liegen damit im
      // selben Bild — sonst blitzte das Blatt an seiner Zielposition auf, bevor
      // es losfährt.
      style={[
        styles.root,
        // Die Fläche des Blattes reicht bis ganz nach unten, auch hinter die
        // Tab-Leiste.
        //
        // Der INHALT endet weiterhin über der Leiste (areaStyle), damit sie
        // bedienbar bleibt. Ohne Farbe dahinter war dieser Streifen aber
        // durchsichtig — und weil die Leiste selbst durchscheint, sah man dort
        // den Landingscreen. Jetzt läuft die Farbe des Formulars durch, die
        // Leiste liegt also auf dem Such-Screen statt auf dem Bildschirm darunter.
        { width: winW, backgroundColor: palette.s1 },
        outerOpacityStyle,
        sheetStyle,
      ]}
      // Für die DAUER der Bewegung eine GPU-Ebene. Darunter liegt der
      // Dünen-SVG; ohne sie würde er in jedem Bild der Slide neu gerastert.
      // Dauerhaft darf sie nicht sein — dann entstünde sie bei jeder Eingabe im
      // Formular neu. Dasselbe Muster wie im Ticket-Blatt.
      renderToHardwareTextureAndroid={Platform.OS === "android" && (moving || pickerBusy)}
      pointerEvents={active && launchActive ? "box-none" : "none"}
    >
      {/* box-none: Dieser Rahmen spannt die VOLLE Fensterhöhe (er traegt die
          Gegenbewegung des Beschnitts) und lag damit auch ueber dem Streifen der
          Tab-Leiste — mit der Standard-Einstellung fing er dort jede Beruehrung
          ab, die Leiste war im Such-Screen also tot. Die Kinder darin regeln ihre
          Treffer-Flaechen selbst (areaStyle endet bei NAVBAR_H). */}
      <ClipContent style={[styles.inner, { width: winW }, clipContentStyle]}>
      {active ? <StatusBar style="light" /> : null}
      {/* Blockt Taps auf den Landingscreen darunter, solange dieses Blatt oben
          liegt — aber NICHT auf die Nav-Bar. */}
      {active ? <View style={areaStyle} pointerEvents="auto" /> : null}

      {/* Der Inhalt bleibt DAUERHAFT gemountet, auch wenn die Suche zu ist —
          sonst fiele pro Öffnung ein Aufbau an, und zwar genau im Bild, in dem
          die Bewegung startet. KEIN `key`, aus demselben Grund. */}
      <Animated.View
        style={areaStyle}
        pointerEvents={active ? "auto" : "none"}
      >
        <SearchHero
          mode={heroMode}
          entranceTrigger={entranceTick}
          bgTrigger={bgTick}
          resetTrigger={resetTick}
        />
      </Animated.View>



      {/* Zurück-Pfeil oben links. */}
      {active ? (
        <Animated.View style={[styles.backWrap, { top: insets.top + 10 }]}>
          <Pressable
            onPress={() => {
              haptic("button");
              close();
            }}
            hitSlop={12}
            accessibilityRole="button"
            style={styles.backBtn}
          >
            <ArrowLeft size={22} color="#FFFFFF" strokeWidth={2} />
          </Pressable>
        </Animated.View>
      ) : null}
      </ClipContent>
    </Animated.View>
  );
}

const styles = scaledStyles({
  // Feste Breite statt absoluteFill: clipStyle animiert sie (siehe dort).
  // overflow hidden, damit der Beschnitt auch greift.
  root: {
    position: "absolute",
    left: 0,
    top: 0,
    height: "100%",
    width: SW,
    // Gerundete Ecken beim Hereinfahren, passend zum Geräte-Display — dieselbe
    // Behandlung wie bei der Ergebnisliste und den Detail-Blättern. `overflow`
    // beschneidet den Inhalt darauf; Android macht das über clipToOutline,
    // also GPU-seitig, die Bewegung bleibt flüssig.
    borderRadius: SCREEN_CORNER_RADIUS,
    overflow: "hidden",
  },
  // Gegenstück zum Fenster: feste Breite, damit der Inhalt beim Verschieben
  // nichts neu umbricht.
  inner: { width: SW, height: "100%" },
  backWrap: { position: "absolute", left: 18 },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.10)",
    alignItems: "center",
    justifyContent: "center",
  },
});
