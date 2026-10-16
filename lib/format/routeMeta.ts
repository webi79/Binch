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

/**
 * Leerzeichen innerhalb eines Ortsnamens gegen geschützte tauschen.
 *
 * U+00A0 sieht aus wie ein Leerzeichen, ist aber keine Trennstelle. Damit hält
 * der Textsatz „Paris Gare du Nord" zusammen.
 */
function nbsp(v: string): string {
  return v.replace(/ /g, "\u00A0");
}

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

  /**
   * Die Strecke als Zeile — und sie bricht NUR am Trennstrich um.
   *
   * Läuft die Zeile über, soll der Umbruch hinter „Start –" fallen, damit das
   * Ziel geschlossen darunter steht. Ohne Zutun sucht sich der Textsatz das
   * nächstbeste Leerzeichen und zerreißt den Ortsnamen: „Frankfurt (Main) Hbf –
   * Paris Gare du" / „Nord". Das liest sich wie ein abgeschnittener Satz, und
   * die Strecke ist auf einen Blick nicht mehr zu erfassen.
   *
   * Erzwungen über GESCHÜTZTE Leerzeichen innerhalb der beiden Namen: Dort darf
   * dann nicht mehr getrennt werden, am Trennstrich schon. Das ist der einzige
   * Weg, der ohne Messung auskommt — eine Fallunterscheidung „passt es in eine
   * Zeile?" bräuchte die Breite, und die steht erst nach dem Layout fest.
   *
   * Ist ein einzelner Name für sich zu lang, bricht Android ihn weiterhin
   * zeichenweise um. Das ist der Notausgang und bleibt bewusst offen — ein
   * abgeschnittener Name wäre schlechter als ein unschön umgebrochener.
   */
  const routeLine = useCallback(
    (from: string, to: string) => `${nbsp(from)}${ROUTE_SEP}${nbsp(to)}`,
    [],
  );

  return useMemo(() => ({ fmtDate, metaLine, routeLine }), [fmtDate, metaLine, routeLine]);
}

/** Werden die „Stopps" einer Verbindung als Zwischenlandung gezählt (Flug, Schiff)? */
function countsStops(mode: string): boolean {
  return mode === "FLIGHT" || mode === "CRUISE";
}

/**
 * Umstiege einer Verbindung als Text: „Direkt", „1 Umstieg", „2 Umstiege".
 *
 * `SearchResult.stops` zählt die UMSTIEGE (beim Flug die Zwischenlandungen) —
 * nie die Halte unterwegs, die stehen am Leg. Bei Zug und Bus hieß es trotzdem
 * „1 Stopp" („1 stop / STOPS" im Englischen), was sich wie ein Halt las; und der
 * Kopf der Zeitleiste beschriftete denselben Wert mit „Umstieg". Beim Flug
 * bleibt es beim üblichen „1 Stopp".
 */
export function changesText(mode: string, count: number, t: (key: string) => string): string {
  const k = countsStops(mode) ? "details.stop" : "details.change";
  if (count === 0) return t(`${k}.zero`);
  if (count === 1) return t(`${k}.one`);
  return t(`${k}.many`).replace("{count}", String(count));
}

/** Die passende Überschrift dazu: „Umstiege" bzw. beim Flug „Stopps". */
export function changesCaption(mode: string, t: (key: string) => string): string {
  return t(countsStops(mode) ? "details.summary.stops" : "details.summary.changes");
}

/** Kurzform für die Ergebniskarte: „1 Umstieg", „2 Umstiege" (beim Flug „1 Stopp"). */
export function changesShort(mode: string, count: number, t: (key: string) => string): string {
  const one = countsStops(mode) ? "results.stop" : "results.transfer";
  const many = countsStops(mode) ? "results.stops" : "results.transfers";
  return `${count} ${t(count === 1 ? one : many)}`;
}
