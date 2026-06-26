/**
 * Zustand für den „Verbindung nicht gefunden"-Modal (Papierflieger-Variante).
 * Getrennt vom generischen `useAlertStore` weil das Modal eine eigene
 * Illustration + CTA-Struktur hat (Zur Suche / Vielleicht später) und keine
 * beliebige Button-Liste rendert.
 *
 * Aufruf von überall via `showConnectionNotFound({ onSearch })`. Der Modal
 * selbst wird einmal in app/_layout.tsx gemountet (ConnectionNotFoundHost).
 */
import { create } from "zustand";
import type { TravelMode } from "@/types/search";

interface ConnectionNotFoundState {
  visible: boolean;
  /** Welcher Travel-Mode war zum Zeitpunkt des Fails aktiv? Bestimmt wo der
   *  „Zur Suche"-CTA hinführt — z.B. User hat Bus M27 getappt → Bus-Suche.
   *  Wenn unbekannt, fällt der Host auf den aktuell aktiven Mode im Store. */
  mode?: TravelMode;
  /** Custom-onSearch falls Caller eigene Navigation will (Default: Search-
   *  Overlay mit `mode` öffnen). */
  onSearch?: () => void;
  /** Optional: Title/Body überschreiben. Default kommt aus i18n. */
  title?: string;
  message?: string;
  show: (args?: {
    mode?: TravelMode;
    onSearch?: () => void;
    title?: string;
    message?: string;
  }) => void;
  dismiss: () => void;
}

export const useConnectionNotFoundStore = create<ConnectionNotFoundState>((set) => ({
  visible: false,
  show: (args) =>
    set({
      visible: true,
      mode: args?.mode,
      onSearch: args?.onSearch,
      title: args?.title,
      message: args?.message,
    }),
  dismiss: () =>
    set({
      visible: false,
      mode: undefined,
      onSearch: undefined,
      title: undefined,
      message: undefined,
    }),
}));

/** Drop-in-Funktion: zeigt das Modal.
 *  @param args.mode  Welcher Travel-Mode soll der „Zur Suche"-CTA öffnen?
 *                    Z.B. wenn User Bus-Departure getappt hat → mode="BUS".
 *  @param args.onSearch  Override für die Suche-Navigation (selten gebraucht).
 */
export function showConnectionNotFound(args?: {
  mode?: TravelMode;
  onSearch?: () => void;
  title?: string;
  message?: string;
}): void {
  useConnectionNotFoundStore.getState().show(args);
}
