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
import { useEffect, useMemo, useState } from "react";
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
import { haptic } from "@/lib/haptics";

interface Props {
  recording: boolean;
  onPauseToggle: () => void;
  onDelete: () => void;
  onSend: () => void;
  bottomInset?: number;
  /** Real-Time-Mikrofon-Volume vom Parent (Assistant via expo-speech-
   *  recognition volumechange-Event). 0..1 normalisiert. */
  micVolumeSV: SharedValue<number>;
}

const C = {
  panel: "#1F1F20",
  border: "#2E2E30",
  red: "#FF3B30",
  white: "#FFFFFF",
  gray: "#8A8A90",
  surface3: "#323234",
};

const PITCH = 6;
const BAR_W = 3;
/** Halbe Höhe — Balken extendieren von -HALF_H bis +HALF_H um die Mittellinie. */
const HALF_H = 17;
/** Minimaler Stub auch bei Stille, damit Wellenform nicht komplett verschwindet. */
const MIN_AMP = 0.06;
/** Sample-Cadence: einmal pro TICK_MS schreiben wir die aktuelle Volume in den Buffer. */
const TICK_MS = 80;

/* ──── Bar — symmetrisch um die Mittellinie, scaleY = amp ────────── */

interface BarProps {
  index: number;
  total: number;
  bufSV: SharedValue<number[]>;
  phase: SharedValue<number>;
  color: string;
}

function Bar({ index, total, bufSV, phase, color }: BarProps) {
  const opacity = 0.5 + 0.5 * ((index + 1) / total);

  const style = useAnimatedStyle(() => {
    "worklet";
    const sub = phase.value - Math.floor(phase.value);
    const buf = bufSV.value;
    // Bar index 0 = ganz links (älteste Samples), total-1 = ganz rechts
    // (neueste). Buffer wächst am Ende.
    const head = buf.length - 1;
    const sampleIdx = head - (total - 1 - index);
    const raw = sampleIdx >= 0 ? buf[sampleIdx] ?? 0 : 0;
    const amp = Math.max(MIN_AMP, Math.min(1, raw));
    return {
      transform: [
        { translateX: -sub * PITCH },
        { scaleY: amp },
      ],
    };
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

function Waveform({
  recording,
  micVolumeSV,
}: {
  recording: boolean;
  micVolumeSV: SharedValue<number>;
}) {
  const accent = useAccent();
  const [width, setWidth] = useState(0);
  const total = useMemo(
    () => (width > 0 ? Math.ceil(width / PITCH) + 2 : 0),
    [width],
  );

  const bufSV = useSharedValue<number[]>([]);
  const phase = useSharedValue(0);
  const lastSampleTs = useSharedValue(0);
  const lastFrameTs = useSharedValue(0);

  // Recording-State auf UI-Thread spiegeln damit die Frame-Callback (worklet)
  // ihn lesen kann.
  const recordingSV = useSharedValue(recording);
  useEffect(() => {
    recordingSV.value = recording;
  }, [recording, recordingSV]);

  useFrameCallback((info) => {
    "worklet";
    const ts = info.timestamp;
    if (lastFrameTs.value === 0) {
      lastFrameTs.value = ts;
      lastSampleTs.value = ts;
      return;
    }
    const dt = ts - lastFrameTs.value;
    lastFrameTs.value = ts;
    if (!recordingSV.value) return;

    // Phase wächst kontinuierlich → smoothes sub-Pitch Scrolling.
    phase.value = phase.value + dt / TICK_MS;

    // Sample alle TICK_MS einen neuen Volume-Wert in den Buffer schreiben.
    if (ts - lastSampleTs.value >= TICK_MS) {
      lastSampleTs.value = ts;
      const v = micVolumeSV.value;
      const next = [...bufSV.value, v];
      // Buffer-Cap: nur die letzten ~maxBars Samples behalten.
      const cap = total + 2;
      if (cap > 0 && next.length > cap) next.splice(0, next.length - cap);
      bufSV.value = next;
    }
  }, true);

  return (
    <View style={styles.waveClip} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {/* Mittellinie (subtil) als Referenz für die +/- Auslenkung */}
      <View style={[styles.centerLine, { backgroundColor: accent.solid, opacity: 0.15 }]} />
      {total > 0
        ? Array.from({ length: total }).map((_, i) => (
            <Bar
              key={i}
              index={i}
              total={total}
              bufSV={bufSV}
              phase={phase}
              color={accent.solid as string}
            />
          ))
        : null}
    </View>
  );
}

/* ──── Pulsierender Aufnahme-Dot ─────────────────────────────────── */

function RecordingDot({ recording }: { recording: boolean }) {
  const accent = useAccent();
  const op = useSharedValue(1);

  useEffect(() => {
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
  }, [recording, op]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: op.value }));
  return (
    <Animated.View style={[styles.dot, { backgroundColor: accent.solid }, dotStyle]} />
  );
}

/* ──── Haupt-Komponente ──────────────────────────────────────────── */

export function VoiceRecordBar({
  recording,
  onPauseToggle,
  onDelete,
  onSend,
  bottomInset = 12,
  micVolumeSV,
}: Props) {
  const accent = useAccent();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  return (
    <View style={[styles.panel, { paddingBottom: bottomInset }]}>
      <View style={styles.topRow}>
        <View style={styles.timeBox}>
          <RecordingDot recording={recording} />
          <Text style={styles.time}>{fmtTime(seconds)}</Text>
        </View>
        <Waveform recording={recording} micVolumeSV={micVolumeSV} />
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

const styles = StyleSheet.create({
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
  centerLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: HALF_H - 0.5,
    height: 1,
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
