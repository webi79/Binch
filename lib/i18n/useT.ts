import { useMemo } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { dictionaries } from "./dict";

/**
 * Returns the translator function. Memoized by locale — gibt dieselbe
 * Function-Referenz zurück solange der User die Sprache nicht wechselt.
 * Wichtig für Memo'te Components (z.B. Bubble im Assistant-Chat), die
 * `t` als Prop kriegen — ohne useMemo würde die neue Funktion jeden Re-
 * Render den Memo-Schutz brechen.
 */
export function useT() {
  const locale = useSearchStore((s) => s.locale);
  return useMemo(
    () => (key: string) => dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key,
    [locale],
  );
}
