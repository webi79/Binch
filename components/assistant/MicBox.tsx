import { useEffect, useMemo } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { Mic, Pause, Send, Trash2 } from "lucide-react-native";
import { Waveform } from "@/components/assistant/VoiceRecordBar";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { usePalette } from "@/lib/theme/appBg";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
import { haptic } from "@/lib/haptics";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Der Mikrofon-Kasten in Bos Chat.
 *
 * Oben die Tonspur mit der Laufzeit, unten drei Bedienelemente: verwerfen,
 * anhalten/fortsetzen, senden. Geschlossen wird NUR über Verwerfen oder Senden
 * — das Mikrofon selbst öffnet ihn nur.
 */

const DELETE_INK = "#E5484D";
/** Getönter Grund des Verwerfen-Knopfes — derselbe Rotton, stark verdünnt. */
const DELETE_TINT = "rgba(229,72,77,0.16)";

/** `#RRGGBB` mischen. `t` = 0 gibt `a`, 1 gibt `b`. */
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Ein Textfeld, dessen Inhalt vom UI-Strang geschrieben werden darf. */
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/**
 * Die Uhr — und warum sie KEINEN Durchgang von React mehr auslöst.
 *
 * Vorher zählte sie über `useState` im Sekundentakt. Genau das war das Zucken
 * der Tonspur: Jeder Commit von React klont den Pfad im Shadow-Tree für JEDEN
 * animierten Knoten und HÄLT DABEI Reanimateds eigene Commits an (steht so in
 * dessen Quelle). Für eine Fläche, die dauerhaft rollt, ist eine Pause je
 * Sekunde genau ein sichtbarer Ruckler je Sekunde — dieselbe Ursache, die in
 * dieser App schon beim Kartenstapel und bei den Übergängen dranstand.
 *
 * Jetzt läuft die Zeit als geteilter Wert im Bild-Takt mit und wird als `text`
 * direkt in ein Textfeld geschrieben. Das passiert auf dem UI-Strang, ohne
 * Zustand, ohne Neuaufbau, ohne Commit — der Rest des Kastens merkt davon
 * nichts.
 *
 * Ein `TextInput` statt `Text`, weil nur dessen `text`-Eigenschaft von
 * Reanimated fortgeschrieben werden kann. Nicht bedienbar, nicht fokussierbar:
 * Er ist hier reine Anzeige.
 */
