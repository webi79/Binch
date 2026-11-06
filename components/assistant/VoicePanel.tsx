/**
 * Das Innere des Aufnahme-Blattes (04.11.2026) — nach Googles Spracheingabe:
 * oben „Ich höre zu" mit Uhr, groß der Text, den Bo gerade versteht, darunter
 * vier Punkte, die mit der Stimme zu Balken werden (Googles vier Farben in
 * Binch-Farben: Akzent und Weiß im Wechsel). Unten Verwerfen, Senden (groß, mit
 * einem Hof, der mit der Lautstärke atmet) und Pause/Weiter.
 *
 * Alles Bewegte hängt an EINEM Bild-Rückruf auf dem UI-Strang (Takt +
 * geglättete Lautstärke); React rechnet nur, wenn sich der Text ändert. Jeder
 * Punkt ist eine Pille aus zwei runden Kappen und einem Mittelstück, das nur
 * gestreckt wird — alles Lage und Streckung, der schnelle Weg. Vorher waren es
 * SVG-Rechtecke mit animierter Höhe: auf Android ein Commit plus ein neu
 * gerastertes Bitmap in JEDEM Bild, solange man spricht (04.11.2026).
 *
 * Der Inhalt fährt MIT dem Blatt herein — nichts wird hinterher eingeblendet
 * („das Blatt geht hoch, dann kommen die Elemente nach … komisch",
 * 04.11.2026). Lebendig sind von Anfang an nur die Punkte und der Status.
 */
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { Mic, Pause, Trash2 } from "lucide-react-native";
import { SendGlyph } from "@/components/ui/SendGlyph";
import { SHEET_HEAD_TOP, SHEET_TITLE } from "@/components/ui/SheetModal";
import { DELETE_TINT, RecordTime } from "@/components/assistant/MicBox";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { GROUP_GAP, GUTTER, ITEM_GAP } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { RotatingText, type RotationTiming } from "@/components/home/RotatingPlaceholder";
import { useHintPause } from "@/lib/ui/hintPause";

const WHITE = "#F4F4F5";
const G3 = "#5A5A5E";
const DANGER = "#F26B6F";

/** Fläche der Punkte: vier Pillen, 12 breit, 18 Abstand. */
const DOTS_W = 120;
const DOTS_H = 56;
const DOT = 12;
/** Größte Streckung des Mittelstücks (Pille bis DOT + 40). */
const MID_H = 40;

/**
 * Wechselnde Hinweise, solange noch nichts gesagt ist (Nutzer 05.11.2026: „ein
 * bisschen Dynamik … mit genug Zeit, 6 bis 7 Sekunden"). Dieselbe Bewegung wie
 * die Hinweise im Ortswähler und die Sprüche der Startseite (`RotatingText`):
 * der alte Satz hebt ab, der neue rollt von unten ein.
 *
 * Der erste ist die bisherige Aufforderung, danach BEISPIELE — in
 * Anführungszeichen, damit sie sich als „so könntest du es sagen" lesen und
 * nicht als Aussage der App. Nur, was Bo wirklich kann: Verbindungen suchen
 * (Zug, Flug, Bus — Preise aus unserer Suche), Abfahrten zeigen, vage Wünsche
 * wie „ans Meer" in Ziele übersetzen. Kurz genug für EINE Zeile; was dennoch
 * nicht passt (große Systemschrift), überspringt `RotatingText` selbst.
 */
const HINT_KEYS = [
  "voice.sheet.hint",
  "voice.sheet.hint.train",
  "voice.sheet.hint.flight",
  "voice.sheet.hint.departures",
  "voice.sheet.hint.weekend",
  "voice.sheet.hint.bus",
] as const;
/** 6,5 s je Satz — ruhiger als die Startseite (3,6 s), etwas lebhafter als
 *  der Ortswähler (7,5 s): Hier wartet man auf sich selbst, nicht auf einen Ort. */
const HINT_TIMING: RotationTiming = { hold: 6500, firstHold: 6000, resumeHold: 4500 };

