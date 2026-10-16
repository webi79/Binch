import { useSearchStore } from "@/stores/searchStore";
import { mapStyleFor } from "@/components/surroundings/mapStyle";
import type { Locale } from "@/lib/i18n/dict";
import type { StyleSpecification } from "@maplibre/maplibre-react-native";

/**
 * Welchen Karten-Stil zeigen wir? — die EINE Stelle, an der das entschieden wird.
 *
 * Es gibt vier Werte, aber nur drei Stile: „auto" ist die Kopplung an das
 * Thema der App, kein eigenes Aussehen. Wer nichts auswählt, bekommt zum
 * dunklen und zum grauen Thema die dunkle Karte und zum hellen die helle.
 *
 * Warum das hier liegt und nicht im Blatt: Die Auflösung brauchen mehrere
 * Stellen — die Kartenfläche (welcher Stil), das Blatt (welche Kachel ist
 * hervorgehoben) und die Knopfreihe (welches Zeichen). Drei Kopien derselben
 * Regel wären drei Stellen, an denen sie auseinanderläuft.
 */
export type MapStyleChoice = "auto" | "dark" | "light" | "satellite";

/** Der tatsächlich gezeigte Stil — „auto" ist hier schon aufgelöst. */
export type ResolvedMapStyle = "dark" | "light" | "satellite";

/**
 * Die Kopplung selbst, als reine Funktion — damit sie prüfbar ist und nicht an
 * einem Hook klebt.
 *
 * `gray` UND `dark` führen beide zur dunklen Karte: Das graue Thema ist in
 * dieser App kein Zwischenzustand, sondern das dunkle mit einem etwas weniger
 * harten Grund (siehe `appBg.ts`). Eine helle Karte darunter wäre ein Bruch.
 */
export function resolveMapStyle(
  choice: MapStyleChoice,
  theme: "light" | "dark" | "gray",
): ResolvedMapStyle {
  if (choice !== "auto") return choice;
  return theme === "light" ? "light" : "dark";
}

/** Reaktiv: Die Karte zeichnet neu, wenn Wahl ODER Thema wechseln. */
export function useResolvedMapStyle(): ResolvedMapStyle {
  const choice = useSearchStore((s) => s.mapStyleChoice);
  const theme = useSearchStore((s) => s.theme);
  return resolveMapStyle(choice, theme);
}

/**
 * Das Stil-Dokument zum aufgelösten Namen — in der Sprache der Beschriftungen.
 *
 * Für „satellite" gibt es hier (noch) keines: Satellit ist eine RASTER-Quelle
 * und wird an der Kartenfläche eigens zusammengesetzt, weil dort auch die
 * Beschriftungen darüber liegen müssen. Diese Funktion beantwortet deshalb nur
 * die Vektor-Fälle und gibt sonst `null` — der Aufrufer entscheidet.
 */
export function vectorStyleFor(
  resolved: ResolvedMapStyle,
  locale: Locale,
): StyleSpecification | null {
  if (resolved === "satellite") return null;
  return mapStyleFor(resolved, locale);
}
