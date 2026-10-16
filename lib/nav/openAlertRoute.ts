import { startResultsPush } from "@/lib/nav/overlayCover";
import { useSearchStore } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

/**
 * Die Suche eines Preis-Alarms öffnen — von ÜBERALL derselbe Weg.
 *
 * Zwei Stellen führen dorthin: der Tipp auf die Push-Meldung und der Tipp auf
 * eine Karte unter der Glocke. Sie müssen dieselbe Liste öffnen, sonst zeigt
 * die eine andere Preise als die andere — und genau diese Sorte Kopie ist in
 * diesem Projekt heute dreimal auseinandergelaufen.
 */
export interface AlertRoute {
  mode: TravelMode | string;
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  /** ISO „yyyy-MM-dd". */
  departDate: string;
  returnDate?: string;
  passengers?: number | string;
  travelClass?: string;
  currency?: string;
}

export function openAlertRoute(p: AlertRoute): void {
  if (!p.mode || !p.origin || !p.destination || !p.departDate) return;
  const rp: Record<string, string> = {
    mode: String(p.mode),
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel ?? p.origin,
    destLabel: p.destLabel ?? p.destination,
    departDate: p.departDate,
    /**
     * Die Suche wird GENAUSO geöffnet, wie der Alarm sie gespeichert hat.
     *
     * Rückreise, Reisendenzahl und Klasse gehören zum Schlüssel des Alarms —
     * der Preis einer Antwort ist der Gesamtpreis der Gruppe. Würde hier
     * pauschal „eine Person, einfache Fahrt" stehen, meldete die Nachricht
     * 120 € und die Liste daraufhin 31 €. Eine Meldung, deren Zahl nach dem
     * Tipp nicht mehr stimmt, ist schlimmer als keine.
     *
     * Fehlt ein Feld, stammt die Meldung von einem älteren Server — dann
     * greifen dieselben Vorgaben wie in der Suchroute.
     */
    passengers: String(p.passengers ?? "1"),
    currency: p.currency ?? "EUR",
    ...(p.returnDate ? { returnDate: p.returnDate } : {}),
    ...(p.travelClass ? { travelClass: p.travelClass } : {}),
    tripType: p.returnDate ? "roundtrip" : "oneway",
  };
  /**
   * Erst die Bewegung anstoßen, dann EIN BILD SPÄTER die Parameter setzen.
   *
   * Diese Reihenfolge ist im Projekt an mehreren Stellen erkämpft: Der
   * Schreibvorgang macht einen über 2000 Zeilen langen Baum sichtbar, und sein
   * Commit läuft bei einem Ereignis synchron zu Ende, während die Bewegung nur
   * eingereiht wird. Andersherum liefe erst der ganze Aufbau und dann erst
   * führe etwas los.
   */
  startResultsPush();
  requestAnimationFrame(() => {
    useSearchStore.getState().setPendingResultsRoute(rp);
    useSearchStore.getState().setResultsParams(rp);
  });
}

/**
 * Liegt die Hinreise schon hinter uns?
 *
 * Verglichen wird auf TAGESEBENE, nicht auf die Sekunde: Eine Verbindung heute
 * um sechs Uhr früh ist um zehn Uhr zwar vorbei, aber der Tag ist es nicht —
 * und eine Suche für heute liefert weiterhin spätere Verbindungen. Erst ab
 * morgen ist sie wirklich sinnlos.
 *
 * Gerechnet in der ORTSZEIT des Geräts, weil der Nutzer das Datum so liest.
 */
export function isPastDate(iso: string): boolean {
  if (!iso) return false;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate(),
  ).padStart(2, "0")}`;
  return iso < todayIso;
}

/**
 * Ab wann ein gemeldeter Preis als überholt gilt.
 *
 * SECHS STUNDEN, und die Zahl ist hergeleitet: Ein Alarm darf frühestens alle
 * zwölf Stunden erneut melden (`NOTIFY_COOLDOWN_MS` auf dem Server). Nach der
 * Hälfte dieser Spanne ist die Wahrscheinlichkeit, dass der Preis inzwischen
 * ein anderer ist, größer als die, dass er noch stimmt — Bahn- und Flugpreise
 * ändern sich im Tagesverlauf, nicht im Wochentakt.
 *
 * Lieber einmal zu oft warnen als eine Zahl zu versprechen, die wir nicht mehr
 * kennen: Wir schätzen keine Preise, und ein alter Preis ist eine Schätzung
 * über die Gegenwart.
 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function isStale(receivedAtIso: string): boolean {
  const t = Date.parse(receivedAtIso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t > STALE_AFTER_MS;
}
