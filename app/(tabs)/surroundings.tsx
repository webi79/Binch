import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import {
  MapSurface,
  type MapLayerType,
  type MapSurfaceHandle,
  type RegionInfo,
} from "@/components/surroundings/MapSurface";
import { POIMarker, UserPin } from "@/components/surroundings/MapMarkers";
import { MarkerLayer } from "@/components/surroundings/MarkerLayer";
import { openStopSheet } from "@/components/surroundings/stopSheetAnimation";
import { RouteLayer } from "@/components/surroundings/RouteLayer";
import { RouteBanner } from "@/components/surroundings/RouteBanner";
import { MapFabs } from "@/components/surroundings/MapFabs";
import { SurroundingsSheet } from "@/components/surroundings/SurroundingsSheet";
import { SearchBar } from "@/components/SearchBar";
import { LocationPicker } from "@/components/search/LocationPicker";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";
import { useT } from "@/lib/i18n/useT";
import type { Location } from "@/types/search";
import { useSearchStore } from "@/stores/searchStore";
import {
  POIS,
  markersForMode,
  listForMode,
  distanceMeters,
  type SheetMode,
  type MapMarker,
  type StopListItem,
} from "@/lib/surroundings/mockData";
import { useUserLocation } from "@/lib/surroundings/useUserLocation";
import { AIRPORT_PINS } from "@/lib/surroundings/airportCoords";
import { CRUISE_PORT_PINS } from "@/lib/surroundings/cruisePortCoords";
import { fetchSurroundings } from "@/lib/api/client";

/** Viewport-Daten die wir an /api/surroundings schicken. */
interface Viewport {
  latitude: number;
  longitude: number;
  /** Suchradius in Metern — abgeleitet aus den Map-Bounds. */
  distance: number;
  zoom: number;
}

const DEFAULT_VIEWPORT_DISTANCE = 2000;
const DEFAULT_ZOOM = 13;

/** Berechnet eine großzügige BBox aus Viewport-Center + Distanz. Faktor 2.5
 *  damit Marker am Rand schon gerendert sind wenn der User wischt — kein
 *  Pop-In an der Map-Kante. */
function computeBufferedBbox(v: Viewport): [number, number, number, number] {
  const radiusM = Math.max(v.distance, 1000) * 2.5;
  const dLat = radiusM / 111_000;
  const dLng = radiusM / (111_000 * Math.max(Math.cos((v.latitude * Math.PI) / 180), 0.01));
  return [v.longitude - dLng, v.latitude - dLat, v.longitude + dLng, v.latitude + dLat];
}

/**
 * Versucht eine geographische Position für eine User-Auswahl im
 * LocationPicker zu finden:
 *   1. Server-Live-Quellen liefern lat/lng direkt mit (db-rest Stationen).
 *   2. Flughäfen (Type FLIGHT) → IATA-Code in AIRPORT_PINS nachschlagen.
 *   3. Kreuzfahrt-Häfen (Type CRUISE) → CRUISE_PORT_PINS nachschlagen.
 *   4. Sonst undefined — kein Fly-To.
 */
function resolveLocationCoord(loc: Location): { latitude: number; longitude: number } | null {
  if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
    return { latitude: loc.latitude, longitude: loc.longitude };
  }
  if (loc.type === "FLIGHT") {
    const hit = AIRPORT_PINS.find((p) => p.iata === loc.code);
    if (hit) return hit.coord;
  }
  if (loc.type === "CRUISE") {
    const hit = CRUISE_PORT_PINS.find((p) => p.code === loc.code);
    if (hit) return hit.coord;
  }
  return null;
}