export function VoicePanel({
  recording,
  transcript,
  micVolumeSV,
  onToggle,
  onDelete,
  onSend,
  bottomInset,
}: {
  recording: boolean;
  transcript: string;
  micVolumeSV: SharedValue<number>;
  onToggle: () => void;
  onDelete: () => void;
  onSend: () => void;
  bottomInset: number;
}) {
  const t = useT();
  const accent = useAccent();
  const palette = usePalette();

  /** Takt in Sekunden und geglättete Lautstärke — nur auf dem UI-Strang. */
  const clock = useSharedValue(0);
  const level = useSharedValue(0);
  const live = useSharedValue(recording ? 1 : 0);
  useEffect(() => {
    live.value = recording ? 1 : 0;
  }, [recording, live]);
  const frame = useFrameCallback((info) => {
    "worklet";
    const dt = Math.min(64, info.timeSincePreviousFrame ?? 16) / 1000;
    clock.value += dt;
    // In der Pause zählt keine Lautstärke — die Punkte kommen zur Ruhe.
    const target = live.value ? micVolumeSV.value : 0;
    level.value += (target - level.value) * Math.min(1, dt * 10);
  }, false);
  useEffect(() => {
    frame.setActive(true);
    return () => frame.setActive(false);
  }, [frame]);

  const pulse = useAnimatedStyle(() => ({
    opacity: live.value ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(clock.value * Math.PI * 2.4)) : 1,
  }));
  const halo = useAnimatedStyle(() => ({
    opacity: 0.16 + 0.34 * level.value,
    transform: [{ scale: 1 + 0.42 * level.value }],
  }));

  const said = transcript.trim();
  const dotColors = [accent.solid, WHITE, accent.solid, WHITE];
  /** Gewechselt wird nur, solange der Hinweis zu sehen ist — und nie mitten in
   *  einer Fahrt des Blattes (`useHintPause`). */
  const hintPause = useHintPause(!said);

  return (
    <View style={[styles.wrap, { paddingBottom: bottomInset + GROUP_GAP }]}>
      {/* Kopf wie jedes Blatt der App: Titel in `SHEET_TITLE` am Rand. Die
          Aufnahme selbst (Punkt + Uhr) steht rechts als kleine Pille — vorher
          stand „Ich höre zu" in 14 da, kleiner als jeder andere Blattkopf. */}
      <View style={styles.head}>
        <Text style={styles.title} numberOfLines={1}>
          {t(recording ? "voice.sheet.listening" : "voice.paused")}
        </Text>
        <View style={[styles.timePill, { backgroundColor: palette.s2 }]}>
          <Animated.View style={[styles.statusDot, { backgroundColor: recording ? accent.solid : G3 }, pulse]} />
          <RecordTime recording={recording} paused={!recording} />
        </View>
      </View>

      <View style={styles.textArea}>
        {said ? (
          <Text style={styles.transcript} numberOfLines={3} ellipsizeMode="head">
            {said}
          </Text>
        ) : (
          /* Die Zeile von `RotatingText` nimmt `flex: 1` — in einer ZEILE ist
             das die Breite. Direkt in der Spalte zöge sie sich über die ganze
             Höhe, und der Satz stünde oben statt mittig. */
          <View style={styles.hintRow}>
            <RotatingText
              keys={HINT_KEYS}
              pause={hintPause}
              timing={HINT_TIMING}
              textStyle={[styles.transcript, styles.hint]}
            />
          </View>
        )}
      </View>

      <View style={styles.dots}>
        <View style={dotStyles.area}>
          {dotColors.map((c, i) => (
            <VoiceDot key={i} index={i} color={c} clock={clock} level={level} />
          ))}
        </View>
      </View>

      <View style={styles.controls}>
        <RippleTouch
          onPress={() => {
            haptic("button");
            onDelete();
          }}
          accessibilityRole="button"
          accessibilityLabel={t("voice.delete")}
          rippleColor="rgba(255,255,255,0.12)"
          style={[styles.side, { backgroundColor: DELETE_TINT }]}
        >
          <Trash2 size={21} color={DANGER} strokeWidth={2.1} />
        </RippleTouch>

        <View style={styles.sendWrap}>
          {/* Der Hof atmet mit der Lautstärke — man sieht, dass Bo zuhört. */}
          <Animated.View pointerEvents="none" style={[styles.halo, { backgroundColor: accent.solid }, halo]} />
          <RippleTouch
            onPress={() => {
              haptic("button");
              onSend();
            }}
            accessibilityRole="button"
            accessibilityLabel={t("voice.send")}
            rippleColor="rgba(0,0,0,0.14)"
            style={[styles.send, { backgroundColor: accent.solid }]}
          >
            <SendGlyph size={ms(28)} color={accent.textOnSolid} cutColor={accent.solid} />
          </RippleTouch>
        </View>

        <RippleTouch
          onPress={() => {
            haptic("button");
            onToggle();
          }}
          accessibilityRole="button"
          accessibilityLabel={t(recording ? "voice.pause" : "voice.resume")}
          rippleColor="rgba(255,255,255,0.12)"
          style={[styles.side, { backgroundColor: palette.s2 }]}
        >
          {recording ? (
            <Pause size={21} color={WHITE} strokeWidth={2.2} />
          ) : (
            <Mic size={21} color={accent.solid} strokeWidth={2.2} />
          )}
        </RippleTouch>
      </View>
    </View>
  );
}

