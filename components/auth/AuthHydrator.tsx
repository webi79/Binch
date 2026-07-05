import { useEffect, useRef } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { authMe } from "@/lib/api/client";
import { loadAuthToken, saveAuthToken } from "@/lib/auth/tokenStorage";

/**
 * Mounted once at app root. Lädt das Session-Token aus dem SecureStore
 * (Keystore/Keychain) und validiert es via /api/auth/me — bei Erfolg wird
 * die Session in den Store gesetzt, sonst der lokale Auth-State geleert.
 *
 * Migration: Bestandsinstallationen haben das Token noch im persistierten
 * AsyncStorage-Blob des Stores (alte Ära). Die persist-Hydration setzt es
 * dann in state.authToken — Pfad A schiebt es einmalig in den SecureStore;
 * aus dem Persist-Blob verschwindet es beim nächsten Write von selbst
 * (partialize lässt authToken inzwischen weg).
 */
/** Nur bei einem ECHTEN Auth-Fehler (401) ausloggen — Netzwerkfehler
 *  (Server offline, Funkloch) dürfen die Session nicht zerstören. */
function isAuthRejection(err: unknown): boolean {
  return err instanceof Error && /API 401/.test(err.message);
}

export function AuthHydrator() {
  const storeToken = useSearchStore((s) => s.authToken);
  // Verhindert Doppel-Validierung, wenn beide Pfade feuern (und dass Pfad A
  // erneut anspringt, wenn Pfad B das Token via setAuth in den Store setzt).
  const started = useRef(false);

  // Pfad A (Migration/alte Ära): Token taucht per persist-Hydration im Store auf.
  useEffect(() => {
    if (!storeToken || started.current) return;
    started.current = true;
    let cancelled = false;
    void saveAuthToken(storeToken);
    // Re-Persist erzwingen: der ALTE AsyncStorage-Blob enthält das Token noch
    // im Klartext und würde sonst erst beim nächsten organischen Store-Write
    // überschrieben (partialize lässt authToken jetzt weg). Ein leerer
    // setState-Patch triggert die persist-Middleware sofort.
    useSearchStore.setState({});
    (async () => {
      try {
        const user = await authMe(storeToken);
        if (!cancelled) useSearchStore.getState().setAuthUser(user);
      } catch (err) {
        if (!cancelled && isAuthRejection(err)) useSearchStore.getState().clearAuth();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storeToken]);

  // Pfad B (Normalfall): Token liegt im SecureStore. Kurzer Delay, damit die
  // persist-Hydration (Pfad A) zuerst greifen kann.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (started.current || useSearchStore.getState().authToken) return;
        const token = await loadAuthToken();
        if (!token || cancelled || started.current) return;
        started.current = true;
        try {
          const user = await authMe(token);
          if (!cancelled) useSearchStore.getState().setAuth(token, user);
        } catch (err) {
          if (!cancelled && isAuthRejection(err)) {
            // Token ungültig/abgelaufen → aus dem SecureStore entfernen.
            void saveAuthToken(null);
          }
          // Netzwerkfehler: Token behalten — nächster App-Start versucht's neu.
        }
      })();
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  return null;
}
