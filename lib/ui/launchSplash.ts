/**
 * „Das Startbild ist weg" — als Modul-Signal statt als Zustand.
 *
 * Das Startbild ist ein lokaler Zustand im Wurzel-Layout (`splashDone`). Der
 * Landingscreen liegt währenddessen schon fertig gemountet darunter, nur eben
 * unsichtbar — und alles, was dort nach der Uhr läuft, läuft damit auch hinter
 * dem Startbild los. Für den wechselnden Platzhalter der Suchleiste hieße das:
 * Der erste Satz („Wohin möchtest du reisen?") wäre längst weitergerückt, wenn
 * das Bild ausblendet, und man sähe ihn nie.
 *
 * Ein Modul-Wert statt eines Speicherfelds, aus demselben Grund wie in
 * `lib/nav/transitionBusy.ts`: Ein Schreibvorgang im Speicher weckt jeden
 * Abonnenten der App, und das genau im Bild, in dem das Startbild ausblendet.
 * Hier hört nur zu, wer sich ausdrücklich anmeldet.
 */
let done = false;
const listeners = new Set<() => void>();

/** Vom Wurzel-Layout gerufen, sobald das Startbild seine Animation beendet hat. */
export function markLaunchSplashDone(): void {
  if (done) return;
  done = true;
  for (const fn of listeners) fn();
  listeners.clear();
}

export function isLaunchSplashDone(): boolean {
  return done;
}

/**
 * Meldet sich für das Ende des Startbilds an. Ist es schon vorbei, kommt der
 * Rückruf nicht — wer anmeldet, fragt vorher `isLaunchSplashDone()`.
 */
export function onLaunchSplashDone(fn: () => void): () => void {
  if (done) return () => {};
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
