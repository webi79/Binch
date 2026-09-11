import { format, parseISO } from "date-fns";
import { de as deLocale, enUS, es as esLocale, fr as frLocale, type Locale as DateLocale } from "date-fns/locale";
import { useCallback, useMemo } from "react";
import { useT } from "@/lib/i18n/useT";
import { useSearchStore } from "@/stores/searchStore";

/**
 * Strecke und Eckdaten formatieren — an EINER Stelle für die ganze App.
 *
 * Diese Zeile („13. Sep · 1 Reisender · Economy") steht inzwischen an mehreren
 * Orten: im Kopf der Ergebnisliste, auf der Karte eines Preis-Alarms und unter
 * der Glocke bei einer ausgelösten Meldung. Sie zweimal zu schreiben hieße,
 * dass dasselbe Datum in derselben App verschieden aussieht, sobald jemand an
 * einer der Kopien etwas ändert — und der Punkt hinter dem Tag ist genau die
 * Art Detail, die dabei zuerst auseinanderläuft.
 */

/**
 * Trenner zwischen zwei Orten: Halbgeviertstrich MIT Leerzeichen.
 *
 * Kein Bindestrich — „Berlin-Teneriffa" liest sich als ein zusammengesetzter
 * Ortsname. Und mit Leerzeichen, weil die Zeile abgeschnitten wird und ein
 * Umbruch nur dort sauber fällt.
 */
export const ROUTE_SEP = " – ";

/** Trenner der Eckdaten-Zeile. */
export const META_SEP = " · ";

/**
 * Die Sprachdateien STATISCH, nicht nachgeladen.
 *
 * `date-fns` bündelt sie einzeln, und ein `import()` zur Laufzeit hieße, dass
 * die Zeile beim ersten Bild ohne Datum steht und einen Takt später umspringt.
 * Vier Einträge kosten nichts.
 */
const DATE_LOCALES: Record<string, DateLocale> = {
  en: enUS,
  de: deLocale,
  fr: frLocale,
  es: esLocale,
};

export function useRouteMeta() {
  const t = useT();
  const locale = useSearchStore((s) => s.locale);
  const dateLocale = DATE_LOCALES[locale] ?? enUS;

  /**
   * Ein Datum kurz — „13. Sep".
   *
   * Das Muster ist NICHT frei gewählt: Genau dieses benutzen RecentCard,
   * DetailsOverlay und LegTimelineOverlay. Scheitert das Auswerten, steht die
   * Rohform da statt „Invalid Date".
   */
  const fmtDate = useCallback(
    (iso: string): string => {
      if (!iso) return "";
      try {
        return format(parseISO(iso), "d. MMM", { locale: dateLocale });
      } catch {
        return iso;
      }
    },
    [dateLocale],
  );

  /**
   * Die Eckdaten-Zeile. Leere Teile fallen ERSATZLOS weg.
   *
   * Naheliegend wäre eine feste Kette mit zwei Trennern. Fehlt dann ein Stück —
   * bei einer Zug-Suche ohne Klasse etwa —, stünde ein nacktes „ · " in der
   * Zeile, und das liest sich wie ein Ladefehler.
   */
  const metaLine = useCallback(
    (a: { departDate: string; returnDate?: string; passengers: number; travelClassKey?: string }): string => {
      const departLabel = fmtDate(a.departDate);
      const returnLabel = fmtDate(a.returnDate ?? "");
      const dateLabel = departLabel && returnLabel ? `${departLabel}${ROUTE_SEP}${returnLabel}` : departLabel;
      const paxLabel =
        a.passengers > 0
          ? `${a.passengers} ${t(a.passengers === 1 ? "search.pax.one" : "search.pax.many")}`
          : "";
      const classLabel = a.travelClassKey ? t(a.travelClassKey) : "";
      return [dateLabel, paxLabel, classLabel].filter(Boolean).join(META_SEP);
    },
    [fmtDate, t],
  );

  const routeLine = useCallback((from: string, to: string) => `${from}${ROUTE_SEP}${to}`, []);

  return useMemo(() => ({ fmtDate, metaLine, routeLine }), [fmtDate, metaLine, routeLine]);
}
