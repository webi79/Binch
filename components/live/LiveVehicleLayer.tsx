import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useWindowDimensions } from "react-native";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useAccent } from "@/lib/theme/accent";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { LINE_SOURCE_MAXZOOM } from "@/components/surroundings/lineSourceTuning";
import { metersPerPixel } from "@/lib/live/geo";
import { isLongDistance, TRANSIT_COLOR, tint } from "@/lib/theme/transitColors";
import { cameraTarget, viewHeading } from "@/lib/live/camera";
import { useSearchStore } from "@/stores/searchStore";
import type { LiveModel } from "@/lib/live/model";
import {
  compact,
  DOT_RADIUS_PX,
  hiddenHalfM,
  lineFeature,
  liveModelConfig,
  stopsCollection,
  threeDZoom,
  vehicleCollection,
} from "@/lib/live/features";
import { LiveModels } from "@/modules/live-models";
import type { ZoomTrack } from "@/lib/live/zoomTrack";
import { probeTick } from "@/lib/live/probe";
import { ARC_LAYER_PREFIX } from "@/lib/routing/flightArcs3d";

/**
 * DIE LIVE-ANSICHT AUF DER KARTE — die Strecke, ihre Halte und das Fahrzeug,
 * das sich darauf bewegt (gerechnet, siehe `lib/live/model.ts`).
 *
 * Die Strecke sieht aus wie eine Route (`RouteLayer`): Akzentlinie, 4 breit,
 * darunter der dunkle Schatten bzw. auf der hellen Karte der Rand im
 * abgedunkelten Akzent. Wo das Fahrzeug schon war, wird sie grau — wie bei
 * einer Navigation.
 *
 * DAS FAHRZEUG hat zwei Gestalten, je nach Zoom:
 *   • nah: echte 3D-Modelle in einer eigenen Ebene IN der Karte
 *     (`modules/live-models`) — Bahn als Wagenkette, Bus, Flugzeug auf seinem
 *     Bogen, jeweils mit Schatten am Boden. Lage, Größe und Bewegung zwischen
 *     zwei Takten rechnet die Ebene in jedem Bild selbst. Nur die Fähre ist
 *     noch ein hochgezogener Körper (`fill-extrusion`, `lib/live/shapes.ts`).
 *   • weit: ein Punkt in der Farbe der Verkehrsart mit Richtungspfeil.
 * Der Wechsel ist eine Überblendung über den Zoom — die rechnet die Karte
 * selbst, ohne einen Durchgang hier.
 *
 * DAS GRAUE ENDET UNTER DER MITTE DES FAHRZEUGS. Vorher endete es an seinem
 * Heck, und weil es nur mit dem Takt nachkam, während die 3D-Ebene jedes Bild
 * weiterfährt, öffnete und schloss sich dort ein Spalt — „eine graue Linie,
 * die du drüberlegst". Unter der Mitte verdeckt das Fahrzeug den Übergang;
 * solange das Ende darunter bleibt, darf es hinterherkommen (`hiddenHalfM`).
 * Es liegt etwas breiter als die Akzentlinie, damit deren Kantenglättung
 * nicht als farbiger Saum am Grau stehen bleibt.
 *
 * DER TAKT: Mit der 3D-Ebene bekommt sie alle 300 ms den Weg der nächsten
 * 800 ms (`LiveModels.setMotion`, ohne Durchgang hier) — und das Ende des
 * Grauen nur so oft, wie es nötig ist, um unter dem Fahrzeug zu bleiben (beim
 * langen Zug etwa einmal je Sekunde). Jeder Durchgang hier ist ein Commit,
 * jede neue Quelle ein neuer Kachelschnitt — beides fiel genau in die Gesten
 * („Navigieren ruckelt, vor allem wenn sich das Ding bewegt"). Nur was die
 * Karte selbst zeichnet (Punkt weit draußen, Fähre), wird wie bisher so oft
 * neu gesetzt, dass es je Schritt höchstens anderthalb Punkte vorankommt.
 *
 * Jeder Durchgang betrifft nur DIESES Bauteil (eigener Zustand), und darin nur
 * die Fahrzeug-Quelle — die übrigen Quellen sind als fertige Elemente
 * vorgehalten und werden nicht neu durchlaufen. Die Strecke liegt in einer
 * eigenen Quelle, die sich nie ändert; das schon Gefahrene wird in Stücken
 * eingefroren, und nur das letzte Stück fährt mit.
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
/**
 * Das Gefahrene wird in Stücken dieser Länge (m) eingefroren; das letzte Stück
 * fährt in der Fahrzeug-Quelle mit und beginnt ein Stück VOR dem Eingefrorenen.
 * Die zwei Quellen kommen nicht im selben Bild an — ohne Überlappung blitzte
 * beim Nachrücken für ein Bild die Akzentfarbe durch. Nachgerückt wird deshalb
 * auch nie weiter als um eine Stücklänge auf einmal.
 */
