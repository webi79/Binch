/**
 * VoiceRecordBar — Sprachnachrichten-Aufnahme-UI für den Bo-Chat.
 *
 * Wellenform-Architektur:
 *  - Real-Time Volume kommt vom Mic via expo-speech-recognition'
 *    volumechange-Event und liegt in `micVolumeSV` (parent-supplied,
 *    SharedValue<number>, 0..1 normalisiert).
 *  - `useFrameCallback` sampled diesen Wert auf einem festen Raster
 *    (TICK_MS) und schreibt ihn in `bufSV` (Ring-Buffer). Phase wird
 *    parallel für Sub-Tick translateX (smoothes Scrolling) geführt.
 *  - Jeder Bar liest bufSV[index] und rendert seine Amplitude SYMMETRISCH
 *    nach oben UND unten von einer Center-Linie (Y-Achse +/-).
 *  - Bei recording=false friert der Sampler ein — Balken halten ihre
 *    letzten Werte.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Trash2, ArrowRight } from "lucide-react-native";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

interface Props {
  recording: boolean;
  /**
   * Alles Laufende anhalten — für die Dauer einer Fahrt.
   *
   * Diese Leiste ist während einer Aufnahme der teuerste Dauerläufer im
   * Assistenten: ein Worklet im Bild-Takt (der Sampler), ein Endlos-Pulsieren
   * am Aufnahme-Punkt und ein Sekunden-Takt, der die Leiste jede Sekunde neu
   * rendert. Schließt man den Assistenten währenddessen, liegt über dem Baum
   * eine GPU-Textur — und was sich darunter bewegt, macht sie in jedem Bild
   * ungültig. Dieselbe Begründung wie bei Bos Pause und den Tipp-Punkten.
   *
   * Die Aufnahme selbst läuft weiter; angehalten wird nur ihre Darstellung.
   */
  paused?: boolean;
  onPauseToggle: () => void;
  onDelete: () => void;
  onSend: () => void;
  bottomInset?: number;
  /** Real-Time-Mikrofon-Volume vom Parent (Assistant via expo-speech-
   *  recognition volumechange-Event). 0..1 normalisiert. */
  micVolumeSV: SharedValue<number>;
}

const C = {
  panel: "#171719",
  border: "#212123",
  red: "#FF3B30",
  white: "#F4F4F5",
  gray: "#8E8E93",
  surface3: "#212123",
};

/**
 * Maße der Balken — nach Vorlage.
 *
 * Vorher 3 Punkt breit im 6er-Raster: Das ergab eine feine Schraffur, in der
 * die einzelnen Balken kaum als solche zu lesen waren. 4 im 8er-Raster heißt
 * gleich viel Balken wie Lücke — dadurch wird jeder einzelne als Strich
 * erkennbar, so wie in der Vorlage.
 */
const PITCH = 8;
const BAR_W = 4;
/** Halbe Höhe — Balken reichen von -HALF_H bis +HALF_H um die Mitte. */
const HALF_H = 20;
/**
 * Auch bei Stille bleibt ein Stummel stehen. Höher als zuvor (0.06): Bei einem
 * kräftigeren Balken liest sich ein zu kurzer Stummel als Punkt, nicht als
 * Strich — und die Spur soll durchgehend als Spur erkennbar bleiben.
 */
const MIN_AMP = 0.14;
/**
 * Wie lange ein Balken lebt — und damit, wie schnell die Spur läuft.
 *
 * Ein Balken je `TICK_MS`, und die Spur wandert in derselben Zeit um eine
 * Rasterbreite. Von 80 auf 160 heißt also: halbes Tempo, und jeder Balken deckt
 * die doppelte Zeit ab. Weil in dieser Zeit die LAUTESTE Stelle festgehalten
 * wird (siehe `peak`), geht dabei keine Silbe verloren.
 */
const TICK_MS = 160;


/* ──── Bar — symmetrisch um die Mittellinie, scaleY = amp ────────── */

interface BarProps {
  index: number;
  total: number;
  bufSV: SharedValue<number[]>;
  color: string;
}

