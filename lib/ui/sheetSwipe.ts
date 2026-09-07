/**
 * Wischen nach unten schließt das Blatt — EINMAL, für alle Blätter von unten.
 *
 * Bis hierher hatte jedes Blatt seine eigene Wisch-Geste, und alle sahen fast
 * gleich aus: `activeOffsetY(8)`, `failOffsetY(-8)`, 110 Punkte oder 700
 * Geschwindigkeit als Abwurf, sonst mit Feder zurück. Fast gleich heißt: Das
 * Verlaufs-Blatt fuhr mit der langen Kurve hinaus, das Ticket-Blatt mit der
 * kurzen, und das Benachrichtigungs-Blatt hatte gar keine. Solche Unterschiede
 * fallen einzeln nicht auf und zusammen sehr wohl.
 *
 * Zwei Dinge macht diese Datei, die die einzelnen Fassungen nicht konnten:
 *
 * **1. Die ganze Fläche ist griffig, nicht nur der Griff.** Die Geste hängt am
 * Blatt selbst, nicht am 40×4 großen Strich oben. Dass ein Tipper auf einen
 * Knopf trotzdem ein Tipper bleibt, entscheidet nicht Code, sondern die
 * Aktivierungs-Schwelle: `activeOffsetY` lässt die Geste erst nach ein paar
 * Punkten Weg anspringen. Bis dahin gehört die Berührung dem Knopf darunter.
 * Springt sie an, nimmt der Erkenner dem Knopf die Berührung ab — der Druck
 * wird abgebrochen, statt beim Loslassen auszulösen. Genau die Entscheidung
 * „Knopf oder Wisch", ohne eine einzige Zeile Heuristik.
 *
 * **2. Eine Liste im Blatt scrollt weiter.** Das ist der Teil, der ohne Hilfe
 * kaputtgeht: Sobald ein Erkenner anspringt, schickt die Gesten-Bibliothek den
 * nativen Ansichten darunter ein Abbruch-Ereignis — die Liste bliebe mitten im
 * Scrollen stehen. Deshalb `useSheetScrollGate`: Die Liste bekommt einen
 * eigenen nativen Erkenner, beide werden als GLEICHZEITIG angemeldet (dann
 * bricht keiner den anderen ab), und der Scroll-Stand entscheidet, wer die
 * Bewegung zeigt. Steht die Liste nicht ganz oben, wandert nur der Nullpunkt
 * mit — das Blatt rührt sich nicht. Erreicht sie oben, übernimmt das Blatt
 * bruchlos.
 *
 * Was hier NICHT hineingehört: Blätter mit Rastpunkten (`StopDetailSheet`,
 * `SurroundingsSheet`). Die haben mehr als „offen oder weg" und behalten ihre
 * eigene Geste; von hier nehmen sie nur die Torhüter-Funktion.
 */
import { useMemo } from "react";
import { Dimensions } from "react-native";
import { Gesture, type NativeGesture } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import { markSheetMoving } from "@/lib/nav/overlayCover";

/**
 * So weit muss der Finger nach unten, bevor aus einem Druck ein Wisch wird.
 *
 * Der Wert ist die eigentliche Antwort auf „Knopf oder Wisch": klein genug,
 * dass sich das Blatt sofort mitzubewegen scheint, groß genug, dass das
 * unvermeidliche Wackeln beim Antippen keinen Wisch auslöst.
 */
export const SWIPE_ACTIVATE = 8;

/**
 * Deutlich quer = kein Wisch nach unten.
 *
 * Ohne diese Schranke fräße das Blatt die Wisch-zum-Löschen-Geste der Karten im
 * Verlaufs-Blatt: Die springt erst bei 10 Punkten seitlich an, das Blatt schon
 * bei 8 nach unten — bei einer schrägen Bewegung wäre das Blatt regelmäßig
 * zuerst dran. 20 Punkte seitlich vor 8 nach unten ist eine Bewegung, die
 * niemand als „nach unten" gemeint hat.
 */
const FAIL_X = 20;

