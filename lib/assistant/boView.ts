/**
 * Was Bos Bildschirm gerade zeigt: den Chat oder „Geplant".
 *
 * Als Verteiler und nicht als Zustandsgröße des Bildschirms — dieselbe Bauart
 * und derselbe Grund wie `setBoBlocked` dort: Gebraucht wird der Wert an drei
 * kleinen Stellen (die Seite selbst, die Zeile in der Schublade, Bos Pause), und
 * ein Durchgang des ganzen Bildschirms ist dafür viel zu teuer.
 */
import { useEffect, useState } from "react";

export type BoView = "chat" | "scheduled";

let view: BoView = "chat";
const listeners = new Set<(view: BoView) => void>();

export function getBoView(): BoView {
  return view;
}

export function setBoView(next: BoView): void {
  if (view === next) return;
  view = next;
  for (const fn of listeners) fn(next);
}

export function subscribeBoView(fn: (view: BoView) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useBoView(): BoView {
  const [current, set] = useState(view);
  useEffect(() => {
    set(view);
    return subscribeBoView(set);
  }, []);
  return current;
}
