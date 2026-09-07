/**
 * Der Tick des Zahlenrades — ein leiser Klick und ein sehr kurzer Stups.
 *
 * Beides zusammen in EINER Funktion, und zwar aus einem Grund: Sie teilen sich
 * die Sperre. Ein Rad läuft im Auslaufen mit über zwanzig Zahlen je Sekunde
 * durch; getrennt gedrosselt gerieten Ton und Vibration gegeneinander aus dem
 * Takt.
 *
 * ── Warum der Klang NICHT über `expo-audio` läuft ──────────────────────────
 *
 * Er lief es, und er kam verzögert oder gar nicht. Der Grund steht in dessen
 * Quelle: Auf Android fährt `expo-audio` einen ExoPlayer, also einen
 * Media-Player für Streams. Sein `play()` reicht über den Haupt-Looper zum
 * Player, der Ton beginnt erst, wenn die Ausgabe angelaufen ist. Und ein
 * Media-Player ENDET nach dem Stück — jeder weitere Klick braucht erst ein
 * Zurückspulen, das als Zusage später eingelöst wird. Beide Male ist die
 * Verzögerung nicht die Datei, sondern das Werkzeug.
 *
 * Androids Werkzeug für kurze Bedien-Klänge heißt `SoundPool`: Der Klang liegt
 * entpackt im Speicher, `play()` startet ihn sofort, Überlagerungen sind
 * eingeplant, und Audio-Fokus fordert es gar nicht erst an (fremde Musik läuft
 * also unbehelligt weiter). Das steckt im lokalen Modul `modules/tick-sound`.
 *
 * `expo-audio` bleibt als Rückfall für iOS und für einen Dev-Client ohne
 * frischen Build — dort mit derselben Verzögerung wie zuvor, aber hörbar.
 *
 * ── Zum Klang selbst ───────────────────────────────────────────────────────
 *
 * Herkunft und Bearbeitung stehen in `assets/sounds/README.md`. Zwei Dinge
 * daran sind nicht offensichtlich:
 *
 *  - Der ZUSCHNITT. In der Vorlage standen 134 ms Stille vor dem Anschlag, und
 *    die spielt jeder Abspieler brav mit ab.
 *  - Er bleibt STEREO. Die beiden Kanäle der Aufnahme sind kaum verwandt
 *    (Korrelation +0,25); die Mono-Summe löschte 38% der Energie aus und machte
 *    aus dem Anschlag einen hohlen Klang.
 *
 * Der Stups ist Androids EIGENER Uhren-Tick (`Clock_Tick`) — dieselbe
 * Rückmeldung, die das System für die Stunden- und Minutenauswahl seiner Uhr
 * benutzt. Damit ist er so leicht, wie das Gerät ihn kann, und nicht so leicht,
 * wie wir eine Dauer in Millisekunden geraten hätten.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { tickSound } from "@/modules/tick-sound";
import { haptic } from "@/lib/haptics";

const SOURCE = require("../../assets/sounds/tick.wav");

/**
 * Kürzester Abstand zwischen zwei Klicks — und er muss LÄNGER sein als der
 * Klang selbst (52ms).
 *
 * Bei 35ms lagen zwei Klicks 23ms übereinander. Zwei Kopien desselben Anschlags,
 * leicht versetzt gemischt, löschen sich in Teilen des Spektrums aus und
 * verstärken sich in anderen — das ist ein Kammfilter, und genau danach klingt
 * es: nach seltsamem Klackern statt nach einzelnen Anschlägen. Mit 60ms liegt
 * zwischen zwei Klicks immer etwas Luft.
 *
 * Kostet an schnellen Stellen einzelne Ticks (höchstens 16 je Sekunde) — die
 * fallen nicht auf, ein verschmierter Anschlag schon.
 */
const MIN_GAP_MS = 60;
/** Unter dem Daumen, nicht im Raum. */
const VOLUME = 0.25;

let last = 0;

/* -------------------------------------------------- Rückfall: `expo-audio` */

/** Vier Abspieler im Wechsel — siehe `playFallback`. */
const VOICES = 4;
/** Erst deutlich NACH dem Klang zurückspulen, sonst schneidet es ihn ab. */
const REARM_MS = 260;

let pool: AudioPlayer[] | null = null;
let next = 0;

function primeFallback(): void {
  if (pool) return;
  /**
   * OHNE Audio-Fokus abspielen — sonst pausiert jeder Klick die Musik.
   *
   * Steht in `AudioModule.kt` von expo-audio: Ohne gesetzten Modus fordert das
   * Abspielen `AUDIOFOCUS_GAIN_TRANSIENT` an, und das hält fremde Wiedergabe
   * an. `mixWithOthers` fordert auf Android gar keinen Fokus an. Nur für diesen
   * Weg nötig — `SoundPool` fragt nie nach Fokus.
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

/**
 * Abspielen und danach zurückspulen — nicht davor.
 *
 * Ein Media-Player steht nach dem Klang am Ende und spielt ohne Zurückspulen
 * nicht wieder an. Läge das Zurückspulen VOR dem Abspielen, käme der Klang
 * verspätet; liegt es zu kurz danach, schneidet es ihn ab — der Anlauf des
 * Players kann länger dauern als der 52ms-Klang selbst. Deshalb 260ms, und vier
 * Abspieler, damit trotzdem keiner drankommt, bevor er wieder bereit ist.
 */
function playFallback(): void {
  if (!pool) primeFallback();
  const players = pool;
  if (!players) return;
  const p = players[next % players.length]!;
  next = (next + 1) % players.length;
  try {
    p.play();
    setTimeout(() => {
      try {
        p.pause();
        void p.seekTo(0);
      } catch {
        // Abspieler schon abgeräumt (Blatt zu) — dann ist ja gut.
      }
    }, REARM_MS);
  } catch {
    // Ein verschluckter Klick ist harmlos.
  }
}

function releaseFallback(): void {
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

/* -------------------------------------------------------------- Öffentlich */

/**
 * Klang bereitlegen — bewusst NICHT im Durchgang, der das Blatt öffnet.
 *
 * Entpacken und Laden gehören nicht neben die Einfahrt. Aufgerufen wird das,
 * wenn das Blatt steht — oder beim Aufsetzen des Fingers, je nachdem, was
 * zuerst kommt.
 */
export function primeTick(): void {
  if (tickSound) {
    tickSound.prime();
    return;
  }
  primeFallback();
}

/** Beim Abbau des Blattes: Der Klang gehört nicht der ganzen Sitzung. */
export function releaseTick(): void {
  if (tickSound) {
    tickSound.release();
    return;
  }
  releaseFallback();
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

  if (tickSound) {
    tickSound.play(VOLUME);
    return;
  }
  playFallback();
}
