import { memo } from "react";
import { ScrollView, Text, View, type ViewStyle } from "react-native";
import { FadePress } from "@/components/ui/FadePress";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { usePalette } from "@/lib/theme/appBg";
import { SPACE } from "@/lib/theme/spacing";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * EINE Knopfreihe für die ganze App — Kategorien unter „Gespeichert" und
 * Sortierung im Ergebnis-Screen.
 *
 * Beide waren einmal verschieden: hier Konturen, dort nackter Text mit einem
 * Unterstrich. Zwei Bedienmuster für dieselbe Sache — „wähle eines aus dieser
 * kurzen Liste" — und der Nutzer muss zweimal lernen, was er anfassen kann.
 * Zusammengelegt, damit es gar nicht erst auseinanderlaufen kann: Wer hier die
 * Rundung ändert, ändert sie an beiden Stellen.
 *
 * LINKSBÜNDIG, immer. Eine zentrierte Reihe steht unter linksbündigen
 * Überschriften und Karten wie ein Fremdkörper, und beim Wechsel der Auswahl
 * rutschte sie zusätzlich seitlich, weil die Wörter verschieden lang sind.
 *
 * ZWEI AUFTEILUNGEN, ein Aussehen (`fill`):
 *
 *  • ohne `fill` — jeder Knopf so breit wie sein Wort, die Reihe endet, wo sie
 *    endet, und schiebt sich bei Bedarf waagerecht. So steht die Sortierung im
 *    Ergebnis-Screen: Dort sind es drei Wörter unter einer Trefferzahl, und
 *    eine über die volle Breite gedehnte Reihe läse sich als Reiter-Leiste.
 *  • mit `fill` — alle Knöpfe teilen sich die volle Breite zu gleichen Teilen.
 *    So stehen die Kategorien unter „Gespeichert": Sie sind die oberste Ebene
 *    dieses Reiters, stehen unmittelbar unter dem Umschalter Reisen/Tickets —
 *    und der nimmt die volle Breite ein. Eine kürzere Reihe darunter sah aus,
 *    als wäre sie abgeschnitten.
 */

export interface FilterChip {
  id: string;
  label: string;
}

const C = { text: "#F4F4F5" };

