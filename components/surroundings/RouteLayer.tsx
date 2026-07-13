import { memo, useMemo } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { RouteWaypoint, RouteLegGeometry } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";

/**
 * Zeichnet eine Route auf der Karte: Polyline durch alle Waypoints + farbige
 * Marker je Waypoint (Origin / Transfer / Destination).
 *
 * Drei Layer-Quellen:
 *   1. route-line-src → LineString durch die Waypoint-Coords
 *   2. route-waypoints-src → Punkte für Origin/Transfer/Destination
 * Layer:
 *   - line-shadow (dunkle dickere Linie hinter der Hauptlinie)
 *   - line-main (lime, ggf. gestrichelt für Flug/Cruise)
 *   - wp-bg-circle (großer farbiger Kreis pro Waypoint)
 *   - wp-stroke-circle (heller Ring außen für Sichtbarkeit auf dunklem Map-BG)
 *   - wp-label (Text mit Stop-Name)
 */

// LIME/ORIGIN_COLOR entfernt — werden zur Laufzeit aus useAccent() bezogen
// (siehe RouteLayer-Body). Transfer/Dest sind feste informative Farben.
const TRANSFER_COLOR = "#FFD60A";
const DEST_COLOR = "#FF3B5C";

// Maximales Verhältnis Polyline-Länge / Luftlinie, ab dem wir die echte
// Polyline als implausibel verwerfen. Normale Linienbusse/-bahnen folgen den
// Straßen/Schienen mit ~1.2-2.5× Luftlinie. Rufbusse (Bedarfsverkehr ohne feste
// Route) liefern bei HAFAS eine zickzackende „Polyline" quer durch den Ort →
// Vielfaches der Luftlinie → wir zeichnen stattdessen eine saubere Gerade.
const MAX_POLY_RATIO = 5;

function segLen(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}
function pathLen(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += segLen(coords[i - 1]!, coords[i]!);
  return len;
}

