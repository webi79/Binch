/**
 * „Preis vergleichen" wurde getippt und die Ergebnis-Liste slidet gerade über
 * den Such-Screen.
 *
 * Solange das läuft, darf ihn niemand anders schließen — der Home-Screen tut
 * das sonst bei seinem Fokus-Verlust, und dann verschwindet die Unterlage
 * mitten in der Bewegung.
 *
 * Bewusst ein Modul-Wert und KEIN Store-Feld: Jeder Schreibvorgang im Store
 * löst ein React-Update in allen abonnierten Komponenten aus, und er lag hier
 * genau im Berührungs-Frame — direkt bevor die Navigation startet. Für ein
 * Flag, das nur zwei Stellen im Callback lesen (nie im Render), ist das reine
 * Verschwendung. Dasselbe Muster nutzt bereits die Tab-Takt-Erkennung in
 * lib/motion.tsx.
 */
let active = false;

/**
 * Der frühere Benachrichtigungs-Kanal für die Übergabe ist entfallen.
 *
 * Er hatte genau einen Zuhörer — den Such-Screen, der sich damit auf die
 * Bewegung vorbereitete. Der bereitet sich inzwischen über `subscribeHandoffLayer`
 * darunter vor, und der Kanal hier hatte zuletzt keinen Abonnenten mehr:
 * `beginSearchHandoff`/`endSearchHandoff` riefen bei jeder Suche eine
 * Verteilerfunktion auf, die über eine leere Menge lief.
 */
type HandoffListener = (active: boolean) => void;


/**
 * Getrenntes Signal für die GPU-Textur des Such-Screens.
 *
 * Warum nicht dasselbe wie die Übergabe: Die Textur braucht VORLAUF. Sie wird
 * beim Antippen angefordert, und erst ein Bild später erreicht das Prop die
 * native Ansicht, dann beginnt das Rastern. Die Bewegung startet inzwischen,
 * sobald der JS-Thread frei ist — und seit der Ergebnis-Bildschirm beim App-
 * Start vorgeladen wird, ist er das deutlich FRÜHER als vorher. Der eigene
 * Fortschritt hat sich damit selbst ein Bein gestellt: Die Bewegung überholte
 * das Rastern.
 *
 * Deshalb hängt dieses Signal am FINGERDRUCK statt am fertigen Tippen. Zwischen
 * Aufsetzen und Loslassen liegen typischerweise 80-150ms, die sonst ungenutzt
 * verstreichen — genug, um die Textur fertigzustellen, und ohne dem Nutzer auch
 * nur eine Millisekunde Wartezeit hinzuzufügen.
 */
const layerListeners = new Set<HandoffListener>();
let layerWanted = false;
let layerRelease: ReturnType<typeof setTimeout> | null = null;

/** Frist für die automatische Freigabe (neu) setzen. */
function scheduleRelease(): void {
  if (layerRelease) clearTimeout(layerRelease);
  layerRelease = setTimeout(releaseHandoffLayer, LAYER_SAFETY_MS);
}

/** Losgelassen ohne zu suchen? Dann fällt die Textur von selbst wieder weg. */
// 1400 statt 5000 — dieselbe Frage wird in lib/nav/transitionLayer.ts mit 1400
// beantwortet, und dort ist sie richtig beantwortet: Bleibt der Such-Screen nach
// einem abgebrochenen Druck fünf Sekunden lang eine Textur, muss jede Eingabe im
// Formular sie neu rastern.
const LAYER_SAFETY_MS = 1400;

export function subscribeHandoffLayer(fn: HandoffListener): () => void {
  layerListeners.add(fn);
  return () => {
    layerListeners.delete(fn);
  };
}

function emitLayer(): void {
  for (const fn of layerListeners) fn(layerWanted);
}

/** Beim Fingerdruck auf „Preis vergleichen" aufrufen. */
export function prepareHandoffLayer(): void {
  // Neue Anforderung → der Aufschub von letztem Mal ist verbraucht.
  // Dieselbe Symmetrie wie im Schwestermodul; hier fehlte sie.
  releaseDeferred = false;
  scheduleRelease();
  if (layerWanted) return;
  layerWanted = true;
  emitLayer();
}

