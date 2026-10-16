import { type ComponentProps, useMemo, useRef } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import { type Coord } from "@/lib/surroundings/mockData";
import { useDeviceHeading } from "@/lib/surroundings/useDeviceHeading";
import { useAccent } from "@/lib/theme/accent";
import { ms } from "@/lib/ui/compact";

/**
 * Die eigene Position auf der Karte — als NATIVE Ebene, nicht als Ansicht.
 *
 * WARUM DAS UMGEBAUT WURDE: Hier stand ein `Marker` der Bibliothek, und der
 * setzt auf Android eine echte Android-View auf die Karte, die bei JEDEM
 * Kamerabild neu positioniert werden muss. Die Bibliothek sagt das selbst in
 * ihrer Beschreibung: „If you have static view consider using ViewAnnotation or
 * SymbolLayer for better performance." Unsere war genau das — ein Hof und ein
 * Punkt, ohne Berührung, ohne Zustand.
 *
 * Der Preis dafür fällt genau dort an, wo er am meisten stört: bei JEDER
 * Kamerabewegung. Solange die Karte sich bewegt, muss diese Ansicht in jedem
 * Bild im nativen Baum umgehängt werden — ein Knoten, der nicht in der
 * GL-Zeichnung der Karte liegt und deshalb einzeln nachgeführt werden muss.
 * Beim Zoomen kommt hinzu, dass ihre Bildschirmposition sich mit dem Abstand
 * zum Zoom-Mittelpunkt ändert, also auch dann, wenn die Koordinate stillsteht.
 *
 * Als Kreis-Ebene läuft dieselbe Darstellung in derselben GL-Zeichnung wie die
 * Karte: kein Knoten im Ansichtsbaum, keine Neupositionierung, nichts, was pro
 * Bild über die Brücke muss.
 *
 * MASSE UNVERÄNDERT: Der Hof war 52 Punkte breit (Radius 26), der Punkt 20
 * (Radius 10) mit 3 Punkten Rand in #0D0D0D. `ms()` rechnet sie wie zuvor auf
 * die Bildschirmgröße herunter — vorher tat das `scaledStyles`, was hier nicht
 * greift: Der Kartenstil ist kein Stilblatt, sondern Werte im Ausdruck.
 *
 * WEGGEFALLEN ist außerdem ein `Marker`-Bauteil, das je Haltestelle eine
 * React-Ansicht auf die Karte setzte. Es hatte seit dem Umbau auf
 * `MarkerLayer` keinen Aufrufer mehr — und war damit genau die Falle, gegen
 * die jener Umbau geschrieben wurde.
 */

/** MapLibre erwartet Koordinaten als [longitude, latitude] (GeoJSON-Order). */
function lngLat(c: Coord): [number, number] {
  return [c.longitude, c.latitude];
}

const SRC_ID = "user-pin-src";

/**
 * Wie weit der Kegel über den Punkt hinausreicht, als Radius in Punkten — ein
 * gutes Stück über den Hof (26) hinaus, sonst läse er sich als Fleck am Punkt
 * statt als Richtung.
 */
const CONE_RADIUS = 62;
/** Halbe Kantenlänge des Kegelbildes, siehe `server/scripts/build-heading-cone.mjs`. */
const CONE_RADIUS_PX = 150;

type ConeWidth = "schmal" | "mittel" | "breit";

/**
 * Welche Breite zur Unsicherheit des Kompasses gehört — mit Rückstellweg.
 *
 * Ohne ihn flackerte der Kegel zwischen zwei Breiten, sobald die Schätzung um
 * eine Grenze pendelt, und das tut sie, wenn man stillsteht. Umgeschaltet wird
 * erst, wenn der Wert die Grenze um drei Grad überschritten hat.
 */
function coneWidthFor(accuracy: number, current: ConeWidth): ConeWidth {
  if (accuracy < 0) return current;
  const up = (limit: number) => accuracy > limit + 3;
  const down = (limit: number) => accuracy < limit - 3;
  switch (current) {
    case "schmal":
      return up(35) ? "breit" : up(15) ? "mittel" : "schmal";
    case "mittel":
      return up(35) ? "breit" : down(15) ? "schmal" : "mittel";
    case "breit":
      return down(15) ? "schmal" : down(35) ? "mittel" : "breit";
  }
}

