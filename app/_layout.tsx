import "../global.css";

import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppState, LogBox, StyleSheet, useColorScheme, View } from "react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useEffect, useMemo } from "react";
import { SearchHeroOverlay } from "@/components/search/SearchHeroOverlay";
import { DatePickerHost } from "@/components/search/DatePickerHost";
import { LocationPickerHost } from "@/components/search/LocationPickerHost";
import { VoiceOverlay } from "@/components/search/VoiceOverlay";
import { RecentHistoryOverlay } from "@/components/home/RecentHistoryOverlay";
import { LegTimelineOverlay } from "@/components/results/LegTimelineOverlay";
import { DetailsOverlay } from "@/components/results/DetailsOverlay";
import { StopDetailSheet } from "@/components/surroundings/StopDetailSheet";
import { AppAlertHost } from "@/components/ui/AppAlertHost";
import { ConnectionNotFoundHost } from "@/components/ui/ConnectionNotFoundModal";
// FloatingTabBar entfernt — der native Tab-Bar des
// createNativeBottomTabNavigator (siehe app/(tabs)/_layout.tsx) übernimmt
// die Rolle. Native = Tap wird auf UI-Thread verarbeitet = wirklich instant.
import { SavedToastHost } from "@/components/ui/SavedToastHost";
import { StationSaveToastHost } from "@/components/surroundings/StationSaveToastHost";
import { TicketDetailOverlay } from "@/components/saved/TicketDetailOverlay";
import { BinchSplash } from "@/components/ui/BinchSplash";
import { BinchAuthScreen } from "@/components/auth/BinchAuthScreen";
import { AuthHydrator } from "@/components/auth/AuthHydrator";
import { migrateTicketImagesToFiles } from "@/lib/saved/ticketImages";
import Animated, { FadeOut } from "react-native-reanimated";
import { useState } from "react";

// Transiente MapLibre-Tile-Errors („Software caused connection abort",
// „Failed to load tile") werden von der nativen MapLibre-Library auf
// console.error gebrückt — MapLibre retried automatisch und der User sieht
// die fehlende Kachel nicht. Aber LogBox würde im Dev-Mode einen roten Banner
// zeigen und im Prod-Build z.B. Sentry / Crashlytics-Events triggern. Wir
// filtern sie raus.
LogBox.ignoreLogs([
  /Failed to load tile/,
  /Mbgl RenderThread/,
  /Software caused connection abort/,
  // db-rest und ähnliche Provider können beim Reachability-Wechsel kurz
  // einen Abort werfen — TanStack Query retried, User sieht's nicht.
  /AbortError/,
]);

