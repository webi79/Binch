import { Easing, makeMutable, runOnUI, withTiming } from "react-native-reanimated";
import { notifyViewportChanged } from "@/lib/surroundings/mapViewport";

/**
 * NUR DIE KARTE — die Oberfläche des Karten-Tabs fährt aus dem Bild.
 *
 * Wer an der Suchleiste nach oben wischt, schiebt alles hinaus, was über der
 * Karte liegt: Suchleiste und Knopfreihe (obere Bildhälfte) nach OBEN,
 * Auswahlfenster samt Standort-Knopf und Tab-Leiste (untere Hälfte) nach UNTEN.
 * Ein Tipp auf die freie Karte holt alles zurück — wie bei Google Maps.
 *
 * EINE VERSCHIEBUNG IN PUNKTEN für alle Teile — nicht ein Fortschritt 0…1.
 *
 * Vorher teilten sich alle einen Fortschritt, und jedes Teil rechnete daraus
 * seinen eigenen Weg bis hinter den Rand. Damit kamen alle GLEICHZEITIG an,
 * fuhren aber verschieden SCHNELL: die Suchleiste rund 100 Punkte, das
 * Auswahlfenster bis 450 in derselben Zeit. Gemeldet als „die Elemente fliegen
 * unterschiedlich schnell".
 *
 * Jetzt fährt jedes Teil dieselbe Verschiebung mit, bis es draußen ist
 * (`min(chromeShift, eigener Weg)`). Alle bewegen sich in jedem Bild um genau
 * gleich viel; wer den kürzeren Weg hat, ist nur früher draußen — die
 * Knopfreihe verschwindet eben nach der Suchleiste. Zurück genauso, nur
 * rückwärts.
 */
export const chromeShift = makeMutable(0);

/**
 * Der Weg jedes Teils bis hinter den Rand, gemessen von den Teilen selbst.
 * Die Verschiebung muss bis zum LÄNGSTEN laufen, sonst bliebe ein Rest stehen;
 * weiter als nötig zu fahren hieße dagegen, dass beim Zurückholen erst eine
 * Weile nichts passiert.
 */
export const travelSearch = makeMutable(0);
export const travelFabs = makeMutable(0);
/** Auswahlfenster samt Standort-Knopf darüber — hängt am Rastpunkt des Blattes. */
export const travelBottom = makeMutable(0);
export const travelBar = makeMutable(0);

export function maxTravel(): number {
  "worklet";
  return Math.max(travelSearch.value, travelFabs.value, travelBottom.value, travelBar.value);
}

/**
 * Wann ein losgelassener Wisch die Oberfläche ganz ausblendet: ab gut einem
 * Drittel des Weges der Suchleiste — die ist es, die man anfasst —, oder bei
 * deutlichem Schwung nach oben. Darunter kommt sie zurück; ein kurzes
 * Anstoßen soll nichts verstecken.
 */
export const HIDE_AT = 0.35;
export const HIDE_VELOCITY = -600;

/** Ruhiges Tempo ohne Schwung: Punkte pro Millisekunde. */
const SPEED = 1.6;

/**
 * Die Bewegung ab dem Loslassen — sie SETZT DEN FINGER FORT.
 *
 * Vorher lief hier die Blatt-Kurve (0.4, 0, 0.4, 1): Sie beginnt mit Tempo
 * null. Wer zügig wischte, sah die Teile beim Loslassen erst abbremsen und
 * dann wieder anziehen — ein Knick mitten in der Bewegung.
 *
 * Mit Schwung: eine abbremsende Kurve (kubisch), deren Anfangstempo dem des
 * Fingers entspricht — bei ihr ist das Tempo am Start das Dreifache des
 * Durchschnitts, die Dauer also 3 · Weg / Fingertempo. Ohne nennenswerten
 * Schwung: ein ruhiges, festes Tempo. Beides begrenzt, damit weder ein
 * Schnipsen zuckt noch ein langer Weg schleicht.
 */
export function settle(target: number, velocityPxPerS: number): void {
  "worklet";
  const remaining = Math.abs(target - chromeShift.value);
  if (remaining < 0.5) {
    chromeShift.value = target;
    return;
  }
  const v = Math.abs(velocityPxPerS) / 1000;
  const movingToward =
    (target > chromeShift.value && velocityPxPerS < 0) ||
    (target < chromeShift.value && velocityPxPerS > 0);
  if (movingToward && v > 0.3) {
    const duration = Math.min(420, Math.max(160, (3 * remaining) / v));
    chromeShift.value = withTiming(target, { duration, easing: Easing.out(Easing.cubic) });
    return;
  }
  const duration = Math.min(420, Math.max(220, remaining / SPEED));
  chromeShift.value = withTiming(target, { duration, easing: Easing.bezier(0.2, 0, 0, 1) });
}

/**
 * Der JS-seitige Merker — für alles, was nicht auf dem UI-Strang läuft:
 * Zurück-Taste, Kartentipp, das Zurücksetzen beim Tab-Wechsel.
 */
let hidden = false;

export function isMapChromeHidden(): boolean {
  return hidden;
}

/** Aus der Wisch-Geste (per `runOnJS`) — die Bewegung selbst läuft dort schon. */
export function markMapChromeHidden(h: boolean): void {
  if (hidden === h) return;
  hidden = h;
  // Der freie Ausschnitt der Karte ändert sich — die Kamera kann nachführen.
  notifyViewportChanged();
}

/**
 * Oberfläche zurückholen — Tipp auf die freie Karte, Zurück-Taste.
 *
 * Gestartet auf dem UI-Strang: Dort liegen Verschiebung und Wege, und ein
 * Lesezugriff aus JS sperrte beide Stränge gegeneinander (siehe
 * `overlayCover.ts`).
 *
 * `animated: false` beim Verlassen des Tabs: Dort sieht es niemand, und die
 * Tab-Leiste muss auf dem nächsten Tab im selben Bild wieder stehen.
 */
export function showMapChrome(animated = true): void {
  const wasHidden = hidden;
  hidden = false;
  if (wasHidden) notifyViewportChanged();
  if (!animated) {
    chromeShift.value = 0;
    return;
  }
  // Stand die Oberfläche nicht auf „versteckt", läuft höchstens noch das
  // Zurückfedern der Geste — das endet von selbst bei 0.
  if (!wasHidden) return;
  runOnUI(() => {
    "worklet";
    settle(0, 0);
  })();
}