function RecordTime({ recording, paused }: { recording: boolean; paused: boolean }) {
  const elapsedMs = useSharedValue(0);
  /** Zeitstempel des letzten Bildes — 0 heißt „gerade angehalten". */
  const lastTs = useSharedValue(0);

  const frame = useFrameCallback((info) => {
    "worklet";
    if (lastTs.value === 0) {
      lastTs.value = info.timestamp;
      return;
    }
    elapsedMs.value += info.timestamp - lastTs.value;
    lastTs.value = info.timestamp;
  }, false);

  const running = recording && !paused;
  useEffect(() => {
    // Beim Anhalten den Zeitstempel löschen: Sonst zahlte das erste Bild nach
    // dem Fortsetzen die ganze Pause auf einmal nach.
    if (!running) lastTs.value = 0;
    frame.setActive(running);
  }, [frame, running, lastTs]);

  /**
   * `text` steht nicht in den Eigenschaften von `TextInput` — es ist der
   * interne Weg, auf dem Reanimated den Inhalt am React-Zustand vorbei setzt.
   * Deshalb hier ausdrücklich mit angegeben.
   */
  const animatedProps = useAnimatedProps<TextInputProps & { text: string }>(() => {
    "worklet";
    const total = Math.floor(elapsedMs.value / 1000);
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return { text: `${m}:${sec < 10 ? "0" : ""}${sec}` };
  });

  return (
    <AnimatedTextInput
      editable={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      defaultValue="0:00"
      animatedProps={animatedProps}
      style={styles.time}
    />
  );
}

interface Props {
  /** Läuft die Aufnahme gerade? Steuert Tonspur, Uhr und die Beschriftung. */
  recording: boolean;
  /** Darstellung anhalten, solange etwas fährt — siehe VoiceRecordBar. */
  paused?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onSend: () => void;
  micVolumeSV: SharedValue<number>;
  /** Lage und Maße kommen vom Bildschirm — dort steht die Geometrie. */
  style?: StyleProp<ViewStyle>;
}

export function MicBox({
  recording,
  paused = false,
  onToggle,
  onDelete,
  onSend,
  micVolumeSV,
  style,
}: Props) {
  const t = useT();
  const palette = usePalette();
  const accent = useAccent();

  /**
   * Die Farbe kommt aus dem THEME, nicht aus einer festen Zahl.
   *
   * Gewünscht war „wie die Nachrichten, nur dunkler". Beides steht in der
   * Palette: `s2` ist der Ton der Nachrichten, `bg` der des Bildschirms. Genau
   * dazwischen liegt der Kasten — dunkler als eine Nachricht, heller als der
   * Grund, und damit in JEDEM Theme als eigene Fläche zu erkennen.
   *
   * Feste Werte gingen hier nicht: Im Grau-Theme liegt der Grund auf `#0D0D0D`,
   * im Dark-Theme auf Schwarz. Ein Wert, der zu dem einen passt, verschwindet im
   * anderen oder hebt zu stark ab.
   */
  const fill = useMemo(() => mix(palette.bg, palette.s2, 0.5), [palette.bg, palette.s2]);

  return (
    <View style={[styles.box, { backgroundColor: fill, borderColor: palette.border }, style]}>
      <View style={styles.topRow}>
        <Waveform recording={recording} paused={paused} micVolumeSV={micVolumeSV} />
        <RecordTime recording={recording} paused={paused} />
      </View>

      <View style={styles.actions}>
        <RippleTouch
          borderless
          onPress={() => {
            haptic("button");
            onDelete();
          }}
          accessibilityLabel={t("assistant.voice.delete")}
          style={[styles.round, { backgroundColor: DELETE_TINT }]}
        >
          <Trash2 size={22} color={DELETE_INK} strokeWidth={1.9} />
        </RippleTouch>

        <RippleTouch
          onPress={() => {
            haptic("button");
            onToggle();
          }}
          style={[
            styles.toggle,
            { backgroundColor: accent.subtle, borderColor: accent.border },
          ]}
        >
          {recording ? (
            <Pause size={19} color={accent.solid} strokeWidth={2.2} fill={accent.solid} />
          ) : (
            <Mic size={19} color={accent.solid} strokeWidth={2.2} />
          )}
          <Text style={[styles.toggleText, { color: accent.solid }]}>
            {t(recording ? "assistant.voice.pause" : "assistant.voice.resume")}
          </Text>
        </RippleTouch>

        <RippleTouch
          borderless
          onPress={() => {
            haptic("important");
            onSend();
          }}
          accessibilityLabel={t("assistant.voice.send")}
          style={[styles.round, { backgroundColor: accent.solid }]}
        >
          <Send size={21} color={accent.textOnSolid} strokeWidth={2.2} />
        </RippleTouch>
      </View>
    </View>
  );
}

const styles = scaledStyles({
  box: {
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    justifyContent: "space-between",
  },
  /**
   * Nimmt den ganzen Platz über den Knöpfen und setzt die Spur MITTIG hinein.
   *
   * Vorher saß sie am oberen Rand (der Kasten verteilte mit `space-between`,
   * und die Zeile war nur so hoch wie ihr Inhalt). Gemeint war die Mitte
   * zwischen Oberkante des Kastens und Oberkante der Knöpfe — genau die ergibt
   * sich, wenn die Zeile den Raum füllt und ihren Inhalt zentriert.
   */
  topRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 14 },
  /** Feste Breite mit Ziffern gleicher Laufweite: Die Uhr darf die Tonspur
   *  nicht bei jedem Sekundenwechsel um einen Punkt verschieben. */
  /**
   * Die Zeitanzeige ist ein Textfeld (siehe `RecordTime`) — die drei Zeilen am
   * Ende nehmen ihm den Innenabstand, den ein Eingabefeld von Haus aus hat,
   * damit es genauso sitzt wie vorher der Text.
   */
  time: {
    fontSize: 15,
    fontWeight: "700",
    color: "#F4F4F5",
    minWidth: 46,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
    padding: 0,
    margin: 0,
    includeFontPadding: false,
  },
  actions: { flexDirection: "row", alignItems: "center", gap: 12 },
  round: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: "center",
    justifyContent: "center",
  },
  toggle: {
    flex: 1,
    height: 54,
    borderRadius: 27,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  toggleText: { fontSize: 15, fontWeight: "700" },
});
