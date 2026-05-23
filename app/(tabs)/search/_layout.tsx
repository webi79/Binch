import { Stack } from "expo-router";

// Initial-Route explizit auf `index` festsetzen. Ohne diese Zeile nimmt
// react-navigation das erste deklarierte `<Stack.Screen>` als Initial-Route —
// das wäre `voice`. Resultat war: bei `router.push("/search/results")` aus
// dem Home-Tab baute der Stack `[voice, results]` auf, sodass der User beim
// Zurück-Pressen das Voice-Screen für einen Moment sah.
export const unstable_settings = {
  initialRouteName: "index",
};

export default function SearchLayout() {
  return (
    <Stack
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        animation: "none",
        contentStyle: { backgroundColor: "#1A1A1A" },
      }}
    >
      <Stack.Screen
        name="voice"
        options={{
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
    </Stack>
  );
}
