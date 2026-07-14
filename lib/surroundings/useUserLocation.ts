import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { USER_LOC, type Coord } from "./mockData";

export type LocationStatus = "loading" | "granted" | "denied" | "error";

export interface UseUserLocation {
  /** Aktuelle Position. Fällt auf den Default (Berlin Hbf) zurück, wenn GPS abgelehnt/fehlerhaft. */
  coord: Coord;
  status: LocationStatus;
  /** Position aktiv neu auflösen — für den Locate-FAB. */
  refresh: () => Promise<void>;
}

/**
 * Ein frischer GPS-Fix darf die Karte nicht blockieren.
 *
 * `getCurrentPositionAsync` wartet auf eine echte Messung — in Gebäuden dauert
 * das gern 10-30 s und kann auch gar nicht zurückkommen (das SDK hat kein
 * eigenes Timeout). Solange stand `coord` auf dem Default USER_LOC = BERLIN:
 * Der Surroundings-Screen feuerte seinen ersten /api/surroundings-Call also für
 * Berlin, und der User sah erst nach dem Fix (flyTo → Map-Idle → neuer Viewport
 * → neuer Call) seine echte Umgebung. Hing das GPS, blieb er ganz auf Berlin
 * sitzen — „ich krieg nichts, lade neu, dann geht's" (beim 2. Versuch ist der
 * Fix warm).
 */
const FRESH_FIX_TIMEOUT_MS = 8_000;
/** Ein Fix aus den letzten 5 Min ist für „was ist um mich herum" gut genug. */
const LAST_KNOWN_MAX_AGE_MS = 5 * 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/**
 * Holt den Standort beim Mount und bietet ein manuelles refresh() für den
 * Locate-Button. Zweistufig:
 *
 *   1. `getLastKnownPositionAsync` — der vom OS zwischengespeicherte Fix, da
 *      praktisch sofort. Damit stimmen Karte und erster Backend-Call von
 *      Anfang an.
 *   2. `getCurrentPositionAsync` — die genaue Messung, aber gedeckelt. Läuft sie
 *      in den Timeout, behalten wir den Fix aus (1), statt ewig zu hängen.
 */
export function useUserLocation(): UseUserLocation {
  const [coord, setCoord] = useState<Coord>(USER_LOC);
  const [status, setStatus] = useState<LocationStatus>("loading");

  const fetchLocation = async (): Promise<void> => {
    try {
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== "granted") {
        setStatus("denied");
        return;
      }

      // 1) Sofort verfügbarer Fix aus dem OS-Cache.
      let haveFix = false;
      try {
        const last = await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS });
        if (last) {
          setCoord({ latitude: last.coords.latitude, longitude: last.coords.longitude });
          setStatus("granted");
          haveFix = true;
        }
      } catch {
        // Kein Cache-Fix → unten auf die frische Messung warten.
      }

      // 2) Genaue Messung — mit Deckel, sonst hängt der Screen am GPS.
      const fresh = await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        FRESH_FIX_TIMEOUT_MS,
      );
      if (fresh) {
        setCoord({ latitude: fresh.coords.latitude, longitude: fresh.coords.longitude });
        setStatus("granted");
      } else if (!haveFix) {
        // Weder Cache noch frischer Fix → der Screen darf nicht in "loading"
        // festhängen, sonst wartet die Query ewig auf einen Standort.
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    void fetchLocation();
  }, []);

  return { coord, status, refresh: fetchLocation };
}
