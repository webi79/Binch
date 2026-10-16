import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccent } from "@/lib/theme/accent";
import { useReduceMotion } from "@/lib/motion";
import { useLandingPause } from "@/components/home/landingPause";
import {
  BIG_H,
  BIG_HEADROOM,
  BIG_K,
  BIG_PERSPECTIVE,
  BIG_W,
  BO_BODY_PATH,
  CANVAS_H,
  CANVAS_W,
  CLIP_H,
  CLIP_LEFT,
  CLIP_W,
  M_LOOK,
  MOMENT_SIZES,
  MOMENT_TOTALS,
  PEEK_OUT,
  SLOT,
  SPOT_MAX,
  SPOT_MIN,
  TONE_ON_DARK,
  TONE_ON_LIGHT,
  VIEW_BOX,
  bigFrame,
  faceFrame,
  featureFrame,
  figureFrame,
  isDarkSurface,
  joyFrame,
  rightLimitFor,
  roomFor,
  yawnFrame,
  type MiniBoTone,
} from "@/components/home/miniBoMotion";

/**
 * Bo, klein, links in der Landingscreen-Leiste — anstelle der Lupe.
 *
 * Meist steht er still und blinzelt selten. In unregelmäßigen Abständen hat er
 * einen kurzen Moment — 18 verschiedene, als Daten in `miniBoMotion.ts`:
 * auf der Stelle (Freudensprung, Pirouette, Wackeln, Umschauen, zum Mikrofon
 * linsen, Gähnen), unterwegs in der Pille (Hereinfliegen wie nach dem Login,
 * Schweben, eine Runde, Looping, an den Rand huschen und spähen, Kuckuck,
 * verträumt treiben) und über die Leiste hinaus: Er taucht in die Leiste ein,
 * und weiter rechts schaut sein Kopf groß über ihre Oberkante (Periskop,
 * Neugierig, Buh!, Schüchtern, Schläfrig). Alle kommen gleich oft dran — aus
 * einem gemischten Stapel, siehe `createDeck`.
 *
 * HERAUSSCHAUEN: Dafür gibt es einen zweiten, großen Bo — dieselben Ebenen,
 * doppelt so groß gezeichnet, damit er in voller Größe scharf ist (ein
 * hochskaliertes Bitmap des kleinen wäre weich). Er steckt in einem
 * stillstehenden Ausschnitt mit `overflow: hidden`, dessen Unterkante auf der
 * Pillen-Oberkante liegt; was darunter ist, „steckt in der Leiste". Er ist immer
 * eingehängt, aber unsichtbar: Seine Bilder werden beim Einhängen einmal
 * gerastert, nicht im ersten Bild seines Auftritts. Vor jedem Herausschauen
 * wird gemessen, ob über der Leiste Platz ist (gescrollt, Statusleiste) —
 * sonst kommt ein anderer Moment. Die Stelle liegt über der leeren Mitte der
 * Kopfzeile, zwischen Logo und Glocke; die Leiste wird nach der Kopfzeile
 * gezeichnet, er liegt also ohne `zIndex` darüber.
 *
 * SEIN RAUM ist die Pille, nicht sein Platz: Er misst beim Einhängen, wie hoch
 * die Leiste ist, und seine Wege schrumpfen auf kurzen Geräten mit
 * (`roomFor`). Rechts beginnt nach wenigen dp der Text — eine Sperre in
 * `figureFrame` hält seine rechte Kante dort immer `TEXT_CLEARANCE` davor.
 *
 * WIE ER GEZEICHNET WIRD — je sieben STATISCHE SVG-Ebenen, bewegt nur über
 * ihre Hüllen (Verschiebung, Drehung, Maßstab, Deckkraft auf dem UI-Strang):
 *
 *  - react-native-svg rastert eine Fläche einmal in ein Bitmap und malt danach
 *    nur noch dieses (`SvgView.onDraw`: `if (mBitmap == null) mBitmap =
 *    drawOutput()`). Verworfen wird es ausschließlich in `SvgView.invalidate()`
 *    — bei Größenwechsel, beim Abhängen, oder wenn sich eine Eigenschaft eines
 *    SVG-Elements ändert (`VirtualView`-Setter rufen `invalidate()`, die
 *    Wurzel rastert dann ALLES neu). Deshalb nie animierte SVG-Eigenschaften.
 *  - Ein Transform an der Hülle landet dagegen in
 *    `BaseViewManager.setTransformProperty` → `View.setTranslationX/
 *    setRotation/setScaleX…`, also an Eigenschaften des Zeichenknotens. Auch
 *    Reanimateds direkter Weg (`NativeProxy.synchronouslyUpdateUIProps` →
 *    `synchronouslyUpdateViewOnUIThread`) endet dort. Das SVG darunter wird
 *    nicht ungültig, die GPU verschiebt, dreht und skaliert das fertige Bild —
 *    auch eine Skalierung ÜBER einem SVG rastert also nicht neu.
 *  - Vorgerenderte PNGs hätten dieselben Kosten je Bild, aber: Bilder werden
 *    asynchron dekodiert (leere erste Bilder), sie bräuchten je Ebene, Thema,
 *    Akzent und Dichte eine eigene Datei, und Farben kämen nicht zur Laufzeit.
 *    Die SVG-Ebenen werden in der Dichte des Geräts gerastert und sind scharf.
 *  - Der einzige Preis: Während eines Moments ist Bo bis zu ~1,15-fach
 *    vergrößert, das Bitmap dann minimal weich. In Ruhe sind alle Transforms
 *    exakt neutral (siehe `miniBoMotion.ts`), dort ist er pixelgenau.
 *
 * KEINE DAUER-BILDER: Zwischen den Momenten läuft nichts — kein `withRepeat`,
 * kein Schweben. Ein Moment ist eine einzige Uhr (`clock`, linear 0 → Dauer),
 * aus der jede Ebene ihre Lage liest; danach steht wieder alles.
 *
 * PAUSE wie bei den wechselnden Sprüchen (`landingPause.ts`): Fokus, App im
 * Hintergrund, Startbild, Bo offen und andere Überlagerungen, Finger auf der
 * Leiste; vor jedem Start zusätzlich „fährt woanders etwas?". Ein Moment, der
 * beim Pausieren läuft, wird nicht neu angestoßen, sondern gleitet in 160 ms in
 * die Ruhepose — tippt man auf die Leiste, steht Bo, bevor seine große Fassung
 * hereinfährt.
 *
 * WANN: bevorzugt direkt nach einem Spruch-Wechsel (`cue`). Die Sprüche laden
 * nach jedem Wechsel den nächsten Satz nach, und dieser Commit gehört nicht in
 * eine laufende Kurve: Mit `ANDROID_SYNCHRONOUSLY_UPDATE_UI_PROPS` schreibt
 * jeder React-Commit Reanimateds Werte ein, zwei Bilder zu spät zurück. Nach dem
 * Nachladen ist die Leiste über drei Sekunden still — genug für jeden Moment.
 * Kommt ein Spruch, in dem Bo selbst vorkommt, freut er sich oft gleich mit.
 *
 * BEWEGUNG REDUZIEREN: dann steht er ganz still. Für Vorleser ist er
 * unsichtbar — die Leiste trägt ihr eigenes Label.
 */

