import { View, Text } from "react-native";
import { Heart, Ticket as TicketIcon } from "lucide-react-native";
import { useT } from "@/lib/i18n/useT";

interface Props {
  tab: "trips" | "tickets";
}

export function EmptyState({ tab }: Props) {
  const t = useT();
  const Icon = tab === "trips" ? Heart : TicketIcon;
  const titleKey = tab === "trips" ? "saved.empty.trips.title" : "saved.empty.tickets.title";
  const bodyKey = tab === "trips" ? "saved.empty.trips.body" : "saved.empty.tickets.body";
  const iconColor = tab === "trips" ? "#FF3B5C" : "#56565C";

  return (
    <View className="items-center pt-16 px-8">
      <View className="w-[72px] h-[72px] rounded-2xl bg-[#242425] items-center justify-center mb-4">
        <Icon size={30} color={iconColor} strokeWidth={1.8} />
      </View>
      <Text className="text-base font-semibold text-white mb-2 text-center">{t(titleKey)}</Text>
      <Text className="text-[13px] text-[#8A8A90] text-center leading-5">{t(bodyKey)}</Text>
    </View>
  );
}
