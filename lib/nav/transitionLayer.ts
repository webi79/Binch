import { isSheetMoving } from "./searchHandoff";
/**
 * GPU-Texturen für die Bildschirme, die sich während eines Übergangs bewegen.
 *
 * DAS PROBLEM, in der Codebasis zweimal unabhängig gemessen:
 *
 *   • TicketDetailOverlay (Perfetto): „ohne Layer wird der komplette Screen
 *     JEDEN Animations-Frame neu gezeichnet (~14,7ms > 8,3ms-Budget bei 120Hz
 *     → jeder zweite Frame droppt). Als Textur ist der Frame ein Blit."
 *   • saved.tsx: derselbe Versuch für die UNTERLAGE wurde wieder verworfen —
 *     „Der Layer-Flip erzwang ein 66ms-Record-View#draw() über den ganzen Tree".
 *
 * Beide Befunde stimmen, und zusammen ergeben sie die Lösung: Die Textur ist
 * richtig, ihr AUFBAU darf nur nicht in die Bewegung fallen. Genau daran ist der
 * zweite Versuch gescheitert — er schaltete die Ebene ein, wenn die Animation
 * schon lief.
 *
 * DIE LÖSUNG: Vorbereiten beim FINGERDRUCK, nicht beim Loslassen. Zwischen
 * Aufsetzen und Loslassen liegen typischerweise 80-150ms, die ohnehin
 * verstreichen — genug für den Aufbau, ohne dem Nutzer Wartezeit hinzuzufügen.
 *
 * WARUM NICHT DAUERHAFT: Unter diesen Ebenen liegen scrollende Flächen. Eine
 * dauernde Textur müsste bei jedem Scroll-Bild neu entstehen und wäre schlimmer
 * als gar keine. Sie gilt deshalb nur für die Dauer des Übergangs und fällt
 * danach von selbst wieder weg.
 *
 * WARUM EIN EIGENES MODUL statt Store-Feldern: Jeder Schreibvorgang im Store
 * weckt alle Abonnenten — und das im Berührungs-Frame, direkt bevor die
 * Navigation startet. Hier weckt es genau die eine Fläche, um die es geht.
 */
/**
 * `searchHero` steht hier ohne Nutzer — der Such-Screen läuft über das eigene
 * Modul `searchHandoff`. Bleibt vorerst stehen, damit die Aufzählung nicht in
 * einer unbeteiligten Runde wandert; `settings` ist neu.
 */
/**
 * KEIN "home" mehr. Der Landingscreen hatte als einziger Abonnent eine Textur
 * für die Dauer eines Übergangs — gestützt auf die Annahme, sein Baum werde
 * beim Zur-Seite-Wandern in jedem Bild neu gezeichnet. Die Annahme war falsch
 * (Android hält je Ansicht eine aufgezeichnete Zeichenliste; eine Verschiebung
 * ist eine Eigenschaft davon), und die Zustandsgröße, an der sie hing, saß in
 * der Parallax-Komponente: Jedes Anfordern und Freigeben schickte einen
 * Fabric-Commit auf genau die Ansicht, die Reanimated Bild für Bild beschreibt.
 * Die Selbstverfall-Wecker schoben einen Teil davon bis in ein späteres
 * Scrollen. Wieder aufnehmen nur mit Messung am Gerät.
 */
export type LayerKey = "saved" | "searchHero" | "results" | "settings" | "pickerLocation" | "pickerDate";

type Listener = (on: boolean) => void;

const listeners = new Map<LayerKey, Set<Listener>>();
const wanted = new Map<LayerKey, boolean>();
/** Wer schon einmal aufgeschoben wurde — siehe `releaseLayer`. */
const deferred = new Set<LayerKey>();
const timers = new Map<LayerKey, ReturnType<typeof setTimeout>>();
/**
 * Zählt, wie oft eine Textur angefordert wurde.
 *
 * Nötig gegen einen Wettlauf: Tippt jemand am Ende einer Rückfahrt schon die
 * nächste Karte an, fordert das eine frische Textur an — und die Aufräumfunktion
 * des gerade abgebauten Bildschirms räumte sie ein Bild später wieder ab. Der
 * nächste Übergang lief dann ungeschützt UND zahlte den Abbau im Berührungs-
 * Frame. Wer freigeben will, nennt jetzt den Stand, auf den er sich bezieht.
 */
