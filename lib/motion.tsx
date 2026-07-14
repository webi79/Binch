import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccessibilityInfo, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  measure,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
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
  /** Weg nach oben. Klein halten — Elemente sollen sich SETZEN, nicht
   *  hereinfliegen. */
  rise: 10,
  /** Erste Fassung lief mit 360 ms und wirkte gehetzt. „Smooth" heißt hier vor
   *  allem: Zeit lassen. 550 ms ist noch weit unter der Schwelle, ab der
   *  Bewegung als Warten empfunden wird (Kontextwechsel dürfen 600-800 ms). */
  duration: 550,
  /** Versatz je Element. Größer = die Welle ist deutlicher lesbar. */
  stagger: 90,
  /** Ab hier kein weiterer Versatz — sonst wartet das 20. Element ewig. */
  maxSteps: 5,
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
  "worklet";
  return Math.min(Math.max(index, 0), MOTION.maxSteps) * MOTION.stagger;
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
const EntranceContext = createContext(0);

export function ScreenEntrance({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (focused) setGeneration((g) => g + 1);
  }, [focused]);
  return <EntranceContext.Provider value={generation}>{children}</EntranceContext.Provider>;
}

interface RevealProps {
  children: ReactNode;
  /** Position in der Welle. 0 = zuerst. */
  index?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Blendet sein Kind gestaffelt ein: 12 px hochgleiten + aufblenden, versetzt um
 * `index × 60 ms`.
 *
 * Muss unter einem {@link ScreenEntrance} hängen — dann läuft die Welle bei
 * JEDEM Fokus des Screens neu, nicht nur beim ersten Mount.
 */
export function Reveal({ children, index = 0, style }: RevealProps) {
  const generation = useContext(EntranceContext);
  const reduceMotion = useReduceMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = 0;
    progress.value = withDelay(
      staggerDelay(index),
      withTiming(1, { duration: MOTION.duration, easing: MOTION.easing }),
    );
  }, [generation, index, reduceMotion, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * MOTION.rise }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
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
 * Vorlauf: Ein Element blendet ein, sobald seine Oberkante 48 px VOR der unteren
 * Bildschirmkante liegt. Ohne diesen Vorlauf sieht man es aufblenden, während es
 * schon halb im Bild ist — das wirkt wie Nachladen, nicht wie Bewegung.
 */
const REVEAL_MARGIN = 48;

interface ScrollRevealCtx {
  /** Treibt die Neubewertung — bei jedem Scroll-Frame. */
  scrollY: SharedValue<number>;
  /** Untere Bildschirmkante. */
  windowHeight: number;
  generation: number;
}

const ScrollRevealContext = createContext<ScrollRevealCtx | null>(null);

/**
 * ScrollView, die ihre Kinder beim Hereinscrollen einblenden lässt.
 *
 * Zwei Fälle, EIN Verhalten:
 *   - Beim Öffnen des Tabs blenden die SICHTBAREN Elemente gestaffelt ein (die
 *     Welle).
 *   - Alles darunter blendet einzeln ein, sobald man es hereinscrollt — dann
 *     aber OHNE Versatz. Ein Element, das man gerade ins Bild schiebt, soll
 *     sofort reagieren; ein Versatz läse sich dort als Verzögerung.
 */
export function RevealScrollView({
  children,
  ...props
}: React.ComponentProps<typeof Animated.ScrollView>) {
  const generation = useContext(EntranceContext);
  const { height: windowHeight } = useWindowDimensions();
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  const ctx = useMemo(
    () => ({ scrollY, windowHeight, generation }),
    [scrollY, windowHeight, generation],
  );

  return (
    <ScrollRevealContext.Provider value={ctx}>
      <Animated.ScrollView {...props} onScroll={onScroll} scrollEventThrottle={16}>
        {children}
      </Animated.ScrollView>
    </ScrollRevealContext.Provider>
  );
}

/**
 * Ein Element, das einblendet, sobald es ins Bild kommt — und beim Öffnen des
 * Screens als Teil der Welle.
 *
 * Einmal eingeblendet bleibt es sichtbar. Beim Zurückscrollen wieder
 * auszublenden wäre nervig: Man hat es ja schon gesehen.
 *
 * Ohne umgebende {@link RevealScrollView} verhält es sich wie {@link Reveal}.
 */
export function ScrollReveal({ children, index = 0, style }: RevealProps) {
  const ctx = useContext(ScrollRevealContext);
  const generation = useContext(EntranceContext);
  const reduceMotion = useReduceMotion();
  const ref = useAnimatedRef<Animated.View>();
  const progress = useSharedValue(0);
  /** Stößt die Sichtbarkeitsprüfung einmal an, ohne dass gescrollt wurde. */
  const pulse = useSharedValue(0);
  /** Erst wenn onLayout gefeuert hat, existiert die native View — vorher reißt
   *  measure() die App um. */
  const laidOut = useSharedValue(false);
  /**
   * Wartet dieses Element noch auf SEINE ERSTE Prüfung?
   *
   * Daran hängt, ob es Teil der Welle ist: War es beim Erscheinen des Screens
   * schon im Bild, bekommt es den Versatz seiner Position. Kommt es erst durch
   * Scrollen herein, blendet es SOFORT ein — ein Element, das man gerade ins
   * Bild schiebt, soll reagieren; ein Versatz läse sich dort als Verzögerung.
   *
   * Das ist auch der Grund, warum das kein Zeitfenster ist: Beim
   * Kategorie-Wechsel entstehen die Karten neu, sind sofort im Bild — und sollen
   * dann ebenfalls kaskadieren, egal wie lange der Fokus schon her ist.
   */
  const pending = useSharedValue(true);

  // Neuer Fokus → Welle von vorn. Und einen Frame später prüfen: Ohne diesen
  // Anstoß liefe die Prüfung NUR beim Scrollen — beim Öffnen des Screens bliebe
  // alles unsichtbar. Ein Frame Verzögerung, damit das Layout steht (vorher
  // misst measure() ins Leere).
  useEffect(() => {
    progress.value = reduceMotion ? 1 : 0;
    pending.value = true;
    const id = requestAnimationFrame(() => {
      pulse.value = pulse.value + 1;
    });
    return () => cancelAnimationFrame(id);
  }, [generation, reduceMotion, progress, pulse, pending]);

  // measure() statt onLayout: onLayout liefert die Position relativ zum
  // ELTERNELEMENT. Eine Karte, die in einer Sektion steckt, meldete damit eine
  // Position nahe 0 und würde sofort einblenden, egal wo sie auf dem Schirm
  // steht. measure() gibt die echte Bildschirmposition (pageY).
  //
  // ABER: measure() STÜRZT AB, wenn die View noch nicht im nativen Baum hängt —
  // nicht „gibt null zurück", sondern reißt die App mit einer C++-Exception um
  // („Value is null, expected an Object"). Ich hatte angenommen, ein Frame
  // Verzögerung (requestAnimationFrame) reiche aus. Beim App-Start reicht es
  // nicht.
  //
  // Zwei Sicherungen:
  //   1. Gemessen wird erst, wenn onLayout gefeuert hat — dann existiert die
  //      native View garantiert. Das onLayout stößt die Prüfung auch gleich an.
  //   2. try/catch drumherum. Ein fehlgeschlagenes Messen darf höchstens
  //      bedeuten, dass ein Element sichtbar bleibt — niemals, dass die App
  //      abstürzt.
  useAnimatedReaction(
    () => (ctx ? ctx.scrollY.value : 0) + pulse.value,
    () => {
      if (reduceMotion || progress.value !== 0) return;

      const reveal = (delay: number) => {
        progress.value = withDelay(
          delay,
          withTiming(1, { duration: MOTION.duration, easing: MOTION.easing }),
        );
      };

      if (!ctx) {
        // Keine RevealScrollView drumherum → verhält sich wie Reveal.
        reveal(staggerDelay(index));
        return;
      }
      if (!laidOut.value) return;

      let m: ReturnType<typeof measure> = null;
      try {
        m = measure(ref);
      } catch {
        // View (noch) nicht messbar → lieber sichtbar machen als hängen lassen.
        reveal(0);
        return;
      }
      if (!m) return;

      // Noch unterhalb des Bildschirms → warten. Aber merken, dass die erste
      // Prüfung gelaufen ist: Wenn es später hereingescrollt wird, gehört es
      // NICHT mehr zur Welle.
      if (m.pageY >= ctx.windowHeight - REVEAL_MARGIN) {
        pending.value = false;
        return;
      }

      const delay = pending.value ? staggerDelay(index) : 0;
      pending.value = false;
      reveal(delay);
    },
    [index, reduceMotion, ctx],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * MOTION.rise }],
  }));

  return (
    <Animated.View
      ref={ref}
      style={[style, animatedStyle]}
      onLayout={() => {
        laidOut.value = true;
        pulse.value = pulse.value + 1;
      }}
    >
      {children}
    </Animated.View>
  );
}
