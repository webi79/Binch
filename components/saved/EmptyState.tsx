import { useEffect, useRef } from "react";
import { View, Text } from "react-native";
import { usePalette } from "@/lib/theme/appBg";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
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

  // Beim ERSTEN Erscheinen mit gestaffeltem Anlauf, danach nahtlos weiter.
  const startedRef = useRef(false);

  useEffect(() => {
    if (!focused || reduceMotion) {
      // Nur anhalten, NICHT zurücksetzen. Vorher sprang die Phase auf 0 — beim
      // Verlassen des Tabs rutschten also alle Herzen auf ihre Grundstellung,
      // und beim Zurückkommen standen sie dort bis zu 1,3s regungslos (der
      // Anlauf-Versatz lief jedes Mal neu), bevor sie ansprangen. Genau das ließ
      // die Szene bei jedem Besuch wie frisch hingesetzt wirken.
      cancelAnimation(phase);
      return;
    }
    const loop = withRepeat(
      withTiming(1, { duration, easing: Easing.linear }),
      -1,
      false,
    );
    if (!startedRef.current) {
      startedRef.current = true;
      phase.value = 0;
      phase.value = withDelay(delay, loop);
    } else {
      // Dort weiter, wo angehalten wurde: der Rest des laufenden Durchgangs zu
      // unveränderter Geschwindigkeit, dann wieder die Endlosschleife.
      //
      // Der Rücksprung auf 0 in der Mitte ist NICHT kosmetisch, er ist der
      // eigentliche Punkt: `withRepeat` wiederholt ab dem Wert, mit dem es
      // startet. Ohne ihn übernähme die Schleife die 1 vom Schritt davor und
      // liefe von 1 nach 1 — die Herzen standen dann nach einem Tab-Wechsel
      // einfach still. Sichtbar ist der Sprung nicht: sin(2π·1) und sin(2π·0)
      // sind beide 0, also exakt dieselbe Stellung.
      phase.value = withSequence(
        withTiming(1, {
          duration: duration * (1 - phase.value),
          easing: Easing.linear,
        }),
        withTiming(0, { duration: 0 }),
        loop,
      );
    }
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
  const palette = usePalette();
  const t = useT();
  // Native-Bottom-Tabs halten alle Tab-Screens gemountet, deshalb hängen die
  // Herz-SCHLEIFEN am Fokus — im Hintergrund würden sie mit dem Scrollen anderer
  // Tabs konkurrieren.
  //
  // Bo hängt bewusst NICHT mehr daran: Er läuft hier fest mit `paused`, und in
  // dem Zustand startet er keine einzige Animation (nur einmalig statische
  // Posen-Werte). Gemountet kostet er also pro Bild nichts, während das
  // Ab- und Wiederaufbauen seinen ganzen SVG-Baum in den Wechsel-Frame legte.
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
          {/* Dauerhaft gemountet statt bei jedem Fokus neu.
              Das Ab- und Wiederaufbauen war reine Verschwendung: Bo trägt 27
              Endlos-Animationen und einen SVG-Baum, die bei JEDEM Wechsel in den
              Tab komplett neu entstanden — sichtbar als „wird neu hingeklebt".
              Der Grund fürs Abbauen (Hintergrund-Last) greift ohnehin nicht,
              denn `paused` steht fest an: Die Schleifen laufen nie. */}
          <Bo state="sad" size={138} paused />
        </View>
        <Text className="text-base font-semibold text-white mb-2 text-center">
          {t(titleKey)}
        </Text>
        <Text className="text-[13px] text-[#8E8E93] text-center leading-5">
          {t(bodyKey)}
        </Text>
      </View>
    );
  }

  // Tickets-Tab: minimaler Ticket-Icon-Empty bleibt.
  return (
    <View className="items-center pt-16 px-8">
      <View className="w-[72px] h-[72px] rounded-2xl items-center justify-center mb-4" style={{ backgroundColor: palette.s2 }}>
        <TicketIcon size={30} color="#56565C" strokeWidth={1.8} />
      </View>
      <Text className="text-base font-semibold text-white mb-2 text-center">
        {t(titleKey)}
      </Text>
      <Text className="text-[13px] text-[#8E8E93] text-center leading-5">
        {t(bodyKey)}
      </Text>
    </View>
  );
}
