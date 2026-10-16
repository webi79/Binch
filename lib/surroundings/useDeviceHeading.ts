import { useEffect, useState } from "react";
import * as Location from "expo-location";
import { deviceHeading } from "@/modules/device-heading";
import { type Coord } from "./mockData";
import { isSheetDragging, isTransitionBusy } from "@/lib/nav/transitionBusy";
import { isMapMoving } from "@/lib/surroundings/mapViewport";

export interface DeviceHeading {
  /** Wohin das Telefon zeigt — Grad, 0 = geografisch Nord, im Uhrzeigersinn. */
  deg: number;
  /** Geschätzte Unsicherheit in Grad; −1, wenn der Sensor keine nennt. */
  accuracy: number;
}

/**
 * `expo-location` nennt die Genauigkeit nur als Stufe 0…3. Die Bandbreiten
 * stehen in dessen Dokumentation (für iOS: unter 20, 35, 50 Grad bzw. darüber);
 * hier jeweils die Mitte davon, damit beide Quellen dieselbe Einheit sprechen.
 */
function levelToDegrees(level: number): number {
  if (level >= 3) return 15;
  if (level === 2) return 30;
  if (level === 1) return 45;
  return 60;
}

type Listener = (heading: DeviceHeading | null) => void;

/**
 * Der Sensor wird auf MODULEBENE geschaltet — nicht über eine Eigenschaft.
 *
 * Der Kegel liegt in der Kartenfläche, und die steckt in einem `Freeze`
 * (`surroundings.tsx`). Eingefroren wird im selben Durchgang, in dem der Tab
 * den Fokus verliert, und ebenso, sobald Ortswähler, Suche, Bo oder der Verlauf
 * darüberliegen. Ein eingefrorener Baum bekommt keine neuen Eigenschaften mehr
 * — ein `active={false}` käme also nie an, und der Sensor feuerte dreißigmal
 * pro Sekunde weiter in einen Baum, den niemand sieht. Genau die Art
 * Hintergrundarbeit, die dieser Bildschirm an einem Dutzend Stellen fernhält.
 *
 * Deshalb schaltet der Bildschirm selbst, der nicht eingefroren wird, über
 * `setDeviceHeadingActive`. Der Sensor läuft genau dann, wenn er gewollt ist
 * UND jemand zuhört.
 */
const listeners = new Set<Listener>();
let wanted = false;
let stopSensor: (() => void) | null = null;

/**
 * DROSSEL — der Kegel darf nichts kosten, was man merkt.
 *
 * Der Sensor meldet bis zu dreißigmal pro Sekunde, schon beim ruhig
 * gehaltenen Telefon (Rauschen um ±1°). Jede Meldung war ein React-Durchgang
 * samt neuer `icon-rotate`-Eigenschaft — MapLibre setzt dafür die Symbole neu
 * und zeichnet das ganze Fenster neu (die Karte ist eine TextureView). Und
 * jeder React-Durchgang mitten in einer Blatt-Bewegung setzt das Blatt für ein
 * Bild zurück (siehe `startDragHeal` in lib/ui/sheetSwipe.ts).
 *
 * Deshalb durchgelassen nur:
 *   • höchstens alle 66 ms (15 Bilder pro Sekunde — für einen Kegel, der sich
 *     mit der Hand dreht, flüssig genug),
 *   • und erst ab 1,5° Änderung — das Rauschen in Ruhe fällt damit ganz weg,
 *   • und NICHT, solange sich etwas bewegt: ein Blatt unter dem Finger, eine
 *     Übergangs-Animation, die Karte selbst. Danach springt der Kegel mit der
 *     nächsten Messung auf die aktuelle Richtung — in Bewegung schaut niemand
 *     auf ihn.
 * Ein Wechsel der Genauigkeit geht immer durch (er ändert die Kegelbreite).
 */
const HEADING_MIN_INTERVAL_MS = 66;
const HEADING_MIN_DELTA_DEG = 1.5;
let lastEmitted: DeviceHeading | null = null;
let lastEmitAt = 0;

function angleDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}

