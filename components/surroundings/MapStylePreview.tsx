import { memo, useCallback, useMemo, useRef } from "react";
import { Image, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { DARK_PALETTE } from "@/components/surroundings/mapStyle";

/**
 * Die große Vorschau im Kartentyp-Blatt (Nutzer 06.11.2026, „Idee 2"): EIN
 * Bild, das zeigt, was man bekommt — Dunkel, Hell oder Satellit, und ob die
 * Häuser stehen (3D).
 *
 * ECHTE BILDER EINES ECHTEN ORTES (Köln, Rheinauhafen am Schokoladenmuseum),
 * deckungsgleich: das Luftbild NRW und die App-Karte desselben Ausschnitts in
 * ihren Stilen, mit den echten Hausgrundrissen und -höhen. Vorher war es eine
 * gezeichnete Fantasie-Stadt — „die Satellitenansicht finde ich arg hässlich".
 * Weil alle Bilder denselben Ausschnitt zeigen, wechselt beim Überblenden nur
 * der Stil, nicht der Ort.
 *
 * Erzeugt von `server/scripts/build-map-previews.mjs` (dort auch Quellen und
 * Lizenzen: Kartendaten © OpenStreetMap-Mitwirkende über OpenFreeMap;
 * Luftbild Geobasis NRW, „Datenlizenz Deutschland – Zero"). Das Skript liest
 * die Farben aus `mapStyle.ts` — ändert sich eine Palette, das Skript neu
 * laufen lassen.
 *
 * BEWEGUNG OHNE NEUZEICHNEN. Alle fünf Bilder (drei Stile, dazu je eine
 * durchsichtige 3D-Ebene für Dunkel und Hell) hängen von Anfang an
 * übereinander. Ein Wechsel ändert nur Deckkraft und Lage ihrer Hüllen — auf
 * dem UI-Strang, ohne React-Durchgang.
 *
 * Gesteuert von außen (`MapTypeSheet`):
 *  - `ops`: Deckkraft je Stil, in der Reihenfolge der Schichtung (Dunkel unten,
 *    Satellit oben). Der Wechsel hält den unteren Stil voll stehen, solange der
 *    obere blendet — so scheint nie der Kartengrund durch (siehe dort).
 *  - `p3`: 0 = flach, 1 = Häuser stehen. Die 3D-Ebene blendet ein und hebt sich
 *    dabei um ein paar Punkte — die Häuser „wachsen" an ihren Platz.
 */

const IMAGES = {
  dark: require("@/assets/map-previews/dark.webp"),
  dark3d: require("@/assets/map-previews/dark-3d.webp"),
  light: require("@/assets/map-previews/light.webp"),
  light3d: require("@/assets/map-previews/light-3d.webp"),
  satellite: require("@/assets/map-previews/satellite.webp"),
};

/** Seitenverhältnis der Bilder (1000 × 489) — die Karte nimmt es an. */
const ASPECT = 1000 / 489;

/** Wie weit die Häuser beim Aufstellen steigen (vor `ms`). */
const RISE = 6;

/** Innenabstand der Beschriftungs-Box links und rechts (vor `ms`). */
const PILL_PAD = 12;

/**
 * Breiter als die breiteste Box je wird (längste Beschriftung, alle Sprachen,
 * plus Innenabstand) — das feste Maß der Ebenen, die sie formen (vor `ms`).
 */
const PILL_MAX = 240;

/**
 * Wie viel von jeder Beschriftung gerade zu sehen ist — in der Reihenfolge
 * Dunkel, Dunkel · 3D, Hell, Hell · 3D, Satellit.
 *
 * Maßgeblich ist der SICHTBARE Anteil eines Stils, nicht seine Deckkraft: Beim
 * Überblenden steht der untere voll und ist trotzdem hinter dem oberen
 * verschwunden. Zusammen ergibt das 1, solange unten ein Stil voll steht — und
 * das hält `crossTo` (MapTypeSheet) in jedem Bild ein.
 *
 * VOR seinen Aufrufern: Ein Worklet wird beim Laden des Moduls gebaut.
 */
function labelShares(d: number, l: number, s: number, p: number): number[] {
  "worklet";
  const wd = d * (1 - l) * (1 - s);
  const wl = l * (1 - s);
  return [wd * (1 - p), wd * p, wl * (1 - p), wl * p, s];
}

/**
 * Sichtbarer Anteil → Deckkraft der Schrift, weich (smoothstep): unter 35 %
 * aus, ab 85 % voll. Die alte Schrift ist damit fast weg, bevor die neue
 * deutlich wird — nie zwei Wörter halb übereinander.
 */
function textFade(w: number): number {
  "worklet";
  const t = Math.min(1, Math.max(0, (w - 0.35) / 0.5));
  return t * t * (3 - 2 * t);
}

/**
 * Eine Beschriftung in der Box — ein eigenes Bauteil, damit jede ihren eigenen
 * animierten Stil hat (in einer Schleife dürfen keine Hooks stehen).
 */
const PillLabel = memo(function PillLabel({
  index,
  text,
  ops,
  p3,
  onWidth,
}: {
  index: number;
  text: string;
  ops: readonly [SharedValue<number>, SharedValue<number>, SharedValue<number>];
  p3: SharedValue<number>;
  onWidth: (index: number, width: number) => void;
}) {
  const [opDark, opLight, opSat] = ops;
  const fade = useAnimatedStyle(() => ({
    opacity: textFade(labelShares(opDark.value, opLight.value, opSat.value, p3.value)[index]),
  }));
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => onWidth(index, e.nativeEvent.layout.width),
    [index, onWidth],
  );
  return (
    <Animated.View style={[styles.pillLabel, fade]} onLayout={onLayout}>
      <Text style={styles.pillText} numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
});

/**
 * Ein Bild der Vorschau. `fadeDuration={0}`: Android blendet geladene Bilder
 * sonst 300 ms ein — das Überblenden gehört hier allein den Hüllen.
 */
function Layer({ source }: { source: number }) {
  return <Image source={source} style={styles.fill} resizeMode="cover" fadeDuration={0} />;
}

export const MapStylePreview = memo(function MapStylePreview({
  ops,
  p3,
  labels,
}: {
  ops: readonly [SharedValue<number>, SharedValue<number>, SharedValue<number>];
  p3: SharedValue<number>;
  /** Beschriftung je Stil (Dunkel, Hell, Satellit) — „ · 3D" hängt die Vorschau an. */
  labels: readonly [string, string, string];
}) {
  const accent = useAccent();
  const palette = usePalette();
  const [opDark, opLight, opSat] = ops;
  const rise = ms(RISE);

  const darkStyle = useAnimatedStyle(() => ({ opacity: opDark.value }));
  const lightStyle = useAnimatedStyle(() => ({ opacity: opLight.value }));
  const satStyle = useAnimatedStyle(() => ({ opacity: opSat.value }));
  // Je Ebene ein eigener Stil — ein animierter Stil gehört zu genau einer Ansicht.
  const extrudeDark = useAnimatedStyle(() => ({
    opacity: p3.value,
    transform: [{ translateY: (1 - p3.value) * rise }],
  }));
  const extrudeLight = useAnimatedStyle(() => ({
    opacity: p3.value,
    transform: [{ translateY: (1 - p3.value) * rise }],
  }));
  /**
   * DIE BESCHRIFTUNG IST EINE BOX, die sich dehnt (Nutzer 06.11.2026: „die Box
   * springt — sie soll sich expanden, und der Text wird smooth reingefadet").
   *
   * Vorher waren es fünf fertige Pillen verschiedener Breite, die übereinander
   * überblendeten — „Hell" → „Hell · 3D" sah aus wie ein Sprung. Jetzt gleitet
   * die Breite EINER Box stufenlos zwischen den gemessenen Breiten der
   * Beschriftungen, gewichtet mit ihrem sichtbaren Anteil (`labelShares`) — sie
   * folgt also genau der Überblendung der Bilder, ohne eigene Uhr. Die Schrift
   * darin blendet über (`textFade`); die Box schneidet ab, was noch nicht
   * hineinpasst.
   */
  const textW = useSharedValue<number[]>([0, 0, 0, 0, 0]);
  /**
   * Die gemessenen Breiten liegen HIER, auf der JS-Seite — geschrieben wird
   * immer der ganze Satz.
   *
   * Vorher wurde der geteilte Wert gelesen, eine Breite eingetragen und
   * zurückgeschrieben. Die fünf Beschriftungen melden sich aber fast
   * gleichzeitig, und ein Schreiben vom JS-Strang kommt erst VERZÖGERT auf dem
   * UI-Strang an: Jede Meldung las den alten Stand und überschrieb die vorige.
   * Übrig blieb nur die letzte (Satellit) — bei Dunkel und Hell stand die Box
   * auf Breite 0 und war unsichtbar (Gerät, 06.11.2026).
   */
  const widthsRef = useRef([0, 0, 0, 0, 0]);
  const onWidth = useCallback(
    (index: number, width: number) => {
      const known = widthsRef.current;
      if (Math.abs(known[index] - width) < 0.5) return;
      known[index] = width;
      textW.value = known.slice();
    },
    [textW],
  );
  const pad = ms(PILL_PAD);
  const pillMax = ms(PILL_MAX);
  /** Breite der Box in diesem Bild; 0, bis die Beschriftungen gemessen sind. */
  const boxW = useDerivedValue(() => {
    const shares = labelShares(opDark.value, opLight.value, opSat.value, p3.value);
    const widths = textW.value;
    let sum = 0;
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      sum += shares[i];
      acc += shares[i] * widths[i];
    }
    const inner = sum > 0.0001 ? acc / sum : 0;
    return inner > 0 ? Math.min(pillMax, inner + 2 * pad) : 0;
  });
  /**
   * FLÜSSIG DEHNEN OHNE LAYOUT (Nutzer 06.11.2026: „die Box dehnt sich schon
   * gut, aber noch nicht flüssig").
   *
   * Die Breite stand als `width` im animierten Stil — eine Layout-Eigenschaft.
   * Die schickt Reanimated nicht über den schnellen Weg wie Deckkraft und
   * Verschiebung, sondern Bild für Bild durch einen Layout-Durchgang; die Box
   * hinkte der Überblendung der Bilder hinterher und ruckelte dabei.
   *
   * Jetzt ändert sich nur noch `translateX`: Der Körper der Box ist fest
   * `PILL_MAX` breit, rechts gerundet, und wird so weit nach links geschoben,
   * dass seine rechte Kante bei der Boxbreite steht; die Hülle schneidet links
   * (gerundet) ab, was über den Anfang hinausragt. Die Beschriftungen fahren
   * genau gegenläufig mit, stehen also still — der Körper schneidet ab, was
   * noch nicht hineinpasst. Alles im selben Bild wie die Überblendung.
   */
  const pillShow = useAnimatedStyle(() => ({ opacity: boxW.value > 0 ? 1 : 0 }));
  const pillBody = useAnimatedStyle(() => ({ transform: [{ translateX: boxW.value - pillMax }] }));
  const pillHold = useAnimatedStyle(() => ({ transform: [{ translateX: pillMax - boxW.value }] }));
  const texts = useMemo(
    () => [labels[0], `${labels[0]} · 3D`, labels[1], `${labels[1]} · 3D`, labels[2]],
    [labels],
  );

  return (
    <View
      // Grund in der Farbe der dunklen Karte — falls ein Bild beim ersten
      // Öffnen ein Bild später kommt, steht dort keine Lücke.
      style={[styles.card, { backgroundColor: DARK_PALETTE.bg }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[StyleSheet.absoluteFill, darkStyle]}>
        <Layer source={IMAGES.dark} />
        <Animated.View style={[StyleSheet.absoluteFill, extrudeDark]}>
          <Layer source={IMAGES.dark3d} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, lightStyle]}>
        <Layer source={IMAGES.light} />
        <Animated.View style={[StyleSheet.absoluteFill, extrudeLight]}>
          <Layer source={IMAGES.light3d} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, satStyle]}>
        <Layer source={IMAGES.satellite} />
      </Animated.View>

      {/* Der eigene Standort mittendrin (auf der Uferstraße) — dasselbe Zeichen
          wie auf der Karte. */}
      <View style={styles.center} pointerEvents="none">
        <View style={[styles.halo, { backgroundColor: accent.subtle }]}>
          <View style={[styles.dot, { backgroundColor: accent.solid }]} />
        </View>
      </View>

      <Animated.View style={[styles.pill, pillShow]} pointerEvents="none">
        <Animated.View style={[styles.pillBody, pillBody]}>
          {/* Breite Bahn für die Beschriftungen — sie messen sich darin in voller
              Länge, der Körper zeigt davon nur, was hineinpasst. */}
          <Animated.View style={[styles.pillTrack, pillHold]}>
            {texts.map((text, i) => (
              <PillLabel key={i} index={i} text={text} ops={ops} p3={p3} onWidth={onWidth} />
            ))}
          </Animated.View>
        </Animated.View>
      </Animated.View>

      {/* Die Kante ÜBER allem — am Bild selbst würde sie mit ihm überblenden. */}
      <View style={[styles.edge, { borderColor: palette.border }]} pointerEvents="none" />
    </View>
  );
});

