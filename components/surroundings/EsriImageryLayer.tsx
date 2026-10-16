import { Layer, RasterSource } from "@maplibre/maplibre-react-native";
import { memo } from "react";

/**
 * Esri World Imagery als eigene Ebene — nur in den Lücken (siehe
 * lib/imagery/esriImagery.ts und `esriVisible` im Kartenbildschirm).
 *
 * Als KIND der Karte statt im Stil: Den Stil zu ändern lädt die ganze Karte
 * neu (siehe `mapStyle` an der Kartenfläche). Die Sichtbarkeit wechselt hier
 * über `visibility` — und eine ausgeblendete Ebene lädt KEINE Kacheln, es wird
 * also auch nichts bei Esri abgerechnet, solange sie aus ist.
 *
 * Lage: direkt über den eigenen Luftbild-Ebenen (`aerial-gl` ist die letzte
 * davon in `AERIAL_LAYERS`), also unter Beschriftungen, Haltestellen und Routen.
 *
 * NEUER SCHEIN = NEUE QUELLE: MapLibre baut eine Quelle nur EINMAL; eine
 * geänderte `tiles`-Adresse übernimmt sie nicht (in MLRN 11 nachgelesen). Der
 * Schein in der Adresse wechselt aber täglich — ohne neue Quelle wäre Esri nach
 * spätestens 48 Stunden leer. Deshalb hängt die Kennung am Schein, und der
 * Aufrufer setzt `key` darauf: Wechselt er, wird die Quelle ersetzt.
 */
export const EsriImageryLayer = memo(function EsriImageryLayer({
  ticket,
  tiles,
  minzoom,
  maxzoom,
  attribution,
  visible,
}: {
  ticket: string;
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  attribution: string;
  visible: boolean;
}) {
  return (
    <RasterSource
      id={`aerial-esri-${ticket}`}
      tiles={tiles}
      tileSize={256}
      minzoom={minzoom}
      maxzoom={maxzoom}
      attribution={attribution}
    >
      <Layer
        id={`aerial-esri-${ticket}`}
        type="raster"
        afterId="aerial-gl"
        minzoom={minzoom}
        layout={{ visibility: visible ? "visible" : "none" }}
        paint={{
          "raster-saturation": 0.1,
          "raster-contrast": 0.05,
          // Kein harter Wechsel bei Stufe 13 vom 10-m-Satellitenbild auf
          // Esri — ein kurzes Überblenden über eine halbe Zoomstufe.
          "raster-opacity": ["interpolate", ["linear"], ["zoom"], minzoom, 0, minzoom + 0.5, 1],
        }}
      />
    </RasterSource>
  );
});
