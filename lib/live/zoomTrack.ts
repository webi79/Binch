/**
 * DER ZOOM, FÜR DEN DAS LIVE-FAHRZEUG GEBAUT WIRD.
 *
 * Der 3D-Körper ist überhöht, damit er auf jeder Stufe gut zu sehen ist
 * (`groundScale`, `bodyScale` in `features.ts`): Seine Maße hängen am Zoom.
 * Gebaut wird er in JS, gezeichnet von der Karte — passt der Zoom nicht zu
 * dem, den die Karte zeigt, ist das Fahrzeug zu groß oder zu klein („wird beim
 * Start kurz riesig", „man steckt im Zug": gebaut für den Zoom der vorigen
 * Sitzung bzw. schon für das Ziel einer Fahrt, die gerade erst losging).
 *
 * WÄHREND SICH DER ZOOM ÄNDERT, BLEIBT DIE GRÖSSE STEHEN. Neu gebaut wird
 * höchstens 30-mal je Sekunde, die Karte zoomt aber in jedem Bild weiter:
 * Folgte die Größe dem Zoom, wüchse das Fahrzeug zwischen zwei Takten mit der
 * Karte und spränge beim nächsten zurück — ein Sägezahn, der beim Zoomen wie
 * Glitchen aussah. Stattdessen verhält es sich während Geste und Fahrt wie ein
 * echtes Ding (wächst und schrumpft mit der Karte), und erst wenn sie ruht,
 * geht es in einer Viertelsekunde auf seine Größe für die neue Stufe über.
 * Meldungen mitten in der Bewegung zählen deshalb nicht.
 *
 * Eigene Fahrten kennt die App vorher: Ein Schnitt setzt den Zoom sofort. Eine
 * Fahrt HINEIN baut gleich für ihr Ziel (das Fahrzeug ist anfangs kleiner und
 * wächst mit der Karte in seine Größe), eine Fahrt HINAUS behält die Größe und
 * geht an ihrem Ende über — gebaut fürs Ziel wäre es zu Beginn ein Block, in
 * dem die Kamera steckt.
 */
export interface ZoomTrack {
  /** Der Zoom zu einem Zeitpunkt (`Date.now()`). */
  at(now: number): number;
  /** Läuft gerade ein Übergang der Größe (dann im vollen Takt bauen)? */
  changing(now: number): boolean;
  /** Die Karte meldet ihren Stand — `settled`: am Ende einer Bewegung. */
  report(zoom: number, settled: boolean): void;
  /** Die Kamera springt (Schnitt): ab sofort dieser Zoom. */
  jump(zoom: number): void;
  /** Die Kamera fährt in `ms` dorthin. */
  glide(zoom: number, ms: number): void;
  /**
   * Drehung und Neigung der Kamera — für die Ansicht des Flugzeugs. Anders als
   * der Zoom folgen sie JEDER Meldung sofort: Das Bild muss beim Drehen mit.
   */
  view(): { bearing: number; pitch: number };
  setView(bearing: number, pitch: number): void;
  /**
   * Bei Sprung oder beginnendem Übergang Bescheid geben — für einen Durchgang
   * außer der Reihe, damit kein Bild mit der alten Größe stehen bleibt.
   */
  subscribe(fn: () => void): () => void;
}

/** Übergang auf die neue Größe. */
const MORPH_MS = 250;
/** Kleinere Unterschiede sind auf dem Schirm unsichtbar (< 1 %). */
const EPS = 0.01;

export function createZoomTrack(initial: number): ZoomTrack {
  /** Der Zoom, auf den die Größe zuläuft bzw. steht. */
  let target = initial;
  let morph: { from: number; t0: number } | null = null;
  /** Eigene Fahrt HINAUS: ihr Ziel, bis sie ankommt. */
  let outTo: number | null = null;
  let outTimer: ReturnType<typeof setTimeout> | null = null;
  let cam = { bearing: 0, pitch: 0 };
  /** Bis wann der Blickwinkel als „ändert sich" gilt (voller Takt). */
  let viewUntil = 0;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((fn) => fn());

  const at = (now: number): number => {
    if (!morph) return target;
    const k = (now - morph.t0) / MORPH_MS;
    if (k >= 1) {
      morph = null;
      return target;
    }
    if (k <= 0) return morph.from;
    return morph.from + (target - morph.from) * (1 - (1 - k) * (1 - k));
  };
  /** Auf `zoom` übergehen — weich oder sofort. */
  const moveTo = (zoom: number, smooth: boolean) => {
    const now = Date.now();
    const cur = at(now);
    target = zoom;
    const changed = Math.abs(zoom - cur) >= EPS;
    morph = smooth && changed ? { from: cur, t0: now } : null;
    if (changed) notify();
  };
  const cancelOut = () => {
    if (outTimer) clearTimeout(outTimer);
    outTimer = null;
    outTo = null;
  };

  return {
    at,
    changing: (now) => (morph != null && now < morph.t0 + MORPH_MS) || now < viewUntil,
    view: () => cam,
    setView(bearing, pitch) {
      const db = Math.abs(((bearing - cam.bearing + 540) % 360) - 180);
      if (db < 0.2 && Math.abs(pitch - cam.pitch) < 0.2) return;
      cam = { bearing, pitch };
      viewUntil = Date.now() + 200;
    },
    report(zoom, settled) {
      if (!settled) return;
      // Das Ende der eigenen Fahrt hinaus übernimmt ihr Zeitgeber — außer sie
      // wurde abgebrochen (Finger auf der Karte): dann gilt, wo sie stehen blieb.
      if (outTo != null) {
        if (Math.abs(zoom - outTo) < 0.3) return;
        cancelOut();
      }
      moveTo(zoom, true);
    },
    jump(zoom) {
      cancelOut();
      moveTo(zoom, false);
    },
    glide(zoom, ms) {
      cancelOut();
      const cur = at(Date.now());
      if (ms <= 0) {
        moveTo(zoom, false);
      } else if (zoom > cur + EPS) {
        moveTo(zoom, true);
      } else if (zoom < cur - EPS) {
        outTo = zoom;
        outTimer = setTimeout(() => {
          outTimer = null;
          outTo = null;
          moveTo(zoom, true);
        }, ms);
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
