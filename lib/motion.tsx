import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  AccessibilityInfo,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeInDown,
  ReduceMotion,
  makeMutable,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

/**
 * EIN Bewegungs-Vokabular für die ganze App.
 *
 * Ohne das erfindet jeder Screen sein eigenes Timing, und die App fühlt sich
 * zusammengestückelt an — mal springt etwas, mal kriecht es. Die Werte hier sind
 * nicht geraten:
 *
 *   - 200-400 ms ist das Fenster, in dem Bewegung als REAKTION gelesen wird.
 *     Darunter wirkt sie abrupt, darüber hält sie auf.
 *   - Der Versatz zwischen zwei Elementen (~60-80 ms) erzeugt die Welle: Das
 *     Auge kann folgen, statt eine fertige Wand zu sehen. Genau das meint
 *     „nicht einfach aufploppen".
 *   - Der Weg nach oben bleibt klein (12 px). Elemente sollen sich SETZEN, nicht
 *     hereinfliegen — eine große Strecke liest sich als Effekt, eine kleine als
 *     Materialität.
 *
 * Die Kurve ist dieselbe wie bei den Push-Transitions (lib/nav/overlayCover.ts,
 * an YouTube nachgemessen): zügig an, langer weicher Auslauf.
 */
export const MOTION = {
  /**
   * Weg nach oben.
   *
   * Stand auf 10 px, und damit war die Animation faktisch unsichtbar: 10 px über
   * 550 ms sind ~18 px/s — langsamer, als das Auge Bewegung noch als Bewegung
   * liest. Wahrnehmbarkeit kommt aus dem WEG, nicht aus der Dauer; wer eine
   * Animation „smoother" machen will, indem er sie verlängert, macht sie in
   * Wahrheit unsichtbar.
   *
   * 16 px sind weit genug, um gelesen zu werden, und kurz genug, dass sich die
   * Elemente immer noch SETZEN statt hereinzufliegen.
   */
  rise: 16,
  /**
   * Weg für große Flächen — AKTUELL UNGENUTZT.
   *
   * Die Idee dahinter: Größere Elemente brauchen MEHR Weg, weil derselbe Weg an
   * einer bildschirmhohen Karte proportional kleiner wirkt als an einem Chip.
   *
   * Große Flächen bewegen sich inzwischen aber gar nicht mehr (siehe `large` in
   * Reveal): Sie sind gerundet + geclippt, und Androids clipToOutline rendert
   * unter einem Ancestor-Transform fehlerhaft — flackernde Ecken und ruckeliges
   * Gleiten. Der Wert bleibt dokumentiert, falls die Bewegung je zurückkehrt
   * (dann aber nur ohne gerundeten Clip auf der bewegten View).
   */
  riseLarge: 22,
  /** Erste Fassung lief mit 360 ms und wirkte gehetzt. „Smooth" heißt hier vor
   *  allem: Zeit lassen. 500 ms ist noch weit unter der Schwelle, ab der
   *  Bewegung als Warten empfunden wird (Kontextwechsel dürfen 600-800 ms). */
  duration: 500,
  /**
   * NUR das erste Element der Welle — deutlich kürzer.
   *
   * Über „fühlt sich der Tab-Wechsel instant an" entscheidet allein das, was man
   * zuerst ansieht. Lief das erste Element mit denselben 500 ms wie der Rest, war
   * es eine halbe Sekunde lang halbdurchsichtig — und halbdurchsichtiger Inhalt
   * liest sich als „noch nicht da", obwohl der Tab längst steht.
   *
   * Es dem Rest der Welle vorwegzunehmen kostet nichts: Die Kaskade dahinter
   * behält ihr Timing komplett, sie beginnt nur hinter einem Element, das schon
   * da ist. Alles darunter darf sich in Ruhe setzen.
   */
  lead: 200,
  /**
   * Für große Flächen (bildschirmhohe Bild-Karten).
   *
   * Große Elemente müssen sich LANGSAMER bewegen als kleine — sonst wirken sie
   * hektisch. Das ist kein Geschmack: Eine große Fläche legt auf dem Schirm mehr
   * Weg pro Pixel Wahrnehmung zurück, und das Auge liest gleiche Dauer bei
   * größerer Fläche als höheres Tempo. Material nennt das „größere Elemente
   * bewegen sich träger"; hier heißt es schlicht: die Destination-Karten
   * bekommen mehr Zeit als die Chips darüber.
   */
  durationLarge: 700,
  /** Abstand zwischen den ERSTEN beiden Elementen. Danach klingt er ab. */
  stagger: 90,
  /**
   * Deckel, den die Welle nie überschreitet — sonst wartet das 20. Element
   * ewig.
   *
   * Vorher war das eine harte Grenze bei 5 Schritten: Ab dem fünften Element
   * bekamen ALLE denselben Versatz. Auf Home lagen die Popular-Destination-
   * Karten genau dort (Index 5, 6, 7 …) — also 450 ms Stillstand, dann klatschte
   * der ganze Block auf einmal rein. In Saved liegen die Karten bei 2, 3, 4, der
   * Deckel griff nie, und deshalb wirkte NUR Saved gestaffelt.
   *
   * Jetzt klingt der Abstand ab (0, 90, 163, 223, 272, 311, 343 …): Jedes
   * Element bekommt seinen eigenen Moment, die Welle läuft immer weiter, und die
   * Summe bleibt trotzdem unter diesem Deckel.
   */
  maxDelay: 480,
  /**
   * easeOutCubic statt der Push-Kurve (0.05, 0.7, 0.1, 1).
   *
   * Die Push-Kurve ist „emphasized decelerate": Sie SCHIESST los und bremst
   * dann. Für eine 400-ms-Seitentransition, die Tempo signalisieren soll, ist
   * das richtig — für ein Element, das sich beiläufig setzen soll, liest es sich
   * als Zucken. Hier soll nichts schießen; der Anstieg ist sanft, das Ausrollen
   * lang.
   */
  easing: Easing.bezier(0.33, 1, 0.68, 1),
} as const;

