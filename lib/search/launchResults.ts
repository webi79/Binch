/**
 * Die Ergebnisliste mit fertigen Parametern öffnen — ohne Such-Formular.
 *
 * Der Weg der Verlaufskarten („Zuletzt gesucht") und der Pendel-Knöpfe
 * („Zur Arbeit" / „Nach Hause"). Die Begründungen stehen an der Verlaufskarte
 * (components/home/RecentCard.tsx): erst die Bewegung, die beiden
 * Schreibvorgänge ein Bild später.
 *
 * Die Sperre steht auf MODULEBENE und gilt für alle Knöpfe zusammen: Karte A
 * antippen und während der Bewegung Knopf B startete `startResultsPush` ein
 * zweites Mal — die halb hereingefahrene Liste spränge zurück und führe mit
 * B's Parametern neu ein.
 */
import { startResultsPush } from "@/lib/nav/overlayCover";
import { useSearchStore } from "@/stores/searchStore";

let locked = false;

/** `false`, wenn gerade schon eine Liste hereinfährt (Doppeltipp). */
export function launchResults(rp: Record<string, string>): boolean {
  if (locked) return false;
  locked = true;
  // 400 statt 900 ms: Ein echter Doppeltipp liegt darunter; länger fühlt sich
  // der Knopf danach tot an.
  setTimeout(() => {
    locked = false;
  }, 400);
  startResultsPush();
  requestAnimationFrame(() => {
    useSearchStore.getState().setPendingResultsRoute(rp);
    useSearchStore.getState().setResultsParams(rp);
  });
  return true;
}
