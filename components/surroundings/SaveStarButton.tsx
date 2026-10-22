/**
 * SaveStarButton — der Merken-Stern: schlicht und direkt.
 *
 * Der Tipp zeigt die runde Welle der übrigen Symbol-Knöpfe (gleich groß, nicht
 * bis in die Ecken des größeren Knopfes). Merken: Der gefüllte Stern in der
 * Akzentfarbe blendet ein und wächst dabei das letzte Stück auf seine Größe —
 * ohne Überschwinger. Entfernen: kurz ausblenden. Keine Funken, kein Glüh-Hof,
 * keine Drehung, kein Verlauf.
 *
 * Die Fassung davor („Variante 1a") sprang auf 145 % mit Drehung, warf fünfzehn
 * Funken und lief fast zwei Sekunden — sie wirkte schwer und passte nicht zur
 * App. Bestätigt wird das Merken zusätzlich mit der Meldung der App
 * (`GlideToast`, ausgelöst vom Aufrufer).
 *
 * Engine: Reanimated (UI-Strang); der klassische Animated-Treiber bleibt auf
 * der neuen Architektur hängen. Der gefüllte Stern hängt nur, solange er zu
 * sehen ist — der Knopf steht in jeder Zeile des Ortswählers.
 *
 * Verwendung: <SaveStarButton saved={saved} onChange={(willSave) => ...} />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { RippleTouch } from "@/components/ui/RippleTouch";
import { haptic } from "@/lib/haptics";
import { useAccent } from "@/lib/theme/accent";
import { scaledStyles } from "@/lib/ui/compact";

// Stern-Pfad (viewBox 0 0 24 24)
const STAR_PATH =
  "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";

const FILL_IN = { duration: 200, easing: Easing.out(Easing.cubic) };
const FILL_OUT = { duration: 150, easing: Easing.in(Easing.quad) };
/** Die Welle — so groß wie bei den übrigen runden Symbol-Knöpfen (44-dp-Kreis). */
const RIPPLE_RADIUS = 22;

interface Props {
  size?: number;
  starSize?: number;
  saved?: boolean;
  onChange?: (saved: boolean) => void;
}

export function SaveStarButton({ size = 46, starSize = 30, saved: savedProp, onChange }: Props) {
  const accent = useAccent();
  const [savedState, setSavedState] = useState(false);
  const saved = savedProp ?? savedState;

  /** 0 = leer, 1 = gefüllt — dazwischen die Bewegung. */
  const fill = useSharedValue(saved ? 1 : 0);
  /** Hängt der gefüllte Stern? Bis zum Ende des Ausblendens. */
  const [shown, setShown] = useState(saved);
  const pressOrigin = useRef(false);

  const handlePress = useCallback(() => {
    const willSave = !saved;
    pressOrigin.current = true;
    haptic(willSave ? "important" : "button");
    if (willSave) {
      setShown(true);
      fill.value = 0;
      fill.value = withTiming(1, FILL_IN);
    } else {
      fill.value = withTiming(0, FILL_OUT, (finished) => {
        if (finished) runOnJS(setShown)(false);
      });
    }
    if (savedProp === undefined) setSavedState(willSave);
    onChange?.(willSave);
  }, [saved, onChange, savedProp, fill]);

  // Von außen geändert (Einhängen, anderer Halt) → ohne Bewegung in den Zustand.
  useEffect(() => {
    if (pressOrigin.current) {
      pressOrigin.current = false;
      return;
    }
    cancelAnimation(fill);
    fill.value = saved ? 1 : 0;
    setShown(saved);
  }, [saved, fill]);

  const fillStyle = useAnimatedStyle(() => ({
    opacity: interpolate(fill.value, [0, 0.6], [0, 1], Extrapolation.CLAMP),
    transform: [{ scale: interpolate(fill.value, [0, 1], [0.82, 1], Extrapolation.CLAMP) }],
  }));

  return (
    <RippleTouch
      onPress={handlePress}
      hitSlop={10}
      borderless
      rippleRadius={Math.min(RIPPLE_RADIUS, size / 2)}
      accessibilityRole="button"
      accessibilityLabel={saved ? "Unsave station" : "Save station"}
      style={[styles.btn, { width: size, height: size }]}
    >
      {/* Umriss-Stern (immer sichtbar, weiß) */}
      <Svg width={starSize} height={starSize} viewBox="0 0 24 24">
        <Path
          d={STAR_PATH}
          fill="none"
          stroke="#F4F4F5"
          strokeWidth={1.7}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </Svg>

      {/* Gefüllter Stern — nur gemountet, solange er zu sehen ist. */}
      {shown && (
        <Animated.View pointerEvents="none" style={[styles.overlay, fillStyle]}>
          <Svg width={starSize} height={starSize} viewBox="0 0 24 24">
            <Path
              d={STAR_PATH}
              fill={accent.solid}
              stroke={accent.solid}
              strokeWidth={1.7}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </Svg>
        </Animated.View>
      )}
    </RippleTouch>
  );
}

const styles = scaledStyles({
  btn: { alignItems: "center", justifyContent: "center" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
});
