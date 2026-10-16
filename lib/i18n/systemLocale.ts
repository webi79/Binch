import { I18nManager } from "react-native";
import type { Locale } from "@/lib/i18n/dict";

/**
 * Die Sprache des TELEFONS — für den allerersten Start.
 *
 * Bis hierher stand als Vorgabe fest „de". Wer die App in Madrid installierte,
 * bekam sie auf Deutsch und musste die Einstellung erst finden.
 *
 * WARUM OHNE NEUE ABHÄNGIGKEIT: `Intl` ist in Hermes fest einkompiliert — die
 * React-Native-Build-Datei setzt `HERMES_ENABLE_INTL=True` ausdrücklich und
 * ohne Schalter, auf Android wie auf Apple. Dieselbe Schnittstelle wird in
 * diesem Projekt längst benutzt, nämlich für die Zeitzone in
 * `lib/notifications/push.ts`. `expo-localization` bräuchte einen neuen
 * nativen Build und liefert für diese eine Frage nichts, was hier fehlt.
 *
 * WARUM SYNCHRON: Der Wert wird als ANFANGSWERT des Speichers gebraucht, also
 * bevor die Persistenz überhaupt anläuft (siehe `searchStore.ts`). Alles
 * Asynchrone käme zu spät und liefe in die dokumentierte Falle, dass
 * Schreibvorgänge vor dem Ende der Hydrierung überrollt werden.
 *
 * WARUM MIT `try`: Diese Funktion läuft beim Laden des Speicher-Moduls, und
 * das Modul hängt an fast jeder Datei der App. Eine Ausnahme hier nähme den
 * ganzen Start mit.
 */

/** Was die App wirklich kann — siehe `dict.ts`. */
const SUPPORTED: readonly string[] = ["en", "de", "fr", "es"];

/** Der Rückfall, wenn das Telefon etwas sagt, das wir nicht sprechen. */
const FALLBACK: Locale = "en";

export function systemLocale(): Locale {
  try {
    /**
     * Zwei Quellen, in dieser Reihenfolge:
     *
     * 1. `Intl` — liefert auf BEIDEN Plattformen dasselbe Format („de-DE").
     * 2. Androids `localeIdentifier` als Rückfall — dort mit Unterstrich
     *    („de_DE"), manchmal mit Skript-Anhang („zh_CN_#Hans"). Auf iOS gibt
     *    es das Feld nicht; die Typdefinition führt es deshalb als optional.
     *
     * Die Trennung unten nimmt beide Schreibweisen, damit aus der Reihenfolge
     * keine stille Abhängigkeit wird.
     */
    const tag =
      Intl.DateTimeFormat().resolvedOptions().locale ||
      I18nManager.getConstants().localeIdentifier ||
      "";
    const lang = tag.split(/[-_]/)[0]?.toLowerCase() ?? "";
    return SUPPORTED.includes(lang) ? (lang as Locale) : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
