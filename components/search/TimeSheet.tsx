/**
 * TimeSheet — die Abfahrtszeit als Blatt von unten.
 *
 * Vorher war das ein mittiger Dialog mit Ein- und Ausblenden. Damit war es die
 * einzige Auswahl des Such-Screens, die NICHT von unten hereinfährt: Reisende
 * und Klasse tun es, das Ticket-Blatt im Saved-Tab tut es. Der Weg dorthin ist
 * deshalb kein Nachbau, sondern dieselbe Hülle — `SheetModal`. Bewegung, Kurve,
 * Dauer (300ms herein, 260ms hinaus), Verdunkelung, Wisch-Geste und
 * Zurück-Taste kommen von dort und ändern sich mit, wenn sie sich dort ändern.
 *
 * Übernommen wird wie bei den Geschwister-Blättern erst, wenn das Blatt UNTEN
 * ist (siehe `TravelOptionsSheets`): Der Datumswähler dahinter rendert bei einer
 * neuen Uhrzeit seine Fußzeile neu, und dieser Durchgang fiele sonst mitten in
 * die Ausfahrt.
 *
 * ── Das Rad ist KEINE Scroll-Ansicht ───────────────────────────────────────
 *
 * Erster Versuch war eine `FlatList` mit vielfach wiederholten Werten und einem
 * Rücksprung in die Mitte. Drei Fehler auf einmal, alle aus derselben Wurzel:
 * Der Stand des Rades lag im Nativen, und die Anzeige hing an einem Wert, der
 * ihm nur HINTERHERLIEF.
 *
 *  1. Die Liste stellt ihren Anfangsstand selbst ein — nach dem ersten Layout,
 *     also mitten in der Einfahrt. Beim geteilten Wert kam das nicht (oder zu
 *     spät) an: Die Uhrzeit oben stimmte mit der unter der Bande nicht überein.
 *  2. Bis zum ersten eigenen Wischen blieb dieser Wert stehen — und weil die
 *     Helligkeit einer Zeile aus dem ABSTAND zu ihm kam, war alles blass. Nach
 *     dem ersten Wischen dann immer noch das Rad, das man nicht angefasst hatte.
 *  3. Die Virtualisierung arbeitet nach dem Aufbau weiter: Zellen nachreichen,
 *     Fenster nachziehen, Anfangssprung. Jeder dieser Schritte ist ein Commit
 *     von React — und der hält Reanimateds eigene Commits an. Genau in den
 *     300ms der Einfahrt. Das war das Haken beim Hereinfahren.
 *
 * Jetzt gibt es weder Liste noch Scroll-Ansicht. Der Stand des Rades IST ein
 * geteilter Wert (`offset`, in Punkten), die Zahlenspalte steht fest im Baum und
 * wird als Ganzes verschoben, und der Finger schreibt den Wert unmittelbar auf
 * dem UI-Strang. Die Anzeige oben ist damit keine Kopie des Standes mehr,
 * sondern dieselbe Zahl: Auseinanderlaufen kann da nichts.
 *
 * Endlos ist es aus demselben Grund geschenkt: Verschoben wird um `offset`
 * MODULO einer Runde. Die Spalte enthält drei Runden, der Sprung um eine ganze
 * Runde ist unsichtbar (dieselben Zahlen an derselben Stelle), und einen
 * Anschlag gibt es nicht — `offset` darf beliebig weit laufen.
 *
 * Kosten je Bild: eine Verschiebung je Rad. Kein Commit, keine Vermessung,
 * keine Zelle, die nachgereicht wird.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import { SheetModal } from "@/components/ui/SheetModal";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { primeTick, releaseTick, wheelTick } from "@/lib/ui/tick";
import { fs, ms, scaledStyles } from "@/lib/ui/compact";

/**
 * Die Vorgabe — dieselbe, auf die der Datumswähler beim Schließen zurückfällt.
 * Modulweit, damit „Zurücksetzen" hier und das Zurücksetzen dort nicht
 * auseinanderlaufen können.
 */
export const DEFAULT_TIME = { hour: 9, minute: 30 };

