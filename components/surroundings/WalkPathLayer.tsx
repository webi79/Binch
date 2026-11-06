import { memo, useEffect, useMemo, useState, type ComponentProps } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchWalkRoute } from "@/lib/api/client";
import { SHEET_IN } from "@/lib/nav/overlayCover";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";
import { whenMapQuiet } from "@/lib/surroundings/mapViewport";
import { useAccent } from "@/lib/theme/accent";
import { useResolvedMapStyle } from "@/lib/theme/mapStyleChoice";
import { useSearchStore } from "@/stores/searchStore";
import {
  LINE_SOURCE_MAXZOOM,
  LINE_SOURCE_TOLERANCE,
} from "@/components/surroundings/lineSourceTuning";

/**
 * Der Fußweg vom eigenen Standort zu einer Station — GEPUNKTET und entlang der
 * Straßen, wie Google Maps ihn zeichnet.
 *
 * Zwei Anlässe, derselbe Weg:
 *   • eine Haltestelle ist angetippt → der Weg dorthin;
 *   • das Stadt-Blatt ist offen → der Weg zur Startstation der gewählten
 *     Verbindung.
 *
 * Die Geometrie rechnet der Server über MOTIS (`/api/walk`, OSM-Fußwege). Über
 * rund 5 km Luftlinie gibt es keinen — das ist kein Fußweg mehr.
 *
 * PUNKTE statt Strich — echte Kreise mit Rand, siehe `useWalkDotLayout`. So
 * unterscheidet sich der Fußweg auf einen Blick von einer Fahrt, die
 * durchgezogen ist.
 *
 * Antippbar ohne Wirkung — nur, damit ein Tipp auf den Weg kein Tipp auf die
 * freie Karte ist (der holte im Nur-Karte-Modus die Oberfläche zurück).
 */

type Coord = { latitude: number; longitude: number };

/**
 * Die Punkte eines Fußwegs — für diesen Weg UND die Fuß-Etappen einer Route
 * (`RouteLayer`), damit ein Fußweg überall gleich aussieht.
 *
 * Als SYMBOL entlang der Linie, nicht als gestrichelte Linie: Striche der Länge
 * null zeichnete MapLibre bei zoomabhängiger Breite als verzogene Striche statt
 * Kreise, und einen Rand je Punkt kann eine Linie nicht haben. Das Bild ist ein
 * Kreis in der Akzentfarbe mit Rand (server/scripts/build-walk-dots.mjs);
 * MapLibre setzt es im festen BILDSCHIRM-Abstand, wie Google Maps.
 *
 * Der Rand hebt sich von der Karte ab: schwarz auf der hellen, weiß auf der
 * dunklen und auf dem Luftbild.
 *
 * Größe und Abstand wachsen mit dem Zoom (das Bild ist dreifach aufgelöst, 14
 * Punkte bei Größe 1/3): weit draußen fein, in der Straße deutlich.
 */
export function useWalkDotLayout() {
  const accent = useAccent();
  const mapStyle = useResolvedMapStyle();
  const tone = accent.id === "mint" ? "mint" : "lime";
  const outline = mapStyle === "light" ? "black" : "white";
  return useMemo<ComponentProps<typeof Layer>["layout"]>(
    () => ({
        "symbol-placement": "line",
        "symbol-spacing": ["interpolate", ["linear"], ["zoom"], 12, 14, 16, 20, 19, 26],
        "icon-image": `walk-dot-${tone}-${outline}`,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.2, 16, 0.3, 19, 0.36],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
    }),
    [tone, outline],
  );
}

/**
 * Fester Rückruf: Eine neue Funktion je Durchgang ließ die Quelle ihre Daten
 * jedes Mal neu serialisieren (siehe `ROUND_LINE` in RouteLayer.tsx) — und
 * dieser Baustein rendert bei jeder neuen Ortung.
 */
const NOOP = () => {};

/** Auf rund 25 m gerundet: GPS-Zittern ist derselbe Weg, keine neue Anfrage. */
function roundStart(v: number): number {
  return Math.round(v * 4000) / 4000;
}

/**
 * Wohin der Weg führt: im Stadt-Blatt zur Startstation der gewählten
 * Verbindung, sonst zur angetippten Haltestelle.
 */
function walkTargetOf(s: ReturnType<typeof useSearchStore.getState>): Coord | null {
  if (s.selectedCity) {
    const start = s.cityRoutes?.plans[s.cityRoutes.selected]?.waypoints[0];
    return start ? { latitude: start.latitude, longitude: start.longitude } : null;
  }
  const st = s.selectedStop;
  return st?.latitude != null && st.longitude != null
    ? { latitude: st.latitude, longitude: st.longitude }
    : null;
}