export interface MiniBoHandle {
  /** Finger auf der Leiste. */
  hold(): void;
  release(): void;
  /** Ein Spruch steht, die Leiste ist bis zum nächsten Wechsel still. */
  cue(lineKey: string): void;
}

interface Props {
  /** Die tatsächliche Farbe der Leiste — danach richtet sich Bos Farbe. */
  surface: unknown;
  /**
   * Abstand zwischen seinem Platz und dem Platzhalter-Text (`gap` der Leiste,
   * auf kurzen Geräten kleiner). Bos rechte Kante bleibt immer
   * `TEXT_CLEARANCE` davor.
   */
  textGap: number;
}

// ─── Zeitplan ───────────────────────────────────────────────────────────────

/** Nach dem Startbild: kurz ankommen lassen, dann ein erstes Hallo. */
const FIRST_MS = 2600;
/** Nach jeder anderen Pause (Tab, Bo, Hintergrund, Berührung). */
const RESUME_MS = 2500;
/**
 * Abstand vom Ende eines Moments bis zum nächsten — nach seiner Größe: Nach
 * einem kleinen kommt der nächste eher, nach einem großen später. Mit dem
 * Warten auf ein ruhiges Fenster und dem Moment selbst ergibt das im Mittel
 * gut 10 s von Start zu Start, wie vorher.
 */
const GAP_MS: ReadonlyArray<readonly [number, number]> = [
  [4500, 9000], // klein
  [5500, 11000], // mittel
  [7000, 13000], // groß
  [7000, 13000], // Herausschauen
];
/** Vor der ersten Messung der Leiste: so viel Weg, wie in die kürzeste passt. */
const DEFAULT_ROOM = 0.64;
/** Erneuter Versuch, solange woanders etwas fährt. */
const BUSY_RETRY_MS = 500;

/** Blinzeln: selten, manchmal doppelt. */
const BLINK_MIN_MS = 3500;
const BLINK_MAX_MS = 7500;
const BLINK_AFTER_MIN_MS = 1500;
const BLINK_AFTER_MAX_MS = 3500;
const DOUBLE_BLINK = 0.2;
const BLINK_GAP_MS = 90;
const BLINK_CLOSE = { duration: 70, easing: Easing.in(Easing.quad) };
const BLINK_OPEN = { duration: 130, easing: Easing.out(Easing.quad) };

