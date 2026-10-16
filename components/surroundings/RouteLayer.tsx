import { memo, useCallback, useMemo, useRef, type ComponentProps } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { RouteWaypoint, RouteLegGeometry } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { useWalkDotLayout } from "@/components/surroundings/WalkPathLayer";
import {
  ARC_FADE_END,
  ARC_FADE_START,
  ARC_LAYER_PREFIX,
  flightArcLines,
} from "@/lib/routing/flightArcs3d";
import {
  LINE_SOURCE_MAXZOOM,
  LINE_SOURCE_TOLERANCE,
} from "@/components/surroundings/lineSourceTuning";
import { clipToSegment, pathLen, segLen } from "@/lib/routing/clipPolyline";

/**
 * Zeichnet eine Route auf der Karte: Polyline durch alle Waypoints + farbige
 * Marker je Waypoint (Origin / Transfer / Destination).
 *
 * Drei Layer-Quellen:
 *   1. route-line-src → LineString durch die Waypoint-Coords
 *   2. route-waypoints-src → Punkte für Origin/Transfer/Destination
 * Layer:
 *   - line-shadow (dunkle dickere Linie hinter der Hauptlinie)
 *   - line-main (Akzent, ggf. gestrichelt für Flug/Cruise)
 *   - wp-bg-circle (großer farbiger Kreis pro Waypoint)
 *   - wp-stroke-circle (heller Ring außen für Sichtbarkeit auf dunklem Map-BG)
 *   - wp-label (Text mit Stop-Name)
 */

// LINE_COLOR/ORIGIN_COLOR stehen nicht hier — sie kommen zur Laufzeit aus
// useAccent() (siehe RouteLayer-Body). Transfer/Dest sind feste informative
// Farben.
const TRANSFER_COLOR = "#FFD60A";
const DEST_COLOR = "#FF3B5C";

// Maximales Verhältnis Polyline-Länge / Luftlinie, ab dem wir die echte
// Polyline als implausibel verwerfen. Normale Linienbusse/-bahnen folgen den
// Straßen/Schienen mit ~1.2-2.5× Luftlinie. Rufbusse (Bedarfsverkehr ohne feste
// Route) liefern bei HAFAS eine zickzackende „Polyline" quer durch den Ort →
// Vielfaches der Luftlinie → wir zeichnen stattdessen eine saubere Gerade.
const MAX_POLY_RATIO = 5;
/** Ein- und Ausstieg so nah beieinander (Grad, ~100–150 m), dass die Luftlinie nichts über die Strecke sagt — eine Runde. */
const SAME_PLACE = 0.0015;

/**
 * Die Linien einer Route — je Etappe ein LineString: echte Gleis-/Straßen-
 * Geometrie, wenn geladen und plausibel, sonst die Gerade zwischen den Halten.
 *
 * Ausgelagert, weil das Stadt-Blatt dieselben Linien braucht: für die grauen
 * Alternativen hinter der gewählten Route und für die Lage der Dauer-Blasen
 * (siehe CityRouteLayers.tsx). Zwei Rechnungen liefen beim nächsten Anfassen
 * auseinander, und die Blase säße neben ihrer Linie.
 */
export function routeLineCollection(waypoints: RouteWaypoint[], legs: RouteLegGeometry[]) {
  return {
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
        // Eine Runde mit Ein- und Ausstieg am selben Ort ist IMMER ein
        // Vielfaches ihrer Luftlinie (~0) — kein Rufbus-Zickzack. Ohne die
        // Ausnahme stand statt der Runde ein Punkt auf der Karte.
        if (direct <= SAME_PLACE || pathLen(clipped) / direct <= MAX_POLY_RATIO) {
          coords = clipped;
        }
      }
      return {
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: coords },
        properties: { hasPolyline: coords !== straight, walking: !!leg.walking },
      };
    }),
  };
}

