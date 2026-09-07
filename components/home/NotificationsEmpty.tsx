import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { useReduceMotion } from "@/lib/motion";
import { useT } from "@/lib/i18n/useT";
import { usePalette, type Palette } from "@/lib/theme/appBg";
import { SPACE } from "@/lib/theme/spacing";
import { ms, scaledStyles } from "@/lib/ui/compact";

/**
 * Die leeren Zustände des Benachrichtigungs-Blattes.
 *
 * Aus einer Design-Übergabe (Varianten 2b, 2c, 2e) übernommen — die Idee, die
 * Maßverhältnisse und die Bewegungen stammen von dort. Angepasst wurde alles,
 * was die Übergabe nur annehmen konnte:
 *
 *  - **Farben** aus der App-Palette statt aus dem mitgelieferten Satz. Der war
 *    auf einen helleren Grund (#1A1A1A) gerechnet; unser Blatt liegt auf `s1`
 *    (#0D0D0D). Die Stufen sind dieselben, nur eben unsere.
 *  - **Schrift** aus dem Standard für leere Zustände (16/600 und 13/20), nicht
 *    die 20/700 und 14,5/21 der Übergabe. Denselben Block gibt es im Saved-Tab
 *    und in der Ergebnisliste schon zweimal; eine dritte, etwas größere Fassung
 *    wäre genau die Sorte Abweichung, die man später wieder einsammelt.
 *  - **Abstände** aufs 4er-Raster: Listenabstand 8 statt 10, Balkenabstand 8
 *    statt 7, Eckenradius 16 statt 20 (der Radius jeder Box in dieser App).
 *  - **Bewegung** über Reanimated statt `Animated` aus React Native. Das ist
 *    kein Geschmack: Auf der neuen Architektur bleibt `Animated` mit
 *    `useNativeDriver` am Startwert hängen — die Zeilen pulsten schlicht nicht.
 *  - **Der gestrichelte Rahmen** kommt aus SVG statt aus `borderStyle:
 *    "dashed"`. Android zeichnet den gestrichelten Rahmen einer abgerundeten
 *    Box über einen Pfad-Effekt auf dem Zeichenstift, und ob der bei
 *    hardware-beschleunigtem Zeichnen greift, hängt an der Android-Version.
 *    Mit SVG steht das Muster fest.
 */
export type NotificationsEmptyVariant = "ghostRows" | "zero" | "boIcon";

/** Sanft, in beide Richtungen gleich — die Kurve der Übergabe. */
const EASE = Easing.inOut(Easing.ease);

/**
 * `active` schaltet die Schleifen, nicht das Aufbauen.
 *
 * Das Blatt hängt dauerhaft am Wurzel-Layout. Ohne diesen Schalter liefen drei
 * bis vier endlose Worklets die ganze Sitzung lang mit — auf jedem anderen Tab,
 * bei jedem Scrollen. Dieselbe Vorsichtsmaßnahme wie Bos `paused`.
 */
interface Props {
  variant: NotificationsEmptyVariant;
  active: boolean;
}

export function NotificationsEmpty({ variant, active }: Props) {
  const t = useT();
  const palette = usePalette();

  const copy =
    variant === "zero"
      ? { title: "notifications.empty.zero.title", body: "notifications.empty.zero.body" }
      : variant === "boIcon"
      ? { title: "notifications.empty.bo.title", body: "notifications.empty.bo.body" }
      : { title: "notifications.empty.rows.title", body: "notifications.empty.rows.body" };

  return (
    <View style={styles.stage}>
      {variant === "ghostRows" ? <GhostRows palette={palette} active={active} /> : null}
      {variant === "zero" ? <BigZero palette={palette} /> : null}
      {variant === "boIcon" ? <BoOutline active={active} /> : null}

      <Text style={styles.title}>{t(copy.title)}</Text>
      <Text style={styles.body}>{t(copy.body)}</Text>
    </View>
  );
}

/* ------------------------------------------------ 2b · gestrichelte Zeilen */

/**
 * Drei angedeutete Zeilen zeigen, WO Benachrichtigungen landen werden.
 *
 * Die Maße stehen als Konstanten und nicht im Stilblatt, weil der SVG-Rahmen
 * sie als Zahlen braucht: Ein Rechteck in SVG kennt keine Prozente vom
 * Elternteil. Beide Wege müssen denselben Wert benutzen, sonst sitzt der
 * Rahmen neben der Zeile.
 */
