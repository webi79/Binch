import { useEffect } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { ms, scaledStyles } from "@/lib/ui/compact";

/**
 * DER Schalter der App — selbst gezeichnet, nicht der von Android.
 *
 * Androids `Switch` setzt den Knopf KONSTRUKTIONSBEDINGT größer als seine
 * Spur: Der Kreis steht oben und unten über, die Spur ist ein dünner Balken
 * dahinter. Das ist die Materialform, und sie lässt sich über Farben nicht
 * ändern — `thumbColor` und `trackColor` sind alles, was die Plattform
 * hergibt. Wer die Form will, in der der Kreis IN der Pille von links nach
 * rechts fährt, muss beide selbst zeichnen.
 *
 * Zwei Knoten, eine Bewegung: Die Pille wechselt die Farbe, der Kreis wandert.
 * Beides läuft über `useAnimatedStyle`, also auf dem UI-Strang — ein Schalter
 * in einer Liste darf nicht auf den JS-Strang warten, um umzuspringen.
 *
 * Er steht an drei Stellen: Einstellungen, Preis-Alarm-Blatt und die Karten
 * unter „Gespeichert". Vorher waren das drei Kopien mit verschiedenen Größen
 * und Grautönen — und drei Stellen, an denen eine spätere Änderung vergessen
 * werden kann.
 */

/**
 * Die Maße — hergeleitet, nicht gegriffen.
 *
 * Der Kreis darf NICHT kleiner werden als er ist: Er ist die Greiffläche und
 * das, was das Auge verfolgt. Also wächst die Pille um ihn herum. Zwei Punkte
 * Luft ringsum lassen ihn sichtbar IN der Spur liegen statt auf ihr; weniger
 * sähe nach einem Fehler aus, mehr nach einer Kapsel mit einer Murmel darin.
 */
/**
 * Die PILLE ist die feste Größe, der Kreis hängt an ihr — nicht umgekehrt.
 *
 * Zuerst stand es andersherum: Der Kreis war gesetzt und die Pille rechnete
 * sich aus ihm plus einem Abstand. Wer dann den Kreis änderte, änderte
 * unbemerkt die Höhe der ganzen Zeile mit. So herum bleibt die Zeile ruhig,
 * und der Abstand ringsum ergibt sich aus der Differenz — er ist damit nie
 * gesetzt, sondern immer die Hälfte dessen, was übrig bleibt.
 */
const TRACK_W = 52;
const TRACK_H = 30;
const THUMB = 24;

/**
 * Die Maße für die BEWEGUNG kommen aus den SKALIERTEN Zahlen, nicht aus den
 * rohen — sonst stimmt der Abstand links nicht mit dem oben überein.
 *
 * `scaledStyles` rechnet die Stile auf kleinen Geräten herunter, die Konstanten
 * oben bleiben davon unberührt. Die Pille wurde also schmaler, während der
 * Kreis weiter um die ungerundeten zwei Punkte verschoben wurde — und in der
 * eingeschalteten Stellung stieß er über den Rand hinaus. Gerundet wird
 * außerdem in jedem Maß einzeln, ein Punkt Differenz genügt für eine sichtbare
 * Schieflage.
 *
 * Der seitliche Abstand wird deshalb nicht gesetzt, sondern AUS DEM SENKRECHTEN
 * ABGELEITET: Er ist die halbe Differenz zwischen Pillen- und Kreishöhe, also
 * genau der Abstand, den die senkrechte Zentrierung von selbst herstellt. Damit
 * ist er gleich, statt gleich gemeint zu sein.
 */
const S_TRACK_W = ms(TRACK_W);
const S_TRACK_H = ms(TRACK_H);
const S_THUMB = ms(THUMB);
const S_INSET = (S_TRACK_H - S_THUMB) / 2;
const S_TRAVEL = S_TRACK_W - S_THUMB - S_INSET * 2;

const MS = 180;
const EASE = Easing.out(Easing.cubic);

export function BinchSwitch({
  value,
  onValueChange,
  readOnly = false,
  accessibilityLabel,
}: {
  value: boolean;
  onValueChange?: (v: boolean) => void;
  /**
   * Nur ANZEIGEN, nicht bedienen — für Zeilen, die als Ganzes tippbar sind.
   *
   * Ohne das lägen zwei Ziele übereinander: Ein Tipp auf den Schalter löste
   * beide aus und schaltete zweimal, also im Ergebnis gar nicht.
   */
  readOnly?: boolean;
  accessibilityLabel?: string;
}) {
  const palette = usePalette();
  const accent = useAccent();

  const p = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    p.value = withTiming(value ? 1 : 0, { duration: MS, easing: EASE });
  }, [value, p]);

  /**
   * Die Farbe der Pille wird ÜBERBLENDET, nicht umgeschaltet.
   *
   * Ein harter Wechsel während der Kreis noch unterwegs ist, liest sich als
   * zwei getrennte Ereignisse. Über dieselbe Kurve geführt, ist es eines.
   */
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(p.value, [0, 1], [palette.s3, accent.solid]),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: S_INSET + p.value * S_TRAVEL }],
  }));

  const body = (
    <Animated.View style={[styles.track, trackStyle]}>
      <Animated.View style={[styles.thumb, thumbStyle]} />
    </Animated.View>
  );

  if (readOnly) return <View pointerEvents="none">{body}</View>;
  return (
    <Pressable
      onPress={() => onValueChange?.(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
    >
      {body}
    </Pressable>
  );
}

const styles = scaledStyles({
  track: {
    width: TRACK_W,
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    // Der Kreis wird über `translateX` geführt; senkrecht hält ihn die
    // Ausrichtung der Spur mittig, ohne zweite Rechnung.
    justifyContent: "center",
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: "#FFFFFF",
    /**
     * KEIN Schatten.
     *
     * Er lag zuerst darunter, um den weißen Kreis vom hellen Akzentgrün zu
     * trennen. Er sitzt aber nach UNTEN versetzt und macht damit genau das
     * kaputt, worum es hier geht: Der Abstand nach unten sieht kleiner aus als
     * der nach oben, obwohl beide gleich sind. Ein weißer Kreis auf Grün oder
     * Dunkelgrau braucht keine Trennung.
     */
  },
});