/** Ungerade — sonst läge keine Zeile in der Mitte. */
const VISIBLE = 5;
/**
 * Zeilenhöhe: EINE Zahl für Stil und Rechnung.
 *
 * Und deshalb hier schon heruntergerechnet (`ms`) statt über `scaledStyles`:
 * Das Stilblatt skaliert `height` mit, die Rechnung im Worklet bekäme aber die
 * rohe Zahl — auf einem kurzen Bildschirm liefen Zeile und Rastung auseinander.
 * Genau dieser Fehler steckte im alten Rad im Datumswähler.
 */
const ITEM = ms(52);
const WHEEL_H = ITEM * VISIBLE;
/**
 * Sichtbare Zeilen plus eine Reserve nach oben und unten — so viele stehen beim
 * Aufbau des Blattes im Baum, mehr nicht (siehe `rows` im Rad).
 */
const EDGE = (VISIBLE - 1) / 2 + 1;
/**
 * DREI Runden stehen im Baum, und der Versatz ist genau EINE davon.
 *
 * Verschoben wird um `offset` modulo einer Runde; das Sichtfenster liegt damit
 * immer in der mittleren Runde — mit einer vollen Runde Luft nach oben und nach
 * unten, sichtbar sind höchstens zweieinhalb Zeilen.
 *
 * Warum eine ganze Runde und nicht eine halbe (die als Vorrat gereicht hätte):
 * Zeile `i` zeigt `values[i % len]`. Ein Versatz um eine halbe Runde verschiebt
 * damit nicht nur die Lage, sondern auch den WERT — bei 24 Stunden um zwölf.
 * Ein Versatz um ein Vielfaches der Runde lässt ihn unberührt. Genau diese
 * Verwechslung wäre sonst wieder eine Uhrzeit, die nicht stimmt.
 */
const CYCLES = 3;
/**
 * Höhe der Ausblendung an beiden Enden — genau die zwei Zeilen neben der Bande.
 *
 * Daraus kommt die Abstufung: Der Verlauf läuft von der Kante des Kastens (voll
 * gedeckt) bis an die Bande (klar). Die Zahl direkt neben der Auswahl steht
 * damit bei rund drei Vierteln, die äußerste bei einem Viertel — weiß, heller
 * Grauton, dunkler Grauton.
 *
 * Und weil das aus der LAGE kommt und nicht aus dem Wert, kann es nicht wieder
 * passieren, dass ein ganzes Rad abdunkelt, nur weil man das andere anfasst.
 */
const FADE_H = ITEM * 2;

/**
 * EINE Bewegung vom Finger bis zur Ruhe — nicht zwei.
 *
 * Vorher lief erst ein Auslaufen (`withDecay`) und danach ein Einrasten auf die
 * nächste Zeile. Das Auslaufen endet aber erst, wenn die Geschwindigkeit unter
 * 1 Punkt je Sekunde fällt — das Rad steht also praktisch schon, und GENAU DANN
 * kam der Ruck über bis zu einer halben Zeile. Das war das harte Abbremsen am
 * Ende: nicht das Auslaufen, sondern das, was danach kam.
 *
 * Jetzt wird beim Loslassen ausgerechnet, wo das Rad von selbst zur Ruhe käme,
 * diese Stelle auf die nächste Zeile gerundet — und dorthin führt eine einzige
 * Bewegung, die mit der Geschwindigkeit des Fingers losläuft und bei null
 * ankommt. Die Zahl gleitet in ihre Endlage, statt hineinzuspringen.
 */
/** Weg eines Wisches: Geschwindigkeit × diese Zeit (in Sekunden). */
const GLIDE_TRAVEL = 0.4;
/**
 * Bei `Easing.out(Easing.cubic)` ist die Anfangsgeschwindigkeit das Dreifache
 * der Durchschnittsgeschwindigkeit. Aus `Dauer = 3 × Weg / Geschwindigkeit`
 * läuft die Bewegung deshalb exakt so schnell an, wie der Finger sie verlassen
 * hat — der Übergang ist nicht zu sehen.
 */
const GLIDE_SLOPE = 3;
const GLIDE_EASE = Easing.out(Easing.cubic);
const GLIDE_MIN_MS = 170;
const GLIDE_MAX_MS = 1400;
/** Darunter war es kein Wisch, sondern ein Loslassen: nur noch einrasten. */
const FLING_MIN_SPEED = 60;
const SETTLE = { duration: 240, easing: Easing.out(Easing.cubic) } as const;
/** „Zurücksetzen" fährt sichtbar auf die Vorgabe. */
const SPIN = { duration: 320, easing: Easing.out(Easing.cubic) } as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));

