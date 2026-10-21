/**
 * MESSSONDE (vorübergehend) — schreibt nach logcat (`adb logcat -d | grep
 * LIVEPROBE`), zeigt nichts an. Zum Vermessen von Start und Ende der
 * Live-Ansicht am Gerät (feedback_measure_dont_infer_transitions). Nach der
 * Messung wieder entfernen.
 */
export function probeMark(tag: string): void {
  console.log(`LIVEPROBE ${tag} ${Date.now()}`);
}

/** Bildlücken über 24 ms auf der JS-Seite, `ms` lang nach einem Übergang. */
export function probeFrames(tag: string, ms = 3000): void {
  const t0 = performance.now();
  let last = t0;
  const gaps: string[] = [];
  const tick = (t: number) => {
    const d = t - last;
    if (d > 24) gaps.push(`${Math.round(t - t0)}:${Math.round(d)}`);
    last = t;
    if (t - t0 < ms) requestAnimationFrame(tick);
    else console.log(`LIVEPROBE ${tag} gaps ${gaps.join(" ") || "-"}`);
  };
  requestAnimationFrame(tick);
}

/** Dauer der Fahrzeug-Takte: alle 40 Takte Mittel und Spitze. */
let n = 0;
let sum = 0;
let max = 0;
export function probeTick(ms: number): void {
  n++;
  sum += ms;
  if (ms > max) max = ms;
  if (n >= 40) {
    console.log(`LIVEPROBE tick avg ${(sum / n).toFixed(1)} max ${max.toFixed(1)}`);
    n = 0;
    sum = 0;
    max = 0;
  }
}