/**
 * `"worklet"`, weil ScrollReveal das aus einer `useAnimatedReaction` heraus
 * aufruft — die läuft auf dem UI-Thread und kann keine normale JS-Funktion
 * synchron ausführen („Tried to synchronously call a non-worklet function").
 * Mit der Direktive wird die Funktion auf BEIDE Threads kopiert; die
 * JS-Aufrufer (Reveal, revealEntering) rufen sie unverändert weiter auf.
 */
export function staggerDelay(index: number): number {
  const i = Math.max(index, 0);
  const decay = 1 - MOTION.stagger / MOTION.maxDelay;
  return Math.round(MOTION.maxDelay * (1 - Math.pow(decay, i)));
}

/**
 * Systemeinstellung „Bewegung reduzieren" — EIN Abo für die ganze App statt
 * eines pro Element.
 *
 * Wer sie gesetzt hat, tut das meist wegen Schwindel oder Migräne; dann
 * erscheint alles sofort, ohne Bewegung.
 *
 * Vorher legte jede Reveal-Instanz ihr eigenes an: eine asynchrone Abfrage und
 * einen AccessibilityInfo-Listener pro Element. Bei rund zehn Elementen je
 * Screen und vier dauerhaft gemounteten Tabs waren das etwa 40 Listener, 40
 * Abfragen beim Start und 40 Zustandsänderungen, sobald das Ergebnis eintrifft
 * — für einen Wert, der sich praktisch nie ändert und für alle gleich ist.
 */
let reduceMotionValue = false;
let reduceMotionWatched = false;
const reduceMotionSubs = new Set<() => void>();

function publishReduceMotion(v: boolean): void {
  if (v === reduceMotionValue) return;
  reduceMotionValue = v;
  for (const notify of reduceMotionSubs) notify();
}

function watchReduceMotion(): void {
  if (reduceMotionWatched) return;
  reduceMotionWatched = true;
  void AccessibilityInfo.isReduceMotionEnabled().then(publishReduceMotion);
  AccessibilityInfo.addEventListener("reduceMotionChanged", publishReduceMotion);
}

function subscribeReduceMotion(notify: () => void): () => void {
  reduceMotionSubs.add(notify);
  return () => {
    reduceMotionSubs.delete(notify);
  };
}

export function useReduceMotion(): boolean {
  watchReduceMotion();
  return useSyncExternalStore(subscribeReduceMotion, () => reduceMotionValue);
}

