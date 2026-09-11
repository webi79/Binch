import { memo, useEffect, useMemo } from "react";
import { View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";

import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { GUTTER } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

/** Höhe der Spur. Dünn genug, um neben der Kopfzeile nicht als Element zu
 *  gelten — sie soll ein Zustand sein, kein Bauteil. */
const TRACK_H = 4;

/** Anteil der Spur, den das Leucht-Segment einnimmt. */
const SEG_FRAC = 0.4;

/**
 * Ein Durchlauf. Kurz genug, dass die Bewegung als „es passiert etwas" liest,
 * lang genug, dass sie nicht hektisch wirkt.
 */
const SWEEP_MS = 1100;

/**
 * Höhe der Spur — für den Ergebnis-Screen, der darüber und darunter Abstände
 * setzt.
 *
 * SCHON SKALIERT, aus demselben Grund wie `SUMMARY_BAR_H`: Der Wert wird als
 * Position verrechnet und läuft durch kein Stilblatt. In ein
 * `scaledStyles`-Blatt gehört er NICHT, dort bekäme er den Faktor zweimal.
 */
export const PROGRESS_BAR_H = ms(TRACK_H);

/**
 * Waagerechter Verlauf — als MODUL-Konstanten, nicht als Objektliteral im JSX.
 *
 * Frische Objekt-Identitäten auf einem Knoten unter einer laufenden Animation
 * sind im Projekt eine bekannte Fehlerquelle: Sie erzwingen bei jedem Render
 * eine neue Zuweisung an die native Ansicht, mitten in eine Schleife hinein, die
 * eigentlich allein auf dem UI-Strang läuft.
 */
const GRAD_START = { x: 0, y: 0.5 } as const;
const GRAD_END = { x: 1, y: 0.5 } as const;

/**
 * Unbestimmter Fortschritt während einer laufenden Suche.
 *
 * Unbestimmt, weil es nichts zu bestimmen gibt: Die Suche fragt mehrere Anbieter
 * parallel, und wie lange der langsamste braucht, weiß niemand vorher. Ein
 * Balken, der sich füllt, wäre eine Behauptung über eine Restzeit, die wir nicht
 * haben — und die letzten „10 %" stünden dann minutenlang. Also ein Leuchten,
 * das durchläuft: Es sagt „läuft", nicht „gleich fertig".
 *
 * Im Ruhezustand gibt die Komponente `null` zurück, hält also NICHTS im Baum.
 * Die Alternative — Spur stehen lassen, Segment ausblenden — hätte den Aufrufer
 * gezwungen, den Platz dauerhaft zu reservieren, obwohl dort im Normalfall eine
 * leere Rinne läge. So entscheidet er selbst: Steht die Zeile, nimmt sie
 * `PROGRESS_BAR_H` plus seinen Abstand ein, sonst rückt die Liste auf.
 */
export const SearchProgressBar = memo(function SearchProgressBar({
  active,
}: {
  active: boolean;
}) {
  const palette = usePalette();
  const accent = useAccent();

  /**
   * Die Breite kommt aus dem FENSTER, nicht aus `onLayout` — und das ist hier
   * die genauere der beiden Möglichkeiten, nicht die bequemere.
   *
   * Die Spur steht zwischen den beiden Seitenrändern, ihre Breite ist also
   * ausgerechnet und nicht gemessen. `onLayout` liefert dieselbe Zahl, aber
   * einen Takt später: Im ersten Bild wäre die Strecke 0, das Segment stünde
   * still, und genau dieses Bild ist das, in dem die Suche startet — der
   * Balken zuckt beim Erscheinen.
   *
   * `ms(GUTTER)` und NICHT `GUTTER`: Der Rand steht unten im Stilblatt, und das
   * läuft durch `scaledStyles`. Auf einem kurzen Gerät sind es dort 16 statt 20
   * — mit dem Rohwert gerechnet liefe das Segment um 8 Punkte zu weit und
   * verschwände am rechten Rand, bevor es ihn erreicht hat.
   */
  const { width } = useWindowDimensions();
  const trackW = Math.max(0, width - 2 * ms(GUTTER));
  const segW = Math.round(trackW * SEG_FRAC);

  const p = useSharedValue(0);

  useEffect(() => {
    /**
     * Riegel: Bei `active === false` startet gar nichts erst.
     *
     * Eine Endlos-Schleife ohne diesen Riegel läuft auf dem UI-Strang weiter,
     * auch wenn niemand sie sieht — und weil dieser Bildschirm bei jeder neuen
     * Suche durch den Ladezustand geht, stapeln sich die Worklets. Deshalb
     * doppelt abgesichert: Riegel hier, `cancelAnimation` im Aufräumen unten.
     * Genauso hielten es die drei pulsierenden Punkte, die vor diesem Balken in
     * der Zähler-Pille des alten Kopfbereichs saßen — die Schleife war dort
     * derselbe Fehler, den der Riegel verhindert.
     */
    if (!active) {
      cancelAnimation(p);
      // Zurück an den Anfang, damit der nächste Durchlauf links beginnt und
      // nicht dort, wo der letzte abgebrochen wurde.
      p.value = 0;
      return;
    }
    /**
     * LINEAR und NICHT umkehrend — dieselbe Begründung, die bei `useArcMotion`
     * in `components/results/search-loaders/SearchSceneChrome.tsx` ausführlich
     * steht: Der dritte Wert ist `false`, die Schleife springt am Ende also
     * zurück an den Anfang. Eine Kurve, die zum Ende hin abbremst und aus der
     * Ruhe anläuft, verbringt einen guten Teil jedes Zyklus fast stillstehend —
     * und direkt danach kommt der Sprung. Genau das fühlt sich zäh an.
     * Beschleunigen und Abbremsen gehört an Wendepunkte, und die hat diese
     * Schleife keine.
     */
    p.value = withRepeat(
      withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(p);
  }, [active, p]);

  /**
   * Verschoben wird die HÜLLE, der Verlauf darin steht still.
   *
   * Der Verlauf selbst darf nie animiert werden: Animierte Zeichen-Eigenschaften
   * machen die ganze Fläche ungültig und lassen sie in jedem Bild neu rastern.
   * Als starres Kind unter einem bewegten `transform` wird er einmal gezeichnet
   * und danach nur noch kopiert.
   *
   * Der Weg beginnt bei `-segW`, damit das Leuchten von AUSSERHALB hereinkommt,
   * und endet bei `trackW`, damit es vollständig hinausläuft. Stünde es am Rand
   * schon halb im Bild, sähe man an beiden Enden ein Aufblitzen statt einer
   * Bewegung.
   */
  const segStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -segW + p.value * (trackW + segW) }],
  }));

  // Stabile Identitäten für den Verlauf: Er hängt allein am Akzent, nicht am
  // Render.
  const colors = useMemo(
    () => ["transparent", accent.solid, "transparent"] as const,
    [accent.solid],
  );
  const segSize = useMemo(() => ({ width: segW }), [segW]);

  if (!active) return null;

  return (
    <View style={[styles.track, { backgroundColor: palette.s3 }]}>
      <Animated.View style={[styles.seg, segSize, segStyle]}>
        <LinearGradient
          colors={colors}
          start={GRAD_START}
          end={GRAD_END}
          style={styles.fill}
        />
      </Animated.View>
    </View>
  );
});

const styles = scaledStyles({
  track: {
    height: TRACK_H,
    borderRadius: TRACK_H / 2,
    marginHorizontal: GUTTER,
    // Clippt das Segment an den runden Enden — ohne das ragt das Leuchten an
    // beiden Seiten über die Spur hinaus, solange es ein- oder ausläuft.
    overflow: "hidden",
  },
  // Die Breite kommt von außen (aus der Fenster-Breite gerechnet); die Höhe
  // bleibt relativ und wird von `scaledStyles` nicht angefasst.
  seg: { height: "100%" },
  fill: { flex: 1 },
});
