import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Pause, Play } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Eine gesendete Sprachnachricht im Chat — abspielbar.
 *
 * Die Tonspur ist hier STILL: Ein festes Muster aus der Datei zu rechnen hieße,
 * sie beim Anzeigen zu dekodieren, und das für jede Nachricht in der Liste. Die
 * Balken zeigen deshalb den Fortschritt an, nicht den Inhalt — was gespielt
 * wurde, steht voll, der Rest tritt zurück.
 */

const BARS = 22;
/** Feste, unregelmäßige Höhen — eine Spur, die bei jeder Nachricht gleich
 *  aussieht, wirkt wie ein Fortschrittsbalken; diese hier wirkt wie Ton. */
const SHAPE = [
  0.35, 0.6, 0.45, 0.8, 1, 0.7, 0.5, 0.85, 0.65, 0.4, 0.75, 0.95, 0.55, 0.7,
  0.45, 0.85, 0.6, 0.35, 0.7, 0.5, 0.8, 0.4,
];

function fmt(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function VoiceBubble({
  uri,
  durationSec,
  ink,
}: {
  uri: string;
  /** Beim Aufnehmen gezählt — steht sofort, auch bevor die Datei geladen ist. */
  durationSec: number;
  /** Vordergrundfarbe der Blase (Schrift und Balken). */
  ink: string;
}) {
  const player = useAudioPlayer(uri);
  const status = useAudioPlayerStatus(player);
  const [progress, setProgress] = useState(0);

  const playing = status.playing;
  const total = status.duration > 0 ? status.duration : durationSec;
  const position = status.currentTime;

  useEffect(() => {
    setProgress(total > 0 ? Math.min(1, position / total) : 0);
  }, [position, total]);

  /**
   * Am Ende zurück auf Anfang.
   *
   * Ohne das bleibt der Spieler am Schluss stehen, und der nächste Druck auf
   * „Abspielen" tut nichts — er ist ja schon dort.
   */
  useEffect(() => {
    if (status.didJustFinish) {
      player.seekTo(0);
      player.pause();
    }
  }, [status.didJustFinish, player]);

  return (
    <View style={styles.row}>
      <RippleTouch
        borderless
        onPress={() => {
          if (playing) player.pause();
          else player.play();
        }}
        accessibilityLabel={playing ? "Pause" : "Play"}
        style={styles.btn}
      >
        {playing ? (
          <Pause size={18} color={ink} strokeWidth={2.4} fill={ink} />
        ) : (
          <Play size={18} color={ink} strokeWidth={2.4} fill={ink} />
        )}
      </RippleTouch>

      <View style={styles.wave}>
        {SHAPE.slice(0, BARS).map((h, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: 4 + h * 20,
                backgroundColor: ink,
                // Was schon gespielt wurde, steht voll; der Rest tritt zurück.
                opacity: i / BARS <= progress ? 1 : 0.35,
              },
            ]}
          />
        ))}
      </View>

      <Text style={[styles.time, { color: ink }]}>
        {fmt(playing || position > 0 ? total - position : total)}
      </Text>
    </View>
  );
}

const styles = scaledStyles({
  row: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 190 },
  btn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  wave: { flex: 1, flexDirection: "row", alignItems: "center", gap: 2, height: 26 },
  bar: { width: 3, borderRadius: 2 },
  time: {
    fontSize: 12,
    fontWeight: "700",
    minWidth: 32,
    textAlign: "right",
    fontVariant: ["tabular-nums"],
  },
});