/**
 * Der Blickrichtungs-Kegel — wohin das Telefon zeigt, wie bei Google.
 *
 * EIGENE KOMPONENTE, und das ist der Punkt: Die Richtung ändert sich bis zu
 * dreißigmal pro Sekunde, und jede `Layer` schickt bei jedem Durchgang ihren
 * vollständigen Stil nach nativ (in der Bibliothek: `useMemo` über das ganze
 * Eigenschaftsobjekt, das bei jedem Durchgang neu ist). Hinge die Richtung an
 * `UserPin`, würden Hof und Punkt dreißigmal pro Sekunde mitgeschickt. So läuft
 * nur diese eine Ebene.
 *
 * `icon-rotation-alignment: map` — die Drehung zählt gegen den Kartennorden,
 * nicht gegen den Bildschirm. Dreht man die Karte, bleibt der Kegel also dort,
 * wohin das Telefon zeigt. `icon-pitch-alignment: map` legt ihn beim Kippen
 * flach auf den Boden, statt ihn aufrecht stehen zu lassen.
 *
 * Immer eingehängt, ohne Richtung nur unsichtbar: Die Ebenen einer Quelle
 * landen in der Reihenfolge ihres Einhängens im Stil. Hinge sich der Kegel
 * erst mit der ersten Messung ein, läge er ÜBER dem Punkt statt darunter.
 */
/** Fest, damit der Kegel nicht bei jeder Kompass-Messung neu eingestellt wird. */
const HEADING_CONE_PAINT: Extract<ComponentProps<typeof Layer>, { type: "symbol" }>["paint"] = {
  "icon-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0, 6, 1],
};

function HeadingCone({ coord }: { coord: Coord }) {
  const accent = useAccent();
  const heading = useDeviceHeading(coord);
  const widthRef = useRef<ConeWidth>("mittel");
  if (heading) widthRef.current = coneWidthFor(heading.accuracy, widthRef.current);
  return (
    <Layer
      id="user-pin-heading"
      type="symbol"
      source={SRC_ID}
      layout={{
        "icon-image": `heading-cone-${accent.id}-${widthRef.current}`,
        "icon-size": ms(CONE_RADIUS) / CONE_RADIUS_PX,
        "icon-rotate": heading?.deg ?? 0,
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-anchor": "center",
        // Nie verdrängen und nie verdrängt werden — die Richtung ist keine
        // Beschriftung, die sich mit Haltestellennamen um Platz streitet.
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        visibility: heading ? "visible" : "none",
      }}
      /**
       * Weit draußen ausblenden: Als Kugel legt MapLibre ein flach liegendes
       * Bild in die Tangentialebene — der Kegel stand dann riesig und schräg
       * über den Erdrand hinaus. Auf Weltmaßstab sagt eine Blickrichtung ohnehin
       * nichts; Punkt und Hof bleiben.
       */
      paint={HEADING_CONE_PAINT}
    />
  );
}

export function UserPin({ coord }: { coord: Coord }) {
  const accent = useAccent();
  /**
   * Nur neu bauen, wenn sich die Koordinate WIRKLICH ändert.
   *
   * Die Ortung liefert bei jedem Fix ein neues Objekt, auch wenn die Zahlen
   * gleich bleiben. Ohne diese Schranke bekäme die Quelle bei jedem Durchgang
   * eine neue Form gereicht — und eine Quelle, die sich ändert, lädt die
   * Ebene neu.
   */
  const shape = useMemo(
    () => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: lngLat(coord) },
      properties: {},
    }),
    [coord.latitude, coord.longitude],
  );

  return (
    <GeoJSONSource id={SRC_ID} data={shape}>
      {/* Der weiche Hof. Die Farbe bringt ihre eigene Deckung mit (`subtle`). */}
      <Layer
        id="user-pin-halo"
        type="circle"
        source={SRC_ID}
        paint={{ "circle-radius": ms(26), "circle-color": accent.subtle }}
      />
      {/* Zwischen Hof und Punkt: Die Spitze liegt unter dem Punkt. */}
      <HeadingCone coord={coord} />
      {/* Der Punkt mit dunklem Rand — damit er auf hellem Untergrund steht. */}
      <Layer
        id="user-pin-dot"
        type="circle"
        source={SRC_ID}
        paint={{
          "circle-radius": ms(10),
          "circle-color": accent.solid,
          "circle-stroke-width": ms(3),
          "circle-stroke-color": "#0D0D0D",
        }}
      />
    </GeoJSONSource>
  );
}
