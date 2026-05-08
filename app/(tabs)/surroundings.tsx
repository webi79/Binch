import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useT } from "@/lib/i18n/useT";

export default function SurroundingsScreen() {
  const t = useT();
  return (
    <SafeAreaView className="flex-1 bg-[#1A1A1A]" edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text className="text-3xl font-bold text-white mb-2">{t("surroundings.title")}</Text>
        <View className="bg-[#1F1F20] border border-[#2E2E30] rounded-2xl p-4">
          <Text className="text-gray-400">{t("surroundings.subtitle")}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
