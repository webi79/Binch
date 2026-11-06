/**
 * „Bewegung reduzieren" — NUR für Slides.
 *
 * Profil → Einstellungen → Darstellung. Gemeint sind die großen Bewegungen:
 * Bildschirme, die hereinfahren, Blätter, Wähler, die Schublade, Reiter-Panels.
 * Pille, Schalter, Bo, Meldungen und alles Kleine laufen weiter wie immer —
 * zuerst wirkte der Schalter global über Reanimateds `ReducedMotionConfig`, und
 * dann sah „alles andere komisch aus" (Nutzer, 28.10.2026).
 *
 * Jede Slide reicht ihre Zeitkurve durch `slideTiming(...)`. Ist der Schalter an,
 * springt sie sofort ans Ziel (`ReduceMotion.Always`), Rückrufe kommen wie
 * gewohnt mit `finished === true`. Ist er aus, bleibt es bei
 * `ReduceMotion.System`: Die Einstellung des Handys gilt wie vorher.
 *
 * Eine FRISCHE Konfiguration je Aufruf, keine veränderte Konstante: Reanimated
 * kopiert eine Konfiguration beim ersten Übergang auf den UI-Strang und hebt
 * die Kopie auf (in Entwicklungs-Builds friert es das Original sogar ein) —
 * ein später umgestellter Wert käme dort nie an.
 *
 * Läuft auf beiden Strängen: Auf dem JS-Strang gilt der Merker hier, in einem
 * Worklet (Gesten) der geteilte Wert.
 */
import { makeMutable, ReduceMotion } from "react-native-reanimated";

let reduceJs = false;
const reduceUi = makeMutable(false);

/** Vom Wurzel-Layout aufgerufen, wenn der Schalter wechselt. */
export function setSlideReduce(on: boolean): void {
  if (on === reduceJs) return;
  reduceJs = on;
  reduceUi.value = on;
}

declare const _WORKLET: boolean | undefined;

export function slideTiming<T extends object>(cfg: T): T & { reduceMotion: ReduceMotion } {
  "worklet";
  const on = typeof _WORKLET !== "undefined" && _WORKLET ? reduceUi.value : reduceJs;
  return { ...cfg, reduceMotion: on ? ReduceMotion.Always : ReduceMotion.System };
}
