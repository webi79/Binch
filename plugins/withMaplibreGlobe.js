/**
 * Expo-Config-Plugin: MapLibre Native MIT GLOBUS.
 *
 * Wer ganz hinauszoomt, soll die Erde als Kugel sehen — und beim
 * Hineinzoomen nahtlos auf der Karte landen, wie in Google Earth. Das kann nur
 * EIN Renderer, der die Karte selbst als Kugel zeichnet; eine Kugel-Ebene über
 * einer flachen Karte war zwei Dinge nebeneinander und wurde verworfen.
 *
 * MapLibre Native kann das in den veröffentlichten Versionen (bis 13.6.1)
 * nicht. Der Globus steckt im Pull Request maplibre/maplibre-native#4533
 * („render the map as a globe when the style sets projection", auf 13.6.1
 * aufgesetzt), die Atmosphäre in #4534; Sterne, Milchstraße und Erdschatten
 * sind unser eigener Patch darauf. Bis das veröffentlicht ist, bauen wir die
 * Android-Bibliothek daraus selbst und legen sie unter
 * `vendor/maplibre-native/` als kleines Maven-Verzeichnis ab (Zusammensetzung
 * und Bauanleitung: `vendor/maplibre-native/README.md`).
 *
 * Das Plugin macht zwei Dinge, beide beim Prebuild (android/ ist gitignored —
 * CNG):
 * 1. das Verzeichnis als Maven-Quelle eintragen,
 * 2. maplibre-react-native auf diese Version stellen — die Bibliothek liest
 *    sie aus `org.maplibre.reactnative.nativeVersion` (ihr build.gradle), am
 *    eigenen Code ändert sich nichts.
 *
 * Sobald MapLibre den Globus veröffentlicht: Plugin und Verzeichnis löschen,
 * MLRN auf die offizielle Version heben.
 */
const { withGradleProperties, withProjectBuildGradle } = require("@expo/config-plugins");

const VERSION = "13.6.1-globe.6";
const REPO_LINE = 'maven { url "$rootDir/../vendor/maplibre-native" }';

module.exports = function withMaplibreGlobe(config) {
  config = withGradleProperties(config, (cfg) => {
    const key = "org.maplibre.reactnative.nativeVersion";
    cfg.modResults = cfg.modResults.filter((item) => !(item.type === "property" && item.key === key));
    cfg.modResults.push({ type: "property", key, value: VERSION });
    return cfg;
  });
  config = withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") return cfg;
    let src = cfg.modResults.contents;
    if (!src.includes("vendor/maplibre-native")) {
      // In allprojects.repositories, VOR den öffentlichen Quellen: Die eigene
      // Version gibt es nur hier.
      src = src.replace(/allprojects\s*\{\s*repositories\s*\{/, (m) => `${m}\n    ${REPO_LINE}`);
    }
    cfg.modResults.contents = src;
    return cfg;
  });
  return config;
};
