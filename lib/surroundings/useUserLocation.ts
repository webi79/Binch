import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { type Coord } from "./mockData";
import { useSearchStore } from "@/stores/searchStore";

export type LocationStatus = "loading" | "granted" | "denied" | "error";

export interface UseUserLocation {
  /**
   * Aktuelle Position, oder `null` solange keine bekannt ist.
   *
   * Hier stand ein fest verdrahteter Platzhalter (Berlin Hbf). Der wurde
   * überall wie eine echte Position behandelt: Die Karte startete dort, die
   * Umkreis-Abfrage lief dafür, und die Stecknadel „du bist hier" stand
   * mitten in Berlin — für jeden Nutzer, der nicht in Berlin ist. `null` ist
   * die ehrliche Antwort, und die Aufrufer können darauf reagieren.
   */
  coord: Coord | null;
  status: LocationStatus;
  /** true, sobald die Position aus einer echten Messung stammt (nicht aus dem
   *  gemerkten Wert der letzten Sitzung). */
  hasFix: boolean;
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
  // Zeitgeber aufräumen, sobald das Rennen entschieden ist. Ohne das lief er
  // auch dann weiter, wenn die Ortung längst geantwortet hat — bei jedem Tippen
  // auf den Standort-Knopf erneut.
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
/**
 * @param enabled false = noch gar nichts tun. Gedacht für Bildschirme, die
 * vorgerendert im Hintergrund liegen: Seit die Tabs beim App-Start entstehen
 * (lazy={false}), lief die Ortung sonst sofort los — inklusive Berechtigungs-
 * Dialog und GPS-Fix für einen Tab, den der Nutzer vielleicht nie öffnet.
 */
export function useUserLocation(enabled = true): UseUserLocation {
  /**
   * Start beim zuletzt bekannten EIGENEN Ort, nicht bei einem fremden.
   *
   * Der gemerkte Wert überlebt den App-Start (siehe `lastKnownCoord` im
   * Speicher). Beim allerersten Start gibt es ihn nicht — dann bleibt es bei
   * `null`, und die Karte startet weit herausgezoomt statt in einer Stadt, in
   * der der Nutzer nicht ist.
   */
  const remembered = useSearchStore((s) => s.lastKnownCoord);
  const [coord, setCoord] = useState<Coord | null>(remembered);
  const [hasFix, setHasFix] = useState(false);
  const [status, setStatus] = useState<LocationStatus>("loading");

  const remember = (c: Coord) => {
    setCoord(c);
    setHasFix(true);
    setStatus("granted");
    useSearchStore.getState().setLastKnownCoord(c);
  };

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
          remember({ latitude: last.coords.latitude, longitude: last.coords.longitude });
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
        remember({ latitude: fresh.coords.latitude, longitude: fresh.coords.longitude });
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
    if (!enabled) return;
    void fetchLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  return { coord, status, hasFix, refresh: fetchLocation };
}
