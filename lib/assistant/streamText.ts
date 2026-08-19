/**
 * Der Text einer LAUFENDEN Antwort — außerhalb der Nachrichtenliste.
 *
 * WARUM ÜBERHAUPT:
 *
 * Ein Messenger hat dieses Problem nicht: Dort kommt eine Nachricht fertig an,
 * die Liste bekommt genau einen Eintrag dazu. Bo schreibt dagegen zehnmal pro
 * Sekunde in dieselbe Blase — und solange dieser Text in `messages` steht, ist
 * jedes dieser Stücke eine Änderung an den DATEN der virtualisierten Liste.
 * Daran hängt weit mehr als die eine Blase:
 *
 *   • ein neues Datenfeld → die Liste rendert komplett neu,
 *   • dabei entsteht pro Zelle eine frische Referenz-Funktion, die React im
 *     Commit ab- und wieder anhängt — auch für Zellen, die sich nicht ändern,
 *   • und die Buchhaltung der Virtualisierung läuft über alle gemounteten
 *     Zellen.
 *
 * Das wächst mit dem Verlauf und fällt zehnmal pro Sekunde an. Genau deshalb
 * fühlte sich schon die dritte Nachricht anders an als die erste.
 *
 * WAS ES NICHT LÖST: Die Blase wird beim Wachsen höher, und das ist ein echter
 * Layout-Durchgang — der bleibt. Weg fällt alles, was NUR daran hing, dass der
 * Text durch die Liste lief.
 *
 * WARUM EIN EIGENES MODUL statt eines Zustand-Feldes: Jeder Schreibvorgang im
 * Store weckt sämtliche Abonnenten. Hier weckt er genau die eine Blase, um die
 * es geht — dieselbe Begründung wie bei `lib/nav/transitionLayer.ts`.
 */
type Listener = (text: string | null) => void;

const texts = new Map<string, string>();
const listeners = new Map<string, Set<Listener>>();

function emit(id: string): void {
  const set = listeners.get(id);
  if (!set) return;
  const value = texts.get(id) ?? null;
  for (const fn of set) fn(value);
}

/** Der bisher eingetroffene Text, oder `null` wenn hier nichts (mehr) läuft. */
export function peekStreamText(id: string): string | null {
  return texts.get(id) ?? null;
}

export function appendStreamText(id: string, delta: string): void {
  texts.set(id, (texts.get(id) ?? "") + delta);
  emit(id);
}

/**
 * Abonnieren. Meldet sofort den aktuellen Stand — sonst stünde eine gerade
 * wieder aufgebaute Blase bis zum nächsten Stück leer da.
 */
export function subscribeStreamText(id: string, fn: Listener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  fn(texts.get(id) ?? null);
  return () => {
    set?.delete(fn);
    /**
     * Nur aufräumen, wenn die Karte NOCH auf denselben Satz zeigt.
     *
     * Läuft ein Abmelden doppelt (Entwicklungs-Modus ruft Aufräumfunktionen
     * zweimal auf) oder verspätet, während für dieselbe Kennung längst ein
     * neuer Satz angelegt wurde, hätte die alte Schließung sonst den neuen
     * Eintrag entfernt — und die lebende Blase bekäme mitten in der Antwort
     * keine Stücke mehr.
     */
    if (set !== undefined && set.size === 0 && listeners.get(id) === set) {
      listeners.delete(id);
    }
  };
}

/**
 * Herausnehmen und den Platz räumen — für das Übernehmen in die Nachricht.
 *
 * Die Meldung danach ist wichtig: Die Blase erfährt damit im SELBEN Durchgang,
 * dass sie ab jetzt den Text aus der Nachricht nimmt. React fasst beides zu
 * einem Rendern zusammen, es gibt also kein Bild dazwischen, in dem der Text
 * fehlt.
 */
export function takeStreamText(id: string): string | null {
  const text = texts.get(id) ?? null;
  if (text === null) return null;
  texts.delete(id);
  emit(id);
  return text;
}