/**
 * DIE VERSCHIEBUNG IST BEI ALLEN BALKEN DIESELBE — sie gehört nach oben.
 *
 * Jeder Balken hatte einen eigenen Auswerter, der `phase` las. `phase` wächst in
 * JEDEM Bild (Bild-Rückruf), also liefen bei rund 330 Punkt Breite etwa 57
 * Auswerter plus 57 native Aktualisierungen pro Bild — für eine Verschiebung,
 * die überall gleich ist. Unterschiedlich ist nur die Höhe, und die ändert sich
 * bloß alle 80ms.
 *
 * Jetzt trägt der gemeinsame Rahmen die Verschiebung (ein Auswerter, der
 * `phase` liest), und die Balken lesen nur noch `bufSV`. Sichtbar ändert sich
 * nichts — es ist dieselbe Bewegung, nur einmal statt 57-mal gerechnet.
 */
function Bar({ index, total, bufSV, color }: BarProps) {
  const opacity = 0.5 + 0.5 * ((index + 1) / total);

  const style = useAnimatedStyle(() => {
    "worklet";
    const buf = bufSV.value;
    // Bar index 0 = ganz links (älteste Samples), total-1 = ganz rechts
    // (neueste). Buffer wächst am Ende.
    const head = buf.length - 1;
    const sampleIdx = head - (total - 1 - index);
    const raw = sampleIdx >= 0 ? buf[sampleIdx] ?? 0 : 0;
    /**
     * Der Nachbar zieht mit — ein Balken springt nicht aus dem Nichts.
     *
     * Jeder Wert ist die lauteste Stelle seines Zeitfensters, und zwischen zwei
     * Fenstern kann das weit auseinanderliegen. Gemittelt mit dem vorherigen
     * bleibt der Ausschlag erhalten, die Spur liest sich aber als Kurve statt
     * als Zaun.
     */
    const prev = sampleIdx - 1 >= 0 ? buf[sampleIdx - 1] ?? raw : raw;
    const amp = Math.max(MIN_AMP, Math.min(1, raw * 0.7 + prev * 0.3));
    /**
     * `scaleY` um die MITTE — der Balken füllt die volle Höhe des Ausschnitts
     * und wird von seinem Mittelpunkt aus gestaucht. Er wächst dadurch von
     * selbst gleich weit nach oben wie nach unten; eine Mittellinie oder zwei
     * getrennte Hälften braucht es dafür nicht.
     */
    return { transform: [{ scaleY: amp }] };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.barBase,
        {
          left: index * PITCH,
          width: BAR_W,
          height: HALF_H * 2,
          backgroundColor: color,
          opacity,
        },
        style,
      ]}
    />
  );
}

/* ──── Waveform — Sampler + Bars ─────────────────────────────────── */

/**
 * Wird auch vom neuen Mikrofon-Kasten benutzt (`MicBox`) — deshalb ausgeführt.
 * Es gibt bewusst nur EINE Wellenform in der App; diese Datei ist ihr Ort,
 * auch wenn der Rest darin gerade nicht eingebaut ist.
 */
