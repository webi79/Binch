import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type WithTimingConfig,
} from "react-native-reanimated";
import { useT } from "@/lib/i18n/useT";
import { useReduceMotion } from "@/lib/motion";
import { fs } from "@/lib/ui/compact";
import { useLandingPause } from "@/components/home/landingPause";

/**
 * Der Platzhalter der Landingscreen-Suchleiste — als wechselnde Sprüche.
 *
 * Der aktuelle Satz fliegt nach oben hinaus und blendet aus, der nächste kommt
 * leicht versetzt von unten an dieselbe Stelle. Alles daran ist so gebaut, dass
 * es auf dem meistgesehenen Bildschirm der App nichts kostet:
 *
 *  - ZWEI Ebenen, beide immer gemountet, im Wechsel. Bewegt werden nur
 *    Verschiebung und Deckkraft, auf dem UI-Strang. Die Ebenen ändern dabei
 *    nur Eigenschaften ihres Zeichenknotens; die Leiste und der Bildschirm
 *    darunter werden nicht neu aufgezeichnet.
 *  - Der einzige React-Durchlauf ist das Nachladen des nächsten Satzes in die
 *    gerade unsichtbare Ebene — in DIESER Komponente, nie in der Leiste oder im
 *    Landingscreen, und nie während einer Bewegung. Ein Commit mitten in einer
 *    Kurve schriebe Reanimateds Werte ein, zwei Bilder zu spät zurück (siehe
 *    `ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` in package.json).
 *  - Gesteuert über Modul-Werte, Rückrufe und Referenzen statt über Zustände:
 *    Fokus, App im Hintergrund, Überlagerungen, Berührung — nichts davon löst
 *    einen Render aus. Die Bedingungen selbst stehen in `landingPause.ts`;
 *    der kleine Bo neben der Leiste pausiert nach denselben.
 */

/**
 * Die Sätze. Der erste kommt vom Aufrufer (`home.search.placeholder`) und steht
 * nach dem Start immer zuerst; danach mischt `createPicker` alle zusammen.
 *
 * Jeder Satz muss auf einem 360-dp-Gerät in EINE Zeile passen. Die Rechnung:
 * 360 − 2×20 Rand − 2×1,5 Umrandung − 18 − 8 Polster − (18 Lupe + 10 Abstand)
 * − (38 Mikrofon + 10 Abstand) = 215 dp für den Text bei 14 sp. Kein Satz ist
 * breiter als „Wohin möchtest du reisen?" (170 dp in Roboto), der schon immer
 * dort stand — gut 20 % Luft für iOS-Schrift, Herstellerschriften und
 * vergrößerte Systemschrift. Ein größeres Symbol links geht von dieser Luft
 * ab. Auf kurzen Geräten (`UI_SCALE` < 1) schrumpft die Schrift langsamer als
 * die Flächen, der Platz wird dort relativ GRÖSSER.
 *
 * Was trotzdem nicht passt (sehr große Systemschrift), wird zur Laufzeit
 * erkannt und übersprungen — siehe `fits` in der Steuerung.
 *
 * Inhaltlich nur, was die App wirklich kann: Flug, Zug, Bus, Kreuzfahrt,
 * Spracheingabe, Bo als Chat (Tagesplan, Tür-zu-Tür, Abfahrten). Keine Zahlen,
 * keine Preise, keine Ersparnis.
 */
const ROTATING_KEYS = [
  "home.search.rotating.where",
  "home.search.rotating.seaOrMountains",
  "home.search.rotating.modes",
  "home.search.rotating.getaway",
  "home.search.rotating.ifNotNow",
  "home.search.rotating.cityBreak",
  "home.search.rotating.weekend",
  "home.search.rotating.cruise",
  "home.search.rotating.gateway",
  "home.search.rotating.packed",
  "home.search.rotating.adventure",
  "home.search.rotating.seaView",
  "home.search.rotating.boWanderlust",
  "home.search.rotating.boPlan",
  "home.search.rotating.tellBo",
  "home.search.rotating.talk",
  "home.search.rotating.doorToDoor",
  "home.search.rotating.departures",
  "home.search.rotating.dayPlan",
  "home.search.rotating.noBite",
  "home.search.rotating.noLuggage",
  "home.search.rotating.bored",
  "home.search.rotating.boGhost",
  "home.search.rotating.ghost",
] as const;

