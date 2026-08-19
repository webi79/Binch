import { Stack } from "expo-router";
import { useAppBg } from "@/lib/theme/appBg";

// Initial-Route explizit auf `index` festsetzen. Ohne diese Zeile nimmt
// react-navigation das erste deklarierte `<Stack.Screen>` als Initial-Route —
// das wäre `voice`. Resultat war: bei `router.push("/search/results")` aus
// dem Home-Tab baute der Stack `[voice, results]` auf, sodass der User beim
// Zurück-Pressen das Voice-Screen für einen Moment sah.
export const unstable_settings = {
  initialRouteName: "index",
};

export default function SearchLayout() {
  const appBg = useAppBg();
  return (
    <Stack
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        animation: "none",
        contentStyle: { backgroundColor: appBg },
      }}
    >
      <Stack.Screen
        name="voice"
        options={{
          presentation: "modal",
          animation: "slide_from_bottom",
        }}
      />
      {/* results: contentStyle transparent damit der Stack-Container kein
          solides Rechteck über die Landing-Page legt. Der eigentliche
          Result-Hintergrund kommt aus styles.slideRoot in results.tsx, das
          via Reanimated von rechts reinslidet — DRÜBER die Landing. */}
      <Stack.Screen
        name="results"
        options={{ contentStyle: { backgroundColor: "transparent" } }}
      />
    </Stack>
  );
}