function sameCoord(a: Coord | null, b: Coord | null): boolean {
  return a === b || (a != null && b != null && a.latitude === b.latitude && a.longitude === b.longitude);
}

export const WalkPathLayer = memo(function WalkPathLayer({ from }: { from: Coord }) {
  const dotLayout = useWalkDotLayout();
  const fLat = roundStart(from.latitude);
  const fLng = roundStart(from.longitude);
  /**
   * Das ZIEL holt sich der Weg selbst — und übernimmt es erst, wenn Blatt und
   * Karte ruhen.
   *
   * Bisher reichte es der Karten-Tab herein und abonnierte dafür die
   * angetippte Haltestelle. Jeder Tipp rendete damit den ganzen Bildschirm im
   * selben Durchgang wie das Blatt, und dessen Commit rückte mitten in die
   * Einfahrt — dorthin, wo sie am schnellsten ist (`SHEET_EASE`). Ein Commit
   * während einer Fahrt trägt die Lage des Blattes ein, die beim Einhängen ein,
   * zwei Bilder später schon veraltet ist (siehe `startDragHeal` in
   * lib/ui/sheetSwipe.ts): Das Blatt sprang zurück, gemeldet als „ein Ruckler
   * in der Hälfte der Fahrt". Lag der Weg schon im Zwischenspeicher, hängte
   * derselbe Durchgang außerdem eine neue Kartenquelle ein.
   *
   * Jetzt erscheint er kurz nach dem Blatt und geht beim Schließen erst nach
   * der Ausfahrt — beides ohne Durchgang des Karten-Tabs.
   */
  const [to, setTo] = useState<Coord | null>(null);
  useEffect(() => {
    let alive = true;
    /** Nur der jüngste Auftrag zählt — `whenMapQuiet` lässt sich nicht abbrechen. */
    let gen = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delayMs: number) => {
      clearTimeout(timer);
      const mine = ++gen;
      timer = setTimeout(
        () =>
          whenMapQuiet(() => {
            if (!alive || mine !== gen) return;
            // Fährt inzwischen ein Blatt (Suchtreffer: erst die Kamera, dann
            // das Blatt), auch das abwarten.
            if (isTransitionBusy()) {
              schedule(80);
              return;
            }
            const next = walkTargetOf(useSearchStore.getState());
            setTo((prev) => (sameCoord(prev, next) ? prev : next));
          }),
        delayMs,
      );
    };
    // Länger als jede Fahrt des Blattes (herein 300, hinaus 260 ms).
    schedule(SHEET_IN.duration + 80);
    const unsub = useSearchStore.subscribe((s, prev) => {
      if (
        s.selectedStop !== prev.selectedStop ||
        s.selectedCity !== prev.selectedCity ||
        s.cityRoutes !== prev.cityRoutes
      ) {
        schedule(SHEET_IN.duration + 80);
      }
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      unsub();
    };
  }, []);
  const toLat = to?.latitude.toFixed(5);
  const toLng = to?.longitude.toFixed(5);
  const { data } = useQuery({
    queryKey: ["walk", fLat, fLng, toLat, toLng],
    queryFn: () => fetchWalkRoute({ latitude: fLat, longitude: fLng }, to!),
    enabled: to != null,
    staleTime: 30 * 60 * 1000,
    retry: 1,
    /**
     * Den alten Weg stehen lassen, bis der neue da ist — aber nur zum SELBEN
     * Ziel. Nach einer Ortung mit mehr als 25 m Unterschied war der Weg sonst
     * kurz weg (Quelle ab- und wieder eingehängt). Zu einem anderen Ziel wäre
     * der alte Weg dagegen falsch.
     */
    placeholderData: (prev, prevQuery) =>
      to != null && prevQuery?.queryKey[3] === toLat && prevQuery?.queryKey[4] === toLng
        ? prev
        : undefined,
  });

  const geo = useMemo(
    () =>
      data
        ? {
            type: "FeatureCollection" as const,
            features: [
              {
                type: "Feature" as const,
                geometry: { type: "LineString" as const, coordinates: data.coords },
                properties: {},
              },
            ],
          }
        : null,
    [data],
  );

  if (!geo) return null;
  return (
    <GeoJSONSource
      id="walk-path-src"
      data={geo}
      // Wie die Strecken (RouteLayer.tsx): Kacheln bis 14 reichen, darüber
      // vergrößert — die Punkte setzt MapLibre ohnehin im Bildschirm-Abstand.
      maxzoom={LINE_SOURCE_MAXZOOM}
      tolerance={LINE_SOURCE_TOLERANCE}
      onPress={NOOP}
    >
      <Layer id="walk-path-dots" type="symbol" layout={dotLayout} />
    </GeoJSONSource>
  );
});
