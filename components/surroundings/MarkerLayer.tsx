import { memo, useMemo } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { MapMarker } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";

/**
 * Rendert Marker als Vector-Layer (statt einzelne Overlay-Views) — pannt
 * pixelgenau ohne Wobble, native GL-Pipeline.
 *
 * Bei großen Datasets (z.B. ~3000 Airports) aktivieren wir **Clustering**:
 * MapLibre fasst nahe Punkte zu Cluster-Kreisen zusammen, beim Reinzoomen
 * werden sie aufgelöst.
 *
 * Layer (Render-Reihenfolge bottom → top):
 *   1. Cluster-Circle      → gefüllter Kreis bei Cluster-Punkten
 *   2. Cluster-Count       → Anzahl der Punkte im Cluster
 *   3. Marker-Background   → farbiger Kreis je Kategorie (Einzel-Marker)
 *   4. Marker-Icon         → Lucide-Icon (Train/Bus/Plane/Tram/Ship)
 */

// LIME entfernt auf Modul-Ebene — wird zur Laufzeit aus useAccent() berechnet
// und innerhalb der MarkerLayer-Komponente als lokale Konstante geschadowed.
const TRAIN_YELLOW = "#FFD60A";
const BUS_PURPLE = "#9D5FE0";
const WHITE = "#FFFFFF";
const DARK = "#2A2A2C";
const CRUISE_BLUE = "#6B95B5";
// Dunkelblau für U-Bahn — klar vom dunkelgrauen Tram und blauen Cruise
// unterscheidbar.
const SUBWAY_BLUE = "#1F3A8A";

interface Props {
  markers: MapMarker[];
  /** Wird beim Tap auf einen Einzel-Marker (NICHT Cluster) aufgerufen.
   *  Übergibt die ID des Markers (= location.code). */
  onMarkerPress?: (id: string) => void;
}

// Stabile IDs (siehe v11-Constraint: keine id-Änderungen zur Laufzeit).
// Drei separate GeoJSON-Sources, jeweils mit eigenen Cluster-Settings.
// MapLibre kann Clustering nur global pro Source steuern, daher die Aufteilung:
//   - SRC_ID: Train/Subway/Tram + Multi-Mode-Hubs → clustern (bei viel rein-
//             gezoomt zeigt's Einzel-Marker, rausgezoomt Cluster)
//   - SRC_ID_BUS: reine Bus-Stops → NIE clustern (jede Haltestelle antappbar)
//   - SRC_ID_AIRCR: Airports + Cruise-Ports → clustern (3k+ Pins weltweit)
const SRC_ID = "surroundings-markers-src";
const SRC_ID_BUS = "surroundings-markers-src-bus";
const SRC_ID_AIRCR = "surroundings-markers-src-aircr";
const BG_SINGLE_BUS_LAYER_ID = "surroundings-markers-bg-single-bus";
const ICON_BUS_LAYER_ID = "surroundings-markers-icon-bus";
const BG_AIRCR_LAYER_ID = "surroundings-markers-bg-aircr";
const ICON_AIRCR_LAYER_ID = "surroundings-markers-icon-aircr";
const PILL_LAYER_ID = "surroundings-markers-pill";
const BG_SINGLE_LAYER_ID = "surroundings-markers-bg-single";
// Eigene neue Layer-IDs für die Badge-Symbol-Layer — die alten IDs waren
// vorher Circle-Layer registriert, MapLibre Native verbietet Layer-Typ-
// Änderungen unter derselben ID (silent fail).
const BADGE_SLOT0_LAYER_ID = "surroundings-markers-badge-slot0";
const BADGE_SLOT1_LAYER_ID = "surroundings-markers-badge-slot1";
const BADGE_SLOT2_LAYER_ID = "surroundings-markers-badge-slot2";
const ICON_SLOT0_LAYER_ID = "surroundings-markers-icon-slot0";
const ICON_SLOT1_LAYER_ID = "surroundings-markers-icon-slot1";
const ICON_SLOT2_LAYER_ID = "surroundings-markers-icon-slot2";
const CLUSTER_CIRCLE_LAYER_ID = "surroundings-markers-cluster";
const CLUSTER_COUNT_LAYER_ID = "surroundings-markers-cluster-count";

