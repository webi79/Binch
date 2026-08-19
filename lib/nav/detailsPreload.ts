import type { SearchResult } from "@/types/search";

/**
 * Das Detail-Blatt schon beim AUFSETZEN des Fingers bauen.
 *
 * `DetailsOverlay` gibt vor dem allerersten Öffnen `null` zurück — der Baum
 * entsteht also erst in dem Commit, den der Tipp auslöst. Das sind rund 47
 * Elemente (der schwere Rest hängt hinter `atRest` und kommt ohnehin später),
 * und dieser Commit liegt auf demselben Strang wie die Bewegung. Genau daher
 * kam „vor allem beim ersten Mal ruckelt es".
 *
 * Ab dem zweiten Öffnen bleibt der Baum stehen, aber die Inhalte wechseln —
 * anderer Flug, andere Zeilen. Auch dieses Durchrendern lag bisher im
 * Loslass-Bild. Wird hier vorab dasselbe Ergebnis gemeldet, das gleich
 * ausgewählt wird, ist beim Loslassen nur noch `open` zu wechseln.
 *
 * Warum nicht über den Speicher: Ein Schreibvorgang dort weckt jeden
 * Abonnenten. Hier soll genau eine Überlagerung aufwachen — dieselbe
 * Überlegung wie in [[settingsPreload]] und `transitionLayer`.
 *
 * Sichtbar wird davon nichts: Das Blatt steht geparkt außerhalb des Bildes und
 * ohne Zeigerereignisse, solange kein echtes Ergebnis ausgewählt ist. Auch
 * keine Abfrage läuft an — die hängt an `open && atRest`.
 */
type Listener = (result: SearchResult) => void;

const listeners = new Set<Listener>();

export function subscribeDetailsPreload(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function preloadDetails(result: SearchResult): void {
  for (const fn of listeners) fn(result);
}