/**
 * Ein Punkt: in der Stille ein Kreis, der sacht wippt; beim Sprechen eine
 * Pille, die mit der Lautstärke wächst — jeder mit eigenem Versatz, so wirkt es
 * wie eine Welle statt wie ein Block.
 */
function VoiceDot({
  index,
  color,
  clock,
  level,
}: {
  index: number;
  color: string;
  clock: SharedValue<number>;
  level: SharedValue<number>;
}) {
  // Vier Pillen, 30 Abstand von Mitte zu Mitte, zusammen mittig in der Fläche.
  const x = (DOTS_W - (3 * 30 + DOT)) / 2 + index * 30;
  /** Mitte und Höhe der Pille — einmal je Bild gerechnet, von allen drei Teilen gelesen. */
  const geo = useDerivedValue(() => {
    const v = level.value;
    const wave = Math.sin(clock.value * Math.PI * 2 * 1.7 + index * 1.25);
    const h = DOT + v * MID_H * (0.6 + 0.4 * wave);
    const calm = 1 - Math.min(1, v * 3);
    const bob = calm * 4 * Math.sin(clock.value * Math.PI * 2 * 0.8 + index * 0.9);
    return { cy: DOTS_H / 2 + bob, h };
  });
  const top = useAnimatedStyle(() => ({ transform: [{ translateY: geo.value.cy - geo.value.h / 2 }] }));
  const bottom = useAnimatedStyle(() => ({ transform: [{ translateY: geo.value.cy + geo.value.h / 2 - DOT }] }));
  // Gestreckt um die eigene Mitte (Standard), dann dorthin geschoben — kein `transformOrigin`.
  const mid = useAnimatedStyle(() => ({
    transform: [{ translateY: geo.value.cy - MID_H / 2 }, { scaleY: Math.max(0, geo.value.h - DOT) / MID_H }],
  }));
  const fill = { left: x, backgroundColor: color };
  return (
    <>
      <Animated.View style={[dotStyles.cap, fill, top]} />
      <Animated.View style={[dotStyles.mid, fill, mid]} />
      <Animated.View style={[dotStyles.cap, fill, bottom]} />
    </>
  );
}

/** Rohmaße wie vorher in der Zeichenfläche — bewusst nicht durch `scaledStyles`. */
const dotStyles = StyleSheet.create({
  area: { width: DOTS_W, height: DOTS_H },
  cap: { position: "absolute", top: 0, width: DOT, height: DOT, borderRadius: DOT / 2 },
  mid: { position: "absolute", top: 0, width: DOT, height: MID_H },
});

const styles = scaledStyles({
  /** Oben `SHEET_HEAD_TOP`: Oberkante bis Titel wie in jedem Blatt. */
  wrap: { flex: 1, paddingTop: SHEET_HEAD_TOP, paddingHorizontal: GUTTER },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", columnGap: GROUP_GAP },
  title: { ...SHEET_TITLE, flexShrink: 1 },
  /** Punkt + Uhr der Aufnahme — eine ruhige Pille eine Stufe über dem Blatt. */
  timePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: ITEM_GAP,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  /** Der Text nimmt den Raum zwischen Kopf und Punkten und steht darin mittig. */
  textArea: { flex: 1, justifyContent: "center", paddingVertical: ITEM_GAP },
  transcript: { fontSize: 22, lineHeight: 30, fontWeight: "400", color: WHITE, letterSpacing: -0.2 },
  hint: { color: G3 },
  hintRow: { flexDirection: "row" },
  dots: { alignItems: "center", marginBottom: GROUP_GAP },
  controls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: ITEM_GAP },
  side: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  sendWrap: { width: 96, height: 96, alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", width: 72, height: 72, borderRadius: 36 },
  send: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", overflow: "hidden" },
});
