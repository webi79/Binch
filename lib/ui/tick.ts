/**
 * Der Tick des Zahlenrades — ein leiser Klick und ein sehr kurzer Stups.
 *
 * Beides zusammen in EINER Funktion, und zwar aus einem Grund: Sie teilen sich
 * die Sperre. Ein Rad läuft im Auslaufen mit über zwanzig Zahlen je Sekunde
 * durch; getrennt gedrosselt gerieten Ton und Vibration gegeneinander aus dem
 * Takt, und aus dem Klicken würde ein Rauschen.
 *
 * Der Ton ist Androids EIGENER Klick (`Effect_Tick` aus dem AOSP, Apache-2.0 —
 * Herkunft und Bearbeitung stehen in `assets/sounds/README.md`). Es ist derselbe
 * Klang, den `NumberPicker` und `TimePicker` beim Drehen spielen.
 *
 * Vorher stand hier ein selbst erzeugter: eine gedämpfte Sinuswelle, deren
 * Tonhöhe von 2100 auf 1500 Hz fiel. Genau das war der Fehler — eine fallende
 * Tonhöhe auf einem schmalen Ton IST die Signatur einer Laserpistole. Ein
 * Anschlag klingt anders: breitbandig, sehr kurz, ohne wandernde Tonhöhe. Das
 * ist nichts, was man aus Formeln errät; dafür nimmt man einen echten.
 *
 * Der Stups ist Androids EIGENER Uhren-Tick (`Clock_Tick`) — dieselbe Rückmeldung,
 * die das System für die Stunden- und Minutenauswahl seiner Uhr benutzt. Damit
 * ist er so leicht, wie das Gerät ihn kann, und nicht so leicht, wie wir eine
 * Dauer in Millisekunden geraten hätten.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { haptic } from "@/lib/haptics";

const SOURCE = require("../../assets/sounds/tick.wav");

/**
 * Drei Abspieler im Wechsel.
 *
 * Einer allein müsste vor jedem Klick zurückspulen, und das Zurückspulen ist
 * eine Zusage, die erst später eingelöst wird — bei zwanzig Klicks je Sekunde
 * verschluckt es die Hälfte. Im Wechsel hat jeder rund eine Zehntelsekunde Ruhe,
 * bei 18ms Ton also reichlich.
 */
const VOICES = 3;
/** Kürzester Abstand zwischen zwei Ticks. Darüber wird aus dem Klicken ein Surren. */
const MIN_GAP_MS = 35;
/** Unter dem Daumen, nicht im Raum. */
const VOLUME = 0.5;

let pool: AudioPlayer[] | null = null;
let next = 0;
let last = 0;

/**
 * Abspieler anlegen — bewusst NICHT beim Aufbau des Blattes.
 *
 * Ein Abspieler ist auf Android ein echter Decoder; drei davon im selben
 * Durchgang wie die Einfahrt wären genau die Art Arbeit, die dort nicht
 * hingehört. Angelegt wird deshalb erst, wenn das Blatt steht — oder wenn ein
 * Finger das Rad berührt, je nachdem, was zuerst kommt.
 */
export function primeTick(): void {
  if (pool) return;
  /**
   * OHNE Audio-Fokus abspielen — sonst pausiert jeder Klick die Musik.
   *
   * Steht in `AudioModule.kt` von expo-audio: Ohne gesetzten Modus fordert das
   * Abspielen `AUDIOFOCUS_GAIN_TRANSIENT` an, und das hält fremde Wiedergabe
   * an. Bei einem Klick je gescrollter Zahl hieße das: Wer beim Suchen Musik
   * hört, dem stottert sie im Takt des Rades. `mixWithOthers` fordert auf
   * Android gar keinen Fokus an — genau dafür ist der Modus da („Best suited
   * for sound effects, UI feedback").
   *
   * Der Modus gilt für die ganze App, deshalb wird er beim Abbau wieder
   * zurückgestellt: Eine Sprachnachricht in Bo SOLL die Musik weiterhin
   * anhalten.
   */
  setAudioModeAsync({ interruptionMode: "mixWithOthers" }).catch(() => undefined);
  try {
    pool = Array.from({ length: VOICES }, () => {
      const p = createAudioPlayer(SOURCE);
      p.volume = VOLUME;
      return p;
    });
  } catch {
    // Kein Ton ist kein Grund, das Rad anzuhalten.
    pool = null;
  }
}

/** Beim Abbau des Blattes: Die Decoder gehören nicht der ganzen Sitzung. */
export function releaseTick(): void {
  const old = pool;
  pool = null;
  next = 0;
  if (!old) return;
  // Zurück auf das Verhalten der App vor dem Rad: Wiedergabe holt sich den
  // Fokus. (`doNotMix` ist genau das, was ohne gesetzten Modus passiert.)
  setAudioModeAsync({ interruptionMode: "doNotMix" }).catch(() => undefined);
  for (const p of old) {
    try {
      p.remove();
    } catch {
      // Schon weg — dann ist ja gut.
    }
  }
}

/**
 * Eine Zahl weiter. Läuft auf dem JS-Strang, angestoßen aus dem Worklet des
 * Rades — die Bewegung selbst bleibt davon unberührt.
 */
export function wheelTick(): void {
  const now = Date.now();
  if (now - last < MIN_GAP_MS) return;
  last = now;

  // Prüft selbst, ob der Nutzer Haptik überhaupt möchte.
  haptic("tick");

  if (!pool) primeTick();
  const players = pool;
  if (!players) return;
  const p = players[next % players.length]!;
  next = (next + 1) % players.length;
  try {
    void p.seekTo(0);
    p.play();
  } catch {
    // Ein verschluckter Klick ist harmlos.
  }
}