/** Wie lange ein Satz steht, bevor der nächste kommt. */
const HOLD_MS = 3600;
/** Der erste Satz nach dem Startbild steht etwas länger — er ist die Frage. */
const FIRST_HOLD_MS = 4200;
/** Nach jeder Pause (Tab, Bo, Hintergrund, Berührung): erst ankommen lassen. */
const RESUME_HOLD_MS = 2500;
/** Nachladen des nächsten Satzes — nicht im Bild, in dem die Kurve endet. */
const LOAD_DELAY_MS = 150;
/** Bis Commit, Einhängen und Messung des nachgeladenen Satzes sicher durch sind. */
const SETTLE_MS = 300;
/** Erneuter Versuch, solange woanders etwas fährt. */
const BUSY_RETRY_MS = 500;

interface Motion {
  out: WithTimingConfig;
  in: WithTimingConfig;
  /** Versatz, mit dem der neue Satz dem alten folgt. */
  delay: number;
  /** Weg nach oben bzw. von unten, in dp. */
  travel: number;
  /** Ab welchem Anteil des Weges der alte Satz ganz weg ist … */
  outFade: number;
  /** … und ab welchem der neue zu sehen beginnt. */
  inFade: number;
}

/** Sanft an, sanft aus — der alte Satz soll abheben, nicht wegspringen. */
const EASE_LIFT = Easing.bezier(0.4, 0, 0.6, 1);
/** Kurzer Anlauf (noch unsichtbar), dann langes Ausrollen an seinem Platz. */
const EASE_SETTLE = Easing.bezier(0.2, 0, 0, 1);

/**
 * Der Wechsel mit Bewegung, rund 540 ms.
 *
 * Der alte Satz hebt sanft ab und ist nach etwa 11 dp verschwunden, der neue
 * startet 90 ms später, wird rund 13 dp unter seinem Platz sichtbar und rollt
 * lange aus (durchgerechnet bei 18 dp Weg).
 * Damit stehen nie zwei Sätze lesbar übereinander, und es entsteht trotzdem
 * keine leere Lücke. Der Weg folgt der Schrift (`fs`), auf kleinen Geräten
 * also etwas kürzer — und wird hier auf dem JS-Strang ausgerechnet, weil `fs`
 * im Worklet nicht existiert.
 */
const MOVE: Motion = {
  out: { duration: 420, easing: EASE_LIFT, reduceMotion: ReduceMotion.Never },
  in: { duration: 450, easing: EASE_SETTLE, reduceMotion: ReduceMotion.Never },
  delay: 90,
  travel: fs(18),
  outFade: 0.6,
  inFade: 0.75,
};

/**
 * „Bewegung reduzieren": nur Deckkraft, nacheinander statt übereinander — zwei
 * verschiedene Sätze an exakt derselben Stelle, gleichzeitig halb sichtbar,
 * wären ein unlesbares Gemenge.
 *
 * Deshalb steht in BEIDEN Fassungen `ReduceMotion.Never`: Reanimated würde bei
 * der Systemeinstellung sonst jede Kurve überspringen, auch diese Überblendung,
 * und aus dem Wechsel würde ein harter Schnitt. Was dann gilt, entscheidet die
 * Wahl zwischen `MOVE` und `FADE`.
 */
const FADE: Motion = {
  out: { duration: 260, easing: EASE_LIFT, reduceMotion: ReduceMotion.Never },
  in: { duration: 320, easing: EASE_LIFT, reduceMotion: ReduceMotion.Never },
  delay: 180,
  travel: 0,
  outFade: 1,
  inFade: 1,
};

/**
 * Lage und Deckkraft einer Ebene aus ihrer Stellung: 0 = an ihrem Platz,
 * −1 = oben hinaus, +1 = unten geparkt. Beide Enden sind unsichtbar; der
 * Sprung von oben nach unten vor jedem Einflug sieht deshalb niemand.
 *
 * Als Worklet auf Modulebene — nur Rechnen, keine Funktion vom JS-Strang.
 */
function layerFrame(p: number, travel: number, outFade: number, inFade: number) {
  "worklet";
  const o = p < 0 ? 1 + p / outFade : 1 - p / inFade;
  return {
    opacity: o <= 0 ? 0 : o >= 1 ? 1 : o,
    transform: [{ translateY: p * travel }],
  };
}