interface Props {
  waypoints: RouteWaypoint[];
  /** Pro Leg ein Geometry-Block — kann echte Polyline-Coords enthalten. */
  legs: RouteLegGeometry[];
  /** Modus bestimmt den Linien-Style (gestrichelt für Flug/Cruise = Luft/Wasser). */
  mode: "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
  /**
   * Tipp auf die Linie oder einen Halt. Mit Angabe sind beide Quellen
   * antippbar — und ein Tipp auf sie ist damit KEIN Karten-Tipp mehr: MapLibre
   * reicht ihn nur an die getroffene Quelle weiter (MLRNMapView.onMapClick).
   * Im Nur-Karte-Modus darf ein Tipp auf die Route die Oberfläche nicht
   * zurückholen; ohne das fiel er als Tipp auf die freie Karte durch.
   */
  onPress?: () => void;
}

const LINE_SRC = "route-line-src";
/** Die Flugbögen in der Luft (siehe `lib/routing/flightArcs3d.ts`). */
const ARC_SRC = "route-arc-src";
const WP_SRC = "route-waypoints-src";
const LINE_SHADOW_ID = "route-line-shadow";
const LINE_MAIN_ID = "route-line-main";
const LINE_WALK_ID = "route-line-walk";
const WP_RING_ID = "route-wp-ring";
const WP_BG_ID = "route-wp-bg";
const WP_LABEL_ID = "route-wp-label";

/**
 * FESTE Stil-Objekte und Quell-Einstellungen — nicht bei jedem Durchgang neu.
 *
 * Standen sie als Objekt-Literale im JSX, war jede Eigenschaft bei jedem
 * Durchgang neu: MapLibres Brücke schickte sie erneut an die Karte, und die
 * Quelle serialisierte ihre Daten jedes Mal mit (`GeoJSONSource` ruft bei
 * jedem Durchgang `JSON.stringify` über die ganze Strecke — bei einem langen
 * Gleisverlauf Tausende Punkte). Auf der Karte kam davon nichts an; gekostet
 * hat es trotzdem, mitten im Öffnen des Stadt-Blatts.
 */
type LayerProps = ComponentProps<typeof Layer>;
type LineProps = Extract<LayerProps, { type: "line" }>;
type CircleProps = Extract<LayerProps, { type: "circle" }>;
type SymbolProps = Extract<LayerProps, { type: "symbol" }>;
const ROUND_LINE: LineProps["layout"] = { "line-cap": "round", "line-join": "round" };
const NOT_WALKING: LineProps["filter"] = ["!=", ["get", "walking"], true];
const WALKING: LineProps["filter"] = ["==", ["get", "walking"], true];
const SHADOW_PAINT: LineProps["paint"] = {
  "line-color": "#14181A",
  "line-width": 8,
  "line-opacity": 0.7,
};
/**
 * Unter einem Flugbogen in der Luft bleibt die Linie auf dem Boden nur als
 * blasse Bodenspur — der Flug selbst ist oben. Während der Bogen ausblendet,
 * wird sie wieder zur vollen Linie (siehe `lib/routing/flightArcs3d.ts`).
 */
const FLIGHT_GROUND: NonNullable<LineProps["paint"]>["line-opacity"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ARC_FADE_START,
  0.25,
  ARC_FADE_END,
  1,
];
const FLIGHT_SHADOW_PAINT: LineProps["paint"] = {
  ...SHADOW_PAINT,
  "line-opacity": ["interpolate", ["linear"], ["zoom"], ARC_FADE_START, 0.15, ARC_FADE_END, 0.7],
};