const generation = new Map<LayerKey, number>();

export function layerGeneration(key: LayerKey): number {
  return generation.get(key) ?? 0;
}

/**
 * Nach dieser Zeit fällt die Textur von selbst weg.
 *
 * Deckt beides ab: den normalen Übergang (Zeitkurve 500ms hin, 450ms zurück; danach wird sie nicht
 * mehr gebraucht) und den Fall, dass der Nutzer den Finger wieder abhebt, ohne
 * etwas auszulösen. Ohne diese Grenze bliebe die Fläche als Textur stehen und
 * müsste bei jedem Scrollen neu entstehen.
 */
const AUTO_RELEASE_MS = 1400;

export function subscribeLayer(key: LayerKey, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

function emit(key: LayerKey): void {
  const on = wanted.get(key) === true;
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) fn(on);
}

/** Beim Fingerdruck auf das Element aufrufen, das den Übergang auslöst. */
export function prepareLayer(key: LayerKey): void {
  // Neue Anforderung → der Aufschub von letztem Mal ist verbraucht.
  deferred.delete(key);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => releaseLayer(key), AUTO_RELEASE_MS),
  );
  generation.set(key, layerGeneration(key) + 1);
  if (wanted.get(key) === true) return;
  wanted.set(key, true);
  emit(key);
}

/**
 * Eine BEREITS BESTEHENDE Textur halten — schaltet selbst keine ein.
 *
 * Das ist der ganze Unterschied, und er ist wesentlich: In der ersten Fassung
 * legte diese Funktion die Textur auch an, wenn keine da war. Aufgerufen wird
 * sie beim Mounten des Ergebnis-Bildschirms — also EXAKT beim Start der
 * Bewegung. Kam der Aufruf aus dem Such-Screen, war für den Landingscreen nie
 * eine vorbereitet worden, und sie entstand mitten im Übergang. Genau der
 * Ebenen-Aufbau zur Unzeit, der in saved.tsx mit 66ms vermessen ist und wegen
 * dem der ganze Ansatz dort einmal verworfen wurde. Damit hat die Funktion das
 * Problem verursacht, das sie lösen sollte.
 *
 * Sinnvoll ist nur die Verlängerung: Wurde beim Fingerdruck eine Textur
 * angelegt, soll sie nicht nach 1,4s wegfallen, solange die Fläche verdeckt ist
 * — dann steht sie auch fürs Zurückfahren bereit, für das es keinen Fingerdruck
 * gibt. Ist keine da, wird hier nichts erzwungen: Eine Fläche, für die niemand
 * vorbereitet hat, ist auch keine, die sich gerade bewegt.
 */
export function holdLayer(key: LayerKey): void {
  if (wanted.get(key) !== true) return;
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
}

/**
 * Eine bestehende Textur für die Rückfahrt weiterlaufen lassen.
 *
 * Fürs Zurückfahren gibt es keinen Fingerdruck, an dem man vorbereiten könnte —
 * es beginnt mit dem Schließen. `prepareLayer` wäre hier falsch: Es legt eine
 * Textur auch dann an, wenn gar keine da war, und beim Schließen weiß der
 * Aufrufer oft nicht, welche der Flächen überhaupt darunter lag. Auf der
 * anderen wäre es reine Rasterarbeit für nichts.
 *
 * Also: Nur wer schon eine hat, behält sie — und diesmal mit Ablaufdatum, damit
 * sie nicht über der wieder scrollbaren Fläche stehen bleibt.
 */
