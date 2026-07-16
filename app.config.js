/**
 * Dynamic Expo config.
 *
 * Karten-Stack: MapLibre Native + OpenFreeMap (open source, kostenlos,
 * kein API-Key, kein Tracking). Wir hosten die Vector-Tiles nicht selbst —
 * MapLibre lädt sie direkt von tiles.openfreemap.org.
 *
 * Wenn das Volumen mal über die OpenFreeMap-Grenzen geht oder ihr eine
 * SLA braucht: Tile-URL im `MapSurface`-Style auf einen eigenen Server
 * umbiegen (Protomaps + nginx). Code bleibt identisch.
 *
 * Env-Vars:
 *   - EXPO_PUBLIC_API_BASE_URL (optional) → Backend-URL überschreiben
 */
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://192.168.2.84:3000";

// Klartext-HTTP NUR erlauben, wenn die Backend-URL selbst http:// ist (lokaler
// Dev-Server im LAN). Zeigt die URL auf https://, wird usesCleartextTraffic
// automatisch false → das Android-System BLOCKT dann jeden versehentlichen
// http-Fetch (Fallback-URL, vergessener Endpoint) auf OS-Ebene. So kann ein
// Produktions-Build gar keine unverschlüsselten Daten mehr senden.
const ALLOW_CLEARTEXT = API_BASE_URL.startsWith("http://");

module.exports = {
  expo: {
    name: "Binch",
    slug: "binch-mobile",
    scheme: "binch",
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#ffffff",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.binch.mobile",
    },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: "com.binch.mobile",
    },
    web: {
      favicon: "./assets/favicon.png",
      bundler: "metro",
    },
    plugins: [
      "expo-router",
      // usesCleartextTraffic hängt jetzt an der Backend-URL (siehe
      // ALLOW_CLEARTEXT oben): http:// (lokaler Dev-Server) → true, damit der
      // LAN-Dev-Server auch im Release-Build erreichbar bleibt; https:// (Prod
      // über Caddy) → false, dann blockt Android jeden Klartext-Fetch auf
      // OS-Ebene. Kein manuelles Umdrehen mehr nötig — die HTTPS-Backend-URL
      // schaltet Klartext von selbst ab.
      [
        "expo-build-properties",
        {
          android: {
            usesCleartextTraffic: ALLOW_CLEARTEXT,
          },
        },
      ],
      // Scroll-Judder-Fix: pinnt die Display-Rate am App-Window (Details im
      // Plugin). MUSS als Config-Plugin laufen — android/ ist gitignored
      // (CNG), direkte Edits dort erreichen EAS-Builds nie.
      "./plugins/withDisplayRatePin",
      "@react-native-community/datetimepicker",
      [
        "expo-location",
        {
          locationAlwaysAndWhenInUsePermission:
            "Binch nutzt deinen Standort, um Haltestellen und Stationen in deiner Nähe anzuzeigen.",
        },
      ],
      "@maplibre/maplibre-react-native",
      "react-native-bottom-tabs",
      [
        "expo-speech-recognition",
        {
          microphonePermission:
            "Binch nutzt das Mikrofon, um deine Sprachnachrichten an Bo zu transkribieren.",
          speechRecognitionPermission:
            "Binch nutzt Spracherkennung, um deine Anfragen an Bo zu verstehen.",
        },
      ],
    ],
    extra: {
      apiBaseUrl: API_BASE_URL,
      eas: {
        projectId: "bb96def4-7d38-4119-8758-ea844051db4a",
      },
    },
  },
};