export const Waveform = memo(function Waveform({
  recording,
  paused,
  micVolumeSV,
}: {
  recording: boolean;
  paused: boolean;
  micVolumeSV: SharedValue<number>;
}) {
  const accent = useAccent();
  const [width, setWidth] = useState(0);
  const total = useMemo(
    () => (width > 0 ? Math.ceil(width / PITCH) + 2 : 0),
    [width],
  );

  const bufSV = useSharedValue<number[]>([]);
  /**
   * Lautester Wert SEIT dem letzten Balken — nicht der Wert im Augenblick des
   * Abtastens.
   *
   * Das Mikrofon meldet etwa alle 100ms, abgetastet wird alle 80ms: Ein
   * Momentwert verpasst damit regelmäßig genau die Spitze einer Silbe, und die
   * Spur wirkt teilnahmslos. Über das Maximum zwischen zwei Balken landet jede
   * Silbe in der Spur — das ist der Unterschied zwischen „zappelt zufällig" und
   * „reagiert auf die Stimme".
   */
  const peak = useSharedValue(0);
  const phase = useSharedValue(0);
  /** Bei welchem ganzen Schritt der letzte Balken entstanden ist. */
  const lastStep = useSharedValue(0);
  const lastFrameTs = useSharedValue(0);

  // Recording-State auf UI-Thread spiegeln damit die Frame-Callback (worklet)
  // ihn lesen kann.
  const recordingSV = useSharedValue(recording);
  useEffect(() => {
    recordingSV.value = recording;
  }, [recording, recordingSV]);

  const frameCb = useFrameCallback((info) => {
    "worklet";
    const ts = info.timestamp;
    if (lastFrameTs.value === 0) {
      lastFrameTs.value = ts;
      return;
    }
    const dt = ts - lastFrameTs.value;
    lastFrameTs.value = ts;
    if (!recordingSV.value) return;

    // Phase wächst kontinuierlich → smoothes sub-Pitch Scrolling.
    phase.value = phase.value + dt / TICK_MS;

    // Zwischen zwei Balken die lauteste Stelle festhalten.
    if (micVolumeSV.value > peak.value) peak.value = micVolumeSV.value;

    /**
     * Ein neuer Balken entsteht GENAU dann, wenn die Phase einen ganzen Schritt
     * weiter ist — nicht nach einer eigenen Stoppuhr.
     *
     * Das war das Zittern: Die Verschiebung lief über `phase`, der neue Balken
     * über einen Zeitvergleich. Zwei Uhren für dieselbe Sache, und zwischen
     * ihnen sammelte sich ein Bruchteil an. Der Streifen sprang beim Weiterzählen
     * mal etwas zu früh, mal etwas zu spät zurück — sichtbar als Ruckeln, obwohl
     * beide für sich gleichmäßig liefen.
     *
     * Ein Schritt, eine Quelle: Jetzt fällt der Rücksprung der Verschiebung
     * exakt auf den neuen Balken.
     */
    const step = Math.floor(phase.value);
    if (step > lastStep.value) {
      lastStep.value = step;
      const v = peak.value;
      peak.value = micVolumeSV.value;
      const next = [...bufSV.value, v];
      // Buffer-Cap: nur die letzten ~maxBars Samples behalten.
      const cap = total + 2;
      if (cap > 0 && next.length > cap) next.splice(0, next.length - cap);
      bufSV.value = next;
    }
  }, true);

  // Nur laufen lassen, wenn wirklich aufgenommen wird.
  //
  // `useFrameCallback` startet standardmäßig sofort und feuert dann JEDES Bild —
  // auch ohne Aufnahme. Solange der Assistent offen war, hing damit dauerhaft ein
  // Worklet im Bild-Takt, das nichts zu tun hatte.
  useEffect(() => {
    // `paused` hält ihn auch für die Dauer einer Fahrt an — siehe dort. Die
    // Balken behalten dabei ihre letzten Werte, genau wie beim Pausieren der
    // Aufnahme.
    const active = recording && !paused;
    /**
     * Beim Anhalten den Zeitstempel löschen.
     *
     * Ohne das rechnet der erste Bild-Rückruf nach dem Fortsetzen die GANZE
     * Pause in `dt` — die Spur springt dann um so viele Balken weiter, wie die
     * Pause lang war, und der Ton dazu fehlt. Bei zehn Sekunden Pause ist die
     * sichtbare Historie damit in einem Bild weg.
     */
    if (!active) lastFrameTs.value = 0;
    frameCb.setActive(active);
  }, [frameCb, recording, paused, lastFrameTs]);

  const scrollStyle = useAnimatedStyle(() => {
    "worklet";
    const sub = phase.value - Math.floor(phase.value);
    /**
     * Bewusst NICHT auf ganze Pixel gerundet.
     *
     * Beim Kartenstapel war das Runden richtig — dort ruht die Fläche am Ende.
     * Hier rollt sie dauerhaft, und zwar langsam: rund ein Achtel Pixel je Bild.
     * Gerundet stünde der Streifen sechs Bilder still und spränge dann um ein
     * ganzes — das wäre erst recht ein Ruckeln.
     */
    return { transform: [{ translateX: -sub * PITCH }] };
  });

  return (
    <View style={styles.waveClip} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {/* Der gemeinsame Rahmen trägt die Verschiebung — siehe Begründung an `Bar`. */}
      <Animated.View style={[StyleSheet.absoluteFill, scrollStyle]} pointerEvents="none">
        {total > 0
          ? Array.from({ length: total }).map((_, i) => (
              <Bar
                key={i}
                index={i}
                total={total}
                bufSV={bufSV}
                color={accent.solid as string}
              />
            ))
          : null}
      </Animated.View>
    </View>
  );
});

/* ──── Pulsierender Aufnahme-Dot ─────────────────────────────────── */

