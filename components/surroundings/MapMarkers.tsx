import { memo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Marker as MapLibreMarker } from "@maplibre/maplibre-react-native";
import {
  Train,
  Bus,
  TramFront,
  Plane,
  Ship,
  type LucideIcon,
} from "lucide-react-native";
import { MapMarker, MarkerKind, type Coord } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";

// LIME-Konstanten entfernt — Marker holen den User-Akzent via useAccent zur
// Laufzeit. markerColors() nimmt den Akzent als Parameter.

const MARKER_ICON: Record<MarkerKind, LucideIcon> = {
  train: Train,
  subway: Train, // U-Bahn nutzt dasselbe Icon wie Train, Unterscheidung über Farbe
  bus: Bus,
  tram: TramFront,
  airport: Plane,
  cruise: Ship,
};

function markerColors(type: MarkerKind, accentSolid: string, accentTextOn: string): { bg: string; fg: string } {
  if (type === "train" || type === "airport") return { bg: accentSolid, fg: accentTextOn };
  if (type === "subway") return { bg: "#1F3A8A", fg: "#FFFFFF" }; // Dunkelblau
  if (type === "tram") return { bg: "#212123", fg: "#FFFFFF" };
  if (type === "cruise") return { bg: "#6B95B5", fg: "#FFFFFF" };
  return { bg: "#FFFFFF", fg: "#0D0D0D" };
}

/** MapLibre erwartet Koordinaten als [longitude, latitude] (GeoJSON-Order). */
function lngLat(c: Coord): [number, number] {
  return [c.longitude, c.latitude];
}

export const Marker = memo(function Marker({ m }: { m: MapMarker }) {
  const accent = useAccent();
  const { bg, fg } = markerColors(m.type, accent.solid, accent.textOnSolid);
  const Icon = MARKER_ICON[m.type];
  // Defensiv gegen unbekannte type-Werte: beim Zoomen rendern wir hunderte
  // Marker und ein einzelner ungültiger type (z.B. „ferry" aus OSM-Daten)
  // würde sonst „Cannot read property 'displayName' of undefined" auslösen
  // und die ganze Surroundings-Map zum Crash bringen.
  if (!Icon) return null;
  const size = m.big ? 36 : 28;
  const round = false;

  return (
    <MapLibreMarker id={m.id} lngLat={lngLat(m.coord)} anchor="bottom">
      <View style={styles.markerWrap}>
        {m.selected && (
          <View style={[styles.halo, { borderRadius: round ? size : 16, borderColor: accent.border }]} />
        )}
        <View
          style={[
            styles.pin,
            {
              width: size,
              height: size,
              borderRadius: round ? size / 2 : 10,
              backgroundColor: bg,
              borderColor: m.selected ? accent.solid : "rgba(0,0,0,0.45)",
            },
          ]}
        >
          <Icon color={fg} size={m.big ? 17 : 14} strokeWidth={2.2} />
          {m.label && (
            <View style={[styles.label, { borderColor: accent.solid }]}>
              <Text style={[styles.labelText, { color: accent.solid }]}>{m.label}</Text>
            </View>
          )}
        </View>
        <View style={[styles.tail, { borderTopColor: bg }]} />
      </View>
    </MapLibreMarker>
  );
});

/**
 * Die Stecknadel „du bist hier".
 *
 * Der Vorgabewert war der Berliner Platzhalter — ohne Standort stand die Nadel
 * also in Berlin und behauptete, das sei der Nutzer. Jetzt ist die Koordinate
 * Pflicht, und der Aufrufer zeichnet die Nadel gar nicht erst, solange keine
 * bekannt ist.
 */
export function UserPin({ coord }: { coord: Coord }) {
  const accent = useAccent();
  return (
    <MapLibreMarker id="user-pin" lngLat={lngLat(coord)} anchor="center">
      <View style={styles.userPin}>
        <View style={[styles.userHalo, { backgroundColor: accent.subtle }]} />
        <View style={[styles.userDot, { backgroundColor: accent.solid }]} />
      </View>
    </MapLibreMarker>
  );
}

const styles = scaledStyles({
  markerWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    left: -10,
    top: -10,
    right: -10,
    bottom: -2,
    borderWidth: 3,

  },
  pin: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  label: {
    position: "absolute",
    top: -6,
    right: -6,
    backgroundColor: "#0D0D0D",

    borderWidth: 1.5,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 7,
    minWidth: 14,
  },
  labelText: {

    fontSize: 9,
    fontWeight: "800",
    textAlign: "center",
  },
  tail: {
    width: 0,
    height: 0,
    borderLeftWidth: 4,
    borderRightWidth: 4,
    borderTopWidth: 7,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    marginTop: -2,
  },
  userPin: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  userHalo: {
    position: "absolute",
    width: 52,
    height: 52,
    borderRadius: 26,

  },
  userDot: {
    width: 20,
    height: 20,
    borderRadius: 10,

    borderWidth: 3,
    borderColor: "#0D0D0D",
  },
});
