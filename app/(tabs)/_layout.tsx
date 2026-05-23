import { Tabs } from "expo-router";
import { View } from "react-native";
import { useT } from "@/lib/i18n/useT";

export default function TabsLayout() {
  const t = useT();

  return (
    <View style={{ flex: 1, backgroundColor: "#1A1A1A" }}>
      <Tabs
        // detachInactiveScreens ist eine Navigator-Level-Prop (kein screenOption).
        // Default in react-native-screens v3+ ist `true` — der native View-
        // Container des inaktiven Tabs wird beim Verlassen vom Tree abgehängt,
        // beim Zurück-Wechseln wieder angehängt → 1-2 Frame Latenz pro Switch.
        // Mit `false` bleiben alle Tabs durchgehend im native View-Tree
        // (nur visibility wechselt) → Switch ist effektiv nur ein Toggle.
        detachInactiveScreens={false}
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: "none" },
          sceneStyle: { backgroundColor: "#1A1A1A" },
          // Tab-Wechsel ohne Crossfade/Shift — der grüne Kreis im
          // FloatingTabBar liefert genug visuelles Feedback. So fühlt
          // sich der Tab-Wechsel sofort an statt mit Verzögerung.
          animation: "none",
          // Alle Tabs eager mounten (statt lazy beim ersten Besuch). Trade-
          // off: App-Start dauert ~200-400 ms länger (Surroundings mit
          // MapLibre + Saved-SectionList werden vorbereitet), dafür ist
          // jeder Tab-Switch danach instant ohne Mount-Stutter.
          lazy: false,
          // Render-Loop auf inaktiven Tabs NICHT einfrieren. Default ist
          // bereits `false`, aber explizit weil's für unsere App wichtig
          // ist (z.B. damit der MapLibre-Container im Surroundings-Tab
          // beim Zurück-Wechseln nicht erst wieder hochfahren muss).
          freezeOnBlur: false,
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