/**
 * Zählt hoch, sobald der Screen den Fokus BEKOMMT.
 *
 * Warum nicht einfach Reanimateds `entering`: Das feuert nur beim MOUNT. Die
 * Tabs bleiben aber gemountet (nur die Karte friert ein, siehe die
 * Freeze-Strategie in app/(tabs)/_layout.tsx) — beim Tab-Wechsel würde also nie
 * etwas animieren. Und die Views nur für die Animation zu remounten wäre teuer
 * und genau die Sorte Commit, die den Tab-Wechsel ruckeln lässt.
 *
 * Stattdessen bleiben die Views IMMER gemountet und wir triggern die Animation
 * über einen Shared Value neu. (Klassisches RN-Animated bleibt hier auf der New
 * Architecture am Startwert hängen — deshalb reanimated.)
 */
/**
 * Wann zwei Tab-Wechsel als „schnelles Durchklicken" gelten.
 *
 * Modulweit (nicht pro Screen), weil die Frage lautet: Wie lange ist der LETZTE
 * Wechsel her — egal von welchem Tab zu welchem.
 */
const RAPID_NAV_MS = 600;
let lastTabPressAt = 0;
let rapidNav = false;

/**
 * Wird vom Tab-Navigator bei JEDEM Tab-Tipp gerufen (siehe app/(tabs)/_layout.tsx).
 *
 * Warum nicht mehr aus dem Fokus-Effekt heraus: Der Zeitstempel wurde vorher nur
 * von `ScreenEntrance` gesetzt — und der Surroundings-Tab hat gar keine
 * `ScreenEntrance`. Die Kette Home → Surroundings → Saved sah deshalb aus wie
 * EIN Wechsel über die doppelte Zeit und galt fälschlich als „langsam": Die
 * volle Welle lief los, genau im schnellen Durchklicken, das sie vermeiden
 * sollte. Der Navigator sieht dagegen jeden Tipp.
 */
export function noteTabPress(): void {
  const now = Date.now();
  rapidNav = lastTabPressAt !== 0 && now - lastTabPressAt < RAPID_NAV_MS;
  lastTabPressAt = now;
}

/**
 * Einmalige Sperre für die NÄCHSTE Einblend-Welle.
 *
 * Gedacht für Screens, die man aus einem Zwischenzustand heraus verlässt — etwa
 * den Ergebnis-Screen, solange die Suche noch läuft. Dort ist das Zurückgehen ein
 * Abbruch, und der Landingscreen soll einfach wieder dastehen, statt sich noch
 * einmal aufzubauen. Kommt man dagegen normal von den fertigen Ergebnissen
 * zurück, läuft die Welle wie gewohnt.
 *
 * Die Sperre verfällt von selbst: Greift sie nicht innerhalb von SKIP_VALID_MS
 * (weil doch kein Fokus-Wechsel folgte), gilt sie nicht mehr — sonst würde sie
 * irgendwann eine völlig unbeteiligte Welle verschlucken.
 */
const SKIP_VALID_MS = 1200;
let skipEntranceUntil = 0;

export function skipNextScreenEntrance(): void {
  skipEntranceUntil = Date.now() + SKIP_VALID_MS;
}

/** Prüft die Sperre und verbraucht sie dabei. */
function consumeSkipEntrance(): boolean {
  const active = Date.now() < skipEntranceUntil;
  skipEntranceUntil = 0;
  return active;
}

/** true = der Nutzer klickt gerade schnell durch die Tabs. */
export function isRapidNav(): boolean {
  // Zusätzlich die Frische prüfen: Sonst würde ein alter `true`-Stand noch für
  // Screens gelten, die gar nicht über die Tab-Leiste kommen (Bo, Suche).
  return rapidNav && Date.now() - lastTabPressAt < RAPID_NAV_MS;
}

/**
 * Wie lange der letzte Tab-Tipp her ist. Damit können schwere, aufschiebbare
 * Commits (z.B. das Einfrieren der Karte) sich aus dem Wechsel-Frame
 * heraushalten, statt blind auf einen festen Timer zu setzen.
 */
export function msSinceTabPress(): number {
  return lastTabPressAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastTabPressAt;
}

