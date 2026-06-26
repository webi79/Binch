import { View, Text } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useIsFocused } from "@react-navigation/native";
import { Ticket as TicketIcon } from "lucide-react-native";
import { Bo } from "@/components/assistant/Bo";
import { useT } from "@/lib/i18n/useT";

interface Props {
  tab: "trips" | "tickets";
}

const HEART_COLOR = "#FF6B7A";

/**
 * Statisches Herz — keine Animation. SVG-Outline in Heart-Akzent-Farbe.
 * Wir setzen die Herzen mit absolute-Positionierung um Bo herum für die
 * "schwebend"-Optik ohne Reanimated-Worklets.
 */
function StaticHeart({
  top,
  left,
  right,
  bottom,
  size,
  rotate,
  opacity = 0.7,
}: {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  size: number;
  rotate: number;
  opacity?: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top,
        left,
        right,
        bottom,
        opacity,
        transform: [{ rotate: `${rotate}deg` }],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={HEART_COLOR} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M12 20s-6.8-4.3-9-8C1.3 9 2.6 5.4 6 5.4c2 0 3.2 1.2 4 2.4 0.8-1.2 2-2.4 4-2.4 3.4 0 4.7 3.6 3 6.6-2.2 3.7-9 8-9 8Z" />
      </Svg>
    </View>
  );
}

export function EmptyState({ tab }: Props) {
  const t = useT();
  // Native-Bottom-Tabs halten alle Tab-Screens mounted. Bo hat 33+
  // Reanimated-Hooks (auch mit paused=true bleiben die als UI-Thread-
  // Subscriptions aktiv) → wenn der Saved-Tab nicht fokussiert ist, sollte
  // Bo NICHT gerendert werden, sonst konkurriert er mit anderen Animations
  // (z.B. Landing-Scroll). Wir prüfen `useIsFocused` und unmounten Bo
  // sobald der User die Saved-Tab verlässt.
  const isFocused = useIsFocused();
  const titleKey =
    tab === "trips" ? "saved.empty.trips.title" : "saved.empty.tickets.title";
  const bodyKey =
    tab === "trips" ? "saved.empty.trips.body" : "saved.empty.tickets.body";

  if (tab === "trips") {
    return (
      <View className="items-center pt-12 px-8">
        <View style={{ width: 200, height: 220, alignItems: "center", justifyContent: "center" }}>
          <StaticHeart top={4} left={6} size={26} rotate={-12} opacity={0.85} />
          <StaticHeart top={46} right={0} size={18} rotate={14} opacity={0.7} />
          <StaticHeart bottom={28} left={12} size={20} rotate={-8} opacity={0.75} />
          {isFocused ? <Bo state="sad" size={138} paused /> : null}
        </View>
        <Text className="text-base font-semibold text-white mb-2 text-center">
          {t(titleKey)}
        </Text>
        <Text className="text-[13px] text-[#8A8A90] text-center leading-5">
          {t(bodyKey)}
        </Text>
      </View>
    );
  }

  // Tickets-Tab: minimaler Ticket-Icon-Empty bleibt.
  return (
    <View className="items-center pt-16 px-8">
      <View className="w-[72px] h-[72px] rounded-2xl bg-[#242425] items-center justify-center mb-4">
        <TicketIcon size={30} color="#56565C" strokeWidth={1.8} />
      </View>
      <Text className="text-base font-semibold text-white mb-2 text-center">
        {t(titleKey)}
      </Text>
      <Text className="text-[13px] text-[#8A8A90] text-center leading-5">
        {t(bodyKey)}
      </Text>
    </View>
  );
}
