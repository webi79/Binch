/**
 * Buchungslinks in die Sprache des Users bringen.
 *
 * Warum hier und nicht im Provider: Der Deeplink wird beim Suchen erzeugt und
 * mit dem Ergebnis GECACHT. Die Sprache steckt aber nicht im Cache-Key — täten
 * wir sie hinein, fragmentierte der Cache je Sprache um den Faktor 4, und das
 * ausgerechnet auch für Flüge, wo das Anbieter-Kontingent knapp ist.
 *
 * Also lokalisieren wir erst beim REDIRECT (routes/redirect.ts liest `?lang=`).
 * Das kostet nichts, wirkt auch auf längst gecachte Ergebnisse und ist der
 * einzige Ort, der die Sprache des KLICKENDEN Users kennt — nicht die dessen,
 * der die Suche zufällig als Erster ausgelöst hat.
 */

/** Die vier Sprachen der App. */
export type AppLocale = "de" | "en" | "fr" | "es";

export function isAppLocale(v: unknown): v is AppLocale {
  return v === "de" || v === "en" || v === "fr" || v === "es";
}

/**
 * FlixBus-Shop je Sprache.
 *
 * NICHT geraten — ausgelesen aus dem Sprachumschalter von shop.flixbus.de selbst
 * (`switch_url` pro Sprache, 27 Einträge). FlixBus schaltet über die DOMAIN und
 * `_locale` gemeinsam um; „shop.flixbus.com&_locale=de" ist nicht ihr Weg.
 */
const FLIXBUS_SHOP: Record<AppLocale, string> = {
  de: "shop.flixbus.de",
  en: "shop.global.flixbus.com",
  fr: "shop.flixbus.fr",
  es: "shop.flixbus.es",
};

/**
 * Passt einen Buchungslink an die Sprache an. Unbekannte Hosts bleiben
 * unverändert — lieber der Original-Link als ein kaputt manipulierter.
 */
export function localizeBookingUrl(rawUrl: string, locale: AppLocale): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  // FlixBus: Host tauschen + _locale setzen.
  if (/(^|\.)flixbus\.[a-z.]+$/i.test(url.hostname) || url.hostname.endsWith("flix.com.mx")) {
    url.hostname = FLIXBUS_SHOP[locale];
    url.searchParams.set("_locale", locale);
    return url.toString();
  }

  return rawUrl;
}
