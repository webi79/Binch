import { createContext, useContext, useRef, type ReactNode } from "react";
import { usePathname, useGlobalSearchParams } from "expo-router";

/**
 * Route-Spiegel: die aktuelle Route in einer STABILEN Ref, ohne Abo im Render.
 *
 * Warum das nötig ist: `usePathname()` und `useLocalSearchParams()` sind in
 * expo-router 6 beide `useSyncExternalStore` auf das komplette routeInfo-Objekt.
 * Jeder Tab-Wechsel ändert den Pfad ("/" → "/saved" → …) → neuer Snapshot →
 * JEDE Komponente, die einen der beiden Hooks aufruft, rendert neu. Bei
 * `ResultCard` lief das an der `memo`-Schranke vorbei (der Hook sitzt INNEN),
 * und im Saved-Tab hängen alle gespeicherten Trips ungeschnitten in einer
 * ScrollView → bei 15 Trips 15 schwere Renders in genau dem Frame, der den
 * Tab-Wechsel trägt. Genau das fühlt sich als Input-Lag an.
 *
 * Die Karten brauchen die Route aber gar nicht zum ZEICHNEN — nur im
 * Press-Handler, um festzuhalten, wohin „Auf Karte zeigen" später
 * zurücknavigieren soll. Also: EIN Abo an einer Stelle, das Ergebnis in eine
 * Ref, und die Karten lesen sie erst beim Tippen.
 *
 * Der Provider-Wert ist die Ref selbst (referenzstabil) → Consumer rendern NIE
 * wegen einer Routen-Änderung neu. Der Provider selbst rendert neu, sein
 * `children`-Element bleibt aber dasselbe Objekt → React überspringt den
 * Teilbaum.
 */
export interface RouteSnapshot {
  pathname: string;
  params?: Record<string, string>;
}

const FALLBACK: { current: RouteSnapshot } = { current: { pathname: "/" } };
const RouteMirrorContext = createContext(FALLBACK);

export function RouteMirror({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // GLOBAL, nicht local: Am Root liefert `useLocalSearchParams()` die Params
  // der Root-Route (= leer). Wir wollen die der gerade fokussierten Route —
  // dasselbe, was die Karte vorher an ihrer eigenen Position gesehen hat.
  const params = useGlobalSearchParams();

  const ref = useRef<RouteSnapshot>({ pathname });
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") flat[key] = value;
    else if (Array.isArray(value) && typeof value[0] === "string") flat[key] = value[0];
  }
  ref.current = {
    pathname,
    params: Object.keys(flat).length > 0 ? flat : undefined,
  };

  return <RouteMirrorContext.Provider value={ref}>{children}</RouteMirrorContext.Provider>;
}

/** Liefert die Ref — im Render NICHT dereferenzieren, erst im Handler lesen. */
export function useRouteMirror(): { current: RouteSnapshot } {
  return useContext(RouteMirrorContext);
}