/** Start nach einem Spruch-Wechsel: erst den Nachlade-Commit durchlassen. */
const CUE_DELAY_MS = 250;
/** So viel vor dem Fälligkeitszeitpunkt darf ein ruhiges Fenster genutzt werden. */
const CUE_EARLY_MS = 1500;
/** Kommen Meldungen, wartet ein fälliger Moment höchstens so lange auf eine … */
const CUE_WAIT_MS = 4600;
/** … und als „sie kommen" gilt, wenn die letzte so frisch ist. */
const CUE_FRESH_MS = 9000;
/** Ein vorgemerkter Start, der wegen einer Fahrt so lange hing, verfällt. */
const CUE_STALE_MS = 1000;
/** Freude über einen Bo-Spruch: frühestens so lange nach dem letzten Moment … */
const CUE_MIN_GAP_MS = 5000;
/** … und nicht jedes Mal. */
const CUE_CHANCE = 0.6;
/**
 * Sprüche, in denen Bo selbst vorkommt (Liste: `ROTATING_KEYS` in
 * `RotatingPlaceholder`). „Bo langweilt sich" fehlt mit Absicht — darüber
 * freut er sich nicht.
 */
const ABOUT_BO = new Set([
  "home.search.rotating.boWanderlust",
  "home.search.rotating.boPlan",
  "home.search.rotating.tellBo",
  "home.search.rotating.doorToDoor",
  "home.search.rotating.departures",
  "home.search.rotating.dayPlan",
  "home.search.rotating.noBite",
  "home.search.rotating.noLuggage",
  "home.search.rotating.boGhost",
  "home.search.rotating.ghost",
]);

/** Ausschlag und Tempo schwanken je Moment ein wenig — nie zweimal gleich. */
const AMP_MIN = 0.9;
const AMP_MAX = 1.1;
const SPEED_MIN = 0.94;
const SPEED_MAX = 1.06;

/** Ausgleiten in die Ruhepose, wenn beim Pausieren noch ein Moment lief. */
const SETTLE = { duration: 160, easing: Easing.out(Easing.quad) };
/**
 * Die Uhr eines Moments läuft gleichmäßig — die Kurven stecken in den
 * Schlüsselbildern. Auf Modulebene, damit das Worklet nur diese eine Funktion
 * mitnimmt und nicht das ganze `Easing`.
 */
const LINEAR = Easing.linear;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randomDir = () => (Math.random() < 0.5 ? -1 : 1);

/**
 * Welcher Moment als nächster kommt: ein gemischter Stapel über ALLE Momente.
 * Jeder kommt genau einmal dran, bevor sich einer wiederholt — in zufälliger
 * Reihenfolge, und auch über die Rundengrenze nie derselbe zweimal
 * hintereinander. Dasselbe Muster wie bei den wechselnden Sprüchen.
 *
 * Warum kein unabhängiges Ziehen mit gleicher Wahrscheinlichkeit: Das verteilt
 * auf lange Sicht ebenso gleich, aber bis man alle 18 einmal gesehen hat,
 * vergingen im Mittel 11 Minuten, im ungünstigen Fall 40 (Simulation über
 * 3000 Läufe). Mit dem Stapel sind es 3,3 Minuten, höchstens rund 4,6 —
 * bei unverändertem Takt.
 *
 * Ein Herausschauen, für das über der Leiste gerade kein Platz ist, geht
 * zurück in den Stapel und kommt später in derselben Runde. So bleibt die
 * Verteilung gleich, auch wenn man oft gescrollt hat.
 */
function createDeck(count: number) {
  let bag: number[] = [];
  const isPeek = (m: number) => MOMENT_SIZES[m] === PEEK_OUT;
  const refill = (last: number) => {
    bag = [];
    for (let i = 0; i < count; i++) bag.push(i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const swap = bag[i];
      bag[i] = bag[j];
      bag[j] = swap;
    }
    // Gezogen wird von hinten — der erste der neuen Runde ist nie der letzte der alten.
    const top = bag.length - 1;
    if (bag[top] === last) {
      bag[top] = bag[0];
      bag[0] = last;
    }
  };
  return {
    /** Nächster Moment, nie `last`; `peekOk: false` überspringt Herausschauen. */
    draw(last: number, peekOk: boolean): number {
      if (bag.length === 0) refill(last);
      for (let k = bag.length - 1; k >= 0; k--) {
        const m = bag[k];
        if (m === last || (!peekOk && isPeek(m))) continue;
        bag.splice(k, 1);
        return m;
      }
      // Übrig sind nur Herausschau-Momente ohne Platz (oder der letzte): Dann
      // ausnahmsweise ein anderer von außerhalb des Stapels.
      const others: number[] = [];
      for (let i = 0; i < count; i++) if (i !== last && !isPeek(i)) others.push(i);
      return others[Math.floor(Math.random() * others.length)];
    },
    /** Kam ein gezogener Moment doch nicht dran: an zufälliger Stelle zurück. */
    putBack(m: number) {
      bag.splice(Math.floor(Math.random() * (bag.length + 1)), 0, m);
    },
  };
}
type Deck = ReturnType<typeof createDeck>;

/** Pause nach einem Moment, je nach seiner Größe. */
const gapAfter = (m: number) => {
  const [a, b] = GAP_MS[m >= 0 ? MOMENT_SIZES[m] : 0];
  return a + Math.random() * (b - a);
};