const FREEZE_M = 1200;
/** Takt ohne 3D-Ebene: höchstens so oft je Sekunde … */
const MAX_HZ = 10;
/** … und so weit (Bildpunkte) kommt das Fahrzeug je Schritt höchstens voran. */
const STEP_PX = 1.5;
/**
 * So weit voraus bekommt die 3D-Ebene den Weg (`LiveModels.setMotion`) — sie
 * rechnet dazwischen jedes Bild selbst. Der Takt kommt dafür, solange es
 * fährt, spätestens alle `NATIVE_TICK_MS` (Luft für einen hängenden Strang).
 */
const MOTION_AHEAD_MS = 800;
const NATIVE_TICK_MS = 300;
/** Vorlauf für den Weg der Daten bis auf den Schirm (Quelle → Kachel → Bild). */
const LEAD_MS = 35;
/** So lange (ms) braucht eine neue Quelle ungefähr, bis sie im Bild ist. */
const SOURCE_LAG_MS = 120;
/**
 * Breite des Grauen — etwas mehr als die Akzentlinie (4): Deren Kanten sind
 * geglättet (rund ein Gerätepixel), unter gleich breitem Grau blieb davon ein
 * farbiger Saum stehen, und das Grau sah aufgelegt aus statt eingefärbt.
 */
const DONE_WIDTH = 4.7;
/**
 * Der regelmäßige Takt beginnt erst, wenn die Karte unten eingeblendet ist
 * (220 ms) — jeder Durchgang schreibt laufende Reanimated-Werte verspätet
 * zurück (feedback_reanimated_commit_race), die Einblendung würde flackern.
 * Ein Sprung der Kamera baut trotzdem sofort neu.
 */
const ARM_MS = 450;

/**
 * Die Farben der Verkehrsmittel der ganzen App (lib/theme/transitColors.ts) —
 * wie die Kästen der Karte, Symbol weiß.
 */
