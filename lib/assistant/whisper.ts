import * as FileSystem from "expo-file-system/legacy";
import { initWhisper, type WhisperContext } from "whisper.rn/index";
import { useSearchStore } from "@/stores/searchStore";

/**
 * Spracherkennung IN der App — whisper.cpp auf dem Gerät.
 *
 * # Warum nicht der Erkenner von Android
 *
 * Weil es auf diesem Gerät keinen gibt, der Deutsch kann. Die Messzeile hat es
 * gezeigt: `getSpeechRecognitionServices()` nennt genau einen Dienst,
 * `com.xiaomi.mibrain.speech`. Der ignoriert `EXTRA_LANGUAGE`, erkennt in seiner
 * eigenen Sprache — englisch, egal was gesprochen wurde — und meldet nebenbei
 * Netzfehler. Googles Erkenner ist auf dem Gerät nicht installiert, weder der
 * übers Netz noch der lokale; an der Sichtbarkeit liegt es nicht, die
 * `<queries>`-Freigabe für `android.speech.RecognitionService` steht im
 * Manifest. Dass die Tastatur Deutsch versteht, hilft nicht: Gboard hat einen
 * eigenen, nicht öffentlich ansprechbaren Weg zu Googles Erkennung.
 *
 * Also erkennt die App selbst. Kein Server, keine laufenden Kosten, keine
 * Abhängigkeit davon, was ein Hersteller mitliefert — und auf jedem Gerät
 * dasselbe Ergebnis.
 *
 * # Warum das Format schon passt
 *
 * Whisper will 16 kHz, mono, 16 Bit. Genau das schreibt der Aufnehmer des
 * Sprachmoduls (`ExpoAudioRecorder`), also geht die fertige WAV-Datei ohne
 * Umrechnung hinein.
 *
 * # Warum das Modell geladen und nicht mitgeliefert wird
 *
 * `android/` ist erzeugt und nicht im Git (CNG) — eine Datei unter
 * `app/src/main/assets/` wäre beim nächsten `prebuild` weg. Und 60 MB in jedem
 * Build mitzuschleppen lohnt für eine Funktion nicht, die nicht jeder benutzt.
 * Das Modell liegt deshalb im dauerhaften Bereich der App und wird einmal
 * geladen — danach läuft alles ohne Netz.
 */

/**
 * `base` in 5-Bit-Quantisierung, mehrsprachig.
 *
 * `tiny` (32 MB) versteht Deutsch nur bruchstückhaft, `small` (190 MB) rechnet
 * auf dem Telefon zu lange. `base` ist der Punkt dazwischen: rund 60 MB, und
 * eine Sprachnachricht von zehn Sekunden ist in wenigen Sekunden abgeschrieben.
 *
 * KEIN `.en`-Modell: Die englischen Varianten können ausschließlich Englisch —
 * das wäre genau der Fehler, den wir gerade beheben.
 */
const MODEL_FILE = "ggml-base-q5_1.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
/** Grob die erwartete Größe — zum Erkennen halb geladener Dateien. */
const MODEL_MIN_BYTES = 50_000_000;

function modelPath(): string {
  return `${FileSystem.documentDirectory ?? ""}models/${MODEL_FILE}`;
}

export type ModelState =
  | { status: "missing" }
  | { status: "downloading"; progress: number }
  | { status: "ready" }
  | { status: "error"; message: string };

let downloadPromise: Promise<boolean> | null = null;
/** Wer den Fortschritt sehen will — es kann mehr als einer sein. */
const progressListeners = new Set<(p: number) => void>();

/**
 * Woran es zuletzt lag.
 *
 * „Konnte nicht geladen werden" allein sagt nicht, ob die Datei fehlt, das
 * Laden abbrach oder der native Teil sie nicht annimmt. Der Grund steht
 * vorübergehend mit in der Meldung im Chat — sonst rät man wieder.
 */
let lastIssue = "";
export function lastWhisperIssue(): string {
  return lastIssue;
}
let contextPromise: Promise<WhisperContext | null> | null = null;

