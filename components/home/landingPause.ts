import { useContext, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { NavigationContext, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { isSheetDragging, isTransitionBusy } from "@/lib/nav/transitionBusy";
import { isSheetMoving } from "@/lib/nav/searchHandoff";
import { isLaunchSplashDone, onLaunchSplashDone } from "@/lib/ui/launchSplash";
import { useSearchStore, type SearchStoreState } from "@/stores/searchStore";

/**
 * „Darf in der Landingscreen-Leiste gerade etwas von selbst passieren?"
 *
 * Gemeinsam für die wechselnden Sprüche (`RotatingPlaceholder`) und den kleinen
 * Bo daneben (`MiniBo`) — beide sollen genau dann stillstehen, wenn sie niemand
 * sieht oder wenn sie stören würden: Landingscreen nicht im Fokus, App im
 * Hintergrund, Startbild noch da, eine Überlagerung darüber (Bo vorneweg), ein
 * Finger auf der Leiste. Dazu, nur abgefragt: Fährt woanders gerade etwas?
 *
 * Gesteuert über Modul-Werte, Rückrufe und Referenzen statt über Zustände:
 * Nichts davon löst einen Render aus — weder hier noch im Landingscreen.
 */

/**
 * Eine Berührung, deren Ende verloren ging, gilt danach als vorbei — sonst
 * stünde alles für den Rest des App-Laufs still.
 */
const TOUCH_MAX_MS = 10_000;

/**
 * Liegt etwas über dem Landingscreen? Dann sieht die Leiste niemand.
 *
 * Diese Flächen hängen am Wurzel-Layout, nicht an der Navigation — der
 * Landingscreen behält darunter den Fokus, ein Fokus-Haken allein sähe sie also
 * nicht. Bo vorneweg: Er muss ausdrücklich pausieren, und sein Merker fällt erst,
 * wenn seine Ausfahrt durch ist.
 */
function coveredBy(s: SearchStoreState): boolean {
  return (
    s.assistantOpen ||
    s.searchOverlayMode != null ||
    s.resultsParams != null ||
    s.selectedResult != null ||
    s.legTimelineOverlayOpen ||
    s.voiceOverlayOpen ||
    s.recentHistoryOverlayOpen ||
    s.notificationsOpen ||
    s.authOverlayOpen
  );
}

export interface LandingPause {
  /** Steht gerade etwas dagegen? Dann startet nichts Neues. */
  isPaused(): boolean;
  /**
   * Fährt woanders gerade etwas? Nur zum Abfragen, kein Ereignis — vor jedem
   * Start fragen und es sonst etwas später noch einmal versuchen.
   */
  isBusy(): boolean;
  /** Finger liegt auf der Leiste — Pause, bis er wieder weg ist. */
  hold(): void;
  release(): void;
  /** Rückruf nach JEDER Änderung einer Bedingung oben. Liefert die Abmeldung. */
  listen(fn: () => void): () => void;
}

type Nav = NavigationProp<ParamListBase> | undefined;

function createWatch() {
  const listeners = new Set<() => void>();
  let attached = false;
  let focused = true;
  let appActive = true;
  let covered = false;
  let splashGone = false;
  let touching = false;
  /** Weckt nach TOUCH_MAX_MS, falls Loslassen und Abbruch beide ausbleiben. */
  let touchWake: ReturnType<typeof setTimeout> | null = null;

  const notify = () => {
    for (const fn of Array.from(listeners)) fn();
  };

  const endTouch = () => {
    if (touchWake !== null) {
      clearTimeout(touchWake);
      touchWake = null;
    }
    if (!touching) return;
    touching = false;
    notify();
  };

  const api: LandingPause = {
    isPaused: () => !attached || !focused || !appActive || covered || !splashGone || touching,
    isBusy: () => isTransitionBusy() || isSheetMoving() || isSheetDragging(),
    hold: () => {
      if (touchWake !== null) clearTimeout(touchWake);
      touchWake = setTimeout(endTouch, TOUCH_MAX_MS);
      touching = true;
      notify();
    },
    release: endTouch,
    listen: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };

  /** Anmelden bei allen Quellen; liefert das Abmelden. */
  const attach = (navigation: Nav) => {
    attached = true;
    touching = false;
    focused = navigation ? navigation.isFocused() : true;
    appActive = AppState.currentState !== "background" && AppState.currentState !== "inactive";
    covered = coveredBy(useSearchStore.getState());
    splashGone = isLaunchSplashDone();

    const unsubFocus = navigation?.addListener("focus", () => {
      focused = true;
      notify();
    });
    const unsubBlur = navigation?.addListener("blur", () => {
      focused = false;
      notify();
    });
    const appSub = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      if (active === appActive) return;
      appActive = active;
      notify();
    });
    const unsubStore = useSearchStore.subscribe((s) => {
      const c = coveredBy(s);
      if (c === covered) return;
      covered = c;
      notify();
    });
    const unsubSplash = onLaunchSplashDone(() => {
      splashGone = true;
      notify();
    });
    // Wer schon zuhört (Wechsel der Navigation), bewertet neu.
    notify();

    return () => {
      attached = false;
      if (touchWake !== null) {
        clearTimeout(touchWake);
        touchWake = null;
      }
      touching = false;
      unsubFocus?.();
      unsubBlur?.();
      appSub.remove();
      unsubStore();
      unsubSplash();
    };
  };

  return { api, attach };
}

/**
 * Je Nutzer ein eigener Wächter — ein stabiles Objekt über die ganze
 * Lebensdauer, damit es in Effekt-Abhängigkeiten stehen kann.
 *
 * Gelesen wird in einem Effekt, der VOR dem des Nutzers steht: Wer `listen`
 * im eigenen Effekt aufruft, findet die Bedingungen also schon angemeldet vor.
 */
export function useLandingPause(): LandingPause {
  /**
   * Der Kontext direkt statt `useIsFocused()`: Der Haken rendert bei jedem
   * Fokuswechsel neu — genau im Bild des Tab-Wechsels. Die Rückrufe der
   * Navigation tun das nicht. Außerhalb eines Bildschirms (kein Kontext) gilt
   * die Leiste als immer sichtbar.
   */
  const navigation = useContext(NavigationContext) as Nav;
  const watchRef = useRef<ReturnType<typeof createWatch> | null>(null);
  if (watchRef.current === null) watchRef.current = createWatch();
  const watch = watchRef.current;
  useEffect(() => watch.attach(navigation), [watch, navigation]);
  return watch.api;
}