function RecordingDot({
  recording,
  paused,
}: {
  recording: boolean;
  paused: boolean;
}) {
  const accent = useAccent();
  const op = useSharedValue(1);

  useEffect(() => {
    // Für die Dauer einer Fahrt hart auf voll — kein Ausblenden, das wäre
    // wieder eine Animation unter der Textur.
    if (paused) {
      cancelAnimation(op);
      op.value = 1;
      return;
    }
    if (!recording) {
      cancelAnimation(op);
      op.value = withTiming(0.4, { duration: 200 });
      return;
    }
    op.value = withRepeat(
      withSequence(
        withTiming(0.25, { duration: 550, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 550, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(op);
  }, [recording, paused, op]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.View style={[styles.dot, { backgroundColor: accent.solid }, dotStyle]} />
  );
}

/* ──── Haupt-Komponente ──────────────────────────────────────────── */

export function VoiceRecordBar({
  recording,
  paused = false,
  onPauseToggle,
  onDelete,
  onSend,
  bottomInset = 12,
  micVolumeSV,
}: Props) {
  const accent = useAccent();
  const palette = usePalette();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // Nicht während einer Fahrt: Der Takt rendert diese Leiste neu, und das ist
    // ein Commit mitten in die Bewegung. Sichtbar ist davon nichts — die
    // Anzeige steht höchstens eine knappe halbe Sekunde still, und zwar
    // während der Bildschirm ohnehin wegfährt.
    if (!recording || paused) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording, paused]);

  return (
    <View style={[styles.panel, { backgroundColor: palette.s1, borderColor: palette.border }, { paddingBottom: bottomInset }]}>
      <View style={styles.topRow}>
        <View style={styles.timeBox}>
          <RecordingDot recording={recording} paused={paused} />
          <Text style={styles.time}>{fmtTime(seconds)}</Text>
        </View>
        <Waveform recording={recording} paused={paused} micVolumeSV={micVolumeSV} />
      </View>

      <View style={styles.actionRow}>
        <Pressable
          onPress={() => {
            haptic("button");
            onDelete();
          }}
          hitSlop={10}
          style={styles.iconBtn}
          accessibilityLabel="Verwerfen"
        >
          <Trash2 size={22} color={C.gray} strokeWidth={1.8} />
        </Pressable>

        <Pressable
          onPress={() => {
            haptic("button");
            onPauseToggle();
          }}
          style={styles.pauseBtn}
          accessibilityLabel={recording ? "Pause" : "Weiter"}
        >
          {recording ? (
            <View style={styles.pauseGlyph}>
              <View style={styles.pauseBar} />
              <View style={styles.pauseBar} />
            </View>
          ) : (
            <View style={styles.playGlyph} />
          )}
        </Pressable>

        <Pressable
          onPress={() => {
            haptic("important");
            onSend();
          }}
          style={[styles.sendBtn, { backgroundColor: accent.solid }]}
          accessibilityLabel="Senden"
        >
          <ArrowRight size={22} color={accent.textOnSolid} strokeWidth={2.2} />
        </Pressable>
      </View>
    </View>
  );
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `${m}:${ss}`;
}

const styles = scaledStyles({
  panel: {
    backgroundColor: C.panel,
    borderTopWidth: 1,
    borderTopColor: C.border,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 22,
  },
  topRow: { flexDirection: "row", alignItems: "center" },
  timeBox: { flexDirection: "row", alignItems: "center", marginRight: 16 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 9 },
  time: {
    fontSize: 26,
    fontWeight: "700",
    color: C.white,
    letterSpacing: -0.5,
    fontVariant: ["tabular-nums"],
  },
  waveClip: {
    flex: 1,
    height: HALF_H * 2,
    overflow: "hidden",
    justifyContent: "center",
  },
  barBase: {
    position: "absolute",
    top: 0,
    borderRadius: BAR_W,
  },

  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
  },
  iconBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },

  pauseBtn: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: C.red,
    alignItems: "center",
    justifyContent: "center",
  },
  pauseGlyph: { flexDirection: "row", gap: 4 },
  pauseBar: { width: 5, height: 20, borderRadius: 2, backgroundColor: C.white },
  playGlyph: {
    marginLeft: 4,
    width: 0,
    height: 0,
    borderTopWidth: 11,
    borderBottomWidth: 11,
    borderLeftWidth: 18,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: C.white,
  },

  sendBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
});