const styles = scaledStyles({
  /** Volle Breite, Seitenverhältnis der Bilder; Radius der Karten in Blättern (20). */
  card: { width: "100%", aspectRatio: ASPECT, borderRadius: 20, overflow: "hidden" },
  fill: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  edge: { ...StyleSheet.absoluteFillObject, borderRadius: 20, borderWidth: 1 },
  center: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  /** Verhältnis wie `UserPin` auf der Karte: Hof doppelt so groß wie der Punkt samt Rand. */
  halo: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: "#0D0D0D" },
  /**
   * Unten links. Die HÜLLE: feste Breite, links gerundet, schneidet ab, was der
   * verschobene Körper links über den Anfang hinausschiebt.
   */
  pill: {
    position: "absolute",
    left: 12,
    bottom: 12,
    height: 28,
    width: PILL_MAX,
    borderTopLeftRadius: 14,
    borderBottomLeftRadius: 14,
    overflow: "hidden",
  },
  /** Der KÖRPER: deckend dunkel (liest sich auf jedem Stil), rechts gerundet. Lage: `pillBody`. */
  pillBody: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PILL_MAX,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "rgba(13,13,13,0.86)",
  },
  /** Breiter als jede Beschriftung — darin misst sich jede in voller Länge. */
  pillTrack: { position: "absolute", left: 0, top: 0, bottom: 0, width: 480 },
  /** Jede Beschriftung am selben linken Rand, senkrecht mittig. */
  pillLabel: { position: "absolute", left: PILL_PAD, top: 0, bottom: 0, justifyContent: "center" },
  pillText: { fontSize: 13, fontWeight: "600", color: "#F4F4F5" },
});