/**
 * DER RAND AUF DER HELLEN KARTE — der Akzent selbst, auf gut zwei Fünftel
 * abgedunkelt, und deckend statt des halb durchsichtigen Schattens.
 *
 * Warum: Die helle Karte ist Googles Mintgrün. Lime (#7FEA4D) und Mint
 * (#3FE0A8) stehen darauf nur mit 1,3–1,5 : 1, auf der Stadtfläche 1,4–1,6 und
 * auf Wasser 1,0 — der Kern geht im Grund fast auf. Der Schatten der dunklen
 * Karte (Schwarz zu 70 %) trug die Linie dort allein, als graue Kante, die je
 * nach Grund anders ausfiel. Der abgedunkelte Akzent steht gegen Land, Stadt
 * und Wald mit 5,7–7,2 : 1, gegen Wasser mit 4,5–4,8 : 1, und der Kern hebt
 * sich mit 4,5–4,7 : 1 von ihm ab (WCAG verlangt für Grafik 3 : 1). So bleibt
 * die Linie in der Farbe, die der Nutzer gewählt hat — ein Schwarz wäre ebenso
 * deutlich gewesen, macht aus ihr aber einen Strich mit Umriss statt einer
 * grünen Linie.
 */
function edgeOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return (
    "#" +
    [n >> 16, (n >> 8) & 255, n & 255]
      .map((c) => Math.round(c * 0.42).toString(16).padStart(2, "0"))
      .join("")
  );
}
/**
 * Stumpfe Enden, spitze Ecken: Runde Kappen und Anschlüsse bringen Eckpunkte mit
 * schräger Ausrichtung, aus denen der Shader die Richtung des Bogens nicht lesen
 * kann. Bei Stützpunkten alle 25 km sieht man den Unterschied nicht.
 */
const ARC_LAYOUT: LineProps["layout"] = { "line-cap": "butt", "line-join": "miter" };
/** Die ID der Bogen-Ebene: Ihr Präfix schaltet im Shader das Heben ein. */
const ARC_LAYER_ID = `${ARC_LAYER_PREFIX}-route`;
/** Der Rand unter dem Bogen — dasselbe Präfix, sonst bliebe er am Boden liegen. */
const ARC_EDGE_ID = `${ARC_LAYER_PREFIX}-route-edge`;
/**
 * Der Rand des Bogens ist IMMER eingehängt und außerhalb der hellen Karte nur
 * ausgeblendet: Eine abgebaute Kind-Ebene ist in dieser Bibliothek der Weg in
 * einen Absturz (siehe die Häuser-Ebene in `surroundings.tsx`).
 */
const ARC_EDGE_SHOWN: LineProps["layout"] = { ...ARC_LAYOUT, visibility: "visible" };
const ARC_EDGE_HIDDEN: LineProps["layout"] = { ...ARC_LAYOUT, visibility: "none" };
/**
 * Die Scheitelhöhe in Kilometern — über `line-gap-width`, siehe
 * `lib/routing/flightArcs3d.ts`. Ab Zoom 3 sinkt der Bogen je Stufe auf die
 * halbe Höhe, genau so schnell, wie die Kamera herunterkommt: Er behält seine
 * Gestalt im Bild, statt der Kamera entgegenzuwachsen, und legt sich beim
 * Hineinzoomen auf die Linie am Boden.
 */
const ARC_APEX: NonNullable<LineProps["paint"]>["line-gap-width"] = [
  "interpolate",
  ["exponential", 0.5],
  ["zoom"],
  3,
  ["get", "apexKm"],
  7,
  ["/", ["get", "apexKm"], 16],
];
const ARC_OPACITY: NonNullable<LineProps["paint"]>["line-opacity"] = [
  "interpolate",
  ["linear"],
  ["zoom"],
  ARC_FADE_START,
  0.95,
  ARC_FADE_END,
  0,
];
const WP_RING_PAINT: CircleProps["paint"] = {
  "circle-radius": ["match", ["get", "role"], "origin", 12, "destination", 12, 8],
  "circle-color": "#F4F4F5",
  "circle-stroke-color": "#14181A",
  "circle-stroke-width": 2,
};
const WP_LABEL_LAYOUT: SymbolProps["layout"] = {
  "text-field": ["get", "label"],
  "text-font": ["Noto Sans Regular"],
  "text-size": 11,
  "text-offset": [0, 1.4],
  "text-anchor": "top",
  "text-allow-overlap": false,
  "text-optional": true,
};
const WP_LABEL_PAINT: SymbolProps["paint"] = {
  "text-color": "#F4F4F5",
  "text-halo-color": "#14181A",
  "text-halo-width": 1.5,
};


