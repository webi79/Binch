/**
 * „Dieser Tab wird gerade über die Tab-Leiste BETRETEN."
 *
 * Für kleine Einlauf-Bewegungen, die nur beim bewussten Wechsel laufen sollen
 * (Gespeichert: die Karten kommen von unten) — nicht beim Zurückkehren aus
 * einer Unterseite wie der Routen-Karte und nicht beim App-Start. Am
 * Fokus-Ereignis des Navigators lässt sich das nicht unterscheiden, an der
 * Tab-Leiste schon: Gemeldet wird aus `go` in components/ui/BinchTabBar.tsx,
 * direkt nach dem Wechsel.
 *
 * Ein Ereignis, kein Speicherfeld: Es soll niemanden neu rendern lassen.
 */
const listeners = new Map<string, Set<() => void>>();

export function announceTabEnter(href: string): void {
  listeners.get(href)?.forEach((l) => l());
}

export function onTabEnter(href: string, listener: () => void): () => void {
  let set = listeners.get(href);
  if (!set) {
    set = new Set();
    listeners.set(href, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
