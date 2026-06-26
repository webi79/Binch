import { ReactNode, forwardRef, memo, useImperativeHandle, useRef } from "react";
import { StyleSheet, type NativeSyntheticEvent } from "react-native";
import { Map, Camera, Images, type CameraRef } from "@maplibre/maplibre-react-native";
import { USER_LOC } from "@/lib/surroundings/mockData";
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
}

/**
 * Karte basierend auf MapLibre Native + OpenFreeMap-Tiles (kostenlos,
 * kein API-Key, OSM-Daten). Dark-Theme via inline Style JSON
 * (siehe `mapStyle.ts`).
 */
const MapSurfaceInner = forwardRef<MapSurfaceHandle, Props>(function MapSurface(
  { children, onRegionChange, onMapRendered },
  ref,
) {
  const cameraRef = useRef<CameraRef>(null);
  const renderedFiredRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (latitude, longitude, zoom = 13) => {
        cameraRef.current?.flyTo({
          center: [longitude, latitude],
          zoom,
          duration: 600,
        });
      },
      fitBounds: (sw, ne, paddingPx = 60) => {
        cameraRef.current?.fitBounds(
          // MapLibre erwartet [west, south, east, north]
          [sw[0], sw[1], ne[0], ne[1]],
          {
            padding: { top: paddingPx, bottom: paddingPx, left: paddingPx, right: paddingPx },
            duration: 800,
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
        if (renderedFiredRef.current) return;
        renderedFiredRef.current = true;
        onMapRendered?.();
      }}
    >
      <Camera
        ref={cameraRef}
        initialViewState={{
          center: [USER_LOC.longitude, USER_LOC.latitude],
          zoom: 13,
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