interface Entrance {
  /**
   * true = Inhalt SOFORT vollständig zeigen, ohne Welle.
   *
   * Beim schnellen Durchklicken durch die Tabs überlagern sich der native
   * Crossfade und die noch laufende Einblend-Welle: Der neue Tab ist noch
   * halbdurchsichtig, während der Crossfade läuft → man sieht den ALTEN Tab
   * durchscheinen. Deshalb: Kommt ein Fokus-Wechsel < RAPID_NAV_MS nach dem
   * vorigen, ist der Inhalt sofort da (nichts fadet) — der Crossfade zeigt dann
   * fertige Inhalte statt halbleerer Screens. Beim normalen (langsamen) Wechsel
   * läuft die Welle unverändert.
   */
  instant: boolean;
  /** Zählt bei jedem Fokus hoch → die Welle läuft neu. */
  generation: number;
  /** Wann der Fokus kam. Daran erkennt ein Element, ob es zur Welle gehört oder
   *  lange danach nachgewachsen ist (siehe `waveBase`). */
  focusedAt: number;
  /**
   * Zählt hoch, wenn die laufende Welle SOFORT fertig werden soll.
   *
   * Ausgelöst vom ersten Scroll-Griff (RevealScrollView.onScrollBeginDrag):
   * Wer scrollt, will Inhalt sehen, keine Choreografie — und die noch laufenden
   * Opacity/TranslateY-Animationen plus die Vorhang-Overlays der großen Karten
   * konkurrieren auf dem UI-Thread genau mit diesem Scroll. Das war der Ruckler
   * „Tab wechseln und sofort scrollen". Jedes Reveal springt dann direkt auf
   * fertig; die anstehenden withDelay-Ketten werden durch die Zuweisung
   * abgebrochen.
   */
  finishWave: SharedValue<number>;
  /**
   * false = die Welle ist noch NICHT scharf; Reveals bleiben stumm im
   * Versteckt-Zustand (progress 0), OHNE zu animieren. Nur im manuellen Modus
   * relevant: Der Such-Screen mountet verdeckt VOR der Expansion — ohne diese
   * Sperre liefe die Welle unsichtbar unter dem Splash und wäre vorbei, bevor
   * man den Screen sieht (danach triggert man erneut → alles animiert doppelt).
   * Fokus-getriebene Screens sind immer armed=true.
   */
  armed: boolean;
}

const EntranceContext = createContext<Entrance>({
  generation: 0,
  focusedAt: 0,
  // Modulweiter Default, falls ein Reveal ohne ScreenEntrance läuft.
  finishWave: makeMutable(0),
  armed: true,
  instant: false,
});

