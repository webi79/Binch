import { memo } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
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
  style,
  contentPadding = 0,
}: {
  items: FilterChip[];
  value: string;
  onChange: (id: string) => void;
  /** Außenabstände der REIHE (Abstand nach oben/unten) — je Einsatzort verschieden. */
  style?: ViewStyle;
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
      {items.map((it) => {
        const on = it.id === value;
        return (
          /**
           * Die FLÄCHE liegt auf einem eigenen Knoten, nicht auf der
           * `Pressable`.
           *
           * Auf ihr lag sie zuerst, und sie kam nicht an: Polster und
           * Textfarbe griffen, der Hintergrund nicht — die Knöpfe standen als
           * nackter Text da.
           *
           * `Pressable` und nicht `RippleTouch`: Der Knopf muss der
           * Sprachausgabe sagen, ob er GEWÄHLT ist. `accessibilityState`
           * reicht `RippleTouch` nicht durch.
           */
          <Pressable
            key={it.id}
            onPress={() => {
              if (it.id === value) return;
              haptic("button");
              onChange(it.id);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => (pressed ? styles.pressed : undefined)}
          >
            <View
              style={[
                styles.chip,
                on
                  ? { backgroundColor: accent.solid, borderColor: accent.solid }
                  : /**
                     * Ungewählt: KONTUR statt Fläche.
                     *
                     * Eine Füllung in der zweiten Flächenstufe liegt sechs
                     * Prozent über dem Grund und ist auf einem OLED-Schwarz
                     * praktisch unsichtbar — genau das war zu sehen. Eine Linie
                     * zeichnet auch dann, wenn der Unterschied der Flächen
                     * verschwindet.
                     */
                    { backgroundColor: "transparent", borderColor: palette.s3 },
              ]}
            >
              <Text style={[styles.chipText, { color: on ? accent.textOnSolid : C.text }]}>
                {it.label}
              </Text>
            </View>
          </Pressable>
        );
      })}
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
  pressed: { opacity: 0.6 },
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
  tail: { width: SPACE.md },
});