/** Wisch-Abwurf: kürzer als die reguläre Ausfahrt — der Weg ist schon halb zurückgelegt. */
export const SWIPE_OUT = { duration: 220, easing: Easing.out(Easing.quad) } as const;

/** Ab hier gilt der Wisch als Abwurf: entweder weit genug oder schnell genug. */
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 700;

/**
 * Zurück an den Platz, wenn es für den Abwurf nicht gereicht hat — als KURVE,
 * nicht mehr als Feder.
 *
 * Die Feder hier hatte einen Dämpfungsgrad von rund 0,74 und schwang damit um
 * gut 3% über: Das Blatt fuhr am Ruhepunkt VORBEI, also über seine Oberkante
 * hinaus, und darunter wurde für ein paar Bilder der Hintergrund sichtbar.
 * Genau das ist der „Sprung beim Hochgleiten". Dazu kommt der Anlauf: Eine
 * Feder startet mit Geschwindigkeit null, der Finger war aber gerade noch in
 * Bewegung — nach dem Loslassen lag deshalb erst ein Zögern und dann ein
 * Schnalzen.
 *
 * `Easing.out` startet schnell und läuft aus. Das ist dieselbe Kurve wie beim
 * Abwurf (`SWIPE_OUT`) — beides sind Bewegungen, die der Finger angestoßen hat.
 */
const RETURN_EASE = Easing.out(Easing.quad);
const RETURN_MS = 220;
/**
 * Kurzer Weg, kurze Dauer — sonst kriecht das Blatt über zwei Fingerbreit
 * zurück. Bezugsgröße ist die Abwurf-Entfernung, denn weiter als die kann der
 * Rückweg gar nicht sein: Alles darüber wäre ein Abwurf gewesen.
 */
const RETURN_MIN_FRAC = 0.25;

/**
 * Der Torhüter für eine Liste im Blatt.
 *
 * `native` gehört an einen `GestureDetector` UM die Liste, `onScroll` und
 * `scrollEventThrottle` an die Liste selbst — und die muss dafür eine
 * `Animated.ScrollView` sein, sonst läuft der Scroll-Stand über den JS-Strang
 * und ist genau dann veraltet, wenn er gebraucht wird.
 */
export interface SheetScrollGate {
  /** Gehört an die Liste (`ref={gate.ref}`) — darüber wird sie festgehalten. */
  ref: AnimatedRef<Animated.ScrollView>;
  scrollY: SharedValue<number>;
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  native: NativeGesture;
}

export function useSheetScrollGate(): SheetScrollGate {
  const ref = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });
  // Fest — ein neues Gesten-Objekt zwingt den Erkenner, sich bei jedem
  // Durchgang neu gegen seinen nativen Gegenpart einzurichten.
  const native = useMemo(() => Gesture.Native(), []);
  return { ref, scrollY, onScroll, native };
}

/**
 * Zurück an den Ruhepunkt — auf dem UI-Strang, im selben Bild wie das
 * Loslassen.
 *
 * Angemeldet wird die Rückkehr trotzdem: An `markSheetMoving` hängt der Riegel,
 * der eine GPU-Textur nicht mitten in einer Fahrt abreißen lässt. Ohne ihn
 * konnte genau diese kurze Kurve von einem fremden Commit angehalten werden —
 * das „manchmal ruckelt es, manchmal nicht" aus `overlayCover`.
 */
function settleBack(y: SharedValue<number>, rest: number) {
  "worklet";
  const dist = Math.abs(y.value - rest);
  if (dist < 0.5) {
    y.value = rest;
    return;
  }
  const frac = Math.min(1, Math.max(RETURN_MIN_FRAC, dist / DISMISS_DISTANCE));
  const duration = Math.round(RETURN_MS * frac);
  runOnJS(markSheetMoving)(duration);
  y.value = withTiming(rest, { duration, easing: RETURN_EASE });
}