export function ScreenEntrance({
  children,
  trigger,
  resetTrigger,
  wave = true,
}: {
  children: ReactNode;
  /**
   * `false` = KEINE Welle. Der Inhalt ist beim Fokus sofort vollständig da.
   *
   * So laufen jetzt Landingscreen, Saved und Profil. Den Übergang trägt allein
   * der native „Fade Through" der Tab-Leiste — und der ist genau das, was
   * Material für Bottom-Navigation vorsieht: Der abgehende Inhalt blendet in
   * 100ms aus, der eingehende blendet über 200ms ein und wächst dabei von 92%
   * auf 100%. Bei 92% (nicht 0%) beginnt die Skalierung ausdrücklich deshalb,
   * damit der Übergang keine übermäßige Aufmerksamkeit auf sich zieht. Auf iOS
   * wechselt ein UITabBarController sogar ganz ohne Animation.
   *
   * Der Inhalt kommt damit als EIN Körper mit Ein- und Ausblenden statt in einer
   * Kaskade. Nichts ploppt, und es fühlt sich sofort an, weil alles gleichzeitig
   * eintrifft.
   *
   * Der Wellen-Code bleibt vollständig erhalten: Zum Zurückschalten genügt es,
   * das Attribut in den drei Screens zu entfernen (Default ist `true`).
   */
  wave?: boolean;
  /**
   * Manueller Wellen-Auslöser für Inhalte, die KEIN Navigations-Screen sind
   * (z.B. der Such-Screen im Launch-Overlay): Bei jeder Änderung dieses Werts
   * läuft die Welle neu. Ist er gesetzt, wird der Fokus ignoriert — sonst
   * würde die Welle schon beim (unsichtbaren) Mount hinter dem Splash laufen
   * und wäre vorbei, bevor der Nutzer den Screen überhaupt sieht.
   */
  trigger?: number;
  /**
   * ENTWAFFNEN: Bei jeder Änderung springen alle Reveals sofort zurück in den
   * Versteckt-Zustand — ohne Animation.
   *
   * Nötig für Screens, die DAUERHAFT gemountet bleiben (Such-Overlay): Ohne das
   * stünde beim nächsten Öffnen noch der fertig eingeblendete Stand von letztem
   * Mal. Der Reveal würde ihn dann erst sichtbar zurücksetzen und neu einblenden
   * — genau das flackert. Also einmal beim Launch-START entwaffnen, solange der
   * Screen noch unsichtbar ist; `trigger` schärft danach wieder und animiert.
   */
  resetTrigger?: number;
}) {
  const focused = useIsFocused();
  const finishWave = useSharedValue(0);
  const manual = trigger !== undefined;
  const firstManual = useRef(true);
  const [entrance, setEntrance] = useState<Entrance>(() => ({
    generation: 0,
    focusedAt: Date.now(),
    finishWave,
    // Manuell: erst stumm (nicht scharf). Fokus-getrieben: sofort scharf.
    armed: !manual,
    // Ohne Welle schon beim ERSTEN Render vollständig da — sonst blitzte der
    // Inhalt beim App-Start einmal versteckt auf, bevor der Effekt greift.
    instant: !wave,
  }));
  useEffect(() => {
    if (manual || !focused) return;
    // Schnelles Durchklicken erkennen (siehe `instant` im Interface): Der
    // Zeitstempel kommt jetzt vom Navigator (`noteTabPress`), nicht mehr von
    // hier — sonst zählen Tabs ohne ScreenEntrance nicht mit und die Erkennung
    // greift ausgerechnet in den Ketten nicht, um die es geht.
    setEntrance((e) => ({
      generation: e.generation + 1,
      focusedAt: Date.now(),
      finishWave,
      armed: true,
      // Sperre hat Vorrang: Wer aus einem laufenden Ladevorgang zurückkommt,
      // soll den Screen einfach vorfinden (siehe skipNextScreenEntrance).
      // wave={false} → gar keine Welle (siehe dort). `instant` ist genau der
      // Zustand „alles sofort vollständig da", den es dafür schon gibt.
      instant: !wave || consumeSkipEntrance() || isRapidNav(),
    }));
  }, [focused, finishWave, manual, wave]);
  useEffect(() => {
    if (!manual) return;
    // Den Mount-Lauf überspringen: der Effect feuert auch beim ersten Render,
    // aber DA soll die Welle noch nicht laufen (Screen ist verdeckt). Erst der
    // echte Trigger-Wechsel (nach dem Reveal) schaltet scharf.
    if (firstManual.current) {
      firstManual.current = false;
      return;
    }
    setEntrance((e) => ({
      generation: e.generation + 1,
      focusedAt: Date.now(),
      finishWave,
      armed: true,
      // `wave` gilt AUCH im manuellen Modus.
      //
      // Hier stand fest `false` mit der Begründung „beim manuellen Trigger ist
      // die Welle bewusst gewollt". Damit war `wave={false}` am Such-Screen
      // wirkungslos: Das Attribut wird nur im Anfangszustand und im Fokus-Zweig
      // gelesen, nie hier — und der Such-Screen ist der EINZIGE Ort mit
      // manuellem Trigger. Der Kommentar dort („Der Inhalt ist sofort
      // vollständig da und fährt als EIN Körper mit dem Blatt herein")
      // beschrieb also einen Zustand, der nie eintrat: Die Welle lief mitten in
      // der Bewegung, mit fünf zusätzlich bewegten Ansichten.
      instant: !wave,
    }));
  }, [trigger, finishWave, manual, wave]);
  // Entwaffnen (siehe resetTrigger oben): Reveals sofort auf versteckt, ohne
  // Animation. Der erste Lauf wird übersprungen — beim Mount ist ohnehin nichts
  // eingeblendet.
  const firstReset = useRef(true);
  useEffect(() => {
    if (resetTrigger === undefined) return;
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setEntrance((e) => (e.armed ? { ...e, armed: false } : e));
  }, [resetTrigger]);
  return <EntranceContext.Provider value={entrance}>{children}</EntranceContext.Provider>;
}

/**
 * Ab wann ein Mount nicht mehr zur Screen-Welle gehört.
 *
 * Länger als die Welle selbst dauert, kürzer als jede plausible Nutzer-Aktion
 * danach.
 */
const LATE_MOUNT_MS = 400;

