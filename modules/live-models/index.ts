import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

/**
 * Die 3D-Fahrzeuge der Live-Ansicht als eigene Ebene in der Karte (nur
 * Android; Umsetzung in android/src/main/cpp). Ohne das Modul bleibt es beim
 * 2D-Punkt.
 */
interface LiveModelsNativeModule {
  /** Ebene in die Karte mit dieser Kennung hängen (unter `below`, wenn es die Ebene gibt). */
  attach(mapTag: number, below: string | null): Promise<boolean>;
  detach(): Promise<boolean>;
  /** Strecke: Länge, Breite abwechselnd; Meter ab Beginn je Punkt. */
  setRoute(lngLat: number[], cum: number[]): void;
  /** kind 0 Bahn, 1 Bus, 2 Flugzeug; Belegung von `params` siehe live_models_core.cpp. */
  setVehicle(kind: number, headMesh: string, midMesh: string, params: number[]): void;
  /** Boden: t0, d0, t1, d1 (ms seit 1970, Meter). Flug: t0, Länge, Breite, Höhe, Kurs, t1, … */
  setMotion(motion: number[]): void;
}

const native = Platform.OS === "android" ? requireOptionalNativeModule<LiveModelsNativeModule>("LiveModels") : null;

export const LiveModels = {
  available: native != null,
  attach: (mapTag: number, below: string | null) => native?.attach(mapTag, below) ?? Promise.resolve(false),
  detach: () => native?.detach() ?? Promise.resolve(false),
  setRoute: (lngLat: number[], cum: number[]) => native?.setRoute(lngLat, cum),
  setVehicle: (kind: number, headMesh: string, midMesh: string, params: number[]) =>
    native?.setVehicle(kind, headMesh, midMesh, params),
  setMotion: (motion: number[]) => native?.setMotion(motion),
};
