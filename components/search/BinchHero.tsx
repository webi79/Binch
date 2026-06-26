/**
 * Animated Search-Hero — ersetzt die statischen PNG-Hintergründe für
 * Flug/Zug/Bus/Cruise mit einer SVG-Animation (Himmel + Sonne/Mond +
 * Wolken/Sterne + ruhige Dünen-Silhouette).
 *
 * Vier Categories × drei Zeit-Stimmungen:
 *   - category: "flug" | "zug" | "bus" | "kreuzfahrt"  → Dünen-Phase (Seed)
 *   - time:     "morgen" | "tag" | "nacht"             → Farbpalette
 *
 * `time` kommt typischerweise aus pickTimeOfDay() (siehe Helper unten),
 * basierend auf der aktuellen Geräte-Uhrzeit.
 *
 * Animationen via RN's eingebautes Animated-API (kein Reanimated) damit
 * keine Worklets nötig sind und der Hero auch in Liste/Modal ohne extra
 * Setup läuft.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, {
  Defs,
  LinearGradient,
  RadialGradient,
  Stop,
  Rect,
  Circle,
  Ellipse,
  G,
  Path,
} from "react-native-svg";
import { useSearchStore } from "@/stores/searchStore";

// Reanimated-wrapped Circle — wir animieren cy + opacity direkt auf den
// Sonnen-Circles INNERHALB der SVG. Damit kann die dritte Düne, die nach
// der Sonne im SVG gerendert wird, die untere Hälfte überlagern (Sunset-
// Look bei morgen).
const ReanimatedCircle = Reanimated.createAnimatedComponent(Circle);


const W = 390;
const H = 446;

export type HeroCategory = "flug" | "zug" | "bus" | "kreuzfahrt";
export type HeroTime = "morgen" | "tag" | "nacht";

interface TimePalette {
  sky: Array<[number, string]>;
  warm?: { x: number; y: number; col: string };
  light: { cx: number; cy: number; r: number; core: string; glow: string; moon?: boolean };
  hills: [string, string, string];
  rim: string;
  stars: number;
}

// Drei Tages-Variants, alle aus der Original-Vorlage:
//   morgen → dunkler Sunrise (purple→pink→orange→gold) mit niedriger Sonne
//   tag    → heller Mittag (lila→pink→peach→cream) mit hoher Cremesonne
//   nacht  → tiefes Navy mit Mond + 32 Sterne
const TIMES: Record<HeroTime, TimePalette> = {
  morgen: {
    // Sky-Palette aus dem BinchAuthScreen — gelb → orange → lila → navy
    // (Sunrise/Sunset-Look). Locations exakt wie im AuthScreen-Gradient.
    sky: [
      [0, "#f7b15c"],
      [0.3, "#e8784e"],
      [0.64, "#7a4a6e"],
      [1, "#2c3a63"],
    ],
    // Sonne tief am Horizont, größer (r=62). End-Position cy=230 (nochmal
    // 15dp höher), horizontal zentriert (cx=W/2=195). Wird komplett von
    // ALLEN Dünen überlagert — nur die obere Kuppe schaut über die
    // hinterste Dünen-Linie.
    light: { cx: 195, cy: 230, r: 62, core: "#FCE7B6", glow: "#F3A858" },
    hills: ["#3a2740", "#22182f", "#0e0a18"],
    rim: "#e8784e",
    stars: 0,
  },
  tag: {
    // Pure 5-Stop-Gradient OHNE warm-Overlay. Vorher hat der warm-Radial
    // die unteren Stopps mit Orange übertönt → die reinen Lavendel/Rose-
    // Töne waren verfälscht. Jetzt sieht der Sky aus wie der saubere
    // Gradient den der LinearGradient-Placeholder zeigte.
    sky: [
      [0, "#8C7BA8"],
      [0.38, "#B98EA0"],
      [0.66, "#E2A878"],
      [0.85, "#F0C290"],
      [1, "#F6D3A2"],
    ],
    light: { cx: 300, cy: 150, r: 50, core: "#F0DFB8", glow: "#E8C088" },
    hills: ["#3A4A63", "#26354C", "#141E2E"],
    rim: "#C99A86",
    stars: 0,
  },
  nacht: {
    sky: [[0, "#070A1C"], [0.55, "#101634"], [1, "#26315C"]],
    light: { cx: 300, cy: 140, r: 40, core: "#ECF1FF", glow: "#9FB6E0", moon: true },
    hills: ["#1E2B4A", "#16213A", "#0A1120"],
    rim: "#5E7CB4",
    stars: 32,
  },
};

const SEED: Record<HeroCategory, number> = { flug: 0, zug: 1, bus: 2, kreuzfahrt: 3 };

// Original-Dünen-Setup (wie in der Vorlage). baseY=350 für die dritte Düne
// landet rein technisch nahe am Container-Bottom, der bottom-fade-Rect
// blendet aber alles unter y=H-96=350 sanft in `melt` ein → die dritte
// Düne bleibt als Silhouette voll erkennbar. Amplituden 44/56/60 sorgen
// für die kräftige, dramatische Skyline aus der Vorlage.
const DUNES = [
  { baseY: 230, amp: 44, n: 4 },
  { baseY: 286, amp: 56, n: 4 },
  { baseY: 350, amp: 60, n: 3 },
];

function smoothTop(pts: number[][]): string {
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    d += ` Q ${pts[i - 1][0]},${pts[i - 1][1]} ${mx},${my}`;
  }
  const last = pts[pts.length - 1];
  return d + ` L ${last[0]},${last[1]}`;
}

function duneTop(layer: { baseY: number; amp: number; n: number }, ph: number): string {
  const pts: number[][] = [[0, layer.baseY + layer.amp * 0.3]];
  for (let i = 0; i <= layer.n; i++) {
    pts.push([(W * i) / layer.n, layer.baseY - layer.amp * (0.5 + 0.5 * Math.sin(i * 1.7 + ph))]);
  }
  pts.push([W, layer.baseY + layer.amp * 0.3]);
  return smoothTop(pts);
}

const closeDune = (top: string) => `${top} L ${W},${H} L 0,${H} Z`;

function makeStars(n: number): Array<[number, number, number, number]> {
  // Deterministischer PRNG damit Sterne pro Reload an gleicher Stelle bleiben
  // und nicht jeden Mount unterschiedlich tanzen (sähe nervös aus).
  let s = 91;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out: Array<[number, number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    out.push([rnd() * W, rnd() * 170 + 8, rnd() * 1.1 + 0.5, rnd() * 2 + 1]);
  }
  return out;
}

/** Bestimmt anhand der aktuellen Stunde welche Tageszeit-Stimmung passt.
 *  06-12 = morgen, 12-21 = tag (mittag), 21-06 = nacht. */
