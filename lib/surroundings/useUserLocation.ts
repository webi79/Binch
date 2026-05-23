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
 * Holt den aktuellen GPS-Standort einmalig beim Mount und bietet ein
 * manuelles refresh() für den Locate-Button. Fragt Permission, falls noch
 * nicht erteilt. Bei Ablehnung/Fehler bleiben wir auf dem Default-Standort.
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
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      setCoord({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
      setStatus("granted");
    } catch {
      setStatus("error");
    }
  };

  useEffect(() => {
    void fetchLocation();
  }, []);

  return { coord, status, refresh: fetchLocation };
}