/** Index des Polyline-Punkts, der `p` am nächsten liegt. */
function nearestIdx(coords: [number, number][], p: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = segLen(coords[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Schneidet die volle Trip-Polyline auf das gefahrene Teilstück zwischen
 * `from` und `to` zu. Nötig, weil `/api/trips/polyline` die GESAMTE Fahrt
 * liefert (z.B. den ganzen ICE München→Hamburg, obwohl das Leg nur Köln→Hamburg
 * ist; oder die ganze Ringlinie, obwohl der User nur Petrischule→Justus-Liebig-
 * Platz fährt). Ohne Clip zeichnet die Karte weit über das Segment hinaus / die
 * ganze Runde. Reihenfolge egal fürs Zeichnen → wir slicen min..max.
 */
function clipToSegment(
  coords: [number, number][],
  from: [number, number],
  to: [number, number],
): [number, number][] {
  const fi = nearestIdx(coords, from);
  const ti = nearestIdx(coords, to);
  const a = Math.min(fi, ti);
  const b = Math.max(fi, ti);
  if (b - a < 1) return coords; // kein sinnvolles Teilstück → volle Linie
  return coords.slice(a, b + 1);
}

interface Props {
  waypoints: RouteWaypoint[];
  /** Pro Leg ein Geometry-Block — kann echte Polyline-Coords enthalten. */
  legs: RouteLegGeometry[];
  /** Modus bestimmt den Linien-Style (gestrichelt für Flug/Cruise = Luft/Wasser). */
  mode: "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
}

const LINE_SRC = "route-line-src";
const WP_SRC = "route-waypoints-src";
const LINE_SHADOW_ID = "route-line-shadow";
const LINE_MAIN_ID = "route-line-main";
const WP_RING_ID = "route-wp-ring";
const WP_BG_ID = "route-wp-bg";
const WP_LABEL_ID = "route-wp-label";

export const RouteLayer = memo(function RouteLayer({ waypoints, legs, mode }: Props) {
  // Line-Color + Origin-Waypoint nutzen den User-Akzent (live).
  const accent = useAccent();
  const LIME = accent.solid;
  const ORIGIN_COLOR = accent.solid;
  // Pro Leg ein LineString: entweder echte Polyline (Schienen-Geometrie) wenn
  // bereits gefetched, oder Fallback auf gerade Linie zwischen den Waypoints.
  const lineGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: legs.map((leg) => {
        const straight = [
          [waypoints[leg.fromIndex].longitude, waypoints[leg.fromIndex].latitude],
          [waypoints[leg.toIndex].longitude, waypoints[leg.toIndex].latitude],
        ] as [number, number][];
        // Echte Polyline nur nutzen, wenn sie plausibel ist (nicht absurd länger
        // als die Luftlinie). Sonst (Rufbus-Zickzack o.ä.) → saubere Gerade.
        let coords = straight;
        if (leg.coords && leg.coords.length > 1) {
          // Erst aufs gefahrene Teilstück (from→to) zuschneiden, DANN die
          // Plausibilität an der Luftlinie messen (auf dem Segment, nicht der
          // ganzen Fahrt — sonst würde ein langer Trip fälschlich verworfen).
          const clipped = clipToSegment(leg.coords, straight[0]!, straight[1]!);
          const direct = segLen(straight[0]!, straight[1]!);
          if (direct === 0 || pathLen(clipped) / direct <= MAX_POLY_RATIO) {
            coords = clipped;
          }
        }
        return {
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: coords },
          properties: { hasPolyline: coords !== straight },
        };
      }),
    }),
    [legs, waypoints],
  );

  const waypointGeoJson = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: waypoints.map((w, i) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [w.longitude, w.latitude] as [number, number],
        },
        properties: {
          label: w.label,
          role: w.role,
          index: i,
        },
      })),
    }),
    [waypoints],
  );

  // Cruise bleibt gestrichelt (Schifffahrt = Wasser, kein fest gezogener Weg).
  // Flug ist seit der Großkreis-Arc-Berechnung als durchgängige Kurve
  // dargestellt — die Bogenform reicht visuell um Luftverkehr zu signalisieren,
  // gestrichelt wäre redundant + macht die Kurve auf der Karte schlechter
  // ablesbar.
  const dashed = mode === "CRUISE";

  return (
    <>
      <GeoJSONSource id={LINE_SRC} data={lineGeoJson} />
      <GeoJSONSource id={WP_SRC} data={waypointGeoJson} />

      {/* Dunkle „Shadow"-Linie unter der Hauptlinie für Lesbarkeit */}
      <Layer
        id={LINE_SHADOW_ID}
        type="line"
        source={LINE_SRC}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": "#14181A",
          "line-width": 8,
          "line-opacity": 0.7,
        }}
      />
      <Layer
        id={LINE_MAIN_ID}
        type="line"
        source={LINE_SRC}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{
          "line-color": LIME,
          "line-width": 4,
          ...(dashed ? { "line-dasharray": [2, 2] } : {}),
        }}
      />

      {/* Waypoint-Ring (heller Kontrast außen) */}
      <Layer
        id={WP_RING_ID}
        type="circle"
        source={WP_SRC}
        paint={{
          "circle-radius": [
            "match",
            ["get", "role"],
            "origin",
            12,
            "destination",
            12,
            8, // transfer
          ],
          "circle-color": "#FFFFFF",
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
        }}
      />
      <Layer
        id={WP_BG_ID}
        type="circle"
        source={WP_SRC}
        paint={{
          "circle-radius": [
            "match",
            ["get", "role"],
            "origin",
            8,
            "destination",
            8,
            5, // transfer
          ],
          "circle-color": [
            "match",
            ["get", "role"],
            "origin",
            ORIGIN_COLOR,
            "destination",
            DEST_COLOR,
            TRANSFER_COLOR,
          ],
        }}
      />
      <Layer
        id={WP_LABEL_ID}
        type="symbol"
        source={WP_SRC}
        layout={{
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 11,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
          "text-allow-overlap": false,
          "text-optional": true,
        }}
        paint={{
          "text-color": "#FFFFFF",
          "text-halo-color": "#14181A",
          "text-halo-width": 1.5,
        }}
      />
    </>
  );
});
