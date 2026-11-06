/**
 * DATENSPAREN — Luftbild und 3D-Häuser nur im WLAN.
 *
 * Profil → Einstellungen → Darstellung. Ist der Schalter an und das Handy NICHT
 * im WLAN (oder per Kabel), zeigt die Karte statt des Luftbilds den normalen
 * Stil und keine 3D-Häuser. Das sind mit Abstand die größten Datenmengen der
 * App; im Ausland mit teurem Datenvolumen ist das der Unterschied.
 *
 * Bis die erste Antwort des Systems da ist, gilt das Netz als unbekannt — und
 * unbekannt heißt sparen: Lieber das Luftbild einen Augenblick später zeigen,
 * als es einmal über Mobilfunk anzufangen.
 *
 * EIN Abo für die ganze App (wie `useReduceMotion` in lib/motion.tsx), und erst,
 * wenn der Schalter das erste Mal an ist — wer ihn nie benutzt, bekommt keinen
 * Zuhörer.
 */
import { useSyncExternalStore } from "react";
import * as Network from "expo-network";
import { useSearchStore } from "@/stores/searchStore";

let unmetered: boolean | null = null;
let watching = false;
const subs = new Set<() => void>();

function publish(state: Network.NetworkState): void {
  const next = state.type === Network.NetworkStateType.WIFI || state.type === Network.NetworkStateType.ETHERNET;
  if (next === unmetered) return;
  unmetered = next;
  for (const notify of subs) notify();
}

function watch(): void {
  if (watching) return;
  watching = true;
  Network.getNetworkStateAsync().then(publish).catch(() => {});
  Network.addNetworkStateListener(publish);
}

function subscribe(notify: () => void): () => void {
  subs.add(notify);
  return () => {
    subs.delete(notify);
  };
}

/** Wird gerade gespart? Nur wenn der Schalter an ist UND kein WLAN bekannt ist. */
export function useDataSaverActive(): boolean {
  const enabled = useSearchStore((s) => s.dataSaver);
  if (enabled) watch();
  const wifi = useSyncExternalStore(subscribe, () => unmetered);
  return enabled && wifi !== true;
}
