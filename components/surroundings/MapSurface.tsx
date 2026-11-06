import {
  ReactNode,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Dimensions,
  Platform,
  StyleSheet,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
} from "react-native";
import {
  Map,
  Camera,
  Images,
  OfflineManager,
  type CameraRef,
  type MapRef,
} from "@maplibre/maplibre-react-native";
import { localizedName, mapStyleFor } from "./mapStyle";
import type { ResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import type { Locale } from "@/lib/i18n/dict";

/**
 * Marker-Icons — pro Marker-Typ direkt in seiner Zielfarbe gerendert
 * (kein SDF/Tinting nötig). PNGs werden via
 * `server/scripts/build-marker-icons.mjs` aus Lucide-SVG generiert.
 */
const MARKER_ICONS = {
  "marker-train": require("@/assets/marker-icons/train.png"),
  // Zug weiß — auf den Live-Punkten (Bernstein, Fernverkehr rot).
  "marker-train-white": require("@/assets/marker-icons/train-white.png"),
  "marker-bus": require("@/assets/marker-icons/bus.png"),
  // Bus weiß — auf dem lila Live-Punkt.
  "marker-bus-white": require("@/assets/marker-icons/bus-white.png"),
  "marker-tram": require("@/assets/marker-icons/tram.png"),
  "marker-airport": require("@/assets/marker-icons/airport.png"),
  "marker-cruise": require("@/assets/marker-icons/cruise.png"),
  // U-Bahn: weißes „U" (Live-Ansicht, Punkt weit draußen).
  "marker-subway": require("@/assets/marker-icons/subway.png"),
  // Haltestellen-Kästen: abgerundetes Quadrat, dicker weißer Rand, Symbol
  // eingebacken — je Verkehrsart ein Bild (siehe MarkerLayer).
  "marker-box-train": require("@/assets/marker-icons/box-train.png"),
  "marker-box-subway": require("@/assets/marker-icons/box-subway.png"),
  "marker-box-bus": require("@/assets/marker-icons/box-bus.png"),
  "marker-box-tram": require("@/assets/marker-icons/box-tram.png"),
  "marker-box-cruise": require("@/assets/marker-icons/box-cruise.png"),
  "marker-box-ferry": require("@/assets/marker-icons/box-ferry.png"),
  "marker-box-airport-lime": require("@/assets/marker-icons/box-airport-lime.png"),
  "marker-box-airport-mint": require("@/assets/marker-icons/box-airport-mint.png"),
  // Halt mit mehreren Verkehrsarten: weißer Rahmen, darin je Art ein Kasten.
  "marker-pill-2": require("@/assets/marker-icons/pill-2.png"),
  "marker-pill-3": require("@/assets/marker-icons/pill-3.png"),
  // Die Kästen im Rahmen — Symbole, weil sie per icon-offset nebeneinander
  // sitzen (circle-translate ist in MapLibre nicht datengetrieben).
  "marker-badge-train": require("@/assets/marker-icons/badge-train.png"),
  "marker-badge-subway": require("@/assets/marker-icons/badge-subway.png"),
  "marker-badge-bus": require("@/assets/marker-icons/badge-bus.png"),
  "marker-badge-tram": require("@/assets/marker-icons/badge-tram.png"),
  "marker-badge-ferry": require("@/assets/marker-icons/badge-ferry.png"),
  // Blickrichtungs-Kegel am Standortpunkt, je Akzentfarbe in drei Breiten für
  // die Unsicherheit des Kompasses. Erzeugt von
  // `server/scripts/build-heading-cone.mjs`, siehe `HeadingCone`.
  "heading-cone-lime-schmal": require("@/assets/marker-icons/heading-cone-lime-schmal.png"),
  "heading-cone-lime-mittel": require("@/assets/marker-icons/heading-cone-lime-mittel.png"),
  "heading-cone-lime-breit": require("@/assets/marker-icons/heading-cone-lime-breit.png"),
  "heading-cone-mint-schmal": require("@/assets/marker-icons/heading-cone-mint-schmal.png"),
  "heading-cone-mint-mittel": require("@/assets/marker-icons/heading-cone-mint-mittel.png"),
  "heading-cone-mint-breit": require("@/assets/marker-icons/heading-cone-mint-breit.png"),
  // Live-Ansicht: Fahrtrichtung am Fahrzeug-Punkt und das Flugzeug von oben —
  // erzeugt von `server/scripts/build-live-icons.mjs`, siehe LiveVehicleLayer.
  "live-arrow": require("@/assets/marker-icons/live-arrow.png"),
  "live-plane": require("@/assets/marker-icons/live-plane.png"),
  // Dauer-Blasen an den Routen des Stadt-Blatts, je Zeichenzahl eine Breite —
  // siehe server/scripts/build-route-pills.mjs. Ausgeschrieben, weil der
  // Bundler nur feste `require`-Pfade kennt.
  "route-pill-lime-2": require("@/assets/marker-icons/route-pill-lime-2.png"),
  "route-pill-lime-3": require("@/assets/marker-icons/route-pill-lime-3.png"),
  "route-pill-lime-4": require("@/assets/marker-icons/route-pill-lime-4.png"),
  "route-pill-lime-5": require("@/assets/marker-icons/route-pill-lime-5.png"),
  "route-pill-lime-6": require("@/assets/marker-icons/route-pill-lime-6.png"),
  "route-pill-lime-7": require("@/assets/marker-icons/route-pill-lime-7.png"),
  "route-pill-lime-8": require("@/assets/marker-icons/route-pill-lime-8.png"),
  "route-pill-lime-9": require("@/assets/marker-icons/route-pill-lime-9.png"),
  "route-pill-mint-2": require("@/assets/marker-icons/route-pill-mint-2.png"),
  "route-pill-mint-3": require("@/assets/marker-icons/route-pill-mint-3.png"),
  "route-pill-mint-4": require("@/assets/marker-icons/route-pill-mint-4.png"),
  "route-pill-mint-5": require("@/assets/marker-icons/route-pill-mint-5.png"),
  "route-pill-mint-6": require("@/assets/marker-icons/route-pill-mint-6.png"),
  "route-pill-mint-7": require("@/assets/marker-icons/route-pill-mint-7.png"),
  "route-pill-mint-8": require("@/assets/marker-icons/route-pill-mint-8.png"),
  "route-pill-mint-9": require("@/assets/marker-icons/route-pill-mint-9.png"),
  "route-pill-dark-2": require("@/assets/marker-icons/route-pill-dark-2.png"),
  "route-pill-dark-3": require("@/assets/marker-icons/route-pill-dark-3.png"),
  "route-pill-dark-4": require("@/assets/marker-icons/route-pill-dark-4.png"),
  "route-pill-dark-5": require("@/assets/marker-icons/route-pill-dark-5.png"),
  "route-pill-dark-6": require("@/assets/marker-icons/route-pill-dark-6.png"),
  "route-pill-dark-7": require("@/assets/marker-icons/route-pill-dark-7.png"),
  "route-pill-dark-8": require("@/assets/marker-icons/route-pill-dark-8.png"),
  "route-pill-dark-9": require("@/assets/marker-icons/route-pill-dark-9.png"),
  // Punkte eines Fußwegs — echte Kreise mit Rand, siehe
  // server/scripts/build-walk-dots.mjs.
  "walk-dot-lime-white": require("@/assets/marker-icons/walk-dot-lime-white.png"),
  "walk-dot-lime-black": require("@/assets/marker-icons/walk-dot-lime-black.png"),
  "walk-dot-mint-white": require("@/assets/marker-icons/walk-dot-mint-white.png"),
  "walk-dot-mint-black": require("@/assets/marker-icons/walk-dot-mint-black.png"),
};

export interface RegionInfo {
  /** Mitte des sichtbaren Viewports (lat/lng). */
  latitude: number;
  longitude: number;
  /** Sichtbares Bounding-Box: [west, south, east, north] */
  bounds: [number, number, number, number];
  /** Aktuelles Zoom-Level (typisch 0..22). */
  zoom: number;
  /**
   * Drehung in Grad (0 = Norden oben) und Neigung — beide für den Kompass.
   *
   * Sie lagen die ganze Zeit an und wurden weggeworfen: Die Nutzlast des
   * Ereignisses führt sie bereits (siehe `RegionChangeEvent`), nur dieses
   * Zwischenformat nannte sie nicht. Sie mitzunehmen kostet deshalb KEIN
   * zusätzliches Ereignis — und das ist der Punkt: Der Kompass hängt damit an
   * `onRegionDidChange`, das genau einmal am ENDE einer Bewegung feuert (nativ
   * `addOnCameraIdleListener`). Der naheliegende Weg über `onRegionIsChanging`
   * liefe pro Bild und schickte bei jeder Drehgeste sechzig vollständige
   * Nutzlasten über die Brücke — genau die Sorte Arbeit, die in dieser App
   * schon einmal als Mikroruckler vermessen wurde.
   */
  bearing: number;
  pitch: number;
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

export interface MapSurfaceHandle {
  /**
   * „Fertig gerendert" wieder scharf stellen — nach einem Einfrieren.
   *
   * Der Aufrufer weiß als Einziger, wann eingefroren wird; das Bauteil kann es
   * nicht erfahren, weil `react-freeze` seine Durchgänge verwirft. Siehe
   * `rearm` weiter unten.
   */
  rearm: () => void;
  /** Karte wieder nach Norden ausrichten (Drehung und Neigung auf null). */
  resetNorth: () => void;
  /**
   * Nur die NEIGUNG weich ändern — Mitte, Zoom und Drehung bleiben. Für
   * „3D-Gebäude an/aus" im Kartentyp-Blatt.
   */
  tiltTo: (pitch: number) => void;
  /**
   * Map auf eine Koordinate (lat/lng) zentrieren mit gewünschtem Zoom.
   *
   * `padding`: der verdeckte Rand (Leiste oben, Blatt unten) — der Punkt landet
   * dann in der Mitte dessen, was frei bleibt, statt in der Bildschirmmitte.
   * Ohne Angabe gilt wie bisher kein Rand. MapLibre behält den Rand für
   * spätere Bewegungen; jede Fahrt zu einem Punkt setzt ihn neu.
   */
  flyTo: (latitude: number, longitude: number, zoom?: number, padding?: CameraPadding) => number;
  /**
   * Zurück zu einem Punkt, dem Weg angemessen — für „zu meinem Standort".
   * Siehe die Umsetzung für die Regeln. Gibt die Dauer in Millisekunden zurück,
   * damit der Aufrufer eine Nachkorrektur erst danach starten kann.
   * `padding` wie bei `flyTo`.
   */
  glideTo: (
    latitude: number,
    longitude: number,
    minZoom?: number,
    padding?: CameraPadding,
  ) => number;
  /**
   * Den verdeckten Rand neu setzen, OHNE dass sich die Karte bewegt.
   *
   * MapLibre behält den Rand der letzten Fahrt. Nach dem Schließen eines
   * Blattes stand damit noch dessen Höhe als Rand da: Der gemeldete Mittelpunkt
   * lag im oberen Teil des Bildes (die Haltestellen wurden um ihn geladen, der
   * untere Rand blieb leer), und das Geraderücken drehte um diesen Punkt. Der
   * Mittelpunkt wandert deshalb genau um die Verschiebung des freien
   * Ausschnitts mit — im Bild ändert sich nichts.
   *
   * Nur im Stillstand und ohne Neigung (dort ist die Verschiebung nicht mehr
   * linear); sonst bleibt der alte Rand bis zur nächsten Fahrt.
   */
  realignPadding: (padding: CameraPadding, stillValid?: () => boolean) => void;
  /** Der zuletzt gesetzte Rand — für den Neuaufbau (siehe `initialCenter`). */
  getPadding: () => CameraPadding;
  /**
   * Map auf ein Bounding-Box zoomen (für Route-Übersicht). Gibt die Dauer der
   * Fahrt zurück — wer danach eine zweite anschließt, wartet so lange.
   */
  fitBounds: (
    sw: [number, number],
    ne: [number, number],
    /** Ein Wert für alle Seiten — oder je Seite, etwa unten die Höhe eines Blattes. */
    paddingPx?: number | { top: number; bottom: number; left: number; right: number },
  ) => number;
  /**
   * Die Kamera einem Fahrzeug nachführen (Live-Ansicht) — mit Zoom, Drehung
   * und Neigung. Mit `duration` fährt sie GLEICHMÄSSIG (`linear`) in genau
   * dieser Zeit: Der Aufrufer schickt jede Sekunde das nächste Ziel, und die
   * Fahrten schließen ohne Anfahren und Bremsen aneinander an. Ohne `duration`
   * ist es ein Anflug, dem Weg angemessen (wie `flyTo`). Gibt die Dauer zurück.
   *
   * `cut`: SCHNITT statt Fahrt — die Kamera springt, unter dem eingefrorenen
   * alten Bild, das weich ausblendet, sobald die neue Stelle gezeichnet ist
   * (Android, `MLRNMapView.coverCut`). Dauer dann 0. Für Wege, die sonst ein
   * Bogenflug wären (`isFar`): Der lädt mit Neigung auf jeder Zwischenstufe
   * Kacheln und lief Bild für Bild auf dem UI-Strang — zugleich mit dem Umbau
   * der Oberfläche beim Öffnen und Schließen der Live-Ansicht.
   */
  followTo: (target: {
    latitude: number;
    longitude: number;
    zoom: number;
    bearing: number;
    pitch: number;
    padding?: CameraPadding;
    duration?: number;
    cut?: boolean;
  }) => number;
  /** Wäre eine Fahrt dorthin ein Bogenflug (weiter Weg oder viele Stufen Zoom)? */
  isFar: (latitude: number, longitude: number, zoom: number) => boolean;
  /** Kennung der nativen Karte (für die 3D-Ebene der Live-Ansicht, `modules/live-models`). */
  nativeTag: () => number | null;
}

/** Verdeckter Rand der Karte in Punkten — siehe `flyTo`. */
export interface CameraPadding {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Eine angetippte Stadt — Name und Lage aus der Beschriftung der Karte. */
export interface MapCityPress {
  /**
   * Der ÖRTLICHE Name (`name` der Kachel). Mit ihm ordnet der Server Bahnhöfe
   * zu („Köln" → „Köln Hbf") — ein übersetzter Name fände sie nicht (so schon
   * passiert mit „Prague" statt „Praha").
   */
  name: string;
  /** Der Name, wie ihn die Karte zeigt — in der App-Sprache, nur zur Anzeige. */
  label: string;
  latitude: number;
  longitude: number;
}

interface Props {
  children?: ReactNode;
  /**
   * WELCHER Stil gezeigt wird — aufgelöst, also ohne „auto".
   *
   * Hier standen zwei Eigenschaften, die nichts taten: `mapType` („Reserved für
   * späteren Layer-Toggle") und `showsTraffic` („Reserved"). Beide wurden
   * gesetzt, durchgereicht und nie gelesen — der Knopf in der Karten-Reihe
   * schaltete also jahrelang eine Zustandsvariable um, die niemand ansah. Sie
   * sind ersetzt durch das, was wirklich gebraucht wird.
   *
   * Die Auflösung von „auto" gehört NICHT hierher, sondern an eine Stelle
   * (`lib/theme/mapStyleChoice.ts`): Auch das Blatt und die Knopfreihe brauchen
   * sie, und drei Kopien derselben Regel liefen auseinander.
   */
  styleName?: ResolvedMapStyle;
  /**
   * Die Sprache der Beschriftungen (Orte, Länder, Gewässer).
   *
   * Ein Wechsel ist für MapLibre ein neuer Stil — und einen Stilwechsel darf
   * eine Karte mit eingehängten Ebenen nicht erleben (siehe den `key` in
   * `surroundings.tsx`). Wer sie ändert, baut die Kartenfläche deshalb über
   * den `key` neu auf, genau wie beim Kartentyp.
   */
  locale: Locale;
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
  /**
   * Wo die Karte AUFGEHT — gilt nur beim Aufbau (`initialViewState`).
   *
   * Der Zoom gehört mit dazu, seit ein Wechsel des Kartentyps die Karte neu
   * aufbaut (siehe den `key` in `surroundings.tsx`): Ohne ihn fiele sie dabei
   * auf die Stadt-Stufe zurück, und wer sich gerade eine Straße ansieht, würde
   * beim Umschalten hinausgerissen.
   */
  initialCenter?: {
    latitude: number;
    longitude: number;
    zoom?: number;
    /**
     * Drehung, Neigung und Rand der vorigen Karte — beim Neuaufbau (Wechsel
     * des Kartentyps). Die gemeldete Mitte ist die des FREIEN Ausschnitts; ohne
     * denselben Rand stünde sie in der Bildmitte, und die Ansicht spränge um
     * den halben Unterschied.
     */
    bearing?: number;
    pitch?: number;
    padding?: CameraPadding;
  };
  /**
   * Wie tief hineingezoomt werden darf — siehe `appliedMaxZoom` für den
   * Übergang, wenn die Grenze sinkt, während man tiefer steht.
   */
  maxZoom?: number;
  /**
   * Drehung und Neigung bei JEDEM Kamerabild — für den Kompass, der sich
   * während einer Drehung mitdreht. Der Aufrufer soll damit nur einen
   * animierten Wert füttern, keinen React-Zustand: Das kommt sechzigmal pro
   * Sekunde. Der Zoom kommt kostenlos mit (dieselbe Meldung) — für die Größe
   * des Live-Fahrzeugs (`lib/live/zoomTrack.ts`).
   */
  onCameraFrame?: (bearing: number, pitch: number, zoom: number) => void;
  /**
   * Eine Kamerabewegung BEGINNT — Wischen, Zoomen, Drehen oder eine Fahrt.
   * Einmal pro Bewegung; ihr Ende meldet `onRegionChange`, das auf jeden
   * Beginn folgt.
   *
   * Beim Verschieben kommt `onCameraFrame` nicht mehr (nativ nur noch bei
   * Drehung und Neigung, siehe den Patch an `MLRNMapView.kt`) — wer eine
   * Wartezeit bei neuer Bewegung abbrechen will, braucht dieses Signal.
   */
  onCameraMoveStart?: () => void;
  /**
   * Ein Tipp auf die freie Karte — nicht auf eine Haltestelle (die meldet ihre
   * Quelle selbst, MapLibre schickt dann keinen Karten-Tipp mehr). Ein Wisch
   * ist kein Tipp.
   */
  onMapPress?: () => void;
  /**
   * Ein Tipp auf den NAMEN einer Stadt (Ebene `place-city`: Städte und
   * Kleinstädte). Stadtteile zählen nicht — ein Viertel der eigenen Stadt ist
   * kein Reiseziel. Ohne diesen Rückruf bleibt der Tipp ein Karten-Tipp.
   */
  onCityPress?: (city: MapCityPress) => void;
}

/**
 * Die Kurve für jede ANGETIPPTE Kamerafahrt — Norden, Standort, Zoomgrenze,
 * Modus, Route.
 *
 * MapLibres `ease` startet mit voller Geschwindigkeit und kriecht dann lange
 * aus: Die Karte ruckt im ersten Bild los. `smooth` fährt aus dem Stand an und
 * landet weich (Googles Material-Kurve). Es gibt sie nur auf Android — sie
 * steckt im Patch `patches/@maplibre+maplibre-react-native+11.2.1.patch`
 * (`CameraUpdateItem.runSmooth`), die iOS-Seite kennt sie nicht und bekäme
 * sonst gar keine Animation.
 */
const TAP_EASING = Platform.OS === "android" ? "smooth" : "ease";

/**
 * So lange hält ein Schnitt (`followTo` mit `cut`) das alte Bild
 * höchstens, wenn die neue Stelle nicht fertig wird (Kacheln aus dem Netz).
 * Danach blendet es trotzdem aus — lieber halb geladen als festgefroren.
 */
const CUT_MAX_HOLD_MS = 350;

/** Wohin die Kamera zuletzt zeigte — für Dauern, die vom Weg abhängen. */
interface CameraState {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** Web-Mercator auf 0…1 — nur für Abstände, deshalb ohne Kappung. */
function mercX(longitude: number): number {
  return (longitude + 180) / 360;
}
function mercY(latitude: number): number {
  const rad = (latitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}
const NO_PADDING: CameraPadding = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Dauer und Kurve einer Fahrt zu einem Punkt — dem Weg angemessen. Gemeinsam
 * für `glideTo` (Standort) und `flyTo` (Haltestelle, Suchtreffer, Stadt).
 *
 * Bis ein Bildschirm und ein halber Weg (und höchstens drei Stufen Zoom): direkt
 * (`TAP_EASING`), eine knappe halbe Sekunde als Sockel plus 220 ms je
 * Bildschirmbreite und 90 ms je Zoomstufe — ein kurzer Schwenk bleibt kurz,
 * ein Sprung übers halbe Land wird kein Wischer, in dem keine Kachel ankommt.
 * Darüber im Bogen (`fly`): kurz hinaus, hinüber, wieder hinein; die Dauer
 * wächst mit dem Logarithmus der Strecke, höchstens 2,6 Sekunden — über den
 * Globus von Kontinent zu Kontinent waren 1,8 Sekunden ein Gehetze.
 *
 * Die Weltbreite ist 512 · 2^Zoom Punkte (MapLibre rechnet Zoom in
 * 512er-Kacheln). Ohne bekannte Kamera: 700 ms direkt.
 */
function cameraMove(
  cam: CameraState | null,
  latitude: number,
  longitude: number,
  zoom: number,
): { duration: number; easing: "smooth" | "ease" | "fly" } {
  if (!cam) return { duration: 700, easing: TAP_EASING };
  const world = 512 * 2 ** cam.zoom;
  const dx = (mercX(longitude) - mercX(cam.longitude)) * world;
  const dy = (mercY(latitude) - mercY(cam.latitude)) * world;
  const screens = Math.hypot(dx, dy) / Dimensions.get("window").width;
  const zoomDelta = Math.abs(zoom - cam.zoom);
  if (screens <= 1.5 && zoomDelta <= 3) {
    return { duration: Math.round(450 + 220 * screens + 90 * zoomDelta), easing: TAP_EASING };
  }
  return {
    duration: Math.round(Math.min(2600, 900 + 240 * Math.log2(1 + screens))),
    easing: "fly",
  };
}

/**
 * Karte basierend auf MapLibre Native + OpenFreeMap-Tiles (kostenlos,
 * kein API-Key, OSM-Daten). Dark-Theme via inline Style JSON
 * (siehe `mapStyle.ts`).
 */
/**
 * Wie lange nach einer Bewegung auf „alle Kacheln da" gewartet wird, bevor der
 * Kachelspeicher zur Neuprüfung gezwungen wird — siehe `armStuckWatch`.
 *
 * Fünfzehn Sekunden, und die Zahl ist nicht geraten: Ein Kachelsatz braucht in
 * diesem Projekt gemessene 0,3 bis 4,7 Sekunden. Das Dreifache des schlechtesten
 * Falls trennt „langsames Netz" von „es kommt gar nichts mehr" — und selbst wenn
 * es daneben liegt, ist der Preis eine Neuprüfung.
 */
const STUCK_MS = 15_000;

/**
 * Sperrfrist zwischen zwei Neuprüfungen des Kachelspeichers — siehe
 * `healedAtRef`. Lang genug, dass daraus keine Schleife wird, kurz genug, dass
 * ein Fehlalarm die Nothilfe nicht für die Sitzung verbraucht.
 */
const HEAL_COOLDOWN_MS = 5 * 60_000;

const MapSurfaceInner = forwardRef<MapSurfaceHandle, Props>(function MapSurface(
  {
    children,
    styleName = "dark",
    locale,
    onRegionChange,
    onMapRendered,
    initialCenter,
    maxZoom = 18,
    onCameraFrame,
    onCameraMoveStart,
    onMapPress,
    onCityPress,
  },
  ref,
) {
  const cameraRef = useRef<CameraRef>(null);
  /**
   * Die Kamera, wie sie zuletzt gemeldet wurde — pro Bild und am Ende jeder
   * Bewegung. Als Ref, weil nichts davon gezeichnet wird.
   */
  /** Größe der Karte in dp — für `realignPadding`. */
  const mapSizeRef = useRef<{ width: number; height: number } | null>(null);
  /** Zählt Anfragen von `realignPadding` — nur die letzte gilt. */
  const realignGenRef = useRef(0);
  /**
   * Wohin die LAUFENDE Fahrt geht — und bis wann. Die Karte meldet ihren Stand
   * während einer weichen Fahrt nicht (nur bei Drehung/Neigung), `cameraStateRef`
   * steht bis zum Ende auf dem Startpunkt. Eine zweite Fahrt, die mittendrin
   * kommt (Blatt eingerastet → Standort nachführen), rechnete sonst vom Start
   * aus und zoomte etwa zurück auf die alte Stufe.
   */
  const moveTargetRef = useRef<{ latitude: number; longitude: number; zoom: number; until: number } | null>(
    null,
  );
  const baseCam = (): CameraState | null => {
    const cam = cameraStateRef.current;
    const t = moveTargetRef.current;
    if (cam && t && Date.now() < t.until) {
      return { ...cam, latitude: t.latitude, longitude: t.longitude, zoom: t.zoom };
    }
    return cam;
  };
  /**
   * Jede neue Kamerafahrt verwirft eine noch ausstehende Rand-Angleichung
   * (`realignPadding` wartet auf die Antwort der Karte) — sonst setzte die
   * Angleichung die Kamera danach zurück und brach die Fahrt ab.
   */
  /**
   * Läuft noch eine Fahrt, braucht die neue mindestens deren Rest: Sie startet
   * vom ECHTEN Zwischenstand (irgendwo unterwegs), `baseCam` rechnet aber vom
   * Ziel — die Dauer allein daraus wäre für den tatsächlichen Weg zu kurz.
   */
  const stretch = (ms: number) => {
    const t = moveTargetRef.current;
    return t && Date.now() < t.until ? Math.max(ms, Math.round(t.until - Date.now())) : ms;
  };
  const beginMove = (target: { latitude: number; longitude: number; zoom: number } | null, ms: number) => {
    realignGenRef.current += 1;
    moveTargetRef.current = target ? { ...target, until: Date.now() + ms } : null;
  };
  const onMapLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    mapSizeRef.current = { width, height };
  }, []);
  /** Der Rand der letzten Fahrt — MapLibre behält ihn (siehe `realignPadding`). */
  const paddingRef = useRef<CameraPadding>(initialCenter?.padding ?? NO_PADDING);
  const cameraStateRef = useRef<CameraState | null>(
    initialCenter
      ? {
          latitude: initialCenter.latitude,
          longitude: initialCenter.longitude,
          zoom: initialCenter.zoom ?? 13,
          bearing: initialCenter.bearing ?? 0,
          pitch: initialCenter.pitch ?? 0,
        }
      : null,
  );
  const onCameraFrameRef = useRef(onCameraFrame);
  onCameraFrameRef.current = onCameraFrame;
  const onCameraMoveStartRef = useRef(onCameraMoveStart);
  onCameraMoveStartRef.current = onCameraMoveStart;
  const onMapPressRef = useRef(onMapPress);
  onMapPressRef.current = onMapPress;
  const onCityPressRef = useRef(onCityPress);
  onCityPressRef.current = onCityPress;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const mapViewRef = useRef<MapRef>(null);

  /**
   * Hat der Tipp einen Ortsnamen getroffen?
   *
   * Gefragt wird ein Rechteck um den Finger, nicht der eine Bildpunkt: Eine
   * Beschriftung ist schmal, und ein Finger trifft selten genau auf einen
   * Buchstaben. 16 Punkte in jede Richtung — etwa eine Fingerkuppe. Liegen
   * mehrere Namen darin, gewinnt der, dessen Punkt dem Tipp am nächsten ist.
   */
  const handlePress = useCallback(
    async (e: NativeSyntheticEvent<{ point: [number, number]; lngLat: [number, number] }>) => {
      const onCity = onCityPressRef.current;
      if (onCity && mapViewRef.current) {
        const [x, y] = e.nativeEvent.point;
        const [lng, lat] = e.nativeEvent.lngLat;
        try {
          const hits = await mapViewRef.current.queryRenderedFeatures(
            [
              [x - 16, y - 16],
              [x + 16, y + 16],
            ],
            { layers: ["place-city"] },
          );
          let best: MapCityPress | null = null;
          let bestD = Infinity;
          for (const f of hits) {
            const name = f.properties?.name;
            if (typeof name !== "string" || f.geometry?.type !== "Point") continue;
            const [fLng, fLat] = f.geometry.coordinates as [number, number];
            const d = (fLng - lng) ** 2 + (fLat - lat) ** 2;
            if (d < bestD) {
              bestD = d;
              const label = localizedName(f.properties, localeRef.current) ?? name;
              best = { name, label, latitude: fLat, longitude: fLng };
            }
          }
          if (best) {
            onCity(best);
            return;
          }
        } catch {
          // Abfrage fehlgeschlagen — dann ist es eben ein Karten-Tipp.
        }
      }
      onMapPressRef.current?.();
    },
    [],
  );

  /**
   * Die Grenze, die die Kamera WIRKLICH bekommt — sie hinkt `maxZoom` beim
   * Absenken um eine Fahrt hinterher.
   *
   * `maxZoom` geht in der Bibliothek ohne Umweg an `setMaxZoomPreference`
   * (nachgelesen in `MLRNCamera.kt`). Steht man tiefer als die neue Grenze,
   * setzt MapLibre die Kamera beim nächsten Bild hart darauf — ein Sprung um
   * bis zu zwei Stufen. Das passiert hier genau dann, wenn man über einem
   * Orthofoto auf Stufe 20 steht und in ein Gebiet ohne schiebt. Deshalb erst
   * sanft auf die neue Grenze hinausfahren und sie danach setzen. Steigt die
   * Grenze, gilt sie sofort.
   */
  const [appliedMaxZoom, setAppliedMaxZoom] = useState(maxZoom);
  useEffect(() => {
    if (maxZoom >= appliedMaxZoom) {
      if (maxZoom !== appliedMaxZoom) setAppliedMaxZoom(maxZoom);
      return;
    }
    const cam = cameraStateRef.current;
    if (!cam || cam.zoom <= maxZoom + 0.01) {
      setAppliedMaxZoom(maxZoom);
      return;
    }
    try {
      // Als Fahrt anmelden — eine ausstehende Rand-Angleichung darf sie nicht abbrechen.
      beginMove(null, 450);
      void cameraRef.current?.setStop({ zoom: maxZoom, duration: 450, easing: TAP_EASING });
    } catch {
      // Karte noch nicht bereit — dann steht sie auch nicht zu tief.
    }
    const timer = setTimeout(() => setAppliedMaxZoom(maxZoom), 500);
    return () => clearTimeout(timer);
  }, [maxZoom, appliedMaxZoom]);
  const renderedFiredRef = useRef(false);
  /** Frist des schwächeren Signals — siehe `onDidFinishRenderingMap` unten. */
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Läuft die Frist des Kachel-Wächters? Und wurde schon geholfen? Beides
   *  steht hier oben, weil `rearm` weiter unten darauf zugreift. Begründung
   *  ausführlich an `armStuckWatch`. */
  const stuckRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * WANN zuletzt geholfen wurde — nicht OB.
   *
   * Hier stand ein einfaches „schon geholfen"-Ja/Nein, und das war zu starr:
   * Der Wächter wird beim Ende jeder Kamerabewegung scharf gestellt und nur
   * durch „alle Kacheln da" wieder entschärft. Kommt diese Meldung schon
   * VOR dem Stillstand der Kamera — beim Schieben, kurz halten, Finger heben —,
   * entschärft sie niemand mehr, und der Wecker feuert auf einer völlig
   * gesunden Karte. Mit einem Ja/Nein wäre die Nothilfe damit für den Rest der
   * Sitzung verbraucht, und zwar ausgerechnet, bevor der echte Fall eintritt.
   *
   * Ein Zeitpunkt mit Sperrfrist löst beides: Ein Fehlalarm kostet eine
   * Neuprüfung und ist danach vergessen, und eine Schleife aus Neuprüfungen
   * kann trotzdem nicht entstehen.
   */
  const healedAtRef = useRef(0);
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
    /**
     * Den Kachel-Wächter MIT entschärfen — und das ist kein Mitnehmen, sondern
     * genau sein Fehlalarm.
     *
     * Der Aufrufer ruft `rearm` in genau einem Fall: Die Fläche wird
     * eingefroren, BEVOR sie fertig geladen war (siehe `surroundings.tsx`).
     * Dann kommt kein „alle Kacheln da" mehr — nicht weil etwas kaputt ist,
     * sondern weil niemand mehr hinsieht. Liefe der Wächter weiter, verbrauchte
     * er die einmalige Nothilfe an einem Tab-Wechsel und hätte sie nicht mehr,
     * wenn es wirklich klemmt.
     */
    if (stuckRef.current) {
      clearTimeout(stuckRef.current);
      stuckRef.current = null;
    }
  }, []);

  /**
   * NOTHILFE gegen eine Karte, die nicht mehr nachlädt.
   *
   * DER BEFUND, der dazu geführt hat: Beim Hineinzoomen kamen keine neuen
   * Kacheln mehr — die Karte blieb unscharf (MapLibre streckt dann die Kachel
   * der gröberen Zoomstufe) —, und ein NEUSTART der App half nicht. Die Pins
   * vom eigenen Server standen gleichzeitig normal da, das Gerät hatte also
   * Netz.
   *
   * Was daran wichtig ist: Ein Neustart kann diesen Zustand gar nicht
   * aufheben. MapLibre führt seinen Kachelspeicher als SQLite-Datei auf der
   * Platte; er überlebt jeden App-Start. Was einmal darin steht — auch eine
   * abschlägige Antwort mit Ablaufdatum — wird bis zum Ablauf weiterbenutzt.
   * Die App hatte bisher KEINEN Weg, das aufzulösen: kein Fehlerereignis, das
   * sie behandelt, und keinen Griff an den Speicher.
   *
   * `invalidateAmbientCache` ist dafür das von der Bibliothek ausdrücklich
   * empfohlene Mittel (nachgelesen in `OfflineManager.ts`): Es LÖSCHT nichts,
   * es erzwingt eine Neuprüfung — die Kacheln bleiben also nutzbar, werden aber
   * frisch geholt statt blind weiterverwendet.
   *
   * EHRLICH DAZU: Der Auslöser selbst ließ sich hier nicht nachstellen (die
   * Kachelquelle antwortet von hier aus einwandfrei, auch die
   * Versions-Vermutung wurde widerlegt — der Datumsteil in der Kachel-URL wird
   * serverseitig gar nicht geprüft). Das hier heilt den Fall, in dem der
   * Speicher die Ursache ist, und kostet sonst einmal pro Sitzung ein paar
   * Nachfragen. Gegen eine blockierende Gegenstelle hilft nichts von hier aus.
   */
  const clearStuckWatch = useCallback(() => {
    if (stuckRef.current) {
      clearTimeout(stuckRef.current);
      stuckRef.current = null;
    }
  }, []);

  /**
   * Nach jeder Bewegung scharf stellen: Ab jetzt müssen Kacheln kommen.
   * `onDidFinishRenderingMapFully` nimmt den Wächter wieder weg — es feuert,
   * sobald ALLE sichtbaren Kacheln geladen und gemalt sind.
   */
  const armStuckWatch = useCallback(() => {
    // Höchstens alle fünf Minuten: Hilft es nicht, liegt es nicht am Speicher,
    // und eine Schleife aus Neuprüfungen macht ein schlechtes Netz schlechter.
    if (Date.now() - healedAtRef.current < HEAL_COOLDOWN_MS) return;
    clearStuckWatch();
    stuckRef.current = setTimeout(() => {
      stuckRef.current = null;
      healedAtRef.current = Date.now();
      void OfflineManager.invalidateAmbientCache().catch(() => {
        // Schlägt die Nothilfe fehl, bleibt es beim alten Zustand — sie darf
        // die Karte nicht mitreißen.
      });
    }, STUCK_MS);
  }, [clearStuckWatch]);

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
      // Den Kachel-Wächter mit abräumen — sonst liefe er über den Abbau der
      // Fläche hinaus und riefe in eine Karte hinein, die es nicht mehr gibt.
      if (stuckRef.current) {
        clearTimeout(stuckRef.current);
        stuckRef.current = null;
      }
    };
  }, [markRendered]);

  useImperativeHandle(
    ref,
    () => ({
      rearm,
      /**
       * Zurück nach Norden — Drehung UND Neigung auf null.
       *
       * `setStop` und nicht `flyTo`/`easeTo`: Bei denen ist die Mitte ein
       * PFLICHTFELD, und die Bibliothek reicht sie bedingungslos weiter. Ohne
       * Mitte ginge dort also `center: undefined` nach nativ, und die
       * Android-Seite prüft mit `hasKey` statt auf `null` — sie liefe in die
       * Umwandlung eines fehlenden Wertes. `setStop` baut dagegen auf der
       * AKTUELLEN Kameraposition auf und überschreibt nur die Felder, die man
       * angibt; Mitte und Zoom bleiben damit stehen, und genau das will man
       * hier: nur geraderücken, nicht wegfahren.
       *
       * Keine Flugbahn (`fly`): Ein Flug zoomt unterwegs heraus, und das ist
       * hier grober Unfug. Die Kurve ist `TAP_EASING`, siehe dort.
       *
       * Das `try` ist kein Schmuck: `setStop` wirft SYNCHRON, wenn die Karte
       * noch nicht aufgebaut ist — ein `.catch()` am Versprechen griffe da
       * nicht.
       *
       * DIE DAUER HÄNGT AM WINKEL. Hier standen feste 300 Millisekunden, und
       * das war für eine halbe Drehung ein Ruck: 180 Grad in 300 Millisekunden
       * sind 600 Grad pro Sekunde. Jetzt eine knappe halbe Sekunde als Sockel
       * plus gut zwei Millisekunden je Grad (und drei je Grad Neigung), höchstens
       * 900 — eine Vierteldrehung dauert damit rund 650 Millisekunden, eine
       * halbe gut 850. Die Kurve (`TAP_EASING`) fährt aus dem Stand an und
       * landet weich, der Kompass dreht sich dabei Bild für Bild mit (siehe
       * `onCameraFrame`).
       */
      resetNorth: () => {
        const cam = cameraStateRef.current;
        const bearing = cam ? ((cam.bearing % 360) + 360) % 360 : 0;
        const angle = Math.min(bearing, 360 - bearing);
        const tilt = cam?.pitch ?? 0;
        const duration = Math.round(Math.min(900, 450 + angle * 2.2 + tilt * 3));
        beginMove(null, duration);
        try {
          void cameraRef.current?.setStop({
            bearing: 0,
            pitch: 0,
            duration,
            easing: TAP_EASING,
          });
        } catch {
          // Karte noch nicht bereit — dann gibt es auch nichts geradezurücken.
        }
      },
      /**
       * Kippen ohne Wegfahren — derselbe Weg wie `resetNorth` (`setStop`
       * überschreibt nur die Neigung, Mitte und Zoom bleiben stehen).
       *
       * Für „3D-Gebäude": Anschalten kippt die Karte, damit man die Häuser
       * sofort stehen sieht; Ausschalten legt sie wieder flach. Das ersetzt den
       * Satz „mit zwei Fingern kippen" (Nutzer 05.11.2026: zu viel Text). Dauer
       * wie beim Geraderücken: Sockel plus drei Millisekunden je Grad.
       */
      tiltTo: (pitch) => {
        const from = cameraStateRef.current?.pitch ?? 0;
        if (Math.abs(from - pitch) < 1) return;
        const duration = Math.round(Math.min(900, 450 + Math.abs(pitch - from) * 3));
        beginMove(null, duration);
        try {
          void cameraRef.current?.setStop({ pitch, duration, easing: TAP_EASING });
        } catch {
          // Karte noch nicht bereit — dann gibt es nichts zu kippen.
        }
      },
      /**
       * Zurück zum Standort — und zwar so, wie der Weg es verlangt.
       *
       * Hier lief ein `flyTo` mit festen 600 Millisekunden auf festen Zoom 14,
       * egal von wo. Drei Dinge daran waren unrund:
       *
       * 1. Der ZOOM sprang. Wer auf Stufe 17 ein paar Straßen weiter geschaut
       *    hatte, wurde auf 14 hinausgerissen. Jetzt bleibt die Stufe, und nur
       *    wer weiter draußen stand, kommt auf `minZoom` herein.
       * 2. Die DAUER passte nicht zum Weg. Ein kurzer Schwenk in 600
       *    Millisekunden ist hastig, und über viele Bildschirme hinweg ist
       *    dieselbe Zeit ein Wischer, in dem keine einzige Kachel ankommt.
       *    Jetzt wächst sie mit der Strecke in Bildschirmbreiten.
       * 3. Weit weg schob `ease` die Karte flach über die ganze Strecke. Ab
       *    anderthalb Bildschirmen (oder mehr als drei Stufen Zoomwechsel)
       *    fliegt die Kamera deshalb im Bogen (`fly`): kurz hinaus, hinüber,
       *    wieder hinein — man sieht, wohin es geht. Das lädt Zwischenstufen
       *    (siehe `cameraMove`), aber nur bei diesem seltenen, gewollten Sprung.
       */
      glideTo: (latitude, longitude, minZoom = 14, padding) => {
        const cam = baseCam();
        const zoom = cam ? Math.max(cam.zoom, minZoom) : minZoom;
        const move = cameraMove(cam, latitude, longitude, zoom);
        const duration = stretch(move.duration);
        const easing = move.easing;
        beginMove({ latitude, longitude, zoom }, duration);
        // Mit Mitte setzt die Bibliothek immer einen Rand — ohne Angabe null.
        paddingRef.current = padding ?? NO_PADDING;
        try {
          void cameraRef.current?.setStop({
            center: [longitude, latitude],
            zoom,
            duration,
            easing,
            ...(padding ? { padding } : {}),
          });
        } catch {
          return 0;
        }
        return duration;
      },
      /**
       * Hier standen feste 600 ms, egal ob zwei Straßen weiter oder quer über
       * den Kontinent — weit weg ein Ruck, in dem keine Kachel ankommt. Jetzt
       * dieselbe Rechnung wie für den Standort (`cameraMove`).
       *
       * Die Kurve: `flyTo` der Bibliothek setzt von sich aus `easing: "fly"`,
       * die van-Wijk-Flugbahn — erst herauszoomen, quer hinüber, wieder
       * hineinzoomen. Unterwegs lädt die Karte JEDE Zwischenstufe der
       * Kachel-Pyramide. Für den Normalfall (Haltestelle antippen, ein paar
       * hundert Meter) ist das Verschwendung, deshalb dort `TAP_EASING`, direkt;
       * den Bogen gibt es nur für weite Sprünge, wo er zeigt, wohin es geht.
       */
      flyTo: (latitude, longitude, zoom = 13, padding) => {
        const move = cameraMove(baseCam(), latitude, longitude, zoom);
        const duration = stretch(move.duration);
        const easing = move.easing;
        beginMove({ latitude, longitude, zoom }, duration);
        paddingRef.current = padding ?? NO_PADDING;
        // Wirft SYNCHRON, solange die Karte nicht aufgebaut ist (wie `resetNorth`).
        try {
          void cameraRef.current?.flyTo({
            center: [longitude, latitude],
            zoom,
            duration,
            ...(padding ? { padding } : {}),
            easing,
          });
        } catch {
          return 0;
        }
        return duration;
      },
      getPadding: () => paddingRef.current,
      realignPadding: (next, stillValid) => {
        const cam = cameraStateRef.current;
        const size = mapSizeRef.current;
        if (!cam || !size || cam.pitch > 0.5) return;
        /**
         * Welcher Punkt liegt JETZT an der Mitte des neuen freien Ausschnitts?
         * Das fragt die Karte selbst (`unproject`) — exakt, auch gedreht.
         *
         * Nicht aus dem gemerkten alten Rand gerechnet: Der ist der ZIELWERT
         * der letzten Fahrt. Hielt ein Finger die Fahrt mittendrin an (die
         * Kamerakurve blendet den Rand Bild für Bild über), stand ein
         * Zwischenwert da, und die Rechnung ließ die Karte beim Schließen des
         * Blattes um bis zu hundert Punkte springen.
         */
        const x = next.left + (size.width - next.left - next.right) / 2;
        const y = next.top + (size.height - next.top - next.bottom) / 2;
        const gen = ++realignGenRef.current;
        mapViewRef.current
          ?.unproject([x, y])
          .then(([lng, lat]) => {
            // Inzwischen bewegt (neuer Kamerastand, neue Fahrt) oder neu angefragt:
            // lassen. Und die Gegenprobe des Aufrufers (Finger auf der Karte?
            // Blatt wieder offen?) — die Antwort der Karte kommt asynchron.
            if (gen !== realignGenRef.current || cameraStateRef.current !== cam) return;
            if (stillValid && !stillValid()) return;
            try {
              void cameraRef.current?.setStop({
                center: [lng, lat],
                padding: next,
                // Dauer null = `moveCamera`, ein einziges Bild.
                duration: 0,
              });
              paddingRef.current = next;
            } catch {
              // Karte nicht mehr bereit — dann bleibt der alte Rand.
            }
          })
          .catch(() => {
            // Karte noch nicht bereit — dann bleibt der alte Rand.
          });
      },
      fitBounds: (sw, ne, paddingPx = 60) => {
        const padding =
          typeof paddingPx === "number"
            ? { top: paddingPx, bottom: paddingPx, left: paddingPx, right: paddingPx }
            : paddingPx;
        paddingRef.current = padding;
        /**
         * Die Dauer hängt am WEG — wie bei `flyTo`/`glideTo` (`cameraMove`).
         * Hier standen feste 800 ms: Für eine Stadt am Bildrand, die samt
         * Standort ins Bild soll (weit schwenken UND mehrere Stufen hinaus),
         * war das ein Ruck. Das Ziel wird dafür geschätzt — Mitte und Zoom, auf
         * die der Rahmen passt. Die Kurve bleibt die weiche (zoom-bewusst im
         * Patch), ohne den Flugbogen: Die Fahrt geht ohnehin hinaus.
         */
        let duration = 800;
        const size = mapSizeRef.current;
        const cam = baseCam();
        let target: { latitude: number; longitude: number; zoom: number } | null = null;
        if (size && cam) {
          const wM = Math.abs(mercX(ne[0]) - mercX(sw[0])) * 512;
          const hM = Math.abs(mercY(sw[1]) - mercY(ne[1])) * 512;
          const availW = Math.max(1, size.width - padding.left - padding.right);
          const availH = Math.max(1, size.height - padding.top - padding.bottom);
          const zoom = Math.min(
            20,
            Math.log2(Math.min(availW / Math.max(wM, 1e-9), availH / Math.max(hM, 1e-9))),
          );
          const move = cameraMove(cam, (sw[1] + ne[1]) / 2, (sw[0] + ne[0]) / 2, zoom);
          // Bis 2,4 Sekunden: Von der Stadt auf eine Fernstrecke sind das elf
          // Stufen Zoom hinaus bis zum Globus — in 1,6 Sekunden ein Ruck.
          duration = Math.max(600, Math.min(2400, move.duration));
          target = { latitude: (sw[1] + ne[1]) / 2, longitude: (sw[0] + ne[0]) / 2, zoom };
        }
        duration = stretch(duration);
        beginMove(target, duration);
        try {
          void cameraRef.current?.fitBounds(
            // MapLibre erwartet [west, south, east, north]
            [sw[0], sw[1], ne[0], ne[1]],
            {
              padding,
              duration,
              easing: TAP_EASING,
            },
          );
        } catch {
          return 0;
        }
        return duration;
      },
      isFar: (latitude, longitude, zoom) => cameraMove(baseCam(), latitude, longitude, zoom).easing === "fly",
      nativeTag: () => mapViewRef.current?.getNativeTag() ?? null,
      followTo: ({ latitude, longitude, zoom, bearing, pitch, padding, duration, cut }) => {
        if (cut) {
          /**
           * SCHNITT: Erst das Bild einfrieren, dann springen — beide Aufträge
           * laufen auf dem UI-Strang in genau dieser Reihenfolge
           * (`ReactTagResolver.withViewResolved` → `runOnUiQueueThread`).
           * Ein kurzes Ziel für `baseCam`, bis die Karte ihre Ruhe meldet.
           */
          beginMove({ latitude, longitude, zoom }, 250);
          if (padding) paddingRef.current = padding;
          if (Platform.OS === "android") {
            void mapViewRef.current
              ?.createStaticMapImage({ output: `cut:${CUT_MAX_HOLD_MS}` as "file" })
              .catch(() => {});
          }
          try {
            void cameraRef.current?.setStop({
              center: [longitude, latitude],
              zoom,
              bearing,
              pitch,
              duration: 0,
              ...(padding ? { padding } : {}),
            });
          } catch {
            // wie unten: eine abgebaute Karte wirft
          }
          return 0;
        }
        let ms: number;
        let easing: "linear" | typeof TAP_EASING | "fly";
        if (duration != null) {
          ms = duration;
          easing = "linear";
        } else {
          const move = cameraMove(baseCam(), latitude, longitude, zoom);
          ms = stretch(Math.max(700, move.duration));
          easing = move.easing;
        }
        beginMove({ latitude, longitude, zoom }, ms);
        if (padding) paddingRef.current = padding;
        try {
          void cameraRef.current?.setStop({
            center: [longitude, latitude],
            zoom,
            bearing,
            pitch,
            duration: ms,
            easing,
            ...(padding ? { padding } : {}),
          });
        } catch {
          return 0;
        }
        return ms;
      },
    }),
    [],
  );

  return (
    <Map
      ref={mapViewRef}
      onLayout={onMapLayout}
      style={StyleSheet.absoluteFill}
      /**
       * TEXTUR statt eigener Oberfläche — das ist der schwarze Balken.
       *
       * MapLibre rendert auf Android standardmäßig in eine `GLSurfaceView`.
       * Die ist keine gewöhnliche Ansicht: Sie stanzt ein Loch in das Fenster
       * und wird vom System getrennt komponiert. Beim Tab-Wechsel bleibt dieses
       * Loch stehen, bis die Fläche wirklich zerstört ist — sichtbar als
       * schwarzes Rechteck am oberen Rand, dort wo die Karte unter die
       * Statusleiste reicht. Und solange es steht, hat der Compositor eine
       * zusätzliche Ebene zu verwalten.
       *
       * Genau das deckt sich mit dem Befund: Löst man die Fahrt aus, WÄHREND
       * der Balken zu sehen ist, ruckelt sie; wartet man, bis er weg ist, läuft
       * sie glatt. Der Balken war also nie ein zweiter Fehler, sondern das
       * sichtbare Zeichen dafür, dass die Karten-Oberfläche noch lebt.
       *
       * Als `TextureView` ist die Karte eine ganz normale Ansicht im Baum: kein
       * Loch, keine eigene Ebene, und sie verschwindet mit dem Tab-Wechsel
       * sofort. Der Preis ist eine zusätzliche Kopie beim Zeichnen — für eine
       * Karte, die die meiste Zeit stillsteht, ist das der günstigere Tausch.
       *
       * AUF DEM GERÄT VERGLICHEN (September 2026, Perfetto + Umschalter in der
       * App): Die eigene Oberfläche (`surface`) fühlte sich beim Wischen
       * schlechter an, nicht besser — die Karte stand dort in der
       * Pufferschlange des Displays (2,8 ms Warten je Bild, „Buffer Stuffing"),
       * jedes Bild kam einen Takt später. Mit der Textur ist die Kreisbewegung
       * nach dem Entfernen der Ereignisflut (siehe `patches/…maplibre…`) und
       * der Listen-Umbauten mitten im Wischen flüssig. Und NICHT mit
       * `preferredFramesPerSecond` bremsen: Das ist in der Textur nur ein
       * Warten nach jedem Bild, läuft gegen den Display-Takt und erzeugte bei
       * jedem neunten Bild einen Doppelschritt — gemessen und gespürt.
       */
      androidView="texture"
      /**
       * Der Stil kommt aus einem ZWISCHENSPEICHER je Aussehen und Sprache
       * (`mapStyleFor`) — nicht aus einem Aufruf pro Durchgang.
       *
       * Das ist kein Feinschliff: MapLibre lädt den Stil neu, wenn sich die
       * Kennung dieser Eigenschaft ändert. Ein `buildMapStyle(...)` an dieser
       * Stelle erzeugte bei jedem React-Durchgang ein neues Dokument — die
       * Karte würde ihre Kacheln immer wieder von vorn aufbauen.
       */
      mapStyle={mapStyleFor(styleName, locale)}
      compass={false}
      attribution
      logo={false}
      onRegionDidChange={(e: NativeSyntheticEvent<RegionChangeEvent>) => {
        // Ab hier müssen für den neuen Ausschnitt Kacheln kommen — siehe
        // `armStuckWatch`. Steht VOR dem Wächter unten, damit er auch dann
        // scharf wird, wenn niemand auf Ausschnitte hört.
        armStuckWatch();
        const v = e.nativeEvent;
        // Die Bewegung ist zu Ende — erreicht oder vom Finger abgebrochen. Ihr
        // Ziel gilt nicht mehr als Ausgangspunkt (siehe `baseCam`).
        moveTargetRef.current = null;
        cameraStateRef.current = {
          latitude: v.center[1],
          longitude: v.center[0],
          zoom: v.zoom,
          bearing: v.bearing,
          pitch: v.pitch,
        };
        onCameraFrameRef.current?.(v.bearing, v.pitch, v.zoom);
        if (!onRegionChange) return;
        onRegionChange({
          latitude: v.center[1],
          longitude: v.center[0],
          bounds: v.bounds,
          zoom: v.zoom,
          // Kostenlos mitgenommen — siehe `RegionInfo`.
          bearing: v.bearing,
          pitch: v.pitch,
        });
      }}
      // Einmal pro Bewegung — siehe `onCameraMoveStart`.
      onRegionWillChange={() => onCameraMoveStartRef.current?.()}
      // Über Refs, damit ein neuer Rückruf die Karte nicht neu rendert.
      onPress={handlePress}
      /**
       * Pro Kamerabild MIT Drehung oder Neigung — für den Kompass und die
       * Dauer von `resetNorth`.
       *
       * Beim reinen Verschieben kommt es nicht: Der Patch an `MLRNMapView.kt`
       * (`sendRegionIsChangingIfTurned`) schickt es nur, wenn sich Drehung
       * oder Neigung geändert haben — vorher waren es rund 200 vollständige
       * Nutzlasten pro Sekunde, ohne dass sich am Kompass etwas tat. Hier wird
       * daraus nur ein Ref und ein Aufruf, der einen animierten Wert setzt —
       * kein Zustand, kein Durchgang.
       */
      onRegionIsChanging={(e: NativeSyntheticEvent<RegionChangeEvent>) => {
        const v = e.nativeEvent;
        const cam = cameraStateRef.current;
        if (cam) {
          cam.latitude = v.center[1];
          cam.longitude = v.center[0];
          cam.zoom = v.zoom;
          cam.bearing = v.bearing;
          cam.pitch = v.pitch;
        } else {
          cameraStateRef.current = {
            latitude: v.center[1],
            longitude: v.center[0],
            zoom: v.zoom,
            bearing: v.bearing,
            pitch: v.pitch,
          };
        }
        onCameraFrameRef.current?.(v.bearing, v.pitch, v.zoom);
      }}
      onDidFinishRenderingMapFully={() => {
        // Feuert wenn alle sichtbaren Tiles geladen + die Karte einmal
        // vollständig gepaintet ist. Nur einmal aufrufen — danach feuert
        // das Event bei jedem Pan/Zoom erneut.
        //
        // Genau dieses „danach" ist der Grund, warum der Wächter hier hängt:
        // Es ist das einzige Signal der Bibliothek, das sagt „alle sichtbaren
        // Kacheln sind da". Kommt es nach einer Bewegung nicht, kommen keine.
        clearStuckWatch();
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
        /**
         * DAS LUFTBILD ENDET BEI ZOOM 18 — ÜBER EINEM ORTHOFOTO ERST BEI 20.
         * Die Vektorkarte darf überall bis 20; sie wird gezeichnet, nicht
         * gestreckt.
         *
         * Die Grenze kommt als `maxZoom` vom Aufrufer, und der fragt dafür den
         * Server (`/api/tiles/aerial/abdeckung`): Nur dort, wo wirklich ein
         * amtliches Luftbild mit 10 bis 25 Zentimetern liegt, zeigen zwei
         * Stufen mehr noch etwas. Überall sonst gilt, was folgt.
         *
         * Ohne diese Grenze läuft MapLibre bis Stufe 22, und dort zeigt die
         * Karte nur noch vergrößerte Bildpunkte. Wie stark, hängt davon ab, wo
         * man ist, und die Rechnung ist eindeutig: Bei Stufe 18 ist ein
         * Bildpunkt auf dem Schirm 0,18 Meter groß. Wo ein amtliches Orthofoto
         * liegt (10 bis 25 Zentimeter), passt das genau. Wo nur die europaweite
         * Schicht mit 2 Metern liegt — Großbritannien, Griechenland, der Balkan
         * —, wird jeder Quellpunkt schon hier elffach aufgeblasen, bei Stufe 20
         * vierundvierzigfach.
         *
         * Nachgeschärft werden kann das nicht: gemessen an einer Kachel aus
         * Birmingham steigt der mittlere Bildgradient durch eine Schärfung von
         * 0,76 auf 0,78. Es gibt keine feinen Strukturen, die man verstärken
         * könnte — sie sind in den Daten nicht enthalten. Die Grenze ist die
         * ehrliche Antwort.
         *
         * Die Kachelstufe liegt eine über der Kartenstufe (MapLibre rechnet bei
         * 256er-Kacheln `z + 1`), bei der Obergrenze 18 also 19 — genau dort, wo
         * die meisten Landesdienste ihre Pyramide enden lassen.
         */
        maxZoom={appliedMaxZoom}
        initialViewState={{
          // Ohne bekannten Standort bleibt es bei einem weit herausgezoomten
          // Blick statt bei einer fremden Stadt: Das ist ehrlicher als ein Ort,
          // an dem der Nutzer nicht ist, und lädt keinen Kachelsatz, den
          // niemand braucht.
          center: initialCenter
            ? [initialCenter.longitude, initialCenter.latitude]
            : [0, 20],
          zoom: initialCenter ? (initialCenter.zoom ?? 13) : 1,
          ...(initialCenter?.bearing ? { bearing: initialCenter.bearing } : {}),
          ...(initialCenter?.pitch ? { pitch: initialCenter.pitch } : {}),
          ...(initialCenter?.padding ? { padding: initialCenter.padding } : {}),
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
