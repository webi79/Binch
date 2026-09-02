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
    /**
     * ZWEI Schemata.
     *
     * `binch` ist das der App (Verlinkungen, Rücksprung aus dem Browser).
     * `com.binch.mobile` kommt für die Google-Anmeldung dazu: Google verlangt
     * für installierte Apps eine Rücklauf-Adresse in Reverse-DNS-Form, und die
     * App muss dieses Schema auch selbst beanspruchen — sonst leitet Google
     * zwar korrekt weiter, aber auf dem Gerät fängt niemand den Rücklauf auf,
     * und der Browser bleibt einfach stehen.
     */
    scheme: ["binch", "com.binch.mobile"],
    version: "1.0.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    userInterfaceStyle: "automatic",
    newArchEnabled: true,
    splash: {
      image: "./assets/splash-icon.png",
      resizeMode: "contain",
      backgroundColor: "#000000",
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.binch.mobile",
      // Aktiviert die Berechtigung „Sign in with Apple" im iOS-Projekt. Ohne
      // sie schlägt der Aufruf zur Laufzeit fehl, nicht beim Bauen.
      usesAppleSignIn: true,
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
      /**
       * Anmeldung mit Apple — nur iOS.
       *
       * Das Plugin setzt die nötige Berechtigung im iOS-Projekt. Auf Android
       * bleibt es folgenlos; der Knopf wird dort ohnehin ausgeblendet, weil
       * Apples Web-Fluss ein signiertes Client-Secret verlangt, das nur auf
       * einen Server gehört.
       */
      "expo-apple-authentication",
      /**
       * Natives Google-Sign-In über die Play-Dienste.
       *
       * Das Plugin trägt die nötigen Abhängigkeiten und Manifest-Einträge ins
       * Android-Projekt ein. Nötig, seit der Browser-Weg entfällt: Google hat
       * eigene URI-Schemata für neue Android-Clients abgeschaltet.
       */
      "@react-native-google-signin/google-signin",
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
      /**
       * Wiedergabe der Sprachnachrichten im Chat. Aufgenommen wird weiterhin
       * über `expo-speech-recognition` — dort entsteht die Datei zusammen mit
       * der Erkennung, aus EINER Mikrofon-Aufnahme.
       */
      "expo-audio",
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
      /**
       * Client-IDs für die Anmeldung über Google.
       *
       * Aus der Umgebung, nicht im Code — nicht weil sie geheim wären (das sind
       * sie nicht, sie stehen in jeder installierten App), sondern weil sie pro
       * Projekt verschieden sind und weil der SERVER dieselben IDs als gültige
       * Empfänger kennen muss (`GOOGLE_CLIENT_IDS` dort). Zwei Orte, ein Wert —
       * er gehört an eine Stelle, an der man beide bedient.
       *
       * Fehlen sie, blendet der Anmelde-Bildschirm den Knopf aus, statt einen
       * anzubieten, der nicht funktioniert.
       */
      /**
       * EINE ID: die des WEB-Clients.
       *
       * Das native SDK meldet sich zwar über den Android-Client an (der
       * autorisiert die App über Paketname und Fingerabdruck), stellt das
       * ID-Token aber immer auf den Web-Client aus. Dessen ID steht im `aud` des
       * Tokens und muss deshalb auch auf dem Server als gültiger Empfänger
       * eingetragen sein (`GOOGLE_CLIENT_IDS`).
       *
       * Das Client-Secret des Web-Clients wird NICHT gebraucht und darf nirgends
       * in die App: Es gehört auf einen Server, der Codes eintauscht — hier
       * tauscht niemand etwas ein.
       */
      googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID ?? null,
      // KEINE Web-Client-ID mehr: Web-Clients erlauben keinen Rücklauf über ein
      // eigenes Schema. Als Rückfall hätte sie den Knopf sichtbar gemacht, den
      // Google dann abgelehnt hätte — siehe googleClientId() im Client.
      eas: {
        projectId: "bb96def4-7d38-4119-8758-ea844051db4a",
      },
    },
  },
};
