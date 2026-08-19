import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { prepareLayer } from "@/lib/nav/transitionLayer";
import { preloadLocationPicker } from "@/lib/nav/pickerPreload";
import { View, StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, { FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { Freeze } from "react-freeze";
import { msSinceTabPress } from "@/lib/motion";
import {
  MapSurface,
  type MapLayerType,
  type MapSurfaceHandle,
  type RegionInfo,
} from "@/components/surroundings/MapSurface";
import { UserPin } from "@/components/surroundings/MapMarkers";
import { MarkerLayer } from "@/components/surroundings/MarkerLayer";
import { openStopSheet } from "@/components/surroundings/stopSheetAnimation";
import { RouteLayer } from "@/components/surroundings/RouteLayer";
import { RouteBanner } from "@/components/surroundings/RouteBanner";
import { MapFabs } from "@/components/surroundings/MapFabs";
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
import { AIRPORT_PINS } from "@/lib/surroundings/airportCoords";
import { CRUISE_PORT_PINS } from "@/lib/surroundings/cruisePortCoords";
import { fetchSurroundings } from "@/lib/api/client";
import { scaledStyles } from "@/lib/ui/compact";

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
const FREEZE_QUIET_MS = 500;

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

  const [viewport, setViewport] = useState<Viewport | null>(null);

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
  //     der letzte Tab-Tipp noch frisch ist (msSinceTabPress), der Commit landet
  //     also garantiert in einer ruhigen Phase.
  //  2. Aufgetaut wurde per State im Effekt: Der Screen rendete beim Zurück-
  //     kommen erst NOCH eingefroren, und erst der Effekt danach taute den
  //     kompletten Kartenbaum in einem zweiten Commit auf — beide im Wechsel-
  //     Frame. `frozen` ist jetzt abgeleitet, das Auftauen passiert im ersten
  //     Render, und es bleibt bei EINEM Commit.
  const [freezeArmed, setFreezeArmed] = useState(false);
  useEffect(() => {
    if (isFocused) {
      // Auftauen erledigt `frozen` unten schon. Gleicher Wert ⇒ React bailt raus.
      setFreezeArmed((armed) => (armed ? false : armed));
      return;
    }
    let id: ReturnType<typeof setTimeout>;
    const schedule = (delay: number) => {
      id = setTimeout(() => {
        if (msSinceTabPress() < FREEZE_QUIET_MS) {
          schedule(FREEZE_QUIET_MS);
          return;
        }
        setFreezeArmed(true);
      }, delay);
    };
    schedule(FREEZE_QUIET_MS);
    return () => clearTimeout(id);
  }, [isFocused]);
  /**
   * Auch einfrieren, wenn ein WÄHLER darüber liegt — nicht nur beim Tab-Wechsel.
   *
   * Der Ortswähler wird aus dieser Karte heraus geöffnet, also bei FOKUSSIERTEM
   * Tab. Der Riegel griff dort nie: Während der 250ms Einfahrt und der 220ms
   * Ausfahrt liefen der GL-Strang der Karte, die Marker-Ebene und die
   * Ausschnitts-Abfrage einfach weiter — unter einem deckenden Blatt, das man
   * ohnehin nicht durchschauen kann.
   *
   * Derselbe Wähler über dem Such-Bildschirm hat diesen Nachbarn nicht. Das ist
   * einer der Gründe, warum es sich hier schlechter anfühlt als dort.
   */
  const pickerOverMap = useSearchStore((st) => st.locationPickerRequest !== null);
  /** Liegt die Suche darüber? Dann ist die Karte sicher nicht zu sehen. */
  const searchOverMap = useSearchStore((st) => st.searchOverlayMode != null);
  const frozen = (!isFocused && freezeArmed) || pickerOverMap || searchOverMap;

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
  const [mapTilesRendered, setMapTilesRendered] = useState(false);
  useEffect(() => {
    if (frozen) {
      setMapTilesRendered(false);
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
    const id = setTimeout(() => setMapTilesRendered(true), 4000);
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
  const keyLat = effectiveViewport ? Math.round(effectiveViewport.latitude * 200) / 200 : 0; // ~500m
  const keyLng = effectiveViewport ? Math.round(effectiveViewport.longitude * 200) / 200 : 0;
  const keyDistance = effectiveViewport
    ? Math.round(effectiveViewport.distance / 1000) * 1000
    : DEFAULT_VIEWPORT_DISTANCE;
  const keyZoom = effectiveViewport ? Math.round(effectiveViewport.zoom) : DEFAULT_ZOOM;

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
      if (fly) {
        const zoom = mode === "transit" ? 15 : 11;
        mapRef.current?.flyTo(m.coord.latitude, m.coord.longitude, zoom);
      }
      openStopSheet();
      // Ohne eigenen Standort gibt es keine Entfernung — dann lieber keine
      // Angabe als eine, die von einem fremden Ort aus gerechnet ist.
      const here = latestCoordRef.current;
      const dist = here ? distanceMeters(here, m.coord) : null;
      selectStop({
        code: m.id,
        label: m.label ?? "",
        distanceMeters: dist == null ? undefined : Math.round(dist),
        kinds: m.kinds && m.kinds.length > 0 ? m.kinds : [m.type],
      });
    },
    [markers, mode, openStopSheet, selectStop],
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
  const onMapRendered = useCallback(() => {
    if (frozenRef.current) return;
    setMapTilesRendered(true);
  }, []);

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
    if (routeActive) return;
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
    mapRef.current.flyTo(userCoord.latitude, userCoord.longitude, zoom);
  }, [userCoord, routeActive, locationStatus, mode, mapMounted]);

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
      mapRef.current?.flyTo(userCoord.latitude, userCoord.longitude, zoom);
    },
    [userCoord],
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
      const known = latestCoordRef.current;
      if (known) mapRef.current?.flyTo(known.latitude, known.longitude, 14);
      await refreshLocation();
      // Nach dem await steht in `userCoord` noch der ALTE Wert aus der Closure
      // des Renders, in dem dieser Rückruf entstand. Frisch aus dem Hook lesen.
      const fresh = latestCoordRef.current;
      if (!fresh) return;
      const moved =
        !known ||
        Math.abs(known.latitude - fresh.latitude) > 0.0008 ||
        Math.abs(known.longitude - fresh.longitude) > 0.0008;
      if (moved) mapRef.current?.flyTo(fresh.latitude, fresh.longitude, 14);
    } finally {
      locatingRef.current = false;
      setLocating(false);
    }
  }, [refreshLocation]);

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
    <Freeze freeze={frozen}>
    <View style={styles.root} onLayout={onRootLayout}>
      {/* MapSurface mountet darunter, MapSkeleton liegt DARÜBER und fadet
          erst raus wenn MapLibre seine Tiles tatsächlich gerendert hat.
          So sieht der User nie blanke Tiles. */}
      {mapMounted && (
        <MapSurface
          ref={mapRef}
          mapType={mapType}
          showsTraffic={trafficOn}
          onRegionChange={onRegionChange}
          onMapRendered={onMapRendered}
          // Die Karte startet dort, wo der Nutzer ist — siehe `initialCenter`.
          initialCenter={userCoord ?? undefined}
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
              <MarkerLayer
                key={deferredMode}
                markers={markers}
                onMarkerPress={selectStopFromMap}
              />
            </>
          )}
          {userCoord ? <UserPin coord={userCoord} /> : null}
        </MapSurface>
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

      {routeActive ? (
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
        />
      ) : (
        <View
          style={[styles.searchWrap, { top: insets.top + 8 }]}
          pointerEvents="box-none"
        >
          <SearchBar
            placeholderKey="surroundings.search.placeholder"
            showMic={false}
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
                  mapRef.current?.flyTo(coord.latitude, coord.longitude, zoom);
                },
              })
            }
          />
        </View>
      )}


      <MapFabs
        topInset={insets.top}
        satelliteOn={mapType !== "standard"}
        trafficOn={trafficOn}
        onToggleLayers={onToggleLayers}
        onToggleTraffic={onToggleTraffic}
        onLocate={onLocate}
        locating={locating}
      />

      {!routeActive && (
        <SurroundingsSheet
          mode={mode}
          setMode={handleModeChange}
          items={listItems}
          onSelectStop={selectStopFromList}
        />
      )}
    </View>
    </Freeze>
  );
}

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
});