// ─── Ebenen ─────────────────────────────────────────────────────────────────

/**
 * Augen und Mund — als Worklet auf Modulebene, nur Rechnen. `side` −1/+1 sind
 * die Augen, 0 der Mund. Die Augen schließen sich zum Blinzeln, wenn ein
 * Moment sie schließt (verträumt, müde), und kurz bevor das Freude-Gesicht
 * kommt; der Mund weicht dem Freude- und dem Gähn-Mund.
 */
function featureStyle(
  side: number,
  clock: number,
  m: number,
  d: number,
  calm: number,
  blink: number,
  k: number,
) {
  "worklet";
  const face = faceFrame(clock, m, d, calm);
  const close = side === 0 ? 0 : Math.max(blink, face.close, Math.min(1, face.joy * 2));
  const f = featureFrame(side, face.turn, close);
  const hidden = face.joy >= 0.5 || (side === 0 && face.yawn > 0.05);
  return {
    opacity: hidden ? 0 : f.opacity,
    transform: [{ translateX: f.tx * k }, { translateY: f.ty * k }, { scaleX: f.sx }, { scaleY: f.sy }],
  };
}

/**
 * Das Erröten: wandert mit dem Gesicht wie der Mund, ist aber nur von vorn zu
 * sehen — beide Wangen liegen auf einer Ebene, schon bei ~12° Drehung stünde
 * die abgewandte über Bos Umriss hinaus.
 */
function blushStyle(clock: number, m: number, d: number, calm: number, k: number) {
  "worklet";
  const face = faceFrame(clock, m, d, calm);
  const f = featureFrame(0, face.turn, 0);
  const front = (Math.cos((face.turn * Math.PI) / 180) - 0.97) / 0.03;
  const o = face.blush * (front <= 0 ? 0 : front >= 1 ? 1 : front);
  return {
    opacity: face.joy >= 0.5 ? 0 : o,
    transform: [{ translateX: f.tx * k }, { translateY: f.ty * k }, { scaleX: f.sx }, { scaleY: f.sy }],
  };
}

/** Gähn- und Freude-Mund, auf die Größe `k` der Ebene gerechnet. */
function mouthOverlayStyle(kind: number, clock: number, m: number, d: number, calm: number, k: number) {
  "worklet";
  const face = faceFrame(clock, m, d, calm);
  const o = kind === 0 ? yawnFrame(face.yawn) : joyFrame(face.joy);
  return { opacity: o.opacity, transform: [{ translateY: o.ty * k }, { scaleY: o.sy }] };
}

/*
 * Die Ebenen selbst: statisch, `memo`, alle mit DERSELBEN Fläche und demselben
 * Bildausschnitt — so liegen sie pixelgenau übereinander, und jede wird genau
 * einmal gerastert (wieder nur bei Thema- oder Akzentwechsel).
 * Pfade und Maße 1:1 aus `components/assistant/Bo.tsx`.
 */

/** Jede Ebene in zwei Größen: klein am Platz, groß beim Herausschauen. */
interface LayerProps {
  tone: MiniBoTone;
  w?: number;
  h?: number;
}

const BodyLayer = memo(function BodyLayer({ tone, w = CANVAS_W, h = CANVAS_H }: LayerProps) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Defs>
        <LinearGradient id="miniBoBody" x1="100" y1="40" x2="100" y2="220" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={tone.bodyTop} />
          <Stop offset="1" stopColor={tone.bodyBottom} />
        </LinearGradient>
      </Defs>
      <Path d={BO_BODY_PATH} fill="url(#miniBoBody)" />
    </Svg>
  );
});

/** Ein Auge — einzeln, weil jedes bei der Drehung anders schmal wird. */
const EyeLayer = memo(function EyeLayer({ cx, tone, w = CANVAS_W, h = CANVAS_H }: LayerProps & { cx: number }) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Ellipse cx={cx} cy={120} rx={16} ry={21} fill={tone.face} />
      <Circle cx={cx + 6} cy={112} r={5.5} fill={tone.glint} opacity={tone.glintOpacity} />
      <Circle cx={cx - 5} cy={126} r={2.6} fill={tone.glint} opacity={0.7 * tone.glintOpacity} />
    </Svg>
  );
});

const MouthLayer = memo(function MouthLayer({ tone, w = CANVAS_W, h = CANVAS_H }: LayerProps) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Path d="M89 150 Q100 159 111 150" stroke={tone.face} strokeWidth={5} strokeLinecap="round" fill="none" />
    </Svg>
  );
});

/**
 * Der Gähn-Mund: ein weit offenes Oval in Tinte — groß genug, dass er auf
 * 17 dp nach Gähnen aussieht und nicht nach einem staunenden „o".
 */
const YawnLayer = memo(function YawnLayer({ tone, w = CANVAS_W, h = CANVAS_H }: LayerProps) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Ellipse cx={100} cy={158} rx={12} ry={16} fill={tone.face} />
    </Svg>
  );
});

