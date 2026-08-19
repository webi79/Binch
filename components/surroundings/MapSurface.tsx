import { ReactNode, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import { StyleSheet, type NativeSyntheticEvent } from "react-native";
import { Map, Camera, Images, type CameraRef } from "@maplibre/maplibre-react-native";
import { DARK_MAP_STYLE } from "./mapStyle";

/**
 * Marker-Icons — pro Marker-Typ direkt in seiner Zielfarbe gerendert
 * (kein SDF/Tinting nötig). PNGs werden via
 * `server/scripts/build-marker-icons.mjs` aus Lucide-SVG generiert.
 */
const MARKER_ICONS = {
  "marker-train": require("@/assets/marker-icons/train.png"),
  "marker-bus": require("@/assets/marker-icons/bus.png"),
  "marker-tram": require("@/assets/marker-icons/tram.png"),
  "marker-airport": require("@/assets/marker-icons/airport.png"),
  "marker-cruise": require("@/assets/marker-icons/cruise.png"),
  // Pillen-Hintergründe für Multi-Mode-Marker (weißer abgerundeter Container,
  // dunkle Outline). Die einzelnen farbigen Mode-Kreise sitzen INSIDE der Pille.
  "marker-pill-2": require("@/assets/marker-icons/pill-2.png"),
  "marker-pill-3": require("@/assets/marker-icons/pill-3.png"),
  // Badge-Sprites: kleine farbige Kreise pro Mode. Werden als Hintergrund-
  // Symbole für die einzelnen Slots in der Multi-Mode-Pille gerendert.
  // Müssen Symbole sein, weil circle-translate in MapLibre nicht data-driven
  // ist (für Multi-Slot-Positionierung brauchen wir icon-offset).
  "marker-badge-train": require("@/assets/marker-icons/badge-train.png"),
  "marker-badge-subway": require("@/assets/marker-icons/badge-subway.png"),
  "marker-badge-bus": require("@/assets/marker-icons/badge-bus.png"),
  "marker-badge-tram": require("@/assets/marker-icons/badge-tram.png"),
  "marker-badge-ferry": require("@/assets/marker-icons/badge-ferry.png"),
};

export interface RegionInfo {
  /** Mitte des sichtbaren Viewports (lat/lng). */
  latitude: number;
  longitude: number;
  /** Sichtbares Bounding-Box: [west, south, east, north] */
  bounds: [number, number, number, number];
  /** Aktuelles Zoom-Level (typisch 0..22). */
  zoom: number;
}

interface RegionChangeEvent {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bounds: [number, number, number, number];
  animated: boolean;
  userInteraction: boolean;
}

export type MapLayerType = "standard" | "satellite" | "hybrid";

export interface MapSurfaceHandle {
  /**
   * „Fertig gerendert" wieder scharf stellen — nach einem Einfrieren.
   *
   * Der Aufrufer weiß als Einziger, wann eingefroren wird; das Bauteil kann es
   * nicht erfahren, weil `react-freeze` seine Durchgänge verwirft. Siehe
   * `rearm` weiter unten.
   */
  rearm: () => void;
  /** Map auf eine Koordinate (lat/lng) zentrieren mit gewünschtem Zoom. */
  flyTo: (latitude: number, longitude: number, zoom?: number) => void;
  /** Map auf ein Bounding-Box zoomen (für Route-Übersicht). */
  fitBounds: (
    sw: [number, number],
    ne: [number, number],
    paddingPx?: number,
  ) => void;
}

interface Props {
  children?: ReactNode;
  /** Reserved für späteren Layer-Toggle (Satellit). Aktuell ignoriert. */
  mapType?: MapLayerType;
  /** Reserved (Traffic-Overlay nicht in OpenFreeMap-Tiles enthalten). */
  showsTraffic?: boolean;
  /** Callback wenn der User aufhört zu pannen/zoomen — gibt die neue Region. */
  onRegionChange?: (region: RegionInfo) => void;
  /** Wird einmal aufgerufen wenn die initialen Tiles tatsächlich gerendert
   *  sind. Vor diesem Event zeigt die Surface ggf. nur leere Tiles —
   *  Parent kann ein Skelett darüber halten bis das echte Bild da ist. */
  onMapRendered?: () => void;
  /**
   * Wo die Kamera STARTET.
   *
   * Hier stand fest verdrahtet Berlin Hbf. Der Bildschirm darüber wartet
   * eigens auf die Ortung, bevor er die Karte einhängt, mit der ausdrücklichen
   * Begründung „`initialViewState` bekommt die Nutzerkoordinate" — bekam es
   * aber nie. Die Karte startete also für JEDEN Nutzer in Berlin, lud dort
   * einen Kachelsatz und wurde erst danach per Flug an die richtige Stelle
   * geschoben. Genau der Ablauf, den der Kommentar verhindern wollte.
   */
  initialCenter?: { latitude: number; longitude: number };
}

/**
 * Karte basierend auf MapLibre Native + OpenFreeMap-Tiles (kostenlos,
 * kein API-Key, OSM-Daten). Dark-Theme via inline Style JSON
 * (siehe `mapStyle.ts`).
 */
const MapSurfaceInner = forwardRef<MapSurfaceHandle, Props>(function MapSurface(
  { children, onRegionChange, onMapRendered, initialCenter },
  ref,
) {
  const cameraRef = useRef<CameraRef>(null);
  const renderedFiredRef = useRef(false);
  /** Frist des schwächeren Signals — siehe `onDidFinishRenderingMap` unten. */
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onMapRenderedRef = useRef(onMapRendered);
  onMapRenderedRef.current = onMapRendered;
  /**
   * Den Riegel wieder scharf stellen — über die Steuerung, nicht über ein Prop.
   *
   * Der Aufrufer holt das Skelett zurück, wenn eingefroren wird (die GL-Fläche
   * stirbt dabei). Beim Auftauen meldet MapLibre erneut „fertig" — aber der
   * Riegel unten ist pro AUFBAU einmalig, und `react-freeze` baut nichts ab.
   * Ohne diese Zeile bliebe das Skelett bis zur Notbremse liegen, also volle
   * vier Sekunden über einer längst gemalten Karte.
   *
   * Als Prop ginge es nicht: Solange eingefroren ist, verwirft `react-freeze`
   * jeden Durchgang des Unterbaums, ein neues Prop käme also nie an. Die
   * Steuerung erreicht die Instanz trotzdem.
   */
  const rearm = useCallback(() => {
    renderedFiredRef.current = false;
    if (fallbackRef.current) {
      clearTimeout(fallbackRef.current);
      fallbackRef.current = null;
    }
  }, []);

  const markRendered = useCallback(() => {
    if (renderedFiredRef.current) return;
    renderedFiredRef.current = true;
    if (fallbackRef.current) {
      clearTimeout(fallbackRef.current);
      // Und die Merkstelle leeren, sonst hält der Wächter in
      // `onDidFinishRenderingMap` unten für immer eine tote Kennung fest und
      // lässt nie wieder eine Frist zu.
      fallbackRef.current = null;
    }
    onMapRenderedRef.current?.();
  }, []);
  /**
   * Letzte Notbremse: Kommt gar kein Signal, geben wir nach vier Sekunden frei.
   *
   * `markRendered` hing vorher über `onMapRendered` an einer Pfeilfunktion, die
   * der Aufrufer bei jedem Render neu anlegt — der Zeitgeber wurde also bei
   * jedem Render abgeräumt und neu gestartet und griff ausgerechnet im
   * Zappel-Fall nie, für den er gedacht ist. Über einen Ref hängt er an nichts
   * mehr.
   */
  /**
   * Letzte Notbremse: Kommt gar kein Signal, geben wir nach vier Sekunden frei.
   *
   * Der Riegel darüber bleibt einwegs — dieses Bauteil meldet pro Aufbau
   * genau einmal. Ob die Meldung ZÄHLT, entscheidet der Aufrufer: Nur er weiß,
   * ob die Fläche gerade eingefroren ist, und nur er kann es wissen. Ein
   * `paused`-Prop wäre hier wirkungslos gewesen — `react-freeze` verwirft genau
   * den Durchgang, der es liefern würde, das Kind behält also seine alten
   * Eigenschaften. Die Entscheidung gehört deshalb nach oben.
   */
  useEffect(() => {
    const id = setTimeout(markRendered, 4000);
    return () => {
      clearTimeout(id);
      if (fallbackRef.current) {
        clearTimeout(fallbackRef.current);
        fallbackRef.current = null;
      }
    };
  }, [markRendered]);

  useImperativeHandle(
    ref,
    () => ({
      rearm,
      flyTo: (latitude, longitude, zoom = 13) => {
        cameraRef.current?.flyTo({
          center: [longitude, latitude],
          zoom,
          duration: 600,
          /**
           * `ease` statt der Vorgabe `fly`.
           *
           * `flyTo` setzt in der Bibliothek von sich aus `easing: "fly"`, und
           * das ist auf Android die van-Wijk-Flugbahn: erst herauszoomen, quer
           * hinüber, wieder hineinzoomen. Unterwegs lädt die Karte JEDE
           * Zwischenstufe der Kachel-Pyramide — bei einem Sprung über mehrere
           * Zoomstufen ein Vielfaches dessen, was am Ziel gebraucht wird.
           * `ease` interpoliert linear, ohne Zoom-Ausflug.
           */
          easing: "ease",
        });
      },
      fitBounds: (sw, ne, paddingPx = 60) => {
        cameraRef.current?.fitBounds(
          // MapLibre erwartet [west, south, east, north]
          [sw[0], sw[1], ne[0], ne[1]],
          {
            padding: { top: paddingPx, bottom: paddingPx, left: paddingPx, right: paddingPx },
            duration: 800,
            easing: "ease",
          },
        );
      },
    }),
    [],
  );

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={DARK_MAP_STYLE}
      compass={false}
      attribution
      logo={false}
      onRegionDidChange={(e: NativeSyntheticEvent<RegionChangeEvent>) => {
        if (!onRegionChange) return;
        const v = e.nativeEvent;
        onRegionChange({
          latitude: v.center[1],
          longitude: v.center[0],
          bounds: v.bounds,
          zoom: v.zoom,
        });
      }}
      onDidFinishRenderingMapFully={() => {
        // Feuert wenn alle sichtbaren Tiles geladen + die Karte einmal
        // vollständig gepaintet ist. Nur einmal aufrufen — danach feuert
        // das Event bei jedem Pan/Zoom erneut.
        markRendered();
      }}
      /**
       * Zweites, SCHWÄCHERES Signal — und es darf das Skelett nicht sofort
       * wegnehmen.
       *
       * Nativ sind das zwei verschiedene Ereignisse (MLRNMapView.kt: `if (fully)
       * … else …`). Das Nicht-Fully feuert beim ERSTEN gemalten Bild — da liegt
       * nur die Hintergrund-Ebene des Stils auf dem Schirm, keine einzige
       * Kachel. Es hier direkt durchzureichen hieß: Das Skelett verschwindet
       * nach 280ms, und der Nutzer schaut den Kacheln beim Eintrudeln zu. Bei
       * gemessenen 0,3 bis 4,7 Sekunden pro Kachelsatz sind das mehrere Sekunden
       * dunkle Fläche. An der Netzzeit hat sich dabei nichts geändert — nur die
       * Enthüllung. Genau das ist die „auf einmal lädt die Karte so langsam".
       *
       * Gebraucht wird es trotzdem: Ohne Netz oder bei nicht erreichbarem
       * Kachel-Server kommt NUR dieses Ereignis, und das Skelett bliebe sonst
       * für immer liegen. Also als Ausweg mit Frist — kommt in 2 Sekunden kein
       * „Fully", gibt es frei.
       */
      onDidFinishRenderingMap={() => {
        if (fallbackRef.current) return;
        fallbackRef.current = setTimeout(markRendered, 2000);
      }}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{
          // Ohne bekannten Standort bleibt es bei einem weit herausgezoomten
          // Blick statt bei einer fremden Stadt: Das ist ehrlicher als ein Ort,
          // an dem der Nutzer nicht ist, und lädt keinen Kachelsatz, den
          // niemand braucht.
          center: initialCenter
            ? [initialCenter.longitude, initialCenter.latitude]
            : [0, 20],
          zoom: initialCenter ? 13 : 1,
        }}
      />
      <Images
        images={MARKER_ICONS}
        onImageMissing={(e) => {
          // Wird gefeuert wenn ein Layer `icon-image` referenziert das
          // nicht im Registry ist — sehr hilfreich zum Debuggen
          // (Metro-Cache, falsche Names, Timing-Issues).
          console.warn("[MapSurface] Missing icon image:", e.nativeEvent.image);
        }}
      />
      {children}
    </Map>
  );
});

export const MapSurface = memo(MapSurfaceInner);
