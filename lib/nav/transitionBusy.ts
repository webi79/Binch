/**
 * „Gerade fährt etwas" — als schlichter Zeitstempel.
 *
 * WOZU: Die Persistenz des Speichers serialisiert über 50 KB und braucht dafür
 * 10 bis 30 Millisekunden auf dem JS-Strang. Sie wartet deshalb auf eine
 * Leerlauf-Lücke (`requestIdleCallback`). Nur misst die die Ruhe des
 * JS-STRANGS — und jede Bewegung dieser App läuft als Worklet auf dem
 * UI-STRANG. Während einer Slide ist der JS-Strang also genau ruhig, die
 * Leerlauf-Bedingung ist erfüllt, und der Schreibvorgang läuft ausgerechnet
 * dann hinein.
 *
 * Sichtbar fällt dabei kein Bild aus: Die Kurve selbst rechnet weiter auf dem
 * UI-Strang. Was sich staut, sind die Rückrufe, an denen die Übergänge hängen —
 * `runOnJS` am Ende einer Bewegung, React-Commits, Berührungen. Genau das kommt
 * als „läuft, hakt kurz, läuft weiter" an.
 *
 * WARUM EIN ZEITSTEMPEL und kein Zähler: Ein Zähler müsste bei jedem
 * Abbruch, jeder unterbrochenen Kurve und jedem Bildschirm, der ohne
 * Abschluss-Rückruf verschwindet, sauber wieder heruntergezählt werden — und
 * jeder vergessene Pfad ließe die Persistenz für immer verstummen. Ein
 * Zeitstempel verfällt von selbst; im schlimmsten Fall wartet ein
 * Schreibvorgang eine halbe Sekunde zu lang.
 */
let busyUntil = 0;

/** Meldet eine laufende Bewegung an, für die angegebene Dauer plus Reserve. */
export function markTransitionBusy(durationMs: number): void {
  const until = Date.now() + durationMs + 80;
  if (until > busyUntil) busyUntil = until;
}

export function isTransitionBusy(): boolean {
  return Date.now() < busyUntil;
}