export interface SheetSwipeOptions {
  /** Die Lage des Blattes — derselbe geteilte Wert, den auch die Einfahrt schreibt. */
  y: SharedValue<number>;
  /** Der Weg nach unten aus dem Bild: die Höhe des Blattes. */
  travel: SharedValue<number> | number;
  /**
   * Läuft auf dem JS-Strang, sobald der Wisch als Abwurf gilt.
   *
   * Bekommt die Dauer der Ausfahrt mit, damit der Aufrufer das Abmelden
   * dahinter legen kann — Blätter in einem Fenster verschwinden sonst
   * schlagartig, weil mit `visible` auch die Fläche weg ist.
   */
  onDismiss: (durationMs: number, fromY: number) => void;
  /**
   * `true` = die Geste fährt die Ausfahrt selbst, sofort, auf dem UI-Strang.
   *
   * `false` für Blätter, deren Ausfahrt woanders hängt (ein Effekt am `open`,
   * die gemeinsame Fahrt in `useSheetSlide`). Zwei Kurven auf demselben Wert
   * sind sichtbar: Sie überschreiben sich gegenseitig und ergeben mitten in der
   * Bewegung einen Tempo-Wechsel.
   */
  drive?: boolean;
  enabled?: boolean;
  /** Die Ruhelage, falls sie nicht 0 ist. */
  rest?: number;
  /** Liste im Blatt — siehe `useSheetScrollGate`. */
  gate?: SheetScrollGate | null;
}

