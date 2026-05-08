import { Tabs } from "expo-router";
import { View } from "react-native";
import { useT } from "@/lib/i18n/useT";

export default function TabsLayout() {
  const t = useT();

  return (
    <View style={{ flex: 1, backgroundColor: "#1A1A1A" }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: "none" },
          sceneStyle: { backgroundColor: "#1A1A1A" },
        }}
      >
        <Tabs.Screen name="index" options={{ title: t("bottomnav.booking") }} />
        <Tabs.Screen name="surroundings" options={{ title: t("bottomnav.surroundings") }} />
        <Tabs.Screen name="saved" options={{ title: t("bottomnav.saved") }} />
        <Tabs.Screen name="settings" options={{ title: t("bottomnav.settings") }} />
        <Tabs.Screen name="search" options={{ href: null }} />
      </Tabs>
    </View>
  );
}