interface RevealProps {
  children: ReactNode;
  /** Position in der Welle. 0 = zuerst. */
  index?: number;
  /**
   * Nur für Elemente, die auch NACHTRÄGLICH entstehen können (Kategorie-Wechsel
   * auf Home): der Index, bei dem ihre Gruppe beginnt.
   *
   * Beim Betreten des Screens zählt `index` — die Karten kommen nach Überschrift
   * und Kategorie-Auswahl. Wechselt man später die Kategorie, mounten sie neu,
   * ohne dass eine Welle vor ihnen läuft: Dann wäre `index` eine Wartezeit auf
   * nichts (auf Home: 450 ms Stillstand, dann alles auf einmal). Deshalb zählt
   * dort nur die Position INNERHALB der Gruppe.
   */
  waveBase?: number;
  /**
   * Hintergrundfarbe → statt die View durchsichtig zu machen, blendet ein
   * VORHANG in dieser Farbe darüber aus.
   *
   * Für große Bild-Karten. Ein `opacity`-Fade zwingt Android, pro Frame einen
   * Offscreen-Buffer in Kartengröße zu füllen (sonst komponiert es die
   * überlagerten halbtransparenten Kinder falsch, siehe unten) — bei einer fast
   * bildschirmhohen Karte ist das der teuerste Posten der ganzen Welle und
   * genau das, was als Ruckeln ankam.
   *
   * Mit Vorhang bleibt die Karte durchgehend opak: kein Alpha, kein
   * Offscreen-Buffer, und der Tiefen-Verlauf stimmt von der ersten Millisekunde
   * an. Sichtbar ist dasselbe — vorausgesetzt, dahinter liegt wirklich diese
   * Farbe.
   */
  scrim?: string;
  /** Große Fläche → mehr Zeit (siehe MOTION.durationLarge). */
  large?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Blendet sein Kind gestaffelt ein: 12 px hochgleiten + aufblenden, versetzt um
 * `index × 60 ms`.
 *
 * Muss unter einem {@link ScreenEntrance} hängen — dann läuft die Welle bei
 * JEDEM Fokus des Screens neu, nicht nur beim ersten Mount.
 */
export function Reveal({
  children,
  index = 0,
  waveBase = 0,
  scrim,
  large = false,
  style,
}: RevealProps) {
  const { generation, focusedAt, finishWave, armed, instant } = useContext(EntranceContext);
  const reduceMotion = useReduceMotion();
  const progress = useSharedValue(0);

  // Hier stand eine Reaktion auf `finishWave` („Scroll-Griff → Welle sofort
  // fertig"). Hochgezählt wurde dieser Wert einzig von `RevealScrollView` — und
  // die Komponente wird nirgends mehr verwendet, seit die Wellen aus den Tabs
  // raus sind. Die Reaktion horchte also auf einen Wert, der sich nie ändert:
  // ein Mapper pro Reveal auf dem UI-Thread, dauerhaft, für nichts. Im
  // Such-Screen sind das fünf Stück, die während des Öffnens mitlaufen.

  useEffect(() => {
    // reduceMotion: Systemeinstellung. instant: schnelles Tab-Durchklicken →
    // Inhalt sofort vollständig da, keine Welle (sonst sieht man während des
    // Crossfades den alten Tab durch den halbdurchsichtigen neuen).
    if (reduceMotion || instant) {
      progress.value = 1;
      return;
    }
    // Noch nicht scharf (manueller Modus, Screen verdeckt) → stumm im
    // Versteckt-Zustand bleiben, NICHT animieren. Erst der Trigger schaltet
    // scharf und lässt die Welle einmal sauber laufen.
    if (!armed) {
      progress.value = 0;
      return;
    }
    // Nachgewachsen statt mitgekommen → keine Welle davor, also auch kein
    // Vorlauf, auf den zu warten wäre.
    const late = Date.now() - focusedAt > LATE_MOUNT_MS;
    const step = late ? index - waveBase : index;

    // Das erste Element der Welle läuft kürzer (siehe MOTION.lead) — es trägt
    // den Eindruck „sofort da". Alles dahinter behält die gewohnte Kurve.
    const duration =
      step <= 0 ? MOTION.lead : large ? MOTION.durationLarge : MOTION.duration;

    progress.value = 0;
    progress.value = withDelay(
      staggerDelay(step),
      withTiming(1, { duration, easing: MOTION.easing }),
    );
  }, [generation, focusedAt, index, waveBase, large, reduceMotion, armed, instant, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    // Mit Vorhang bleibt die View selbst opak — der Vorhang erledigt das Faden.
    const opacity = scrim ? 1 : progress.value;
    // GROSSE Flächen (die bildschirmhohen Bild-Karten) bewegen sich GAR NICHT:
    // Sie sind gerundet + `overflow: hidden` (Android clipToOutline), und ein
    // gerundeter Clip rendert unter einem Ancestor-Transform fehlerhaft — das
    // waren die flackernden Ecken UND das ruckelige Hochgleiten. Ohne transform
    // gibt es keinen Ancestor-Transform: Der Clip stimmt, und die Karte blendet
    // über den Vorhang sauber ein (das Einblenden allein trägt die Welle).
    // Kleine Elemente (Chips, Zeilen) haben keinen solchen Clip → sie gleiten
    // weiter, das ist der spürbare Teil der Welle.
    if (large) return { opacity };
    return {
      opacity,
      transform: [{ translateY: (1 - progress.value) * MOTION.rise }],
    };
  });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));

  return (
    // KEIN needsOffscreenAlphaCompositing (mehr).
    //
    // Es stand hier, weil Android beim Faden sonst JEDES KIND EINZELN mit dem
    // Alpha zeichnet, statt die View fertig zu komponieren — bei den
    // Destination-Karten dimmte der Verlauf getrennt vom Bild und sprang am Ende
    // rein. Das Flag behebt das, indem Android einen Offscreen-Buffer in
    // VIEW-GRÖSSE anlegt, solange alpha != 1.
    //
    // Genau das kostete dann aber: In Saved hängt es an jeder ResultCard, und der
    // Tab-Wechsel bekam spürbaren Input-Lag. Der Vorhang unten löst dasselbe
    // Problem, ohne dass die View je durchsichtig wird — also ohne Buffer. Wer
    // überlagerte halbtransparente Kinder hat, nimmt `scrim`; alle anderen
    // brauchen weder das eine noch das andere.
    <Animated.View style={[style, animatedStyle]}>
      {children}
      {scrim ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: scrim }, scrimStyle]}
        />
      ) : null}
    </Animated.View>
  );
}

