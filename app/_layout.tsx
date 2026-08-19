import "../global.css";

import { Stack } from "expo-router";
import { RouteMirror } from "@/lib/nav/routeMirror";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AppState, LogBox, StyleSheet, useColorScheme, View } from "react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useAppBg } from "@/lib/theme/appBg";
import { useEffect, useMemo } from "react";
import { DatePickerHost } from "@/components/search/DatePickerHost";
import { LocationPickerHost } from "@/components/search/LocationPickerHost";
import { VoiceOverlay } from "@/components/search/VoiceOverlay";
import { SearchHeroOverlay } from "@/components/search/SearchHeroOverlay";
import { ResultsView } from "@/components/results/ResultsView";
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
import { SettingsSubOverlay } from "@/app/(tabs)/settings";
import { BinchTabBar } from "@/components/ui/BinchTabBar";
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
  // Screen-Hintergrund je nach gewähltem Theme (Grau / echtes Schwarz).
  const appBg = useAppBg();
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
  /**
   * Den Ergebnis-Bildschirm samt Lade-Szenen schon hinter der Splash laden.
   *
   * Hermes führt den Rumpf eines Moduls erst aus, wenn es zum ERSTEN Mal
   * angefordert wird. `app/search/results.tsx` und die vier Lade-Szenen samt
   * ihrem Rahmen sind zusammen über 2200 Zeilen — und sie hängen an keiner
   * anderen Stelle im Baum, werden also erst beim allerersten Antippen von
   * „Preis vergleichen" ausgewertet. Genau dort, wo der Übergang beginnt.
   *
   * Das erklärt, warum nur das ERSTE Mal ruckelt und jedes weitere sauber läuft,
   * und warum keine der Optimierungen an der Bewegung daran etwas geändert hat:
   * Sie alle haben den warmen Fall verbessert, während der Ruckler im kalten
   * steckt. Auch die Messungen liefen unvermeidlich warm — die Sonde lässt sich
   * erst nach mehreren Berührungen einschalten.
   *
   * Nachgeholt wird das jetzt beim Start, in einer Leerlauf-Lücke hinter der
   * Splash. Dort wartet niemand darauf, und danach ist der erste Übergang so
   * warm wie jeder weitere.
   */
  useEffect(() => {
    const warm = () => {
      try {
        // Absichtlich require statt import: Ein Import oben würde die Auswertung
        // in den Startpfad ziehen und den Kaltstart verlängern — hier soll sie
        // gerade NACH dem ersten Bild passieren.
        require("./search/results");
      } catch {
        // Schlägt das fehl, ist nur der erste Übergang wieder kalt.
      }
    };
    const ric = (
      globalThis as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
      }
    ).requestIdleCallback;
    if (typeof ric === "function") ric(warm, { timeout: 2500 });
    else setTimeout(warm, 800);
  }, []);

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
  // gelöschte/umgelabelte Codes — real passiert: ein Recent-Eintrag namens
  // „Wien Hbf" trug den Code sta:8101003, der auf „Inzersdorf Wien Blumental
  // Bahnhof" zeigt. Beim Antippen fuhr die Suche stumm nach Blumental.
  //
  // Hier hing der Aufruf früher an einem 800-ms-Timer. Das war ein Race: die
  // Persist-Middleware hydratet asynchron, und war sie nach 800 ms noch nicht
  // durch, stand `recentSearches` leer da → `codes.size === 0` → stiller
  // Abbruch. Im Log tauchte NIE ein /api/locations/by-codes-Aufruf auf, die
  // Selbstheilung lief also praktisch nie. Jetzt deterministisch an die
  // Rehydration gehängt.
  useEffect(() => {
    const run = () => {
      void useSearchStore.getState().validatePersistedCodes();
    };
    if (useSearchStore.persist.hasHydrated()) {
      run();
      return;
    }
    return useSearchStore.persist.onFinishHydration(run);
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
          <View className={isDark ? "dark flex-1" : "flex-1"} style={{ flex: 1, backgroundColor: appBg }}>
            <StatusBar style={isDark ? "light" : "dark"} />
            {/* RouteMirror hält Pfad + Params in einer stabilen Ref, damit die
                ResultCards nicht mehr selbst am Router hängen (sie brauchen die
                Route nur im Press-Handler). Vorher rendete JEDE gemountete Karte
                bei JEDEM Tab-Wechsel neu — an der memo-Schranke vorbei, weil der
                Hook in der Karte selbst saß. Siehe lib/nav/routeMirror.tsx. */}
            <RouteMirror>
            {/* Kein App-weites Scale mehr: die Tiefe (Home weicht zurück) läuft
                jetzt NUR auf dem Home-Screen-Inhalt (HomeContentDepth in der
                Home-Page) — so bleibt die native Bottom-Tab-Bar statisch und
                sichtbar, statt mitzuschrumpfen. */}
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: appBg },
                // KEINE Slide-Animation — weder beim Push noch beim Pop.
                // Default Stack-Animation wäre slide_from_right (iOS) bzw.
                // fade_from_bottom (Android), was beim Öffnen von Bo +
                // Results unerwünscht reinslidet. Wir wollen instant.
                animation: "none",
              }}
            >
              <Stack.Screen name="(tabs)" />
              {/* Bo genauso — aus demselben Grund wie beim Suchen darunter.
                  OHNE das nimmt der Stack den vorigen Bildschirm aus dem Bild,
                  sobald navigiert wird. Bo fährt dann über SCHWARZ herein statt
                  über den Landingscreen, und weil die Navigation im
                  Tipp-Handler passiert, ist das Schwarz schon da, bevor Bo
                  überhaupt losgefahren ist. */}
              <Stack.Screen
                name="assistant"
                options={{
                  presentation: "transparentModal",
                  animation: "none",
                  contentStyle: { backgroundColor: "transparent" },
                }}
              />
              {/* search als transparentModal: der vorige Screen (z.B. der
                  Home-Tab) bleibt DARUNTER gemountet & sichtbar während der
                  Slide-In läuft. */}
              <Stack.Screen
                name="search"
                options={{
                  presentation: "transparentModal",
                  animation: "none",
                  contentStyle: { backgroundColor: "transparent" },
                }}
              />
            </Stack>
            {/* KEIN Dim mehr: Der Home ist von sich aus #1A1A1A = exakt die
                Box-Endfarbe. Ein Dim (schwarz → Farb-Stufe; oder deckend
                #1A1A1A → Bildschirm „ploppt" vor Expand-Ende in die Endfarbe)
                zerstört beides Mal den Expand. Die Box wächst jetzt sichtbar
                über den echten (farbgleichen) Home. */}
            {/* StopDetailSheet wird hier registriert (nicht in den Tabs)
                damit der Slide ÜBER der FloatingTabBar UND allen Tab-Pages
                liegt — wie alle anderen Sheets im Root-Layout. */}
            <StopDetailSheet />
            {/* SearchHeroOverlay am ROOT (nicht im Home-Tab): nur hier ist die
                Overlay-Fläche == Fenster, sodass die Fenster-Koordinaten der
                Kachel (pageX/pageY) exakt auf die Icon-/Box-Platzierung passen.
                Im Tab-Screen (Fenster minus Bar) läge das Icon daneben. */}
            <SearchHeroOverlay />
            {/* Die Tab-Leiste — HIER, nicht im Tab-Baum.
                Ihre Position in dieser Liste ist die Schichtung: über dem
                Such-Screen (der sie sonst verdeckt), aber unter der
                Ergebnisliste und den Detail-Blättern, die den ganzen Bildschirm
                für sich beanspruchen. */}
            <BinchTabBar />

            {/* NACH der Leiste: Das Verlaufs-Blatt kommt vom unteren Rand und
                deckt sie mit ab. Davor gerendert lag die halbdurchsichtige
                Leiste über Blatt und Verdunkelung — und fing dort Berührungen
                ab, sodass man durch die Verdunkelung hindurch den Tab wechseln
                konnte, während das Blatt offen stehen blieb. */}
            <RecentHistoryOverlay />

            {/* Ergebnis-Bildschirm: dauerhaft gemountet statt pro Aufruf gebaut.
                NACH dem Such-Screen, weil er über ihn slidet — und vor den
                Detail-Überlagerungen, die wiederum über ihn sliden. Dieselbe
                Schichtung wie vorher, als er noch eine Route war. */}
            <ResultsView />
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
            {/* Unterschirme des Profil-Tabs: HIER, nicht im Tab — nur von der
                Wurzel aus decken sie die native Tab-Leiste mit ab. Vor
                BinchAuthScreen, also darunter. */}
            <SettingsSubOverlay />
            <BinchAuthScreen />
            <AuthHydrator />
            </RouteMirror>
          </View>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
