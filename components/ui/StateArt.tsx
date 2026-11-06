/**
 * Zeichnungen für Zustände — leer, nichts gefunden, nicht geladen, und die
 * Rückfragen in Dialogen (04.11.2026). Sie ersetzen Bo überall dort, wo er
 * nicht selbst gemeint ist: Bo gehört in sein Fenster (Chat, „Geplant"), in die
 * Ladeszenen der Suche und zur Begrüßung nach der Anmeldung. Sonst „hat man
 * sich satt gesehen" — die Strichzeichnung sagt dasselbe ruhiger.
 *
 * Jeder Strich deckt sich in Zeichenrichtung auf (Regeln und Technik in
 * `lineArt.tsx`: nur Lage, kein Neurastern), danach macht die Zeichnung
 * höchstens EINE kleine Geste: Der Stecker rückt an die Dose, das Herz
 * schlägt, der Pfeil schiebt hinaus, der Deckel hebt sich. Dann steht alles
 * still. Einmal gestartet, läuft es zu Ende — auch wenn die Fläche inzwischen
 * verdeckt ist.
 *
 * `play` startet (z. B. erst, wenn die Schublade aufgeht). `surface` ist die
 * Fläche dahinter — Herz und vordere Sprechblase decken damit ab, was hinter
 * ihnen liegt.
 */
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Circle, G, Path } from "react-native-svg";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { ART_FAINT, ART_STROKE, FadeLayer, RevealLayer, STROKE_PROPS } from "@/components/ui/lineArt";

export type StateArtKind = "offline" | "noRoute" | "noMatch" | "chat" | "favorites" | "logout" | "delete";

/** Ab wann gezeichnet wird — die Fläche darum (Blatt, Dialog) ist dann so gut wie da. */
const START = 220;

/**
 * Wo jede Zeichnung wirklich Tinte hat — x1, y1, x2, y2 im 200er-Raster,
 * Striche eingerechnet (die Hüllen ihrer Ebenen, siehe `box`).
 *
 * Gezeigt wird NUR dieser Ausschnitt. Vorher stand jede Zeichnung in ihrem
 * vollen 200er-Quadrat, und das ist je nach Motiv bis zu zwei Drittel leer:
 * Unter der Lupe lagen 30 Punkte Luft, unter dem Stecker 32 — der Titel stand
 * dadurch weit ab, mal mehr, mal weniger, je nach Zeichnung („Nichts gefunden"
 * mit 45 Punkten Lücke, 05.11.2026). Abstände gelten zwischen SICHTBAREN
 * Kanten; mit dem Ausschnitt sind sie das, was `StatePanel` & Co. angeben.
 * Waagerecht ebenso: Herz und Tür lagen 8 Einheiten rechts der Mitte.
 *
 * Die eine Geste nach dem Zeichnen darf kurz darüber hinaus (Stecker, Pfeil,
 * Deckel) — beschnitten wird nicht.
 */
const INK: Record<StateArtKind, readonly [number, number, number, number]> = {
  offline: [10, 62, 192, 138],
  noRoute: [26, 34, 176, 150],
  noMatch: [51, 45, 149, 143],
  chat: [30, 40, 172, 160],
  favorites: [42, 36, 174, 170],
  logout: [48, 34, 170, 166],
  delete: [48, 40, 152, 171],
};