/** Erröten: die Wangen aus dem Freude-Gesicht, allein. */
const BlushLayer = memo(function BlushLayer({ blush, w = CANVAS_W, h = CANVAS_H }: Omit<LayerProps, "tone"> & { blush: string }) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Ellipse cx={56} cy={150} rx={13} ry={7.5} fill={blush} opacity={0.8} />
      <Ellipse cx={144} cy={150} rx={13} ry={7.5} fill={blush} opacity={0.8} />
    </Svg>
  );
});

/**
 * Das Freude-Gesicht aus Bos `happy`: Lächel-Augen, offener Mund und Wangen im
 * Akzent. Im Ruhegesicht fehlen die Wangen bewusst — auf 17 dp lesen sie sich
 * als grüne Flecken; erst zur Freude passen sie.
 */
const JoyLayer = memo(function JoyLayer({ tone, blush, w = CANVAS_W, h = CANVAS_H }: LayerProps & { blush: string }) {
  return (
    <Svg width={w} height={h} viewBox={VIEW_BOX}>
      <Ellipse cx={56} cy={150} rx={13} ry={7.5} fill={blush} opacity={0.8} />
      <Ellipse cx={144} cy={150} rx={13} ry={7.5} fill={blush} opacity={0.8} />
      <Path
        d="M61 124 Q76 104 91 124 M109 124 Q124 104 139 124"
        stroke={tone.face}
        strokeWidth={7.5}
        strokeLinecap="round"
        fill="none"
      />
      <Path d="M82 149 Q100 180 118 149 Z" fill={tone.face} />
    </Svg>
  );
});

// ─── Komponente ─────────────────────────────────────────────────────────────