export const RouteLayer = memo(function RouteLayer({ waypoints, legs, mode, onPress }: Props) {
  // Line-Color + Origin-Waypoint nutzen den User-Akzent (live).
  const accent = useAccent();
  const walkDotLayout = useWalkDotLayout();
  /**
   * Auf der hellen Karte trägt die Linie einen deckenden Rand im abgedunkelten
   * Akzent statt des Schattens — siehe `edgeOf`. Die Linie selbst bleibt
   * überall im Akzent.
   */
  const light = useResolvedMapStyle() === "light";
  const LINE_COLOR = accent.solid;
  const ORIGIN_COLOR = accent.solid;
  const edge = edgeOf(accent.solid);
  // Pro Leg ein LineString: entweder echte Polyline (Schienen-Geometrie) wenn
  // bereits gefetched, oder Fallback auf gerade Linie zwischen den Waypoints.
  const lineGeoJson = useMemo(
    () => routeLineCollection(waypoints, legs),
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
  const flight = mode === "FLIGHT";

  /**
   * Die Bögen in der Luft — nur für Flüge, nur für Etappen, die geflogen werden.
   * Gleich als Text: Ein Objekt serialisiert `GeoJSONSource` bei JEDEM Rendern
   * neu (seine Kind-Ebenen schlagen das `memo` immer).
   */
  const arcGeoJson = useMemo(
    () =>
      flight
        ? JSON.stringify(
            flightArcLines(
              legs
                .filter((leg) => !leg.walking)
                .map((leg) => ({ from: waypoints[leg.fromIndex]!, to: waypoints[leg.toIndex]! })),
            ),
          )
        : null,
    [flight, legs, waypoints],
  );

  // Fest je Farbe bzw. je Rückruf — Begründung an `ROUND_LINE`.
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const hasPress = onPress != null;
  const handlePress = useCallback(() => onPressRef.current?.(), []);
  const mainPaint = useMemo<LineProps["paint"]>(
    () => ({
      "line-color": LINE_COLOR,
      "line-width": 4,
      ...(dashed ? { "line-dasharray": [2, 2] } : {}),
      ...(flight ? { "line-opacity": FLIGHT_GROUND } : {}),
    }),
    [LINE_COLOR, dashed, flight],
  );
  const arcPaint = useMemo<LineProps["paint"]>(
    () => ({
      "line-color": LINE_COLOR,
      "line-width": 4,
      "line-gap-width": ARC_APEX,
      // Kein Versatz: Der Shader liest hier die Mercator-Länge des Fluges (siehe
      // `lib/routing/flightArcs3d.ts`).
      "line-offset": ["get", "mercatorLength"],
      "line-opacity": ARC_OPACITY,
    }),
    [LINE_COLOR],
  );
  /** Unter der Linie: dunkel wie bisher — oder auf der hellen Karte der Rand. */
  const shadowPaint = useMemo<LineProps["paint"]>(
    () =>
      light
        ? {
            "line-color": edge,
            "line-width": 8,
            // Unter einem Flug auch hier nur eine blasse Bodenspur.
            "line-opacity": flight
              ? ["interpolate", ["linear"], ["zoom"], ARC_FADE_START, 0.25, ARC_FADE_END, 1]
              : 1,
          }
        : flight
          ? FLIGHT_SHADOW_PAINT
          : SHADOW_PAINT,
    [light, flight, edge],
  );
  /** Derselbe Rand unter dem Bogen in der Luft — so breit wie unter der Linie. */
  const arcEdgePaint = useMemo<LineProps["paint"]>(
    () => ({ ...arcPaint, "line-color": edge, "line-width": 8 }),
    [arcPaint, edge],
  );
  const wpBgPaint = useMemo<CircleProps["paint"]>(
    () => ({
      "circle-radius": ["match", ["get", "role"], "origin", 8, "destination", 8, 5],
      "circle-color": [
        "match",
        ["get", "role"],
        "origin",
        ORIGIN_COLOR,
        "destination",
        DEST_COLOR,
        TRANSFER_COLOR,
      ],
    }),
    [ORIGIN_COLOR],
  );

  return (
    <>
      {/* Ebenen als KINDER ihrer Quelle — nur so kennt MapLibre sie als
          antippbar (sonst fände `onPress` nie einen Treffer). */}
      <GeoJSONSource
        id={LINE_SRC}
        data={lineGeoJson}
        maxzoom={LINE_SOURCE_MAXZOOM}
        tolerance={LINE_SOURCE_TOLERANCE}
        onPress={hasPress ? handlePress : undefined}
      >

      {/* Dunkle „Shadow"-Linie unter der Hauptlinie für Lesbarkeit */}
      <Layer
        id={LINE_SHADOW_ID}
        type="line"
        // Nur unter Fahrten — unter den Punkten eines Fußwegs läge sonst ein
        // durchgehender dunkler Strich.
        filter={NOT_WALKING}
        layout={ROUND_LINE}
        paint={shadowPaint}
      />
      {/* Fahrt-Etappen: durchgezogen. `line-dasharray` ist in MapLibre NICHT
          datengetrieben — deshalb zwei Layer mit Filter statt einer Expression. */}
      <Layer
        id={LINE_MAIN_ID}
        type="line"
        filter={NOT_WALKING}
        layout={ROUND_LINE}
        paint={mainPaint}
      />
      {/* Fußweg-Etappen: GEPUNKTET. Ohne eigenen Layer sähe ein
          12-Minuten-Fußmarsch aus wie eine Zugfahrt. Dieselben Punkte wie der
          Weg vom Standort zur Station (`useWalkDotLayout`) — ein Fußweg sieht
          auf der Karte überall gleich aus, wie bei Google Maps. */}
      <Layer
        id={LINE_WALK_ID}
        type="symbol"
        filter={WALKING}
        layout={walkDotLayout}
      />

      </GeoJSONSource>

      {arcGeoJson ? (
        // `lineMetrics`: der Fortschritt entlang des Fluges, aus dem der Shader
        // die Höhe rechnet; `tolerance={0}`: keine Vereinfachung, sonst fehlten
        // dem Bogen die Stützpunkte.
        <GeoJSONSource id={ARC_SRC} data={arcGeoJson} lineMetrics tolerance={0}>
          {/* Zuerst der Rand: Die Ebenen einer Quelle liegen in der Reihenfolge
              ihres Einhängens, die spätere oben. */}
          <Layer
            id={ARC_EDGE_ID}
            type="line"
            maxzoom={ARC_FADE_END}
            layout={light ? ARC_EDGE_SHOWN : ARC_EDGE_HIDDEN}
            paint={arcEdgePaint}
          />
          <Layer id={ARC_LAYER_ID} type="line" maxzoom={ARC_FADE_END} layout={ARC_LAYOUT} paint={arcPaint} />
        </GeoJSONSource>
      ) : null}

      <GeoJSONSource id={WP_SRC} data={waypointGeoJson} onPress={hasPress ? handlePress : undefined}>
      {/* Waypoint-Ring (heller Kontrast außen) */}
      <Layer
        id={WP_RING_ID}
        type="circle"
        paint={WP_RING_PAINT}
      />
      <Layer
        id={WP_BG_ID}
        type="circle"
        paint={wpBgPaint}
      />
      <Layer
        id={WP_LABEL_ID}
        type="symbol"
        layout={WP_LABEL_LAYOUT}
        paint={WP_LABEL_PAINT}
      />
      </GeoJSONSource>
    </>
  );
});
