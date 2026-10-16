/**
 * DER ZOOM, FÜR DEN DAS LIVE-FAHRZEUG GEBAUT WIRD.
 *
 * Der 3D-Körper ist überhöht, damit er auf jeder Stufe gut zu sehen ist
 * (`groundScale`, `bodyScale` in `features.ts`): Seine Maße hängen am Zoom.
 * Gebaut wird er hier in JS, gezeichnet von der Karte — passt der Zoom nicht
 * zu dem, den die Karte gerade zeigt, ist das Fahrzeug zu groß oder zu klein.
 * Genau das waren „wird beim Start kurz riesig, dann wieder klein" und „man
 * steckt plötzlich im Zug": Gebaut wurde für den Zoom der VORIGEN Sitzung bzw.
 * schon für das Ziel einer Fahrt, die gerade erst losging („Ganze Strecke"),
 * und ein Zug für Zoom 8 ist auf Zoom 15 ein kilometerbreiter Block.
 *
 * Die Karte meldet ihren Zoom nicht bei jedem Bild: am Ende einer Bewegung,
 * mittendrin nur, wenn sie sich dabei dreht oder neigt (Patch an
 * `MLRNMapView`, siehe `onCameraFrame`). Was die App selbst anstößt, kennt sie
 * aber: Ein Schnitt setzt den Zoom sofort, eine Folgefahrt gleitet in
 * bekannter Zeit gleichmäßig. Wer selbst zoomt, sieht das Fahrzeug während
 * der Geste wie ein echtes Ding mitwachsen; danach geht es in einer
 * Viertelsekunde auf seine Größe für die neue Stufe über, statt zu springen.
 */
export interface ZoomTrack {
  /** Der Zoom zu einem Zeitpunkt (`Date.now()`). */
  at(now: number): number;
  /** Ändert er sich gerade (Fahrt, Übergang, laufende Meldungen)? */
  changing(now: number): boolean;
  /**
   * Die Karte meldet ihren Stand — mitten in einer Bewegung (`settled`
   * false, pro Bild) oder an ihrem Ende.
   */
  report(zoom: number, settled: boolean): void;
  /** Die Kamera springt (Schnitt): ab sofort dieser Zoom. */
  jump(zoom: number): void;
  /** Die Kamera fährt in `ms` dorthin — gleichmäßig genug für die Größe. */
  glide(zoom: number, ms: number): void;
  /**
   * Bei Sprung oder beginnendem Übergang Bescheid geben — für einen Durchgang
   * außer der Reihe, damit kein Bild mit der alten Größe stehen bleibt.
   */
  subscribe(fn: () => void): () => void;
}

/** Übergang nach dem Ende einer Geste. */
const MORPH_MS = 250;
/** So lange gilt eine Meldung mitten in der Bewegung als „ändert sich". */
const LIVE_REPORT_MS = 150;
/** Kleinere Unterschiede sind auf dem Schirm unsichtbar (< 1 %). */
const EPS = 0.01;

export function createZoomTrack(initial: number): ZoomTrack {
  let from = initial;
  let to = initial;
  let t0 = 0;
  let dur = 0;
  /** Übergang nach einer Geste: weich auslaufend statt gleichmäßig. */
  let easeOut = false;
  let changingUntil = 0;
  const subs = new Set<() => void>();
  const notify = () => subs.forEach((fn) => fn());

  const at = (now: number): number => {
    if (dur <= 0 || now >= t0 + dur) return to;
    if (now <= t0) return from;
    let k = (now - t0) / dur;
    if (easeOut) k = 1 - (1 - k) * (1 - k);
    return from + (to - from) * k;
  };
  const settle = (zoom: number) => {
    from = zoom;
    to = zoom;
    dur = 0;
  };

  return {
    at,
    changing: (now) => now < changingUntil,
    report(zoom, settled) {
      const now = Date.now();
      const cur = at(now);
      if (!settled) {
        // Die echte Lage mitten in der Bewegung — besser als jede Schätzung.
        if (Math.abs(zoom - cur) >= EPS * 0.5) changingUntil = now + LIVE_REPORT_MS;
        settle(zoom);
        return;
      }
      // Eine eigene Fahrt, deren Ziel schon feststeht, führt — die Meldung
      // kann von der eben abgebrochenen Vorgängerin stammen.
      if (dur > 0 && now < t0 + dur && !easeOut) return;
      if (Math.abs(zoom - cur) < EPS) {
        settle(zoom);
        return;
      }
      from = cur;
      to = zoom;
      t0 = now;
      dur = MORPH_MS;
      easeOut = true;
      changingUntil = now + MORPH_MS;
      notify();
    },
    jump(zoom) {
      const changed = Math.abs(zoom - at(Date.now())) >= EPS;
      settle(zoom);
      if (changed) notify();
    },
    glide(zoom, ms) {
      const now = Date.now();
      const cur = at(now);
      if (ms <= 0 || Math.abs(zoom - cur) < EPS) {
        settle(zoom);
        return;
      }
      from = cur;
      to = zoom;
      t0 = now;
      dur = ms;
      easeOut = false;
      changingUntil = now + ms;
      notify();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
