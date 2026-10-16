import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useWindowDimensions } from "react-native";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useAccent } from "@/lib/theme/accent";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { LINE_SOURCE_MAXZOOM } from "@/components/surroundings/lineSourceTuning";
import { metersPerPixel, sliceLine } from "@/lib/live/geo";
import { cameraTarget } from "@/lib/live/camera";
import { useSearchStore } from "@/stores/searchStore";
import type { LiveModel } from "@/lib/live/model";
import { compact, stopsCollection, threeDZoom, vehicleCollection } from "@/lib/live/features";
import type { ZoomTrack } from "@/lib/live/zoomTrack";
import { ARC_LAYER_PREFIX } from "@/lib/routing/flightArcs3d";

/**
 * DIE LIVE-ANSICHT AUF DER KARTE — die Strecke, ihre Halte und das Fahrzeug,
 * das sich darauf bewegt (gerechnet, siehe `lib/live/model.ts`).
 *
 * Die Strecke sieht aus wie eine Route (`RouteLayer`): Akzentlinie, 4 breit,
 * darunter der dunkle Schatten bzw. auf der hellen Karte der Rand im
 * abgedunkelten Akzent. Was schon gefahren ist, liegt grau darüber — wie bei
 * einer Navigation.
 *
 * DAS FAHRZEUG hat zwei Gestalten, je nach Zoom:
 *   • nah: ein 3D-Körper (`fill-extrusion`, `lib/live/shapes.ts`) — ein Zug als
 *     Wagenkette, die sich in Kurven biegt; ein Flugzeug schwebt in seiner
 *     Höhe, mit Schatten am Boden und einem dünnen Lot dazwischen.
 *   • weit: ein Punkt in der Farbe der Verkehrsart mit Richtungspfeil (bzw. das
 *     Flugzeug von oben, gedreht nach Kurs).
 * Der Wechsel ist eine Überblendung über den Zoom — die rechnet die Karte
 * selbst, ohne einen Durchgang hier.
 *
 * DER TAKT: Das Fahrzeug wird so oft neu gesetzt, dass es je Schritt höchstens
 * gut einen halben Bildpunkt vorankommt — bis zu 20-mal je Sekunde, im Stand
 * einmal. Vorher waren es anderthalb Bildpunkte bei höchstens 20 Hz: Ein Bus
 * auf Zoom 17 oder ein Zug auf 15,4 (beide ~13 Punkte/s) bekamen so nur neun
 * Schritte je Sekunde, und unter der gleichmäßig gleitenden Kamera sah man sie
 * ticken. Gerechnet wird für einen Augenblick 35 ms voraus — so lange braucht
 * ein neues Bild der Quelle bis auf den Schirm. Ändert sich der Zoom (Fahrt,
 * Geste vorbei, Schnitt), wird sofort und dann im vollen Takt neu gebaut
 * (`zoomTrack`), damit die Größe nie zu einem anderen Zoom gehört.
 *
 * Jeder Durchgang betrifft nur DIESES Bauteil (eigener Zustand), und darin nur
 * die Fahrzeug-Quelle — die übrigen Quellen sind als fertige Elemente
 * vorgehalten und werden nicht neu durchlaufen. Die Strecke liegt in einer
 * eigenen Quelle, die sich nie ändert; das schon Gefahrene wird in Stücken von
 * einem halben Kilometer „eingefroren", und nur das letzte Stück fährt mit dem
 * Fahrzeug mit.
 *
 * Eingehängt wird alles auf einmal, solange die Live-Ansicht offen ist, und
 * nichts davon wechselt dazwischen (keine bedingten Ebenen) — eine abgebaute
 * Kind-Ebene ist in dieser Bibliothek der Weg in einen Absturz (siehe die
 * Häuser-Ebene in `surroundings.tsx`).
 */

type LayerProps = ComponentProps<typeof Layer>;
type LineProps = Extract<LayerProps, { type: "line" }>;
type CircleProps = Extract<LayerProps, { type: "circle" }>;
type SymbolProps = Extract<LayerProps, { type: "symbol" }>;
type FillProps = Extract<LayerProps, { type: "fill" }>;
type ExtrusionProps = Extract<LayerProps, { type: "fill-extrusion" }>;