/**
 * Dieselbe Welle für Listen, die FRISCH mounten (Ergebnis-Screen).
 *
 * Dort ist Reanimateds `entering` genau richtig — die Liste entsteht neu, wir
 * brauchen keinen Fokus-Trigger. Wichtig ist nur, dass sie dasselbe Timing und
 * denselben kurzen Weg benutzt wie {@link Reveal}, sonst fühlt sich der
 * Ergebnis-Screen an wie eine andere App.
 *
 * `ReduceMotion.System`: Wer „Bewegung reduzieren" gesetzt hat, bekommt die
 * Elemente sofort.
 */
export function revealEntering(index: number) {
  return FadeInDown.delay(staggerDelay(index))
    .duration(index <= 0 ? MOTION.lead : MOTION.duration)
    .easing(MOTION.easing)
    .withInitialValues({ opacity: 0, transform: [{ translateY: MOTION.rise }] })
    .reduceMotion(ReduceMotion.System);
}

// ---------------------------------------------------------------------------
// Beim Scrollen einblenden
// ---------------------------------------------------------------------------

/**
 * ScrollView, unter der {@link ScrollReveal} läuft.
 *
 * Hier hing mal eine Sichtbarkeitsprüfung dran (Scroll-Position + gemessene
 * Element-Position), damit Elemente erst einblenden, wenn man sie hereinscrollt.
 * Das ist DREIMAL schiefgegangen:
 *
 *   1. Reanimateds `measure()` im Worklet → App-Absturz („Value is null,
 *      expected an Object"), sobald die native View noch nicht im Baum hängt.
 *   2. `measureInWindow` auf der Animated.View → deren Ref ist die
 *      Wrapper-Instanz, die Methode gibt es dort nicht. Der Optional-Chain lief
 *      still ins Leere: JEDER TAB LEER.
 *   3. Mit Notausstiegs-Timer → Tab kam eine Sekunde leer herein und alles
 *      erschien dann auf einmal, statt in der Welle.
 *
 * Der gemeinsame Nenner ist die imperative Messung. Sie kann fehlschlagen, und
 * wenn sie fehlschlägt, sieht der User einen LEEREN SCREEN — der schlechteste
 * mögliche Ausgang für eine Verschönerung. Deshalb ist sie raus: Die Welle
 * hängt jetzt an nichts mehr außer dem Fokus und dem Index, und kann damit
 * nichts mehr verstecken.
 *
 * Bleibt als Komponente erhalten, damit die Screens nichts davon mitkriegen —
 * und als Ort, an dem ein Einblenden-beim-Scrollen später wieder andocken kann,
 * dann aber additiv (nie unsichtbar als Ausgangszustand).
 */
