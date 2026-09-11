import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "lucide-react-native";
import { SearchHero, type SearchHeroInitial } from "@/components/search/SearchHero";
import { SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";
import { useSheetSlide } from "@/lib/nav/sheetSlide";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { haptic } from "@/lib/haptics";
import { useT } from "@/lib/i18n/useT";
import { usePalette } from "@/lib/theme/appBg";
import { CLOSE_ICON_SIZE, GUTTER, SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";
import { useSheetSwipe } from "@/lib/ui/sheetSwipe";
import type { TravelMode } from "@/types/search";

const C = {
  /** Der X-Knopf trägt in Ortswähler, Bo, Spracheingabe und Benachrichtigungen
   *  denselben Ton. */
  closeIcon: "#E5E7EB",
};

/**
 * Die Fensterhöhe EINMAL beim Laden — wie in allen Blättern dieser App.
 *
 * Nicht die Gerätehöhe (die enthält Status- und Navigationsleiste, das wären bei
 * gleicher Dauer rund 9% mehr Tempo) und nicht laufend gelesen: Unter
 * `adjustResize` schrumpft sie mit der Tastatur, und dann führe das Blatt beim
 * nächsten Öffnen eine andere Strecke.
 */
const WINDOW_H = Dimensions.get("window").height;

/** Untere Ecken des Blattes — derselbe Radius wie an allen Blättern der App. */
const SHEET_RADIUS = 28;

/**
 * Der Deckel für die Höhe — und warum ausgerechnet hier.
 *
 * Das Blatt ist so hoch wie sein Inhalt, und der ist bekannt: Aus dem Stilblatt
 * des Formulars aufaddiert (Reisearten-Zeile 38+10, zwei Ortsfelder 2×56+8,
 * Datumszeile 56, Knopfzeile 42, Suchknopf 56+4, vier Zwischenräume à 10, oben
 * 18 und unten 20) ergeben sich rund 400 Punkte, dazu die Kopfzeile mit dem X
 * und die sichere Fläche — auf einem 900 Punkte hohen Fenster etwa die Hälfte.
 * Der Deckel greift im Normalfall also gar nicht.
 *
 * Er steht trotzdem, und zwar aus zwei Gründen. Erstens ist die Rechnung oben
 * eine Momentaufnahme: Ein zusätzliches Feld, eine größere Systemschrift oder
 * ein sehr kurzer Bildschirm verschieben sie. Zweitens — und das ist der
 * eigentliche Punkt — MUSS unter dem Blatt etwas übrig bleiben. Fährt es bis
 * an den unteren Rand, ist es kein Blatt mehr, sondern ein Bildschirm: Die
 * Verdunkelung, an der man daneben tippt, verschwände, und mit ihr der
 * sichtbare Hinweis, dass die Ergebnisse darunter weiterhin da sind.
 *
 * 78% lässt gut ein Fünftel der Höhe stehen — genug für einen bequemen Tipp
 * daneben. Der Wert steht ZWEIMAL da (als Bruch für den Parkplatz, als Prozent
 * im Stilblatt), weil `scaledStyles` Zahlen skaliert, Zeichenketten aber nicht:
 * Als Zahl bekäme ein bereits aus der echten Fensterhöhe gerechneter Wert den
 * Kleingerät-Faktor ein zweites Mal.
 */
const MAX_FRAC = 0.78;
const MAX_H = Math.round(WINDOW_H * MAX_FRAC);

/**
 * Wie lange der Vorbau wartet, nachdem der Ergebnis-Bildschirm steht.
 *
 * Nicht beliebig: `armed` kippt am ENDE der Einfahrt, und in demselben Commit
 * entsteht die Lade-Szene — vier Reanimated-Schleifen samt SVG-Baum. Ein
 * Aufbau 200ms später liegt genau in deren Anlauf, und jede neu eingehängte
 * Zuordnung verwirft die sortierte Reihenfolge ALLER Zuordnungen der App, die
 * im nächsten Bild neu aufgebaut wird. Das ist im Projekt der belegte Grund
 * dafür, dass Bewegungen nach einer Suche schlechter liefen.
 *
 * 700ms liegen hinter dem Anlauf der Szene und vor der Antwort einer üblichen
 * Suche (die Anbieter brauchen Sekunden, nicht Zehntel). Der Wiederversuch alle
 * 200ms darunter fängt ab, was trotzdem hineinläuft.
 *
 * Wer schneller ist als der Vorbau, verliert nichts: Ein Öffnen baut das
 * Formular sofort (siehe der Notausgang im Effekt).
 */
const PREBUILD_DELAY_MS = 700;

export interface SearchEditPanelProps {
  visible: boolean;
  /** Wahr, sobald der Ergebnis-Screen steht — Aufbau des Formulars vorziehen. */
  armed: boolean;
  onClose: () => void;
  /** Neue Such-Parameter, exakt in der Form der Ergebnis-Parameter. */
  onApply: (params: Record<string, string>) => void;
  mode: TravelMode;
  /**
   * Vorbelegung des Formulars. Die Kennung dieses Objekts entscheidet, WANN
   * vorbelegt wird — sie gehört deshalb festgehalten (`useMemo` beim
   * Aufrufer), sonst schriebe das Formular sich bei jedem Durchgang selbst um.
   */
  initial: SearchHeroInitial | null;
}

/**
 * Die Such-Slide über der Ergebnisliste — ein Blatt von OBEN.
 *
 * Vier Dinge sind hier absichtlich so und nicht anders:
 *
 * **Die Fahrt kommt aus `useSheetSlide`, die Geste aus `useSheetSwipe`.** Kein
 * eigener Wert, keine eigene Kurve, keine eigene Schwelle — dieselben
 * Funktionen, die Ort- und Datumswähler, Benachrichtigungen, Ticket- und
 * Streckenblatt fahren. Dass dieses Blatt in die Gegenrichtung fährt, ist dort
 * ein VORZEICHEN (negativer Parkplatz, `direction: "up"`) und kein zweiter
 * Pfad. Genau daran hing die letzte große Aufräumaktion: Sechs Blätter waren
 * über Monate in Dauer, Strecke und Kurve auseinandergelaufen, und das war der
 * Unterschied zwischen „elegant" und „ruckelt". Ein siebtes mit eigenen Zahlen
 * hätte dieselbe Sammlung wieder aufgemacht.
 *
 * **Das Formular wird VORGEBAUT, nicht beim Öffnen gemountet.** `SearchHero`
 * ist der teuerste Baum der App. Entstünde er im Commit, der die Bewegung
 * auslöst, läge sein Aufbau in deren erstem Bild — der Fehler, den dieses
 * Projekt an einem Dutzend Stellen bekämpft (Wähler-Vorbau, Streckenliste,
 * Ergebniskarten). Gebaut wird deshalb, sobald der Ergebnis-Bildschirm steht
 * UND gerade nichts fährt; danach bleibt er stehen.
 *
 * **Geschlossen kostet es nichts.** Die Wurzel steht auf `pointerEvents="none"`,
 * und damit bricht die Gesten-Bibliothek ihre Trefferprüfung an dieser Stelle
 * ab — ein dauerhaft gemountetes, geschlossenes Blatt kostet pro Berührung
 * nichts.
 *
 * **Die neue Suche läuft NACH der Bewegung an.** Siehe `handleSubmit`.
 */
function SearchEditPanelComponent({
  visible,
  armed,
  onClose,
  onApply,
  mode,
  initial,
}: SearchEditPanelProps) {
  const t = useT();
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  /**
   * Die Rückrufe aus MERKERN, still nachgeführt.
   *
   * An ihnen hängen die Zurück-Taste, die Wisch-Geste und der Übergabe-Wecker.
   * Hingen sie an den Eigenschaften selbst, genügte ein Aufrufer, der sie als
   * Pfeilfunktion hineinschreibt (`onClose={() => …}`), damit bei jedem
   * Durchgang des Ergebnis-Bildschirms alle drei neu entstehen — die Geste also
   * mitten im offenen Blatt neu eingerichtet wird. Dieselbe Vorkehrung wie in
   * `SheetModal`, und aus demselben Grund.
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;

  /**
   * Steht das Formular schon? Die Erklärung dazu am Effekt weiter unten.
   *
   * Die DEKLARATION steht hier oben, weil `park` sie liest — `const` wird nicht
   * hochgezogen, und eine Nutzung vor der Zeile wäre kein Tippfehler, sondern
   * ein Absturz beim ersten Durchgang.
   */
  const [mounted, setMounted] = useState(false);

  /**
   * Die gemessene Höhe des Blattes — und damit seine Strecke.
   *
   * Sie muss echt gemessen sein: Aus einem geschätzten Parkplatz führe das
   * Blatt einen Teil der Dauer noch außerhalb des Bildes und wäre in der
   * restlichen Zeit entsprechend schneller. Man sieht das sofort — es kommt
   * „zu spät und dann zu hastig".
   *
   * Bis die Messung da ist, gilt der Deckel als Parkplatz. Er ist garantiert zu
   * groß, und zu groß ist hier die sichere Seite: Das Blatt steht dann
   * vollständig außerhalb des Bildes. Ein zu kleiner Wert ließe es sichtbar
   * hereinragen, bevor es überhaupt jemand geöffnet hat.
   *
   * Und die Messung zählt erst, wenn das FORMULAR steht (`mounted`). Vorher
   * misst sie nur die Kopfzeile — rund neunzig Punkte. Wer die Slide in genau
   * diesem Fenster öffnet (möglich, wenn der Vorbau noch nicht durch ist),
   * bekäme mit dieser Höhe als Strecke ein Blatt, das schon zu vier Fünfteln im
   * Bild steht und die letzten neunzig Punkte hereinrutscht.
   */
  const [sheetH, setSheetH] = useState(0);
  const onSheetLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h <= 0) return;
    // Nur bei echter Änderung: `onLayout` feuert auch für Durchgänge, die an
    // der Geometrie nichts ändern, und jeder Zustandswechsel hier zieht die
    // Kennungen der Fahrt (`park`) mit sich.
    setSheetH((prev) => (Math.abs(prev - h) < 1 ? prev : h));
  }, []);

  /**
   * Der Parkplatz liegt OBERHALB des Bildrands, also im Negativen.
   *
   * Das ist die ganze Umkehr: `useSheetSlide` fährt in beiden Richtungen auf 0
   * zu, und ob ein Blatt von unten oder von oben kommt, steckt allein im
   * Vorzeichen dieser Zahl.
   */
  const park = -(mounted && sheetH > 0 ? sheetH : MAX_H);
  const { y, style, run, adopt, parkNow, warm } = useSheetSlide("searchEdit", park);

  /**
   * Die Verdunkelung hängt am SELBEN Wert wie die Fahrt.
   *
   * Kein zweiter geteilter Wert, keine zweite Kurve: Sie ist schlicht der
   * zurückgelegte Anteil der Strecke. Damit kann sie gar nicht aus dem Takt
   * geraten — und vor allem geht sie beim ZIEHEN mit, wo eine eigene Kurve
   * stehenbliebe. Genau diesen Weg hat das Streckenblatt gerade bekommen; die
   * Division geht hier mit negativem `park` unverändert auf, weil sich die
   * Vorzeichen von Zähler und Nenner wegkürzen.
   */
  const scrimStyle = useAnimatedStyle(() => ({
    /**
     * Begrenzt, obwohl der Anteil rechnerisch zwischen 0 und 1 liegt.
     *
     * Er tut es nur, solange `y` und `park` zusammenpassen. Sie tun das für
     * genau einen Durchgang NICHT: wenn die Messung eintrifft und `park`
     * kleiner wird, während der geteilte Wert noch auf dem alten Parkplatz
     * steht. Ohne Grenze käme dort eine negative Deckkraft heraus, und die ist
     * kein gültiger Wert. Dasselbe `Math.min/Math.max` steht aus demselben
     * Grund im Streckenblatt.
     */
    opacity: 1 - Math.min(1, Math.max(0, y.value / park)),
  }));

  /**
   * Fahrt und Aussehen in EINEM festen Array.
   *
   * Der bewegte Knoten bekommt bei jedem Durchgang dieselbe Kennung. Ein
   * frisches Array wäre auf Fabric ein Commit auf genau dem Knoten, den
   * Reanimated Bild für Bild beschreibt — dieselbe Falle, die in der
   * Ergebnisliste am Wurzel-Stil beschrieben ist.
   */
  /**
   * Auch die Verdunkelung bekommt ihr Array FEST.
   *
   * Sie ist ein animierter Knoten, und ein frisches Array wäre auf Fabric bei
   * jedem Durchgang ein Commit auf genau dem Knoten, den Reanimated Bild für
   * Bild beschreibt — dieselbe Begründung wie am Blatt darunter.
   */
  const scrimStyleArr = useMemo(
    () => [styles.scrim, scrimStyle],
    [scrimStyle],
  );

  const sheetStyle = useMemo(
    () => [
      styles.sheet,
      // Die sichere Fläche trägt das Blatt selbst: Es beginnt am oberen
      // Bildrand, das X liegt sonst unter der Statusleiste.
      { backgroundColor: palette.s1, paddingTop: insets.top },
      style,
    ],
    [insets.top, palette.s1, style],
  );

  /**
   * Den echten Weg EINMAL kalt anlaufen lassen — sonst ruckelt das erste
   * Öffnen.
   *
   * Reanimated übersetzt die Worklets einer Bewegung beim ersten Lauf. `warm`
   * nimmt dafür denselben Pfad, den später auch die echte Fahrt nimmt (siehe
   * `sheetSlide`); ein Anlauf über eine andere Funktion wäre keiner.
   *
   * ERST WENN DAS FORMULAR STEHT — und das ist keine Bequemlichkeit, sondern
   * die Korrektur eines Fehlers. Der Anlauf hing zuvor am bloßen Aufbau dieser
   * Komponente, und die entsteht mit dem Ergebnis-Bildschirm, also mitten in
   * dessen Einfahrt. Was harmlos aussieht („bewegt das Blatt um zwei
   * Tausendstel Punkte"), ist dort eine 300ms laufende Kurve auf dem UI-Strang
   * PLUS die beiden Zuordner, die an diesem Wert hängen (Blatt und
   * Verdunkelung) — beide werden für die Dauer in jedem Bild ausgewertet, und
   * zwar in genau den Bildern, in denen die Ergebnisliste hereinfährt. Der
   * Anlauf gegen das Ruckeln ruckelte damit selbst, nur woanders.
   *
   * `mounted` ist der richtige Aufhänger, weil es bereits auf Ruhe wartet
   * (siehe den Effekt weiter unten) — eine zweite Prüfung wäre eine zweite
   * Stelle, die dasselbe entscheidet.
   *
   * EIN Bild später, und der Merker gehört IN den Rückruf: `park` ändert sich
   * mit `mounted` mit, und der Effekt darunter parkt daraufhin — das bricht
   * eine laufende Kurve ab, also genau die, die der Anlauf gerade eingereiht
   * hat. Beide Wähler und das Benachrichtigungs-Blatt stoßen ihn aus demselben
   * Grund über ein Bild an.
   */
  const warmed = useRef(false);
  useEffect(() => {
    if (!mounted || warmed.current) return;
    const id = requestAnimationFrame(() => {
      warmed.current = true;
      warm();
    });
    return () => cancelAnimationFrame(id);
  }, [mounted, warm]);

  /**
   * Nur bei echtem WECHSEL fahren.
   *
   * `run` bekommt eine neue Kennung, sobald sich `park` ändert — und das tut es
   * einmal, wenn die Messung eintrifft. Ohne diesen Merker liefe die Fahrt dann
   * ein zweites Mal los, mit unverändertem Zustand, mitten in die schon
   * laufende Bewegung hinein.
   */
  const lastOpen = useRef(false);
  /** Wann die Einfahrt begonnen hat — siehe `dismissFromScrim`. */
  const enteredAt = useRef(0);
  useEffect(() => {
    if (lastOpen.current === visible) return;
    lastOpen.current = visible;
    if (visible) enteredAt.current = Date.now();
    run(visible);
  }, [visible, run]);

  /** Geänderte Strecke (die Messung trifft ein) — neu parken, solange zu. */
  useEffect(() => {
    if (!visible) parkNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [park]);

  /**
   * Wisch nach OBEN schließt — die Spiegelung dessen, was alle Blätter von
   * unten haben.
   *
   * Die Ausfahrt fährt die GESTE, im Bild des Loslassens, auf dem UI-Strang.
   * Ginge sie über den Zustand (`onClose` → Neu-Durchgang → Effekt oben →
   * `run`), lägen dazwischen der Sprung auf den JS-Strang, ein React-Durchgang
   * und das Bild Vorlauf, das `run` bewusst einlegt — das Blatt bliebe in genau
   * dem Moment stehen, in dem der Finger das Glas verlässt.
   *
   * Damit die gemeinsame Fahrt trotzdem Bescheid weiß, bekommt sie die Bewegung
   * als BUCHUNG (`adopt`), und `lastOpen` wird von Hand nachgezogen: Sonst
   * setzte der Effekt oben dieselbe Ausfahrt ein zweites Mal an, und zwei
   * Kurven auf demselben Wert sind als Tempo-Wechsel zu sehen.
   */
  const dismissBySwipe = useCallback(
    (durationMs: number, fromY: number) => {
      adopt(false, durationMs, fromY);
      lastOpen.current = false;
      onCloseRef.current();
    },
    [adopt],
  );
  /**
   * Steht der Inhalt am Deckel? Dann gehört das Wischen dem FORMULAR.
   *
   * Normalerweise passt das Formular in das Blatt (siehe `MAX_FRAC`: rund 400
   * gegen 700 Punkte), es scrollt also gar nicht, und ein Wisch nach oben kann
   * nur „weg damit" heißen. Reicht der Platz einmal nicht — sehr kurzer
   * Bildschirm, ein zusätzliches Feld —, wird aus derselben Bewegung
   * „weiterlesen", und dann sind es zwei Bedeutungen für eine Geste.
   *
   * Bei den Blättern von unten löst das ein Torhüter: Dort ist die Frage
   * eindeutig zu beantworten, weil die Liste an ihrem ANFANG nicht weiterkann
   * und genau dort das Blatt übernimmt. Bei einem Blatt von oben liegt der
   * Anschlag am ENDE der Liste — den kennt der Torhüter nicht, er liest nur den
   * Scroll-Stand. Ihn dafür herzurichten hieße, Inhalts- und Sichtfeldhöhe
   * mitzuführen; für einen Fall, der im Normalbetrieb nicht eintritt, wäre das
   * neue Mechanik an einer Datei, an der sechs Blätter hängen.
   *
   * Die Geste wird deshalb schlicht abgeschaltet, sobald der Deckel greift.
   * Geschlossen wird dann über das X oder daneben — beides steht unverändert.
   * Die Alternative wäre ein Formular, dessen Such-Knopf man nicht mehr
   * erreicht, weil jeder Wisch nach oben das Blatt wegnimmt.
   *
   * Gemessen und nicht gerechnet: `sheetH` ist die tatsächliche Höhe NACH dem
   * Deckel. Wer sie erreicht, ist an ihm.
   */
  const capped = mounted && sheetH > 0 && sheetH >= MAX_H - 1;

  const panGesture = useSheetSwipe({
    y,
    // Eine LÄNGE, positiv — das Vorzeichen steht in `direction`.
    travel: mounted && sheetH > 0 ? sheetH : MAX_H,
    onDismiss: dismissBySwipe,
    direction: "up",
    // Das Blatt bleibt dauerhaft gemountet. Ein dauerhaft scharfer Erkenner
    // läge sonst über der ganzen Ergebnisliste — auch geschlossen. Und am
    // Deckel gehört die Bewegung dem Formular, siehe `capped`.
    enabled: visible && !capped,
  });

  /** Zurück-Taste schließt das Blatt, statt den Bildschirm zu verlassen. */
  useEffect(() => {
    if (Platform.OS !== "android" || !visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onCloseRef.current();
      return true;
    });
    return () => sub.remove();
  }, [visible]);

  /**
   * Das Formular vorbauen, sobald der Ergebnis-Bildschirm steht und nichts
   * fährt.
   *
   * Beides muss stimmen: `armed` allein kippt genau in dem Commit, in dem die
   * Liste hereinfährt — der Aufbau läge dann in deren ersten Bildern. Der
   * Wiederversuch ist dieselbe Bauart wie die Freigabe der Ergebniskarten:
   * Abstand plus Prüfung, ob gerade eine Bewegung läuft, und notfalls nochmal.
   *
   * Der Notausgang darüber ist kein Sonderweg, sondern die Regel für den
   * unwahrscheinlichen Fall: Wer die Slide öffnet, bevor der Vorbau
   * durchgekommen ist, bekommt sie trotzdem — dann eben mit dem Aufbau im
   * ersten Bild. Ein leeres Blatt wäre die schlechtere Antwort.
   *
   * Einmal gebaut, bleibt es stehen. Ein Abbau beim Schließen machte den
   * ganzen Vorbau wieder zunichte, und der Zustand des Formulars ginge mit.
   */
  /**
   * Beim Bauen die Messung MITZURÜCKSETZEN — sonst blitzt das Formular auf.
   *
   * Vor dem Vorbau enthält das Blatt nur die Kopfzeile, gemessen werden also
   * rund neunzig Punkte. Die zählen bewusst nicht als Strecke (siehe `park`),
   * solange nichts gebaut ist — nur kippt `mounted` einen Wimpernschlag VOR
   * der Neuvermessung: In diesem einen Bild stünde ein 480 Punkte hohes Blatt
   * mit einer Strecke von 90 da, also 390 Punkte weit sichtbar über der
   * Ergebnisliste. Auf Null gesetzt greift stattdessen wieder der Deckel, und
   * das Blatt bleibt außerhalb des Bildes, bis die echte Höhe da ist.
   */
  const build = useCallback(() => {
    setSheetH(0);
    setMounted(true);
  }, []);
  useEffect(() => {
    if (mounted) return;
    if (visible) {
      build();
      return;
    }
    if (!armed) return;
    let id: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (isTransitionBusy()) {
        id = setTimeout(attempt, 200);
        return;
      }
      build();
    };
    id = setTimeout(attempt, PREBUILD_DELAY_MS);
    return () => clearTimeout(id);
  }, [armed, build, mounted, visible]);

  /**
   * Tippen NEBEN das Blatt — zählt erst, wenn es steht.
   *
   * Die Fläche dafür deckt den ganzen Bildschirm ab, auch die Stelle, an der
   * der Knopf sitzt, der die Slide öffnet, und sie ist von der ersten
   * Millisekunde an berührbar. Wer zweimal schnell darauf tippt — was man tut,
   * wenn man denkt, der erste Tipp sei nicht angekommen —, träfe mit dem
   * zweiten bereits diese Fläche und schlösse das Blatt wieder, bevor es unten
   * ist. Dieselbe Sperre trägt das Benachrichtigungs-Blatt.
   */
  const dismissFromScrim = useCallback(() => {
    if (Date.now() - enteredAt.current < SHEET_IN.duration) return;
    haptic("button");
    onCloseRef.current();
  }, []);

  const dismiss = useCallback(() => {
    haptic("button");
    onCloseRef.current();
  }, []);

  /**
   * Erst wegfahren, DANN suchen.
   *
   * `onApply` baut die Ergebnisliste neu auf — der teuerste Commit dieses
   * Bildschirms. Fiele er in die ersten Bilder der Ausfahrt, sähe man genau
   * das, wogegen an einem Dutzend Stellen dieses Projekts ein Bild oder eine
   * Bewegungsdauer eingelegt ist: Das Blatt setzt sich in Bewegung, bleibt
   * hängen und läuft dann weiter.
   *
   * Die Wartezeit ist die Dauer der Ausfahrt: Aus der Ruhelage heraus ist der
   * Restweg die ganze Strecke, `useSheetSlide` kürzt die Dauer also nicht. Die
   * 20 obendrauf sind das Bild Vorlauf, das `run` zwischen Anmelden und
   * Losfahren einlegt — ohne sie fiele der Aufbau noch in das letzte Bild der
   * Bewegung. Dieselbe Zugabe nutzt das Streckenblatt für seine Liste.
   *
   * Bewusst OHNE Wiederversuch auf `isTransitionBusy` — anders als beim Abbau
   * der Karten. Dort ist Aufräumen gemeint und Warten billig; hier wartet der
   * Nutzer auf seine Suche, und jede weitere Verzögerung wäre für ihn schlicht
   * eine App, die nicht reagiert.
   */
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (applyTimer.current) clearTimeout(applyTimer.current);
    },
    [],
  );
  const handleSubmit = useCallback((params: Record<string, string>) => {
    onCloseRef.current();
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => {
      applyTimer.current = null;
      onApplyRef.current(params);
    }, SHEET_OUT.duration + 20);
  }, []);

  return (
    /**
     * Die Berührungs-Sperre sitzt auf DIESER Hülle, nicht auf einem der
     * bewegten Knoten.
     *
     * Sie wechselt genau in dem Durchgang, in dem die Fahrt beginnt, und ein
     * Eigenschafts-Wechsel ist auf Fabric ein Commit auf ebendem Knoten, den
     * Reanimated dort Bild für Bild beschreibt. Auf der ruhenden Hülle wirkt er
     * unverändert — und geschlossen MUSS er stehen: Die Verdunkelung liegt über
     * dem ganzen Bild, auch wenn sie unsichtbar ist, und darunter liegt eine
     * Liste, die scrollen können muss.
     */
    <View style={styles.layer} pointerEvents={visible ? "auto" : "none"}>
      <Animated.View pointerEvents="none" style={scrimStyleArr} />
      {/* Tippen neben das Blatt schließt. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={t("search.close")}
        onPress={dismissFromScrim}
      />

      <GestureDetector gesture={panGesture}>
        <Animated.View style={sheetStyle} onLayout={onSheetLayout}>
          <View style={styles.header}>
            {/**
              * `Pressable` statt `RippleTouch` — dieselbe Begründung wie am
              * X-Knopf des Ortswählers und des Benachrichtigungs-Blattes:
              * Dieser Knopf STARTET die Ausfahrt, und der native Wellen-Effekt
              * ist eine 300 bis 400ms lange Zeichen-Animation mitten auf einem
              * Blatt, das sich in derselben Zeit bewegt. Sie liefe über die
              * volle Dauer der Rückfahrt dagegen an.
              */}
            <Pressable
              onPress={dismiss}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t("search.close")}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <X color={C.closeIcon} size={CLOSE_ICON_SIZE} />
            </Pressable>
          </View>

          {/**
            * Das Formular — dieselbe Komponente wie im Such-Blatt, nur ohne
            * Himmel und ohne Bildschirm-Hülle.
            *
            * `active={visible}` ist die Zeile, ohne die es zwei Formulare
            * gäbe, die dieselbe Auswahl übernehmen: Ort- und Datumswähler geben
            * ihr Ergebnis über globalen Zustand zurück, und das Formular des
            * Such-Blattes ist die ganze Zeit mitgemountet. Der Ort, den man
            * hier wählt, stünde sonst auch dort.
            *
            * Dass diese Eigenschaft mit der Sichtbarkeit wechselt, heißt: Das
            * Formular rendert in dem Durchgang durch, in dem geöffnet oder
            * geschlossen wird. Das ist verkraftbar und sogar richtig
            * einsortiert — `run` legt zwischen Anmelden und Losfahren
            * ausdrücklich ein Bild ein, und genau in dieses fällt der Commit.
            * Der teure Teil des Bildschirms, der Hero, ist eingebettet ohnehin
            * nicht dabei.
            */}
          {mounted ? (
            <SearchHero
              mode={mode}
              embedded
              initial={initial}
              active={visible}
              onSubmit={handleSubmit}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

export const SearchEditPanel = memo(SearchEditPanelComponent);

const styles = scaledStyles({
  /**
   * NUR `zIndex`. Keine `elevation` — und das ist hier eine belegte
   * Fehlerquelle, keine Geschmacksfrage.
   *
   * Hier stand `elevation: 34`, begründet mit der Schichtung gegen Detail- und
   * Streckenblatt. Die Begründung war schlicht falsch: Diese beiden hängen am
   * WURZEL-Layout, also als Geschwister des ganzen Ergebnis-Bildschirms — diese
   * Slide dagegen liegt INNERHALB seiner bewegten Hülle. Höhe wie `zIndex`
   * ordnen immer nur unter Geschwistern; gegen die beiden konnte sie also
   * ohnehin nichts ausrichten, und innerhalb der Hülle steht sie als letztes
   * Kind bereits oben.
   *
   * Gekostet hat sie trotzdem: Auf Android ist `elevation` mehr als eine
   * Reihenfolge — sie hebt die Ansicht auf eine eigene Ebene und lässt Android
   * einen Schatten dafür rechnen, hier für eine bildschirmfüllende Fläche, die
   * DAUERHAFT im Baum liegt und mit ihm von rechts hereinfährt. Genau dieser
   * Satz steht in der Ergebnisliste am Wurzel-Stil (`slideRoot`), wo dieselbe
   * Zeile („ein guter Teil der Zähigkeit, die überall zu spüren war")
   * ausgebaut wurde.
   *
   * `zIndex` bleibt als Absicherung gegen ein späteres Umsortieren im
   * Ergebnis-Baum: Es kostet nichts und ist genau das Mittel, das die
   * Ergebnisliste dafür vorsieht.
   */
  layer: { ...StyleSheet.absoluteFillObject, zIndex: 400 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },

  /**
   * Am oberen Rand verankert, nach unten offen — die Umkehr des Blattes von
   * unten.
   *
   * KEIN `overflow: "hidden"`, und das ist hier eine Entscheidung mit
   * Gegenleistung: Runde Ecken kosten auf RN 0.81 ohnehin einen Pfad-Clip pro
   * Bild, das Clippen der KINDER käme als zweiter Durchgang obendrauf, über die
   * volle Fahrt. Damit die Ecken trotzdem rund BLEIBEN, trägt das Formular
   * darin eingebettet gar keine eigene Farbe — die Fläche kommt von hier, und
   * kein Kind malt über die Rundung.
   *
   * `maxHeight` als Prozentwert: siehe `MAX_FRAC`.
   */
  sheet: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    maxHeight: "78%",
    borderBottomLeftRadius: SHEET_RADIUS,
    borderBottomRightRadius: SHEET_RADIUS,
  },

  /**
   * Maße aus dem Benachrichtigungs-Blatt, das sie seinerseits aus dem
   * Ortswähler hat — dem Vorbild-Fall für die Kopfzeile eines Blattes.
   *
   * `paddingTop` ist der eine Wert, der nicht abgeschrieben werden konnte:
   * Der Ortswähler braucht seine 56 zum größten Teil für die Statusleiste. Die
   * trägt hier das Blatt selbst (`insets.top`), die Kopfzeile beginnt also mit
   * derselben Luft, die auch das Benachrichtigungs-Blatt lässt.
   *
   * `paddingBottom` ist der andere, und der ist HERGELEITET statt übernommen.
   *
   * Maßstab ist der Abstand, den das Formular darunter selbst setzt: von der
   * Unterkante der Reisearten-Zeile bis zur Oberkante des ersten Ortsfeldes.
   * Er besteht aus zwei Teilen, beide im Stilblatt von `SearchHero`:
   *
   *     navRow.marginBottom     10
   *   + formContent.gap         10
   *   ------------------------------
   *   = 20
   *
   * Über der Zeile standen dagegen 34 — die 16 dieser Kopfzeile (`SPACE.lg`)
   * plus die 18 `paddingTop` des Formularinhalts. 14 zu viel, und genau so
   * gemeldet.
   *
   * Die Rechnung geht ohne Rest auf, weil an der Reisearten-Zeile nichts
   * zentriert wird: `navRow` gibt nur `minHeight: 38` vor, der Umschalter darin
   * ist mit 38 + 2×4 Innenabstand aber 46 hoch. Die Mindesthöhe greift also gar
   * nicht, und die sichtbaren Kanten des Kastens SIND die Kanten der Zeile —
   * es gibt keinen Zentrier-Rest, der oben und unten mitzurechnen wäre.
   *
   * Der Ausgleich liegt HIER und nicht im Formular: Der eingebettete Inhalt
   * gibt seinen oberen Innenabstand ganz auf (`formContentEmbedded`), und
   * dieser Wert trägt den Abstand allein. Eine Zahl an einer Stelle statt einer
   * Summe über zwei Dateien — und 20 ist `SPACE.xl`, der Wert bleibt also im
   * Raster.
   *
   * Dass die Reisearten-Zeile fehlen kann (nur eine Reiseart), ändert daran
   * nichts: Beide Summanden über ihr sind unbedingte Innenabstände. Steht das
   * erste Ortsfeld direkt unter dem X, ist der Abstand derselbe.
   *
   * Ein Vorbehalt zur Skalierung, damit ihn niemand für einen Fehler hält:
   * `ms(20)` und `ms(10) + ms(10)` können auf kurzen Bildschirmen um einen
   * Punkt auseinandergehen — nämlich bei einem Faktor, der 10 auf einen halben
   * Punkt legt (0,85 und 0,95). Das liegt unter der Wahrnehmungsschwelle und
   * ist der Preis dafür, dass hier eine einzige Zahl steht statt einer über
   * zwei Dateien verteilten Summe.
   */
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: GUTTER,
    paddingTop: SPACE.xxl,
    paddingBottom: SPACE.xl,
  },
});