/** Über so viele Zoomstufen blendet 2D in 3D über. */
const FADE = 0.6;
/** Ab so vielen Metern Rückstand wird das Gefahrene eingefroren. */
const FREEZE_M = 500;
/** Takt: höchstens so oft je Sekunde … */
const MAX_HZ = 20;
/** … und so weit (Bildpunkte) kommt das Fahrzeug je Schritt höchstens voran. */
const STEP_PX = 0.6;
/** Vorlauf für den Weg der Daten bis auf den Schirm (Quelle → Kachel → Bild). */
const LEAD_MS = 35;
/**
 * Der regelmäßige Takt beginnt erst, wenn die Karte unten eingeblendet ist
 * (220 ms) — jeder Durchgang schreibt laufende Reanimated-Werte verspätet
 * zurück (feedback_reanimated_commit_race), die Einblendung würde flackern.
 * Ein Sprung der Kamera baut trotzdem sofort neu.
 */
const ARM_MS = 450;

/** Farben der Verkehrsarten wie auf den Haltestellen-Markern (MarkerLayer). */
const DOT: Record<string, { fill: string; icon: string; halo: string }> = {
  train: { fill: "#FFD60A", icon: "marker-train", halo: "rgba(255,214,10,0.24)" },
  subway: { fill: "#4C7BF0", icon: "marker-train", halo: "rgba(76,123,240,0.26)" },
  tram: { fill: "#2A2A2C", icon: "marker-tram", halo: "rgba(244,244,245,0.20)" },
  bus: { fill: "#9D5FE0", icon: "marker-bus", halo: "rgba(157,95,224,0.26)" },
  ferry: { fill: "#6B95B5", icon: "marker-cruise", halo: "rgba(107,149,181,0.26)" },
};
const DEST_COLOR = "#FF3B5C";

const SRC_LINE = "live-line-src";
const SRC_DONE = "live-done-src";
const SRC_STOPS = "live-stops-src";
const SRC_VEH = "live-veh-src";
/** Der Punkt der 2D-Gestalt — eigene Quelle, siehe `vehicleCollection`. */
const SRC_PT = "live-pt-src";
const SRC_ARC = "live-arc-src";
/**
 * Stumpfe Enden, spitze Ecken — wie die Routen-Bögen: Runde Kappen bringen
 * Eckpunkte mit schräger Ausrichtung, aus denen der Shader die Richtung des
 * Bogens nicht lesen kann.
 */
const ARC_LAYOUT: LineProps["layout"] = { "line-cap": "butt", "line-join": "miter" };
const ARC_EDGE_SHOWN: LineProps["layout"] = { ...ARC_LAYOUT, visibility: "visible" };
const ARC_EDGE_HIDDEN: LineProps["layout"] = { ...ARC_LAYOUT, visibility: "none" };

const ROUND_LINE: LineProps["layout"] = { "line-cap": "round", "line-join": "round" };
const SHADOW_PAINT: LineProps["paint"] = { "line-color": "#14181A", "line-width": 8, "line-opacity": 0.7 };
const IS_DONE: LineProps["filter"] = ["==", ["get", "k"], "done"];
const IS_BODY: ExtrusionProps["filter"] = ["==", ["get", "k"], "body"];
const IS_SHADOW: FillProps["filter"] = ["==", ["get", "k"], "shadow"];
const IS_POINT: CircleProps["filter"] = ["==", ["get", "k"], "pt"];

/** Der Rand auf der hellen Karte — wie `edgeOf` in RouteLayer. */
function edgeOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return (
    "#" +
    [n >> 16, (n >> 8) & 255, n & 255]
      .map((c) => Math.round(c * 0.42).toString(16).padStart(2, "0"))
      .join("")
  );
}

interface Props {
  model: LiveModel;
  /** Der Zoom, den die Karte gerade zeigt — für die Größe des Fahrzeugs und den Takt. */
  zoom: ZoomTrack;
  /** false = Takt anhalten (Tab nicht im Bild, App im Hintergrund). */
  running: boolean;
}