export const FilterChips = memo(function FilterChips({
  items,
  value,
  onChange,
  fill = false,
  style,
  contentPadding = 0,
}: {
  items: FilterChip[];
  value: string;
  onChange: (id: string) => void;
  /** Außenabstände der REIHE (Abstand nach oben/unten) — je Einsatzort verschieden. */
  style?: ViewStyle;
  /**
   * Volle Breite statt Breite nach Wortlänge — siehe oben im Aufbau.
   *
   * Der Abstand ZWISCHEN den Knöpfen bleibt derselbe (`SPACE.md`), sie werden
   * nur länger; die Ränder links und rechts kommen wie bisher von außen.
   */
  fill?: boolean;
  /**
   * Seitliches Polster des INHALTS, nicht des Rahmens.
   *
   * Der Unterschied ist keine Kleinigkeit: Am Rahmen einer waagerechten
   * Scroll-Fläche schneidet es den Inhalt ab, sobald er sich bewegt — der
   * erste Knopf verschwände beim Schieben unter der Kante. Am Inhalt wandert es
   * mit, und der letzte Knopf hat am Ende denselben Abstand wie der erste am
   * Anfang.
   */
  contentPadding?: number;
}) {
  const palette = usePalette();
  const accent = useAccent();

  /**
   * EIN Knopf — einmal beschrieben, in beiden Aufteilungen derselbe.
   *
   * Zwei Kopien davon (eine je Aufteilung) wären genau der Zustand, gegen den
   * diese Datei angelegt wurde: zwei Stellen, an denen Rundung, Kontur und
   * Schrift auseinanderlaufen können.
   */
  const chip = (it: FilterChip) => {
    const on = it.id === value;
    return (
      /**
       * Die FLÄCHE liegt auf einem eigenen Knoten, nicht auf der `Pressable`.
       *
       * Auf ihr lag sie zuerst, und sie kam nicht an: Polster und Textfarbe
       * griffen, der Hintergrund nicht — die Knöpfe standen als nackter Text da.
       *
       * `Pressable` und nicht `RippleTouch`: Der Knopf muss der Sprachausgabe
       * sagen, ob er GEWÄHLT ist. `accessibilityState` reicht `RippleTouch`
       * nicht durch.
       *
       * Als `FadePress`: Die Stil-Funktion `({ pressed }) => …`, die hier stand,
       * kam an der `Pressable` nie an (NativeWind verschluckt sie) — die
       * gedachte Rückmeldung beim Drücken gab es nicht.
       */
      <FadePress
        key={it.id}
        pressedOpacity={0.6}
        onPress={() => {
          if (it.id === value) return;
          haptic("button");
          onChange(it.id);
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
      >
        <View
          style={[
            styles.chip,
            /**
             * Im Füll-Modus KLEINERES seitliches Polster.
             *
             * Dort kommt die Breite vom `flex`, das Polster hält nur den Text
             * von der Kontur weg. Bliebe es bei sechzehn je Seite, bliebe bei
             * vier Knöpfen auf einem schmalen Gerät für „Autobuses" zu wenig
             * übrig — dieselben zweiunddreißig Punkte, die im Breiten-nach-Wort
             * Modus die Form ausmachen, wären hier reiner Verlust.
             */
            fill ? styles.chipFill : null,
            on
              ? { backgroundColor: accent.solid, borderColor: accent.solid }
              : /**
                 * Ungewählt: KONTUR statt Fläche.
                 *
                 * Eine Füllung in der zweiten Flächenstufe liegt sechs Prozent
                 * über dem Grund und ist auf einem OLED-Schwarz praktisch
                 * unsichtbar — genau das war zu sehen. Eine Linie zeichnet auch
                 * dann, wenn der Unterschied der Flächen verschwindet.
                 */
                { backgroundColor: "transparent", borderColor: palette.s3 },
          ]}
        >
          <Text
            style={[styles.chipText, { color: on ? accent.textOnSolid : C.text }]}
            numberOfLines={1}
            /**
             * Im Füll-Modus darf die Schrift notfalls schrumpfen.
             *
             * Vier gleich breite Knöpfe geben jedem ein Viertel der Zeile, und
             * das längste Wort bestimmt nicht mehr die Breite. Auf einem
             * schmalen Gerät mit spanischen Beschriftungen wäre „Autobuses"
             * sonst abgeschnitten — ein halbes Wort ist schlechter als ein
             * ganzes in 12 statt 14 Punkt. Sonst bleibt die Schrift fest, sonst
             * stünden dieselben Reiter je nach Sprache verschieden groß da.
             */
            adjustsFontSizeToFit={fill}
            minimumFontScale={0.85}
          >
            {it.label}
          </Text>
        </View>
      </FadePress>
    );
  };

  /**
   * Füll-Modus: eine feste Reihe, KEINE Scroll-Fläche.
   *
   * Sie kann gar nicht überlaufen — die Knöpfe teilen sich, was da ist. Eine
   * Scroll-Fläche darüber wäre nicht nur überflüssig, sie brächte ein Gefälle
   * mit: Ein `flex: 1` in einem waagerecht scrollenden Inhalt bezieht sich auf
   * dessen EIGENBREITE, nicht auf den Bildschirm — die Knöpfe fielen auf ihre
   * Wortbreite zurück.
   *
   * Das `flex` sitzt auf einer HÜLLE um den Knopf, nicht auf der `Pressable`
   * selbst: An einer `Pressable` wird die Stil-FUNKTION in diesem Projekt von
   * NativeWinds JSX-Umschreibung verschluckt (dokumentiert in `SearchBar.tsx`),
   * und ein verschlucktes `flex` fiele nicht auf — die Reihe sähe schlicht aus
   * wie vorher. An einer schlichten `View` kann das nicht passieren.
   */
  if (fill) {
    return (
      <View style={[styles.row, style]}>
        {items.map((it) => (
          <View key={it.id} style={styles.fillItem}>
            {chip(it)}
          </View>
        ))}
      </View>
    );
  }

  return (
    /**
     * Waagerecht scrollbar, obwohl die Knöpfe fast immer passen.
     *
     * Fast immer ist nicht immer: Auf einem schmalen Gerät mit großer
     * Systemschrift und spanischen Beschriftungen läuft die Reihe über den
     * Rand. Ohne diese Fläche wäre der letzte Knopf dann unerreichbar.
     *
     * `flexGrow: 0`, sonst zöge sie sich auf die volle Resthöhe ihres
     * Behälters. Und `justifyContent: flex-start` ausdrücklich: Ohne die Angabe
     * hängt es am Behälter, ob eine schmale Reihe links steht oder mittig — und
     * das darf nicht vom Einsatzort abhängen.
     */
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.row, { paddingHorizontal: contentPadding }]}
      style={[styles.scroll, style]}
    >
      {items.map(chip)}
      {/* Ein Abschluss-Abstand als eigener Knoten statt `paddingRight` am
          Inhalt: Android schneidet das Polster einer scrollenden Fläche am
          Ende ab, ein Knoten wird gezeichnet. */}
      <View style={styles.tail} />
    </ScrollView>
  );
});

const styles = scaledStyles({
  scroll: { flexGrow: 0 },
  /**
   * Zwölf Punkte zwischen den Knöpfen, nicht acht.
   *
   * Acht reichen zwischen zwei Flächen, die sich farblich abheben. Diese hier
   * sind Konturen auf schwarzem Grund — bei acht stünden die Linien so dicht,
   * dass die Reihe als ein zerteiltes Feld liest statt als mehrere Knöpfe.
   */
  row: { flexDirection: "row", alignItems: "center", justifyContent: "flex-start", gap: SPACE.md },
  chip: {
    /**
     * Abgerundetes Rechteck, keine Kapsel. Volle Kapseln trägt die App schon an
     * anderer Stelle (Abzeichen, Sprech-Knopf); dieselbe Form für beides hieße,
     * dass ein Filter aussieht wie ein Zustand.
     */
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: SPACE.lg,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  chipText: { fontSize: 14, fontWeight: "600" },
  /** Gleiche Teile für alle — siehe `fill`. `minWidth: 0`, damit ein langes
   *  Wort die Aufteilung nicht doch wieder nach seiner Breite verschiebt. */
  fillItem: { flex: 1, minWidth: 0 },
  chipFill: { paddingHorizontal: SPACE.sm },
  tail: { width: SPACE.md },
});
