import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { preloadLocationPicker } from "@/lib/nav/pickerPreload";
import { PICKER_IN, SHEET_IN, SHEET_OUT } from "@/lib/nav/overlayCover";
import {
  View,
  StyleSheet,
  BackHandler,
  useWindowDimensions,
  type LayoutChangeEvent,
  type GestureResponderEvent,
} from "react-native";
import Animated, {
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { Freeze } from "react-freeze";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import {
  MapSurface,
  type MapSurfaceHandle,
  type RegionInfo,
  type MapCityPress,
  type CameraPadding,
} from "@/components/surroundings/MapSurface";
import {
  isMapMoving,
  setMapMoving,
  sheetTargets,
  subscribeViewport,
  whenMapQuiet,
} from "@/lib/surroundings/mapViewport";
import { UserPin } from "@/components/surroundings/MapMarkers";
import { MarkerLayer } from "@/components/surroundings/MarkerLayer";
import { MapTypeSheet } from "@/components/surroundings/MapTypeSheet";
import { Buildings3DLayer } from "@/components/surroundings/Buildings3DLayer";
import { EsriImageryLayer } from "@/components/surroundings/EsriImageryLayer";
import { refreshEsriImagery, useEsriImagery } from "@/lib/imagery/esriImagery";
import { haptic } from "@/lib/haptics";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { openStopSheet, stopSheetSnap } from "@/components/surroundings/stopSheetAnimation";
import { CityRouteLayers } from "@/components/surroundings/CityRouteLayers";
import { WalkPathLayer } from "@/components/surroundings/WalkPathLayer";
import { RouteLayer } from "@/components/surroundings/RouteLayer";
import { LiveVehicleLayer } from "@/components/live/LiveVehicleLayer";
import { LiveOverlay } from "@/components/live/LiveOverlay";
import { useAppActive, useLiveModel } from "@/lib/live/useLiveModel";
import { PLANE_MAX_ZOOM } from "@/lib/live/camera";
import { createZoomTrack } from "@/lib/live/zoomTrack";
import { probeFrames, probeMark } from "@/lib/live/probe";
import { RouteBanner } from "@/components/surroundings/RouteBanner";
import { LocateFab, MapFabs } from "@/components/surroundings/MapFabs";
import { CitySearchMorph, SEARCH_BAR_BARE } from "@/components/surroundings/CitySearchMorph";
import { MapSkeleton } from "@/components/surroundings/MapSkeleton";
import { SurroundingsSheet } from "@/components/surroundings/SurroundingsSheet";
import { SearchBar } from "@/components/SearchBar";
import { POPULAR_LOCATIONS } from "@/lib/data/popularLocations";
import { useT } from "@/lib/i18n/useT";
import type { Location } from "@/types/search";
import { useSearchStore } from "@/stores/searchStore";
import {
  markersForMode,
  listForMode,
  distanceMeters,
  type SheetMode,
  type MapMarker,
  type StopListItem,
} from "@/lib/surroundings/mockData";
import { useUserLocation } from "@/lib/surroundings/useUserLocation";
import { setDeviceHeadingActive } from "@/lib/surroundings/useDeviceHeading";
import {
  HIDE_AT,
  HIDE_VELOCITY,
  chromeShift,
  isMapChromeHidden,
  markMapChromeHidden,
  maxTravel,
  settle,
  showMapChrome,
  travelSearch,
} from "@/lib/surroundings/mapChrome";
import { AIRPORT_PINS } from "@/lib/surroundings/airportCoords";
import { CRUISE_PORT_PINS } from "@/lib/surroundings/cruisePortCoords";
import { fetchAerialCoverage, fetchSurroundings } from "@/lib/api/client";
import { ms, scaledStyles } from "@/lib/ui/compact";
import { SPACE } from "@/lib/theme/spacing";
import { TAB_BAR_H } from "@/components/ui/BinchTabBar";

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

/** Ruhe-Fenster, das ein Tab-Tipp braucht, bevor die Karte einfrieren darf. */

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

/**
 * Die Zoom-STUFEN, die der Server wirklich unterscheidet — und nur die gehören
 * in den Abfrage-Schlüssel.
 *
 * DAS WAR EINE ECHTE RUCKLER-QUELLE: Bisher stand der gerundete Zoom im
 * Schlüssel, also 14, 15, 16, 17, 18 — fünf verschiedene Abfragen für denselben
 * Fleck. Wer von der Stadtansicht bis auf die Hausnummer hineinzoomt,
 * überquert vier Ganzzahl-Grenzen, und jede löste eine Abfrage aus, deren
 * Antwort die komplette Nadel-Quelle der Karte ersetzt (samt Neuaufbau des
 * Cluster-Index). Das passierte MITTEN in der Zoom-Geste, also genau dann, wenn
 * jedes Bild zählt. Und es wurde mit jeder weiteren Zoomstufe wieder fällig —
 * „schlimmer, je weiter ich hineinzoome".
 *
 * Der Server unterscheidet aber gar nicht fünf Stufen, sondern vier Bereiche
 * (`typesForZoom` und `limitForZoom` in `routes/surroundings.ts`): ab 13
 * Bahn+Bus, ab 11 nur Bahn mit mehr Treffern fürs Clustern, ab 9 dasselbe mit
 * noch mehr, darunter gar nichts. Innerhalb eines Bereichs ist die Antwort für
 * denselben Ort IDENTISCH — die Abfragen dazwischen waren also nicht nur teuer,
 * sie waren umsonst.
 *
 * Geschickt wird die untere Kante des Bereichs. Damit bekommt der Server
 * denselben Wert, den er ohnehin zu einem Bereich zusammenfasst.
 */
function zoomBand(zoom: number): number {
  if (zoom >= 13) return 13;
  if (zoom >= 11) return 11;
  if (zoom >= 9) return 9;
  return 0;
}

/**
 * So lange muss die Karte stillstehen, bevor die Umgebung neu abgefragt wird —
 * siehe `onRegionChange`. Länger als eine Pause beim Hin- und Herwischen (die
 * gemessenen Lücken lagen bei 60 bis 360 ms), kurz genug, dass die Liste nach
 * dem Loslassen spürbar sofort nachzieht.
 */
const VIEWPORT_SETTLE_MS = 600;

export default function SurroundingsScreen() {
  const t = useT();
  const [mode, setMode] = useState<SheetMode>("transit");
  /** Steht das Kartentyp-Blatt offen? */
  const [mapTypeOpen, setMapTypeOpen] = useState(false);
  /**
   * Drehung und Neigung der Karte — Bild für Bild, für den Kompass.
   *
   * Hier stand ein Zustand „steht die Karte schief?", gesetzt am ENDE jeder
   * Bewegung. Damit konnte sich der Kompass nicht mitdrehen, und er erschien
   * erst, wenn die Drehgeste vorbei war. Jetzt kommen die Werte aus jedem
   * Kamerabild (`onCameraFrame`), und zwar als animierte Werte: Der Kompass
   * liest sie auf dem UI-Strang, und dieser Bildschirm rendert dafür kein
   * einziges Mal — auch nicht beim Erscheinen und Verschwinden des Knopfes,
   * das entscheidet `MapFabs` selbst.
   */
  /** Der noch wartende Ausschnitt — siehe `VIEWPORT_SETTLE_MS` in `onRegionChange`. */
  const pendingViewportRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingViewport = useCallback(() => {
    if (pendingViewportRef.current) {
      clearTimeout(pendingViewportRef.current);
      pendingViewportRef.current = null;
    }
  }, []);
  useEffect(() => clearPendingViewport, [clearPendingViewport]);
  /**
   * Liegt gerade ein Finger auf der Karte? Dann ist eine beginnende Bewegung
   * die des Nutzers — und das Nachführen auf den Standort endet.
   *
   * Über die Berührung und nicht über die Meldung der Karte: Die zählt ihre
   * eigenen Kamerafahrten (`setStop`) ebenfalls als „Nutzer-Interaktion"
   * (`CameraChangeTracker.isUserInteraction` in MLRN) und taugt dafür nicht.
   */
  const mapTouchRef = useRef(false);
  /**
   * LIVE-ANSICHT — ein Fahrzeug verfolgen (Knopf an der Tafel-Zeile). Sie
   * übernimmt die Karte wie der Routen-Modus: keine Haltestellen, kein Blatt,
   * eigene Kamera (`LiveOverlay`). Als Ablage daneben, weil die Rückrufe der
   * Karte (Bewegung, Ausschnitt) sie lesen, ohne neu zu entstehen.
   */
  const liveSession = useSearchStore((s) => s.liveSession);
  const liveActive = liveSession != null;
  const liveActiveRef = useRef(liveActive);
  liveActiveRef.current = liveActive;
  /**
   * Der Zoom, für den das Live-Fahrzeug gebaut wird — die Karte meldet ihn
   * (immer, nicht nur live: Beim Start muss er schon stimmen), die Live-Kamera
   * kündigt ihre Fahrten an. Siehe `lib/live/zoomTrack.ts`.
   */
  const liveZoom = useMemo(() => createZoomTrack(15), []);
  /** Kennung der nativen Karte — die 3D-Ebene der Live-Ansicht hängt sich dort ein. */
  const liveNativeTag = useCallback(() => mapRef.current?.nativeTag() ?? null, []);
  const onMapTouchStart = useCallback(() => {
    mapTouchRef.current = true;
  }, []);
  const onMapTouchEnd = useCallback((e: GestureResponderEvent) => {
    // Erst, wenn der LETZTE Finger weg ist — `onTouchEnd` kommt je Finger, und
    // beim Zoomen mit zweien war die Karte sonst schon „losgelassen".
    if ((e.nativeEvent.touches?.length ?? 0) === 0) mapTouchRef.current = false;
  }, []);
  const onMapTouchCancel = useCallback(() => {
    mapTouchRef.current = false;
  }, []);
  const onMapCameraMoveStart = useCallback(() => {
    clearPendingViewport();
    setMapMoving(true);
    if (mapTouchRef.current) {
      followUserRef.current = false;
      // Selbst verschoben: Die letzte Rahmen-Fahrt zählt nicht mehr als das,
      // was man sieht (siehe `lastCityFitRef`).
      lastCityFitRef.current = null;
      // Live: Wer die Karte anfasst, will selbst schauen — die Kamera folgt
      // nicht mehr (der Knopf „Fahrzeug folgen" holt sie zurück).
      if (liveActiveRef.current) useSearchStore.getState().setLiveFollow(false);
    }
  }, [clearPendingViewport]);
  const cameraBearing = useSharedValue(0);
  const cameraPitch = useSharedValue(0);
  /**
   * NUR schreiben, was sich geändert hat.
   *
   * Beim Verschieben meldet die Karte jedes Bild, Drehung und Neigung bleiben
   * dabei aber gleich. Jeder Schreibvorgang in einen animierten Wert weckt den
   * UI-Strang — und das ist genau der Strang, auf dem MapLibre die Wischgeste
   * auswertet und die Kartenfläche (eine `TextureView`) ins Bild setzt. Sechzig
   * bis hundertzwanzig wirkungslose Aufträge pro Sekunde mitten in der Geste
   * sind Arbeit, die dort nichts zu suchen hat. Der zuletzt geschriebene Wert
   * steht deshalb in einem Ref daneben.
   */
  const lastCameraRef = useRef({ bearing: 0, pitch: 0 });
  const onCameraFrame = useCallback(
    (bearing: number, pitch: number, zoom: number) => {
      // Die Kamera bewegt sich noch — ein wartender Ausschnitt wäre verfrüht.
      // (Auch beim Stillstand kommt dieser Aufruf, aber VOR `onRegionChange`,
      // das die Wartezeit dann neu startet.)
      clearPendingViewport();
      liveZoom.report(zoom, false);
      liveZoom.setView(bearing, pitch);
      const last = lastCameraRef.current;
      if (Math.abs(bearing - last.bearing) > 0.05) {
        last.bearing = bearing;
        cameraBearing.value = bearing;
      }
      if (Math.abs(pitch - last.pitch) > 0.05) {
        last.pitch = pitch;
        cameraPitch.value = pitch;
      }
    },
    [cameraBearing, cameraPitch, clearPendingViewport, liveZoom],
  );
  /**
   * Wie tief die Satellitenkarte hier zoomen darf — 18, über einem amtlichen
   * Orthofoto bis 20. Die Antwort kommt vom Server (siehe `onRegionChange`),
   * gemerkt je Feld von rund 500 Metern, damit ein Schwenk innerhalb desselben
   * Viertels nicht jedes Mal fragt.
   */
  const [aerialMaxZoom, setAerialMaxZoom] = useState(18);
  /**
   * Liegt hier ein amtliches Luftbild? `null` = noch unbekannt. Davon hängt ab,
   * ob Esri gezeigt wird (nur in den Lücken, siehe lib/imagery/esriImagery.ts).
   */
  const [aerialOfficial, setAerialOfficial] = useState<boolean | null>(null);
  const coverageCacheRef = useRef(new Map<string, { maxZoom: number; amtlich: boolean }>());
  const coverageAskRef = useRef<string | null>(null);
  /**
   * Der LETZTE Ausschnitt, bei jeder Bewegung mitgeschrieben — ohne Durchgang.
   *
   * Nicht dasselbe wie `viewport`: Jener wird absichtlich nur gesetzt, wenn
   * sich das Abfrage-Raster ändert (siehe `onRegionChange`), und sein Zoom ist
   * deshalb veraltet, sobald jemand an Ort und Stelle hineinzoomt — Stufe 17
   * und 22 liegen im selben Raster. Genau dieser alte Wert würde beim
   * Neuaufbau der Karte als Startzoom gesetzt und risse den Nutzer um fünf
   * Stufen heraus.
   *
   * Als Ref, weil es nichts zeichnet: Er darf bei jeder Bewegung mitlaufen,
   * ohne einen einzigen React-Durchgang zu kosten.
   */
  const lastRegionRef = useRef<{
    latitude: number;
    longitude: number;
    zoom: number;
    bearing?: number;
    pitch?: number;
  } | null>(null);
  /**
   * Welcher Stil auf der Karte liegt — „auto" ist hier schon zum Thema
   * aufgelöst (siehe `mapStyleChoice.ts`). Reaktiv: Wer in den Einstellungen
   * das Thema wechselt, sieht die Karte mitgehen, solange er nicht selbst
   * gewählt hat.
   */
  const resolvedMapStyle = useResolvedMapStyle();
  /**
   * Der Kartentyp, den die Karte ZEIGT — er läuft dem gewählten um einen Schritt
   * nach: Vor dem Neuaufbau (siehe `key` an der Kartenfläche) friert die alte
   * Karte ihr Bild ein, die neue blendet es aus, sobald sie fertig ist
   * (`freezeForStyleSwitch`). Ohne das war die neue Karte bis zu ihrem ersten
   * vollständigen Bild leer — der Wechsel blitzte. Höchstens 120 ms Verzug,
   * dann wird ohnehin umgeschaltet.
   */
  const [mapStyleName, setMapStyleName] = useState(resolvedMapStyle);
  /**
   * Die Sprache, in der die Karte beschriftet IST — sie läuft der App-Sprache
   * genauso nach wie der Kartentyp dem gewählten. Für MapLibre ist eine andere
   * Sprache ein anderer Stil, und der wird nie an der offenen Karte getauscht,
   * sondern über denselben Neuaufbau samt eingefrorenem Bild (siehe `key`).
   */
  const appLocale = useSearchStore((s) => s.locale);
  const [mapLocale, setMapLocale] = useState(appLocale);
  useEffect(() => {
    if (resolvedMapStyle === mapStyleName && appLocale === mapLocale) return;
    let cancelled = false;
    const switchNow = () => {
      if (cancelled) return;
      setMapStyleName(resolvedMapStyle);
      setMapLocale(appLocale);
    };
    const map = mapRef.current;
    if (!map) {
      switchNow();
      return;
    }
    void Promise.race([map.freezeForStyleSwitch(), new Promise((r) => setTimeout(r, 120))]).then(switchNow);
    return () => {
      cancelled = true;
    };
  }, [resolvedMapStyle, mapStyleName, appLocale, mapLocale]);
  // Kartentyp oder Sprache gewechselt = neue Karte (siehe `key` an der
  // Kartenfläche); eine Bewegung der alten meldet ihr Ende nie mehr.
  useEffect(() => {
    setMapMoving(false);
  }, [mapStyleName, mapLocale]);
  // Für `onRegionChange`, das bewusst ohne Abhängigkeiten auskommt.
  const mapStyleNameRef = useRef(mapStyleName);
  mapStyleNameRef.current = mapStyleName;

  /**
   * ESRI IN DEN LÜCKEN — nur in der Satellitenansicht, nur wo der Server „kein
   * amtliches Luftbild" meldet (`aerialOfficial === false`), und nur solange er
   * Esri freigibt (Tagesdeckel, Sperren, Monatsdeckel — siehe
   * lib/imagery/esriImagery.ts). Die Freigabe wird beim Wechsel in die
   * Satellitenansicht und danach alle 10 Minuten geholt.
   */
  const esriLayer = useEsriImagery((st) => st.layer);
  useEffect(() => {
    if (mapStyleName !== "satellite") return;
    void refreshEsriImagery();
    const id = setInterval(() => void refreshEsriImagery(), 10 * 60_000);
    return () => clearInterval(id);
  }, [mapStyleName]);
  const esriVisible = mapStyleName === "satellite" && !!esriLayer && aerialOfficial === false;
  const buildings3d = useSearchStore((st) => st.mapBuildings3d);
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapSurfaceHandle | null>(null);
  const openLocationPicker = useSearchStore((s) => s.openLocationPicker);
  // Erst arbeiten, wenn der Tab wirklich einmal offen war.
  //
  // Seit die Tabs beim App-Start vorgerendert werden (lazy={false} in
  // _layout.tsx) lief dieser Bildschirm sonst ab Sekunde eins mit: Ortung
  // anfordern, GPS-Fix abwarten, danach /api/surroundings abfragen — für einen
  // Tab, den der Nutzer vielleicht nie öffnet. Die Antwort kam dann irgendwann
  // an und löste einen Commit aus, während man im Landingscreen scrollte oder
  // gerade eine Slide lief. Weil der Zeitpunkt vom Netz abhängt, traf es mal
  // eine Bewegung und mal nicht — genau das Muster von „ruckelt manchmal".
  //
  // Das Vorrendern selbst bleibt: Gerüst und Skelett stehen weiterhin fertig da,
  // der erste Wechsel auf den Tab zeigt also weiterhin sofort etwas.
  const [everFocused, setEverFocused] = useState(false);
  const {
    coord: userCoord,
    status: locationStatus,
    refresh: refreshLocation,
  } = useUserLocation(everFocused);

  const pendingRoute = useSearchStore((s) => s.pendingRoute);
  const clearRoute = useSearchStore((s) => s.clearRoute);
  /**
   * Route erst nach der Navigation löschen — sonst liefe der Karten-Reset
   * gleichzeitig mit der Bewegung und ruckelte sichtbar.
   *
   * Die Identitätsprüfung ist der Kern: Wer in diesen 400ms schon die nächste
   * Route öffnet, bekam sie sonst gelöscht — der frisch geöffnete Karten-Screen
   * poppte sich kommentarlos selbst wieder zu. Dieselbe Prüfung steht in
   * `app/search/route-map.tsx` bereits.
   */
  const clearRouteSoon = useCallback(() => {
    const closing = useSearchStore.getState().pendingRoute;
    setTimeout(() => {
      if (useSearchStore.getState().pendingRoute === closing) clearRoute();
    }, 400);
  }, [clearRoute]);
  const routeActive = pendingRoute !== null && pendingRoute.waypoints.length >= 2;

  /**
   * DAS STADT-BLATT — Tipp auf den Namen einer Stadt: Zug, Bus und Flug vom
   * eigenen Standort dorthin (Inhalt: `CityTripBody`, im Haltestellen-Blatt).
   *
   * Solange es offen ist, zeigt die Karte statt der Haltestellen-Symbole die
   * Verbindungen (`CityRouteLayers`) — die Symbole lägen sonst über den Linien,
   * und um die geht es in diesem Moment.
   */
  const selectedCity = useSearchStore((s) => s.selectedCity);
  const cityRoutes = useSearchStore((s) => s.cityRoutes);
  const selectedStopForWalk = useSearchStore((s) => s.selectedStop);
  /**
   * Wohin der gepunktete Fußweg führt: im Stadt-Blatt zur Startstation der
   * gewählten Verbindung, sonst zur angetippten Haltestelle. Ohne eigenen
   * Standort gibt es keinen — dann bliebe nur ein Weg von irgendwo.
   */
  const walkTarget = useMemo(() => {
    if (selectedCity) {
      const start = cityRoutes?.plans[cityRoutes.selected]?.waypoints[0];
      return start ? { latitude: start.latitude, longitude: start.longitude } : null;
    }
    const st = selectedStopForWalk;
    return st?.latitude != null && st.longitude != null
      ? { latitude: st.latitude, longitude: st.longitude }
      : null;
  }, [selectedCity, cityRoutes, selectedStopForWalk]);
  const selectCityRoute = useSearchStore((s) => s.selectCityRoute);
  const userCoordRef = useRef(userCoord);
  userCoordRef.current = userCoord;
  const routeActiveRef = useRef(routeActive);
  routeActiveRef.current = routeActive;
  const { height: screenHeight } = useWindowDimensions();
  /**
   * Wo die Karte frei ist, wenn das Stadt-Blatt in der Mitte steht: oben unter
   * der Suchleiste, unten über dem Blatt. Dieselbe Rechnung wie im Blatt selbst
   * (`stopSheetSnap`), sonst läge die Route halb darunter.
   */
  const cityPadding = useMemo(
    () => ({
      top: insets.top + 88,
      bottom: stopSheetSnap(screenHeight, insets.top, insets.bottom).midVisible + 24,
      left: 48,
      right: 48,
    }),
    [insets.top, insets.bottom, screenHeight],
  );
  const cityPaddingRef = useRef(cityPadding);
  cityPaddingRef.current = cityPadding;
  /**
   * Unterkante der Leiste oben (Suchleiste bzw. Kasten, im Routen-Modus das
   * Banner) — gemessen, siehe `topBarBottom` weiter unten. Als Ablage, weil die
   * Kamera-Rechnung sie in Rückrufen liest.
   */
  const topBarBottomRef = useRef<number | null>(null);
  /**
   * DER FREIE AUSSCHNITT — der verdeckte Rand oben und unten, für die Kamera.
   *
   * Oben die Leiste, unten das Blatt, das gerade höher reicht (Auswahlfenster
   * oder Haltestellen-/Stadt-Blatt), gerechnet aus dem ZIEL ihrer Bewegung
   * (lib/surroundings/mapViewport.ts). Ein Punkt, zu dem die Kamera mit diesem
   * Rand fährt, steht genau in der Mitte dazwischen.
   *
   * Vorher zielte „zu meinem Standort" auf die Bildschirmmitte. Mit dem
   * Stadt-Blatt in halber Höhe ist das dessen Oberkante — der Standort-Punkt
   * lag zur Hälfte darunter.
   *
   * Im Nur-Karte-Modus gibt es weder Leiste noch Auswahlfenster; ein offenes
   * Haltestellen-Blatt bleibt (es gehört zum Inhalt). Im Routen-Modus steht
   * unten die Tab-Leiste. Ist ein Blatt ganz aufgezogen, bleibt kaum Karte —
   * dann gar kein Rand statt eines Streifens.
   */
  const visiblePadding = useCallback((): CameraPadding | undefined => {
    const hidden = isMapChromeHidden();
    const fullTop = Math.max(60, insets.top + 12);
    const top = hidden ? 0 : (topBarBottomRef.current ?? 0);
    let bottomEdge = screenHeight;
    const targets = sheetTargets();
    if (!hidden) {
      if (routeActiveRef.current) {
        bottomEdge = screenHeight - (ms(TAB_BAR_H) + insets.bottom);
      } else if (targets.surroundings != null) {
        bottomEdge = fullTop + targets.surroundings;
      }
    }
    if (targets.stop != null) bottomEdge = Math.min(bottomEdge, fullTop + targets.stop);
    if (bottomEdge - top < 160) return undefined;
    return { top, bottom: Math.max(0, screenHeight - bottomEdge), left: 0, right: 0 };
  }, [insets.top, insets.bottom, screenHeight]);
  /**
   * Steht die Kamera auf dem eigenen Standort — Knopf gedrückt und seitdem
   * nichts anderes angesteuert? Dann führt sie nach, wenn ein Blatt sich
   * öffnet, schließt oder einrastet (siehe `subscribeViewport` weiter unten).
   *
   * Aus ist sie, sobald man die Karte selbst bewegt oder etwas anderes
   * ansteuert (Haltestelle, Stadt, Suche) — dann wäre ein Zurückschwenken auf
   * den eigenen Punkt ein Wegreißen.
   */
  const followUserRef = useRef(false);
  /** Rahmen um Punkte — für `fitBounds`. */
  /**
   * Die letzte Rahmen-Fahrt der Stadt — wann und auf welches Rechteck. Siehe
   * den Effekt zu `cityRouteKey`: Er entscheidet damit, ob eine ZWEITE Fahrt
   * nötig ist und wann sie starten darf. Ein Finger auf der Karte löscht sie
   * (`onMapCameraMoveStart`) — danach zeigt die Karte, was der Nutzer will.
   */
  const lastCityFitRef = useRef<{
    at: number;
    /** Wie lange diese Fahrt dauert (hängt am Weg, siehe `fitBounds`). */
    ms: number;
    w: number;
    s: number;
    e: number;
    n: number;
  } | null>(null);
  const fitPoints = useCallback((pts: Array<{ latitude: number; longitude: number }>) => {
    if (pts.length === 0) return;
    let w = Infinity;
    let sLat = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (const p of pts) {
      w = Math.min(w, p.longitude);
      e = Math.max(e, p.longitude);
      sLat = Math.min(sLat, p.latitude);
      n = Math.max(n, p.latitude);
    }
    const fit = { at: Date.now(), ms: CITY_FIT_MS, w, s: sLat, e, n };
    lastCityFitRef.current = fit;
    // Eine Rahmen-Fahrt ist kein „auf meinem Standort" mehr (siehe `followUserRef`).
    followUserRef.current = false;
    /**
     * EIN Punkt (kein Standort bekannt, nur die Stadt): ein Rechteck der
     * Fläche null — MapLibre zoomte dafür bis auf die Höchststufe, man stand
     * auf Hausnummer-Ebene über dem Namen. Dann die Stadt in Stadt-Zoom.
     */
    /**
     * Oben die GEMESSENE Unterkante der Leiste bzw. des Kastens (plus Luft)
     * statt geschätzter 88 Punkte — derselbe Wert wie für den Standort
     * (`visiblePadding`).
     */
    const barBottom = topBarBottomRef.current;
    const pad =
      barBottom != null
        ? { ...cityPaddingRef.current, top: barBottom + CITY_FIT_TOP_GAP }
        : cityPaddingRef.current;
    if (Math.abs(e - w) < 1e-4 && Math.abs(n - sLat) < 1e-4) {
      fit.ms = mapRef.current?.flyTo(sLat, w, SINGLE_POINT_ZOOM, pad) ?? CITY_FIT_MS;
      return;
    }
    fit.ms = mapRef.current?.fitBounds([w, sLat], [e, n], pad) ?? CITY_FIT_MS;
  }, []);
  /**
   * Tipp auf eine Stadt. Start ist IMMER der eigene Standort, Ziel IMMER die
   * Stadt. Im Routen-Modus (Route aus der Ergebnisliste) bleibt ein Tipp ein
   * Karten-Tipp — dort steht schon eine Route, und die gehört einer anderen
   * Suche.
   *
   * Die Kamera zeigt sofort beides, Standort und Stadt; sobald Verbindungen da
   * sind, rückt sie auf die gewählte (Effekt darunter).
   */
  const onCityPress = useCallback((c: MapCityPress) => {
    // Kein Zurückholen der Oberfläche — ein Stadtname ist ein Element der
    // Karte, nicht die freie Fläche (siehe `selectStopFromMap`).
    if (routeActiveRef.current || liveActiveRef.current) return;
    haptic("button");
    followUserRef.current = false;
    const from = userCoordRef.current;
    const st = useSearchStore.getState();
    /**
     * Steht das Blatt schon offen (andere Stadt, oder eine Haltestelle — beide
     * haben dieselben Rastpunkte), bleibt es, wo es ist: Nur der Inhalt wechselt.
     * Ein erneutes Hereinfahren wäre eine Bewegung ohne Anlass, und wer es auf
     * ganz oben gezogen hatte, fände es wieder in der Mitte.
     *
     * „Offen" heißt: das Blatt fährt bzw. steht im Bild (`sheetTargets`) — nicht
     * bloß „im Store gesetzt". Beides lief schon auseinander (Zurück aus „Auf
     * Karte anzeigen"), und dann öffnete kein Tipp mehr ein Blatt.
     */
    const alreadyOpen = sheetTargets().stop != null;
    /**
     * DIESELBE Stadt noch einmal angetippt: nichts neu anlegen, nur wieder
     * einrahmen.
     *
     * Ein neues `selectCity` setzte die Suche der Stadt zurück (Routen,
     * Kasten, Preis) — ihr Inhalt blieb aber derselbe, und seine Effekte
     * liefen deshalb nicht erneut: Linien weg, Glocke und „Suchen" taub.
     */
    const cur = st.selectedCity;
    const sameCityOpen =
      cur != null &&
      cur.name === c.name &&
      Math.abs(cur.latitude - c.latitude) < 1e-4 &&
      Math.abs(cur.longitude - c.longitude) < 1e-4;
    if (!sameCityOpen) {
      st.selectCity({
        ...c,
        from: from ? { latitude: from.latitude, longitude: from.longitude } : null,
      });
    }
    if (!alreadyOpen) openStopSheet();
    fitPoints(from ? [from, c] : [c]);
  }, [fitPoints]);
  /** Neue Verbindungen oder eine andere gewählt → die Karte zeigt deren Strecke. */
  const cityRouteKey = cityRoutes ? `${cityRoutes.key}#${cityRoutes.selected}` : null;
  /**
   * NUR EINE Kamerafahrt, wo eine reicht — und nie zwei ineinander.
   *
   * Beim Tipp auf eine Stadt fährt die Kamera sofort auf Standort + Stadt.
   * Kommen die Verbindungen schnell (oft aus dem Zwischenspeicher), setzte
   * dieser Effekt mitten in dieser Fahrt eine zweite an: Richtungswechsel
   * mitten in der Bewegung, gemeldet als „die Karte zittert kurz, wenn ich auf
   * einen Namen tippe".
   *
   * Jetzt: Liegt die Strecke ohnehin im Rahmen der ersten Fahrt (mit etwas
   * Rand), bleibt es bei ihr. Sonst wartet die zweite, bis die erste
   * angekommen ist, und schließt dann weich an.
   */
  useEffect(() => {
    const r = useSearchStore.getState().cityRoutes;
    if (!r) return;
    const plan = r.plans[r.selected];
    if (!plan) return;
    // Mit dem eigenen Standort — sonst läge der Fußweg zur Station am Rand.
    const here = userCoordRef.current;
    const pts = here ? [here, ...plan.waypoints] : plan.waypoints;
    const last = lastCityFitRef.current;
    if (last) {
      const mx = (last.e - last.w) * 0.1;
      const my = (last.n - last.s) * 0.1;
      const inside = pts.every(
        (p) =>
          p.longitude >= last.w - mx &&
          p.longitude <= last.e + mx &&
          p.latitude >= last.s - my &&
          p.latitude <= last.n + my,
      );
      if (inside) return;
      // Bis die erste angekommen ist — ihre Dauer hängt am Weg — plus ein Bild.
      const wait = last.ms + 20 - (Date.now() - last.at);
      if (wait > 0) {
        const id = setTimeout(() => {
          // Inzwischen selbst verschoben oder woanders hingefahren? Dann nicht
          // mehr — die Fahrt liefe gegen den Finger bzw. die neue Fahrt.
          if (lastCityFitRef.current !== last || mapTouchRef.current) return;
          fitPoints(pts);
        }, wait);
        return () => clearTimeout(id);
      }
    }
    fitPoints(pts);
  }, [cityRouteKey, fitPoints]);

  const [viewport, setViewport] = useState<Viewport | null>(null);
  /**
   * Das zuletzt GEMELDETE Rasterfeld — Wächter gegen Durchgänge ohne Wirkung.
   * Begründung an `onRegionChange`, die Rundung gehört mit dem Abfrage-Schlüssel
   * zusammen (siehe `keyLat` weiter unten).
   */
  const viewportBucketRef = useRef<string | null>(null);

  // StopDetailSheet wird global in app/_layout.tsx gerendert (damit's ÜBER
  // der FloatingTabBar liegt). Wir setzen hier nur den Store-State beim
  // Marker-Tap.
  const selectStop = useSearchStore((s) => s.selectStop);

  // MapSurface mountet bereits beim ersten Focus, aber wir behalten das
  // MapSkeleton SICHTBAR bis MapLibre tatsächlich seine Tiles gerendert
  // hat (Event `onDidFinishRenderingMapFully`). Vorher wurde nach 80ms hart
  // gewechselt → User sah leere/blanke Tiles während MapLibre noch lud,
  // dann ein Flicker zur richtigen Karte.
  // Jetzt: Skelett bleibt drauf bis die echten Tiles da sind → kein leerer
  // Zwischenzustand mehr sichtbar.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (isFocused) setEverFocused(true);
  }, [isFocused]);

  // VERZÖGERTER Freeze (ersetzt freezeOnBlur, siehe (tabs)/_layout.tsx): Beim
  // Blur soll die Karte NICHT sofort einfrieren — der dicke Freeze-Commit fiele
  // sonst in den Tab-Crossfade und verschluckt einen Frame („Aufblitzen" beim
  // Verlassen der Map). Er wird also nachgelagert.
  //
  // Zwei Dinge waren daran vorher falsch und haben Tab-Wechsel spürbar zäh
  // gemacht:
  //
  //  1. Der feste 450ms-Timer war blind für weitere Tipps. Wer schneller
  //     durchklickt, bekam den Freeze-Commit mitten in den ZWEITEN oder DRITTEN
  //     Wechsel geschoben — der Ruckler war damit vom eigenen Tipp entkoppelt
  //     und wirkte wie zufälliger Lag. Jetzt wird weiter aufgeschoben, solange
  //     der letzte Tab-Tipp noch frisch war, der Commit landet
  //     also garantiert in einer ruhigen Phase.
  //  2. Aufgetaut wurde per State im Effekt: Der Screen rendete beim Zurück-
  //     kommen erst NOCH eingefroren, und erst der Effekt danach taute den
  //     kompletten Kartenbaum in einem zweiten Commit auf — beide im Wechsel-
  //     Frame. `frozen` ist jetzt abgeleitet, das Auftauen passiert im ersten
  //     Render, und es bleibt bei EINEM Commit.
  /**
   * SOFORT einfrieren, sobald der Tab den Fokus verliert.
   *
   * Hier stand ein Aufschub von 500ms plus eine Prüfung auf laufende
   * Bewegungen. Beides war gut gemeint — der Freeze-Commit sollte nicht in den
   * Tab-Wechsel und nicht in eine fremde Fahrt fallen. Nur hatte es eine Folge,
   * die schwerer wiegt als der Commit selbst: In diesem Fenster ist die Karte
   * NICHT eingefroren. Sie zeichnet weiter, und man sieht sie — als schwarzen
   * Balken am oberen Rand, dort wo sie unter die Statusleiste reicht.
   *
   * Genau das ist der gemeldete Befund: Löst man die Fahrt aus, WÄHREND der
   * Balken zu sehen ist, ruckelt sie; wartet man, bis er weg ist, läuft sie
   * glatt. Der Balken ist die noch lebende Karte, und der Aufschub hat sein
   * Fenster verlängert — beim Öffnen von Bo sogar über die ganze Fahrt, weil
   * die Prüfung dann jedes Mal erneut vertagt.
   *
   * Der Commit fällt jetzt in den Tab-Wechsel. Dort ist er am besten
   * aufgehoben: Der Wechsel blendet nicht über (`disablePageAnimations`), es
   * läuft also keine Bewegung, die er stören könnte.
   */
  const freezeArmed = !isFocused;
  /**
   * Auch einfrieren, wenn ein WÄHLER darüber liegt — aber erst, wenn er WIRKLICH
   * darüber liegt.
   *
   * Der Gedanke stimmt: Der Ortswähler wird aus dieser Karte heraus geöffnet,
   * also bei fokussiertem Tab, und unter einem deckenden Blatt braucht der
   * GL-Strang der Karte nicht weiterzulaufen.
   *
   * Nur deckt das Blatt beim Antippen noch gar nichts. Es fährt erst herein, und
   * das dauert `PICKER_IN` — und über diese ganze Strecke ist die Karte dahinter
   * zu sehen. Eingefroren verliert die GL-Fläche ihren Kontext (die SurfaceView
   * geht auf `INVISIBLE`), und genau das sah man: Die Karte wurde in dem Moment
   * schwarz, in dem das Blatt losfuhr.
   *
   * Also erst anhalten, wenn die Einfahrt durch ist. Der Zuschlag deckt das
   * Bild ab, in dem die Kurve endet.
   */
  const pickerOpen = useSearchStore((st) => st.locationPickerRequest !== null);
  const [pickerCoversMap, setPickerCoversMap] = useState(false);
  useEffect(() => {
    // Beim Schließen SOFORT freigeben — dort ist es umgekehrt: Das Blatt fährt
    // hinaus und die Karte soll schon wieder da sein, wenn es den Blick freigibt.
    if (!pickerOpen) {
      setPickerCoversMap(false);
      return;
    }
    const id = setTimeout(() => setPickerCoversMap(true), PICKER_IN.duration + 40);
    return () => clearTimeout(id);
  }, [pickerOpen]);
  const pickerOverMap = pickerCoversMap;
  /** Liegt die Suche darüber? Dann ist die Karte sicher nicht zu sehen. */
  const searchOverMap = useSearchStore((st) => st.searchOverlayMode != null);
  /**
   * Und BO — er fehlte in dieser Aufzählung, und das war der Unterschied.
   *
   * Gemeldet als: „Vom Umgebungs-Tab direkt Bo öffnen ruckelt, das Such-Blatt
   * von derselben Stelle aus nicht." Gleicher Tab-Wechsel, gleicher
   * Landingscreen, gleicher Parallax, gleiche Unterlagen-Textur — es konnte also
   * an keinem davon liegen. Der Unterschied steht in dieser Zeile:
   *
   *   • Das Such-Blatt setzt beim Tippen `searchOverlayMode`. Damit wird
   *     `frozen` im TIPP-Bild wahr, der GL-Strang der Karte hält an, und die
   *     Fahrt bekommt den Bildschirm für sich.
   *   • Bo setzte nichts dergleichen. Die Karte lief unsichtbar weiter — mit
   *     ihrem eigenen Render-Strang, ihrer Marker-Ebene und ihrer
   *     Ausschnitts-Abfrage — mitten in Bos Einfahrt hinein.
   *
   * Der aufgeschobene Freeze beim Tab-Wechsel deckt das NICHT ab; im Gegenteil.
   * Er wartet inzwischen ausdrücklich, solange etwas fährt — und hielt die Karte
   * damit über die volle Länge von Bos Fahrt am Laufen. Der Aufschub ist
   * richtig, aber er ist ein Schutz für den Freeze-COMMIT, kein Ersatz für das
   * Einfrieren selbst.
   *
   * Bo deckt den ganzen Bildschirm; sichtbar ist die Karte dabei nie.
   */
  const assistantOverMap = useSearchStore((st) => st.assistantOpen);
  /**
   * Und das Verlaufs-Blatt — dieselbe Regel, letzte Lücke.
   *
   * Der aufgeschobene Freeze greift erst eine halbe Sekunde nach dem Verlassen
   * des Tabs. In diesem Fenster läuft die Karte weiter, und alles, was man in
   * dieser Zeit öffnet, fährt gegen sie an. Wähler, Suche und Bo sind abgedeckt;
   * das Verlaufs-Blatt war der einzige Weg vom Landingscreen aus, der es nicht
   * war.
   *
   * Damit gilt die Regel vollständig: Was den Bildschirm deckt, hält die Karte
   * an — unabhängig davon, ob der Aufschub schon gegriffen hat.
   */
  const historyOverMap = useSearchStore((st) => st.recentHistoryOverlayOpen);
  const frozen =
    (!isFocused && freezeArmed) ||
    pickerOverMap ||
    searchOverMap ||
    assistantOverMap ||
    historyOverMap;

  /**
   * Der Kompass für den Blickrichtungs-Kegel läuft nur, solange die Karte zu
   * sehen und nicht eingefroren ist — geschaltet von HIER, weil ein Prop den
   * eingefrorenen Kegel nicht mehr erreicht (siehe `useDeviceHeading`).
   */
  /**
   * Auch nicht unter einem deckenden Blatt — Detail-Blatt, Zeitleiste,
   * Ergebnisliste. Die halten die Karte nicht an (`frozen`), sie liegt aber
   * vollständig darunter, und der Kegel rechnete dort ungesehen weiter.
   */
  const coveredByOverlay = useSearchStore(
    (st) =>
      st.selectedResult != null ||
      st.legTimelineOverlayOpen ||
      st.directTripResult != null ||
      st.resultsParams != null,
  );
  useEffect(() => {
    setDeviceHeadingActive(isFocused && !frozen && !coveredByOverlay);
  }, [isFocused, frozen, coveredByOverlay]);
  useEffect(() => () => setDeviceHeadingActive(false), []);

  /**
   * NUR DIE KARTE — Hochwischen an der Suchleiste schiebt die Oberfläche aus
   * dem Bild, ein Tipp auf die Karte holt sie zurück. Der Wert und die Regeln
   * stehen in `lib/surroundings/mapChrome.ts`.
   *
   * Beim Verlassen des Tabs SOFORT zurück, ohne Bewegung: Die Tab-Leiste hängt
   * am Wurzel-Layout und liest denselben Wert — auf dem nächsten Tab muss sie
   * stehen. Sieht dort ohnehin niemand die Karte.
   */
  useEffect(() => {
    if (!isFocused) showMapChrome(false);
  }, [isFocused]);
  /**
   * Die Zurück-Taste holt zuerst die Oberfläche zurück — so, wie sie ein
   * offenes Blatt schließt, bevor sie den Bildschirm verlässt. Nur solange der
   * Tab vorn ist; sonst gehört sie anderen.
   */
  useEffect(() => {
    if (!isFocused) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!isMapChromeHidden()) return false;
      showMapChrome();
      return true;
    });
    return () => sub.remove();
  }, [isFocused]);
  const onMapPress = useCallback(() => {
    if (isMapChromeHidden()) showMapChrome();
  }, []);
  /**
   * Live: Takt und Kamera nur, solange man hinsieht — Tab vorn, App vorn.
   * Die Fahrt lädt der Server (Halte, Zeiten, Verlauf), den Rest rechnet die App.
   */
  const appActive = useAppActive();
  const liveRunning = liveActive && isFocused && appActive;
  const { model: liveModel, status: liveStatus } = useLiveModel(liveSession, liveRunning);
  useEffect(() => {
    probeMark(liveActive ? "live-committed" : "close-committed");
  }, [liveActive]);
  useEffect(() => {
    if (!liveActive) return;
    // Die Kamera gehört jetzt dem Fahrzeug, nicht mehr dem eigenen Standort.
    followUserRef.current = false;
    // Im Nur-Karte-Modus gestartet (Tafel über Bo): Banner und Karte zeigen.
    if (isMapChromeHidden()) showMapChrome();
  }, [liveActive]);
  /**
   * DAS AUSWAHLFENSTER KOMMT NACH DEM ZURÜCK EINEN MOMENT SPÄTER, wenn dabei
   * das Haltestellen-Blatt hereinfährt: Es liegt dann ohnehin darunter (das
   * Blatt hängt über allem, `app/_layout.tsx`). Sein Aufbau — Liste mit Zeilen,
   * Symbole, Gesten — fiel sonst in denselben Commit wie der Abbau der
   * Live-Ansicht und mitten in die Einfahrt des Blatts und die Überblendung des
   * Kamera-Schnitts („Beenden laggt immer noch spürbar"). Danach baut es sich
   * unsichtbar darunter auf. Der Standort-Knopf, den es trägt, erscheint
   * dadurch erst, wenn das Blatt steht.
   */
  const [surroundingsHeld, setSurroundingsHeld] = useState(false);
  const surroundingsHoldRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdSurroundingsSheet = useCallback(() => {
    setSurroundingsHeld(true);
    if (surroundingsHoldRef.current) clearTimeout(surroundingsHoldRef.current);
    surroundingsHoldRef.current = setTimeout(() => {
      surroundingsHoldRef.current = null;
      setSurroundingsHeld(false);
    }, SHEET_IN.duration + SURROUNDINGS_HOLD_EXTRA_MS);
  }, []);
  useEffect(
    () => () => {
      if (surroundingsHoldRef.current) clearTimeout(surroundingsHoldRef.current);
    },
    [],
  );
  /**
   * Zurück aus der Live-Ansicht — wie aus dem Routen-Modus: die geparkte
   * Oberfläche zurücklegen und das Blatt wieder hereinfahren. Die Karte wird
   * wieder flach und nach Norden ausgerichtet und kehrt zur Haltestelle zurück:
   * Das Fahrzeug kann weit weg gefahren sein, und die Tafel gehört über ihren
   * Halt, nicht über die letzte Stelle des Zuges. Reihenfolge wie beim Tipp auf
   * eine Haltestelle (`focusStop`): erst das Blatt, dann die Kamera — so kennt
   * der freie Ausschnitt schon dessen Höhe.
   *
   * KEIN FLUG ZURÜCK, wenn der Halt weit weg ist (meist: Das Fahrzeug ist
   * längst ein paar Kilometer weiter). Das war ein Bogenflug bis 2,6 s, mit 58°
   * Neigung durch Kacheln, die keiner im Speicher hatte, Bild für Bild auf dem
   * UI-Strang — zugleich mit dem Umbau der Oberfläche. Gemeldet als „laggt zwei
   * Sekunden lang". Jetzt ein Schnitt: altes Bild einfrieren, Kamera springt
   * darunter zum Halt (dessen Kacheln kennt die Karte noch), Überblendung.
   * Die Kamera geht VOR dem Zurücklegen des Zustands los — eingefroren wird das
   * Bild, bevor Ebenen wechseln.
   */
  const closeLive = useCallback(() => {
    probeMark("close-tap");
    probeFrames("close");
    haptic("button");
    const st = useSearchStore.getState();
    const stash = st.stashedSurroundings;
    if (stash && (stash.selectedStop || stash.city)) {
      openStopSheet();
      holdSurroundingsSheet();
    }
    const at = stash?.selectedStop;
    const map = mapRef.current;
    if (at?.latitude != null && at.longitude != null) {
      const zoom = mode === "transit" ? 15 : 11;
      map?.followTo({
        latitude: at.latitude,
        longitude: at.longitude,
        zoom,
        bearing: 0,
        pitch: 0,
        // Immer einen Rand mitgeben: Ohne behielte MapLibre den der Live-Ansicht
        // (Banner + Karte unten), und der Halt säße außerhalb der Mitte.
        padding: visiblePadding() ?? { top: 0, bottom: 0, left: 0, right: 0 },
        cut: map.isFar(at.latitude, at.longitude, zoom),
      });
    } else {
      map?.resetNorth();
    }
    probeMark("close-cam");
    st.stopLive();
    probeMark("close-state");
  }, [mode, visiblePadding, holdSurroundingsSheet]);
  useEffect(() => {
    if (!isFocused || !liveActive) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeLive();
      return true;
    });
    return () => sub.remove();
  }, [isFocused, liveActive, closeLive]);
  /**
   * Die Unterkante dessen, was oben steht — Suchleiste oder, im Routen-Modus,
   * das Routen-Banner. Die Knopfreihe beginnt darunter im selben Abstand, den
   * der Standort-Knopf unten zum Blatt hat (`SPACE.md`).
   *
   * Gemessen statt geschätzt: Hier stand ein fester Wert (`insets.top + 70`),
   * geraten aus der Höhe der Leiste. Die hängt aber an Schriftgröße und
   * Skalierung — die Knopfreihe klebte fast an der Leiste, während unten der
   * Standort-Knopf sichtbar Luft zum Blatt hatte.
   */
  const [topBarBottom, setTopBarBottom] = useState<number | null>(null);
  /**
   * Wie weit die Suchleiste bis hinter den oberen Rand hat — gemessen, nicht
   * geschätzt (Statusleiste, Schriftgröße und Schatten gehen alle ein).
   */
  const onSearchWrapLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    // Plus Luft für den Schatten, der über die Kante hinausreicht.
    travelSearch.value = y + height + 16;
    topBarBottomRef.current = y + height;
    setTopBarBottom(y + height);
  }, []);
  const onRouteBannerLayout = useCallback((e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    topBarBottomRef.current = y + height;
    setTopBarBottom(y + height);
  }, []);
  const searchChromeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.min(chromeShift.value, travelSearch.value) }],
  }));
  /**
   * Die Geste — NUR an der Suchleiste, nur nach OBEN.
   *
   * Sie springt erst nach zehn Punkten Weg aufwärts an; bis dahin gehört die
   * Berührung der Leiste, ein Tipp öffnet also weiter die Suche. Springt sie an,
   * bricht RNGH den Tipp der Leiste ab. Nach unten oder quer scheitert sie
   * sofort — ein Wisch auf der Karte kann sie gar nicht erst auslösen, er
   * beginnt ja nicht auf der Leiste.
   *
   * Die Verschiebung ist der Weg des Fingers, eins zu eins: Die Leiste klebt am
   * Finger, und alle anderen Teile fahren genau dieselbe Strecke mit (siehe
   * `chromeShift`). Der Nullpunkt ist die Stelle, an der die Geste anspringt —
   * sonst sprängen alle um die zehn Punkte Anlauf auf einmal los.
   */
  const chromeBase = useSharedValue(0);
  const chromePan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(-10)
        .failOffsetY(10)
        .failOffsetX([-30, 30])
        .onStart((e) => {
          chromeBase.value = e.translationY;
        })
        .onUpdate((e) => {
          const shift = -(e.translationY - chromeBase.value);
          chromeShift.value = Math.min(maxTravel(), Math.max(0, shift));
        })
        .onEnd((e) => {
          const hide =
            chromeShift.value > HIDE_AT * travelSearch.value || e.velocityY < HIDE_VELOCITY;
          settle(hide ? maxTravel() : 0, e.velocityY);
          runOnJS(markMapChromeHidden)(hide);
        }),
    [chromeBase],
  );

  const [mapMounted, setMapMounted] = useState(false);
  /**
   * Einwegs war falsch — beim Einfrieren gehört das Skelett zurück.
   *
   * Eingefroren verliert die GL-Fläche ihren Kontext (SurfaceView geht auf
   * `INVISIBLE`/`GONE`). Beim Zurückkommen wird sie neu erzeugt und ist für
   * ein bis drei Sekunden leer — und leer heißt hier exakt die Farbe des
   * Hintergrunds, das Skelett war das einzige, was sich davon abhob. Also
   * zurücksetzen und erst wieder freigeben, wenn MapLibre erneut fertig
   * gemeldet hat.
   */
  /** Wurde die Karte in diesem App-Lauf schon einmal enthüllt? Dann ist jeder
   *  weitere Durchgang ein Auftauen, kein Kaltstart — siehe unten. */
  const everRevealedRef = useRef(false);
  const [mapTilesRendered, setMapTilesRendered] = useState(false);
  /**
   * MITTEN IM LADEN VERLASSEN? Dann die Karte ABBAUEN, nicht nur einfrieren.
   *
   * Gemeldet als: „Zum Karten-Tab, gleich wieder zurück, bevor sie fertig ist —
   * dann ruckelt Bos Fahrt. Lasse ich sie fertig laden, ist es glatt."
   *
   * Das passt genau zu dem, was die Karte tut. Sie holt Vektor-Kacheln von einem
   * freien Server; jede muss dekodiert, in Geometrie übersetzt und über die rund
   * zwanzig Stil-Ebenen tesselliert werden, dazu die Schriftzeichen als eigene
   * Dateien. Diese Arbeit läuft auf EIGENEN Arbeits-Strängen von MapLibre — und
   * die kümmert weder `<Freeze>` (das hält nur React an) noch `display: none`
   * (das hält nur das Zeichnen an). Sie rechnen weiter und nehmen der Fahrt die
   * Rechenzeit weg.
   *
   * Ist die Karte dagegen FERTIG, ist Ruhe: keine offenen Anfragen, nichts mehr
   * zu tesselieren. Deshalb ist genau dieser Fall glatt.
   *
   * Also: fertig geladen → stehen lassen (Rückkehr ist dann sofort da).
   * Mitten im Laden verlassen → abbauen, was die offene Arbeit mit abbricht. Was
   * dabei verloren geht, war ohnehin unvollständig, und beim Zurückkommen wird
   * es neu geholt — dann aber, ohne einer Animation im Weg zu stehen.
   */
  useEffect(() => {
    if (!frozen) return;
    /**
     * Der Prüfstein ist eine ABLAGE, nicht der Zustand — und das ist hier
     * entscheidend.
     *
     * Mit `mapTilesRendered` stand hier ein Wert, den der Schwester-Effekt
     * unten im SELBEN Durchgang auf falsch setzt. Ablauf: Dieser Effekt läuft
     * zuerst, sieht „fertig geladen" und steigt aus; der Schwester-Effekt
     * löscht das Merkmal; dadurch ändert sich die Abhängigkeit, dieser Effekt
     * läuft ERNEUT — und findet jetzt „nicht fertig". Der Wächter war damit
     * tot, und die Karte wurde bei JEDEM Verdecken abgebaut statt nur beim
     * Verlassen mitten im Laden.
     *
     * Ausgelöst hat das alles, was `frozen` setzt — auch der Ortswähler, den
     * man AUS der Karte heraus öffnet. Wer dort einen Ort suchte, zerstörte die
     * Karte damit und baute sie beim Schließen komplett neu auf: neue
     * GL-Fläche, Stil neu geparst, alle Kacheln und Schriftzeichen neu geholt.
     *
     * Die Ablage überlebt den Zwischenzustand, weil sie nur beim echten
     * Fertig-Melden gesetzt wird.
     */
    if (wasFullyLoadedRef.current) return;
    /**
     * Und nur, wenn der Tab wirklich VERLASSEN wurde.
     *
     * `frozen` gilt auch, wenn bloß etwas darüberliegt — Wähler, Suche, Bo,
     * Verlaufs-Blatt. In diesen Fällen kommt man unmittelbar auf die Karte
     * zurück; sie abzubauen wäre in jedem Fall falsch.
     */
    if (isFocused) return;
    if (!mapMounted) return;
    wasFullyLoadedRef.current = false;
    // Eine Karte, die mitten in einer Bewegung abgebaut wird, meldet deren Ende
    // nie — ohne das hielte jede `whenMapQuiet`-Arbeit ihre volle Wartezeit.
    setMapMoving(false);
    setMapMounted(false);
  }, [frozen, isFocused, mapMounted]);

  useEffect(() => {
    if (frozen) {
      /**
       * Das Skelett NUR zurückholen, wenn die Fläche auch wirklich verschwindet.
       *
       * Es stand hier bedingungslos — und das war der Grund für „beim ersten Mal
       * lädt die Karte schnell, danach dauert es viel länger".
       *
       * Der Ablauf: Beim Einfrieren kam das Skelett zurück. Beim Auftauen kann
       * MapLibre sein „fertig" aber gar nicht noch einmal melden — die
       * GL-Fläche wurde nie zerstört, es gibt also kein neues Ereignis. Was das
       * Skelett dann wegnimmt, ist ausschließlich die Notbremse. Der ERSTE
       * Besuch war schnell, weil dort das echte Signal kam; jeder weitere wartete
       * auf den Wecker und sah dabei aus wie „lädt".
       *
       * Bleibt die Karte stehen, sind ihre Pixel noch da. Dann gehört kein
       * Skelett darüber, und beim Zurückkommen ist sie sofort sichtbar.
       *
       * Wird sie dagegen abgebaut (Tab verlassen, bevor sie fertig war — siehe
       * den Effekt darüber), ist das Skelett richtig: Dahinter ist dann wirklich
       * nichts.
       */
      if (!wasFullyLoadedRef.current) {
        setMapTilesRendered(false);
        // Und das Bauteil wieder scharf stellen, damit es nach dem Neuaufbau
        // wieder melden kann.
        mapRef.current?.rearm();
      }
      return;
    }
    if (!mapMounted) return;
    /**
     * Und beim Auftauen eine eigene Notbremse.
     *
     * Die des Kartenbauteils meldet pro Aufbau nur einmal — nach dem Auftauen
     * ist sie also verbraucht. Meldet MapLibre nach dem Neuaufbau seiner Fläche
     * aus irgendeinem Grund kein „fertig" mehr, läge das Skelett sonst für
     * immer über einer funktionierenden Karte. Vier Sekunden decken den
     * gemessenen Bereich (0,3 bis 4,7s pro Kachelsatz) mit ab.
     */
    /**
     * NACH dem Auftauen viel kürzer als beim ersten Aufbau.
     *
     * Die vier Sekunden sind für den KALTSTART bemessen — dort deckt sie der
     * gemessene Bereich von 0,3 bis 4,7s pro Kachelsatz. Nach einem Auftauen
     * gilt davon nichts: Die Kacheln liegen im Zwischenspeicher, die Kamera
     * steht, MapLibre hat nichts nachzuladen.
     *
     * Und genau hier lag der gemeldete Fehler: Beim Auftauen meldet die Karte
     * ihr „fertig" offenbar NICHT noch einmal (`react-freeze` baut den Baum
     * nicht ab, also entsteht auch keine neue GL-Fläche, die es melden könnte).
     * Was die Karte enthüllte, war deshalb nicht das Signal, sondern diese
     * Notbremse — bei jedem Tab-Wechsel aufs Neue, immer nach derselben
     * Zeitspanne. Genau das „exakt fünf Sekunden".
     *
     * Kurz genug, dass man es kaum sieht; lang genug, dass ein echter
     * Neuaufbau der Fläche noch dazwischenkommen darf.
     */
    let id: ReturnType<typeof setTimeout>;
    const reveal = () => {
      /**
       * Nicht, während etwas fährt.
       *
       * Diese Zeile ist ein Commit im Karten-Baum, und sie fällt Sekunden nach
       * dem Tab-Wechsel — also mit hoher Wahrscheinlichkeit in einen Moment, in
       * dem längst etwas anderes offen ist. Ungeprüft landete sie dann in
       * DESSEN Fahrt.
       */
      if (isTransitionBusy()) {
        id = setTimeout(reveal, 200);
        return;
      }
      // ERST HIER merken, nicht beim Stellen des Weckers.
      //
      // Beim schnellen Tab-Wechsel wird dieser Effekt mehrfach ab- und wieder
      // aufgebaut, und jeder Aufräumer nimmt seinen Wecker mit. Wurde der Merker
      // schon beim Stellen gesetzt, galt der allererste Kaltstart nach einem
      // einzigen abgebrochenen Anlauf bereits als „schon mal enthüllt" — die
      // Karte bekäme dann 700ms statt vier Sekunden und würde freigegeben,
      // bevor überhaupt eine Kachel da ist.
      everRevealedRef.current = true;
      setMapTilesRendered(true);
    };
    id = setTimeout(reveal, everRevealedRef.current ? 700 : 4000);
    return () => clearTimeout(id);
  }, [frozen, mapMounted]);
  /**
   * Hat die Fläche schon eine echte Größe?
   *
   * Das ist neuerdings nicht mehr selbstverständlich, und genau daran hing das
   * Problem mit den Kacheln. Solange die native Tab-Leiste da war, bekam jeder
   * Tab-Bildschirm feste Pixelmaße von ihr zugewiesen (`measuredDimensions`).
   * Mit eigener Leiste vergibt die Bibliothek stattdessen `width: "100%",
   * height: "100%"` — und Prozentwerte sind erst dann eine Größe, wenn der
   * Elternknoten eine hat. Im ersten Durchgang ist er 0.
   *
   * MapLibre nimmt seine Größe beim Anlegen der GL-Fläche EINMAL entgegen und
   * berechnet daraus, welche Kacheln es überhaupt braucht. Wird es mit 0×0
   * angelegt, fragt es nichts an — und holt das später auch nicht nach. Die
   * Karte blieb deshalb leer, obwohl sowohl Netz als auch Zwischenspeicher in
   * Ordnung waren. (Dass die Kacheln vorher OHNE Internet kamen, war der
   * entscheidende Hinweis: Es war nie ein Ladeproblem.)
   *
   * Also erst messen, dann anlegen.
   */
  const [hasSize, setHasSize] = useState(false);
  const onRootLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setHasSize(true);
  }, []);
  useEffect(() => {
    /**
     * Auch auf die Ortung warten — sonst startet die Karte auf Berlin.
     *
     * `initialViewState` bekommt die Nutzerkoordinate, und die steht bis zur
     * ersten Ortung auf dem Platzhalter (Berlin Hbf). Wer nicht in Berlin ist,
     * lud damit erst rund ein Megabyte Berliner Kacheln, bekam dann den Flug zur
     * echten Position — und warf alles Geladene weg. Ein paar hundert
     * Millisekunden später zu starten ist billiger als ein kompletter
     * Kachelsatz, der niemanden interessiert.
     */
    if (!isFocused || mapMounted || !hasSize) return;
    /**
     * Gewartet wird nur, wenn wir NOCH GAR KEINE Koordinate haben.
     *
     * Vorher hing das Mounten an `locationStatus !== "loading"` — also an der
     * KOMPLETTEN Ortungskette: Berechtigungsdialog, OS-Zwischenspeicher und
     * eine frische Messung mit acht Sekunden Deckel. Bis dahin baute sich die
     * Karte gar nicht erst auf, und man schaute sekundenlang auf das Skelett.
     *
     * Die Begründung darüber galt einer Fassung, in der `coord` bis zur ersten
     * Ortung auf einem PLATZHALTER stand (Berlin Hbf) — dann wäre ein früher
     * Start tatsächlich ein Kachelsatz für die falsche Stadt gewesen. Den
     * Platzhalter gibt es nicht mehr: `useUserLocation` startet mit der
     * gemerkten Koordinate aus der letzten Sitzung (`lastKnownCoord`, im
     * Speicher persistiert) oder mit `null`.
     *
     * Also: Liegt eine Koordinate vor, ist sie die des Nutzers — losbauen.
     * Liegt keine vor, warten wir die Ortung ab, weil ein Start ohne Ort auf
     * die Weltansicht führt und die zeigt in diesem Kartenstil nichts.
     */
    if (userCoord === null && locationStatus === "loading") return;
    // Ein Frame Defer damit der erste Tab-Commit das Skelett zeichnet
    // BEVOR wir die schwere MapLibre-Initialisation triggern.
    const id = requestAnimationFrame(() => setMapMounted(true));
    return () => cancelAnimationFrame(id);
  }, [isFocused, mapMounted, hasSize, locationStatus, userCoord]);

  // Tab-Tap soll sich sofort anfühlen. Marker-Swap (100+ native Views) ist
  // teuer und blockt sonst den Tap. useDeferredValue rendert die Marker
  // verzögert nach, während die Tab-UI sofort umspringt.
  const deferredMode = useDeferredValue(mode);

  // Effektiver Viewport für Backend-Calls — vor dem ersten Map-Idle-Event
  // nutzen wir den User-Standort als Default.
  /**
   * Ohne bekannten Standort UND ohne Kartenausschnitt gibt es nichts
   * abzufragen. Vorher stand hier der Platzhalter, die erste Umkreis-Abfrage
   * lief also für Berlin — für jeden Nutzer, überall.
   */
  const effectiveViewport: Viewport | null =
    viewport ??
    (userCoord
      ? {
          latitude: userCoord.latitude,
          longitude: userCoord.longitude,
          distance: DEFAULT_VIEWPORT_DISTANCE,
          zoom: DEFAULT_ZOOM,
        }
      : null);

  // Query-Key in grobe Buckets runden — Center auf ~500 m, Distanz auf 1 km.
  // Damit triggern kleine Pans (User wischt durch die Karte) keinen Refetch
  // mehr; erst nach signifikanter Bewegung kommt frische Daten.
  //
  // DIESELBEN vier Zahlen prüft `onRegionChange` weiter unten, bevor es
  // überhaupt einen Zustand setzt — über `viewportBucket`. Liefen die beiden
  // Rundungen auseinander, gäbe es entweder Abfragen ohne Anlass oder, schlimmer,
  // einen verschobenen Ausschnitt ohne Nachfrage.
  const keyLat = effectiveViewport ? Math.round(effectiveViewport.latitude * 200) / 200 : 0; // ~500m
  const keyLng = effectiveViewport ? Math.round(effectiveViewport.longitude * 200) / 200 : 0;
  const keyDistance = effectiveViewport
    ? Math.round(effectiveViewport.distance / 1000) * 1000
    : DEFAULT_VIEWPORT_DISTANCE;
  // Die STUFE, nicht der Zoom — siehe `zoomBand`. Der Vorgabewert geht denselben
  // Weg, sonst fragte der erste Aufruf mit einem Wert, den kein späterer je
  // wieder trifft.
  const keyZoom = zoomBand(effectiveViewport ? effectiveViewport.zoom : DEFAULT_ZOOM);

  // Zoom-abhängiges Marker-Limit: bei rausgezoomter Karte wollen wir viele
  // Train-Stationen für Clustering; unter zoom 9 zeigt der Server eh nichts.
  const zoomLimit = keyZoom >= 13 ? 60 : keyZoom >= 11 ? 200 : 400;

  const { data: fresh } = useQuery({
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
    // Eigene Aufbewahrungszeit statt der globalen 30 Minuten.
    //
    // Der Schlüssel dieser Abfrage enthält den Kartenausschnitt — jedes Schieben
    // und Zoomen erzeugt also einen NEUEN Eintrag, und jeder hält bis zu 400
    // Haltestellen fest. Mit 30 Minuten sammeln sich beim Erkunden der Karte
    // schnell hunderte davon an, die alle im Speicher bleiben. Das ist ein
    // Mechanismus, über den die App mit der Laufzeit tatsächlich langsamer wird.
    // Fünf Minuten decken das ab, was zählt: kurz wegzoomen und zurück.
    gcTime: 5 * 60 * 1000,
    // Erst fragen, wenn wir wissen WO. Vorher stand `coord` noch auf dem
    // Default USER_LOC (Berlin Hbf) — der erste Call ging also immer für Berlin
    // raus, egal wo der User ist, und war schlicht Müll. Sobald die Karte
    // einmal idle war (`viewport`) oder die Ortung durch ist (granted/denied/
    // error → dann gilt bewusst der Default), fragen wir.
    enabled:
      everFocused &&
      deferredMode === "transit" &&
      effectiveViewport != null &&
      (viewport !== null || locationStatus !== "loading"),
    retry: 1,
    placeholderData: (prev) => prev,
  });

  /**
   * Letzte erfolgreiche Antwort festhalten.
   *
   * Bei einem Query-FEHLER ist `data` undefined (placeholderData greift nur
   * während des Ladens, nicht im Error-State). Unten stand `if (!data) return []`
   * — ein einziger Aussetzer (WLAN-Hänger, 10s-Timeout) räumte damit die
   * komplette Karte leer und die Liste gleich mit: die Icons „verschwanden
   * random". Jetzt bleibt der letzte gute Stand stehen, bis wieder etwas
   * ankommt.
   */
  const lastGood = useRef<typeof fresh>(undefined);
  useEffect(() => {
    if (fresh) lastGood.current = fresh;
  }, [fresh]);
  const data = fresh ?? lastGood.current;

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
        detail: m.detail,
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
        // Zusatz nur bei gleichnamigem Halt daneben („Stop RA") — als die
        // vorhandene leise Plakette der Zeile, nicht im Namen.
        badge: l.detail,
        selected: l.selected,
      }));
    }
    return listForMode(mode, userCoord);
  }, [data, mode, userCoord]);

  /**
   * Eine Station auswählen — von der Karte ODER aus der Liste im Blatt.
   *
   * Beide Wege enden im selben Zustand; das war vorher nicht so, denn die Zeilen
   * im Blatt hatten überhaupt keine Wirkung. Sie und die Nadeln auf der Karte
   * teilen sich dieselbe Kennung, also genügt hier ein Nachschlagen.
   *
   * Der Unterschied ist nur die Kamera: Wer eine Nadel antippt, sieht sie schon
   * — da wäre ein Flug dorthin eine Bewegung ohne Anlass. Wer eine Zeile in der
   * Liste antippt, sieht die Station gerade NICHT, und genau darum geht es.
   *
   * Die Zoomstufen sind die Gegenstücke zu denen weiter unten, wo auf den
   * eigenen Standort geflogen wird: Bei Haltestellen will man die Straße
   * ringsum sehen, bei Flughäfen und Häfen den Ort in seiner Region.
   */
  const focusStopRef = useRef<(id: string, fly: boolean) => void>(() => {});
  const focusStop = useCallback(
    (id: string, fly: boolean) => {
      const m = markers.find((mm) => mm.id === id);
      if (!m) return;
      followUserRef.current = false;
      if (fly) lastCityFitRef.current = null;
      /**
       * Steht das Blatt schon offen, bleibt es, wo es ist — nur der Inhalt
       * wechselt, wie beim Tipp auf eine Stadt (`onCityPress`). Das kommt jetzt
       * oft vor: Das Blatt deckt die Karte nicht mehr ab, man tippt bei offenem
       * Blatt die nächste Haltestelle an.
       */
      // „Offen" = im Bild, nicht bloß im Store (siehe `onCityPress`).
      if (sheetTargets().stop == null) openStopSheet();
      /**
       * Erst das Blatt, dann der Flug: So kennt der freie Ausschnitt schon die
       * Höhe, auf die das Blatt fährt, und die Station landet in der Mitte
       * darüber statt an dessen Oberkante.
       */
      if (fly) {
        const zoom = mode === "transit" ? 15 : 11;
        mapRef.current?.flyTo(m.coord.latitude, m.coord.longitude, zoom, visiblePadding());
      }
      // Ohne eigenen Standort gibt es keine Entfernung — dann lieber keine
      // Angabe als eine, die von einem fremden Ort aus gerechnet ist.
      const here = latestCoordRef.current;
      const dist = here ? distanceMeters(here, m.coord) : null;
      selectStop({
        code: m.id,
        label: m.label ?? "",
        detail: m.detail,
        distanceMeters: dist == null ? undefined : Math.round(dist),
        kinds: m.kinds && m.kinds.length > 0 ? m.kinds : [m.type],
        // Für den Fußweg vom Standort dorthin (WalkPathLayer).
        latitude: m.coord.latitude,
        longitude: m.coord.longitude,
      });
    },
    [markers, mode, openStopSheet, selectStop, visiblePadding],
  );
  focusStopRef.current = focusStop;

  /**
   * Feste Kennungen für alles, was nach unten gereicht wird.
   *
   * Die drei Rückrufe standen als Pfeilfunktionen im JSX. Damit war jede
   * Eigenschaft bei jedem Render neu, und die `memo`-Hüllen an `MapSurface` und
   * `MarkerLayer` konnten nie greifen — die Karte samt ihrer ~20 Ebenen wurde
   * bei JEDEM Render dieses Bildschirms abgeglichen. Und der rendert oft: bei
   * jedem Stillstand der Karte, jedem Tipp auf einen der Knöpfe, jedem Wechsel
   * des Ortungs-Zustands.
   *
   * `focusStop` hängt an `markers`, wechselt also mit jeder Antwort. Für die
   * Karte liest es die Marker deshalb aus einer Ablage — sonst wäre auch diese
   * Kennung wieder bei jeder Antwort neu, und wir hätten nichts gewonnen.
   */
  const selectStopFromList = useCallback((id: string) => focusStopRef.current(id, true), []);
  /**
   * Ein Tipp auf eine Haltestelle öffnet ihr Blatt. Die Oberfläche bleibt im
   * Nur-Karte-Modus weg: Zurück holt sie NUR ein Tipp auf die freie Karte —
   * jedes Element auf der Karte (Haltestelle, Route, Stadt) ist kein solcher.
   */
  const selectStopFromMap = useCallback((id: string) => focusStopRef.current(id, false), []);
  /**
   * Die Freigabe des Skeletts liegt HIER, nicht im Kartenbauteil.
   *
   * Der Grund ist mechanisch: Solange eingefroren ist, verwirft `react-freeze`
   * jeden Durchgang des Unterbaums — ein Prop wie „du bist gerade angehalten"
   * käme dort nie an, das Kind behält seine alten Eigenschaften. Dieser
   * Bildschirm selbst ist NICHT eingefroren (der Riegel gilt seinen Kindern),
   * er weiß es also als Einziger.
   *
   * Und wissen muss es jemand: Eingefroren setzt Fabric den Baum nativ auf
   * `INVISIBLE`, MapLibre verliert im SurfaceView-Modus seine Fläche samt
   * GL-Kontext und kann nichts malen. Eine Meldung, die in diesem Zustand
   * eintrifft (die Notbremse des Kindes läuft weiter), bedeutet nicht, dass
   * etwas zu sehen ist.
   */
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  /**
   * Hat die Karte in diesem Aufbau je „fertig" gemeldet?
   *
   * Als Ablage, nicht als Zustand: Sie wird von keinem Effekt zurückgesetzt und
   * überlebt damit den Durchgang, in dem `mapTilesRendered` kurz auf falsch
   * steht. Zurückgesetzt wird sie genau dort, wo die Fläche wirklich verschwindet.
   */
  const wasFullyLoadedRef = useRef(false);
  const onMapRendered = useCallback(() => {
    wasFullyLoadedRef.current = true;
    if (frozenRef.current) return;
    setMapTilesRendered(true);
  }, []);

  /**
   * Ein Flugziel, das gerade nicht ausgeführt werden kann, geht nicht verloren.
   *
   * Die Auswahl aus dem Wähler kommt an, WÄHREND die Karte noch angehalten ist:
   * `confirmLocationPicker` ruft den Rückruf, bevor es den Auftrag räumt, und
   * eine angehaltene Karte hat keine Fläche, auf der sie fliegen könnte. Der
   * Aufruf lief damit ins Leere — man wählte einen Bahnhof und es passierte
   * nichts.
   *
   * Also merken und nachholen, sobald die Karte wieder läuft UND gemeldet hat,
   * dass sie fertig gezeichnet ist. Ist sie ohnehin wach (schnelle Auswahl,
   * bevor der Riegel greift), fliegt sie sofort.
   */
  const pendingFlyRef = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const flyToOrRemember = useCallback((lat: number, lng: number, zoom: number) => {
    followUserRef.current = false;
    lastCityFitRef.current = null;
    if (!frozenRef.current) {
      pendingFlyRef.current = null;
      mapRef.current?.flyTo(lat, lng, zoom, visiblePadding());
      return;
    }
    pendingFlyRef.current = { lat, lng, zoom };
  }, [visiblePadding]);
  useEffect(() => {
    if (frozen || !mapTilesRendered) return;
    const target = pendingFlyRef.current;
    if (!target) return;
    pendingFlyRef.current = null;
    // Die Fahrt setzt den Rand ohnehin neu — eine offene Angleichung entfällt.
    pendingRealignRef.current = false;
    mapRef.current?.flyTo(target.lat, target.lng, target.zoom, visiblePadding());
  }, [frozen, mapTilesRendered, visiblePadding]);

  // Beim ersten GPS-Fix auf den Standort fliegen — Zoom je nach Modus.
  // Wird übersprungen wenn eine Route aktiv ist (dann fitten wir auf die Route).
  // Wichtig: NICHT fliegen solange `locationStatus === "loading"`. Sonst
  // landet der User zuerst auf der Default-Coord (Berlin Hbf) und springt
  // erst nach Auflösung des echten GPS-Fixes an seine wahre Position.
  //
  // NUR EINMAL. Vorher flog die Karte bei JEDER Änderung der Koordinate — und die
  // kommt zweistufig: erst der Fix aus dem OS-Cache, bis zu acht Sekunden später
  // der frische. Wer in der Zwischenzeit einen Ort gesucht oder die Karte bewegt
  // hatte, wurde ohne Zutun zurück auf seine eigene Position gerissen. Dasselbe
  // bei jedem Antippen des Standort-Knopfes.
  const didInitialFlyRef = useRef(false);
  /** Wohin zuletzt geflogen wurde — Bezugspunkt für die Sperre unten. */
  const flownToRef = useRef<{ latitude: number; longitude: number } | null>(null);
  // Immer der neueste Fix — für Rückrufe, die ein await überdauern.
  const latestCoordRef = useRef(userCoord);
  latestCoordRef.current = userCoord;
  useEffect(() => {
    if (routeActive || liveActive) return;
    if (locationStatus === "loading") return;
    /**
     * ERST prüfen, ob die Karte überhaupt existiert — dann die Sperre setzen.
     *
     * Die Sperre stand VOR dem Zugriff auf die Karte, und die Karte gibt es zu
     * diesem Zeitpunkt garantiert noch nicht: Sie wird selbst erst gemountet,
     * wenn die Ortung fertig ist, und zwar über eine Bild-Anforderung — also
     * mindestens ein Bild NACH diesem Effekt. Der Flug lief damit immer ins
     * Leere, die Sperre war trotzdem verbraucht, und spätere Koordinaten wurden
     * abgewiesen. Die Karte blieb auf ihrer Startposition stehen.
     *
     * Der Effekt zwei Stellen weiter unten macht es richtig und prüft
     * `mapMounted` mit; hier war es nicht nachgezogen.
     */
    if (!mapMounted || !mapRef.current) return;
    // Kein Standort, kein Flug — sonst flöge die Karte an den Platzhalter.
    if (!userCoord) return;
    /**
     * Die Sperre gilt für DIESEN Ort, nicht für alle Zeiten.
     *
     * Die Koordinate kommt zweistufig: erst der Fix aus dem OS-Zwischenspeicher
     * (bis zu einer Viertelstunde alt), bis zu acht Sekunden später der frische.
     * Eine einmalige Sperre verbraucht der ERSTE — wer über Nacht in eine andere
     * Stadt gefahren ist, blieb damit auf der alten stehen, obwohl der richtige
     * Fix Sekunden später eintraf. Seit die Karte früher startet (siehe oben,
     * sie wartet die Ortung nicht mehr ab), ist genau das der Normalfall.
     *
     * Also: nachfliegen, wenn der neue Ort WEIT vom angeflogenen entfernt ist.
     * Ein Kilometer trennt sauber — GPS-Zittern und Genauigkeitssprünge liegen
     * darunter, ein anderer Stadtteil oder eine andere Stadt darüber. Wer die
     * Karte selbst bewegt hat, ist davon nicht betroffen: Dann steht sie
     * ohnehin dort, wo er sie hingezogen hat, und ein Ortswechsel dieser
     * Größenordnung passiert nicht beiläufig.
     */
    const flown = flownToRef.current;
    if (flown && distanceMeters(flown, userCoord) < 1000) return;
    flownToRef.current = userCoord;
    didInitialFlyRef.current = true;
    const zoom = mode === "transit" ? 13 : mode === "airport" ? 5 : 4;
    // In die Mitte des freien Ausschnitts, wie der Standort-Knopf.
    mapRef.current.flyTo(userCoord.latitude, userCoord.longitude, zoom, visiblePadding());
  }, [userCoord, routeActive, liveActive, locationStatus, mode, mapMounted, visiblePadding]);

  // Wenn eine Route gesetzt wird → Bounds berechnen und Karte darauf fitten.
  useEffect(() => {
    if (!routeActive || !mapMounted) return;
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
  }, [routeActive, mapMounted, pendingRoute]);

  // Tab-Switch: Zoom anpassen so dass der User die Marker sieht.
  //   - transit: nah ran (Zoom 13, Bushaltestellen-Distanz)
  //   - airport: regional (Zoom 5, Europa-Hubs sichtbar)
  //   - cruise: weiter raus (Zoom 4, Häfen über Kontinent verteilt)
  const handleModeChange = useCallback(
    (m: SheetMode) => {
      setMode(m);
      if (!userCoord) return;
      const zoom = m === "transit" ? 13 : m === "airport" ? 5 : 4;
      lastCityFitRef.current = null;
      mapRef.current?.flyTo(userCoord.latitude, userCoord.longitude, zoom, visiblePadding());
    },
    [userCoord, visiblePadding],
  );

  /**
   * Läuft gerade eine Ortung?
   *
   * Sie darf bis zu acht Sekunden brauchen, und der Knopf sah in dieser Zeit aus
   * wie immer — also tippte man nochmal, und jeder Tipp startete eine weitere
   * GPS-Abfrage. Jetzt läuft höchstens eine, und der Knopf zeigt das gedimmt an.
   *
   * Dass am Ende zum Standort geflogen wird, auch wenn die Karte inzwischen
   * woanders steht, bleibt ausdrücklich so: Genau darum hat man den Knopf
   * gedrückt. Ein Ausstieg bei zwischenzeitlicher Karten-Bewegung stand hier
   * kurz — er hätte den Knopf tot wirken lassen, wenn die Karte beim Tippen noch
   * ausrollt, denn auch dieses Ausrollen meldet eine Bewegung.
   */
  const locatingRef = useRef(false);
  const [locating, setLocating] = useState(false);
  const onLocate = useCallback(async () => {
    if (locatingRef.current) return;
    locatingRef.current = true;
    setLocating(true);
    try {
      /**
       * ZUERST fliegen, dann nachmessen — vorher war es umgekehrt.
       *
       * `refreshLocation()` wartet auf `getCurrentPositionAsync`, und das ist
       * mit acht Sekunden gedeckelt. Der Flug hing also hinter dieser Messung:
       * Man drückte den Knopf und es passierte bis zu acht Sekunden lang
       * nichts. Und weil ein zweiter Druck in dieser Zeit über `locatingRef`
       * verworfen wird, wirkte der Knopf dann ganz tot.
       *
       * Der zuletzt bekannte Punkt ist für „bring mich zurück" gut genug — er
       * stammt aus dem OS-Zwischenspeicher oder der letzten Messung. Die genaue
       * Messung zieht danach nach, aber nur, wenn sie nennenswert woanders
       * liegt; ein zweiter Flug über wenige Meter sähe wie ein Wackler aus.
       */
      /**
       * `glideTo` statt `flyTo`: Die Fahrt richtet sich jetzt nach dem Weg und
       * behält die Zoomstufe, wenn man schon nah dran war — siehe dort.
       */
      /**
       * Erst warten, bis die Karte wieder läuft. „Aktueller Standort" im
       * Suchfeld der Karte ruft hierher, während der Ortswähler die Karte noch
       * deckt — eingefroren kommt ein Kamerabefehl nicht an (derselbe Verlust,
       * gegen den `flyToOrRemember` Suchtreffer vormerkt). Höchstens anderthalb
       * Sekunden; danach wird trotzdem gefahren.
       */
      for (let waited = 0; frozenRef.current && waited < 1500; waited += 50) {
        await new Promise((done) => setTimeout(done, 50));
      }
      const known = latestCoordRef.current;
      let arrivesAt = Date.now();
      // Ab jetzt steht die Kamera auf dem Standort — siehe `followUserRef`.
      followUserRef.current = true;
      // Und der Rahmen einer Stadt gilt nicht mehr als das, was man sieht.
      lastCityFitRef.current = null;
      if (known) {
        arrivesAt +=
          mapRef.current?.glideTo(known.latitude, known.longitude, 14, visiblePadding()) ?? 0;
      }
      await refreshLocation();
      // Nach dem await steht in `userCoord` noch der ALTE Wert aus der Closure
      // des Renders, in dem dieser Rückruf entstand. Frisch aus dem Hook lesen.
      const fresh = latestCoordRef.current;
      if (!fresh) return;
      const moved =
        !known ||
        Math.abs(known.latitude - fresh.latitude) > 0.0008 ||
        Math.abs(known.longitude - fresh.longitude) > 0.0008;
      if (!moved) return;
      /**
       * Die Nachkorrektur erst, wenn die erste Fahrt ANGEKOMMEN ist.
       *
       * Die frische Messung kommt oft schon nach wenigen hundert Millisekunden
       * — also mitten in die laufende Fahrt. Ein neuer Kamerabefehl bricht die
       * alte dort ab, wo sie gerade ist, und startet mit neuer Kurve: Aus einer
       * ausrollenden Bewegung wurde ein Ruck. Jetzt rollt die erste zu Ende,
       * und die zweite ist ein kurzes, eigenes Nachgleiten über die paar
       * hundert Meter.
       */
      const wait = arrivesAt - Date.now();
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      // Inzwischen selbst woandershin geschaut? Dann nicht zurückreißen.
      if (!followUserRef.current) return;
      mapRef.current?.glideTo(fresh.latitude, fresh.longitude, 14, visiblePadding());
    } finally {
      locatingRef.current = false;
      setLocating(false);
    }
  }, [refreshLocation, visiblePadding]);

  // Fest gehalten — das Auswahlfenster ist `memo` (siehe dort).
  const locateAccessory = useMemo(
    () => <LocateFab onPress={onLocate} locating={locating} />,
    [onLocate, locating],
  );

  /**
   * NACHFÜHREN — der Standort bleibt in der Mitte des freien Ausschnitts.
   *
   * Öffnet, schließt oder rastet ein Blatt ein (oder geht die Oberfläche in
   * den Nur-Karte-Modus und zurück), ändert sich der freie Ausschnitt. Steht
   * die Kamera auf dem eigenen Standort, gleitet sie mit — ausgelöst vom ZIEL
   * der Blatt-Bewegung, also im selben Moment, in dem das Blatt losfährt.
   * Gemeldet: „schließe ich die Slide, soll die Kamera weich nachkorrigieren".
   *
   * Nicht, solange die Karte eingefroren ist (anderer Tab) — dort zeichnet
   * nichts, und eine Fahrt käme beim Zurückkehren als Sprung an.
   *
   * Steht die Kamera NICHT auf dem Standort und schließt das Haltestellen-
   * bzw. Stadt-Blatt, bleibt die Karte stehen — aber ihr Rand wird auf den
   * jetzt freien Ausschnitt gesetzt (`realignPadding`, ohne Bewegung). Sonst
   * galt weiter die Höhe des Blattes: Der gemeldete Mittelpunkt lag oben im
   * Bild, und die Haltestellen am unteren Rand wurden nicht geladen.
   */
  const lastStopTargetRef = useRef<number | null>(null);
  /** Rand-Angleichung fällig geworden, während die Karte eingefroren war (anderer Tab). */
  const pendingRealignRef = useRef(false);
  /**
   * Den Rand angleichen — erst wenn Karte und Blatt ruhen, und mit Gegenprobe
   * im Moment, in dem die Karte antwortet (`realignPadding` fragt sie
   * asynchron): kein Finger auf der Karte, keine Bewegung, kein Blatt offen.
   */
  const realignWhenQuiet = useCallback(() => {
    const ok = () =>
      !liveActiveRef.current &&
      !isMapMoving() &&
      !mapTouchRef.current &&
      !frozenRef.current &&
      sheetTargets().stop == null &&
      !followUserRef.current;
    whenMapQuiet(() => {
      // Nie in eine Bewegung oder unter einen Finger hinein — lieber bleibt
      // der alte Rand bis zur nächsten Fahrt.
      if (!ok()) return;
      mapRef.current?.realignPadding(visiblePadding() ?? { top: 0, bottom: 0, left: 0, right: 0 }, ok);
    });
  }, [visiblePadding]);
  useEffect(
    () =>
      subscribeViewport(() => {
        const stopNow = sheetTargets().stop;
        const stopClosed = lastStopTargetRef.current != null && stopNow == null;
        lastStopTargetRef.current = stopNow;
        // Live führt die Kamera selbst — das Blatt, das beim Start hinausfährt,
        // darf sie nicht anschließend zurechtrücken.
        if (liveActiveRef.current) return;
        if (frozenRef.current) {
          // Nachholen, sobald die Karte wieder läuft (siehe unten) — sonst
          // bliebe der Rand des Blattes stehen, und die Haltestellen am
          // unteren Bildrand würden nicht geladen.
          // Folgt die Kamera dem Standort, holt sie dort die Gleitfahrt nach.
          if (stopClosed || followUserRef.current) pendingRealignRef.current = true;
          return;
        }
        if (followUserRef.current) {
          const here = latestCoordRef.current;
          const pad = visiblePadding();
          if (!here || !pad) return;
          // Zoom 0 als Untergrenze: die Stufe bleibt, wie sie ist.
          mapRef.current?.glideTo(here.latitude, here.longitude, 0, pad);
          return;
        }
        if (!stopClosed) return;
        /**
         * Erst NACH der Ausfahrt: Die Kamera meldet danach einen neuen
         * Ausschnitt, und der lädt Haltestellen nach — ein React-Durchgang, der
         * mitten in der Ausfahrt des Blattes als Ruck zu sehen wäre.
         */
        setTimeout(realignWhenQuiet, SHEET_OUT.duration + 40);
      }),
    [visiblePadding, realignWhenQuiet],
  );
  /**
   * Die im eingefrorenen Zustand fällig gewordene Angleichung nachholen.
   *
   * Die Marke fällt erst IM Zeitgeber: Friert die Karte innerhalb der 300 ms
   * wieder ein, räumt React den Zeitgeber ab — und die Angleichung bleibt für
   * das nächste Auftauen vorgemerkt, statt verloren zu gehen.
   */
  useEffect(() => {
    if (frozen || !mapTilesRendered || !pendingRealignRef.current) return;
    const id = setTimeout(() => {
      pendingRealignRef.current = false;
      if (followUserRef.current) {
        const here = latestCoordRef.current;
        const pad = visiblePadding();
        if (here && pad) mapRef.current?.glideTo(here.latitude, here.longitude, 0, pad);
        return;
      }
      realignWhenQuiet();
    }, 300);
    return () => clearTimeout(id);
  }, [frozen, mapTilesRendered, realignWhenQuiet, visiblePadding]);

  /**
   * Der obere Knopf öffnet jetzt das KARTENTYP-BLATT statt binär umzuschalten.
   *
   * Vorher legte er `mapType` zwischen „standard" und „satellite" um — eine
   * Variable, die die Kartenfläche gar nicht las. Der Knopf tat also sichtbar
   * nichts außer sein eigenes Zeichen einzufärben.
   *
   * Fest (`useCallback` ohne Abhängigkeiten): Die Hülle des Blattes richtet an
   * dieser Funktion ihre Wisch-Geste und den Merker für die Zurück-Taste ein —
   * eine neue Funktion pro Durchgang täte das mitten in der Bewegung.
   */
  const openMapType = useCallback(() => {
    haptic("button");
    setMapTypeOpen(true);
  }, []);
  const closeMapType = useCallback(() => setMapTypeOpen(false), []);


  /**
   * Geraderücken. Der Knopf verschwindet NICHT von hier aus — er verschwindet,
   * weil die Karte danach „bin bei Norden" meldet und der Wächter oben den
   * Zustand umlegt. Ihn hier vorsorglich auszublenden wäre eine zweite
   * Wahrheit über dieselbe Sache; liefe die Bewegung ins Leere, wäre der Knopf
   * weg und die Karte weiter schief.
   */
  const onResetNorth = useCallback(() => {
    haptic("button");
    mapRef.current?.resetNorth();
  }, []);

  /**
   * Wird nach Pan/Zoom-Ende getriggert. Aus den Map-Bounds berechnen wir den
   * Such-Radius (Center → NE-Ecke = halbe Diagonale in Metern). Den geben wir
   * zusammen mit dem Zoom-Level ans Backend, das daraus passend filtert.
   */
  /**
   * Gibt es hier ein amtliches Luftbild? Fragt den Server (je Feld einmal) und
   * setzt `aerialMaxZoom` und `aerialOfficial` — Letzteres entscheidet, ob Esri
   * gezeigt wird. Aufgerufen am Ende jeder Bewegung und beim Umschalten auf die
   * Satellitenansicht (sonst bliebe Esri aus, bis man die Karte verschiebt).
   */
  const checkAerialCoverage = useCallback((r: { latitude: number; longitude: number; zoom: number }) => {
    if (mapStyleNameRef.current === "satellite" && r.zoom >= 13) {
      const fein = r.zoom >= 15 ? 200 : 50;
      const cell = `${fein}:${Math.round(r.latitude * fein)}:${Math.round(r.longitude * fein)}`;
      const known = coverageCacheRef.current.get(cell);
      if (known !== undefined) {
        setAerialMaxZoom((prev) => (prev === known.maxZoom ? prev : known.maxZoom));
        setAerialOfficial((prev) => (prev === known.amtlich ? prev : known.amtlich));
      } else if (coverageAskRef.current !== cell) {
        coverageAskRef.current = cell;
        /*
         * Bis die Antwort da ist, bleibt der bisherige Stand. Hier stand
         * einmal ein Zurücksetzen auf „unbekannt" — das blendete Esri bei
         * JEDEM neuen Feld aus und gleich wieder ein: Beim Verschieben und
         * beim Zoomen über Stufe 15 (dort wechselt die Feldgröße) flackerte
         * es. Über ein amtliches Bild legt sich Esri trotzdem nicht: Der Server
         * liefert dort je Kachel kein Esri aus (routes/imagery.ts), darunter
         * bleibt das bessere Bild sichtbar, und es kostet nichts.
         */
        fetchAerialCoverage(r.latitude, r.longitude)
          .then((c) => {
            // Eine unsichere Antwort (Landesquelle gerade nicht erreichbar) wird
            // nicht gemerkt und schaltet Esri nicht ein — beim nächsten Halt
            // wird neu gefragt.
            if (c.vorlaeufig) {
              if (coverageAskRef.current === cell) coverageAskRef.current = null;
              return;
            }
            const cache = coverageCacheRef.current;
            if (cache.size > 300) cache.clear();
            cache.set(cell, { maxZoom: c.maxZoom, amtlich: c.amtlich });
            if (coverageAskRef.current === cell) {
              setAerialMaxZoom((prev) => (prev === c.maxZoom ? prev : c.maxZoom));
              setAerialOfficial((prev) => (prev === c.amtlich ? prev : c.amtlich));
            }
          })
          .catch(() => {
            // Keine Antwort — dann bleibt die Grenze, wie sie war. Beim nächsten
            // Stillstand in diesem Feld wird neu gefragt.
            if (coverageAskRef.current === cell) coverageAskRef.current = null;
          });
      }
    }
  }, []);
  useEffect(() => {
    if (mapStyleName !== "satellite") return;
    // Der Stand von vorher gilt nicht mehr — neu fragen, ohne auf eine Bewegung zu warten.
    setAerialOfficial(null);
    coverageAskRef.current = null;
    const r = lastRegionRef.current;
    if (r) checkAerialCoverage(r);
  }, [mapStyleName, checkAerialCoverage]);

  const onRegionChange = useCallback((r: RegionInfo) => {
    // Die Bewegung ist zu Ende — wartende Kartendaten dürfen jetzt (`whenMapQuiet`).
    setMapMoving(false);
    liveZoom.report(r.zoom, true);
    liveZoom.setView(r.bearing, r.pitch);
    /**
     * Bis zur FERNSTEN Ecke. Der gemeldete Mittelpunkt ist der des freien
     * Ausschnitts (Kamera-Rand für Leiste und Blatt), nicht der des Bildes —
     * bis zur Nordost-Ecke allein reichte der Umkreis dann nicht bis an den
     * unteren Bildrand.
     */
    const [west, south, east, north] = r.bounds;
    const center = { latitude: r.latitude, longitude: r.longitude };
    const radius = Math.max(
      distanceMeters(center, { latitude: north, longitude: east }),
      distanceMeters(center, { latitude: north, longitude: west }),
      distanceMeters(center, { latitude: south, longitude: east }),
      distanceMeters(center, { latitude: south, longitude: west }),
    );
    // Distanz-Cap zoom-abhängig: Stadt-Zoom (13+) eng, Train-only-Bereich
    // (zoom 9-12) etwas weiter für Clustering. Unter zoom 9 zeigen wir eh
    // nichts mehr (siehe typesForZoom), also kein größerer Cap nötig.
    const cap = r.zoom >= 13 ? 20_000 : r.zoom >= 11 ? 50_000 : 120_000;
    // Immer mitschreiben — auch wenn unten nichts weiter passiert.
    lastRegionRef.current = {
      latitude: r.latitude,
      longitude: r.longitude,
      zoom: r.zoom,
      bearing: r.bearing,
      pitch: r.pitch,
    };

    /**
     * Zoomgrenze der Satellitenkarte — erst ab Stufe 15 gefragt.
     *
     * VOR dem Raster-Wächter weiter unten: Wer an Ort und Stelle hineinzoomt,
     * bleibt im selben Abfrage-Raster, und genau dann wird die Grenze gebraucht.
     * (Der Kompass stand früher aus demselben Grund hier; er hängt jetzt an
     * `onCameraFrame`.)
     *
     * Darunter ist die Grenze ohnehin weit weg, und ein Schwenk über ein Land
     * hinweg bräuchte sonst Dutzende Antworten, die niemand nutzt. Die Frage
     * geht je Feld nur einmal hinaus; eine Antwort, die zu spät kommt (man ist
     * längst woanders), wird verworfen. Gesetzt wird nur, wenn sich der Wert
     * ändert — ein gleicher Wert wäre ein Durchgang ohne Wirkung.
     */
    /*
     * Ab Stufe 13 statt 15: Dort beginnt die Esri-Ebene, und sie darf nur in
     * den Lücken laufen. Unter 15 genügt ein gröberes Feld (rund 2 km) — beim
     * Schwenken über eine Gegend sind es sonst zu viele Fragen.
     */
    checkAerialCoverage(r);

    /**
     * Live: keine Haltestellen-Abfragen. Die Folge-Kamera meldet jede Sekunde
     * einen neuen Ausschnitt; jede Abfrage baute Liste und Marker neu auf, die
     * gerade gar nicht zu sehen sind. Nur der Zoom zählt (Größe des Fahrzeugs).
     */
    if (liveActiveRef.current) {
      clearPendingViewport();
      return;
    }

    const next: Viewport = {
      latitude: r.latitude,
      longitude: r.longitude,
      distance: Math.min(cap, Math.max(200, Math.round(radius))),
      zoom: r.zoom,
    };
    /**
     * NUR setzen, wenn sich das Abfrage-Raster wirklich ändert.
     *
     * Vorher lief hier bei JEDER beendeten Kartenbewegung ein `setState` — und
     * damit ein Durchgang des ganzen Bildschirms samt Liste, Knöpfen und
     * Markierungs-Ableitung. Gebracht hat der in den meisten Fällen nichts: Der
     * Abfrage-Schlüssel ist auf ein ~500m-Raster gerundet, ein kurzer Wisch
     * bleibt also im selben Feld und holt ohnehin dieselben Daten.
     *
     * Der Durchgang fiel dabei in den unangenehmsten Moment — genau dann, wenn
     * die Karte gerade zum Stehen kommt und der Finger noch auf dem Glas liegt.
     * Das ist die Sorte Arbeit, die sich als Mikroruckler zeigt: kein Bild
     * fehlt ganz, aber eines kommt zu spät.
     *
     * Die Ecke, in der der Zustand stehen bleibt, ist unschädlich — sie liegt
     * definitionsgemäß im selben Rasterfeld und rundet auf denselben Schlüssel.
     */
    const bucket = `${Math.round(next.latitude * 200)}|${Math.round(next.longitude * 200)}|${Math.round(next.distance / 1000)}|${zoomBand(next.zoom)}`;
    if (bucket === viewportBucketRef.current) {
      // Zurück im Feld, das schon gilt — eine noch wartende Abfrage für ein
      // anderes Feld ist damit hinfällig.
      clearPendingViewport();
      return;
    }
    /**
     * ERST ABFRAGEN, WENN DIE KARTE WIRKLICH STEHT — 600 ms ohne Bewegung.
     *
     * „Bewegung beendet" meldet MapLibre nicht erst, wenn man aufhört, sondern
     * bei jeder kurzen Pause der Kamera — beim Hin- und Herwischen also etwa
     * einmal pro Sekunde, MITTEN in der Geste. Jede dieser Meldungen setzte hier
     * sofort den Ausschnitt, die Umgebungsabfrage lief, und mit den neuen Daten
     * baute das Blatt seine Haltestellenliste neu auf — rund dreißig Zeilen mit
     * SVG-Zeichen, auch wenn das Blatt eingeklappt ist. Mit Perfetto gemessen:
     * bis zu 444 neu angelegte Ansichten pro Sekunde, und genau in diesen
     * Sekunden Bilder von 25, 35 und 60 ms statt 8,3 — die großen Ruckler beim
     * Wischen.
     *
     * Jetzt wartet der Ausschnitt, bis 600 ms lang keine Kamerabewegung mehr
     * kam; jede neue bricht die Wartezeit ab (`onCameraMoveStart` an der
     * Karte). Beim Ausrollen nach einem Wisch kommt „Bewegung beendet" erst,
     * wenn die Karte steht, nicht schon beim Loslassen (Patch an
     * `MLRNMapView.kt`) — die Wartezeit beginnt also dort. Beim
     * Wischen wird damit gar nichts umgebaut, Liste und Haltestellen kommen
     * kurz nach dem Stillstand. Der allererste Ausschnitt geht sofort durch —
     * sonst stünde die Karte beim Öffnen eine halbe Sekunde ohne Haltestellen.
     */
    clearPendingViewport();
    if (viewportBucketRef.current === null) {
      viewportBucketRef.current = bucket;
      setViewport(next);
      return;
    }
    pendingViewportRef.current = setTimeout(() => {
      pendingViewportRef.current = null;
      viewportBucketRef.current = bucket;
      setViewport(next);
    }, VIEWPORT_SETTLE_MS);
  }, [clearPendingViewport, checkAerialCoverage, liveZoom]);

  return (
    <Freeze freeze={frozen}>
    {/**
      * KEIN eigenes `display: none` — das war wirkungslos.
      *
      * Der Gedanke war richtig: Solange die Karte verdeckt ist, soll Android
      * ihre Ansicht auf GONE setzen, damit nichts mehr gezeichnet wird. Nur
      * ist dieser `View` ein KIND von `<Freeze>` — und das wirft bei
      * `freeze === true`, bevor die Kinder überhaupt gerendert werden. Der
      * Stil erreichte den Commit also nie.
      *
      * Nötig ist er auch nicht: Fabric versteckt einen suspendierten Teilbaum
      * von sich aus über `cloneHiddenInstance` mit genau diesem `display:
      * none`. Das gewünschte Ergebnis war also die ganze Zeit da — nur nicht
      * aus dem Grund, der hier stand.
      */}
    <View style={styles.root} onLayout={onRootLayout}>
      {/* MapSurface mountet darunter, MapSkeleton liegt DARÜBER und fadet
          erst raus wenn MapLibre seine Tiles tatsächlich gerendert hat.
          So sieht der User nie blanke Tiles. */}
      {mapMounted && (
        /* Nur Mitschreiben, ob ein Finger auf der Karte liegt (siehe
           `mapTouchRef`) — die Hülle nimmt keine Berührung weg. */
        <View
          style={StyleSheet.absoluteFill}
          onTouchStart={onMapTouchStart}
          onTouchEnd={onMapTouchEnd}
          onTouchCancel={onMapTouchCancel}
        >
        <MapSurface
          /**
           * NEU AUFBAUEN statt den Stil unter der laufenden Karte austauschen —
           * und das ist kein Vorsichts-, sondern ein Absturz-Fix.
           *
           * MapLibre wirft beim Stilwechsel alle Ebenen des alten Stils weg.
           * Die Java-Hüllen der Kind-Ebenen (Nadeln, Standort, Häuser) bleiben
           * dabei bestehen und zeigen danach ins Leere; der nächste Abbau ruft
           * `Style.removeLayer` auf einem toten Zeiger auf und nimmt den Prozess
           * mit. Im Quelltext der Bibliothek ist das gut zu sehen:
           *
           *     override fun removeFromMap(mapView: MLRNMapView) {
           *         val layer = mLayer ?: return     // nur auf null geprüft
           *         this.style?.removeLayer(layer)   // Zeiger schon tot
           *     }
           *
           * Genau das zeigte der Absturzbericht: `removeViewAt` →
           * `removeFromMap` → `Style.removeLayer` → `Layer::get()` → SIGSEGV.
           *
           * Mit dem `key` erlebt keine Karte je einen Stilwechsel: Die alte wird
           * samt ihren Kindern abgebaut, solange ihr Stil noch gültig ist, und
           * die neue kommt mit dem neuen Stil zur Welt. Der Preis ist ein kurzer
           * Neuaufbau beim Umschalten des Kartentyps — für eine bewusste
           * Auswahl der richtige Tausch.
           */
          // Die Sprache gehört mit in den Schlüssel: Auch sie ist ein neuer Stil.
          key={`${mapStyleName}:${mapLocale}`}
          styleName={mapStyleName}
          locale={mapLocale}
          ref={mapRef}
          onRegionChange={onRegionChange}
          onCameraFrame={onCameraFrame}
          // Neue Bewegung — ein wartender Ausschnitt wäre verfrüht (siehe
          // `VIEWPORT_SETTLE_MS`).
          onCameraMoveStart={onMapCameraMoveStart}
          // Nur-Karte-Modus: ein Tipp auf die freie Karte holt die Oberfläche
          // zurück (siehe `onMapPress`).
          onMapPress={onMapPress}
          onCityPress={onCityPress}
          /**
           * Die Vektorkarte darf überall bis 20: Sie wird gezeichnet, nicht
           * gestreckt, und bleibt auf jeder Stufe scharf. Nur das Luftbild hat
           * eine Auflösung, an der die Grenze hängt.
           */
          maxZoom={Math.min(
            mapStyleName === "satellite"
              ? // In den Lücken trägt Esri bis zu seiner Grenze (meist 19).
                esriVisible
                ? Math.max(aerialMaxZoom, esriLayer?.maxzoom ?? 19)
                : aerialMaxZoom
              : 20,
            // Live-Flug: nicht über den Globus-Übergang hinaus — dort hebt der
            // Bogen-Shader die Fluglinie nicht mehr (lib/live/camera.ts).
            liveActive && liveModel?.kind === "plane" ? PLANE_MAX_ZOOM : 20,
          )}
          onMapRendered={onMapRendered}
          /**
           * Beim Neuaufbau NICHT wegspringen.
           *
           * `initialCenter` gilt pro Karten-Instanz, und durch den `key` oben
           * entsteht beim Wechsel des Kartentyps eine neue. Stünde hier nur der
           * Nutzer-Standort, führe die Karte bei jedem Umschalten dorthin
           * zurück — man verlöre die Stelle, die man sich gerade ansieht.
           * Deshalb zuerst der aktuelle Ausschnitt.
           */
          // Mit Drehung, Neigung und Rand der vorigen Karte — sonst spränge die
          // Ansicht um den halben Unterschied der Ränder (siehe `initialCenter`).
          initialCenter={
            lastRegionRef.current
              ? { ...lastRegionRef.current, padding: mapRef.current?.getPadding() }
              : (userCoord ?? undefined)
          }
        >
          {/**
            * IMMER GEMOUNTET, nur nicht immer SICHTBAR — der Schalter legt eine
            * Eigenschaft um, er baut keine Ebene ab.
            *
            * Auch das ist ein Absturz-Fix (siehe `key` an der Kartenfläche
            * oben): Jedes Abbauen einer Kind-Ebene führt in `removeFromMap`,
            * und das ist der Weg, auf dem die App gestorben ist. Eine Ebene,
            * die auf „unsichtbar" steht, kostet nichts und kann nicht abstürzen.
            *
            * Die Bedingung auf den Kartentyp bleibt trotzdem — sie ändert sich
            * nur gemeinsam mit dem `key`, also nie innerhalb einer Karte.
            *
            * IM LUFTBILD GAR NICHT — und die Bedingung steht hier, nicht nur im
            * Blatt.
            *
            * Die App stürzte ab, wenn Satellit und Häuser zusammen anstanden.
            * Der Schalter im Blatt ist dort zwar gesperrt, aber er ist nur die
            * Bedienung: Der gespeicherte Wert kann aus einer früheren Sitzung
            * stammen, in der Satellit noch nicht gewählt war. Die Ebene darf
            * deshalb an der Stelle nicht entstehen, an der sie gezeichnet wird.
            *
            * Inhaltlich verliert dabei nichts: Auf einem Luftbild stehen die
            * Häuser bereits im Bild. Graue Klötze darüber wären eine zweite,
            * schlechtere Darstellung derselben Sache.
            *
            * Häuser mit Höhe liegen VOR den Nadeln im Baum — und das ist keine
            * Formsache: Die Bibliothek hängt Kind-Ebenen in der Reihenfolge des
            * Baums in den Stil, die spätere liegt also OBEN. Stünde das hier
            * unten, wüchsen die Häuser ab Zoom 14 über die Haltestellen-Nadeln
            * und verdeckten genau das, wofür die Karte da ist.
            */}
          {/* Ganz unten unter den Kind-Ebenen: Esri in den Lücken (liegt per
              `afterId` direkt über den eigenen Luftbildern, unter allem anderen). */}
          {mapStyleName === "satellite" && esriLayer ? (
            <EsriImageryLayer
              key={esriLayer.ticket}
              ticket={esriLayer.ticket}
              tiles={esriLayer.tiles}
              minzoom={esriLayer.minzoom}
              maxzoom={esriLayer.maxzoom}
              attribution={esriLayer.attribution}
              visible={esriVisible}
            />
          ) : null}
          {mapStyleName !== "satellite" ? (
            <Buildings3DLayer styleName={mapStyleName} visible={buildings3d} />
          ) : null}

          {/* Unter allem anderen: der gepunktete Fußweg vom Standort. */}
          {walkTarget && userCoord && !routeActive && !liveActive ? (
            <WalkPathLayer from={userCoord} to={walkTarget} />
          ) : null}
          {/* Route-Modus: nur RouteLayer + UserPin; Stadt-Blatt: dessen
              Verbindungen; sonst MarkerLayer + POIs. Die Live-Ansicht zeigt
              nur ihr Fahrzeug — die Haltestellen bleiben dabei EINGEHÄNGT,
              nur unsichtbar (`hidden`): Sie ab- und beim Zurück wieder
              aufzubauen, lief auf dem UI-Strang genau während Blatt und
              Kamera fuhren. */}
          {routeActive && !liveActive ? (
            <RouteLayer
              waypoints={pendingRoute!.waypoints}
              legs={pendingRoute!.legs}
              mode={pendingRoute!.mode}
            />
          ) : selectedCity && !liveActive ? (
            cityRoutes ? (
              <CityRouteLayers routes={cityRoutes} onSelect={selectCityRoute} />
            ) : null
          ) : routeActive || selectedCity ? null : (
            <>
              <MarkerLayer
                key={deferredMode}
                markers={markers}
                onMarkerPress={selectStopFromMap}
                hidden={liveActive}
              />
            </>
          )}
          {liveActive && liveModel ? (
            <LiveVehicleLayer model={liveModel} zoom={liveZoom} running={liveRunning} nativeTag={liveNativeTag} />
          ) : null}
          {userCoord ? <UserPin coord={userCoord} /> : null}
        </MapSurface>
        </View>
      )}
      {/* Skelett liegt OBEN bis die Tiles wirklich gerendert sind, dann
          fadet es weg. Vorher sah der User "blanke Tiles" während MapLibre
          noch lud. */}
      {!mapTilesRendered && (
        <Animated.View
          style={StyleSheet.absoluteFill}
          exiting={FadeOut.duration(280)}
          pointerEvents="none"
        >
          <MapSkeleton />
        </Animated.View>
      )}

      {liveActive ? (
        <LiveOverlay
          session={liveSession!}
          model={liveModel}
          status={liveStatus}
          mapRef={mapRef}
          zoom={liveZoom}
          running={liveRunning}
          topInset={insets.top}
          bottomInset={insets.bottom}
          onBannerLayout={onRouteBannerLayout}
          onClose={closeLive}
        />
      ) : routeActive ? (
        <RouteBanner
          title={pendingRoute!.title ?? "Route"}
          waypointCount={pendingRoute!.waypoints.length}
          onBack={() => {
            // Surroundings-Flow (Direct-Trip ODER Booking ODER nur Stop offen):
            // wir haben den kompletten Overlay-State in den Stash geparkt
            // bevor die Route gezeigt wurde. Beim Back restoren wir alles
            // wieder — Slide + DetailsOverlay + LegTimelineOverlay tauchen
            // genau im selben Zustand wieder auf. KEINE Navigation, sonst
            // landet man bei der vorigen Tab (i.d.R. Home/Landing).
            const stash = useSearchStore.getState().stashedSurroundings;
            if (stash) {
              useSearchStore.getState().restoreSurroundings();
              /**
               * Das Blatt auch wieder HEREINFAHREN. Die Einfahrt startet nur
               * noch `openStopSheet()` (im Tipp-Moment, siehe dort) — das
               * Zurücklegen des Zustands allein ließ das Blatt unsichtbar
               * unter dem Rand stehen. Danach öffnete auch kein Tipp mehr eins:
               * Für den Store war es ja offen.
               */
              if (stash.selectedStop || stash.city) openStopSheet();
              clearRouteSoon();
              return;
            }

            // Search-Flow (User kam aus /search/results, z.B. via Card-Route-
            // Icon ODER via Details→LegTimeline→Show-on-Map). Navigation
            // zurück per `router.replace` mit previousHref — der explizite
            // Pfad ist hier zuverlässiger als `router.back()`, weil expo-
            // router in Tab-Navigation tab-separate Stacks führt und `back()`
            // innerhalb des Surroundings-Tabs zurückspringen würde statt zum
            // Search-Tab. Overlays sind global gemountet in app/_layout.tsx,
            // ihre Pathname-Wache zeigt sie automatisch wieder an sobald der
            // Pathname zu `selectedResultContext.pathname` passt.
            const target = pendingRoute!.previousHref;
            if (target) {
              router.replace({ pathname: target.pathname, params: target.params } as never);
            } else if (router.canGoBack()) {
              router.back();
            }
            // clearRoute DEFERRED — der Map-Reset würde sonst gleichzeitig mit
            // der Nav-Animation laufen und sichtbar ruckeln.
            clearRouteSoon();
          }}
          topInset={insets.top}
          onLayout={onRouteBannerLayout}
        />
      ) : (
        <GestureDetector gesture={chromePan}>
        <Animated.View
          style={[styles.searchWrap, { top: insets.top + 8 }, searchChromeStyle]}
          pointerEvents="box-none"
          onLayout={onSearchWrapLayout}
        >
          {/* Mit offener Stadt wird die Leiste zum Kasten der Ergebnisliste
              (Strecke, Datum, Reisende) — siehe CitySearchMorph.tsx. */}
          <CitySearchMorph>
          <SearchBar
            placeholderKey="surroundings.search.placeholder"
            showMic={false}
            // Fläche und Umrandung zeichnet die Verwandlung darunter.
            style={SEARCH_BAR_BARE}
            // Öffnet den GLOBALEN LocationPicker (Root-Host, app/_layout) —
            // der liegt visuell ÜBER der nativen Bottom-Tab-Bar. Vorher war
            // der Picker hier lokal im Tab gemountet: die Tab-Bar blieb
            // sichtbar und hob sich beim Keyboard-Öffnen nativ über die
            // Tastatur (Material NavigationBarView IME-Insets). Über den
            // Root-Host ist sie während der Suche komplett abgedeckt.
            // Textur des Pickers beim AUFSETZEN anlegen — derselbe Weg wie im
            // Such-Blatt. Ohne das öffnet der Picker von hier aus ohne Ebene und
            // wird während der ganzen Fahrt Bild für Bild neu gezeichnet.
            onTouchStart={() => {
              /**
               * ERST den Inhalt, DANN die Textur — dieselbe Reihenfolge wie im
               * Such-Blatt.
               *
               * Hier stand nur die Textur-Anforderung. Damit entstand sie aus
               * einem noch leeren Blatt und wurde vom Öffnungs-Commit sofort
               * wieder ungültig — genau der Fall, den `pickerPreload` als den
               * ursprünglichen Fehler beschreibt. Und seit der Inhalt erst beim
               * Berühren gebaut wird, lag dieser Aufbau von hier aus sogar
               * hinter dem Start der Fahrt.
               */
              preloadLocationPicker({
                sessionKey: 0,
                field: "from",
                mode: "ALL",
                suggested: POPULAR_LOCATIONS.ALL,
                title: t("surroundings.search.title"),
                leadingLabel: "",
                placeholderKey: "surroundings.search.placeholder",
                /**
                 * Die Zeile „Aktueller Standort" gehört MIT in den Vorlauf.
                 *
                 * Der Wirt behält beim Schließen den zuletzt bekannten Auftrag,
                 * damit der Inhalt während der Ausfahrt stehen bleibt. Fehlte der
                 * Rückruf hier, fiel er beim Schließen auf diesen Vorlauf zurück —
                 * und die Zeile verschwand im ersten Bild der Ausfahrt, also genau
                 * das Flackern, gegen das dieses Behalten gedacht ist.
                 */
                onCurrentLocation: onLocate,
              });
              requestAnimationFrame(() => prepareLayer("pickerLocation"));
            }}
            onPress={() =>
              openLocationPicker({
                field: "from",
                mode: "ALL",
                suggested: POPULAR_LOCATIONS.ALL,
                title: t("surroundings.search.title"),
                leadingLabel: "",
                placeholderKey: "surroundings.search.placeholder",
                /**
                 * „Aktueller Standort" — dieselbe Aufgabe wie der Knopf auf der
                 * Karte, also auch derselbe Rückruf. Er holt vorher einen
                 * frischen Fix; das Blatt hat sich zu dem Zeitpunkt schon
                 * geschlossen (der Picker schließt, bevor er ruft), man sieht
                 * also die Karte, während es passiert.
                 */
                onCurrentLocation: onLocate,
                onSelect: (loc: Location) => {
                  // Mode an den Treffer-Typ anpassen, damit das passende
                  // Marker-Icon an der Zielposition sichtbar ist (sonst
                  // springt die Map zwar hin, der User sieht aber das
                  // falsche Layer).
                  const nextMode: SheetMode =
                    loc.type === "FLIGHT"
                      ? "airport"
                      : loc.type === "CRUISE"
                        ? "cruise"
                        : "transit";
                  if (nextMode !== mode) setMode(nextMode);
                  const coord = resolveLocationCoord(loc);
                  if (!coord) return;
                  // Zoom-Level je nach Treffer-Typ: bei Flughäfen weiter
                  // raus (man will den Hub und Umgebung sehen), bei Bahnhof/
                  // Bushaltestelle näher dran (Stadt-Detail), bei Häfen mittel.
                  const zoom =
                    loc.type === "FLIGHT" ? 11 : loc.type === "CRUISE" ? 12 : 14;
                  flyToOrRemember(coord.latitude, coord.longitude, zoom);
                },
              })
            }
          />
          </CitySearchMorph>
        </Animated.View>
        </GestureDetector>
      )}


      {/* Erst, wenn die Leiste darüber vermessen ist — sonst stünde die Reihe
          ein Bild lang an einer geratenen Stelle und spränge dann. */}
      {topBarBottom != null ? (
        <MapFabs
          top={topBarBottom + ms(SPACE.md)}
          onOpenMapType={openMapType}
          bearing={cameraBearing}
          pitch={cameraPitch}
          onResetNorth={onResetNorth}
        />
      ) : null}

      {/* Das Blatt liegt NEBEN der Karte im Baum, nicht darin: Es ist ein
          Fenster (`Modal`) und gehört nicht in die Kartenfläche. */}
      <MapTypeSheet visible={mapTypeOpen} onClose={closeMapType} />

      {routeActive && !liveActive ? (
        /**
         * Im Routen-Modus gibt es kein Auswahlfenster, das den Standort-Knopf
         * halten könnte. Er steht dann im selben Abstand über der Tab-Leiste —
         * gleiche Ecke, gleicher Abstand, nur ohne Blatt dazwischen.
         */
        <View
          style={[
            styles.routeLocate,
            { bottom: ms(TAB_BAR_H) + insets.bottom + ms(SPACE.md) },
          ]}
          pointerEvents="box-none"
        >
          <LocateFab onPress={onLocate} locating={locating} />
        </View>
      ) : null}
      {!routeActive && !liveActive && !surroundingsHeld && (
        <SurroundingsSheet
          mode={mode}
          setMode={handleModeChange}
          items={listItems}
          onSelectStop={selectStopFromList}
          // Unten über dem Auswahlfenster, wie bei Google — das Blatt hält ihn
          // und führt ihn mit (siehe `accessory` dort).
          accessory={locateAccessory}
        />
      )}
    </View>
    </Freeze>
  );
}

/**
 * Ersatzwert für die Dauer einer Rahmen-Fahrt, falls die Karte (noch) keine
 * meldet. Die echte Dauer gibt `fitBounds` zurück (sie hängt am Weg); eine
 * zweite Fahrt startet erst danach (siehe `cityRouteKey`).
 */
const CITY_FIT_MS = 820;

/**
 * So lange (ms) nach der Einfahrt des Haltestellen-Blatts wartet das
 * Auswahlfenster beim Zurück aus Live noch — bis auch die Überblendung des
 * Kamera-Schnitts durch ist (mindestens 90 + 280 ms, siehe `coverCut`).
 */
const SURROUNDINGS_HOLD_EXTRA_MS = 300;

/** Zoom für eine Stadt ohne zweiten Punkt (kein Standort) — die Stadt im Überblick. */
const SINGLE_POINT_ZOOM = 11;
/** Luft zwischen Kasten und Strecke beim Einrahmen einer Stadt. */
const CITY_FIT_TOP_GAP = 24;

const styles = scaledStyles({
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
  routeLocate: {
    position: "absolute",
    right: 16,
    zIndex: 30,
  },
});