export const MiniBo = memo(
  forwardRef<MiniBoHandle, Props>(function MiniBo({ surface, textGap }, ref) {
    const accent = useAccent();
    const reduceMotion = useReduceMotion();
    const pause = useLandingPause();
    /** Oberkante der sicheren Fläche — darüber darf sein Kopf nicht. Als Ref: kein Neustart. */
    const insetTop = useRef(0);
    insetTop.current = useSafeAreaInsets().top;
    const slotRef = useRef<View>(null);
    const deckRef = useRef<Deck | null>(null);
    if (deckRef.current === null) deckRef.current = createDeck(MOMENT_TOTALS.length);
    /** Abstand von der Oberkante der Leiste bis zu seinem Platz (gemessen). */
    const slotY = useRef(19.5);
    /**
     * Dunkle Leiste → weißer Bo mit dunklem Gesicht, helle → umgekehrt. Heute
     * ist die Leiste in allen drei Themen `#171719`, Bo also überall weiß.
     */
    const tone = isDarkSurface(surface) ? TONE_ON_DARK : TONE_ON_LIGHT;

    const clock = useSharedValue(-1);
    const moment = useSharedValue(0);
    const dir = useSharedValue(1);
    const amp = useSharedValue(1);
    const calm = useSharedValue(1);
    const blink = useSharedValue(0);
    /** Die Pille: wie viel der Wege hineinpasst und wo rechts Schluss ist. */
    const room = useSharedValue(DEFAULT_ROOM);
    const maxRight = useSharedValue(rightLimitFor(textGap));
    /** Über der Leiste: wo die Kante liegt (vom Platz aus) und wo er herausschaut. */
    const edge = useSharedValue(-19.5);
    const spot = useSharedValue((SPOT_MIN + SPOT_MAX) / 2);

    useEffect(() => {
      maxRight.value = rightLimitFor(textGap);
    }, [textGap, maxRight]);

    /**
     * Wie hoch die Pille tatsächlich ist: Der Platz sitzt senkrecht mittig in
     * der Leiste, oben und unten liegt also derselbe Abstand. Eine Messung beim
     * Einhängen — kein Render.
     */
    const onSlotLayout = useCallback(
      (e: LayoutChangeEvent) => {
        const y = e.nativeEvent.layout.y;
        slotY.current = y;
        room.value = roomFor(2 * y + SLOT);
        edge.value = -y;
      },
      [room, edge],
    );

    const figureStyle = useAnimatedStyle(() => {
      const f = figureFrame(
        clock.value,
        moment.value,
        dir.value,
        amp.value,
        calm.value,
        room.value,
        maxRight.value,
      );
      return {
        opacity: f.alpha,
        transform: [
          { translateX: f.tx },
          { translateY: f.ty },
          { rotate: `${f.rot}deg` },
          { scaleX: f.sx },
          { scaleY: f.sy },
        ],
      };
    });
    const eyeLStyle = useAnimatedStyle(() =>
      featureStyle(-1, clock.value, moment.value, dir.value, calm.value, blink.value, 1),
    );
    const eyeRStyle = useAnimatedStyle(() =>
      featureStyle(1, clock.value, moment.value, dir.value, calm.value, blink.value, 1),
    );
    const mouthStyle = useAnimatedStyle(() =>
      featureStyle(0, clock.value, moment.value, dir.value, calm.value, 0, 1),
    );
    const yawnStyle = useAnimatedStyle(() =>
      mouthOverlayStyle(0, clock.value, moment.value, dir.value, calm.value, 1),
    );
    const joyStyle = useAnimatedStyle(() =>
      mouthOverlayStyle(1, clock.value, moment.value, dir.value, calm.value, 1),
    );
    const blushStyleS = useAnimatedStyle(() =>
      blushStyle(clock.value, moment.value, dir.value, calm.value, 1),
    );

    /**
     * Der große Bo beim Herausschauen. Außen Lage und Neigung zum Betrachter
     * (mit Perspektive), innen Kopf schief und Maßstab — getrennt, damit React
     * Native keine Drehung um zwei Achsen samt ungleichem Maßstab in eine
     * Matrix zerlegen muss, die Android nur ungenau nachbilden kann.
     */
    const clipStyle = useAnimatedStyle(() => ({ transform: [{ translateY: edge.value }] }));
    const bigOuterStyle = useAnimatedStyle(() => {
      const b = bigFrame(clock.value, moment.value, calm.value);
      return {
        opacity: b.on,
        transform: [
          { perspective: BIG_PERSPECTIVE },
          { translateX: spot.value - CLIP_LEFT + b.x },
          { translateY: b.y },
          { rotateX: `${b.rx}deg` },
        ],
      };
    });
    const bigInnerStyle = useAnimatedStyle(() => {
      const b = bigFrame(clock.value, moment.value, calm.value);
      return { transform: [{ rotate: `${b.rot}deg` }, { scaleX: b.sx }, { scaleY: b.sy }] };
    });
    const bigEyeLStyle = useAnimatedStyle(() =>
      featureStyle(-1, clock.value, moment.value, dir.value, calm.value, blink.value, BIG_K),
    );
    const bigEyeRStyle = useAnimatedStyle(() =>
      featureStyle(1, clock.value, moment.value, dir.value, calm.value, blink.value, BIG_K),
    );
    const bigMouthStyle = useAnimatedStyle(() =>
      featureStyle(0, clock.value, moment.value, dir.value, calm.value, 0, BIG_K),
    );
    const bigYawnStyle = useAnimatedStyle(() =>
      mouthOverlayStyle(0, clock.value, moment.value, dir.value, calm.value, BIG_K),
    );
    const bigJoyStyle = useAnimatedStyle(() =>
      mouthOverlayStyle(1, clock.value, moment.value, dir.value, calm.value, BIG_K),
    );
    const bigBlushStyle = useAnimatedStyle(() =>
      blushStyle(clock.value, moment.value, dir.value, calm.value, BIG_K),
    );

    const api = useRef<{ cue(key: string): void } | null>(null);
    useImperativeHandle(
      ref,
      () => ({
        hold: () => pause.hold(),
        release: () => pause.release(),
        cue: (key: string) => api.current?.cue(key),
      }),
      [pause],
    );

    useEffect(() => {
      const toRest = () => {
        cancelAnimation(clock);
        cancelAnimation(calm);
        cancelAnimation(blink);
        clock.value = -1;
        calm.value = 1;
        blink.value = 0;
      };
      if (reduceMotion) {
        toRest();
        return;
      }

      let disposed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let paused = true;
      let started = false;
      const deck = deckRef.current as Deck;
      /** Ein Moment läuft — bis sein Ende auf dem JS-Strang ankommt. */
      let moving = false;
      let gen = 0;
      let lastMoment = -1;
      let lastEnd = 0;
      let dueAt = 0;
      let blinkAt = 0;
      let lastCueAt = 0;
      /** Vorgemerkter Start in einem ruhigen Fenster. */
      let cued: { at: number; aboutBo: boolean } | null = null;

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

      /** Fällig — aber solange Sprüche wechseln, auf ein ruhiges Fenster warten. */
      const momentAt = (now: number) =>
        dueAt + (now - lastCueAt < CUE_FRESH_MS ? CUE_WAIT_MS : 0);

      const plan = () => {
        if (disposed || paused || moving) return;
        const now = Date.now();
        let wake = Math.min(blinkAt, momentAt(now));
        if (cued) wake = Math.min(wake, cued.at);
        schedule(wake - now);
      };

      const onEnd = (my: number) => {
        if (disposed || my !== gen) return;
        moving = false;
        const now = Date.now();
        lastEnd = now;
        dueAt = now + gapAfter(lastMoment);
        blinkAt = Math.max(blinkAt, now + rand(BLINK_AFTER_MIN_MS, BLINK_AFTER_MAX_MS));
        plan();
      };

      /** Ein Moment: alle Werte in EINEM Durchgang auf dem UI-Strang, eine Uhr. */
      const begin = (m: number, d: number, a: number, ms: number, at: number, my: number) => {
        "worklet";
        spot.value = at;
        moment.value = m;
        dir.value = d;
        amp.value = a;
        calm.value = 1;
        clock.value = 0;
        clock.value = withTiming(
          MOMENT_TOTALS[m],
          { duration: ms, easing: LINEAR },
          (finished) => {
            "worklet";
            if (!finished) return;
            clock.value = -1;
            runOnJS(onEnd)(my);
          },
        );
      };

      /** Ein laufender Moment gleitet in die Ruhepose, statt zu springen. */
      const settle = () => {
        "worklet";
        if (clock.value < 0) return;
        cancelAnimation(clock);
        calm.value = withTiming(0, SETTLE, (finished) => {
          "worklet";
          if (!finished) return;
          clock.value = -1;
          calm.value = 1;
        });
      };

      const launch = (m: number, d: number, my: number) => {
        lastMoment = m;
        const ms = MOMENT_TOTALS[m] / rand(SPEED_MIN, SPEED_MAX);
        runOnUI(begin)(m, d, rand(AMP_MIN, AMP_MAX), ms, rand(SPOT_MIN, SPOT_MAX), my);
      };

      /**
       * Ist über der Leiste Platz für seinen Kopf? Hat man den Landingscreen so
       * weit gescrollt, dass die Leiste oben am Rand steht, schnitte der
       * Scroll-Bereich ihn ab — oder er läge unter der Statusleiste. Dann kommt
       * ein anderer Moment. Gemessen wird nur hier, vor einem Herausschauen.
       */
      const roomAbove = (then: (ok: boolean) => void) => {
        const node = slotRef.current;
        if (!node) {
          then(false);
          return;
        }
        node.measureInWindow((_x, y) => {
          then(y - slotY.current - BIG_HEADROOM >= insetTop.current + 4);
        });
      };

      /**
       * Den nächsten Moment ziehen und starten. Nach einem Bo-Spruch schaut das
       * Umschauen zum Text, sonst ist die Richtung zufällig.
       */
      const start = (towardText: boolean) => {
        moving = true;
        const my = ++gen;
        const dirFor = (m: number) => (m === M_LOOK && towardText ? 1 : randomDir());
        const m = deck.draw(lastMoment, true);
        if (MOMENT_SIZES[m] !== PEEK_OUT) {
          launch(m, dirFor(m), my);
          return;
        }
        roomAbove((ok) => {
          // Inzwischen pausiert? Dann bleibt das Herausschauen für später im Stapel.
          if (disposed || my !== gen) {
            deck.putBack(m);
            return;
          }
          if (ok) {
            launch(m, dirFor(m), my);
            return;
          }
          deck.putBack(m);
          const other = deck.draw(lastMoment, false);
          launch(other, dirFor(other), my);
        });
      };

      const blinkOnce = () => {
        const close = withTiming(1, BLINK_CLOSE);
        const open = withTiming(0, BLINK_OPEN);
        blink.value =
          Math.random() < DOUBLE_BLINK
            ? withSequence(close, open, withDelay(BLINK_GAP_MS, withTiming(1, BLINK_CLOSE)), withTiming(0, BLINK_OPEN))
            : withSequence(close, open);
      };

      function tick() {
        timer = null;
        if (disposed || paused || moving) return;
        if (pause.isBusy()) {
          schedule(BUSY_RETRY_MS);
          return;
        }
        const now = Date.now();
        if (cued && now >= cued.at) {
          const c = cued;
          cued = null;
          if (now - c.at <= CUE_STALE_MS) {
            start(c.aboutBo);
            return;
          }
        }
        if (now >= momentAt(now)) {
          start(false);
          return;
        }
        if (now >= blinkAt) {
          blinkOnce();
          blinkAt = now + rand(BLINK_MIN_MS, BLINK_MAX_MS);
        }
        plan();
      }

      /** Nach JEDER Änderung einer Pausen-Bedingung. */
      const update = () => {
        if (disposed) return;
        if (pause.isPaused()) {
          if (paused) return;
          paused = true;
          clear();
          cued = null;
          if (moving) {
            // Nicht neu anstoßen: ausgleiten lassen; ein noch ankommendes Ende
            // gehört dann zu keinem Moment mehr.
            moving = false;
            gen++;
            const now = Date.now();
            lastEnd = now;
            dueAt = now + gapAfter(lastMoment);
            runOnUI(settle)();
          }
          return;
        }
        if (paused) {
          paused = false;
          const now = Date.now();
          dueAt = Math.max(dueAt, now + (started ? RESUME_MS : FIRST_MS));
          blinkAt = Math.max(blinkAt, now + rand(BLINK_AFTER_MIN_MS, BLINK_AFTER_MAX_MS));
          started = true;
        }
        plan();
      };

      api.current = {
        cue: (key: string) => {
          const now = Date.now();
          lastCueAt = now;
          if (disposed || paused || moving || cued) {
            plan();
            return;
          }
          // Welcher Moment kommt, entscheidet erst der Start — gezogen wird
          // immer aus demselben Stapel, auch beim Mitfreuen.
          const aboutBo = ABOUT_BO.has(key);
          if (
            now >= dueAt - CUE_EARLY_MS ||
            (aboutBo && now - lastEnd >= CUE_MIN_GAP_MS && Math.random() < CUE_CHANCE)
          ) {
            cued = { at: now + CUE_DELAY_MS, aboutBo };
          }
          plan();
        },
      };

      const unlisten = pause.listen(update);
      update();

      return () => {
        disposed = true;
        clear();
        unlisten();
        api.current = null;
        toRest();
      };
    }, [pause, reduceMotion, clock, moment, dir, amp, calm, blink, spot]);

    return (
      <View
        ref={slotRef}
        style={styles.slot}
        onLayout={onSlotLayout}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
      >
        <Animated.View style={[styles.figure, figureStyle]}>
          <BodyLayer tone={tone} />
          <Animated.View style={[styles.layer, mouthStyle]}>
            <MouthLayer tone={tone} />
          </Animated.View>
          <Animated.View style={[styles.layer, yawnStyle]}>
            <YawnLayer tone={tone} />
          </Animated.View>
          <Animated.View style={[styles.layer, eyeLStyle]}>
            <EyeLayer cx={76} tone={tone} />
          </Animated.View>
          <Animated.View style={[styles.layer, eyeRStyle]}>
            <EyeLayer cx={124} tone={tone} />
          </Animated.View>
          <Animated.View style={[styles.layer, blushStyleS]}>
            <BlushLayer blush={accent.solid} />
          </Animated.View>
          <Animated.View style={[styles.layer, joyStyle]}>
            <JoyLayer tone={tone} blush={accent.solid} />
          </Animated.View>
        </Animated.View>
        {/*
         * Der Ausschnitt über der Leiste — steht still, seine Unterkante liegt
         * auf der Pillen-Oberkante (`edge`, einmal gemessen). Was vom großen Bo
         * darunter liegt, steckt „in der Leiste" und wird abgeschnitten.
         */}
        <Animated.View style={[styles.clip, clipStyle]}>
          <Animated.View style={[styles.bigOuter, bigOuterStyle]}>
            <Animated.View style={[styles.bigFill, bigInnerStyle]}>
              <BodyLayer tone={tone} w={BIG_W} h={BIG_H} />
              <Animated.View style={[styles.bigFill, bigMouthStyle]}>
                <MouthLayer tone={tone} w={BIG_W} h={BIG_H} />
              </Animated.View>
              <Animated.View style={[styles.bigFill, bigYawnStyle]}>
                <YawnLayer tone={tone} w={BIG_W} h={BIG_H} />
              </Animated.View>
              <Animated.View style={[styles.bigFill, bigEyeLStyle]}>
                <EyeLayer cx={76} tone={tone} w={BIG_W} h={BIG_H} />
              </Animated.View>
              <Animated.View style={[styles.bigFill, bigEyeRStyle]}>
                <EyeLayer cx={124} tone={tone} w={BIG_W} h={BIG_H} />
              </Animated.View>
              <Animated.View style={[styles.bigFill, bigBlushStyle]}>
                <BlushLayer blush={accent.solid} w={BIG_W} h={BIG_H} />
              </Animated.View>
              <Animated.View style={[styles.bigFill, bigJoyStyle]}>
                <JoyLayer tone={tone} blush={accent.solid} w={BIG_W} h={BIG_H} />
              </Animated.View>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </View>
    );
  }),
);