export function StateArt({
  kind,
  play = true,
  size,
  surface,
}: {
  kind: StateArtKind;
  play?: boolean;
  /**
   * Maßstab: So lang wäre die Kante des ganzen 200er-Rasters (in Punkten).
   * Gleicher Wert = gleiche Strichstärke in jeder Zeichnung. Belegt wird nur
   * der Ausschnitt mit Tinte (`INK`) — die Zeichnung ist also kleiner als
   * `size` × `size`.
   */
  size: number;
  surface?: string;
}) {
  const palette = usePalette();
  const k = size / 200;
  const art = { play, k, surface: surface ?? palette.s1 };
  const [x1, y1, x2, y2] = INK[kind];
  return (
    <View
      style={{ width: (x2 - x1) * k, height: (y2 - y1) * k }}
      // Reine Zier — gesagt wird es von Titel und Satz daneben.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {/* Das volle Raster, um den leeren Rand nach oben links verschoben. */}
      <View style={{ position: "absolute", left: -x1 * k, top: -y1 * k, width: size, height: size }}>
        {kind === "offline" ? <OfflineArt {...art} /> : null}
        {kind === "noRoute" ? <NoRouteArt {...art} /> : null}
        {kind === "noMatch" ? <NoMatchArt {...art} /> : null}
        {kind === "chat" ? <ChatArt {...art} /> : null}
        {kind === "favorites" ? <FavoritesArt {...art} /> : null}
        {kind === "logout" ? <LogoutArt {...art} /> : null}
        {kind === "delete" ? <DeleteArt {...art} /> : null}
      </View>
    </View>
  );
}

interface ArtProps {
  play: boolean;
  /** Punkte je Rastereinheit. */
  k: number;
  surface: string;
}

/**
 * Die eine Geste nach dem Zeichnen — genau einmal je Einhängen, nicht
 * anzuhalten (sie ist kurz).
 */