export function releaseHandoffLayer(): void {
  // Niemals abbauen, solange die Übergabe läuft.
  //
  // Der Abbau einer bildschirmfüllenden Ebene ist ein nativer Vorgang, der die
  // Bewegung für seine Dauer ANHÄLT — nicht ein Bild verschluckt, sondern
  // stehenbleibt und danach weiterläuft. Genau so sah es aus: „erst normal, dann
  // strikt Stopp, dann weiter." Wer hier landet, während die Liste schon fährt,
  // hat sich verrechnet; aufgeräumt wird am Ende in `endSearchHandoff`.
  /**
   * Aufschieben nur, solange die Übergabe WIRKLICH läuft — und wegen der
   * Bewegung höchstens einmal.
   *
   * `active` ist ein echter Zustand mit Ende. Die Bewegungs-Meldung dagegen
   * kann hängenbleiben: Der Such-Bildschirm schreibt sie unter dem Vorgabe-
   * Schlüssel und hat, anders als die beiden Wähler, keinen Wächter dahinter.
   * Reißt eine Einfahrt ab, läuft ihr Abschluss nie — und ohne Grenze schöbe
   * diese Freigabe sich alle 1,4 Sekunden selbst weiter auf, während der
   * Bildschirm dauerhaft eine bildschirmfüllende Textur trägt.
   *
   * Das Schwestermodul begrenzt aus demselben Grund auf einen Aufschub.
   */
  if (active || (sheetMoving && !releaseDeferred)) {
    if (!active) releaseDeferred = true;
    /**
     * NICHT still aussteigen — sonst bleibt die Textur für immer stehen.
     *
     * Feuert die 1400ms-Freigabe genau, während das Blatt fährt, gab es danach
     * keinen weiteren Auslöser: `setSheetMoving(false)` löst nichts aus, und die
     * Übergabe endet nur, wenn wirklich gesucht wurde. Der Such-Screen blieb dann
     * dauerhaft eine bildschirmfüllende GPU-Textur — und jede Eingabe im Formular
     * rasterte sie neu.
     *
     * Das Schwestermodul (`transitionLayer.ts`) löst genau diesen Fall richtig:
     * Wer nicht freigeben darf, setzt die Frist neu. Hier fehlte es.
     */
    scheduleRelease();
    return;
  }
  releaseDeferred = false;
  if (layerRelease) {
    clearTimeout(layerRelease);
    layerRelease = null;
  }
  if (!layerWanted) return;
  layerWanted = false;
  emitLayer();
}

/**
 * Die Textur EINMAL pro App-Lauf kalt anlaufen lassen.
 *
 * Das erste Anlegen einer bildschirmfüllenden Hardware-Ebene ist deutlich teurer
 * als jedes weitere: Android muss dafür erst einen Grafikpuffer in Bildschirm-
 * größe beschaffen und den Baum zum ersten Mal hineinrastern. Genau deshalb
 * ruckelte die Bewegung aus dem Such-Screen „vor allem beim ersten Mal" — beim
 * zweiten lag der Puffer schon im Pool des Treibers.
 *
 * Der Vorlauf beim Antippen (`onTouchStart`) deckt den WARMEN Fall ab, den
 * kalten nicht. Also holen wir ihn dorthin, wo er nichts kostet: Der Such-Screen
 * steht nach dem Aufblenden sichtbar und völlig still da, während der Nutzer das
 * Formular liest. Ein Bild, das dort verloren ginge, sieht niemand — anders als
 * eines mitten in der Bewegung.
 *
 * Sichtbar ist das eine Bedingung, keine Nebensache: Eine unsichtbare Ansicht
 * zeichnet Android gar nicht erst, dort würde also auch nichts entstehen. Deshalb
 * steht der Aufruf im Aufblenden und nicht beim Start der App.
 */
let warmedOnce = false;

/**
 * Läuft gerade die Öffnungs- oder Schließbewegung des Blattes?
 *
 * Der Wächter in `releaseHandoffLayer` prüfte bisher nur `active` — also die
 * Übergabe an die Ergebnisliste. Der Kalt-Anlauf schaltet seine Ebene aber
 * 1530ms nach dem Aufblenden an und 250ms später wieder AUS, und die
 * automatische Freigabe nach 1400ms hängt ebenfalls an einer Uhr. Wer die Suche
 * in diesem Fenster schließt und neu öffnet, bekam den Abbau einer
 * bildschirmfüllenden Ebene mitten in die Bewegung — genau der Stillstand, gegen
 * den der Wächter überhaupt gebaut wurde. Einmal pro App-Lauf möglich, rein
 * zeitabhängig, also perfektes „manchmal".
 */
let sheetMoving = false;
/** Siehe `releaseHandoffLayer`: höchstens ein Aufschub wegen der Bewegung. */
let releaseDeferred = false;
const sheetMovingListeners = new Set<(v: boolean) => void>();

/**
 * Mithören, ob das Such-Blatt gerade fährt.
 *
 * Gebraucht vom Hero darunter: Er soll während der Fahrt stillstehen — genau
 * das sagt die Beschreibung seiner `paused`-Eigenschaft auch, nur fehlte ihm
 * bisher das Signal dafür. Ohne es lief sein Sonnenaufgang schon beim Antippen
 * los und wurde am Ende der Fahrt vom Reveal zurückgesetzt: Die Sonne stand
 * oben, fiel herunter und ging noch einmal auf.
 *
 * Bewusst ein Modul-Wert und kein Speicher-Feld: Ein Schreibvorgang im Speicher
 * weckt alle Abonnenten, und dieser hier fällt genau in den Start der Bewegung.
 */
/** Der aktuelle Stand — für den Anfangswert eines Zustands. Siehe dort. */
export function isSheetMoving(): boolean {
  return sheetMoving;
}

export function subscribeSheetMoving(fn: (v: boolean) => void): () => void {
  sheetMovingListeners.add(fn);
  fn(sheetMoving);
  return () => {
    sheetMovingListeners.delete(fn);
  };
}