const DOT: Record<string, { fill: string; icon: string; halo: string }> = {
  train: { fill: TRANSIT_COLOR.regional, icon: "marker-train-white", halo: tint(TRANSIT_COLOR.regional, 0.24) },
  longDistance: { fill: TRANSIT_COLOR.longDistance, icon: "marker-train-white", halo: tint(TRANSIT_COLOR.longDistance, 0.24) },
  subway: { fill: TRANSIT_COLOR.subway, icon: "marker-subway", halo: tint(TRANSIT_COLOR.subway, 0.32) },
  tram: { fill: TRANSIT_COLOR.tram, icon: "marker-tram", halo: "rgba(244,244,245,0.20)" },
  bus: { fill: TRANSIT_COLOR.bus, icon: "marker-bus-white", halo: tint(TRANSIT_COLOR.bus, 0.26) },
  ferry: { fill: TRANSIT_COLOR.ferry, icon: "marker-cruise", halo: tint(TRANSIT_COLOR.ferry, 0.26) },
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
const IS_MID_STOP: CircleProps["filter"] = ["==", ["get", "role"], "mid"];
const IS_END_STOP: CircleProps["filter"] = ["!=", ["get", "role"], "mid"];
/**
 * Start und Ziel GENAU wie die Wegpunkte einer Route (`RouteLayer`): heller
 * Ring mit dunklem Rand, darin der Kern — Start im Akzent, Ziel im Rot der
 * Route. Vorher waren es kleinere Punkte eigener Art (der Start sogar grau,
 * sobald passiert), und die Übersicht sah anders aus als jede andere Route.
 */
const END_RING_PAINT: CircleProps["paint"] = {
  "circle-radius": 12,
  "circle-color": "#F4F4F5",
  "circle-stroke-color": "#14181A",
  "circle-stroke-width": 2,
};

/**
 * Der 3D-Ebene sagen, wo das Fahrzeug jetzt ist und in `MOTION_AHEAD_MS` sein
 * wird — dazwischen rechnet sie jedes Bild selbst (Boden: Meter entlang der
 * Strecke; Flug: Lage, Höhe, Kurs).
 */
function sendMotion(model: LiveModel, now: number): void {
  const t1 = now + MOTION_AHEAD_MS;
  const f0 = model.frameAt(now);
  const f1 = model.frameAt(t1);
  LiveModels.setMotion(
    model.kind === "plane"
      ? [now, f0.position[0], f0.position[1], f0.drawAltitude, f0.heading, t1, f1.position[0], f1.position[1], f1.drawAltitude, f1.heading]
      : [now, f0.d, t1, f1.d],
  );
}

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
  /** Kennung der nativen Karte — für die 3D-Ebene (`modules/live-models`). */
  nativeTag: () => number | null;
}

