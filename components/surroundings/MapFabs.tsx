import { useCallback, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { Layers } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { chromeShift, travelFabs } from "@/lib/surroundings/mapChrome";

const WHITE = "#F4F4F5";

/** Knopfgröße und Abstand in der Reihe — dieselben Werte wie in `styles`. */
const FAB = 44;
const GAP = 10;

/**
 * Wie lange der Kompass nach dem Geraderücken noch stehen bleibt.
 *
 * Vorher verschwand er im selben Augenblick, in dem die Karte Norden meldete —
 * man tippte, und der Knopf war weg, bevor man gesehen hatte, dass er etwas
 * getan hat. Eine knappe halbe Sekunde reicht, um die Nadel oben einrasten zu
 * sehen; länger stünde er nur im Weg.
 */
const HOLD_MS = 450;

interface Props {
  /**
   * Oberkante der Reihe — vom Karten-Bildschirm aus der Unterkante der
   * Suchleiste gerechnet, im selben Abstand, den der Standort-Knopf unten zum
   * Blatt hat.
   */
  top: number;
  /** Öffnet das Kartentyp-Blatt (Dunkel / Hell / Satellit). */
  onOpenMapType: () => void;
  /**
   * Drehung und Neigung der Karte, Bild für Bild (aus `onCameraFrame` der
   * Kartenfläche). Als animierte Werte, nicht als Zustand: Der Kompass dreht
   * sich damit auf dem UI-Strang mit, ohne dass der Bildschirm neu rendert.
   */
  bearing: SharedValue<number>;
  pitch: SharedValue<number>;
  onResetNorth: () => void;
}

/**
 * Die Knopfreihe rechts an der Karte.
 *
 * WEGGEFALLEN ist der Verkehrs-Knopf. Er legte `trafficOn` um, das über
 * `showsTraffic` an die Kartenfläche ging — und dort stand daneben „Reserved
 * (Traffic-Overlay nicht in OpenFreeMap-Tiles enthalten)". Die Eigenschaft
 * wurde nie gelesen. Der Knopf färbte also sein Zeichen ein und tat sonst
 * nichts; das ist schlechter als kein Knopf, weil man ihn für kaputt hält.
 * Kommt eine echte Verkehrs-Ebene, kommt er zurück — dann mit Wirkung.
 *
 * Der obere Knopf ist kein Umschalter mehr, sondern ein EINGANG: Er öffnet das
 * Blatt mit den drei Kartentypen. Deshalb trägt er auch keinen aktiven Zustand
 * — ein Eingang ist nie „an".
 */
export function MapFabs({
  top,
  onOpenMapType,
  bearing,
  pitch,
  onResetNorth,
}: Props) {
  const accent = useAccent();
  /** 0 = Kompass weg, 1 = Kompass da — gleitend dazwischen. */
  const shown = useSharedValue(0);
  /**
   * Nimmt der Kompass Berührungen an? Nur, solange er zu sehen ist.
   *
   * Er steht immer an seinem Platz (siehe unten), auch unsichtbar — und dort
   * liegt dann der Standort-Knopf. Ohne diesen Schalter finge ein unsichtbarer
   * Kompass dessen Tipps ab. Als Zustand, weil `pointerEvents` keine
   * animierbare Eigenschaft ist; er wechselt zweimal je Drehung, und neu
   * gezeichnet wird dabei nur diese kleine Reihe.
   */
  const [compassLive, setCompassLive] = useState(false);

  /**
   * Steht die Karte schief? Nur dann gibt es den Kompass.
   *
   * Die Drehung kommt als 0..360, kann aber auch NEGATIV sein (−90 für eine
   * Vierteldrehung nach links) — deshalb der doppelte Rest-Ausdruck und dann
   * der Abstand zur nächstgelegenen Nordrichtung: 359,4° ist genauso schief wie
   * 0,6°. Ein Grad Toleranz, damit ein Wimpernschlag beim Zoomen mit zwei
   * Fingern den Knopf nicht aufblitzen lässt.
   *
   * Erscheinen geht sofort, Verschwinden erst nach `HOLD_MS`. Kippt die Karte
   * in der Haltezeit wieder weg (man dreht durch Norden hindurch), ersetzt die
   * neue Animation die alte, und der Knopf bleibt einfach stehen. Taub wird er
   * erst, wenn er ganz ausgeblendet ist.
   */
  useAnimatedReaction(
    () => {
      const b = ((bearing.value % 360) + 360) % 360;
      return Math.min(b, 360 - b) > 1 || pitch.value > 1;
    },
    (off, prev) => {
      if (off === prev) return;
      if (off) {
        runOnJS(setCompassLive)(true);
        shown.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) });
      } else {
        shown.value = withDelay(
          HOLD_MS,
          withTiming(0, { duration: 280, easing: Easing.inOut(Easing.cubic) }, (finished) => {
            if (finished) runOnJS(setCompassLive)(false);
          }),
        );
      }
    },
  );

  /**
   * Der Kompass hat einen FESTEN Platz unter dem Kartentyp-Knopf und blendet
   * dort nur ein und aus.
   *
   * Hier glitt früher der Standort-Knopf per Verschiebung in die Lücke, wenn
   * der Kompass verschwand. Der Standort-Knopf sitzt inzwischen unten über dem
   * Auswahlfenster (`LocateFab`, siehe unten) — unter dem Kompass steht nichts
   * mehr, das nachrücken müsste.
   *
   * Kein `overflow: hidden` am Platz: Die rund auslaufende Welle beim Antippen
   * (`borderless`) reicht über den Knopf hinaus, ein Rahmen machte aus ihr ein
   * Rechteck mit runden Kanten.
   */
  const compassStyle = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ scale: 0.7 + 0.3 * shown.value }],
  }));
  /**
   * Die Nadel zeigt nach Norden — also gegen die Kameradrehung. Blickt die
   * Kamera nach Osten (90°), liegt Norden links: minus 90°.
   */
  const needleStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${-bearing.value}deg` }],
  }));

  /**
   * Nur-Karte-Modus: Die Reihe steht in der oberen Bildhälfte, fährt also nach
   * OBEN hinaus — mit derselben Verschiebung wie alle anderen Teile, bis sie
   * hinter dem Rand ist (siehe `lib/surroundings/mapChrome.ts`). Sie steht
   * tiefer als die Suchleiste, ist also etwas später draußen.
   */
  const onColLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    // Plus Luft für den Schatten der Knöpfe.
    travelFabs.value = y + height + 24;
  }, []);
  const chromeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.min(chromeShift.value, travelFabs.value) }],
  }));

  return (
    <Animated.View
      style={[styles.col, { top }, chromeStyle]}
      pointerEvents="box-none"
      onLayout={onColLayout}
    >
      <Fab onPress={onOpenMapType}>
        <Layers size={20} color={WHITE} strokeWidth={2} />
      </Fab>
      <Animated.View
        style={compassStyle}
        pointerEvents={compassLive ? "auto" : "none"}
      >
        <Fab onPress={onResetNorth}>
          <Animated.View style={needleStyle}>
            <CompassNeedle color={accent.solid} />
          </Animated.View>
        </Fab>
      </Animated.View>
    </Animated.View>
  );
}

/**
 * „Zu meinem Standort" — unten rechts über dem Auswahlfenster, wie bei Google.
 *
 * Dieselbe Hülle wie die Knöpfe oben (`Fab`: Fläche, Rand, Schatten), darin
 * DASSELBE Zeichen wie der eigene Standort auf der Karte (`UserPin` in
 * MapMarkers.tsx): der Punkt im Akzent mit seinem weichen Hof. Vorher stand
 * hier ein Fadenkreuz — ein Zeichen, das auf der Karte nirgends vorkommt. Der
 * Punkt sagt ohne Umweg, wohin der Knopf führt.
 *
 * Die Lage bestimmt nicht der Knopf, sondern wer ihn hält — über dem
 * Auswahlfenster das Blatt selbst (`accessory` in SurroundingsSheet.tsx; ist
 * das Haltestellen- oder Stadt-Blatt offen und höher, über dessen Kante), im
 * Routen-Modus der Karten-Bildschirm.
 */
export function LocateFab({
  onPress,
  locating,
}: {
  onPress: () => void;
  /** Ortung läuft — Knopf gedimmt, damit niemand ins Leere tippt. */
  locating?: boolean;
}) {
  const accent = useAccent();
  return (
    <Fab onPress={onPress} dimmed={locating}>
      <View style={[styles.locHalo, { backgroundColor: accent.subtle }]}>
        <View style={[styles.locDot, { backgroundColor: accent.solid }]} />
      </View>
    </Fab>
  );
}

/**
 * Eine Kompassnadel — Nordhälfte im Akzent, Südhälfte hell und zurückgenommen.
 *
 * Statt des Lucide-Zeichens `Compass`, und das mit Grund: Dessen Nadel steht
 * schräg nach rechts oben. Dreht man es mit der Karte, zeigt es bei Norden-oben
 * nach Nordosten — als Richtungsanzeige genau falsch. Diese Nadel zeigt in
 * Ruhe senkrecht nach oben.
 */
function CompassNeedle({ color }: { color: string }) {
  const size = ms(22);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 2.5 L16 12 L8 12 Z" fill={color} />
      <Path d="M12 21.5 L16 12 L8 12 Z" fill={WHITE} fillOpacity={0.55} />
    </Svg>
  );
}

function Fab({
  children,
  onPress,
  active,
  activeColor,
  dimmed,
}: {
  children: React.ReactNode;
  onPress: () => void;
  active?: boolean;
  activeColor?: string;
  dimmed?: boolean;
}) {
  return (
    <RippleTouch
      style={[
        styles.fab,
        active && activeColor ? { borderColor: activeColor } : null,
        dimmed ? { opacity: 0.5 } : null,
      ]}
      borderless
      onPress={onPress}
    >
      {children}
    </RippleTouch>
  );
}

const styles = scaledStyles({
  col: {
    position: "absolute",
    right: 16,
    rowGap: GAP,
    zIndex: 25,
  },
  fab: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(13,13,13,0.92)",
    borderColor: "#212123",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  // fabActive entfernt — borderColor wird inline aus accent.solid gesetzt.
  /**
   * Der Standort-Punkt im Kleinen — Verhältnis wie auf der Karte (Hof 26,
   * Punkt 10 mit Rand 3, `UserPin`), auf die Knopfgröße gebracht. Der dunkle
   * Rand der Karte entfällt: Er trennt dort den Punkt vom hellen Untergrund,
   * hier liegt er ohnehin auf der dunklen Knopffläche.
   */
  locHalo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  locDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