function useGesture(play: boolean, at: number, make: () => number): SharedValue<number> {
  const v = useSharedValue(0);
  const done = useRef(false);
  useEffect(() => {
    if (!play || done.current) return;
    done.current = true;
    v.value = withDelay(START + at, make());
    // `make` ist je Zeichnung fest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, v, at]);
  useEffect(() => () => cancelAnimation(v), [v]);
  return v;
}

const OUT = Easing.out(Easing.quad);
const IN_OUT = Easing.inOut(Easing.quad);
/** Hin und zurück — für Stecker, Pfeil und Deckel. */
const nudge = () =>
  withSequence(withTiming(1, { duration: 260, easing: OUT }), withTiming(0, { duration: 420, easing: IN_OUT }));

/** Drehpunkt als Verschiebung hin und zurück — nie `transformOrigin` (siehe PermissionSheet). */
function pivot(k: number, x: number, y: number) {
  return { px: (x - 100) * k, py: (y - 100) * k };
}

/** Nicht geladen: Stecker und Dose, getrennt. Danach rückt der Stecker einmal heran. */
function OfflineArt({ play, k }: ArtProps) {
  const accent = useAccent().solid;
  const near = useGesture(play, 1400, nudge);
  const plug = useAnimatedStyle(() => ({ transform: [{ translateX: 7 * k * near.value }] }));
  const at = { k, play };
  return (
    <>
      <RevealLayer {...at} box={[118, 76, 44, 48]} angle={0} delay={START + 420} duration={460}>
        <Path
          d="M132 80 L148 80 A10 10 0 0 1 158 90 L158 110 A10 10 0 0 1 148 120 L132 120 A10 10 0 0 1 122 110 L122 90 A10 10 0 0 1 132 80 Z"
          stroke={ART_FAINT}
          fill="none"
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <FadeLayer {...at} box={[128, 87, 8, 26]} delay={START + 860}>
        <Circle cx={132} cy={91} r={3} fill={ART_FAINT} />
        <Circle cx={132} cy={109} r={3} fill={ART_FAINT} />
      </FadeLayer>
      <RevealLayer {...at} box={[154, 62, 38, 42]} angle={-48} delay={START + 760} duration={340}>
        <Path d="M158 100 C172 100 172 66 188 66" stroke={ART_FAINT} fill="none" {...STROKE_PROPS} />
      </RevealLayer>
      <Animated.View style={[StyleSheet.absoluteFill, plug]}>
        <RevealLayer {...at} box={[10, 96, 52, 42]} angle={-38} delay={START} duration={380}>
          <Path d="M14 134 C38 134 36 100 58 100" stroke={accent} fill="none" {...STROKE_PROPS} />
        </RevealLayer>
        <RevealLayer {...at} box={[54, 78, 42, 44]} angle={0} delay={START + 260} duration={460}>
          <Path
            d="M58 82 L82 82 A10 10 0 0 1 92 92 L92 108 A10 10 0 0 1 82 118 L58 118 Z"
            stroke={accent}
            fill="none"
            {...STROKE_PROPS}
          />
        </RevealLayer>
        <RevealLayer {...at} box={[88, 87, 22, 26]} angle={0} delay={START + 680} duration={200}>
          <Path d="M92 91 L106 91" stroke={accent} fill="none" {...STROKE_PROPS} />
          <Path d="M92 109 L106 109" stroke={accent} fill="none" {...STROKE_PROPS} />
        </RevealLayer>
      </Animated.View>
    </>
  );
}

/** Keine Verbindung: Die Strecke beginnt, wird blass und gepunktet, das Ziel bleibt offen. */
function NoRouteArt({ play, k }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  return (
    <>
      <FadeLayer {...at} box={[26, 130, 20, 20]} delay={START}>
        <Circle cx={36} cy={140} r={9} fill={accent} />
      </FadeLayer>
      <RevealLayer {...at} box={[32, 94, 72, 50]} angle={-33} delay={START + 120} duration={480}>
        <Path d="M36 140 C66 140 74 104 100 98" stroke={accent} fill="none" {...STROKE_PROPS} />
      </RevealLayer>
      <RevealLayer {...at} box={[96, 58, 66, 44]} angle={-32} delay={START + 560} duration={460}>
        <Path
          d="M100 98 C128 92 138 66 158 62"
          stroke={ART_FAINT}
          fill="none"
          strokeDasharray={[0.1, 13]}
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <RevealLayer {...at} box={[140, 34, 36, 46]} angle={90} delay={START + 900} duration={380}>
        <Path d="M158 76 L149.3 63 A14 14 0 1 1 166.7 63 Z" stroke={ART_FAINT} fill="none" {...STROKE_PROPS} />
      </RevealLayer>
    </>
  );
}

/** Noch keine Chats: zwei Sprechblasen, in der vorderen tippt es. */
function ChatArt({ play, k, surface }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  return (
    <>
      <RevealLayer {...at} box={[92, 40, 80, 80]} angle={0} delay={START} duration={560}>
        <Path
          d="M108 44 L156 44 A12 12 0 0 1 168 56 L168 90 A12 12 0 0 1 156 102 L160 116 L144 102 L108 102 A12 12 0 0 1 96 90 L96 56 A12 12 0 0 1 108 44 Z"
          stroke={ART_FAINT}
          fill="none"
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <RevealLayer {...at} box={[30, 68, 108, 92]} angle={0} delay={START + 200} duration={680}>
        <Path
          d="M48 72 L120 72 A14 14 0 0 1 134 86 L134 126 A14 14 0 0 1 120 140 L70 140 L50 156 L54 140 L48 140 A14 14 0 0 1 34 126 L34 86 A14 14 0 0 1 48 72 Z"
          stroke={accent}
          fill={surface}
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <FadeLayer {...at} box={[57, 99, 14, 14]} delay={START + 860}>
        <Circle cx={64} cy={106} r={6} fill={accent} />
      </FadeLayer>
      <FadeLayer {...at} box={[77, 99, 14, 14]} delay={START + 960}>
        <Circle cx={84} cy={106} r={6} fill={accent} />
      </FadeLayer>
      <FadeLayer {...at} box={[97, 99, 14, 14]} delay={START + 1060}>
        <Circle cx={104} cy={106} r={6} fill={accent} />
      </FadeLayer>
    </>
  );
}

/** Noch nichts gemerkt: ein Herz vor einem Ticket; es schlägt einmal. */
function FavoritesArt({ play, k, surface }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  const beat = useGesture(play, 1250, () =>
    withSequence(
      withTiming(1, { duration: 110, easing: OUT }),
      withTiming(0, { duration: 130, easing: IN_OUT }),
      withTiming(0.6, { duration: 110, easing: OUT }),
      withTiming(0, { duration: 260, easing: IN_OUT }),
    ),
  );
  const { px, py } = pivot(k, 92, 125);
  const heart = useAnimatedStyle(() => ({
    transform: [
      { translateX: px },
      { translateY: py },
      { scale: 1 + 0.09 * beat.value },
      { translateX: -px },
      { translateY: -py },
    ],
  }));
  return (
    <>
      <RevealLayer {...at} box={[56, 36, 118, 84]} angle={0} delay={START} duration={640}>
        <Path
          d="M70 40 L160 40 A10 10 0 0 1 170 50 L170 66 A12 12 0 0 0 170 90 L170 106 A10 10 0 0 1 160 116 L70 116 A10 10 0 0 1 60 106 L60 90 A12 12 0 0 0 60 66 L60 50 A10 10 0 0 1 70 40 Z"
          stroke={ART_FAINT}
          fill="none"
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <RevealLayer {...at} box={[132, 48, 8, 60]} angle={90} delay={START + 560} duration={320}>
        <Path d="M136 52 L136 104" stroke={ART_FAINT} fill="none" strokeDasharray={[0.1, 11]} {...STROKE_PROPS} />
      </RevealLayer>
      <Animated.View style={[StyleSheet.absoluteFill, heart]}>
        <RevealLayer {...at} box={[42, 80, 100, 90]} angle={90} delay={START + 280} duration={720}>
          <Path
            d="M92 166 C68 148 46 132 46 108 C46 94 56 84 69 84 C79 84 87 90 92 98 C97 90 105 84 115 84 C128 84 138 94 138 108 C138 132 116 148 92 166 Z"
            stroke={accent}
            fill={surface}
            {...STROKE_PROPS}
          />
        </RevealLayer>
      </Animated.View>
    </>
  );
}

/** Abmelden: eine Tür, der Pfeil führt hinaus — und schiebt einmal nach. */
function LogoutArt({ play, k }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  const push = useGesture(play, 1100, nudge);
  const arrow = useAnimatedStyle(() => ({ transform: [{ translateX: 8 * k * push.value }] }));
  return (
    <>
      <RevealLayer {...at} box={[48, 34, 74, 132]} angle={90} delay={START} duration={620}>
        <Path
          d="M118 58 L118 46 A8 8 0 0 0 110 38 L60 38 A8 8 0 0 0 52 46 L52 154 A8 8 0 0 0 60 162 L110 162 A8 8 0 0 0 118 154 L118 142"
          stroke={ART_FAINT}
          fill="none"
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <Animated.View style={[StyleSheet.absoluteFill, arrow]}>
        <RevealLayer {...at} box={[82, 96, 88, 8]} angle={0} delay={START + 360} duration={340}>
          <Path d="M86 100 L166 100" stroke={accent} fill="none" {...STROKE_PROPS} />
        </RevealLayer>
        <RevealLayer {...at} box={[138, 72, 32, 56]} angle={90} delay={START + 620} duration={260}>
          <Path d="M142 76 L166 100 L142 124" stroke={accent} fill="none" {...STROKE_PROPS} />
        </RevealLayer>
      </Animated.View>
    </>
  );
}

/** Löschen: ein Eimer; sein Deckel hebt sich einmal an. */
function DeleteArt({ play, k }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  const lift = useGesture(play, 1150, nudge);
  // Um das linke Ende des Deckels (52 | 62).
  const { px, py } = pivot(k, 52, 62);
  const lid = useAnimatedStyle(() => ({
    transform: [
      { translateX: px },
      { translateY: py },
      { rotate: `${-14 * lift.value}deg` },
      { translateX: -px },
      { translateY: -py },
    ],
  }));
  return (
    <>
      <RevealLayer {...at} box={[62, 68, 76, 103]} angle={90} delay={START} duration={620}>
        <Path
          d="M66 72 L74 158 A10 10 0 0 0 84 167 L116 167 A10 10 0 0 0 126 158 L134 72"
          stroke={accent}
          fill="none"
          {...STROKE_PROPS}
        />
      </RevealLayer>
      <RevealLayer {...at} box={[86, 90, 28, 58]} angle={90} delay={START + 520} duration={300}>
        <Path d="M90 94 L92 144" stroke={ART_FAINT} fill="none" {...STROKE_PROPS} />
        <Path d="M110 94 L108 144" stroke={ART_FAINT} fill="none" {...STROKE_PROPS} />
      </RevealLayer>
      <Animated.View style={[StyleSheet.absoluteFill, lid]}>
        <RevealLayer {...at} box={[48, 58, 104, 8]} angle={0} delay={START + 420} duration={320}>
          <Path d="M52 62 L148 62" stroke={accent} fill="none" {...STROKE_PROPS} />
        </RevealLayer>
        <RevealLayer {...at} box={[80, 40, 40, 26]} angle={0} delay={START + 660} duration={260}>
          <Path
            d="M84 62 L84 52 A8 8 0 0 1 92 44 L108 44 A8 8 0 0 1 116 52 L116 62"
            stroke={accent}
            fill="none"
            {...STROKE_PROPS}
          />
        </RevealLayer>
      </Animated.View>
    </>
  );
}

/* ------------------------------------------------------------------ Suche */

/**
 * Lupe und Ortsnadel sind die Umrisse der lucide-Symbole, die die App ohnehin
 * zeigt (24er-Raster) — groß ins 200er-Raster gesetzt, der Strich bleibt 6 wie
 * in jeder Zeichnung. So passt das große Bild zu den kleinen Zeichen der Suche.
 */
const SEARCH = ["m21 21-4.34-4.34"];
const SEARCH_LENS: readonly (readonly [number, number, number])[] = [[11, 11, 8]];
const PIN = [
  "M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0",
];
const PIN_DOT: readonly (readonly [number, number, number])[] = [[12, 10, 3]];

function Glyph({
  paths,
  circles = [],
  tx,
  ty,
  s,
  color,
}: {
  paths: readonly string[];
  circles?: readonly (readonly [number, number, number])[];
  tx: number;
  ty: number;
  /** Rastereinheiten je Symbol-Einheit. */
  s: number;
  color: string;
}) {
  const w = ART_STROKE / s;
  return (
    <G transform={`translate(${tx} ${ty}) scale(${s})`}>
      {paths.map((d) => (
        <Path key={d} d={d} stroke={color} fill="none" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {circles.map(([cx, cy, r]) => (
        <Circle key={`${cx}|${cy}`} cx={cx} cy={cy} r={r} stroke={color} fill="none" strokeWidth={w} />
      ))}
    </G>
  );
}

/** Kein Treffer bei der Ortssuche: eine Lupe, darin blass eine Ortsnadel; sie sucht einmal hin und her. */
function NoMatchArt({ play, k }: ArtProps) {
  const accent = useAccent().solid;
  const at = { k, play };
  const scan = useGesture(play, 1050, () =>
    withSequence(
      withTiming(1, { duration: 240, easing: OUT }),
      withTiming(-0.7, { duration: 320, easing: IN_OUT }),
      withTiming(0, { duration: 260, easing: IN_OUT }),
    ),
  );
  const lens = useAnimatedStyle(() => ({ transform: [{ translateX: 6 * k * scan.value }] }));
  return (
    <>
      <FadeLayer {...at} box={[73, 63, 44, 53]} delay={START + 560} duration={280}>
        <Glyph paths={PIN} circles={PIN_DOT} tx={68.6} ty={63} s={2.2} color={ART_FAINT} />
      </FadeLayer>
      <Animated.View style={[StyleSheet.absoluteFill, lens]}>
        <RevealLayer {...at} box={[51, 45, 98, 98]} angle={45} delay={START} duration={640}>
          <Glyph paths={SEARCH} circles={SEARCH_LENS} tx={40} ty={34} s={5} color={accent} />
        </RevealLayer>
      </Animated.View>
    </>
  );
}