export function pickTimeOfDay(date: Date = new Date()): HeroTime {
  const h = date.getHours();
  if (h >= 6 && h < 12) return "morgen";
  if (h >= 12 && h < 21) return "tag";
  return "nacht";
}

interface Props {
  category: HeroCategory;
  time?: HeroTime;
  /** Farbe in die der untere Rand auslaufen soll (App-Bg-Farbe). */
  melt?: string;
  style?: StyleProp<ViewStyle>;
  /** Stoppt alle Animations-Loops und die Rise-Anim. Nützlich wenn ein
   *  Modal-Overlay über dem Hero auf slidet — sonst konkurriert unsere
   *  RAF-getriebene Animation mit der Reanimated-Slide-Animation des
   *  Modals und produziert sichtbares Lag. */
  paused?: boolean;
}

function BinchHeroComponent({ category, time = "tag", melt = "#1A1A1A", style, paused = false }: Props) {
  // Picker-Open direkt aus dem Store lesen — damit pausiert BinchHero
  // SOFORT beim Tap auf ein Feld (Store-Update ist synchron, BinchHero
  // re-rendert mit pickerOpen=true im SELBEN React-Commit wie der Picker
  // sliden anfängt). Ohne diese direkte Subscription musste SearchHero
  // erst re-rendern → paused=true Prop nach unten → BinchHero re-render
  // → erst dann cancelAnimation. 2 Frames Verzögerung waren genug für
  // sichtbares Stutter im Slide.
  const pickerOpen = useSearchStore(
    (s) => s.locationPickerRequest !== null || s.datePickerRequest !== null,
  );
  const effectivePaused = paused || pickerOpen;
  const palette = TIMES[time];
  const light = palette.light;
  const seed = SEED[category] ?? 0;
  const ph = seed * 0.9;

  const stars = useMemo(() => (palette.stars ? makeStars(palette.stars) : []), [palette.stars]);
  const dunes = useMemo(
    () =>
      DUNES.map((layer, i) => {
        const top = duneTop(layer, ph + i * 1.6);
        return { d: closeDune(top), top, color: palette.hills[i] };
      }),
    [category, time, ph, palette.hills],
  );

  // Sun-Rise via Reanimated (RN's Animated mit useNativeDriver hat auf
  // Fabric/New-Architecture buggy gerendert — Animation startete nicht).
  // Reanimated v4 ist explizit für Fabric gebaut → läuft zuverlässig.
  const sunRise = useSharedValue(0);
  const glowR = light.r * 2.7;
  const cloudX = 7;
  const starOpacity = 0.77;

  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    if (effectivePaused) {
      cancelAnimation(sunRise);
      sunRise.value = 1;
      return;
    }
    if (hasAnimatedRef.current) return;
    hasAnimatedRef.current = true;
    sunRise.value = withDelay(
      400,
      withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }),
    );
  }, [effectivePaused, sunRise]);

  // Sun-Animation auf die einzelnen Circles im SVG: cy + opacity. Die Circles
  // sind zwischen DUNES[1] und DUNES[2] im SVG-Baum → DUNES[2] (vorderste
  // Düne) überlagert die Sonne. Für morgen mit tiefer Sonne ergibt das den
  // klassischen Sunset-hinter-Berg-Effekt.
  const sunCircleProps = useAnimatedProps(() => ({
    cy: light.cy + (1 - sunRise.value) * 34,
    opacity: sunRise.value,
  }));
  const glowCircleProps = useAnimatedProps(() => ({
    cy: light.cy + (1 - sunRise.value) * 34,
    opacity: sunRise.value * 0.8,
  }));

  const warmFade = palette.warm
    ? palette.warm.col.replace(/[\d.]+\)$/, "0)")
    : null;

  return (
    <View
      style={[
        { width: "100%", height: H, backgroundColor: "#161616", overflow: "hidden" },
        style,
      ]}
    >
      {/* Die schwere Sky-SVG (Gradient/Sonne/Glows/Dünen) NUR rendern, wenn KEIN
          Picker offen ist. Sobald LocationPicker/DatePicker offen ist, liegt das
          opake Vollbild-Sheet (+ dunkler 0.75-Backdrop) drüber → die SVG ist
          unsichtbar, wird aber von Fabric/Android hinter dem transformierten
          Sheet pro Frame mit-compositet und frisst beim Kalender-Scrollen
          UI-Thread (react-native-svg = teures Layer). Der solide #161616-
          Hintergrund der umgebenden View bleibt; bei Slide-In ist eh alles
          75% abgedunkelt. */}
      {/* An pickerOpen (nicht effectivePaused!) gehängt: effectivePaused bleibt
          nach dem Schließen noch true (pausiert Kreaturen nach Interaktion) → die
          SVG würde sonst dauerhaft fehlen. pickerOpen ist nur true, solange ein
          Picker die SVG wirklich überdeckt. */}
      {!pickerOpen && (
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        style={{ transform: [{ scale: 1.07 }] }}
      >
        <Defs>
          {/* Vertikaler Sky-Gradient (oben → unten) wie in der Vorlage —
              Farben werden über die Höhe verteilt, am Horizont (kurz vor
              den Dünen) ist's am hellsten/wärmsten, oben am Zenit dunkler. */}
          <LinearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            {palette.sky.map(([o, c], i) => (
              <Stop key={i} offset={o} stopColor={c} />
            ))}
          </LinearGradient>
          <RadialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={light.glow} stopOpacity="0.8" />
            <Stop offset="1" stopColor={light.glow} stopOpacity="0" />
          </RadialGradient>
          {palette.warm && warmFade ? (
            <RadialGradient
              id="warm"
              cx={String(palette.warm.x)}
              cy={String(palette.warm.y)}
              r="0.7"
            >
              <Stop offset="0" stopColor={palette.warm.col} />
              <Stop offset="1" stopColor={warmFade} />
            </RadialGradient>
          ) : null}
          <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.hills[2]} stopOpacity="0" />
            <Stop offset="1" stopColor={melt} />
          </LinearGradient>
        </Defs>

        <Rect x="0" y="0" width={W} height={H} fill="url(#sky)" />
        {palette.warm ? <Rect x="0" y="0" width={W} height={H} fill="url(#warm)" /> : null}

        {/* Sterne (nur nachts) */}
        {stars.length > 0 ? (
          <G opacity={starOpacity}>
            {stars.map((s, i) => (
              <Circle key={i} cx={s[0]} cy={s[1]} r={s[2]} fill="#fff" />
            ))}
          </G>
        ) : null}

        {/* Wolken (nur tagsüber/morgens — bei Sternen-Modus aus). */}
        {palette.stars === 0 ? (
          <G opacity={time === "tag" ? 0.7 : 0.45} x={cloudX}>
            <Ellipse cx="91" cy="132" rx="74" ry="13" fill="#fff" opacity="0.12" />
            <Ellipse cx="233" cy="100" rx="56" ry="10" fill="#fff" opacity="0.10" />
          </G>
        ) : null}

        {/* Sonne / Mond — Glow + Core. cy + opacity animiert (rise 34→0).
            Wird VOR allen Dünen gerendert → alle Dünen überlagern die Sonne.
            Nur der oberste Teil der Sonne ragt über die hinterste Dünen-
            Linie hervor (Sun-set-hinter-Bergen-Look). */}
        <ReanimatedCircle
          cx={light.cx}
          r={glowR}
          fill="url(#glow)"
          animatedProps={glowCircleProps}
        />
        <ReanimatedCircle
          cx={light.cx}
          r={light.r}
          fill={light.core}
          animatedProps={sunCircleProps}
        />

        {/* ALLE Dünen-Silhouetten NACH der Sonne — verdecken die Sonne
            entsprechend ihrer Y-Position. */}
        {dunes.map((d, i) => (
          <G key={i}>
            <Path d={d.d} fill={d.color} />
            <Path d={d.top} fill="none" stroke={palette.rim} strokeOpacity="0.4" strokeWidth="1.4" />
          </G>
        ))}

        {/* Bottom-Auslauf in die App-Bg-Farbe (Übergang zum Form-Bereich). */}
        <Rect x="0" y={H - 96} width={W} height="96" fill="url(#fade)" />
      </Svg>
      )}

    </View>
  );
}

// memo verhindert Re-Renders wenn SearchHero seinen State ändert (z.B.
// pickerField oder Segment-Wechsel). Der schwere SVG-Tree muss nur bei
// wirklicher Prop-Änderung neu durchlaufen werden.
export const BinchHero = memo(BinchHeroComponent);
