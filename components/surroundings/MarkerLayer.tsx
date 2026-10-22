import { memo, useMemo } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { MapMarker } from "@/lib/surroundings/mockData";
import { useAccent } from "@/lib/theme/accent";
import { declutter, DECLUTTER_ZOOM } from "@/lib/surroundings/declutter";
import { TRANSIT_COLOR } from "@/lib/theme/transitColors";

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
 *   3. Marker-Kasten       → abgerundetes Quadrat je Verkehrsart mit dickem
 *                            weißem Rand und eingebackenem Symbol (U-Bahn: „U")
 *   4. Mehrfach-Halt       → weißer Rahmen + je Art ein farbiger Kasten
 *
 * Die Kästen sind fertige Bilder (`server/scripts/build-marker-icons.mjs`):
 * Vorher waren es Kreise mit dunklem 2-dp-Strich und einem Symbol darüber —
 * gewünscht waren Kästen wie Haltestellenschilder, mit dickerem Rahmen. Ein
 * Bild statt Kreis + Symbol ist schärfer und spart je Quelle eine Ebene.
 *
 * Kästen, die sich überdecken würden, rücken auseinander — als `icon-offset`
 * je Merkmal (`off`, bei mehreren Arten `off0`…`off2` je Kasten im Rahmen),
 * gerechnet in lib/surroundings/declutter.ts.
 */

/**
 * Die Haufen (Cluster) in den Farben der Kästen — der Farben der ganzen App
 * (lib/theme/transitColors.ts) —, mit weißem Rand und weißer Zahl wie Rahmen
 * und Symbol der Kästen. Vorher hell gelb mit dunklem Rand: neben den Kästen
 * sah ein Haufen aus wie aus einer anderen App. Flughafen: der dunkle Ton des
 * Akzents (`accent.dark`), wie sein Kasten.
 */
const TRAIN_AMBER = TRANSIT_COLOR.regional;
const BUS_PURPLE = TRANSIT_COLOR.bus;
const TRAM_DARK = TRANSIT_COLOR.tram;
const CRUISE_BLUE = TRANSIT_COLOR.ferry;
const SUBWAY_BLUE = TRANSIT_COLOR.subway;
const CLUSTER_RING = "#FFFFFF";
const CLUSTER_TEXT = "#FFFFFF";

interface Props {
  markers: MapMarker[];
  /** Wird beim Tap auf einen Einzel-Marker (NICHT Cluster) aufgerufen.
   *  Übergibt die ID des Markers (= location.code). */
  onMarkerPress?: (id: string) => void;
  /**
   * Unsichtbar, aber eingehängt — in der Live-Ansicht. Ab- und wieder
   * Aufbauen hieße drei Quellen und sechzehn Ebenen neu in den Stil zu legen,
   * auf dem UI-Strang, genau während Blatt und Kamera fahren (das war ein Teil
   * des Ruckelns beim Zurück). Umschalten ist eine Eigenschaft je Ebene.
   */
  hidden?: boolean;
}

const SHOWN = { visibility: "visible" } as const;
const HIDDEN = { visibility: "none" } as const;

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
// Neue IDs für die Kästen: Die alten Hintergründe waren Kreis-Ebenen, und
// MapLibre Native verbietet einen Typwechsel unter derselben ID (silent fail).
const BOX_BUS_LAYER_ID = "surroundings-markers-box-bus";
const BOX_AIRCR_LAYER_ID = "surroundings-markers-box-aircr";
const PILL_LAYER_ID = "surroundings-markers-pill";
const BOX_SINGLE_LAYER_ID = "surroundings-markers-box-single";
// Eigene neue Layer-IDs für die Badge-Symbol-Layer — die alten IDs waren
// vorher Circle-Layer registriert, MapLibre Native verbietet Layer-Typ-
// Änderungen unter derselben ID (silent fail).
const BADGE_SLOT0_LAYER_ID = "surroundings-markers-badge-slot0";
const BADGE_SLOT1_LAYER_ID = "surroundings-markers-badge-slot1";
const BADGE_SLOT2_LAYER_ID = "surroundings-markers-badge-slot2";
const CLUSTER_CIRCLE_LAYER_ID = "surroundings-markers-cluster";
const CLUSTER_COUNT_LAYER_ID = "surroundings-markers-cluster-count";

// Multi-Mode-Slot-Offsets — die Mitten der Kästen im weißen Rahmen:
//   2-Kind: ±13,5 dp, 3-Kind: 0/±27 dp (bei Zoom 14). `icon-offset` wird mit
//   `icon-size` multipliziert; Rahmen und Kästen sind vierfach aufgelöst und
//   laufen mit derselben icon-size (`MULTI_SIZE`, 0.25 bei Zoom 14) — also ×4.
//   Maße: `renderPill`/`renderBadge` in build-marker-icons.mjs. Dazu kommt der
//   Versatz des ganzen Halts (`toFeature`).
const MM_OFFSET_2_LEFT: [number, number] = [-54, 0];
const MM_OFFSET_2_RIGHT: [number, number] = [54, 0];
const MM_OFFSET_3_LEFT: [number, number] = [-108, 0];
const MM_OFFSET_3_MID: [number, number] = [0, 0];
const MM_OFFSET_3_RIGHT: [number, number] = [108, 0];

const SELECTED = ["==", ["get", "selected"], true] as const;
/**
 * Größe der Kästen: 17 / 30 / 42 dp bei Zoom 10 / 14 / 18 (ausgewählt etwas
 * größer) — so viel Fläche wie vorher die Kreise samt Rand. Das Bild ist
 * 120 px groß (vierfach für 30 dp).
 */
const BOX_SIZE = [
  "interpolate", ["linear"], ["zoom"],
  10, ["case", SELECTED, 0.175, 0.142],
  14, ["case", SELECTED, 0.283, 0.25],
  18, ["case", SELECTED, 0.383, 0.35],
] as const;
/**
 * `icon-size` eines nicht gewählten Kastens auf `DECLUTTER_ZOOM` — `BOX_SIZE`
 * und `MULTI_SIZE` stimmen dort überein (0,25 auf 14, 0,35 auf 18). Damit wird
 * der Versatz aus Punkten in Bildpunkte umgerechnet.
 */
const SIZE_AT_DECLUTTER = 0.25 + ((0.35 - 0.25) * (DECLUTTER_ZOOM - 14)) / 4;
/** Bildgröße in Pixeln (vierfach): Einzel-Kasten, Rahmen für zwei, für drei Arten. */
const IMAGE_PX: Record<1 | 2 | 3, readonly [number, number]> = { 1: [120, 120], 2: [236, 128], 3: [344, 128] };
const round1 = (v: number) => Math.round(v * 10) / 10;
/** Rahmen und Kästen eines Halts mit mehreren Verkehrsarten — dieselbe Höhe wie ein Einzel-Kasten. */
const MULTI_SIZE = [
  "interpolate", ["linear"], ["zoom"],
  10, ["case", SELECTED, 0.156, 0.142],
  14, ["case", SELECTED, 0.275, 0.25],
  18, ["case", SELECTED, 0.385, 0.35],
] as const;
/** Kasten je Verkehrsart (Flughafen: in der Akzentfarbe, siehe `boxImage`). */
const BOX_BY_KIND = [
  "train", "marker-box-train",
  "subway", "marker-box-subway",
  "bus", "marker-box-bus",
  "tram", "marker-box-tram",
  "cruise", "marker-box-cruise",
  "ferry", "marker-box-ferry",
] as const;
const BADGE_BY_KIND = (prop: "kind" | "kind1" | "kind2") => [
  "match",
  ["get", prop],
  "train", "marker-badge-train",
  "subway", "marker-badge-subway",
  "bus", "marker-badge-bus",
  "tram", "marker-badge-tram",
  "ferry", "marker-badge-ferry",
  "marker-badge-bus",
] as const;

export const MarkerLayer = memo(function MarkerLayer({ markers, onMarkerPress, hidden = false }: Props) {
  const vis = hidden ? HIDDEN : SHOWN;
  // Akzent fließt in alle „airport"-Marker (in MapLibre-Style-Expressions als
  // Literal-Hex eingebettet). Train/Bus/Cruise haben weiterhin Mode-spezifische
  // Farben (Gelb/Lila/Blau) damit Marker-Typen visuell unterscheidbar bleiben.
  const accent = useAccent();
  const airportBox = accent.id === "mint" ? "marker-box-airport-mint" : "marker-box-airport-lime";
  const boxImage = ["match", ["get", "kind"], ...BOX_BY_KIND, "airport", airportBox, "marker-box-bus"] as const;
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
    /**
     * Auseinanderrücken, was sich überdecken würde — über ALLE Quellen
     * gemeinsam: Ein Bushalt weicht auch dem Bahnhof aus, der in der anderen
     * Quelle liegt. Wichtigere Halte bleiben eher stehen.
     */
    const shift = declutter(
      markers.map((m) => {
        const kinds = m.kinds && m.kinds.length > 0 ? m.kinds : [m.type];
        const [w, h] = IMAGE_PX[Math.min(kinds.length, 3) as 1 | 2 | 3];
        return {
          id: m.id,
          longitude: m.coord.longitude,
          latitude: m.coord.latitude,
          width: w * SIZE_AT_DECLUTTER,
          height: h * SIZE_AT_DECLUTTER,
          mobility: kinds.length === 1 && kinds[0] === "bus" ? 1 : 0.5,
        };
      }),
    );
    function toFeature(m: MapMarker) {
      const kinds = m.kinds && m.kinds.length > 0 ? m.kinds : [m.type];
      const count = Math.min(kinds.length, 3);
      // In Bildpunkten: MapLibre nimmt `icon-offset` mit `icon-size` mal.
      const d = shift.get(m.id);
      const ox = d ? round1(d[0] / SIZE_AT_DECLUTTER) : 0;
      const oy = d ? round1(d[1] / SIZE_AT_DECLUTTER) : 0;
      const slots =
        count === 3 ? [MM_OFFSET_3_LEFT, MM_OFFSET_3_MID, MM_OFFSET_3_RIGHT] : [MM_OFFSET_2_LEFT, MM_OFFSET_2_RIGHT];
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
          kindsCount: count,
          selected: Boolean(m.selected),
          big: Boolean(m.big),
          off: [ox, oy],
          // Die Kästen im Rahmen: ihr Platz darin plus der Versatz des Halts.
          ...(count >= 2
            ? {
                off0: [slots[0]![0] + ox, oy],
                off1: [slots[1]![0] + ox, oy],
                off2: [(slots[2]?.[0] ?? 0) + ox, oy],
              }
            : {}),
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
  // (Zug bernstein, U-Bahn blau, Tram dunkel, gemischt → Zug).
  const clusterColorMain = useMemo(() => {
    const sample = geojsonMain.features[0]?.properties?.kind as string | undefined;
    if (sample === "subway") return SUBWAY_BLUE;
    if (sample === "tram") return TRAM_DARK;
    if (sample === "bus") return BUS_PURPLE;
    return TRAIN_AMBER;
  }, [geojsonMain]);

  // Cluster-Farbe für Airport/Cruise-Source.
  const clusterColorAircr = useMemo(() => {
    const sample = geojsonAircr.features[0]?.properties?.kind;
    return sample === "cruise" ? CRUISE_BLUE : accent.dark;
  }, [geojsonAircr, accent.dark]);

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
        layout={vis}
        paint={{
          "circle-color": clusterColorMain,
          "circle-stroke-color": CLUSTER_RING,
          "circle-stroke-width": 2.5,
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
          ...vis,
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
        }}
        paint={{
          "text-color": CLUSTER_TEXT,
        }}
      />

      {/* Weißer Rahmen um einen Halt mit mehreren Verkehrsarten. */}
      <Layer
        id={PILL_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          ...vis,
          "icon-image": [
            "case",
            ["==", ["get", "kindsCount"], 3], "marker-pill-3",
            "marker-pill-2",
          ],
          "icon-size": MULTI_SIZE as never,
          "icon-offset": ["get", "off"] as never,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Ein Halt, eine Verkehrsart: Kasten mit Rand und Symbol. */}
      <Layer
        id={BOX_SINGLE_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], ["<", ["get", "kindsCount"], 2]]}
        layout={{
          ...vis,
          "icon-image": boxImage as never,
          "icon-size": BOX_SIZE as never,
          "icon-offset": ["get", "off"] as never,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />

      {/* Mehrere Verkehrsarten: je Art ein farbiger Kasten im Rahmen. */}
      <Layer
        id={BADGE_SLOT0_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          ...vis,
          "icon-image": BADGE_BY_KIND("kind") as never,
          "icon-offset": ["get", "off0"] as never,
          "icon-size": MULTI_SIZE as never,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      <Layer
        id={BADGE_SLOT1_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 2]]}
        layout={{
          ...vis,
          "icon-image": BADGE_BY_KIND("kind1") as never,
          "icon-offset": ["get", "off1"] as never,
          "icon-size": MULTI_SIZE as never,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      <Layer
        id={BADGE_SLOT2_LAYER_ID}
        type="symbol"
        source={SRC_ID}
        filter={["all", ["!", ["has", "point_count"]], [">=", ["get", "kindsCount"], 3]]}
        layout={{
          ...vis,
          "icon-image": BADGE_BY_KIND("kind2") as never,
          "icon-offset": ["get", "off2"] as never,
          "icon-size": MULTI_SIZE as never,
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
        id={BOX_BUS_LAYER_ID}
        type="symbol"
        layout={{
          ...vis,
          "icon-image": "marker-box-bus",
          "icon-size": BOX_SIZE as never,
          "icon-offset": ["get", "off"] as never,
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
        layout={vis}
        paint={{
          "circle-color": clusterColorAircr,
          "circle-stroke-color": CLUSTER_RING,
          "circle-stroke-width": 2.5,
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
          ...vis,
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 13,
        }}
        paint={{
          "text-color": CLUSTER_TEXT,
        }}
      />

      {/* Einzelne Airport/Cruise-Marker (nicht im Cluster) */}
      <Layer
        id={BOX_AIRCR_LAYER_ID}
        type="symbol"
        source={SRC_ID_AIRCR}
        filter={["!", ["has", "point_count"]]}
        layout={{
          ...vis,
          "icon-image": boxImage as never,
          "icon-size": BOX_SIZE as never,
          "icon-offset": ["get", "off"] as never,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        }}
      />
      </GeoJSONSource>
    </>
  );
});