/** Liegt das Modell schon vollständig auf dem Gerät? */
export async function isModelReady(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(modelPath());
    if (!info.exists) return false;
    const size = "size" in info ? ((info as { size?: number }).size ?? 0) : 0;
    return size >= MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

/**
 * Modell besorgen. Mehrfach aufrufbar — es läuft immer nur ein Ladevorgang.
 *
 * Geladen wird in eine Nebendatei und erst am Ende umbenannt: Bricht die
 * Verbindung ab, liegt kein halbes Modell unter dem richtigen Namen, das beim
 * nächsten Start als „fertig" durchginge und Whisper zum Absturz brächte.
 */
export async function ensureModel(onProgress?: (p: number) => void): Promise<boolean> {
  /**
   * Die Sperre wird SOFORT gesetzt — vor dem ersten `await`.
   *
   * Hier lag ein Wettlauf, und er traf genau den ersten Start: Der Kasten
   * stößt das Laden an, das Absenden fragt kurz darauf noch einmal nach. Beide
   * warteten zuerst auf `isModelReady()` — und weil in dieser Wartezeit noch
   * keine Sperre stand, kamen beide durch und luden gleichzeitig in DIESELBE
   * Nebendatei. Was dabei herauskommt, ist kein Modell, sondern zwei
   * ineinander geschriebene Hälften; das Ergebnis war „Sprachmodell konnte
   * nicht geladen werden".
   *
   * Weil der Rumpf einer `async`-Funktion bis zum ersten `await` synchron
   * läuft, reicht es, die Sperre als allererstes zu setzen.
   */
  if (onProgress) progressListeners.add(onProgress);
  if (downloadPromise) return downloadPromise;

  downloadPromise = (async () => {
    const target = modelPath();
    const partial = `${target}.part`;
    try {
      if (await isModelReady()) return true;
      await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory ?? ""}models`, {
        intermediates: true,
      });
      await FileSystem.deleteAsync(partial, { idempotent: true });
      const task = FileSystem.createDownloadResumable(MODEL_URL, partial, {}, (p) => {
        if (p.totalBytesExpectedToWrite > 0) {
          const done = p.totalBytesWritten / p.totalBytesExpectedToWrite;
          for (const listener of progressListeners) listener(done);
        }
      });
      const res = await task.downloadAsync();
      if (!res?.uri) {
        lastIssue = "Laden ohne Antwort";
        return false;
      }
      if (res.status && (res.status < 200 || res.status >= 300)) {
        lastIssue = `Laden HTTP ${res.status}`;
        return false;
      }
      const info = await FileSystem.getInfoAsync(partial);
      const size = info.exists && "size" in info ? ((info as { size?: number }).size ?? 0) : 0;
      if (size < MODEL_MIN_BYTES) {
        lastIssue = `abgebrochen bei ${Math.round(size / 1e6)} MB`;
        await FileSystem.deleteAsync(partial, { idempotent: true });
        return false;
      }
      // Erst am Ende umbenennen: Bricht die Verbindung ab, liegt kein halbes
      // Modell unter dem richtigen Namen, das beim nächsten Start als „fertig"
      // durchginge. `idempotent` räumt einen alten Rest vorher weg — ein
      // Umbenennen auf eine bestehende Datei schlägt sonst fehl.
      await FileSystem.deleteAsync(target, { idempotent: true });
      await FileSystem.moveAsync({ from: partial, to: target });
      for (const listener of progressListeners) listener(1);
      return true;
    } catch (err) {
      lastIssue = String((err as Error)?.message ?? err).slice(0, 60);
      await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => undefined);
      return false;
    } finally {
      downloadPromise = null;
      progressListeners.clear();
    }
  })();
  return downloadPromise;
}

/**
 * Das geladene Modell im Speicher — einmal je App-Lauf.
 *
 * Das Aufsetzen kostet spürbar Zeit und Speicher; für jede Sprachnachricht neu
 * wäre beides verschenkt. Deshalb hier gemerkt, samt der laufenden Anfrage:
 * Zwei schnell hintereinander abgeschickte Nachrichten teilen sich dieselbe.
 */
async function getContext(): Promise<WhisperContext | null> {
  if (contextPromise) {
    const cached = await contextPromise;
    /**
     * Ein FEHLSCHLAG wird NICHT gemerkt.
     *
     * Die Anfrage wurde vorher unabhängig vom Ergebnis behalten. Lief sie
     * einmal ins Leere — weil das Modell in dem Moment noch nicht fertig
     * geladen war —, gab jeder weitere Aufruf für den Rest des App-Laufs
     * dasselbe `null` zurück. Für den Nutzer: „Sprachmodell konnte nicht
     * geladen werden", immer wieder, obwohl die Datei längst dalag.
     */
    if (cached) return cached;
    contextPromise = null;
  }
  contextPromise = (async () => {
    try {
      const info = await FileSystem.getInfoAsync(modelPath());
      const size = info.exists && "size" in info ? ((info as { size?: number }).size ?? 0) : 0;
      if (!info.exists) {
        lastIssue = "Datei fehlt";
        return null;
      }
      if (size < MODEL_MIN_BYTES) {
        lastIssue = `nur ${Math.round(size / 1e6)} MB`;
        return null;
      }
      const ctx = await initWhisper({ filePath: modelPath() });
      lastIssue = "";
      return ctx;
    } catch (err) {
      lastIssue = String((err as Error)?.message ?? err).slice(0, 60);
      return null;
    }
  })();
  return contextPromise;
}

/**
 * Das Modell wieder aus dem Speicher nehmen.
 *
 * Es belegt neben der Datei selbst noch einmal ein Vielfaches an Arbeits-
 * speicher. Auf einem Telefon, das nebenbei Karten und Bilder hält, ist das
 * genug, um vom System abgeräumt zu werden — und das sieht für den Nutzer aus
 * wie ein Absturz: Die App ist einfach zu. Also wieder loslassen, sobald der
 * Assistenten-Screen verlassen wird; das nächste Mal wird neu geladen (rund
 * eine Sekunde), und das ist der bessere Tausch.
 */
export async function releaseWhisper(): Promise<void> {
  const pending = contextPromise;
  contextPromise = null;
  if (!pending) return;
  try {
    /**
     * ERST das Ende einer laufenden Abschrift abwarten.
     *
     * Sonst gibt das Freigeben den nativen Zustand frei, auf dem gerade
     * gerechnet wird — und das ist kein Fehlerwert, sondern ein Absturz im
     * nativen Teil. Der Fall ist real: Wer direkt nach dem Absenden den Tab
     * wechselt, löst genau diese Reihenfolge aus.
     *
     * `queue` ist dieselbe Warteschlange, in der sich auch die Abschriften
     * anstellen (siehe dort).
     */
    await queue.catch(() => undefined);
    const ctx = await pending;
    await ctx?.release();
  } catch {
    // Schon weg oder nie da — beides in Ordnung.
  }
}

/**
 * Nur EINE Abschrift gleichzeitig.
 *
 * whisper.cpp rechnet auf einem gemeinsamen Zustand; zwei Läufe darauf sind
 * kein langsamer Lauf, sondern ein Absturz im nativen Teil. Zwei schnell
 * hintereinander abgeschickte Sprachnachrichten reichen dafür aus.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Ist das überhaupt eine brauchbare Aufnahme?
 *
 * Der native Teil ist beim Lesen nicht zimperlich: Eine abgeschnittene oder
 * leere WAV-Datei bricht dort ab, und ein Abbruch im nativen Teil nimmt die
 * ganze App mit — den kann kein `try` auffangen. Also vorher nachsehen.
 *
 * Geprüft wird der Kopf (RIFF/WAVE) und ob überhaupt Ton dahinter steht: 16 kHz
 * mono 16 Bit sind 32000 Byte je Sekunde, ein Drittel davon ist die Grenze.
 */
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Die ersten Byte eines base64-Blocks zurückholen — mehr braucht der Kopf nicht. */
function decodeBase64Head(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 3 < clean.length; i += 4) {
    const a = B64_CHARS.indexOf(clean[i]);
    const b = B64_CHARS.indexOf(clean[i + 1]);
    const c = B64_CHARS.indexOf(clean[i + 2]);
    const d = B64_CHARS.indexOf(clean[i + 3]);
    out.push((a << 2) | (b >> 4), ((b & 15) << 4) | (c >> 2), ((c & 3) << 6) | d);
    if (out.length >= 12) break;
  }
  return new Uint8Array(out);
}

async function looksPlayable(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return false;
    const size = "size" in info ? ((info as { size?: number }).size ?? 0) : 0;
    if (size < 44 + 10000) return false;
    const head = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 12,
    });
    /**
     * Erst DEKODIEREN, dann vergleichen.
     *
     * Hier stand vorher ein Vergleich auf base64-Schnipsel: „fängt mit UklGR an
     * und enthält V0FWRQ". Der erste Teil stimmt, der zweite kann NIE stimmen —
     * base64 verschlüsselt je drei Byte zu vier Zeichen, und „WAVE" beginnt im
     * Kopf bei Byte 8, also mitten in einer Dreiergruppe. Es wird zu „QVZF" mit
     * anderem Anfang, nicht zu „V0FWRQ" (das wäre „WAVE" für sich allein).
     *
     * Ergebnis: JEDE Aufnahme fiel durch und kam als „kein Wort verstanden"
     * zurück, obwohl sie einwandfrei war.
     */
    const bytes = decodeBase64Head(head);
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...Array.from(bytes.slice(from, to)));
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  } catch {
    return false;
  }
}

/**
 * Was Whisper bei Stille gerne erfindet.
 *
 * Das Modell ist auf Untertiteln trainiert und füllt tonlose Stellen mit deren
 * Abspann — „Untertitel von …", „Thank you." Eine Sprachnachricht, in der
 * niemand spricht, ergäbe damit einen Satz, den Bo ernst nimmt.
 */
const HALLUCINATIONS = [
  /untertitel/i,
  /amara\.org/i,
  /^\s*thank you[.!]?\s*$/i,
  /^\s*thanks for watching/i,
  /^\s*you\s*$/i,
  /^\s*bye[.!]?\s*$/i,
  /^\s*\[.*\]\s*$/,
  /^\s*\(.*\)\s*$/,
  /abonniert|untertitelung/i,
];

/**
 * Der Anlauf-Hinweis darf nicht in der Antwort landen.
 *
 * Whisper behandelt ihn wie zuvor Gesprochenes — und gibt ihn bei stillen
 * Stellen manchmal mit aus. Was mit unserem eigenen Wortschatz beginnt, ist
 * kein Gesagtes.
 */
const PROMPT_ECHO = /^(Reiseauskunft|Travel search|Recherche de voyage|Búsqueda de viajes)\b.*?[.:]\s*/i;

/**
 * Zusammengesetzte Bahn-Wörter wieder zusammensetzen.
 *
 * Das Modell trennt sie gern, weil beide Hälften für sich häufiger sind als das
 * Ganze: „Haupt Bahnhof", „Flug Hafen". Für uns ist das kein Schönheitsfehler —
 * der Server sucht damit nach einer Station, die es nicht gibt.
 */
function joinCompounds(text: string): string {
  return text
    .replace(/\b(Haupt|Ost|West|Süd|Nord|Zentral)[ -](b)ahnhof\b/gi, (_m, a: string) => `${a}bahnhof`)
    .replace(/\bFlug[ -]hafen\b/gi, "Flughafen")
    .replace(/\bH\.?\s?B\.?\s?F\.?\b/g, "Hbf");
}

function clean(text: string): string {
  const t = joinCompounds(text.replace(PROMPT_ECHO, "").replace(/\s+/g, " ")).trim();
  if (!t) return "";
  if (HALLUCINATIONS.some((re) => re.test(t))) return "";
  return t;
}

/**
 * Wortschatz, mit dem Whisper in den Text hineingeht.
 *
 * whisper.cpp nimmt einen „initial prompt" — Text, der so behandelt wird, als
 * wäre er unmittelbar vorher gesprochen worden. Das Modell erwartet danach
 * Ähnliches, und genau daran hängt die Erkennung von EIGENNAMEN: „Hauptbahnhof"
 * ist für ein allgemeines Modell ein seltenes Wort und wird gern zu „Haupt
 * Bahnhof", „Hauptbahn Hof" oder etwas ganz anderem; steht es im Hinweis, trifft
 * es zuverlässig.
 *
 * Bewusst kurz und aus DIESER Welt: Fahrkarten-Wortschatz plus die größten
 * Städte. Ein langer Hinweis kostet Rechenzeit und wird bei stillen Stellen
 * gerne selbst mit ausgegeben.
 */
const VOCAB: Record<string, string> = {
  de: "Reiseauskunft: Hauptbahnhof, Flughafen, Bahnhof, Gleis, Abfahrt, Ankunft, ICE, Regionalbahn, Fernbus. Berlin, Hamburg, München, Köln, Frankfurt, Stuttgart, Düsseldorf, Leipzig, Zürich, Wien.",
  en: "Travel search: main station, central station, airport, platform, departure, arrival, train, coach. London, Paris, Berlin, Amsterdam, Barcelona, Rome, Vienna, Zurich, Munich, Cologne.",
  fr: "Recherche de voyage : gare centrale, aéroport, quai, départ, arrivée, TGV, train, autocar. Paris, Lyon, Marseille, Bordeaux, Lille, Strasbourg, Bruxelles, Genève, Berlin, Londres.",
  es: "Búsqueda de viajes: estación central, aeropuerto, andén, salida, llegada, tren, autobús. Madrid, Barcelona, Valencia, Sevilla, Bilbao, Málaga, Lisboa, París, Berlín, Roma.",
};

/**
 * Und die Orte, um die es DIESEM Nutzer geht.
 *
 * Die zuletzt gesuchten Namen sind der beste Hinweis, den wir haben: Wer
 * gestern „Düsseldorf Hbf" gesucht hat, sagt es morgen wieder. Sie stehen im
 * Speicher ohnehin — sie kosten nichts und treffen genauer als jede Liste, die
 * ich hier hineinschreiben könnte.
 */
function personalVocab(): string {
  try {
    const { recentSearches, recentSpots } = useSearchStore.getState();
    const labels = new Set<string>();
    for (const r of recentSearches) {
      labels.add(r.origin.label);
      labels.add(r.destination.label);
    }
    for (const spot of recentSpots) labels.add(spot);
    const list = [...labels].filter(Boolean).slice(0, 12);
    return list.length ? ` ${list.join(", ")}.` : "";
  } catch {
    return "";
  }
}

export interface TranscribeOutcome {
  /** Der erkannte Text — leer, wenn nichts Brauchbares dabei war. */
  text: string;
  /** Welche Sprache Whisper gehört hat (ISO, z.B. „de"). */
  lang: string;
  /** Warum nichts herauskam — für die Meldung im Chat. */
  reason?: "no-model" | "failed" | "empty";
}

/**
 * Eine Aufnahme abschreiben.
 *
 * `appLang` ist die im Einstellungs-Screen gewählte Sprache. Sie ist die
 * VORGABE, nicht die Vorschrift:
 *
 *  - Bei sehr kurzen Aufnahmen wird sie fest gesetzt. Whispers Spracherkennung
 *    braucht ein paar Sekunden Material; bei einem einzelnen Wort rät sie, und
 *    ein falsch geratenes „nl" macht aus „Ja, gerne" Unsinn.
 *  - Sonst darf Whisper selbst hören, welche Sprache gesprochen wurde. Wer die
 *    App auf Deutsch stehen hat und einen englischen Ortsnamen diktiert oder
 *    mitten im Satz wechselt, bekommt trotzdem, was er gesagt hat.
 *
 * `translate` bleibt AUS. Das ist Whispers Schalter „alles nach Englisch" — also
 * genau das Verhalten, das hier gerade nicht gewollt ist.
 */
export async function transcribeVoice(
  fileUri: string,
  appLang: string,
  durationSec: number,
): Promise<TranscribeOutcome> {
  const base = (appLang || "en").split("-")[0].toLowerCase();
  if (!(await looksPlayable(fileUri))) return { text: "", lang: base, reason: "empty" };
  const ctx = await getContext();
  if (!ctx) return { text: "", lang: base, reason: "no-model" };
  // Anstellen, statt gleichzeitig zu rechnen (siehe `queue`).
  const mine = queue.then(() => undefined).catch(() => undefined);
  let release: () => void = () => undefined;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mine;
  try {
    const { promise } = ctx.transcribe(fileUri, {
      language: durationSec < 2 ? base : "auto",
      translate: false,
      // Vier Stränge: Auf Telefonen mit acht Kernen sind das die schnellen, und
      // mehr bringt bei diesem Modell nichts mehr.
      maxThreads: 4,
      tokenTimestamps: false,
      // Siehe `VOCAB`: Fach-Wortschatz plus die zuletzt gesuchten Orte.
      prompt: `${VOCAB[base] ?? VOCAB.en}${personalVocab()}`,
      /**
       * Mehrere Deutungen verfolgen statt Wort für Wort die erstbeste nehmen.
       *
       * Genau da fallen Eigennamen sonst durch: „Hauptbahnhof" beginnt für das
       * Modell wie „Haupt", und mit gieriger Suche steht diese Entscheidung
       * fest, bevor die zweite Hälfte gehört ist. Mit drei parallelen Pfaden
       * gewinnt die Deutung, die am Ende als GANZES besser passt.
       *
       * Drei statt der üblichen fünf: Es ist der Punkt, an dem die Kurve für
       * kurze Sätze flach wird — fünf kosten spürbar mehr Zeit auf dem Telefon,
       * ohne dass an Ortsnamen noch etwas besser wird.
       */
      beamSize: 3,
      temperature: 0,
    });
    const res = await promise;
    const text = clean(res?.result ?? "");
    return {
      text,
      lang: (res?.language || base).toLowerCase(),
      ...(text ? {} : { reason: "empty" as const }),
    };
  } catch {
    return { text: "", lang: base, reason: "failed" };
  } finally {
    release();
  }
}
