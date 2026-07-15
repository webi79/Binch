import { useEffect } from "react";
import { View, Text } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useIsFocused } from "@react-navigation/native";
import { Ticket as TicketIcon } from "lucide-react-native";
import { Bo } from "@/components/assistant/Bo";
import { useT } from "@/lib/i18n/useT";
import { useReduceMotion } from "@/lib/motion";

interface Props {
  tab: "trips" | "tickets";
  /**
   * Ist dieses Empty-State-Panel gerade das SICHTBARE?
   *
   * Reicht nicht, nur auf `isFocused` (Saved-Tab offen) zu prüfen: Wechselt man
   * im Saved-Tab auf die Tickets-Ansicht, bleibt das Trips-Panel gemountet
   * (SlidingPanels hält beide) und läge nur off-screen. Die Herz-Schleife liefe
   * dann unsichtbar im Hintergrund weiter und fräße Performance. `active` schaltet
   * sie ab, sobald das Panel nicht das vordere ist.
   */
  active?: boolean;
}

const HEART_COLOR = "#FF6B7A";

/**
 * Sanft schwebendes Herz um Bo herum.
 *
 * Auf-und-Ab (translateY) plus leichtes Wiegen (rotate um die Grundneigung),
 * als endlose Sinus-Schleife. Damit die drei Herzen nicht im Gleichtakt
 * wackeln, bekommt jedes eine andere Dauer und einen Versatz.
 *
 * Reanimated, nicht RN-Animated: Letzteres bleibt auf der New Architecture am
 * Startwert hängen (siehe [[classic_animated_fabric_stuck]]). Die Schleife läuft
 * NUR bei Fokus — Bo und die Herzen teilen sich den Saved-Tab, der permanent
 * gemountet bleibt; unfokussiert würde die UI-Thread-Schleife sonst mit anderen
 * Animationen (Landing-Scroll) konkurrieren.
 */
function FloatingHeart({
  top,
  left,
  right,
  bottom,
  size,
  rotate,
  opacity = 0.7,
  focused,
  delay = 0,
  duration = 2600,
  amp = 5,
  sway = 5,
}: {
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  size: number;
  rotate: number;
  opacity?: number;
  focused: boolean;
  delay?: number;
  duration?: number;
  amp?: number;
  sway?: number;
}) {
  const reduceMotion = useReduceMotion();
  // Läuft linear 0→1 und startet nahtlos neu; die Sinus-Abbildung unten macht
  // daraus eine glatte, sprungfreie Schwingung (sin(2π·0) == sin(2π·1) == 0).
  const phase = useSharedValue(0);

  useEffect(() => {
    if (!focused || reduceMotion) {
      cancelAnimation(phase);
      phase.value = 0;
      return;
    }
    phase.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false),
    );
    return () => cancelAnimation(phase);
  }, [focused, reduceMotion, phase, delay, duration]);

  const animatedStyle = useAnimatedStyle(() => {
    const a = phase.value * 2 * Math.PI;
    const wave = Math.sin(a);
    return {
      transform: [
        { translateY: wave * amp },
        // Wiegen leicht phasenverschoben zum Heben — wirkt organischer als
        // starr gekoppelt.
        { rotate: `${rotate + Math.sin(a + Math.PI / 3) * sway}deg` },
      ],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", top, left, right, bottom, opacity },
        animatedStyle,
      ]}
    >
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke={HEART_COLOR}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <Path d="M12 20s-6.8-4.3-9-8C1.3 9 2.6 5.4 6 5.4c2 0 3.2 1.2 4 2.4 0.8-1.2 2-2.4 4-2.4 3.4 0 4.7 3.6 3 6.6-2.2 3.7-9 8-9 8Z" />
      </Svg>
    </Animated.View>
  );
}

export function EmptyState({ tab, active = true }: Props) {
  const t = useT();
  // Native-Bottom-Tabs halten alle Tab-Screens mounted. Bo hat 33+
  // Reanimated-Hooks (auch mit paused=true bleiben die als UI-Thread-
  // Subscriptions aktiv) → wenn der Saved-Tab nicht fokussiert ist, sollte
  // Bo NICHT gerendert werden, sonst konkurriert er mit anderen Animations
  // (z.B. Landing-Scroll). Wir prüfen `useIsFocused` und unmounten Bo
  // sobald der User die Saved-Tab verlässt. Die Herzen laufen aus demselben
  // Grund nur bei Fokus (siehe FloatingHeart).
  const isFocused = useIsFocused();
  // Animieren nur, wenn der Saved-Tab offen UND dieses Panel das sichtbare ist.
  const animate = isFocused && active;
  const titleKey =
    tab === "trips" ? "saved.empty.trips.title" : "saved.empty.tickets.title";
  const bodyKey =
    tab === "trips" ? "saved.empty.trips.body" : "saved.empty.tickets.body";

  if (tab === "trips") {
    return (
      <View className="items-center pt-12 px-8">
        <View style={{ width: 200, height: 220, alignItems: "center", justifyContent: "center" }}>
          <FloatingHeart
            top={4}
            left={6}
            size={26}
            rotate={-12}
            opacity={0.85}
            focused={animate}
            duration={3600}
            amp={6}
            sway={6}
          />
          <FloatingHeart
            top={46}
            right={0}
            size={18}
            rotate={14}
            opacity={0.7}
            focused={animate}
            delay={700}
            duration={4400}
            amp={4}
            sway={5}
          />
          <FloatingHeart
            bottom={28}
            left={12}
            size={20}
            rotate={-8}
            opacity={0.75}
            focused={animate}
            delay={1300}
            duration={4000}
            amp={5}
            sway={5}
          />
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
