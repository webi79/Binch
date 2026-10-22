import { Text, View } from "react-native";
import { Bus, Plane, Ship, TramFront, Train, type LucideIcon } from "lucide-react-native";
import { scaledStyles } from "@/lib/ui/compact";
import { useAccent } from "@/lib/theme/accent";
import { TRANSIT_COLOR, transitCategory } from "@/lib/theme/transitColors";

/**
 * Die Linien-Plakette („ICE 643", „RB59", „S1", „Bus") — in der Farbe ihrer
 * Verkehrsart.
 *
 * Stand bis eben nur in der Zeitleiste einer Fahrt (`LegTimelineOverlay`). Das
 * Stadt-Blatt zeigt dieselben Linien in seiner Verbindungsliste; beide nehmen
 * jetzt diese eine Plakette mit denselben Farben und Kürzeln, sonst läse ein
 * ICE hier rot und dort grau. Die Farben sind die der ganzen App
 * (lib/theme/transitColors.ts) — wie die Kästen auf der Karte.
 */

/**
 * MOTIS-Verkehrsarten (Zug-Suche über Transitous: „HIGHSPEED_RAIL"…) aufs
 * HAFAS-Vokabular, mit dem die Kürzel arbeiten. Wie `modeToProduct` in
 * server/src/services/motisStops.ts; METRO sind bei Transitous die S-Bahnen.
 */
function hafasProduct(product: string): string {
  switch (product) {
    case "HIGHSPEED_RAIL":
      return "nationalExpress";
    case "LONG_DISTANCE":
    case "NIGHT_RAIL":
      return "national";
    case "REGIONAL_RAIL":
    case "REGIONAL_FAST_RAIL":
      return "regional";
    case "SUBURBAN":
    case "METRO":
      return "suburban";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "BUS":
    case "COACH":
      return "bus";
    case "FERRY":
      return "ferry";
    case "AIRPLANE":
      return "flight";
    default:
      return product;
  }
}

/** Kürzel, wenn der Anbieter keinen Liniennamen mitschickt. */
export function productLabel(product?: string): string | null {
  if (!product) return null;
  switch (hafasProduct(product)) {
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
 * Das Symbol je Verkehrsart. Alles, was nicht Bus, Tram, Flug oder Fähre ist,
 * landet auf dem Zug (regional, national, suburban, subway …). Stand zuerst im
 * Haltestellen-Blatt; das Stadt-Blatt setzt dasselbe Symbol vor jede Linie, wie
 * Google Maps. Mit dem Liniennamen erkennt es Ersatzverkehr („Bus RB59").
 */
export function iconForProduct(product: string | null | undefined, line?: string | null): LucideIcon {
  switch (transitCategory(product, line)) {
    case "bus":
      return Bus;
    case "tram":
      return TramFront;
    case "flight":
      return Plane;
    case "ferry":
      return Ship;
    default:
      return Train;
  }
}

/**
 * Farbe je Verkehrsart — die der ganzen App (lib/theme/transitColors.ts),
 * Flüge im Akzent. Ersatzverkehr („Bus RB59") ist ein Bus: Die Quellen führen
 * ihn unter dem Zug, und er stand hier orange wie ein Regionalzug.
 */
export function productColor(product: string | undefined, line: string | undefined, flight: string): string {
  const category = transitCategory(product, line);
  return category === "flight" ? flight : TRANSIT_COLOR[category];
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
  const accent = useAccent();
  return (
    <View
      style={[
        compact ? styles.pillCompact : styles.pill,
        { backgroundColor: productColor(product, label, accent.dark) },
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