const ROW_W = ms(300);
const ROW_H = ms(60);
const ROW_R = ms(16);
/** 3 an, 3 aus — dieselbe Teilung, die Android für einen 1px-Strich nimmt. */
const DASH = "3 3";

const ROWS: { delay: number; w1: `${number}%`; w2: `${number}%` }[] = [
  { delay: 0, w1: "62%", w2: "38%" },
  { delay: 800, w1: "50%", w2: "30%" },
  { delay: 1600, w1: "56%", w2: "34%" },
];

function GhostRows({ palette, active }: { palette: Palette; active: boolean }) {
  return (
    <View style={styles.rows}>
      {ROWS.map((row) => (
        <GhostRow key={row.delay} {...row} palette={palette} active={active} />
      ))}
    </View>
  );
}

function GhostRow({
  delay,
  w1,
  w2,
  palette,
  active,
}: {
  delay: number;
  /** Prozent-Literal, nicht `string` — die Stil-Typen von React Native
   *  akzeptieren nur `${number}%`. */
  w1: `${number}%`;
  w2: `${number}%`;
  palette: Palette;
  active: boolean;
}) {
  const reduce = useReduceMotion();
  /**
   * 0,30 bis 0,62 — die Werte der Übergabe, unverändert übernommen.
   *
   * Sie waren auf einen helleren Grund gerechnet, und ich hatte sie deshalb
   * anheben wollen. Nachgerechnet war das falsch: Bei 62% liegt der Strich dort
   * 10 Stufen über seinem Grund, bei uns 12 — unser dunkleres Blatt gleicht den
   * dunkleren Strich mehr als aus.
   */
  const op = useSharedValue(reduce ? 0.5 : 0.3);

  useEffect(() => {
    if (!active || reduce) {
      cancelAnimation(op);
      /**
       * Zurück auf den Ruhewert MIT Kurve, nicht als Zuweisung.
       *
       * `active` fällt im selben Moment, in dem das Schließen beginnt — das
       * Blatt fährt danach aber noch 260ms sichtbar hinaus. Eine harte
       * Zuweisung ließe alle drei Zeilen im ersten Bild der Ausfahrt sichtbar
       * dunkler springen. 200ms sind kürzer als die Ausfahrt, der Übergang ist
       * also vorbei, bevor das Blatt aus dem Bild ist.
       */
      op.value = withTiming(reduce ? 0.5 : 0.3, { duration: 200, easing: EASE });
      return;
    }
    op.value = withDelay(
      delay,
      withRepeat(withTiming(0.62, { duration: 2500, easing: EASE }), -1, true),
    );
    return () => cancelAnimation(op);
  }, [active, reduce, delay, op]);

  const style = useAnimatedStyle(() => ({ opacity: op.value }));

  return (
    <Animated.View style={[styles.row, { width: ROW_W, height: ROW_H }, style]}>
      {/* Der gestrichelte Rahmen liegt HINTER dem Inhalt und misst genau die
          Zeile: der halbe Strich nach innen versetzt, sonst schneidet ihn die
          Kante zur Hälfte ab. */}
      <Svg width={ROW_W} height={ROW_H} style={StyleSheet.absoluteFill}>
        <Rect
          x={0.5}
          y={0.5}
          width={ROW_W - 1}
          height={ROW_H - 1}
          rx={ROW_R}
          ry={ROW_R}
          fill="none"
          stroke={palette.s3}
          strokeWidth={1}
          strokeDasharray={DASH}
        />
      </Svg>
      <View style={[styles.rowThumb, { backgroundColor: palette.s2 }]} />
      <View style={styles.rowBars}>
        <View style={[styles.bar, { width: w1, backgroundColor: palette.s3 }]} />
        <View style={[styles.bar, { width: w2, backgroundColor: palette.s2 }]} />
      </View>
    </Animated.View>
  );
}

/* ------------------------------------------------------------ 2c · Null */

function BigZero({ palette }: { palette: Palette }) {
  /**
   * OHNE `letterSpacing` — die Übergabe hat −8, und das gehört hier weg.
   *
   * Der Abstand wird auch HINTER das letzte Zeichen gesetzt. Bei einer
   * mehrstelligen Zahl fällt das nicht auf, bei einer einzelnen Null ist die
   * Textbox dadurch schmaler als das Zeichen und die Null sitzt sichtbar neben
   * der Mitte.
   */
  return <Text style={[styles.zero, { color: palette.s3 }]}>0</Text>;
}

/* -------------------------------------------------------- 2e · Bo als Ikone */

