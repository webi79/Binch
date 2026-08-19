import { type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Home→Search „Launch"-Übergang: KEIN Zurück-Skalieren und KEIN Dim mehr.
 * - Live-Scale der Home-ScrollView clippte auf Android immer die unterste Karte
 *   am mit-skalierten Rahmen („unten abgeschnitten"); ein Snapshot (view-shot)
 *   flackerte beim Swap.
 * - Ein Dim zerstörte den Expand: schwarz → Farb-Stufe zwischen Box und Home;
 *   deckend #1A1A1A → der Bildschirm „ploppt" vor Expand-Ende in die Endfarbe.
 * Der Home ist von sich aus #1A1A1A (= exakt die Box-Endfarbe), also passt die
 * Farbe ohne alles, und die aus der Kachel wachsende Box trägt den Übergang.
 *
 * Die Komponente bleibt als Wrapper — sie misst die Home-Höhe (Overlay nutzt sie
 * für AREA_H, damit der Launch über der Tab-Bar endet).
 */
/**
 * KEINE Messung mehr — der Wert wurde nirgends gelesen.
 *
 * Hier stand ein `onLayout`, das die Höhe in den globalen Speicher schrieb. Der
 * Kommentar darüber sagt, das Überlagerungs-Blatt brauche sie für `AREA_H` —
 * eine Suche über das ganze Projekt findet dafür aber keinen einzigen Leser
 * mehr. Geblieben waren die Kosten: Jeder Schreibvorgang weckt sämtliche
 * Abonnenten des Speichers UND stößt die Persistenz an.
 *
 * Und er feuerte zum denkbar schlechtesten Zeitpunkt: Die App läuft mit
 * `adjustResize`, jede Tastatur ändert also die Höhe dieses dauerhaft
 * gemounteten Bereichs — mitten in die Fahrt eines Wählers hinein.
 */
export function HomeContentDepth({ children }: { children: ReactNode }) {
  return <View style={styles.fill}>{children}</View>;
}

const styles = scaledStyles({
  fill: { flex: 1 },
});