export function rearmLayer(key: LayerKey): void {
  if (wanted.get(key) !== true) return;
  /**
   * Mit der Frist kommt auch der Aufschub zurück.
   *
   * Der Aufschub ist ein Einzelstück pro Fläche, und verbraucht wird er von der
   * ERSTEN Bewegung, die zufällig läuft, wenn die Frist abläuft — auch von der
   * eines anderen Blattes. Wer hier neu scharf stellt, meldet aber gerade eine
   * frische Rückfahrt an: Ohne diese Zeile liefe sie ohne Netz, und ein Ablauf
   * mittendrin reißt die Textur weg und hält genau die Fahrt an, für die sie
   * angefordert wurde.
   */
  deferred.delete(key);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => releaseLayer(key), AUTO_RELEASE_MS),
  );
}

export function releaseLayer(key: LayerKey, forGeneration?: number): void {
  // Hat inzwischen jemand neu angefordert, gehört die Textur nicht mehr uns —
  // aber stumm aussteigen darf man trotzdem nicht: Hat `holdLayer` zwischendurch
  // die Zeitgrenze gelöscht, gäbe es dann gar keinen Weg mehr zurück, und eine
  // bildschirmfüllende Textur bliebe dauerhaft über einer scrollenden Fläche
  // stehen. Stattdessen die Zeitgrenze neu setzen: 1,4s sind damit die harte
  // Obergrenze für jede Textur, egal über welchen Pfad.
  if (forGeneration != null && forGeneration !== layerGeneration(key)) {
    if (wanted.get(key) === true && !timers.has(key)) {
      timers.set(
        key,
        setTimeout(() => releaseLayer(key), AUTO_RELEASE_MS),
      );
    }
    return;
  }
  /**
   * NICHT abreißen, solange ein Blatt fährt.
   *
   * Die Zeitgrenze von 1,4s kennt die Bewegung nicht. Wer einen Wähler öffnet
   * und innerhalb dieser Zeit wieder schließt, verliert die Textur mitten in
   * der Rückfahrt — und ein Ebenen-Abbau hält die laufende Bewegung an. Das ist
   * das perfekte „manchmal ruckelt es, manchmal nicht".
   *
   * Die Übergabe-Textur löst dieselbe Frage seit Längerem genau so
   * (`searchHandoff`: `if (active || sheetMoving) { scheduleRelease(); return; }`)
   * und begründet dort auch, warum. Hier fehlte es.
   */
  /**
   * Aufschieben — aber HÖCHSTENS einmal.
   *
   * Der Riegel ist richtig: Eine Ebene mitten in der Fahrt abzureißen hält
   * genau diese Fahrt an. Er darf aber nicht unbegrenzt greifen. Bleibt die
   * Bewegungs-Meldung irgendwo hängen — und dafür reicht ein Abschluss-Rückruf,
   * der nach einem Abbruch nie läuft —, hinge sonst eine bildschirmfüllende
   * Textur für den Rest des App-Laufs fest. Über einer Fläche, auf der etwas
   * passiert, ist das teurer als gar keine Ebene.
   *
   * Ein einziger Aufschub deckt jede echte Fahrt ab (die längste dauert 300ms,
   * die Frist 1,4s). Alles darüber ist ein Fehler, und dann ist Loslassen
   * richtig.
   */
  if (isSheetMoving() && !deferred.has(key)) {
    deferred.add(key);
    // Den bestehenden Zeitgeber ZUERST löschen. Ohne das bleibt er verwaist
    // liegen und ruft später `releaseLayer` ohne Generation auf — der Wächter
    // weiter oben greift dann nicht mehr, und er reißt eine Textur ab, die
    // inzwischen einer NEUEN Anforderung gehört. Mitten in deren Fahrt.
    const pending = timers.get(key);
    if (pending) clearTimeout(pending);
    timers.set(
      key,
      setTimeout(() => releaseLayer(key), AUTO_RELEASE_MS),
    );
    return;
  }
  deferred.delete(key);
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    timers.delete(key);
  }
  if (wanted.get(key) !== true) return;
  wanted.set(key, false);
  emit(key);
}
