import { SafeAreaView } from "react-native-safe-area-context";
import { SearchHero } from "@/components/search/SearchHero";
import { useSearchStore } from "@/stores/searchStore";
import { SlideInOnFocus } from "@/lib/animations/slideInOnFocus";

export default function SearchScreen() {
  const mode = useSearchStore((s) => s.activeMode);
  return (
    <SlideInOnFocus from="bottom">
      <SafeAreaView className="flex-1 bg-[#1A1A1A]" edges={["top"]}>
        <SearchHero mode={mode} />
      </SafeAreaView>
    </SlideInOnFocus>
  );
}