/**
 * Zufällige Reihenfolge als gemischter Stapel: Jeder Satz kommt einmal dran,
 * bevor sich einer wiederholt, und beim Neumischen ist der gerade sichtbare
 * ausgenommen — also nie zweimal derselbe hintereinander.
 */
function createPicker(count: number) {
  let bag: number[] = [];
  const tooWide = new Set<number>();
  const refill = (current: number) => {
    bag = [];
    for (let i = 0; i < count; i++) if (i !== current) bag.push(i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = bag[i];
      bag[i] = bag[j];
      bag[j] = swap;
    }
  };
  return {
    /** Nächster Satz, nie `current`. `null`, wenn keiner mehr in die Zeile passt. */
    next(current: number): number | null {
      for (let round = 0; round < 2; round++) {
        while (bag.length > 0) {
          const i = bag.pop() as number;
          if (i !== current && !tooWide.has(i)) return i;
        }
        refill(current);
      }
      return null;
    },
    markTooWide(i: number) {
      tooWide.add(i);
    },
    resetFit() {
      tooWide.clear();
    },
  };
}
type Picker = ReturnType<typeof createPicker>;

export interface RotatingPlaceholderHandle {
  /** Finger liegt auf der Leiste — kein neuer Wechsel, bis er wieder weg ist. */
  hold(): void;
  release(): void;
}

interface Props {
  /** Der erste Satz — bleibt nach dem Start stehen, bis gewechselt wird. */
  firstKey: string;
  /** Schrift und senkrechtes Polster der Zeile, OHNE `flex` — das trägt der Ausschnitt. */
  textStyle: StyleProp<TextStyle>;
  /**
   * Ein neuer Satz steht, und der nächste ist eben nachgeladen (der Commit
   * dafür läuft in den nächsten ein, zwei Bildern). Danach bleibt die Leiste
   * bis zum nächsten Wechsel still, gut drei Sekunden. Der kleine Bo legt seine
   * Momente in dieses Fenster — siehe `MiniBo`.
   */
  onLineShown?: (key: string) => void;
}

interface Lines {
  a: number;
  b: number;
  /** Der Satz im Messfühler — immer der zuletzt nachgeladene. */
  probe: number;
}

interface Api {
  /** Messung neu bewerten (Sprache oder Breite gewechselt). */
  refit(): void;
}

