/**
 * Akzent-Farb-System.
 *
 * Drei Paletten: Lime (Default, war vorher hardcoded #7FEA4D), Mint, Iris.
 * User wählt eine im Settings-Screen, die Auswahl liegt in `searchStore.accent`
 * und propagiert über den useAccent-Hook in jeden Component der den Akzent
 * verwendet (Tab-Bar, Buttons, Line-Badges, Tabs, Ring im StopDetailSheet, …).
 *
 * Statt jeden Component einzeln `useSearchStore((s) => s.accent)` lesen zu
 * lassen, exportieren wir hier den `useAccent()`-Hook. Er liefert eine
 * voll-aufgelöste Palette mit Solid + abgeleiteten Tints/Borders + Gradient-
 * Stops. Damit ist es auch leicht „accent-aware" Subtle/Border-Tönungen zu
 * machen ohne dass jeder Caller `rgba(...)` selber baut.
 */
import { useSearchStore } from "@/stores/searchStore";

export type AccentId = "lime" | "mint";

export interface AccentPalette {
  id: AccentId;
  label: string;
  /** Solid-Hex, gleichwertig zur alten LIME-Konstante. */
  solid: string;
  /** Dunklere Version für Hover/Pressed. */
  dark: string;
  /** Schwacher Hintergrund-Tint (~16% alpha) — passt für Line-Badges, Pill-Bg. */
  subtle: string;
  /** Border-Variante (~30% alpha) — für 1px-Borders auf Subtle-Bg. */
  border: string;
  /**
   * Pille hinter dem aktiven Tab-Icon.
   *
   * Bewusst NICHT `border` (30%): Über der dunklen Leiste ergibt das gemischt
   * etwa #3F5F31 — ein stumpfes Oliv, das mit dem Akzent der App nichts mehr zu
   * tun hat. 55% liegen sichtbar im Akzentton und lassen das weiße Icon
   * trotzdem klar stehen.
   */
  indicator: string;
  /** 3-Stops-Gradient (für LinearGradient): light/main/dark. */
  gradient: [string, string, string];
  /** Text-Farbe AUF dem Solid-Bg (immer #000 hier — Solid sind hell genug). */
  textOnSolid: string;
}

export const ACCENT_PALETTES: Record<AccentId, AccentPalette> = {
  lime: {
    id: "lime",
    label: "Lime",
    solid: "#7FEA4D",
    dark: "#5DBE34",
    subtle: "rgba(127,234,77,0.16)",
    border: "rgba(127,234,77,0.30)",
    indicator: "rgba(127,234,77,0.55)",
    gradient: ["#A6F37A", "#7FEA4D", "#4FB42B"],
    textOnSolid: "#000000",
  },
  mint: {
    id: "mint",
    label: "Mint",
    solid: "#3FE0A8",
    dark: "#1FA877",
    subtle: "rgba(63,224,168,0.16)",
    border: "rgba(63,224,168,0.30)",
    indicator: "rgba(63,224,168,0.55)",
    gradient: ["#7BFFD0", "#3FE0A8", "#1FA877"],
    textOnSolid: "#000000",
  },
};

export const ACCENT_LIST: AccentPalette[] = [
  ACCENT_PALETTES.lime,
  ACCENT_PALETTES.mint,
];

/** Liefert die aktive Palette aus dem Store. Re-rendert den Caller wenn der
 *  User den Akzent wechselt — Zustand-Selektor sorgt für minimale Re-Renders. */
export function useAccent(): AccentPalette {
  const id = useSearchStore((s) => s.accent);
  return ACCENT_PALETTES[id] ?? ACCENT_PALETTES.lime;
}