export function RevealScrollView({
  children,
  onScrollBeginDrag,
  ...props
}: React.ComponentProps<typeof Animated.ScrollView>) {
  const { finishWave } = useContext(EntranceContext);
  return (
    <Animated.ScrollView
      {...props}
      onScrollBeginDrag={(e) => {
        // Wer scrollt, will Inhalt sehen — die Welle sofort beenden, damit die
        // laufenden Animationen nicht mit dem Scroll um den UI-Thread kämpfen.
        finishWave.value = finishWave.value + 1;
        // Der Prop-Typ erlaubt auch SharedValue-Handler (useAnimatedScrollHandler);
        // durchreichen können wir nur normale Funktionen — mehr nutzt hier keiner.
        if (typeof onScrollBeginDrag === "function") onScrollBeginDrag(e);
      }}
    >
      {children}
    </Animated.ScrollView>
  );
}

/**
 * Ein Element der Welle. Verhält sich exakt wie {@link Reveal} — der eigene Name
 * bleibt, weil die Screens ihn benutzen und weil hier später das Einblenden beim
 * Scrollen wieder andocken soll.
 */
export function ScrollReveal({
  children,
  index = 0,
  waveBase = 0,
  scrim,
  large = false,
  style,
}: RevealProps) {
  return (
    <Reveal index={index} waveBase={waveBase} scrim={scrim} large={large} style={style}>
      {children}
    </Reveal>
  );
}



/**
 * Der Druck-Effekt der Kategorie-Kacheln, zum Weiterverwenden.
 *
 * Die Werte stammen aus `app/(tabs)/index.tsx` und sind dort begründet:
 * Interaktive Elemente brauchen sofortige Rückmeldung, also hohe Steifigkeit
 * beim Hineindrücken — das Zurückfedern darf weicher sein und schwingt dadurch
 * spürbar nach. Sie stehen hier, damit ein zweiter Knopf sich nicht „ungefähr
 * so" anfühlt, sondern gleich.
 */
export const PRESS_SCALE = 0.93;
export const PRESS_IN = { damping: 18, stiffness: 320, mass: 0.7 } as const;
export const PRESS_OUT = { damping: 15, stiffness: 200, mass: 0.8 } as const;

/**
 * Liefert Stil und Handler für den Druck-Effekt.
 *
 * Wer sie benutzt, muss `onPressIn`/`onPressOut` durchreichen — bei einem
 * eigenen Handler beides aufrufen.
 *
 * `scale` ist übersteuerbar, weil dieselbe Zahl auf verschieden großen Flächen
 * verschieden stark WIRKT: 7% Weg sind auf einer bildschirmbreiten Kachel gut
 * sichtbar, auf einem 26px-Symbol kaum. Kleine Elemente brauchen mehr.
 */
export function usePressBounce(scale: number = PRESS_SCALE) {
  const press = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  const onPressIn = () => {
    press.value = withSpring(scale, PRESS_IN);
  };
  const onPressOut = () => {
    press.value = withSpring(1, PRESS_OUT);
  };
  /**
   * Sofort auf Endstand, ohne Nachfedern.
   *
   * Für Knöpfe, die einen bildschirmfüllenden Übergang auslösen. `PRESS_OUT`
   * ist mit einem Dämpfungsgrad von rund 0,59 unterdämpft und schwingt etwa
   * 430ms nach — fast die gesamte Dauer einer Slide. Liegt der Knopf dabei auf
   * einer Fläche, die als GPU-Textur eingefroren wurde (und das ist bei einem
   * Übergang der Normalfall), macht diese Feder die Textur in JEDEM Bild
   * ungültig: Eine Ebene mit sich änderndem Inhalt muss neu gerastert werden,
   * spart also nicht nur nichts, sondern kostet zusätzlich.
   *
   * Das Hineindrücken bleibt sichtbar — es läuft, solange der Finger liegt. Nur
   * das Nachschwingen entfällt, und das sieht ohnehin niemand mehr, sobald der
   * Bildschirm wegfährt.
   */
  const settle = () => {
    cancelAnimation(press);
    press.value = 1;
  };
  return { style, onPressIn, onPressOut, settle };
}