export function useSheetSwipe({
  y,
  travel,
  onDismiss,
  drive = true,
  enabled = true,
  rest = 0,
  gate = null,
}: SheetSwipeOptions) {
  /**
   * Der Nullpunkt der Bewegung.
   *
   * Zwei Aufgaben, beide dagegen, dass das Blatt springt: Beim Anspringen steht
   * der Weg schon bei `SWIPE_ACTIVATE` — ohne Abzug hüpfte das Blatt zum Start
   * um diese acht Punkte. Und solange die Liste scrollt, wandert der Nullpunkt
   * MIT, sonst schnellte das Blatt in dem Moment, in dem die Liste oben
   * ankommt, um die ganze Scroll-Strecke nach unten.
   */
  const base = useSharedValue(0);
  /**
   * Wo das Blatt beim Zupacken stand.
   *
   * Vorher wurde von der Ruhelage aus gerechnet. Wer ein Blatt anfasste, das
   * gerade fuhr — die Rückkehr nach einem halben Wisch, die Einfahrt —, riss es
   * damit im ersten Bild an den Ruhepunkt. Jetzt wird die laufende Kurve
   * angehalten und dort weitergemacht, wo sie steht.
   */
  const startY = useSharedValue(0);

  const travelSv = typeof travel === "number" ? null : travel;
  const travelConst = typeof travel === "number" ? travel : 0;
  const scrollY = gate?.scrollY ?? null;
  const scrollRef = gate?.ref ?? null;
  const nativeScroll = gate?.native ?? null;

  return useMemo(() => {
    const g = Gesture.Pan()
      .enabled(enabled)
      .activeOffsetY(SWIPE_ACTIVATE)
      // Nach OBEN sofort aufgeben: Dort liegt entweder eine Liste, die scrollen
      // will, oder schlicht nichts, was das Blatt tun könnte.
      .failOffsetY(-SWIPE_ACTIVATE)
      .failOffsetX([-FAIL_X, FAIL_X])
      .onStart((e) => {
        // Eine laufende Kurve anhalten und von dort weitermachen — sonst reißt
        // das Zupacken das Blatt im ersten Bild an den Ruhepunkt.
        cancelAnimation(y);
        startY.value = y.value;
        base.value = e.translationY;
      })
      .onUpdate((e) => {
        /**
         * Wer die Bewegung zeigt, entscheidet die LAGE des Blattes zuerst.
         *
         * Vorher entschied allein der Scroll-Stand — und das war der Sprung
         * beim Hochziehen: Ein Blatt, das schon 60 Punkte tief hing, wurde in
         * dem Moment, in dem die Liste zu scrollen begann, in EINEM Bild an
         * seinen Platz zurückgerissen. Die Liste fing aber genau dann an zu
         * scrollen, wenn der Finger wieder nach oben ging.
         *
         * Jetzt gilt: Solange das Blatt von seinem Platz weg ist, gehört ihm
         * die Geste — es folgt dem Finger bis zurück an die Ruhelage. Erst wenn
         * es dort liegt UND die Liste scrollt, übernimmt sie.
         */
        const listOwns = scrollY !== null && y.value <= rest + 0.5 && scrollY.value > 0.5;
        if (listOwns) {
          // Der Nullpunkt wandert mit, damit das Blatt nicht später um die
          // ganze Scroll-Strecke nachspringt.
          base.value = e.translationY;
          startY.value = rest;
          return;
        }
        // Nur nach unten — nach oben hat das Blatt keinen Platz.
        y.value = Math.max(rest, startY.value + e.translationY - base.value);
        /**
         * Liste festhalten, solange das Blatt hängt.
         *
         * Ohne das scrollte sie unter dem gezogenen Blatt mit — sie bekommt
         * dieselbe Berührung ab (beide sind als gleichzeitig angemeldet). Man
         * zieht das Blatt hinunter, lässt es zurückschnappen, und die Liste
         * steht plötzlich woanders.
         */
        if (scrollRef !== null && y.value > rest + 0.5 && scrollRef()) {
          // Der Test auf die Verknüpfung gehört dazu: Nicht jedes Blatt zeigt
          // immer eine Liste (Ladezustand, leerer Zustand). Ohne ihn schriebe
          // Reanimated pro Bild eine Warnung.
          scrollTo(scrollRef, 0, 0, false);
        }
      })
      .onEnd((e) => {
        const dy = startY.value - rest + e.translationY - base.value;
        /**
         * Der Schwung allein wirft nur ein Blatt ab, das auch WIRKLICH hängt.
         *
         * Sonst schlösse ein kräftiger Wisch IN der Liste das Blatt: Der
         * Erkenner läuft dabei mit (beide sind als gleichzeitig angemeldet),
         * bewegt nichts — und läse am Ende trotzdem die Geschwindigkeit des
         * Listen-Wischs als Abwurf.
         */
        const displaced = y.value > rest + 0.5;
        if (dy > DISMISS_DISTANCE || (displaced && e.velocityY > DISMISS_VELOCITY)) {
          if (drive) {
            /**
             * Die Bewegung SOFORT von hier, auf dem UI-Strang.
             *
             * Der Finger ist gerade erst weg; ein Umweg über den JS-Strang
             * liegt genau dazwischen und ist als kurzes Stocken zu spüren —
             * dieselbe Stelle, an der die Schublade des Bo-Screens hakte.
             * Wer `drive: false` setzt, MUSS die Ausfahrt anderswo im selben
             * Bild anstoßen; sonst ist genau dieses Stocken wieder da.
             */
            const dist =
              (travelSv ? travelSv.value : travelConst) ||
              Dimensions.get("window").height;
            y.value = withTiming(dist, SWIPE_OUT);
            // Anmelden wie jede andere Fahrt: An `markSheetMoving` hängt der
            // Riegel, der eine GPU-Textur nicht mitten in der Bewegung
            // abreißen lässt.
            runOnJS(markSheetMoving)(SWIPE_OUT.duration);
          }
          runOnJS(onDismiss)(SWIPE_OUT.duration, y.value);
          return;
        }
        settleBack(y, rest);
      })
      /**
       * Auch der ABBRUCH gehört zurückgeholt.
       *
       * Springt mitten im Ziehen ein anderer Erkenner an, kommt kein `onEnd` —
       * das Blatt bliebe schief stehen, wo der Finger es gelassen hat.
       */
      .onFinalize((_e, success) => {
        if (success) return;
        if (y.value !== rest) settleBack(y, rest);
      });

    // Gleichzeitig mit der Liste: Sonst bricht das Anspringen der einen die
    // andere ab — siehe Kopf der Datei.
    return nativeScroll ? g.simultaneousWithExternalGesture(nativeScroll) : g;
  }, [
    base,
    startY,
    drive,
    enabled,
    nativeScroll,
    onDismiss,
    rest,
    scrollRef,
    scrollY,
    travelConst,
    travelSv,
    y,
  ]);
}
