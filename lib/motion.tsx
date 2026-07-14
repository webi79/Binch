import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
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
  /** Weg nach oben. Klein halten — Elemente sollen sich SETZEN, nicht
   *  hereinfliegen. */
  rise: 10,
  /** Erste Fassung lief mit 360 ms und wirkte gehetzt. „Smooth" heißt hier vor
   *  allem: Zeit lassen. 550 ms ist noch weit unter der Schwelle, ab der
   *  Bewegung als Warten empfunden wird (Kontextwechsel dürfen 600-800 ms). */
  duration: 550,
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
  durationLarge: 780,
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
 * Systemeinstellung „Bewegung reduzieren".
 *
 * Wer sie gesetzt hat, tut das meist wegen Schwindel oder Migräne — für den ist
 * eine Kaskade keine Verspieltheit, sondern ein Problem. Dann erscheint alles
 * sofort, ohne Bewegung.
 */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => {
      if (alive) setReduce(v);
    });
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
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
interface Entrance {
  /** Zählt bei jedem Fokus hoch → die Welle läuft neu. */
  generation: number;
  /** Wann der Fokus kam. Daran erkennt ein Element, ob es zur Welle gehört oder
   *  lange danach nachgewachsen ist (siehe `waveBase`). */
  focusedAt: number;
}

const EntranceContext = createContext<Entrance>({ generation: 0, focusedAt: 0 });

export function ScreenEntrance({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [entrance, setEntrance] = useState<Entrance>(() => ({
    generation: 0,
    focusedAt: Date.now(),
  }));
  useEffect(() => {
    if (focused) {
      setEntrance((e) => ({ generation: e.generation + 1, focusedAt: Date.now() }));
    }
  }, [focused]);
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
  const { generation, focusedAt } = useContext(EntranceContext);
  const reduceMotion = useReduceMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    // Nachgewachsen statt mitgekommen → keine Welle davor, also auch kein
    // Vorlauf, auf den zu warten wäre.
    const late = Date.now() - focusedAt > LATE_MOUNT_MS;
    const step = late ? index - waveBase : index;

    progress.value = 0;
    progress.value = withDelay(
      staggerDelay(step),
      withTiming(1, {
        duration: large ? MOTION.durationLarge : MOTION.duration,
        easing: MOTION.easing,
      }),
    );
  }, [generation, focusedAt, index, waveBase, large, reduceMotion, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    // Mit Vorhang bleibt die View selbst opak — der Vorhang erledigt das Faden.
    opacity: scrim ? 1 : progress.value,
    transform: [{ translateY: (1 - progress.value) * MOTION.rise }],
  }));

  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }));

  return (
    // needsOffscreenAlphaCompositing: React Native schaltet korrektes
    // Alpha-Compositing auf Android AB (ReactViewGroup.hasOverlappingRendering()
    // liefert per Default false — aus Performance-Gründen). Ohne das Flag zeichnet
    // Android beim Faden JEDES KIND EINZELN mit dem aktuellen Alpha, statt die
    // Karte erst fertig zu komponieren und dann als Ganzes zu faden.
    //
    // Sichtbar wird das überall dort, wo sich halbtransparente Kinder
    // überlagern — bei den Destination-Karten liegt ein schwarzer Verlauf über
    // dem Bild. Der wurde während des Fades getrennt vom Bild gedimmt und
    // komponierte erst bei opacity 1 wieder richtig: Der Tiefeneffekt „sprang"
    // am Ende rein, statt mit der Karte zu kommen.
    //
    // Kostet nur WÄHREND des Fades einen Offscreen-Buffer: Android legt ihn nur
    // an, wenn alpha != 1. Kein dauerhafter Hardware-Layer (der hat an anderer
    // Stelle schon mal 66 ms Record-View#draw gekostet, siehe Saved-Parallax).
    <Animated.View
      needsOffscreenAlphaCompositing={!scrim}
      style={[style, animatedStyle]}
    >
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
    .duration(MOTION.duration)
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
  ...props
}: React.ComponentProps<typeof Animated.ScrollView>) {
  return (
    <Animated.ScrollView {...props}>
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
