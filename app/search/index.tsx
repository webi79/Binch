import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { useIsFocused } from "@react-navigation/native";
import { SearchHero } from "@/components/search/SearchHero";
import { useSearchStore } from "@/stores/searchStore";

/**
 * Nur rendern wenn dieser Screen tatsächlich der aktive Stack-Eintrag ist
 * UND seit dem Fokus-Gain ≥80 ms vergangen sind.
 *
 * Hintergrund: bei `router.push("/search/results")` von außerhalb des
 * Search-Stacks (z.B. aus der Recent-History im Home-Tab) mountet expo-router
 * den Stack zuerst mit `index` als Bottom, schiebt dann `results` drauf. In
 * den 1-2 Frames dazwischen ist `index` fokussiert — der SearchHero (mit
 * Mic-Icon und Modal-artigem Layout) blitzt für den User wie ein kurzer
 * Voice-Screen auf.
 *
 * Mit dem Focus+Delay-Guard rendern wir gar nichts während dieser kurzen
 * Pass-Through-Phase. Bei direkter Navigation zu `/search` (z.B. via SearchBar
 * onPress-Fallback) ist focused dauerhaft true → nach 80 ms ist der Hero da.
 */
export default function SearchScreen() {
  const focused = useIsFocused();
  const mode = useSearchStore((s) => s.activeMode);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!focused) {
      setReady(false);
      return;
    }
    const t = setTimeout(() => setReady(true), 80);
    return () => clearTimeout(t);
  }, [focused]);

  if (!focused || !ready) return null;

  return (
    <SafeAreaView className="flex-1 bg-[#1A1A1A]" edges={["top"]}>
      <SearchHero mode={mode} />
    </SafeAreaView>
  );
}