// Belt-and-suspenders: auch direkt console.error filtern, damit Crash-Reporter
// (Sentry o.ä.) in Production diese Tile-Glitches nicht als Issue melden.
const IGNORED_ERROR_PATTERNS = [
  /Failed to load tile/i,
  /Mbgl RenderThread/i,
  /Software caused connection abort/i,
  // expo-router/react-navigation warning das oft im Dev-Mode triggert wenn
  // Fast-Refresh den Root re-mountet — funktional kein Problem (Deep-Links
  // gehen weiter), nur eine Warnung. Im Prod-Build erscheint sie nicht.
  /configured linking in multiple places/i,
];
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const first = args[0];
  const msg = typeof first === "string" ? first : (first instanceof Error ? first.message : "");
  if (msg && IGNORED_ERROR_PATTERNS.some((re) => re.test(msg))) return;
  originalConsoleError(...args);
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 5 Min stale → keine unnötigen Refetches beim Tab-Wechsel oder Zurück-
      // Navigation. Search-Results überschreiben das auf 10 Min, Surroundings
      // auf 60 s (hängt am Viewport-Movement).
      staleTime: 5 * 60 * 1000,
      // 30 Min Cache-Retention nach letztem Use — instant verfügbar wenn der
      // User später nochmal zur selben Such-Anfrage zurückkommt.
      gcTime: 30 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  const system = useColorScheme();
  const theme = useSearchStore((s) => s.theme);
  const isDark = useMemo(() => (theme === "gray" ? system === "dark" : theme === "dark"), [theme, system]);

  // Splash-State: zeigt die animierte BinchSplash beim ersten App-Start.
  // Nach onFinish faded sie via Reanimated FadeOut weg → der Landing-Screen
  // darunter wird sichtbar.
  const [splashDone, setSplashDone] = useState(false);

  // Abgelaufene Saved-Tickets prunen — einmal beim App-Start, danach jedes
  // Mal wenn die App aus dem Background zurückkommt. Damit fängt der Sweep
  // den Tageswechsel auch bei langlaufenden Sessions (User lässt App über
  // Nacht offen) und beim Wiedereinstieg am nächsten Tag.
  useEffect(() => {
    const prune = useSearchStore.getState().pruneExpiredSavedTrips;
    prune();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") prune();
    });
    return () => sub.remove();
  }, []);

  // Persistierte Recent-Searches + Saved-Stations gegen die aktuelle DB
  // validieren. Use-Case: nach Audit-Cleanup verweisen alte Recents auf
  // gelöschte/umgelabelte Codes (z.B. „Wien Hbf"-Eintrag zeigt eigentlich auf
  // einen sta:-Sub-Code der jetzt auf Wien Blumental routet). Persist-
  // Middleware hydratet asynchron — kleiner Delay verhindert dass wir auf
  // einem leeren Store starten (Recents wären noch nicht da).
  useEffect(() => {
    const t = setTimeout(() => {
      void useSearchStore.getState().validatePersistedCodes();
    }, 800);
    return () => clearTimeout(t);
  }, []);

  // Einmalige Migration: Ticket-Bilder (früher Base64 im persistierten Store
  // = Multi-MB-JSON.stringify bei jedem set() + AsyncStorage-CursorWindow-
  // Risiko) auf file://-Dateien umziehen. Idempotent; nach der Hydration.
  useEffect(() => {
    const t = setTimeout(() => {
      void migrateTicketImagesToFiles();
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Splash liegt GANZ AUSSEN — über SafeAreaProvider und allen Tabs,
          damit sie wirklich das ganze Display einnimmt (inkl. Statusbar-
          Bereich und unteren Gesture-Inset). */}
      {!splashDone && (
        <Animated.View
          style={{ ...StyleSheet.absoluteFillObject, zIndex: 9999, elevation: 9999 }}
          exiting={FadeOut.duration(420)}
          pointerEvents="auto"
        >
          <BinchSplash
            duration={3500}
            onFinish={() => setSplashDone(true)}
          />
        </Animated.View>
      )}
      {/* `initialMetrics` füttert das Provider mit synchron beim App-Start
          gecacheten Inset-Werten. Ohne diese Prop sind Insets beim ersten
          Render aller SafeAreaViews 0 und springen erst nach dem nativen
          Layout-Measure auf den echten Wert — sichtbar als kurzes „Screen
          rutscht nach unten"-Snap z.B. beim Öffnen des Results-Screens. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <QueryClientProvider client={queryClient}>
          <View className={isDark ? "dark flex-1" : "flex-1"} style={{ flex: 1, backgroundColor: "#1A1A1A" }}>
            <StatusBar style={isDark ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: "#1A1A1A" },
                // KEINE Slide-Animation — weder beim Push noch beim Pop.
                // Default Stack-Animation wäre slide_from_right (iOS) bzw.
                // fade_from_bottom (Android), was beim Öffnen von Bo +
                // Results unerwünscht reinslidet. Wir wollen instant.
                animation: "none",
              }}
            >
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="assistant" />
              {/* search als transparentModal: der vorige Screen (z.B. der
                  Home-Tab) bleibt DARUNTER gemountet & sichtbar während der
                  Slide-In läuft. Die manuelle Reanimated-Slide-Animation in
                  app/search/results.tsx zieht die Results-Card von rechts
                  über den vorigen Inhalt rüber — exakt das gleiche Verhalten
                  wie das DetailsOverlay („Buchung wählen") das auch
                  oberhalb der Result-Liste slidet, nicht sie ersetzt. */}
              <Stack.Screen
                name="search"
                options={{
                  presentation: "transparentModal",
                  animation: "none",
                  // WICHTIG: contentStyle muss explizit transparent sein,
                  // sonst überschreibt der Default vom Stack-screenOptions
                  // (backgroundColor: #1A1A1A) die Modal-Transparenz und der
                  // vorige Screen ist trotzdem nicht sichtbar dahinter.
                  contentStyle: { backgroundColor: "transparent" },
                }}
              />
            </Stack>
            {/* StopDetailSheet wird hier registriert (nicht in den Tabs)
                damit der Slide ÜBER der FloatingTabBar UND allen Tab-Pages
                liegt — wie alle anderen Sheets im Root-Layout. */}
            <StopDetailSheet />
            <RecentHistoryOverlay />
            <SearchHeroOverlay />
            <VoiceOverlay />
            {/* DetailsOverlay zuerst (liegt unten), LegTimelineOverlay
                danach (liegt drauf) — sonst wäre der von Details aus
                geöffnete Leg-Timeline-Slide hinter Details versteckt. */}
            <DetailsOverlay />
            <LegTimelineOverlay />
            {/* TicketDetailOverlay: slidet von rechts wenn der User in
                Saved-Tab → Tickets-Reiter auf eine Card tappt. Returns
                null wenn selectedTicket === null → null Overhead wenn
                geschlossen. */}
            <TicketDetailOverlay />
            <AppAlertHost />
            <ConnectionNotFoundHost />
            <SavedToastHost />
            <StationSaveToastHost />
            {/* DatePickerHost ZULETZT vor Auth → liegt VISUELL ÜBER den
                Tabs/Overlays inkl. Nav-Bar, sodass die Nav-Bar während des
                Pickers nicht klickbar ist. */}
            <DatePickerHost />
            <LocationPickerHost />
            <BinchAuthScreen />
            <AuthHydrator />
          </View>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
