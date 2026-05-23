import "../global.css";

import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppState, LogBox, useColorScheme, View } from "react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useEffect, useMemo } from "react";
import { SearchHeroOverlay } from "@/components/search/SearchHeroOverlay";
import { VoiceOverlay } from "@/components/search/VoiceOverlay";
import { RecentHistoryOverlay } from "@/components/home/RecentHistoryOverlay";
import { LegTimelineOverlay } from "@/components/results/LegTimelineOverlay";
import { DetailsOverlay } from "@/components/results/DetailsOverlay";
import { StopDetailSheet } from "@/components/surroundings/StopDetailSheet";
import { AppAlertHost } from "@/components/ui/AppAlertHost";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { SavedToastHost } from "@/components/ui/SavedToastHost";
import { AuthOverlay } from "@/components/auth/AuthOverlay";
import { AuthHydrator } from "@/components/auth/AuthHydrator";

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* `initialMetrics` füttert das Provider mit synchron beim App-Start
          gecacheten Inset-Werten. Ohne diese Prop sind Insets beim ersten
          Render aller SafeAreaViews 0 und springen erst nach dem nativen
          Layout-Measure auf den echten Wert — sichtbar als kurzes „Screen
          rutscht nach unten"-Snap z.B. beim Öffnen des Results-Screens. */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <QueryClientProvider client={queryClient}>
          <View className={isDark ? "dark flex-1" : "flex-1"} style={{ flex: 1, backgroundColor: "#1A1A1A" }}>
            <StatusBar style={isDark ? "light" : "dark"} />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#1A1A1A" } }}>
              <Stack.Screen name="(tabs)" />
            </Stack>
            <FloatingTabBar />
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
            <AppAlertHost />
            <SavedToastHost />
            <AuthOverlay />
            <AuthHydrator />
          </View>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
