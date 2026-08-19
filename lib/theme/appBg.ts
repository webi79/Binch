/**
 * Hintergrund- und Flächen-Farbsystem.
 *
 * Bisher waren Hintergrund (`#1A1A1A`) und die Flächen darüber (`#1F1F20`,
 * `#242425`, `#2A2A2C`, Rahmen `#2E2E30`) in jeder Datei fest verdrahtet. Der
 * Settings-Screen bietet aber drei Themes an, und „Dark" soll ein ECHTES
 * Schwarz sein.
 *
 * Im Dark-Theme rutscht die ganze Leiter eine Stufe nach unten: Was im Grau-
 * Theme der HINTERGRUND war (`#1A1A1A`), ist im Dark-Theme die Farbe der
 * Buttons/Kacheln/Nav-Bar. So bleibt der Kontrast-Abstand zwischen den Ebenen
 * gleich, nur eben dunkler.
 *
 * Zwei Zugriffswege, weil beide gebraucht werden:
 *  - `usePalette()` / `useAppBg()` — reaktiv für Komponenten (rendern bei
 *    Theme-Wechsel neu).
 *  - `getPalette()` / `getAppBg()`  — einmalig ohne Abo, für Modul-Konstanten
 *    und Stellen außerhalb der React-Render-Phase.
 *
 * ACHTUNG bei Animationen: Die Endfarbe der Launch-Box und die Scrims MÜSSEN
 * exakt `bg` treffen, sonst zeigt der Übergang eine sichtbare Stufe. Die
 * START-Farbe der Launch-Box muss `s2` treffen (die Kachelfarbe).
 */
import { useSearchStore } from "@/stores/searchStore";

export type ThemeId = "gray" | "dark" | "light";

export interface Palette {
  /** Screen-Hintergrund. */
  bg: string;
  /** Leicht abgehobene Fläche (Eingabefelder). */
  s1: string;
  /** Haupt-Fläche: Buttons, Kacheln, Karten, Nav-Bar. */
  s2: string;
  /** Stärker abgehobene Fläche (Chips auf Karten). */
  s3: string;
  /** Rahmen/Trennlinien. */
  border: string;
}

export const PALETTES: Record<ThemeId, Palette> = {
  /** Bisheriger Standard. */
  gray: {
    bg: "#1A1A1A",
    s1: "#1F1F20",
    s2: "#242425",
    s3: "#2A2A2C",
    border: "#2E2E30",
  },
  /** Echtes Schwarz (OLED). Jede Ebene eine Stufe dunkler — s2 ist exakt der
   *  frühere Grau-Hintergrund. */
  dark: {
    bg: "#000000",
    s1: "#141415",
    s2: "#1A1A1A",
    s3: "#202021",
    border: "#262628",
  },
  /** Noch nicht ausgearbeitet: Ein helles Theme braucht auch invertierte Text-
   *  farben, sonst wird die App unlesbar. Bis dahin wie Grau. */
  light: {
    bg: "#1A1A1A",
    s1: "#1F1F20",
    s2: "#242425",
    s3: "#2A2A2C",
    border: "#2E2E30",
  },
};

/** Reaktiv — Komponente rendert neu, wenn der Nutzer das Theme wechselt. */
export function usePalette(): Palette {
  return useSearchStore((s) => PALETTES[s.theme] ?? PALETTES.gray);
}

/** Nur der Screen-Hintergrund (häufigster Fall). */
export function useAppBg(): string {
  return useSearchStore((s) => (PALETTES[s.theme] ?? PALETTES.gray).bg);
}

/** Einmalig, ohne Abo (Modul-Konstanten, Nicht-Render-Kontext). */
export function getPalette(): Palette {
  return PALETTES[useSearchStore.getState().theme] ?? PALETTES.gray;
}

export function getAppBg(): string {
  return getPalette().bg;
}