/**
 * Der Wert unter der Bande — aus dem Stand des Rades.
 *
 * Als Worklet UND als gewöhnliche Funktion brauchbar: Auf dem UI-Strang
 * schreibt sie die Kopfzeile, auf dem JS-Strang liest sie das „Übernehmen".
 * Beide bekommen damit garantiert dieselbe Zahl.
 */
function valueAt(values: number[], offset: number): number {
  "worklet";
  const len = values.length;
  const i = Math.round(offset / ITEM);
  return values[((i % len) + len) % len]!;
}

/** Nächstgelegener vorhandener Wert — Minuten kommen in 5er-Schritten, die
 *  Vorbelegung aus einer Suche oder einem Sprachbefehl aber nicht. */
function nearest(values: number[], v: number): number {
  let best = values[0]!;
  let bestD = Math.abs(best - v);
  for (const x of values) {
    const d = Math.abs(x - v);
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

/**
 * Auf einen Wert fahren — auf dem KÜRZEREN Weg.
 *
 * Ohne das führe „Zurücksetzen" von der 23 auf die 9 einmal quer durch den
 * ganzen Tag zurück, obwohl zehn Zeilen vorwärts genügen. Der Stand darf dabei
 * über die Runde hinauslaufen; gerechnet wird ohnehin modulo.
 */
function spinTo(offset: SharedValue<number>, values: number[], target: number) {
  const len = values.length;
  const k = values.indexOf(target);
  if (k < 0) return;
  const cur = Math.round(offset.value / ITEM);
  let delta = k - (((cur % len) + len) % len);
  if (delta > len / 2) delta -= len;
  if (delta < -len / 2) delta += len;
  if (delta === 0) return;
  offset.value = withTiming((cur + delta) * ITEM, SPIN);
}

/* ---------------------------------------------------------------------- Rad */

/**
 * Eine Spalte. Die Zahlen stehen fest im Baum — drei Runden, einmal gebaut —,
 * bewegt wird ausschließlich die Spalte als Ganzes.
 */
function Wheel({
  values,
  offset,
  label,
}: {
  values: number[];
  offset: SharedValue<number>;
  label: string;
}) {
  const len = values.length;
  const cycle = len * ITEM;

  /**
   * Erst NUR das Sichtfenster, alles andere kommt nach der Einfahrt.
   *
   * Jede Zahl ist ein Textknoten, und jeder muss vermessen und zum ersten Mal
   * gerastert werden. Über beide Räder wären das 108 Stück, alle in dem
   * Durchgang, der das Fenster öffnet — also unmittelbar vor der Einfahrt, und
   * beim ERSTEN Öffnen zusätzlich mit kaltem Schrift-Zwischenspeicher. Genau da
   * saß das Stottern beim ersten Mal.
   *
   * Zu sehen sind fünf Zeilen. Gebaut werden sieben (eine Reserve nach oben und
   * unten), macht 14 über beide Räder statt 108. Der Rest kommt 360ms später
   * oder beim Aufsetzen des Fingers, je nachdem, was zuerst kommt.
   *
   * Der Platzhalter oben hält die Lage: Die Zeilen stehen dadurch schon jetzt
   * genau dort, wo sie mit allen drei Runden stehen werden — das Nachrüsten
   * verschiebt nichts, es hängt nur oben und unten an.
   */
  const [full, setFull] = useState(false);
  const expanded = useRef(false);
  const expand = useCallback(() => {
    if (expanded.current) return;
    expanded.current = true;
    setFull(true);
    // Der Ton kommt aus einem Decoder, und der wird hier angelegt: nach der
    // Einfahrt oder beim Aufsetzen des Fingers, nie im Öffnungs-Durchgang.
    primeTick();
  }, []);
  useEffect(() => {
    // Nach der Einfahrt (300ms) plus Rand. Zu diesem Zeitpunkt bewegt sich
    // nichts mehr, der Durchgang stört also keine Bewegung.
    const id = setTimeout(expand, 360);
    return () => clearTimeout(id);
  }, [expand]);

  /**
   * Die oberste gebaute Zeile beim Aufbau.
   *
   * Verschoben wird um `offset` modulo einer Runde plus einer Runde Versatz —
   * beim Aufbau steht also die Zeile `len + Startwert` in der Mitte. Einmal
   * bestimmt und danach unveränderlich: Gebaut wird hier nur der Anfang, den
   * das Nachrüsten ohnehin ablöst.
   */
  const [firstRow] = useState(() => {
    const i = Math.round(offset.value / ITEM);
    const centered = len + (((i % len) + len) % len);
    return Math.max(0, centered - EDGE);
  });

  const rows = useMemo(() => {
    const out = [];
    // Über den Schlüssel: Beim Nachrüsten behalten die schon gebauten Zeilen
    // ihre Kennung und damit ihren Knoten — gebaut wird nur, was fehlt.
    if (!full) out.push(<View key="pad" style={{ height: firstRow * ITEM }} />);
    const from = full ? 0 : firstRow;
    const to = full ? len * CYCLES : Math.min(len * CYCLES, firstRow + 2 * EDGE + 1);
    for (let i = from; i < to; i++) {
      out.push(
        <View key={i} style={w.row}>
          <Text style={w.rowTxt}>{pad2(values[i % len]!)}</Text>
        </View>,
      );
    }
    return out;
  }, [values, len, firstRow, full]);

  const style = useAnimatedStyle(() => {
    /**
     * Modulo einer Runde, eine Runde versetzt in die Mitte der drei. Der Sprung
     * am Rundenende verschiebt die Spalte um genau eine Runde — dieselben
     * Zahlen an derselben Stelle, zu sehen ist nichts.
     */
    const p = (((offset.value % cycle) + cycle) % cycle) + cycle;
    return { transform: [{ translateY: WHEEL_H / 2 - ITEM / 2 - p }] };
  });

  /**
   * Eine Zahl weiter — Klick und Stups.
   *
   * Der Vergleich läuft im Bild-Takt auf dem UI-Strang und ist nicht mehr als
   * eine Rundung; gemeldet wird nur der Wechsel. Die Rückmeldung selbst liegt
   * auf dem JS-Strang und kann die Bewegung deshalb nicht bremsen — die läuft
   * davon unabhängig weiter.
   */
  useAnimatedReaction(
    () => Math.round(offset.value / ITEM),
    (cur, prev) => {
      if (prev === null || cur === prev) return;
      runOnJS(wheelTick)();
    },
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        // Ein Tipp soll das Rad nicht um Haaresbreite verschieben.
        .activeOffsetY([-4, 4])
        .onBegin(() => {
          // Wer ein laufendes Rad anfasst, hält es an.
          cancelAnimation(offset);
          /**
           * Und wer es überhaupt anfasst, bekommt die fehlenden Runden sofort —
           * ohne auf den Wecker zu warten. Sonst könnte ein sehr früher, sehr
           * kräftiger Wisch über die eine gebaute Runde hinausfahren und für
           * einen Moment ins Leere zeigen. Der Durchgang liegt hier beim
           * AUFSETZEN des Fingers: Da bewegt sich noch nichts.
           */
          runOnJS(expand)();
        })
        /**
         * `onChange`, nicht `onUpdate`: Der Zuwachs seit dem letzten Bild
         * braucht keinen Startwert. Mit der Gesamtverschiebung müsste man ihn
         * beim Aktivieren festhalten — und weil die Geste erst nach vier
         * Punkten anspringt, spränge das Rad in dem Moment um genau diese vier.
         */
        .onChange((e) => {
          offset.value -= e.changeY;
        })
        .onEnd((e) => {
          // Nach oben gewischt heißt: zu späteren Werten.
          const speed = -e.velocityY;
          const from = offset.value;
          // Wo käme es von selbst zur Ruhe — und welche Zeile ist das?
          const target = Math.round((from + speed * GLIDE_TRAVEL) / ITEM) * ITEM;
          const dist = Math.abs(target - from);
          const duration =
            Math.abs(speed) < FLING_MIN_SPEED
              ? SETTLE.duration
              : Math.min(
                  GLIDE_MAX_MS,
                  Math.max(GLIDE_MIN_MS, (GLIDE_SLOPE * 1000 * dist) / Math.abs(speed)),
                );
          offset.value = withTiming(target, { duration, easing: GLIDE_EASE });
        })
        /**
         * Der Fall ohne `onEnd`: antippen, um ein laufendes Rad anzuhalten.
         *
         * Die Geste springt dabei nie an (der Finger bewegt sich keine vier
         * Punkte), `onBegin` hat das Auslaufen aber schon abgebrochen. Ohne das
         * hier bliebe das Rad stehen, wo der Finger es erwischt hat — mitten
         * zwischen zwei Zahlen.
         */
        .onFinalize((_e, success) => {
          if (success) return;
          offset.value = withTiming(Math.round(offset.value / ITEM) * ITEM, SETTLE);
        }),
    [offset, expand],
  );

  return (
    <View style={w.col}>
      <Text style={w.colLabel}>{label}</Text>
      <GestureDetector gesture={pan}>
        {/* Das Sichtfenster schneidet ab — die Spalte darin ist zwei Runden
            hoch und ragte sonst über Beschriftung und Kasten hinaus. */}
        <View style={w.viewport}>
          <Animated.View style={[w.strip, style]}>{rows}</Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

/* ------------------------------------------------------- Offen: eigener Merker */

/**
 * Ob das Blatt offen ist, steht NICHT im Zustand des Datumswählers.
 *
 * Dort stand es zuerst, und das kostete beim Öffnen den teuersten Durchgang der
 * App: Der Wähler baut den Kalender mit auf — zwölf Monate, die Reiter, die
 * Schiebe-Ebenen —, und dieser Durchgang liegt unmittelbar vor der Einfahrt des
 * Blattes. Sichtbar davon ist nichts; hinter der Verdunkelung ändert sich ja
 * nichts.
 *
 * Jetzt hängt daran nur noch `TimeSheetGate` — ein Knoten, der nichts weiter
 * tut, als das Blatt ein- und auszuhängen.
 */
let sheetOpen = false;
const openListeners = new Set<() => void>();
const subscribeOpen = (l: () => void) => {
  openListeners.add(l);
  return () => {
    openListeners.delete(l);
  };
};
const getOpen = () => sheetOpen;
function setOpen(next: boolean) {
  if (sheetOpen === next) return;
  sheetOpen = next;
  for (const l of openListeners) l();
}
export const openTimeSheet = () => setOpen(true);
export const closeTimeSheet = () => setOpen(false);

/**
 * Der Knoten, der das Blatt hält. Rendert bei jedem Öffnen und Schließen — und
 * ist genau deshalb so klein.
 */
export function TimeSheetGate({
  hour,
  minute,
  minuteStep,
  onApply,
}: {
  hour: number;
  minute: number;
  minuteStep: number;
  onApply: (hour: number, minute: number) => void;
}) {
  const open = useSyncExternalStore(subscribeOpen, getOpen, getOpen);
  return (
    <TimeSheet
      visible={open}
      hour={hour}
      minute={minute}
      minuteStep={minuteStep}
      onClose={closeTimeSheet}
      onApply={onApply}
    />
  );
}

/* -------------------------------------------------------------------- Blatt */

export function TimeSheet({
  visible,
  hour,
  minute,
  minuteStep,
  onClose,
  onApply,
}: {
  visible: boolean;
  hour: number;
  minute: number;
  minuteStep: number;
  onClose: () => void;
  onApply: (hour: number, minute: number) => void;
}) {
  /** Erst unten, dann übernehmen — wie beim Reisenden- und Klassen-Blatt. */
  const applied = useRef<{ hour: number; minute: number } | null>(null);
  /** Feste Kennung: Daran hängen in der Hülle die Wisch-Geste und der Merker
   *  für die Zurück-Taste. */
  const handleClose = useCallback(() => {
    const next = applied.current;
    applied.current = null;
    onClose();
    if (next) onApply(next.hour, next.minute);
  }, [onClose, onApply]);
  return (
    <SheetModal visible={visible} onClose={handleClose}>
      {(close) => (
        <TimeBody
          hour={hour}
          minute={minute}
          minuteStep={minuteStep}
          onApply={(h, m) => {
            applied.current = { hour: h, minute: m };
            close();
          }}
        />
      )}
    </SheetModal>
  );
}

function TimeBody({
  hour,
  minute,
  minuteStep,
  onApply,
}: {
  hour: number;
  minute: number;
  minuteStep: number;
  onApply: (hour: number, minute: number) => void;
}) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();

  const minuteValues = useMemo(() => {
    const arr: number[] = [];
    for (let m = 0; m < 60; m += minuteStep) arr.push(m);
    return arr;
  }, [minuteStep]);

  /**
   * Der Stand beider Räder — die einzige Quelle für alles, was hier zu sehen
   * ist: Zahlenspalten, Kopfzeile, der blasse „Zurücksetzen"-Knopf und das, was
   * „Übernehmen" mitnimmt. Alle lesen DENSELBEN Wert, auseinanderlaufen kann da
   * nichts mehr.
   *
   * Eingerastet gestartet: Eine Vorbelegung von 14:37 gehört auf die 35, nicht
   * auf die nächstbeste Zeile.
   */
  const [start] = useState(() => ({
    hour: nearest(HOURS, hour),
    minute: nearest(minuteValues, minute),
  }));
  const hourOffset = useSharedValue(HOURS.indexOf(start.hour) * ITEM);
  const minOffset = useSharedValue(minuteValues.indexOf(start.minute) * ITEM);

  /** Die Decoder des Klicks gehören dem Blatt, nicht der ganzen Sitzung. */
  useEffect(() => releaseTick, []);

  const timeProps = useAnimatedProps<TextInputProps & { text: string }>(() => {
    "worklet";
    const h = valueAt(HOURS, hourOffset.value);
    const m = valueAt(minuteValues, minOffset.value);
    return { text: `${h < 10 ? "0" : ""}${h}:${m < 10 ? "0" : ""}${m}` };
  });

  /**
   * „Zurücksetzen" steht auf der Vorgabe? Dann blass — dieselbe Aussage wie das
   * `disabled` der Geschwister-Blätter, nur ohne Render. Gesperrt ist der Knopf
   * bewusst nicht: Ein Druck fährt dann auf die Zahl, auf der das Rad ohnehin
   * schon steht, und kostet nichts.
   */
  const resetStyle = useAnimatedStyle(() => ({
    opacity:
      valueAt(HOURS, hourOffset.value) === DEFAULT_TIME.hour &&
      valueAt(minuteValues, minOffset.value) === DEFAULT_TIME.minute
        ? 0.4
        : 1,
  }));

  return (
    <>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{t("search.time.title")}</Text>
          <Text style={styles.subtitle}>{t("search.time.subtitle")}</Text>
        </View>
        {/* Ein Textfeld, kein Text: So schreibt der UI-Strang die Zahl direkt,
            ohne den Umweg über einen Zustand. Derselbe Weg wie bei der Uhr der
            Sprachaufnahme (`MicBox`). */}
        <AnimatedTextInput
          editable={false}
          pointerEvents="none"
          underlineColorAndroid="transparent"
          defaultValue={`${pad2(start.hour)}:${pad2(start.minute)}`}
          animatedProps={timeProps}
          style={[styles.headTime, { color: accent.solid }]}
        />
      </View>

      <View style={[styles.box, { backgroundColor: palette.s2 }]}>
        {/* Die Bande liegt UNTER den Zahlen: Sie markiert die Mitte, die Zahl
            darüber muss lesbar bleiben. */}
        <View
          pointerEvents="none"
          style={[w.band, { backgroundColor: accent.subtle, borderColor: accent.border }]}
        />
        <View style={w.cols}>
          <Wheel values={HOURS} offset={hourOffset} label={t("search.time.hour")} />
          <Text style={[w.colon, { color: accent.solid }]}>:</Text>
          <Wheel
            values={minuteValues}
            offset={minOffset}
            label={t("search.time.minute")}
          />
        </View>
        {/* Oben und unten ausblenden — sonst enden die Zahlen an einer harten
            Kante statt im Hintergrund. Beide Verläufe liegen über den Zahlen,
            nehmen aber keine Berührung an. */}
        <LinearGradient
          pointerEvents="none"
          colors={[palette.s2, "transparent"]}
          style={[w.fade, w.fadeTop]}
        />
        <LinearGradient
          pointerEvents="none"
          colors={["transparent", palette.s2]}
          style={[w.fade, w.fadeBottom]}
        />
      </View>

      <View style={styles.footer}>
        <Animated.View style={resetStyle}>
          <RippleTouch
            onPress={() => {
              haptic("button");
              spinTo(hourOffset, HOURS, DEFAULT_TIME.hour);
              spinTo(minOffset, minuteValues, DEFAULT_TIME.minute);
            }}
            style={[styles.reset, { backgroundColor: palette.s2 }]}
          >
            <Text style={styles.resetText}>{t("sheet.reset")}</Text>
          </RippleTouch>
        </Animated.View>
        <RippleTouch
          onPress={() => {
            haptic("button");
            onApply(
              valueAt(HOURS, hourOffset.value),
              valueAt(minuteValues, minOffset.value),
            );
          }}
          rippleColor="rgba(0,0,0,0.32)"
          style={[styles.apply, { backgroundColor: accent.solid }]}
        >
          <Text style={[styles.applyText, { color: accent.textOnSolid }]}>
            {t("sheet.apply")}
          </Text>
        </RippleTouch>
      </View>
    </>
  );
}

/** Ein Textfeld, dessen Inhalt vom UI-Strang geschrieben werden darf. */
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

const styles = scaledStyles({
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  headText: { flex: 1, minWidth: 0 },
  title: { fontSize: 18, fontWeight: "700", color: "#F4F4F5", marginBottom: 6 },
  subtitle: { fontSize: 13, color: "#8E8E93", lineHeight: 18, marginBottom: 16 },
  /** Ohne Innenabstand und ohne die Schriftpolsterung von Android — sonst
   *  sitzt das Feld tiefer als der Titel daneben. */
  headTime: {
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.8,
    textAlign: "right",
    minWidth: 96,
    padding: 0,
    margin: 0,
    includeFontPadding: false,
    fontVariant: ["tabular-nums"],
  },

  box: { borderRadius: 24, overflow: "hidden" },

  footer: { flexDirection: "row", gap: 10, marginTop: 14 },
  reset: {
    height: 50,
    paddingHorizontal: 22,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  resetText: { fontSize: 15, fontWeight: "600", color: "#F4F4F5" },
  apply: {
    flex: 1,
    height: 50,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  applyText: { fontSize: 16, fontWeight: "700" },
});

/**
 * Die Maße des Rades stehen bewusst NICHT im skalierten Stilblatt: Sie hängen
 * alle an `ITEM`, und das ist über `ms()` schon heruntergerechnet. Ein zweites
 * Mal skaliert wären Zeilenhöhe und Rechnung wieder verschieden.
 */
const w = StyleSheet.create({
  cols: { flexDirection: "row", alignItems: "flex-end" },
  col: { flex: 1 },
  colLabel: {
    fontSize: fs(10),
    color: "#8E8E93",
    letterSpacing: 1.2,
    fontWeight: "700",
    textAlign: "center",
    textTransform: "uppercase",
    paddingTop: ms(14),
    paddingBottom: ms(6),
  },
  viewport: { height: WHEEL_H, overflow: "hidden" },
  /** Drei Runden hoch, oben angeschlagen — die Lage macht die Verschiebung. */
  strip: { position: "absolute", left: 0, right: 0, top: 0 },
  row: { height: ITEM, alignItems: "center", justifyContent: "center" },
  rowTxt: {
    fontSize: fs(26),
    fontWeight: "700",
    color: "#F4F4F5",
    fontVariant: ["tabular-nums"],
    includeFontPadding: false,
  },
  colon: {
    width: ms(18),
    textAlign: "center",
    fontSize: fs(24),
    fontWeight: "800",
    includeFontPadding: false,
    /**
     * Auf der Höhe der Bande, nicht in der Mitte der Spalte: Über den Rädern
     * steht noch die Beschriftung, und die Zeile ist unten ausgerichtet. Die
     * halbe Schrifthöhe (rund 0,58 × Schriftgröße ohne Polsterung) hebt den
     * Doppelpunkt von seiner Grundlinie auf die Mitte der Bande.
     */
    marginBottom: WHEEL_H / 2 - fs(24) * 0.58,
  },
  band: {
    position: "absolute",
    left: ms(10),
    right: ms(10),
    // Von unten gerechnet, weil über den Rädern die Beschriftung sitzt: Die
    // Bande gehört in die Mitte der RÄDER, nicht in die Mitte des Kastens.
    bottom: WHEEL_H / 2 - ITEM / 2,
    height: ITEM,
    borderRadius: ms(16),
    borderWidth: 1,
  },
  /** Die Ausblendungen decken je die äußerste Zeile der Räder ab. */
  fade: { position: "absolute", left: 0, right: 0, height: FADE_H, pointerEvents: "none" },
  fadeTop: { bottom: WHEEL_H - FADE_H },
  fadeBottom: { bottom: 0 },
});
