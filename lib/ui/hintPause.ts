import { useEffect, useRef } from "react";
import { AppState, type NativeEventSubscription } from "react-native";
import type { LandingPause } from "@/components/home/landingPause";
import { isSheetDragging, isTransitionBusy } from "@/lib/nav/transitionBusy";
import { isSheetMoving } from "@/lib/nav/searchHandoff";

/**
 * „Darf im Suchfeld gerade ein Hinweis wechseln?" — für die wechselnden
 * Hinweise AUSSERHALB des Landingscreens (Suchfeld des Ortswählers), mit
 * derselben Schnittstelle wie `useLandingPause`.
 *
 * Läuft nur, solange `active` gilt — der Aufrufer weiß, wann das Feld steht,
 * zu sehen und leer ist — und die App vorne ist; nie mitten in einer Fahrt
 * (`isBusy`). Kein Zustand, kein Render: Rückrufe und Referenzen. Der
 * App-Zustand wird nur abonniert, solange `active` gilt — ein geschlossener
 * Wähler hält keinen Horcher.
 */
export function useHintPause(active: boolean): LandingPause {
  const watchRef = useRef<ReturnType<typeof createHintWatch> | null>(null);
  if (watchRef.current === null) watchRef.current = createHintWatch();
  const watch = watchRef.current;
  useEffect(() => {
    watch.setActive(active);
  }, [watch, active]);
  useEffect(() => () => watch.dispose(), [watch]);
  return watch.api;
}

function createHintWatch() {
  const listeners = new Set<() => void>();
  let active = false;
  let appActive = true;
  let touching = false;
  let appSub: NativeEventSubscription | null = null;

  const notify = () => {
    for (const fn of Array.from(listeners)) fn();
  };

  const api: LandingPause = {
    isPaused: () => !active || !appActive || touching,
    isBusy: () => isTransitionBusy() || isSheetMoving() || isSheetDragging(),
    hold: () => {
      touching = true;
      notify();
    },
    release: () => {
      if (!touching) return;
      touching = false;
      notify();
    },
    listen: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  return {
    api,
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      if (next) {
        appActive = AppState.currentState === "active";
        appSub = AppState.addEventListener("change", (state) => {
          const a = state === "active";
          if (a === appActive) return;
          appActive = a;
          notify();
        });
      } else {
        appSub?.remove();
        appSub = null;
      }
      notify();
    },
    dispose() {
      appSub?.remove();
      appSub = null;
      // Zurück auf „aus": Ein erneutes Einhängen (StrictMode) meldet sich
      // dann wieder vollständig an, statt am Wächter oben vorbeizulaufen.
      active = false;
      listeners.clear();
    },
  };
}
