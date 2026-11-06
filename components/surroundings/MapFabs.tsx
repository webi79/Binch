import { useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Circle, ClipPath, Defs, Path, Rect } from "react-native-svg";
import { Layers } from "lucide-react-native";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { useAccent } from "@/lib/theme/accent";
import { useT } from "@/lib/i18n/useT";
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
 * FORM VON GOOGLE, FARBEN VON BINCH (Nutzer 06.11.2026: „passt überhaupt nicht
 * zum Design — ganz andere Farben"). Die abgerundete Kachel des
 * Material-3-FAB bleibt (56 × 56, Radius 16 — derselbe Radius wie Felder und
 * Knöpfe der App), aber Fläche, Rand und Schatten sind die der Knöpfe oben
 * (`fab`): dasselbe Schwarz wie die Suchleiste, dieselbe feine Kante. Vorher
 * stand hier Googles Grau (#38383B) — ein Ton, den es sonst nirgends in der App
 * gibt.
 *
 * Darin das Zeichen des eigenen Standorts, wie es auf der Karte steht
 * (`UserPin` in MapMarkers.tsx): Punkt im Akzent, weicher Hof, und ein Ring in
 * der FARBE DER FLÄCHE, der den Punkt aus dem Hof stanzt — dasselbe
 * „ausgestanzt" wie am Griff des Preisalarm-Reglers. Größen wie am Vorbild
 * gemessen (Hof zwei Drittel der Kachel, Punkt mit Ring 16).
 *
 * EIGENE EBENE (`renderToHardwareTextureAndroid`): Der Knopf blendet mit dem
 * Aufziehen des Blattes aus, über die Deckkraft seines Halters. Ohne Ebene
 * kam der halbdurchsichtige runde Hof dabei als eckige Box heraus (Gerät,
 * 06.11.2026). Der Schatten gehört dem Halter und bleibt außerhalb der Ebene,
 * wird also nicht abgeschnitten.
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
  const t = useT();
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const press = useCallback(() => pressRef.current(), []);

  /**
   * DIE WELLE IN DER FORM DES KNOPFES (Nutzer 06.11.2026: „der Ripple ist
   * immer noch ein Kreis").
   *
   * Die native Welle von Android lässt sich nur rechteckig oder rund begrenzen.
   * In die Rundung beschneiden ginge über `overflow: hidden` — und genau das
   * flackert hier an den Ecken, weil der Knopf bei jeder Bewegung des Blattes
   * per Verschiebung mitfährt (`noClip` in RippleTouch.tsx). Deshalb eine eigene
   * Welle: ein Kreis, der vom Finger aus wächst, in der Zeichnung selbst auf die
   * abgerundete Kachel beschnitten (SVG-`clipPath`, kein Ansichts-Beschnitt).
   * Alles auf dem UI-Strang: Die Geste setzt die Werte, nichts rendert.
   */
  const cx = useSharedValue(0);
  const cy = useSharedValue(0);
  const rad = useSharedValue(0);
  const glow = useSharedValue(0);
  const tap = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(60_000)
        .maxDistance(24)
        .onBegin((e) => {
          // Ereignis-Lage gilt ab der Außenkante, die Zeichnung beginnt innen am Rand.
          const x = Math.min(LOC_INNER, Math.max(0, e.x - LOC_EDGE));
          const y = Math.min(LOC_INNER, Math.max(0, e.y - LOC_EDGE));
          cx.value = x;
          cy.value = y;
          // Bis in die fernste Ecke — dann deckt die Welle die ganze Kachel.
          const far = Math.hypot(Math.max(x, LOC_INNER - x), Math.max(y, LOC_INNER - y));
          cancelAnimation(rad);
          cancelAnimation(glow);
          rad.value = far * 0.3;
          rad.value = withTiming(far, { duration: 420, easing: Easing.out(Easing.cubic) });
          glow.value = withTiming(RIPPLE_ALPHA, { duration: 80 });
        })
        .onEnd((_e, success) => {
          if (success) runOnJS(press)();
        })
        .onFinalize(() => {
          // Kurz stehen lassen, dann auslaufen — ein schneller Tipp sieht die Welle sonst nie.
          glow.value = withDelay(90, withTiming(0, { duration: 300, easing: Easing.out(Easing.quad) }));
        }),
    [cx, cy, rad, glow, press],
  );
  const rippleProps = useAnimatedProps(() => ({
    cx: cx.value,
    cy: cy.value,
    r: rad.value,
    fillOpacity: glow.value,
  }));

  return (
    <GestureDetector gesture={tap}>
      <View
        renderToHardwareTextureAndroid
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("map.locate")}
        accessibilityActions={[{ name: "activate" }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "activate") press();
        }}
        style={[styles.locFab, locating ? styles.locBusy : null]}
      >
        <View style={[styles.locHalo, { backgroundColor: accent.subtle }]}>
          <View style={[styles.locDot, { backgroundColor: accent.solid }]} />
        </View>
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          <Defs>
            <ClipPath id="locate-fab-shape">
              <Rect x={0} y={0} width={LOC_INNER} height={LOC_INNER} rx={LOC_INNER_R} ry={LOC_INNER_R} />
            </ClipPath>
          </Defs>
          <AnimatedCircle
            clipPath="url(#locate-fab-shape)"
            fill="#FFFFFF"
            animatedProps={rippleProps}
          />
        </Svg>
      </View>
    </GestureDetector>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Kantenlänge des Standort-Knopfes — Material-3-FAB wie bei Google (vor `ms`). */
const LOC_FAB = 56;
/** Rand der Kachel und die Fläche darin — dort wird die Welle gezeichnet. */
const LOC_EDGE = 1;
const LOC_INNER = ms(LOC_FAB) - 2 * LOC_EDGE;
/** Innere Rundung: die äußere (16) minus Rand. */
const LOC_INNER_R = ms(16) - LOC_EDGE;
/** Stärke der Welle — wie die helle Welle der übrigen Knöpfe auf dunklem Grund. */
const RIPPLE_ALPHA = 0.16;

/** Fläche und Kante ALLER Karten-Knöpfe — dasselbe Schwarz wie die Suchleiste. */
const FAB_SURFACE = "rgba(13,13,13,0.92)";
const FAB_EDGE = "#212123";
/** Der Ring um den Standort-Punkt: die Fläche, deckend — er stanzt den Punkt aus dem Hof. */
const FAB_PUNCH = "#0D0D0D";

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
    backgroundColor: FAB_SURFACE,
    borderColor: FAB_EDGE,
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
   * Der Standort-Knopf: Googles Kachel in den Farben der Knöpfe oben (`fab`) —
   * Fläche, Rand und Schatten 1:1 von dort.
   */
  locFab: {
    width: LOC_FAB,
    height: LOC_FAB,
    borderRadius: 16,
    backgroundColor: FAB_SURFACE,
    borderColor: FAB_EDGE,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  /** Ortung läuft — gedimmt, damit niemand ins Leere tippt. */
  locBusy: { opacity: 0.5 },
  /** Hof: zwei Drittel der Kachel, wie am Vorbild gemessen. */
  locHalo: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  /** Punkt 16 mit Ring 2,5 in der Farbe der Fläche — innen bleiben 11 im Akzent. */
  locDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2.5,
    borderColor: FAB_PUNCH,
  },
});
