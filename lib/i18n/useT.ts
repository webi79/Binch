import { useSearchStore } from "@/stores/searchStore";
import { dictionaries } from "./dict";

export function useT() {
  const locale = useSearchStore((s) => s.locale);
  return (key: string) => dictionaries[locale]?.[key] ?? dictionaries.en[key] ?? key;
}