export const LiveVehicleLayer = memo(function LiveVehicleLayer({ model, zoom, running }: Props) {
  const accent = useAccent();
  const style = useResolvedMapStyle();
  const light = style === "light";
  const z3d = useMemo(() => threeDZoom(model), [model]);
  const plane = model.kind === "plane";

  /** Die Strecke — fest für die ganze Sitzung (bis neue Daten kommen). */
  const lineJson = useMemo(
    () =>
      compact({
        type: "Feature",
        geometry: { type: "LineString", coordinates: model.coords },
        properties: {},
      }),
    [model],
  );

  const first = useMemo(() => model.frameAt(Date.now()), [model]);
  const { height } = useWindowDimensions();
  const [stopsJson, setStopsJson] = useState(() => stopsCollection(model, first));
  const [doneJson, setDoneJson] = useState(() => compact({ type: "FeatureCollection", features: [] }));
  /**
   * Das erste Bild schon für den Zoom, auf dem das Fahrzeug zuerst zu sehen
   * ist: Die Ansicht beginnt mit dem Folgen, und die Kamera springt (Schnitt)
   * oder gleitet auf dessen Stufe (`LiveOverlay`). Mit dem Zoom der Tafel
   * gebaut, stünde nach dem Schnitt kurz ein zu großes Fahrzeug da — der
   * Neubau wartet, solange das Blatt noch hinausfährt (`isTransitionBusy`).
   */
  const [initialVeh] = useState(() => {
    const z = useSearchStore.getState().liveFollow
      ? cameraTarget(model, first, 0, height).zoom
      : zoom.at(Date.now());
    return vehicleCollection(model, first, z, 0, accent.solid);
  });
  const [vehJson, setVehJson] = useState(initialVeh.json);
  const [ptJson, setPtJson] = useState(initialVeh.ptJson);

  const accentRef = useRef(accent.solid);
  accentRef.current = accent.solid;
  const mountedAtRef = useRef(Date.now());

  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let frozenD = 0;
    let stage = "";
    let lastVeh = "";
    let lastPt = "";
    const step = () => {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Mitten in einer Fahrt (Blatt, Seitenwechsel) kein Durchgang — kurz warten.
      if (isTransitionBusy()) {
        timer = setTimeout(step, 100);
        return;
      }
      const now = Date.now();
      const frame = model.frameAt(now + LEAD_MS);
      const z = zoom.at(now);
      const mpp = metersPerPixel(z, frame.position[1]);
      const { json, ptJson: pt, rear } = vehicleCollection(model, frame, z, frozenD, accentRef.current);
      // Rückwärts (neue Daten mit anderer Verspätung): neu einfrieren.
      if (rear < frozenD - 1 || rear - frozenD > Math.max(FREEZE_M, 40 * mpp)) {
        frozenD = Math.max(0, rear);
        setDoneJson(
          compact({
            type: "Feature",
            geometry: { type: "LineString", coordinates: sliceLine(model.coords, model.cum, 0, frozenD) },
            properties: {},
          }),
        );
      }
      if (json !== lastVeh) {
        lastVeh = json;
        setVehJson(json);
      }
      // Der Punkt nur, solange die 2D-Gestalt zu sehen ist: Er trägt Symbole,
      // und jede neue Symbol-Quelle lässt die Karte alle Beschriftungen neu
      // platzieren (siehe `vehicleCollection`).
      if (z < z3d && pt !== lastPt) {
        lastPt = pt;
        setPtJson(pt);
      }
      const nextStage = `${frame.stopIndex}|${frame.nextIndex}|${frame.phase}`;
      if (nextStage !== stage) {
        stage = nextStage;
        setStopsJson(stopsCollection(model, frame));
      }
      // So oft, dass ein Schritt höchstens STEP_PX weit ist (siehe oben).
      const pxPerS = frame.speed / mpp;
      const hz = zoom.changing(now)
        ? MAX_HZ
        : frame.speed > 0.1
          ? Math.max(2, Math.min(MAX_HZ, pxPerS / STEP_PX))
          : 1;
      timer = setTimeout(step, 1000 / hz);
    };
    // Sprung oder Übergang der Kamera: sofort neu bauen, auch vor dem Takt.
    const unsubscribe = zoom.subscribe(step);
    timer = setTimeout(step, Math.max(0, mountedAtRef.current + ARM_MS - Date.now()));
    return () => {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [model, running, zoom, z3d]);

  /**
   * DER FLUG IN DER LUFT — die Linie als Bogen, wie die Flugbögen der Routen
   * (`RouteLayer`, Shader-Patch in vendor/maplibre-native): Ebenen, deren ID mit
   * `binch-arc` beginnt, hebt der Shader auf Scheitelhöhe · sin(π · t); die
   * Scheitelhöhe in Kilometern kommt über `line-gap-width`, die Mercator-Länge
   * über `line-offset`. Hier mit der echten Reiseflughöhe statt der überhöhten
   * Bögen der Übersicht — das Flugzeug sitzt darauf (`drawAltitude`). Die Quelle
   * ist immer eingehängt, bei Bodenfahrzeugen leer.
   */
  const arcJson = useMemo(
    () =>
      compact(
        model.arc
          ? {
              type: "Feature",
              geometry: { type: "LineString", coordinates: model.coords },
              properties: { apexKm: model.arc.apexKm, mercatorLength: model.arc.mercatorLength },
            }
          : { type: "FeatureCollection", features: [] },
      ),
    [model],
  );

  // --- Stile (fest je Sitzung, Akzent und Karte) ---------------------------
  /** Unter einem Flug bleibt die Linie am Boden nur als blasse Spur — der Flug ist oben. */
  const groundOpacity = plane ? 0.3 : 1;
  const edgePaint = useMemo<LineProps["paint"]>(
    () =>
      light
        ? { "line-color": edgeOf(accent.solid), "line-width": 8, "line-opacity": groundOpacity }
        : { ...SHADOW_PAINT, "line-opacity": 0.7 * groundOpacity },
    [light, accent.solid, groundOpacity],
  );
  const todoPaint = useMemo<LineProps["paint"]>(
    () => ({
      "line-color": accent.solid,
      "line-width": 4,
      "line-opacity": groundOpacity,
      ...(model.kind === "ferry" ? { "line-dasharray": [2, 2] } : {}),
    }),
    [accent.solid, model.kind, groundOpacity],
  );
  const donePaint = useMemo<LineProps["paint"]>(
    () => ({
      "line-color": light ? "#A3A8AE" : style === "satellite" ? "#B9B9BE" : "#5A5A60",
      "line-width": 4,
      "line-opacity": groundOpacity,
    }),
    [light, style, groundOpacity],
  );
  const arcPaint = useMemo<LineProps["paint"]>(
    () => ({
      "line-color": accent.solid,
      "line-width": 4,
      "line-gap-width": ["get", "apexKm"],
      // Kein Versatz: Der Shader liest hier die Mercator-Länge des Fluges.
      "line-offset": ["get", "mercatorLength"],
    }),
    [accent.solid],
  );
  /** Der Rand unter dem Bogen — wie bei den Routen nur auf der hellen Karte. */
  const arcEdgePaint = useMemo<LineProps["paint"]>(
    () => ({ ...arcPaint, "line-color": edgeOf(accent.solid), "line-width": 8 }),
    [arcPaint, accent.solid],
  );
  /**
   * Ringe wie die Wegpunkte einer Route (`RouteLayer`): hell mit dunklem Rand,
   * Enden größer, Ziel im Rot der Route. Gefahrenes grau, der nächste Halt im
   * Akzent. „Dein" Halt (der der Tafel) trägt einen Rand im Akzent — so findet
   * man ihn auf der Strecke wieder.
   */
  const ringPaint = useMemo<CircleProps["paint"]>(
    () => ({
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        8, ["case", ["==", ["get", "mine"], true], 5, ["match", ["get", "role"], "mid", 2.5, 4.5]],
        13, ["case", ["==", ["get", "mine"], true], 8, ["match", ["get", "role"], "mid", 4.5, 7]],
        17, ["case", ["==", ["get", "mine"], true], 10, ["match", ["get", "role"], "mid", 6, 9]],
      ],
      "circle-color": [
        "case",
        ["==", ["get", "role"], "end"], DEST_COLOR,
        // Dein Halt bleibt hell (mit Akzent-Rand), auch als nächster Halt —
        // ganz im Akzent wurde er zum Klecks (Probe-Darstellung).
        ["==", ["get", "mine"], true], "#F4F4F5",
        ["==", ["get", "next"], true], accent.solid,
        ["==", ["get", "passed"], true], "#8E8E93",
        "#F4F4F5",
      ],
      "circle-stroke-color": ["case", ["==", ["get", "mine"], true], accent.solid, "#14181A"],
      "circle-stroke-width": ["case", ["==", ["get", "mine"], true], 3, 2],
    }),
    [accent.solid],
  );
  const labelLayout = useMemo<SymbolProps["layout"]>(
    () => ({
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["case", ["==", ["get", "next"], true], 12, 11],
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-optional": true,
      "symbol-sort-key": ["get", "rank"],
      // Kleine Halte erst, wenn Platz ist — sonst stünde die Strecke voller Schrift.
      "text-max-width": 9,
    }),
    [],
  );
  const labelPaint = useMemo<SymbolProps["paint"]>(
    () => ({
      "text-color": ["case", ["==", ["get", "passed"], true], "#8E8E93", "#F4F4F5"],
      "text-halo-color": "#14181A",
      "text-halo-width": 1.5,
    }),
    [],
  );
  /** 3D ein-, 2D ausblenden — über den Zoom, ohne Durchgang hier. */
  const fadeIn = useMemo(
    () => ["interpolate", ["linear"], ["zoom"], z3d - FADE, 0, z3d, 1] as const,
    [z3d],
  );
  const fadeOut = useMemo(
    () => ["interpolate", ["linear"], ["zoom"], z3d - FADE, 1, z3d, 0] as const,
    [z3d],
  );
  const bodyPaint = useMemo<ExtrusionProps["paint"]>(
    () => ({
      "fill-extrusion-color": ["get", "c"],
      "fill-extrusion-height": ["get", "h"],
      "fill-extrusion-base": ["get", "b"],
      "fill-extrusion-opacity": fadeIn as never,
      // Ohne Verlauf: Sonst bekäme jede Schicht (Fahrwerk, Lack, Fensterband,
      // Dach) einen eigenen dunklen Fuß, und der Körper sähe gestreift aus.
      "fill-extrusion-vertical-gradient": false,
    }),
    [fadeIn],
  );
  const shadowPaint = useMemo<FillProps["paint"]>(
    () => ({
      "fill-color": "#000000",
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], z3d - FADE, 0, z3d, 0.3] as never,
    }),
    [z3d],
  );
  const dot = DOT[model.kind] ?? DOT.train!;
  const haloPaint = useMemo<CircleProps["paint"]>(
    () => ({
      "circle-radius": 24,
      "circle-color": plane ? accent.subtle : dot.halo,
      "circle-opacity": fadeOut as never,
    }),
    [plane, accent.subtle, dot.halo, fadeOut],
  );
  const dotPaint = useMemo<CircleProps["paint"]>(
    () => ({
      // Kein Punkt unter dem Flugzeug — es zeigt seine Richtung selbst.
      "circle-radius": plane ? 0 : 15,
      "circle-color": dot.fill,
      "circle-stroke-color": "#F4F4F5",
      "circle-stroke-width": plane ? 0 : 2.5,
      "circle-opacity": fadeOut as never,
      "circle-stroke-opacity": fadeOut as never,
    }),
    [plane, dot.fill, fadeOut],
  );
  const iconLayout = useMemo<SymbolProps["layout"]>(
    () =>
      plane
        ? {
            "icon-image": "live-plane",
            // 30 Punkte — mit 20 ging es im Hof (48) unter.
            "icon-size": 0.75,
            "icon-rotate": ["get", "hdg"],
            "icon-rotation-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          }
        : {
            "icon-image": dot.icon,
            "icon-size": 0.42,
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
    [plane, dot.icon],
  );
  const iconPaint = useMemo<SymbolProps["paint"]>(() => ({ "icon-opacity": fadeOut as never }), [fadeOut]);
  /**
   * Der Pfeil sitzt AUSSERHALB des Punkts in Fahrtrichtung: `icon-offset` gilt
   * im gedrehten Bild („oben" = Fahrtrichtung) und wird mit `icon-size`
   * multipliziert — 50 Bildpunkte bei 0.5 sind 25 Punkte ab der Mitte.
   */
  const arrowLayout = useMemo<SymbolProps["layout"]>(
    () => ({
      "icon-image": "live-arrow",
      "icon-size": plane ? 0 : 0.5,
      "icon-rotate": ["get", "hdg"],
      "icon-rotation-alignment": "map",
      "icon-offset": [0, -50],
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    }),
    [plane],
  );

  /**
   * Alles außer der Fahrzeug-Quelle als FERTIGE Elemente: Ein Takt ändert nur
   * `vehJson`, und ein unverändertes Element überspringt React ganz — sonst
   * liefen bei jedem der bis zu 30 Takte je Sekunde alle Quellen und Ebenen
   * mit durch.
   */
  const below = useMemo(
    () => (
      <>
        {/* Ohne Vereinfachung (`tolerance={0}`), beide Linien: Vereinfacht wich die
            graue gefahrene Strecke um einen Bildpunkt von der Akzentlinie darunter
            ab, und ein grüner Saum blitzte durch (Probe-Darstellung). Eine
            einzelne Linie kostet ungekürzt kaum etwas. */}
        <GeoJSONSource id={SRC_LINE} data={lineJson} maxzoom={LINE_SOURCE_MAXZOOM} tolerance={0}>
          <Layer id="live-line-edge" type="line" layout={ROUND_LINE} paint={edgePaint} />
          <Layer id="live-line-todo" type="line" layout={ROUND_LINE} paint={todoPaint} />
        </GeoJSONSource>
        <GeoJSONSource id={SRC_DONE} data={doneJson} maxzoom={LINE_SOURCE_MAXZOOM} tolerance={0}>
          <Layer id="live-done-line" type="line" layout={ROUND_LINE} paint={donePaint} />
        </GeoJSONSource>
        {/* Der Flugbogen VOR dem Fahrzeug eingehängt: Das Flugzeug (3D) liegt
            darüber. `lineMetrics` liefert dem Shader den Fortschritt, `tolerance`
            0, sonst fehlten dem Bogen Stützpunkte. */}
        <GeoJSONSource id={SRC_ARC} data={arcJson} lineMetrics tolerance={0}>
          <Layer
            id={`${ARC_LAYER_PREFIX}-live-edge`}
            type="line"
            layout={light ? ARC_EDGE_SHOWN : ARC_EDGE_HIDDEN}
            paint={arcEdgePaint}
          />
          <Layer id={`${ARC_LAYER_PREFIX}-live`} type="line" layout={ARC_LAYOUT} paint={arcPaint} />
        </GeoJSONSource>
      </>
    ),
    [lineJson, doneJson, arcJson, edgePaint, todoPaint, donePaint, light, arcEdgePaint, arcPaint],
  );
  /** Die Ebenen der Fahrzeug-Quelle — fest, nur deren Daten wechseln. */
  const vehLayers = useMemo(
    () => [
      <Layer key="done" id="live-veh-done" type="line" filter={IS_DONE} layout={ROUND_LINE} paint={donePaint} />,
      <Layer key="shadow" id="live-veh-shadow" type="fill" filter={IS_SHADOW} paint={shadowPaint} />,
      <Layer key="body" id="live-veh-body" type="fill-extrusion" filter={IS_BODY} paint={bodyPaint} />,
    ],
    [donePaint, shadowPaint, bodyPaint],
  );
  const ptLayers = useMemo(
    () => [
      <Layer key="halo" id="live-veh-halo" type="circle" filter={IS_POINT} paint={haloPaint} />,
      <Layer key="dot" id="live-veh-dot" type="circle" filter={IS_POINT} paint={dotPaint} />,
      <Layer key="icon" id="live-veh-icon" type="symbol" filter={IS_POINT} layout={iconLayout} paint={iconPaint} />,
      <Layer key="arrow" id="live-veh-arrow" type="symbol" filter={IS_POINT} layout={arrowLayout} paint={iconPaint} />,
    ],
    [haloPaint, dotPaint, iconLayout, iconPaint, arrowLayout],
  );
  const above = useMemo(
    () => (
      <GeoJSONSource id={SRC_STOPS} data={stopsJson}>
        {/* Die Ringe UNTER das Fahrzeug (es steht am Halt genau darauf), aber
            über das Gefahrene — `beforeId` statt Einhäng-Reihenfolge, die ist
            keine verlässliche Zusage (siehe Buildings3DLayer). */}
        <Layer id="live-stop-ring" type="circle" beforeId="live-veh-shadow" paint={ringPaint} />
        <Layer id="live-stop-label" type="symbol" layout={labelLayout} paint={labelPaint} />
      </GeoJSONSource>
    ),
    [stopsJson, ringPaint, labelLayout, labelPaint],
  );

  return (
    <>
      {below}
      {/* Das letzte Stück des Gefahrenen fährt mit dem Fahrzeug mit — eigene
          Quelle wäre ein zweiter Durchgang je Takt. Unter den Halten. */}
      <GeoJSONSource id={SRC_VEH} data={vehJson} tolerance={0}>
        {vehLayers}
      </GeoJSONSource>
      <GeoJSONSource id={SRC_PT} data={ptJson}>
        {ptLayers}
      </GeoJSONSource>
      {above}
    </>
  );
});
