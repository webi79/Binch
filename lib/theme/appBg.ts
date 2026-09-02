/**
 * Hintergrund- und Flächen-Farbsystem.
 *
 * Bisher waren Hintergrund und die Flächen darüber in jeder Datei fest
 * verdrahtet. Der Settings-Screen bietet aber drei Themes an, und „Dark" soll
 * ein ECHTES Schwarz sein.
 *
 * Im Dark-Theme rutscht die ganze Leiter eine Stufe nach unten: Der Grund ist
 * echtes Schwarz, die Flächen darüber entsprechend tiefer. So bleibt der
 * Kontrast-Abstand zwischen den Ebenen gleich, nur eben dunkler.
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
  /**
   * Der Standard — VIER Töne, und jeder hat genau eine Aufgabe.
   *
   * Vorher waren es acht, und das war der Grund für die Unruhe: Für dieselbe
   * Sache — „eine Box" — gab es zwei verschiedene Grautöne, je nachdem welche
   * Datei sie gebaut hat. Die Verlaufskarten lagen auf `#171719`, die Kacheln
   * daneben auf `#1B1B1B`; nebeneinander gelesen wirkte das zufällig statt
   * gestuft.
   *
   *   `bg`      Der Bildschirm.
   *   `s1`      Was den Bildschirm ERSETZT: Blätter, Dialoge, ganzflächige
   *             Wähler. Deshalb derselbe Ton — abgesetzt sind sie ohnehin, durch
   *             die Verdunkelung dahinter, die runde Oberkante, oder weil sie
   *             über Bild oder Karte liegen. Ein eigener Ton dafür war eine
   *             Unterscheidung ohne Unterschied.
   *   `s2`      JEDE Box: Karten, Kacheln, Eingabefelder, Gruppen, Knöpfe. Der
   *             Ton der Verlaufskarten — der, der auf dem Landingscreen am
   *             besten sitzt.
   *   `s3`      Was AUF einer Box liegt: Chips, Symbolkacheln, Zähler, Pillen,
   *             schwebende Meldungen.
   *   `border`  Rahmen und Trennlinien.
   *
   * `s3` und `border` tragen DENSELBEN Wert, und das ist Absicht: Beides ist
   * „eine Stufe über der Box", einmal als Fläche, einmal als Linie. Ein eigener
   * Wert dafür wären wieder zwei Grautöne, die man nebeneinander nicht
   * auseinanderhalten kann.
   *
   * Der Abstand ist gemessen, nicht geraten: Vor dem Umbau lag die Symbolkachel
   * der Verlaufskarte mit einem Kontrastverhältnis von 1.083 über ihrer Karte,
   * und so sah es richtig aus. Mit `#1B1B1B` waren es 1.039 — die Kachel
   * verschwand. Jetzt sind es 1.114.
   *
   * Die Leiste bleibt, wie sie war (`BAR_TINT` in BinchTabBar): getönt auf der
   * Stufe von `s2`, also im selben Ton wie die Boxen.
   */
  gray: {
    bg: "#0D0D0D",
    s1: "#0D0D0D",
    s2: "#171719",
    s3: "#212123",
    border: "#212123",
  },
  /**
   * Echtes Schwarz (OLED) — und sonst NICHTS anders als Grau.
   *
   * Die Boxen tragen dieselben Werte wie dort. Das ist der ganze Unterschied
   * zwischen den beiden Themes: Der Bildschirm geht auf reines Schwarz, die
   * Flächen darauf bleiben, wie sie sind.
   *
   * Vorher hatte Dark eine eigene, um eine Stufe versetzte Leiter (`#141415`,
   * `#1A1A1A`, `#202021`, `#262628`). Beim Umschalten wechselte damit nicht nur
   * der Grund, sondern jede Kachel und jede Karte gleich mit — es sah aus wie
   * ein anderes Design statt wie derselbe Bildschirm bei Nacht.
   */
  dark: {
    bg: "#000000",
    s1: "#000000",
    s2: "#171719",
    s3: "#212123",
    border: "#212123",
  },
  /** Noch nicht ausgearbeitet: Ein helles Theme braucht auch invertierte Text-
   *  farben, sonst wird die App unlesbar. Bis dahin wie Grau. */
  light: {
    bg: "#0D0D0D",
    s1: "#0D0D0D",
    s2: "#171719",
    s3: "#212123",
    border: "#212123",
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