export const LiveVehicleLayer = memo(function LiveVehicleLayer({ model, zoom, running, nativeTag }: Props) {
  const accent = useAccent();
  const style = useResolvedMapStyle();
  const light = style === "light";
  const z3d = useMemo(() => threeDZoom(model), [model]);
  const plane = model.kind === "plane";
  /**
   * DIE 3D-EBENE IN DER KARTE (`modules/live-models`): Bahn, Bus und Flugzeug
   * als echte Netze, fest in der Welt nach Fahrtrichtung — einmal eingehängt,
   * dann bekommt sie Strecke, Fahrzeug und mit jedem Takt den Weg der nächsten
   * 800 ms (`sendMotion`); Lage, Wagenkette und Größe rechnet sie jedes Bild
   * selbst. Ohne das Modul (iOS) bleibt es beim 2D-Punkt.
   */
  const native = LiveModels.available && liveModelConfig(model, accent.solid) != null;
  const nativeTagRef = useRef(nativeTag);
  nativeTagRef.current = nativeTag;
  useEffect(() => {
    if (!native) return;
    // Nach einem Kartentyp-Wechsel ist die Karte neu — ihre Kennung kann einen
    // Augenblick fehlen. Kurz nachfragen statt aufzugeben (sonst fehlt das Fahrzeug).
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Die Nummer dieser Einhängung — `detach` nimmt nur sie ab, nie die des
    // Nachfolgers (beim Neuaufbau der Karte kommen beide fast gleichzeitig an).
    let id = 0;
    const attach = () => {
      timer = null;
      const tag = nativeTagRef.current();
      if (tag == null) {
        if (++tries < 30) timer = setTimeout(attach, 100);
        return;
      }
      // Unter die Beschriftung der Halte — sie bleibt über dem Fahrzeug lesbar.
      id = LiveModels.attach(tag, "live-stop-label");
    };
    attach();
    return () => {
      if (timer) clearTimeout(timer);
      if (id) void LiveModels.detach(id);
    };
  }, [native]);
  useEffect(() => {
    if (!native) return;
    const cfg = liveModelConfig(model, accent.solid);
    if (!cfg) return;
    if (model.kind !== "plane") LiveModels.setRoute(model.coords.flat(), model.cum);
    LiveModels.setVehicle(cfg.kind, cfg.head, cfg.mid, cfg.params);
    // `setVehicle` erklärt den Weg für ungültig — gleich den neuen hinterher,
    // sonst fehlte das Fahrzeug bis zum nächsten Takt (frische Daten jede Minute).
    sendMotion(model, Date.now());
  }, [native, model, accent.solid]);

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
  /**
   * Das erste Bild schon für den Zoom, auf dem das Fahrzeug zuerst zu sehen
   * ist: Die Ansicht beginnt mit dem Folgen, und die Kamera springt (Schnitt)
   * oder gleitet auf dessen Stufe (`LiveOverlay`). Mit dem Zoom der Tafel
   * gebaut, stünde nach dem Schnitt kurz ein zu großer Fährenkörper da — der
   * Neubau wartet, solange das Blatt noch hinausfährt (`isTransitionBusy`).
   * Das Gefahrene ist schon im ersten Bild da (eingefroren bis kurz davor).
   */
  const [initial] = useState(() => {
    const z0 = useSearchStore.getState().liveFollow
      ? cameraTarget(model, first, viewHeading(model, first), height).zoom
      : zoom.at(Date.now());
    const frozen = Math.max(0, first.d - FREEZE_M);
    return {
      frozen,
      done: lineFeature(model, 0, frozen),
      veh: vehicleCollection(model, first, z0, { from: frozen - FREEZE_M, to: first.d }, !native),
    };
  });
  const [doneJson, setDoneJson] = useState(initial.done);
  const [vehJson, setVehJson] = useState(initial.veh.json);
  const [ptJson, setPtJson] = useState(initial.veh.ptJson);

  const mountedAtRef = useRef(Date.now());
  /**
   * Bis wohin eingefroren ist — über einen Neustart des Takts hinweg (frische
   * Daten jede Minute, Tab zurück). Gilt das Eingefrorene einer früheren
   * Fassung der Fahrt, wird es aus der neuen geschnitten.
   */
  const frozenRef = useRef(initial.frozen);
  const doneModelRef = useRef(model);

  useEffect(() => {
    if (!running) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let frozen = frozenRef.current;
    if (doneModelRef.current !== model) {
      doneModelRef.current = model;
      setDoneJson(lineFeature(model, 0, frozen));
    }
    let stage = "";
    let lastVeh = "";
    let lastPt = "";
    /** Wann das Ende des Grauen wieder fällig ist (mit 3D-Ebene). */
    let tailAt = 0;
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
      const p0 = performance.now();
      const frame = model.frameAt(now + LEAD_MS);
      const z = zoom.at(now);
      const lat = frame.position[1];
      const mpp = metersPerPixel(z, lat);
      const moving = frame.speed > 0.1;
      // Die 3D-Ebene: wo es jetzt ist und gleich — dazwischen rechnet sie selbst.
      if (native) sendMotion(model, now);
      /**
       * Was die Karte aus diesem Takt zeichnet, braucht jeden Takt: der Punkt
       * weit draußen, der Körper der Fähre, ohne 3D-Ebene der Schatten des
       * Flugzeugs. Sonst geht es nur um das Ende des Grauen unter der Mitte —
       * es kommt so oft, dass es um höchstens 35 % der verdeckten Hälfte
       * vor- oder nachläuft, und gerechnet für die Mitte der Zeit, in der es
       * zu sehen sein wird. Durchgespielt an echten Fahrten (Bus: kürzestes
       * Fahrzeug, Stop-and-go): bis 250 ms Verzug der Quelle bleibt es darunter.
       */
      const perTick = !native || model.kind === "ferry" || z < z3d;
      const tailEvery = moving
        ? Math.min(1000, Math.max(150, (700 * hiddenHalfM(model, z, lat, z3d)) / frame.speed))
        : 1000;
      let doneTo = frame.d;
      let send = perTick;
      if (!perTick && now >= tailAt) {
        send = true;
        tailAt = now + tailEvery;
        doneTo = model.frameAt(now + SOURCE_LAG_MS + tailEvery / 2).d;
      }
      if (send) {
        if (doneTo < frozen - 1) {
          // Rückwärts (neue Daten mit anderer Verspätung): neu einfrieren.
          frozen = frozenRef.current = Math.max(0, doneTo - FREEZE_M);
          setDoneJson(lineFeature(model, 0, frozen));
        } else if (doneTo - frozen > 2 * FREEZE_M) {
          frozen = frozenRef.current = frozen + FREEZE_M;
          setDoneJson(lineFeature(model, 0, frozen));
        }
        const { json, ptJson: pt } = vehicleCollection(model, frame, z, { from: frozen - FREEZE_M, to: doneTo }, !native);
        if (json !== lastVeh) {
          lastVeh = json;
          setVehJson(json);
        }
        // Der 2D-Punkt nur, solange er zu sehen ist — er trägt Symbole, und jede
        // neue Symbol-Quelle lässt die Karte alle Beschriftungen neu platzieren.
        if (z < z3d && pt !== lastPt) {
          lastPt = pt;
          setPtJson(pt);
        }
      }
      const nextStage = `${frame.stopIndex}|${frame.nextIndex}|${frame.phase}`;
      if (nextStage !== stage) {
        stage = nextStage;
        setStopsJson(stopsCollection(model, frame));
      }
      probeTick(performance.now() - p0);
      let next: number;
      if (perTick) {
        // So oft, dass ein Schritt höchstens STEP_PX weit ist (siehe oben).
        const hz = zoom.changing(now)
          ? MAX_HZ
          : moving
            ? Math.max(4, Math.min(MAX_HZ, frame.speed / mpp / STEP_PX))
            : 1;
        next = 1000 / hz;
      } else {
        // Auch im Stand: Der Weg reicht nur `MOTION_AHEAD_MS` voraus — sonst
        // blieb ein anfahrender Zug bis zum nächsten Takt stehen und sprang dann.
        next = Math.min(NATIVE_TICK_MS, tailAt - now);
      }
      timer = setTimeout(step, Math.max(16, next));
    };
    // Sprung oder Übergang der Kamera: sofort neu — auch das Ende des Grauen,
    // denn hineingezoomt verdeckt das Fahrzeug weniger Strecke.
    const unsubscribe = zoom.subscribe(() => {
      tailAt = 0;
      step();
    });
    timer = setTimeout(step, Math.max(0, mountedAtRef.current + ARM_MS - Date.now()));
    return () => {
      stopped = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [model, running, zoom, native, plane, z3d]);

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
      "line-width": DONE_WIDTH,
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
   * Die Zwischenhalte: hell mit dunklem Rand. Gefahrenes grau, der nächste
   * Halt im Akzent. „Dein" Halt (der der Tafel) trägt einen Rand im Akzent —
   * so findet man ihn auf der Strecke wieder. Start und Ziel: `END_RING_PAINT`.
   */
  const ringPaint = useMemo<CircleProps["paint"]>(
    () => ({
      "circle-radius": [
        "interpolate", ["linear"], ["zoom"],
        8, ["case", ["==", ["get", "mine"], true], 5, 2.5],
        13, ["case", ["==", ["get", "mine"], true], 8, 4.5],
        17, ["case", ["==", ["get", "mine"], true], 10, 6],
      ],
      "circle-color": [
        "case",
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
  const endDotPaint = useMemo<CircleProps["paint"]>(
    () => ({
      "circle-radius": 8,
      "circle-color": ["match", ["get", "role"], "end", DEST_COLOR, accent.solid],
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
  const dot =
    model.kind === "train" && isLongDistance(model.product) ? DOT.longDistance! : DOT[model.kind] ?? DOT.train!;
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
      "circle-radius": plane ? 0 : DOT_RADIUS_PX,
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
            // Weit draußen das Flugzeug von oben, gedreht nach Kurs (nah: 3D-Ebene).
            "icon-image": "live-plane",
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
        <Layer id="live-stop-ring" type="circle" beforeId="live-veh-shadow" filter={IS_MID_STOP} paint={ringPaint} />
        <Layer id="live-stop-end-ring" type="circle" beforeId="live-veh-shadow" filter={IS_END_STOP} paint={END_RING_PAINT} />
        <Layer id="live-stop-end-dot" type="circle" beforeId="live-veh-shadow" filter={IS_END_STOP} paint={endDotPaint} />
        <Layer id="live-stop-label" type="symbol" layout={labelLayout} paint={labelPaint} />
      </GeoJSONSource>
    ),
    [stopsJson, ringPaint, endDotPaint, labelLayout, labelPaint],
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