const styles = StyleSheet.create({
  /** Genau der Platz der Lupe — die Zeile und die Sprüche merken keinen Unterschied. */
  slot: { width: SLOT, height: SLOT },
  /** Die Figur ragt oben und unten je 1 dp über den Platz hinaus; nichts schneidet. */
  figure: {
    position: "absolute",
    left: (SLOT - CANVAS_W) / 2,
    top: (SLOT - CANVAS_H) / 2,
    width: CANVAS_W,
    height: CANVAS_H,
  },
  layer: { position: "absolute", left: 0, top: 0, width: CANVAS_W, height: CANVAS_H },
  /**
   * Der Ausschnitt: ruht mit seiner Unterkante auf Höhe der Platz-Oberkante
   * und wird per `edge` um genau den gemessenen Abstand bis zur
   * Pillen-Oberkante hochgeschoben. Ohne Hintergrund — man sieht nur, was er
   * durchlässt.
   */
  clip: {
    position: "absolute",
    left: CLIP_LEFT,
    top: -CLIP_H,
    width: CLIP_W,
    height: CLIP_H,
    overflow: "hidden",
  },
  /** Der große Bo: Mitte auf der Unterkante des Ausschnitts, also auf der Pillen-Kante. */
  bigOuter: {
    position: "absolute",
    left: -BIG_W / 2,
    top: CLIP_H - BIG_H / 2,
    width: BIG_W,
    height: BIG_H,
    opacity: 0,
  },
  bigFill: { position: "absolute", left: 0, top: 0, width: BIG_W, height: BIG_H },
});