/**
 * Wer gerade fährt — als MENGE, nicht als einzelnes Ja/Nein.
 *
 * Es gibt drei unabhängige Blätter (Such-Blatt, Ortswähler, Datumswähler), und
 * alle drei schrieben auf denselben Schalter. Wer zuerst fertig war, hat ihn
 * für alle ausgeschaltet: Der Ortswähler beendet seine 220ms-Ausfahrt, während
 * das Such-Blatt noch 250ms einfährt — und in genau diesem Moment fällt die
 * Übergabe-Textur weg. Der Hintergrund (ein bildschirmfüllendes SVG) wird dann
 * mitten in der Bewegung wieder Bild für Bild gerastert. Das ist das Ruckeln.
 *
 * Über eine Menge kann das nicht mehr passieren: Ausgeschaltet wird erst, wenn
 * der Letzte fertig ist. Der Schlüssel darf gern derselbe bleiben, wenn ein
 * Blatt zweimal hintereinander meldet — eine Menge zählt nicht doppelt, und
 * genau das ist hier richtig.
 */
const movingKeys = new Set<string>();

export function setSheetMoving(v: boolean, key: string = "sheet"): void {
  if (v) movingKeys.add(key);
  else movingKeys.delete(key);
  const next = movingKeys.size > 0;
  if (sheetMoving === next) return;
  sheetMoving = next;
  for (const fn of sheetMovingListeners) fn(next);
}

/**
 * Erst NACH der Einblend-Welle des Formulars.
 *
 * Das ist keine Vorsichtsmarge, sondern der Kern: Eine Hardware-Ebene über einem
 * Baum, in dem gerade etwas animiert, wird bei JEDEM Bild ungültig und neu
 * gerastert — sie wäre dann schlimmer als keine. Die Welle beginnt 150ms nach dem
 * Aufblenden (WAVE_DELAY_MS), ihr letztes Element startet spätestens nach
 * weiteren 480ms (MOTION.maxDelay) und läuft dann bis zu 700ms
 * (MOTION.durationLarge). Danach steht der Screen wirklich still.
 */
const WARM_AFTER_MS = 150 + 480 + 700 + 200;

/**
 * Zeitgeber des Kalt-Anlaufs — beide abbrechbar.
 *
 * Ohne das lag hier ein Fehler mit genau der Signatur, die er verhindern sollte:
 * Der Anlauf schaltet die Ebene an und 250ms später wieder AUS. Wer in diesem
 * Fenster auf „Suchen" tippt, bekommt das Abschalten mitten in die Bewegung —
 * und damit den Stillstand, gegen den der Anlauf überhaupt gebaut wurde.
 * `beginSearchHandoff` räumt sie deshalb weg.
 */
let warmTimers: ReturnType<typeof setTimeout>[] = [];

function cancelWarm(): void {
  for (const t of warmTimers) clearTimeout(t);
  warmTimers = [];
}

export function warmHandoffLayer(): void {
  if (warmedOnce) return;
  warmedOnce = true;
  warmTimers.push(
    setTimeout(() => {
      // Nur, wenn der Such-Screen dann noch offen ist — sonst hätte niemand etwas
      // davon, und auf einer unsichtbaren Fläche entsteht ohnehin keine Ebene.
      // Und nicht, wenn die Übergabe schon läuft: Dann ist die Ebene ohnehin da,
      // und sie anzufassen hieße, in die laufende Bewegung zu greifen.
      if (active || sheetMoving || !isSearchScreenOpen?.()) {
        warmedOnce = false;
        return;
      }
      prepareHandoffLayer();
      // Ein paar Bilder stehen lassen, damit wirklich einmal gerastert wird —
      // sofort wieder abschalten hieße, den Puffer vor dem ersten Zeichnen zu
      // verwerfen.
      warmTimers.push(setTimeout(releaseHandoffLayer, 250));
    }, WARM_AFTER_MS),
  );
}

/**
 * Wird beim Start gesetzt (siehe SearchHeroOverlay). Als Rückruf statt als
 * Import, damit dieses Modul nicht vom Store abhängt — es liegt bewusst
 * außerhalb, siehe oben.
 */
let isSearchScreenOpen: (() => boolean) | null = null;

export function setSearchScreenOpenProbe(fn: () => boolean): void {
  isSearchScreenOpen = fn;
}

export function beginSearchHandoff(): void {
  // Erst den Kalt-Anlauf abräumen: Sein Abschalt-Zeitgeber läuft sonst mitten in
  // die gleich startende Bewegung hinein.
  cancelWarm();
  // Falls der Fingerdruck nicht durchkam (z.B. programmatisch ausgelöst),
  // wenigstens jetzt anfordern.
  prepareHandoffLayer();
  active = true;
}

export function endSearchHandoff(): void {
  active = false;
  // Textur wieder freigeben — dauerhaft müsste sie bei jeder Änderung im
  // Formular neu entstehen.
  releaseHandoffLayer();
}

export function isSearchHandoff(): boolean {
  return active;
}
