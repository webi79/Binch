import { Text, View } from "react-native";
import { Bus, Plane, Ship, TramFront, Train, type LucideIcon } from "lucide-react-native";
import { scaledStyles } from "@/lib/ui/compact";

/**
 * Die Linien-Plakette („ICE 643", „RB59", „S1", „Bus") — in der Farbe ihrer
 * Verkehrsart.
 *
 * Stand bis eben nur in der Zeitleiste einer Fahrt (`LegTimelineOverlay`). Das
 * Stadt-Blatt zeigt dieselben Linien in seiner Verbindungsliste; beide nehmen
 * jetzt diese eine Plakette mit denselben Farben und Kürzeln, sonst läse ein
 * ICE hier rot und dort grau.
 */

/** Kürzel, wenn der Anbieter keinen Liniennamen mitschickt. */
export function productLabel(product?: string): string | null {
  if (!product) return null;
  switch (product) {
    case "national":
    case "nationalExpress":
      return "ICE";
    case "regional":
    case "regionalExpress":
      return "RB";
    case "suburban":
      return "S";
    case "subway":
      return "U";
    case "tram":
      return "T";
    case "bus":
      return "Bus";
    case "ferry":
      return "F";
    case "flight":
      return "✈";
    default:
      return null;
  }
}

/**
 * Das Symbol je Verkehrsart. Greift HAFAS-Produkte ab — alles, was nicht Bus,
 * Tram, Flug oder Fähre ist, landet auf dem Zug (regional, national, suburban,
 * subway …). Stand zuerst im Haltestellen-Blatt; das Stadt-Blatt setzt dasselbe
 * Symbol vor jede Linie, wie Google Maps.
 */
export function iconForProduct(product: string | null | undefined): LucideIcon {
  if (!product) return Train;
  const p = product.toLowerCase();
  if (/bus|coach/.test(p)) return Bus;
  if (/tram|stadtbahn/.test(p)) return TramFront;
  if (/flight|air/.test(p)) return Plane;
  if (/ferry|ship/.test(p)) return Ship;
  return Train;
}

/**
 * Farbe je Verkehrsart — Fernverkehr im DB-Rot, S-Bahn grün, Bus im Flix-Grün,
 * Regionalverkehr ORANGE.
 *
 * Regional stand hier nicht und fiel aufs Grau zurück: Im Stadt-Blatt waren
 * RE und RB damit graue Kästchen, bei Google Maps stehen sie farbig (RB59
 * orange). Orange trennt sie zugleich sichtbar vom roten Fernverkehr.
 */
export function productColor(product?: string): string {
  switch (product) {
    case "regional":
    case "regionalExpress":
      return "#E8731A";
    case "suburban":
      return "#1F8A37";
    case "subway":
      return "#0066CC";
    case "national":
    case "nationalExpress":
      return "#EC0016";
    case "tram":
      return "#C13635";
    case "bus":
      return "#73D700";
    case "ferry":
      return "#0EA5E9";
    case "flight":
      return "#1F2A57";
    default:
      return "#2D2D31";
  }
}

/**
 * `compact` für Zeilen, in denen mehrere Plaketten nebeneinander stehen (die
 * Verbindungsliste) — dieselbe Form, nur etwas knapper.
 */
export function LinePill({
  label,
  product,
  compact,
}: {
  label: string;
  product?: string;
  compact?: boolean;
}) {
  return (
    <View
      style={[
        compact ? styles.pillCompact : styles.pill,
        { backgroundColor: productColor(product) },
      ]}
    >
      <Text style={compact ? styles.textCompact : styles.text} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = scaledStyles({
  pill: { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 10 },
  text: { fontSize: 12, fontWeight: "800", color: "#F4F4F5", letterSpacing: -0.2 },
  pillCompact: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7 },
  textCompact: { fontSize: 12, fontWeight: "800", color: "#F4F4F5", letterSpacing: -0.2 },
});