function emitThrottled(heading: DeviceHeading) {
  if (isSheetDragging() || isTransitionBusy() || isMapMoving()) return;
  const now = Date.now();
  const prev = lastEmitted;
  if (prev && prev.accuracy === heading.accuracy) {
    if (now - lastEmitAt < HEADING_MIN_INTERVAL_MS) return;
    if (angleDelta(prev.deg, heading.deg) < HEADING_MIN_DELTA_DEG) return;
  }
  lastEmitted = heading;
  lastEmitAt = now;
  emit(heading);
}

function emit(heading: DeviceHeading | null) {
  if (heading === null) lastEmitted = null;
  for (const l of listeners) l(heading);
}

function startSensor(): () => void {
  const native = deviceHeading;
  if (native?.isAvailable()) {
    const sub = native.addListener("onHeading", (e) => {
      emitThrottled({ deg: e.heading, accuracy: e.accuracy });
    });
    native.start();
    return () => {
      native.stop();
      sub.remove();
    };
  }

  // iOS und Dev-Client ohne das Modul: `expo-location`.
  let cancelled = false;
  let sub: Location.LocationSubscription | null = null;
  Location.watchHeadingAsync((h) => {
    // Ohne Standortfreigabe gibt es kein geografisches Nord (−1) — dann das
    // magnetische, das ist um wenige Grad daneben, aber nicht falsch herum.
    const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
    emitThrottled({ deg, accuracy: levelToDegrees(h.accuracy) });
  })
    .then((s) => {
      if (cancelled) s.remove();
      else sub = s;
    })
    .catch(() => {
      // Kein Kompass im Gerät — dann eben kein Kegel.
    });
  return () => {
    cancelled = true;
    sub?.remove();
  };
}

function reconcile() {
  const run = wanted && listeners.size > 0;
  if (run && !stopSensor) {
    stopSensor = startSensor();
  } else if (!run && stopSensor) {
    stopSensor();
    stopSensor = null;
    // Beim nächsten Öffnen nicht mit einer alten Richtung aufgehen — lieber
    // einen Augenblick kein Kegel als einer, der falsch zeigt.
    emit(null);
  }
}

/**
 * Soll der Kompass laufen? Aufgerufen vom Umgebungs-Bildschirm: an, solange die
 * Karte zu sehen und nicht eingefroren ist. Siehe oben, warum hier und nicht als
 * Eigenschaft.
 */
export function setDeviceHeadingActive(active: boolean): void {
  if (active === wanted) return;
  wanted = active;
  reconcile();
}

/**
 * Wohin das Telefon zeigt — für den Blickrichtungs-Kegel am Standortpunkt.
 *
 * Auf Android aus dem eigenen Modul (`modules/device-heading`), das den
 * fusionierten Lagesensor liest; auf iOS und in einem Dev-Client ohne dieses
 * Modul aus `expo-location`. Warum nicht überall `expo-location`, steht im
 * Modul: Auf Android sind das fünf ungefilterte Messungen pro Sekunde.
 *
 * @param coord für die Missweisung. Nur auf ein Zehntelgrad gerundet genutzt:
 *   Sie ändert sich über Kilometer kaum, und ein neuer Wert je GPS-Fix wäre
 *   ein Aufruf über die Brücke ohne jede Wirkung.
 */
export function useDeviceHeading(coord: Coord | null): DeviceHeading | null {
  const [heading, setHeading] = useState<DeviceHeading | null>(null);

  const latKey = coord ? Math.round(coord.latitude * 10) : null;
  const lonKey = coord ? Math.round(coord.longitude * 10) : null;
  useEffect(() => {
    if (!deviceHeading || latKey === null || lonKey === null) return;
    try {
      deviceHeading.setLocation(latKey / 10, lonKey / 10);
    } catch {
      // Ohne Missweisung zeigt der Kegel um wenige Grad daneben — kein Grund,
      // die Karte mitzureißen.
    }
  }, [latKey, lonKey]);

  useEffect(() => {
    listeners.add(setHeading);
    reconcile();
    return () => {
      listeners.delete(setHeading);
      reconcile();
    };
  }, []);

  return heading;
}
