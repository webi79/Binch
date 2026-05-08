import { Locale } from "@/stores/searchStore";

const MAP: Record<Locale, string> = {
  en: "en-GB",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
};

export function intlLocale(locale: Locale): string {
  return MAP[locale] ?? "en-GB";
}
