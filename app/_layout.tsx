import "../global.css";

import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useColorScheme, View } from "react-native";
import { useSearchStore } from "@/stores/searchStore";
import { useMemo } from "react";
import { SearchHeroOverlay } from "@/components/search/SearchHeroOverlay";
import { VoiceOverlay } from "@/components/search/VoiceOverlay";
import { RecentHistoryOverlay } from "@/components/home/RecentHistoryOverlay";
import { LegTimelineOverlay } from "@/components/results/LegTimelineOverlay";
import { AppAlertHost } from "@/components/ui/AppAlertHost";
import { FloatingTabBar } from "@/components/ui/FloatingTabBar";
import { SavedToastHost } from "@/components/ui/SavedToastHost";
import { AuthOverlay } from "@/components/auth/AuthOverlay";
import { AuthHydrator } from "@/components/auth/AuthHydrator";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 1000, retry: 1 } },
});

export default function RootLayout() {
  const system = useColorScheme();
  const theme = useSearchStore((s) => s.theme);
  const isDark = useMemo(() => (theme === "gray" ? system === "dark" : theme === "dark"), [theme, system]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <View className={isDark ? "dark flex-1" : "flex-1"} style={{ flex: 1, backgroundColor: "#1A1A1A" }}>
            <StatusBar style={isDark ? "light" : "dark"} />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#1A1A1A" } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen
                name="details"
                options={{
                  animation: "ios_from_right",
                  animationDuration: 480,
                  freezeOnBlur: false,
                }}
              />
            </Stack>
            <FloatingTabBar />
            <RecentHistoryOverlay />
            <SearchHeroOverlay />
            <VoiceOverlay />
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
