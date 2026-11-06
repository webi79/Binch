/**
 * EINLAUF von Karten — von unten, eine nach der anderen.
 *
 * Dieselbe Bewegung an zwei Stellen: die Einträge eines Tages im Kalender-Blatt
 * (über `FadeInDown` mit `ENTRY`) und die Karten der Gespeichert-Liste beim
 * Betreten des Tabs und beim Wechsel der Kategorie (über `IntroRow`). Die Zahlen
 * stehen deshalb nur hier.
 *
 * `IntroRow` baut NICHTS neu auf: Ein geteilter Fortschritt läuft linear über
 * die ganze Welle (0 → 1), jede Zeile rechnet daraus auf dem UI-Strang ihren
 * eigenen Abschnitt. Ein Neu-Aufbau der Liste beim Tab-Wechsel war genau das,
 * was hier früher geruckelt hat (siehe Gespeichert-Reiter).
 *
 * Bewusst klein: kurzer Weg, kein Federn, nur die ersten Zeilen — eine
 * Ankunft, keine Vorführung.
 */
import { memo, type ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, type SharedValue } from "react-native-reanimated";

/** Dauer je Karte, Vorlauf, Abstand zwischen zwei Karten (ms) und Weg nach oben (dp). */
export const ENTRY = { duration: 380, delay: 60, stagger: 70, rise: 28 } as const;
/** So viele Zeilen laufen mit — mehr passen ohnehin nicht auf den Bildschirm. */
export const INTRO_ROWS = 6;
/** Länge der ganzen Welle — über diese Zeit läuft der geteilte Fortschritt. */
export const INTRO_TOTAL = ENTRY.delay + (INTRO_ROWS - 1) * ENTRY.stagger + ENTRY.duration;

/** Ruhestellung — als Konstante, damit das Worklet kein neues Objekt pro Bild baut. */
const REST = { opacity: 1, transform: [{ translateY: 0 }] } as const;

export const IntroRow = memo(function IntroRow({
  index,
  intro,
  style,
  children,
}: {
  /** Platz in der Welle. Ab `INTRO_ROWS` steht die Zeile einfach da. */
  index: number;
  /** Geteilter Fortschritt 0 → 1, linear über `INTRO_TOTAL`. */
  intro: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const anim = useAnimatedStyle(() => {
    if (index >= INTRO_ROWS) return REST;
    const t = intro.value * INTRO_TOTAL - ENTRY.delay - index * ENTRY.stagger;
    const p = Math.min(1, Math.max(0, t / ENTRY.duration));
    // Ausrollen wie `Easing.out(Easing.cubic)` im Kalender.
    const e = 1 - (1 - p) * (1 - p) * (1 - p);
    return { opacity: e, transform: [{ translateY: (1 - e) * ENTRY.rise }] };
  });
  return <Animated.View style={[style, anim]}>{children}</Animated.View>;
});