/** Gedeckte Symbolfarbe — dieselbe wie am leeren Tickets-Reiter. */
const ICON_GRAY = "#56565C";

/** 76 breit wie in der Übergabe; die Höhe folgt dem Ausschnitt (152:190). */
const BO_W = ms(76);
const BO_H = Math.round(BO_W * (190 / 152));

/**
 * Bo auf eine Strich-Ikone reduziert.
 *
 * Die Silhouette ist NICHT nachgezeichnet, sondern Bos echter Körperpfad aus
 * `components/assistant/Bo.tsx` — dieselbe Kuppel, dieselben vier Wellen unten,
 * dieselben Augenpositionen. Die Übergabe hatte hier eine eigene Ghost-Form;
 * die wäre neben dem echten Bo im Assistenten als anderes Wesen aufgefallen.
 *
 * Was bleibt, ist die Idee der Übergabe: nur Umriss, keine Farbe, kein Leuchten
 * — Bo als ruhiges Zeichen statt als Figur.
 */
function BoOutline({ active }: { active: boolean }) {
  const reduce = useReduceMotion();
  const y = useSharedValue(0);

  useEffect(() => {
    if (!active || reduce) {
      cancelAnimation(y);
      // Gleiten statt Rucken — siehe die Zeilen oben.
      y.value = withTiming(0, { duration: 200, easing: EASE });
      return;
    }
    y.value = withRepeat(withTiming(-5, { duration: 3000, easing: EASE }), -1, true);
    return () => cancelAnimation(y);
  }, [active, reduce, y]);

  /** Die Bewegung sitzt auf der HÜLLE, nicht auf SVG-Eigenschaften: Ein
   *  animiertes Attribut im SVG macht die ganze Fläche ungültig. */
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));

  return (
    <Animated.View style={style}>
      <Svg width={BO_W} height={BO_H} viewBox="24 40 152 190">
        <Path
          d="M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z"
          fill="none"
          stroke={ICON_GRAY}
          strokeWidth={5}
          strokeLinejoin="round"
        />
        <Circle cx={76} cy={120} r={8} fill={ICON_GRAY} />
        <Circle cx={124} cy={120} r={8} fill={ICON_GRAY} />
        <Path
          d="M89 150 Q100 159 111 150"
          fill="none"
          stroke={ICON_GRAY}
          strokeWidth={5}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

/* ------------------------------------------------------------------ Stile */

const styles = scaledStyles({
  /**
   * OBEN verankert, nicht mittig.
   *
   * Die Übergabe zentrierte den Block und hob ihn mit einem `paddingBottom`
   * über die rechnerische Mitte. Auf einem fast bildschirmhohen Blatt reicht das
   * nicht: Zwischen Kopfzeile und Block klaffte eine leere Fläche, und der Block
   * saß sichtbar zu tief.
   *
   * 64 ist derselbe Abstand, mit dem die leeren Zustände im Saved-Tab und in der
   * Ergebnisliste unter ihrer Überschrift beginnen. Damit fängt der Block auf
   * jeder Bildschirmhöhe an derselben Stelle an, statt mit dem freien Platz
   * darunter zu wandern — und alle drei Varianten setzen oben bündig auf,
   * obwohl sie verschieden hoch sind.
   */
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: SPACE.xxxl,
    paddingTop: 64,
  },

  /** Maße wie im leeren Zustand des Saved-Tabs. */
  title: {
    fontSize: 16,
    fontWeight: "600",
    color: "#F4F4F5",
    textAlign: "center",
    marginBottom: SPACE.sm,
  },
  body: { fontSize: 13, lineHeight: 20, color: "#8E8E93", textAlign: "center" },

  rows: { gap: SPACE.sm, marginBottom: SPACE.xxl },
  /**
   * OHNE Breite und Höhe — die stehen am Element.
   *
   * `ROW_W` und `ROW_H` sind schon durch `ms()` gedreht (der SVG-Rahmen braucht
   * sie als Zahlen). In diesem Blatt bekämen sie den Faktor ein zweites Mal:
   * auf einem kurzen Gerät aus 300 erst 255 und dann 217.
   */
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: 14,
  },
  rowThumb: { width: 32, height: 32, borderRadius: 10 },
  rowBars: { flex: 1, gap: SPACE.sm },
  bar: { height: 8, borderRadius: 9999 },

  zero: { fontSize: 132, lineHeight: 138, fontWeight: "800", marginBottom: SPACE.lg },
});