// Multi-Mode-Slot-Offsets:
//   2-Kind: zentriert links/rechts in der pill-2-Sprite
//   3-Kind: links / mittig / rechts in der pill-3-Sprite
// Badges UND Icons müssen identische pixel-Offsets haben, sonst sitzt das
// Icon nicht zentriert auf seinem farbigen Badge. icon-offset wird mit
// icon-size multipliziert → wenn Badge und Icon dasselbe icon-size haben,
// reicht es, dieselben Offset-Werte einzusetzen. Wir vereinheitlichen daher
// auf icon-size 0.5 für ALLES in Multi-Mode-Markern (Pille, Badge, Icon).
const MM_OFFSET_2_LEFT: [number, number] = [-28, 0]; // = -14px visuell @ 0.5
const MM_OFFSET_2_RIGHT: [number, number] = [28, 0];
const MM_OFFSET_3_LEFT: [number, number] = [-56, 0];
const MM_OFFSET_3_MID: [number, number] = [0, 0];
const MM_OFFSET_3_RIGHT: [number, number] = [56, 0];


export const MarkerLayer = memo(function MarkerLayer({ markers, onMarkerPress }: Props) {
  // Akzent fließt in alle „airport"-Marker (in MapLibre-Style-Expressions als
  // Literal-Hex eingebettet). Train/Bus/Cruise haben weiterhin Mode-spezifische
  // Farben (Gelb/Lila/Blau) damit Marker-Typen visuell unterscheidbar bleiben.
  const accent = useAccent();
  const LIME = accent.solid;
  // Marker werden auf drei GeoJSON-Sources aufgeteilt, damit Clustering
  // pro Modus gesteuert werden kann (MapLibre kann Clustering nur global
  // pro Source schalten):
  //   - Bus-Only-Stops          → bus-Source, NIE clustern
  //   - Airport + Cruise        → aircr-Source, IMMER clustern
  //   - Train/Subway/Tram/Multi → main-Source, ab vielen Pins clustern
  const { mainFeatures, busFeatures, aircrFeatures } = useMemo(() => {
    const main: ReturnType<typeof toFeature>[] = [];
    const bus: ReturnType<typeof toFeature>[] = [];
    const aircr: ReturnType<typeof toFeature>[] = [];
    function toFeature(m: MapMarker) {
      const kinds = m.kinds && m.kinds.length > 0 ? m.kinds : [m.type];
      return {
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [m.coord.longitude, m.coord.latitude] as [number, number],
        },
        properties: {
          id: m.id,
          kind: kinds[0] ?? m.type,
          kind1: kinds[1] ?? "",
          kind2: kinds[2] ?? "",
          kindsCount: Math.min(kinds.length, 3),
          selected: Boolean(m.selected),
          big: Boolean(m.big),
        },
      };
    }
    for (const m of markers) {
      const kinds = m.kinds && m.kinds.length > 0 ? m.kinds : [m.type];
      const single = kinds.length === 1;
      if (single && kinds[0] === "bus") {
        bus.push(toFeature(m));
      } else if (single && (kinds[0] === "airport" || kinds[0] === "cruise")) {
        aircr.push(toFeature(m));
      } else {
        main.push(toFeature(m));
      }
    }
    return { mainFeatures: main, busFeatures: bus, aircrFeatures: aircr };
  }, [markers]);

  const geojsonMain = useMemo(
    () => ({ type: "FeatureCollection" as const, features: mainFeatures }),
    [mainFeatures],
  );
  const geojsonBus = useMemo(
    () => ({ type: "FeatureCollection" as const, features: busFeatures }),
    [busFeatures],
  );
  const geojsonAircr = useMemo(
    () => ({ type: "FeatureCollection" as const, features: aircrFeatures }),
    [aircrFeatures],
  );

  // Train/Subway/Tram-Source clustert IMMER bis zoom 11 — beim Reinzoomen
  // zerfallen die Cluster automatisch in Einzel-Marker (clusterMaxZoom={11}).
  // Bus clustert NIE (Stadt-Bushaltestellen müssen alle einzeln antappbar
  // bleiben), Airport/Cruise auch immer (3k+ Pins weltweit).
  const clusterMain = true;
  const clusterAircr = true;

  // Cluster-Farbe für den Haupt-Source — dominanter Mode entscheidet
  // (Train gelb, Subway blau, Tram dunkel, gemischt → train default).
  const clusterColorMain = useMemo(() => {
    const sample = geojsonMain.features[0]?.properties?.kind as string | undefined;
    if (sample === "subway") return SUBWAY_BLUE;
    if (sample === "tram") return DARK;
    if (sample === "bus") return BUS_PURPLE;
    return TRAIN_YELLOW;
  }, [geojsonMain]);
  const clusterTextColorMain =
    clusterColorMain === DARK || clusterColorMain === SUBWAY_BLUE || clusterColorMain === BUS_PURPLE
      ? "#FFFFFF"
      : "#14181A";

  // Cluster-Farbe für Airport/Cruise-Source.
  const clusterColorAircr = useMemo(() => {
    const sample = geojsonAircr.features[0]?.properties?.kind;
    return sample === "cruise" ? CRUISE_BLUE : LIME;
  }, [geojsonAircr]);
  const clusterTextColorAircr = clusterColorAircr === CRUISE_BLUE ? "#FFFFFF" : "#14181A";

  return (
    <>
      <GeoJSONSource
        id={SRC_ID}
        data={geojsonMain}
        cluster={clusterMain}
        clusterMaxZoom={11}
        clusterRadius={60}
        onPress={(e) => {
          if (!onMarkerPress) return;
          const feature = e.nativeEvent.features.find(
            (f) => !f.properties?.point_count && typeof f.properties?.id === "string",
          );
          if (feature) onMarkerPress(feature.properties!.id as string);
        }}
      >
      {/* Cluster-Kreis für Train/Subway/Tram/Multi-Mode */}
      <Layer
        id={CLUSTER_CIRCLE_LAYER_ID}
        type="circle"
        filter={["has", "point_count"]}
        paint={{
          "circle-color": clusterColorMain,
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            16,
            10,
            20,
            50,
            24,
          ],
        }}
      />
      <Layer
        id={CLUSTER_COUNT_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["has", "point_count"]}
        layout={{
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
        }}
        paint={{
          "text-color": clusterTextColorMain,
        }}
      />

      {/* Pillen-Container für Multi-Mode-Marker. Zoom-skaliert via interpolate. */}
      <Layer
        id={PILL_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          "icon-image": [
            "case",
            ["==", ["get", "kindsCount"], 3], "marker-pill-3",
            "marker-pill-2",
          ],
          // Zoom-Skalierung: bei rausgezoomter Karte kleiner, bei reingezoomter
          // größer. Multipliziert mit Selected-Faktor.
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.33, 0.30],
            14, ["case", ["==", ["get", "selected"], true], 0.55, 0.50],
            18, ["case", ["==", ["get", "selected"], true], 0.77, 0.70],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Single-Mode BG: großer farbiger Kreis mit Stroke. */}
      <Layer
        id={BG_SINGLE_LAYER_ID}
        type="circle"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], ["<", ["get", "kindsCount"], 2]]}
        paint={{
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 10, 8],
            14, ["case", ["==", ["get", "selected"], true], 16, 14],
            18, ["case", ["==", ["get", "selected"], true], 22, 20],
          ],
          "circle-color": [
            "match",
            ["get", "kind"],
            "train", TRAIN_YELLOW,
            "subway", SUBWAY_BLUE,
            "airport", LIME,
            "bus", BUS_PURPLE,
            "tram", DARK,
            "cruise", CRUISE_BLUE,
            WHITE,
          ],
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
        }}
      />

      {/* Multi-Mode Slot 0 Badge — farbiger Kreis hinter dem Slot-0-Icon. */}
      <Layer
        id={BADGE_SLOT0_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind"],
            "train", "marker-badge-train",
            "subway", "marker-badge-subway",
            "bus", "marker-badge-bus",
            "tram", "marker-badge-tram",
            "ferry", "marker-badge-ferry",
            "marker-badge-bus",
          ],
          "icon-offset": [
            "case",
            ["==", ["get", "kindsCount"], 3], ["literal", MM_OFFSET_3_LEFT],
            ["literal", MM_OFFSET_2_LEFT],
          ],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.33, 0.30],
            14, ["case", ["==", ["get", "selected"], true], 0.55, 0.50],
            18, ["case", ["==", ["get", "selected"], true], 0.77, 0.70],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Multi-Mode Slot 1 Badge. */}
      <Layer
        id={BADGE_SLOT1_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind1"],
            "train", "marker-badge-train",
            "subway", "marker-badge-subway",
            "bus", "marker-badge-bus",
            "tram", "marker-badge-tram",
            "ferry", "marker-badge-ferry",
            "marker-badge-bus",
          ],
          "icon-offset": [
            "case",
            ["==", ["get", "kindsCount"], 3], ["literal", MM_OFFSET_3_MID],
            ["literal", MM_OFFSET_2_RIGHT],
          ],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.33, 0.30],
            14, ["case", ["==", ["get", "selected"], true], 0.55, 0.50],
            18, ["case", ["==", ["get", "selected"], true], 0.77, 0.70],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Multi-Mode Slot 2 Badge (3-Kind). */}
      <Layer
        id={BADGE_SLOT2_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 3]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind2"],
            "train", "marker-badge-train",
            "subway", "marker-badge-subway",
            "bus", "marker-badge-bus",
            "tram", "marker-badge-tram",
            "ferry", "marker-badge-ferry",
            "marker-badge-bus",
          ],
          "icon-offset": ["literal", MM_OFFSET_3_RIGHT],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.33, 0.30],
            14, ["case", ["==", ["get", "selected"], true], 0.55, 0.50],
            18, ["case", ["==", ["get", "selected"], true], 0.77, 0.70],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Icon-Layers — pro Slot ein symbol-Layer mit identischem icon-offset
          wie das jeweilige Badge. Da Badge UND Icon dieselbe icon-size haben
          (interpoliert auf gleichen Stops), landen Badge-Mittelpunkt und
          Icon-Mittelpunkt exakt aufeinander. */}
      <Layer
        id={ICON_SLOT0_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["!", ["has", "point_count"]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind"],
            "train", "marker-train",
            "subway", "marker-train",
            "airport", "marker-airport",
            "bus", "marker-bus",
            "tram", "marker-tram",
            "cruise", "marker-cruise",
            "marker-bus",
          ],
          // Multi-Mode: identische Offsets wie Badge Slot 0.
          // Single-Mode: zentriert.
          "icon-offset": [
            "case",
            ["==", ["get", "kindsCount"], 3], ["literal", MM_OFFSET_3_LEFT],
            ["==", ["get", "kindsCount"], 2], ["literal", MM_OFFSET_2_LEFT],
            ["literal", [0, 0]],
          ],
          // Zoom-Skalierung. Single-Mode Icons sind etwas kleiner (passen
          // in den 14px-Kreis besser), Multi-Mode-Icons gleichen sich an die
          // 0.5-Badge-Größe an, damit alles proportional bleibt.
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, [
              "case",
              [">=", ["get", "kindsCount"], 2], 0.24,
              ["==", ["get", "selected"], true], 0.30,
              0.25,
            ],
            14, [
              "case",
              [">=", ["get", "kindsCount"], 2], 0.40,
              ["==", ["get", "selected"], true], 0.50,
              0.42,
            ],
            18, [
              "case",
              [">=", ["get", "kindsCount"], 2], 0.56,
              ["==", ["get", "selected"], true], 0.70,
              0.59,
            ],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      <Layer
        id={ICON_SLOT1_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind1"],
            "train", "marker-train",
            "subway", "marker-train",
            "tram", "marker-tram",
            "bus", "marker-bus",
            "ferry", "marker-cruise",
            "marker-bus",
          ],
          "icon-offset": [
            "case",
            ["==", ["get", "kindsCount"], 3], ["literal", MM_OFFSET_3_MID],
            ["literal", MM_OFFSET_2_RIGHT],
          ],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, 0.24,
            14, 0.40,
            18, 0.56,
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      <Layer
        id={ICON_SLOT2_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 3]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind2"],
            "train", "marker-train",
            "subway", "marker-train",
            "tram", "marker-tram",
            "bus", "marker-bus",
            "ferry", "marker-cruise",
            "marker-bus",
          ],
          "icon-offset": ["literal", MM_OFFSET_3_RIGHT],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, 0.24,
            14, 0.40,
            18, 0.56,
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      </GeoJSONSource>

      {/* ============================================================
          Reine Bus-Stops — eigener Source ohne Clustering. Damit bleiben
          alle Bushaltestellen in der Stadt einzeln antappbar, egal wie
          dicht sie gerendert sind. */}
      <GeoJSONSource
        id={SRC_ID_BUS}
        data={geojsonBus}
        cluster={false}
        onPress={(e) => {
          if (!onMarkerPress) return;
          const feature = e.nativeEvent.features.find(
            (f) => typeof f.properties?.id === "string",
          );
          if (feature) onMarkerPress(feature.properties!.id as string);
        }}
      >
      <Layer
        id={BG_SINGLE_BUS_LAYER_ID}
        type="circle"
        paint={{
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 10, 8],
            14, ["case", ["==", ["get", "selected"], true], 16, 14],
            18, ["case", ["==", ["get", "selected"], true], 22, 20],
          ],
          "circle-color": BUS_PURPLE,
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
        }}
      />

      <Layer
        id={ICON_BUS_LAYER_ID}
        type="symbol"
        layout={{
          "icon-image": "marker-bus",
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.30, 0.25],
            14, ["case", ["==", ["get", "selected"], true], 0.50, 0.42],
            18, ["case", ["==", ["get", "selected"], true], 0.70, 0.59],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      </GeoJSONSource>

      {/* ============================================================
          Airport + Cruise — eigener Source MIT Clustering. Weltweite
          Pin-Sets (3k+ Airports), ohne Clustering wäre die Tap-Hit-
          Detection lahm. */}
      <GeoJSONSource
        id={SRC_ID_AIRCR}
        data={geojsonAircr}
        cluster={clusterAircr}
        clusterMaxZoom={13}
        clusterRadius={60}
        onPress={(e) => {
          if (!onMarkerPress) return;
          const feature = e.nativeEvent.features.find(
            (f) => !f.properties?.point_count && typeof f.properties?.id === "string",
          );
          if (feature) onMarkerPress(feature.properties!.id as string);
        }}
      >
      {/* Cluster-Kreis für Airport/Cruise */}
      <Layer
        id="surroundings-markers-aircr-cluster"
        type="circle"
        filter={["has", "point_count"]}
        paint={{
          "circle-color": clusterColorAircr,
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            16,
            10,
            20,
            50,
            24,
          ],
        }}
      />
      <Layer
        id="surroundings-markers-aircr-cluster-count"
        type="symbol"
        source={SRC_ID_AIRCR}
        filter={["has", "point_count"]}
        layout={{
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 12,
        }}
        paint={{
          "text-color": clusterTextColorAircr,
        }}
      />

      {/* Einzelne Airport/Cruise-Marker (nicht im Cluster) */}
      <Layer
        id={BG_AIRCR_LAYER_ID}
        type="circle"
        source={SRC_ID_AIRCR}
        filter={["!", ["has", "point_count"]]}
        paint={{
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 10, 8],
            14, ["case", ["==", ["get", "selected"], true], 16, 14],
            18, ["case", ["==", ["get", "selected"], true], 22, 20],
          ],
          "circle-color": [
            "match",
            ["get", "kind"],
            "airport", LIME,
            "cruise", CRUISE_BLUE,
            LIME,
          ],
          "circle-stroke-color": "#14181A",
          "circle-stroke-width": 2,
        }}
      />
      <Layer
        id={ICON_AIRCR_LAYER_ID}
        type="symbol"
        filter={["!", ["has", "point_count"]]}
        layout={{
          "icon-image": [
            "match",
            ["get", "kind"],
            "airport", "marker-airport",
            "cruise", "marker-cruise",
            "marker-airport",
          ],
          "icon-size": [
            "interpolate", ["linear"], ["zoom"],
            10, ["case", ["==", ["get", "selected"], true], 0.30, 0.25],
            14, ["case", ["==", ["get", "selected"], true], 0.50, 0.42],
            18, ["case", ["==", ["get", "selected"], true], 0.70, 0.59],
          ],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      </GeoJSONSource>
    </>
  );
});
