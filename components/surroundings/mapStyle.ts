/**
 * MapLibre Style JSON für unsere Dark-Theme-Karte.
 *
 * Tile-Quelle: OpenFreeMap (https://openfreemap.org) — komplett kostenlos,
 * kein API-Key, OpenStreetMap-basiert. Bei größerem Volumen kann die
 * `tiles.openfreemap.org`-URL durch einen eigenen Tile-Server (z.B.
 * Protomaps + nginx) ersetzt werden — der Style bleibt gleich.
 *
 * Schema-Referenz: OpenMapTiles vector tile schema.
 * https://openmaptiles.org/schema/
 */

import type { StyleSpecification } from "@maplibre/maplibre-react-native";

export const DARK_MAP_STYLE_URL: string | undefined = undefined;

export const DARK_MAP_STYLE: StyleSpecification = {
  version: 8,
  name: "Binch Dark",
  sources: {
    openmaptiles: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
    },
  },
  sprite: "https://tiles.openfreemap.org/sprites/ofm_f384/ofm",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#14181A" } },

    // Wasser
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": "#1B2E3A" },
    },

    // Wälder / Parks
    {
      id: "landcover-wood",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["==", ["get", "class"], "wood"],
      paint: { "fill-color": "#1A2420", "fill-opacity": 0.9 },
    },
    {
      id: "park",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: { "fill-color": "#1F2A22", "fill-opacity": 0.85 },
    },

    // Stadt-Hintergrund (residential, commercial leicht heller als bg)
    {
      id: "landuse-residential",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["==", ["get", "class"], "residential"],
      paint: { "fill-color": "#181B1E" },
    },

    // Gebäude (nur in höheren Zooms)
    {
      id: "building",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": "#1E2226", "fill-opacity": 0.85 },
    },

    // Schiene
    {
      id: "rail",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["all", ["==", ["get", "class"], "rail"]],
      paint: {
        "line-color": "#3A3D40",
        "line-width": 1.2,
        "line-dasharray": [3, 2],
      },
    },

    // Straßen — Hierarchie minor → service → secondary → primary → trunk/motorway
    {
      id: "road-minor",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track", "path"]]],
      paint: {
        "line-color": "#22262A",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 18, 3],
      },
    },
    {
      id: "road-secondary",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["tertiary", "secondary"]]],
      paint: {
        "line-color": "#33373B",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 18, 5],
      },
    },
    {
      id: "road-primary",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["==", ["get", "class"], "primary"],
      paint: {
        "line-color": "#42474D",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 18, 7],
      },
    },
    {
      id: "road-trunk",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", ["get", "class"], ["literal", ["trunk", "motorway"]]],
      paint: {
        "line-color": "#525860",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 18, 8],
      },
    },

    // Verwaltungsgrenzen
    {
      id: "boundary-country",
      type: "line",
      source: "openmaptiles",
      "source-layer": "boundary",
      filter: ["==", ["get", "admin_level"], 2],
      paint: { "line-color": "#3A3D40", "line-width": 0.8, "line-opacity": 0.6 },
    },

    // Labels — Ortsnamen, Wasser
    {
      id: "place-city",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 12, 16],
        "text-letter-spacing": 0.05,
        "text-transform": "uppercase",
      },
      paint: {
        "text-color": "#B0B4B8",
        "text-halo-color": "#14181A",
        "text-halo-width": 1.2,
      },
    },
    {
      id: "place-suburb",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood"]]],
      minzoom: 12,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11,
      },
      paint: {
        "text-color": "#7A7E84",
        "text-halo-color": "#14181A",
        "text-halo-width": 1,
      },
    },
    {
      id: "water-name",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "water_name",
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Italic"],
        "text-size": 11,
      },
      paint: {
        "text-color": "#6B95B5",
        "text-halo-color": "#14181A",
        "text-halo-width": 1,
      },
    },
    // Straßennamen — erst ab Zoom 15 sichtbar (statt 14) damit der Style bei
    // normaler Stadtansicht ruhig bleibt. Nur Names schreiben, keine Refs.
    {
      id: "road-name",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "transportation_name",
      minzoom: 15,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 10,
        "symbol-placement": "line",
      },
      paint: {
        "text-color": "#6C7079",
        "text-halo-color": "#14181A",
        "text-halo-width": 1,
      },
    },
  ],
};