export default function SurroundingsScreen() {
  const t = useT();
  const [mode, setMode] = useState<SheetMode>("transit");
  const [mapType, setMapType] = useState<MapLayerType>("standard");
  const [trafficOn, setTrafficOn] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapSurfaceHandle | null>(null);
  const { coord: userCoord, status: locationStatus, refresh: refreshLocation } = useUserLocation();

  const pendingRoute = useSearchStore((s) => s.pendingRoute);
  const clearRoute = useSearchStore((s) => s.clearRoute);
  const routeActive = pendingRoute !== null && pendingRoute.waypoints.length >= 2;

  const [viewport, setViewport] = useState<Viewport | null>(null);

  // StopDetailSheet wird global in app/_layout.tsx gerendert (damit's ÜBER
  // der FloatingTabBar liegt). Wir setzen hier nur den Store-State beim
  // Marker-Tap.
  const selectStop = useSearchStore((s) => s.selectStop);

  // MapSurface erst nach dem ersten Focus des Tabs mounten — UND erst
  // ~280 ms später, damit die Pop-in-Spring der FloatingTabBar
  // ungestört durchläuft bevor MapLibre mit GL-Init / Tile-Loading
  // anfängt. Sobald `mapReady = true` ist, bleibt's true (Tab-Wechsel
  // weg + zurück hat keine Wiederholung der Wartezeit).
  //
  // Visueller Effekt: Tab-Switch ist instant, dann fadet die Karte ein
  // (FadeIn 220 ms) → User sieht zuerst sauber die Surroundings-UI,
  // danach die Karte „einblenden" statt sie mit Stutter mit-zu-rendern.
  const isFocused = useIsFocused();
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (!isFocused || mapReady) return;
    const t = setTimeout(() => setMapReady(true), 280);
    return () => clearTimeout(t);
  }, [isFocused, mapReady]);

  // Tab-Tap soll sich sofort anfühlen. Marker-Swap (100+ native Views) ist
  // teuer und blockt sonst den Tap. useDeferredValue rendert die Marker
  // verzögert nach, während die Tab-UI sofort umspringt.
  const deferredMode = useDeferredValue(mode);

  // Effektiver Viewport für Backend-Calls — vor dem ersten Map-Idle-Event
  // nutzen wir den User-Standort als Default.
  const effectiveViewport: Viewport = viewport ?? {
    latitude: userCoord.latitude,
    longitude: userCoord.longitude,
    distance: DEFAULT_VIEWPORT_DISTANCE,
    zoom: DEFAULT_ZOOM,
  };

  // Query-Key in grobe Buckets runden — Center auf ~500 m, Distanz auf 1 km.
  // Damit triggern kleine Pans (User wischt durch die Karte) keinen Refetch
  // mehr; erst nach signifikanter Bewegung kommt frische Daten.
  const keyLat = Math.round(effectiveViewport.latitude * 200) / 200; // ~500m
  const keyLng = Math.round(effectiveViewport.longitude * 200) / 200;
  const keyDistance = Math.round(effectiveViewport.distance / 1000) * 1000;
  const keyZoom = Math.round(effectiveViewport.zoom);

  // Zoom-abhängiges Marker-Limit: bei rausgezoomter Karte wollen wir viele
  // Train-Stationen für Clustering; unter zoom 9 zeigt der Server eh nichts.
  const zoomLimit = keyZoom >= 13 ? 60 : keyZoom >= 11 ? 200 : 400;

  const { data } = useQuery({
    queryKey: ["surroundings", deferredMode, keyLat, keyLng, keyDistance, keyZoom],
    queryFn: () =>
      fetchSurroundings({
        latitude: keyLat,
        longitude: keyLng,
        distance: Math.max(500, keyDistance),
        zoom: keyZoom,
        limit: zoomLimit,
        mode: deferredMode,
      }),
    staleTime: 60_000,
    enabled: deferredMode === "transit",
    retry: 1,
    placeholderData: (prev) => prev,
  });

  // Wichtig: API-Daten nur im Transit-Mode verwenden. In Airport/Cruise-Mode
  // ist die Query disabled, aber `placeholderData: (prev) => prev` kann
  // sonst die alten Transit-Daten zurückgeben → falsche Marker werden gerendert.
  // Wenn die Transit-Antwort leer ist (z.B. zoom < 9), bleibt die Liste leer —
  // NICHT auf TRANSIT_MOCK zurückfallen, sonst klebt der Mock-Cluster ewig auf
  // der rausgezoomten Karte.
  const markers: MapMarker[] = useMemo(() => {
    if (deferredMode === "transit") {
      if (!data) return [];
      return data.markers.map((m) => ({
        id: m.id,
        type: m.type,
        kinds: m.kinds,
        coord: { latitude: m.latitude, longitude: m.longitude },
        label: m.label,
        selected: m.selected,
      }));
    }
    // Airport/Cruise sind weltweit (3k+ Pins). Wir geben ALLES an MarkerLayer
    // weiter — der Layer clustered die Features serverseitig im MapLibre-
    // Native-Layer (sehr effizient, alles auf der UI-Thread). Beim Rauszoomen
    // entstehen sinnvolle weltumspannende Cluster („London 12", „NYC 8" etc.),
    // beim Zoom-In lösen die Cluster sich auf in individuelle Pins.
    return markersForMode(deferredMode);
  }, [data, deferredMode]);

  const listItems: StopListItem[] = useMemo(() => {
    if (mode === "transit") {
      if (!data) return [];
      return data.list.map((l) => ({
        id: l.id,
        name: l.name,
        kinds: l.kinds,
        distance: l.distance,
        lines: l.lines,
        selected: l.selected,
      }));
    }
    return listForMode(mode, userCoord);
  }, [data, mode, userCoord]);

  // Beim ersten GPS-Fix auf den Standort fliegen — Zoom je nach Modus.
  // Wird übersprungen wenn eine Route aktiv ist (dann fitten wir auf die Route).
  // Wichtig: NICHT fliegen solange `locationStatus === "loading"`. Sonst
  // landet der User zuerst auf der Default-Coord (Berlin Hbf) und springt
  // erst nach Auflösung des echten GPS-Fixes an seine wahre Position.
  useEffect(() => {
    if (routeActive) return;
    if (locationStatus === "loading") return;
    const zoom = mode === "transit" ? 13 : mode === "airport" ? 5 : 4;
    mapRef.current?.flyTo(userCoord.latitude, userCoord.longitude, zoom);
  }, [userCoord.latitude, userCoord.longitude, routeActive, locationStatus]);

  // Wenn eine Route gesetzt wird → Bounds berechnen und Karte darauf fitten.
  useEffect(() => {
    if (!routeActive || !mapReady) return;
    const pts = pendingRoute!.waypoints;
    let minLat = pts[0].latitude, maxLat = pts[0].latitude;
    let minLng = pts[0].longitude, maxLng = pts[0].longitude;
    for (const p of pts) {
      if (p.latitude < minLat) minLat = p.latitude;
      if (p.latitude > maxLat) maxLat = p.latitude;
      if (p.longitude < minLng) minLng = p.longitude;
      if (p.longitude > maxLng) maxLng = p.longitude;
    }
    mapRef.current?.fitBounds([minLng, minLat], [maxLng, maxLat], 80);
  }, [routeActive, mapReady, pendingRoute]);

  // Tab-Switch: Zoom anpassen so dass der User die Marker sieht.
  //   - transit: nah ran (Zoom 13, Bushaltestellen-Distanz)
  //   - airport: regional (Zoom 5, Europa-Hubs sichtbar)
  //   - cruise: weiter raus (Zoom 4, Häfen über Kontinent verteilt)
  const handleModeChange = useCallback(
    (m: SheetMode) => {
      setMode(m);
      const zoom = m === "transit" ? 13 : m === "airport" ? 5 : 4;
      mapRef.current?.flyTo(userCoord.latitude, userCoord.longitude, zoom);
    },
    [userCoord.latitude, userCoord.longitude],
  );

  const onLocate = useCallback(async () => {
    await refreshLocation();
    mapRef.current?.flyTo(userCoord.latitude, userCoord.longitude, 14);
  }, [userCoord.latitude, userCoord.longitude, refreshLocation]);

  const onToggleLayers = useCallback(() => {
    setMapType((t) => (t === "standard" ? "satellite" : "standard"));
  }, []);

  const onToggleTraffic = useCallback(() => {
    setTrafficOn((v) => !v);
  }, []);

  /**
   * Wird nach Pan/Zoom-Ende getriggert. Aus den Map-Bounds berechnen wir den
   * Such-Radius (Center → NE-Ecke = halbe Diagonale in Metern). Den geben wir
   * zusammen mit dem Zoom-Level ans Backend, das daraus passend filtert.
   */
  const onRegionChange = useCallback((r: RegionInfo) => {
    const [, , east, north] = r.bounds;
    const radius = distanceMeters(
      { latitude: r.latitude, longitude: r.longitude },
      { latitude: north, longitude: east },
    );
    // Distanz-Cap zoom-abhängig: Stadt-Zoom (13+) eng, Train-only-Bereich
    // (zoom 9-12) etwas weiter für Clustering. Unter zoom 9 zeigen wir eh
    // nichts mehr (siehe typesForZoom), also kein größerer Cap nötig.
    const cap = r.zoom >= 13 ? 20_000 : r.zoom >= 11 ? 50_000 : 120_000;
    setViewport({
      latitude: r.latitude,
      longitude: r.longitude,
      distance: Math.min(cap, Math.max(200, Math.round(radius))),
      zoom: r.zoom,
    });
  }, []);

  return (
    <View style={styles.root}>
      {mapReady && (
        <Animated.View
          style={StyleSheet.absoluteFill}
          entering={FadeIn.duration(220)}
        >
        <MapSurface
          ref={mapRef}
          mapType={mapType}
          showsTraffic={trafficOn}
          onRegionChange={onRegionChange}
        >
          {/* Route-Modus: nur RouteLayer + UserPin, sonst MarkerLayer + POIs */}
          {routeActive ? (
            <RouteLayer
              waypoints={pendingRoute!.waypoints}
              legs={pendingRoute!.legs}
              mode={pendingRoute!.mode}
            />
          ) : (
            <>
              {deferredMode === "transit" &&
                POIS.map((p, i) => <POIMarker key={`p${i}`} id={`p${i}`} p={p} />)}
              <MarkerLayer
                key={deferredMode}
                markers={markers}
                onMarkerPress={(id) => {
                  const m = markers.find((mm) => mm.id === id);
                  if (!m) return;
                  openStopSheet();
                  const dist = distanceMeters(userCoord, m.coord);
                  selectStop({
                    code: m.id,
                    label: m.label ?? "",
                    distanceMeters: Math.round(dist),
                    kinds: m.kinds && m.kinds.length > 0 ? m.kinds : [m.type],
                  });
                }}
              />
            </>
          )}
          <UserPin coord={userCoord} />
        </MapSurface>
        </Animated.View>
      )}

      {routeActive ? (
        <RouteBanner
          title={pendingRoute!.title ?? "Route"}
          waypointCount={pendingRoute!.waypoints.length}
          onBack={() => {
            // 1. Navigation SOFORT auslösen — fühlt sich snappy an.
            //    Bevorzugt: zurück zum exakten Pfad + Params, von dem aus
            //    die Route geöffnet wurde (z.B. /search/results mit den
            //    origin/destination/date-Params, sonst landet man auf einem
            //    leeren Results-Screen ohne Search-Kontext).
            const target = pendingRoute!.previousHref;
            if (target) {
              router.replace({ pathname: target.pathname, params: target.params } as never);
            } else if (router.canGoBack()) {
              router.back();
            }
            // 2. clearRoute DEFERRED — der Map-Reset (Routen-Layer entfernen,
            //    Marker neu mounten, Zoom zurück) würde sonst gleichzeitig mit
            //    der Nav-Animation laufen und sichtbar ruckeln.
            setTimeout(() => clearRoute(), 400);
          }}
          topInset={insets.top}
        />
      ) : (
        <View
          style={[styles.searchWrap, { top: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <SearchBar
            placeholderKey="surroundings.search.placeholder"
            showMic={false}
            onPress={() => setPickerOpen(true)}
          />
        </View>
      )}

      <LocationPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(loc: Location) => {
          setPickerOpen(false);
          // Mode an den Treffer-Typ anpassen, damit das passende Marker-Icon
          // an der Zielposition sichtbar ist (sonst springt die Map zwar
          // hin, der User sieht aber das falsche Layer).
          const nextMode: SheetMode =
            loc.type === "FLIGHT"
              ? "airport"
              : loc.type === "CRUISE"
                ? "cruise"
                : "transit";
          if (nextMode !== mode) setMode(nextMode);
          const coord = resolveLocationCoord(loc);
          if (!coord) return;
          // Zoom-Level je nach Treffer-Typ: bei Flughäfen weiter raus
          // (man will den Hub und Umgebung sehen), bei Bahnhof/Bushaltestelle
          // näher dran (Stadt-Detail), bei Häfen mittel.
          const zoom =
            loc.type === "FLIGHT" ? 11 : loc.type === "CRUISE" ? 12 : 14;
          mapRef.current?.flyTo(coord.latitude, coord.longitude, zoom);
        }}
        mode="ALL"
        title={t("surroundings.search.title")}
        leadingLabel=""
        placeholderKey="surroundings.search.placeholder"
        suggested={POPULAR_LOCATIONS.ALL}
      />


      <MapFabs
        topInset={insets.top}
        satelliteOn={mapType !== "standard"}
        trafficOn={trafficOn}
        onToggleLayers={onToggleLayers}
        onToggleTraffic={onToggleTraffic}
        onLocate={onLocate}
      />

      {!routeActive && (
        <SurroundingsSheet mode={mode} setMode={handleModeChange} items={listItems} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#14181A",
  },
  searchWrap: {
    position: "absolute",
    left: 16,
    right: 16,
    zIndex: 30,
  },
});