export const RotatingPlaceholder = forwardRef<RotatingPlaceholderHandle, Props>(
  function RotatingPlaceholder({ firstKey, textStyle, onLineShown }, ref) {
    const t = useT();
    const reduceMotion = useReduceMotion();
    /** Wann nichts wechseln darf — gemeinsam mit dem kleinen Bo, siehe dort. */
    const pause = useLandingPause();
    const keys = useMemo(() => [firstKey, ...ROTATING_KEYS], [firstKey]);
    /** Für die Steuerung, die Kennungen statt Indizes melden will, ohne Neustart. */
    const keysRef = useRef(keys);
    keysRef.current = keys;
    const onLineShownRef = useRef(onLineShown);
    onLineShownRef.current = onLineShown;

    const pickerRef = useRef<Picker | null>(null);
    if (pickerRef.current === null) pickerRef.current = createPicker(keys.length);
    const picker = pickerRef.current;

    /** Der einzige React-Zustand: welcher Satz in welcher Ebene liegt. */
    const [lines, setLines] = useState<Lines>(() => {
      const next = picker.next(0) ?? 0;
      return { a: 0, b: next, probe: next };
    });

    /**
     * Steuer-Zustand, der Effekt-Neustarts (StrictMode) überleben muss: welche
     * Ebene vorne steht und welcher Satz worin liegt — ein Spiegel von `lines`,
     * den die Steuerung ohne Render lesen kann.
     */
    const frontRef = useRef<0 | 1>(0);
    const lineOfRef = useRef<[number, number]>([lines.a, lines.b]);

    const posA = useSharedValue(0);
    const posB = useSharedValue(1);

    const motion = reduceMotion ? FADE : MOVE;
    const motionRef = useRef(motion);
    motionRef.current = motion;
    const { travel, outFade, inFade } = motion;
    const styleA = useAnimatedStyle(() => layerFrame(posA.value, travel, outFade, inFade));
    const styleB = useAnimatedStyle(() => layerFrame(posB.value, travel, outFade, inFade));

    /** Breite des Ausschnitts und natürliche Breite des nachgeladenen Satzes. */
    const metrics = useRef({ box: 0, probe: 0 });
    const api = useRef<Api | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        hold: () => pause.hold(),
        release: () => pause.release(),
      }),
      [pause],
    );

    useEffect(() => {
      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let gen = 0;
      let moving = false;
      /** Trägt die geparkte Ebene schon den nächsten Satz? Beim Einhängen: ja. */
      let ready = true;
      let parkedLine = lineOfRef.current[frontRef.current === 0 ? 1 : 0];
      let loadedAt = 0;
      let loadAfter = 0;
      let nextAt = 0;
      let started = false;
      /** Kein Satz passt mehr in die Zeile — dann bleibt der aktuelle stehen. */
      let exhausted = false;
      /** Kam der zu ladende Satz-Platz aus einem Wechsel? Nur dann wird gemeldet. */
      let swapped = false;
      let paused = true;

      const isPaused = () => pause.isPaused();

      /**
       * Fährt woanders gerade etwas? Dann weder bewegen noch nachladen — das
       * Nachladen ist ein Commit, und der gehört nicht in fremde Kurven.
       */
      const busy = () => pause.isBusy();

      const clear = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const schedule = (ms: number) => {
        clear();
        timer = setTimeout(tick, Math.max(0, ms));
      };

      /**
       * Nach JEDER Änderung einer Pausen-Bedingung. Pausieren räumt nur den
       * Zeitgeber ab: Ein Wechsel, der schon läuft, endet auf dem UI-Strang
       * ganz normal (das kostet dort nichts), es startet nur kein neuer.
       */
      const update = () => {
        if (disposed) return;
        if (isPaused()) {
          paused = true;
          clear();
          return;
        }
        if (paused) {
          paused = false;
          nextAt = Math.max(nextAt, Date.now() + (started ? RESUME_HOLD_MS : FIRST_HOLD_MS));
          started = true;
        }
        if (!moving && timer === null) schedule(0);
      };

      /** Den nächsten Satz in die unsichtbare Ebene legen — der eine Render. */
      const loadParked = (): boolean => {
        const front = frontRef.current;
        const line = picker.next(lineOfRef.current[front]);
        if (line === null) {
          exhausted = true;
          return false;
        }
        const slot = front === 0 ? 1 : 0;
        lineOfRef.current[slot] = line;
        parkedLine = line;
        ready = true;
        loadedAt = Date.now();
        setLines((prev) =>
          slot === 1 ? { ...prev, b: line, probe: line } : { ...prev, a: line, probe: line },
        );
        return true;
      };

      /**
       * Passt der nachgeladene Satz in die Zeile? Gemessen am Messfühler, der
       * ihn in natürlicher Breite trägt. Ohne Messung (noch kein Layout) gilt
       * er als passend — die Ellipse der Ebene bleibt als Rückfall.
       */
      const fits = () => {
        const { box, probe } = metrics.current;
        return box <= 0 || probe <= 0 || probe <= box;
      };

      const onSwapDone = (my: number) => {
        if (disposed || my !== gen) return;
        moving = false;
        swapped = true;
        const now = Date.now();
        nextAt = now + HOLD_MS;
        loadAfter = now + LOAD_DELAY_MS;
        update();
      };

      /** Der Wechsel selbst: nur geteilte Werte, kein Render. */
      const startSwap = () => {
        const m = motionRef.current;
        const front = frontRef.current;
        const leaving = front === 0 ? posA : posB;
        const coming = front === 0 ? posB : posA;
        frontRef.current = front === 0 ? 1 : 0;
        ready = false;
        moving = true;
        const my = ++gen;
        // Erst unten parken (unsichtbar, auch wenn sie zuletzt oben stand) …
        coming.value = 1;
        // … dann hereinholen. Der Abschluss hängt am SPÄTEREN der beiden Wege.
        coming.value = withDelay(
          m.delay,
          withTiming(0, m.in, () => {
            "worklet";
            runOnJS(onSwapDone)(my);
          }),
          ReduceMotion.Never,
        );
        leaving.value = withTiming(-1, m.out);
      };

      function tick() {
        timer = null;
        if (disposed || moving || exhausted || isPaused()) return;
        if (busy()) {
          schedule(BUSY_RETRY_MS);
          return;
        }
        const now = Date.now();
        if (!ready) {
          if (now < loadAfter) {
            schedule(loadAfter - now);
            return;
          }
          if (!loadParked()) return;
          schedule(Math.max(SETTLE_MS, nextAt - now));
          // Nur nach einem Wechsel: Das Nachladen eines zu breiten Satzes kurz
          // vor dem nächsten Wechsel öffnet kein ruhiges Fenster.
          if (swapped) {
            swapped = false;
            onLineShownRef.current?.(keysRef.current[lineOfRef.current[frontRef.current]]);
          }
          return;
        }
        if (now < nextAt) {
          schedule(nextAt - now);
          return;
        }
        if (now - loadedAt < SETTLE_MS) {
          schedule(SETTLE_MS - (now - loadedAt));
          return;
        }
        if (!fits()) {
          // Zu breit für diese Schriftgröße: merken und sofort einen anderen
          // nachladen — der Wechsel kommt dann einen Messabstand später.
          picker.markTooWide(parkedLine);
          ready = false;
          loadAfter = now;
          schedule(0);
          return;
        }
        startSwap();
      }

      const unlisten = pause.listen(update);

      api.current = {
        refit: () => {
          picker.resetFit();
          if (!exhausted) return;
          exhausted = false;
          update();
        },
      };

      update();

      return () => {
        disposed = true;
        clear();
        unlisten();
        api.current = null;
      };
    }, [pause, picker, posA, posB]);

    // Andere Sprache, andere Breiten: Was eben zu breit war, darf wieder.
    useEffect(() => {
      api.current?.refit();
    }, [t]);

    const onBoxLayout = useCallback((e: LayoutChangeEvent) => {
      const w = e.nativeEvent.layout.width;
      const m = metrics.current;
      if (Math.abs(w - m.box) < 0.5) return;
      m.box = w;
      api.current?.refit();
    }, []);
    const onProbeLayout = useCallback((e: LayoutChangeEvent) => {
      metrics.current.probe = e.nativeEvent.layout.width;
    }, []);

    return (
      /**
       * Der Ausschnitt: feste Höhe, `overflow: hidden` — die Sätze fliegen an
       * seiner Kante hinaus und herein, die Leiste bewegt sich nicht.
       *
       * Für Vorleser unsichtbar: Die Leiste trägt ein festes Label, und die
       * beiden Ebenen enthielten zwei Sätze auf einmal, einen davon unsichtbar.
       */
      <View
        style={styles.box}
        onLayout={onBoxLayout}
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        {/**
         * Gibt die Höhe vor — mit derselben Schrift wie vorher die feste Zeile,
         * die Leiste bleibt dadurch auf den Punkt gleich hoch. Steht still,
         * rendert nur beim Sprachwechsel neu.
         */}
        <Text style={[textStyle, styles.ghost]} numberOfLines={1}>
          {t(keys[0])}
        </Text>
        {/**
         * Der Messfühler: der nachgeladene Satz in NATÜRLICHER Breite. Das geht
         * nur absolut und in einer Zeilen-Anordnung — in einer Spalte begrenzt
         * Yoga absolute Kinder auf die Breite des Elternteils
         * (`layoutAbsoluteChild`), und die Ebenen selbst sind auf die Zeile
         * begrenzt, damit ihnen die Ellipse als Rückfall bleibt.
         */}
        <Text
          style={[textStyle, styles.ghost, styles.probe]}
          numberOfLines={1}
          onLayout={onProbeLayout}
        >
          {t(keys[lines.probe])}
        </Text>
        <Animated.Text style={[textStyle, styles.layer, styleA]} numberOfLines={1}>
          {t(keys[lines.a])}
        </Animated.Text>
        <Animated.Text style={[textStyle, styles.layer, styleB]} numberOfLines={1}>
          {t(keys[lines.b])}
        </Animated.Text>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  box: { flex: 1, flexDirection: "row", overflow: "hidden" },
  ghost: { opacity: 0 },
  probe: { position: "absolute", top: 0, left: 0 },
  layer: { position: "absolute", top: 0, left: 0, right: 0 },
});
