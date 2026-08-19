/**
 * Chat-Streaming-Client für den Bo-Travel-Agent.
 *
 * Implementierung via XMLHttpRequest (NICHT fetch): React Native's fetch
 * gibt `response.body` als `null` zurück, ReadableStream wird auf Android
 * nicht supportet. XHR mit `onprogress`-Events ist der Standard-Weg für
 * SSE in React Native — wir lesen `xhr.responseText` inkrementell und
 * parsen die neuen Frames seit dem letzten Progress-Event.
 *
 * AbortController: XHR hat `abort()` direkt; wir bridgen den AbortSignal
 * darauf.
 */
import { API_BASE_URL, type StopBoardResponse } from "./client";
import type { SearchResult } from "@/types/search";

export type ChatMood = "idle" | "waving" | "thinking" | "talking" | "happy" | "error";

export interface ChatMessageWire {
  role: "user" | "assistant";
  content: string;
}

export interface LastSearchParams {
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  mode: "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
  departDate: string;
  passengers: number;
  currency: string;
}

export interface StopBoardHint {
  stop: { code: string; label: string };
  board: "departures" | "arrivals";
}

export type ChatStreamEvent =
  | { type: "mood"; mood: ChatMood }
  | { type: "text"; delta: string }
  | { type: "tool_use"; name: string }
  | {
      type: "search_result";
      result: SearchResult;
      params: LastSearchParams;
      /** Bei mehrteiligen Reisen: das Bein, auf das sich „speichern"/„alle
       *  Treffer" beziehen. Fehlt bei einer einfachen Suche. */
      isMain?: boolean;
    }
  | {
      type: "stop_board";
      stop: { code: string; label: string };
      board: "departures" | "arrivals";
      /** Bereits vom Server geladene Tafel — spart die eigene Abfrage. */
      data?: StopBoardResponse;
    }
  | {
      type: "action";
      action: "save_trip" | "unsave_trip" | "open_results";
      payload?: Record<string, unknown>;
    }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "error"; message: string }
  | { type: "done" };

export interface ChatStreamRequest {
  history: ChatMessageWire[];
  locale: "en" | "de" | "fr" | "es";
  currency: string;
  today: string;
  /** Letzte Such-Params aus einem früheren Turn. Server seedet damit den
   *  Turn-State, sodass Tools wie open_all_results über Turns hinweg
   *  funktionieren. */
  lastSearch?: LastSearchParams;
  /** Session-Token — Bo ist kontogebunden (Server antwortet 401 ohne). */
  authToken?: string | null;
  signal?: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

/** Error mit HTTP-Status — Caller unterscheidet damit 401 (Login nötig)
 *  und 429 (Konto-Rate-Limit) von generischen Fehlern. */
export class ChatApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

/** Heutiges Datum als yyyy-MM-dd in der lokalen TZ des Devices. */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Öffnet einen Stream gegen /api/chat/stream und ruft `onEvent` für jeden
 * empfangenen SSE-Frame auf. Promise resolved wenn der Server die Connection
 * schließt (oder per AbortSignal cancelled wird). Wirft bei HTTP-Fehler.
 */
export async function streamChat(req: ChatStreamRequest): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE_URL}/api/chat/stream`);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    if (req.authToken) xhr.setRequestHeader("Authorization", `Bearer ${req.authToken}`);

    // SSE-Frame-Parsing: wir tracken den Offset bis zum letzten geparsten
    // Frame. Bei jedem progress-Event lesen wir nur den neuen Suffix von
    // responseText und framen daraus die kompletten `data:`-Blöcke.
    let parsedTo = 0;
    let buffer = "";

    const parseChunk = (chunk: string) => {
      buffer += chunk;
      // Frames sind durch leere Zeile (`\n\n`) getrennt. Letzten unvoll-
      // ständigen Rest im Buffer behalten.
      let frameEnd: number;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);

        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());

        if (dataLines.length === 0) continue; // Heartbeat-Comment-Lines
        try {
          const event = JSON.parse(dataLines.join("\n")) as ChatStreamEvent;
          req.onEvent(event);
        } catch {
          // Malformed-Frame — skip, nicht abort'en.
        }
      }
    };

    xhr.onreadystatechange = () => {
      // readyState 3 = LOADING (Daten kommen rein), 4 = DONE.
      if (xhr.readyState >= 3) {
        // Es kommt etwas an — die Stillstands-Frist beginnt von vorn.
        touch();
        if (xhr.status !== 0 && xhr.status !== 200 && xhr.readyState === 4) {
          stopIdle();
          // HTTP-Fehler — Server hat einen Status != 200 geantwortet.
          reject(
            new ChatApiError(
              `Chat API ${xhr.status}${xhr.statusText ? ` ${xhr.statusText}` : ""}${
                xhr.responseText ? `: ${xhr.responseText.slice(0, 200)}` : ""
              }`,
              xhr.status,
            ),
          );
          return;
        }

        // Inkrementell die neuen Bytes seit dem letzten Progress lesen.
        const text = xhr.responseText;
        if (text.length > parsedTo) {
          const chunk = text.slice(parsedTo);
          parsedTo = text.length;
          parseChunk(chunk);
        }

        if (xhr.readyState === 4) {
          stopIdle();
          resolve();
        }
      }
    };

    xhr.onerror = () => {
      stopIdle();
      reject(new Error("Chat API network error — server unreachable?"));
    };

    /**
     * Eine Frist — ohne die feuert der Rückruf darunter NIE.
     *
     * `ontimeout` stand hier von Anfang an, `xhr.timeout` aber nicht. Ohne
     * gesetzten Wert hat ein XHR gar keine Frist: Hängt die Verbindung, wird
     * dieses Versprechen weder erfüllt noch abgelehnt. Es bleibt für immer
     * offen.
     *
     * Auf der Aufrufseite hängt daran der `finally`-Block, der die Sende-Sperre
     * löst. Blieb das Versprechen offen, blieb die Sperre stehen — und ab da
     * verwarf der Chat jedes weitere Absenden stillschweigend. Genau das Bild:
     * „ich schreibe hallo, es kommt nichts mehr, er ist stuck."
     *
     * 60 Sekunden sind großzügig: Der Server antwortet im Protokoll zwischen
     * anderthalb und sechzehn Sekunden, auch mit Flugsuche. Wer darüber liegt,
     * hängt.
     */
    /**
     * Gemessen wird STILLSTAND, nicht die Gesamtdauer.
     *
     * `xhr.timeout` deckelt die gesamte Anfrage. Genau das ist hier falsch: Eine
     * mehrteilige Reise läuft über bis zu drei aufeinanderfolgende Suchen mit je
     * 15 Sekunden Deckel, dazwischen die Antworten des Modells. Ein Zug, der
     * fleißig Text liefert, wurde damit nach einer Minute mittendrin abgebrochen
     * und als allgemeiner Fehler angezeigt.
     *
     * Der Zweck war ein anderer: Ein Zug, der HÄNGT, darf die Sperre nicht für
     * immer halten (sonst nimmt der Chat nichts mehr an). Dagegen hilft eine
     * Frist ohne Fortschritt — sie greift genauso schnell beim echten Hänger und
     * gar nicht bei einer langen, aber lebendigen Antwort.
     */
    const IDLE_TIMEOUT_MS = 60_000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const failIdle = () => {
      idleTimer = null;
      xhr.abort();
      reject(new Error("Chat API timeout"));
    };
    const touch = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(failIdle, IDLE_TIMEOUT_MS);
    };
    const stopIdle = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    touch();

    // AbortSignal-Bridge — wenn der Caller abbricht, XHR abort.
    // ‼️ React Native hat KEIN globales DOMException — die JS-Engine wirft
    // ReferenceError beim Aufruf von `new DOMException(...)`. Wir nutzen
    // eine reguläre Error mit name="AbortError"; die Caller-Logik prüft
    // `err.name === "AbortError"` und behandelt's gleich.
    const makeAbortError = () => {
      const e = new Error("Aborted");
      e.name = "AbortError";
      return e;
    };
    if (req.signal) {
      if (req.signal.aborted) {
        stopIdle();
        xhr.abort();
        reject(makeAbortError());
        return;
      }
      req.signal.addEventListener("abort", () => {
        // Die Frist mit abräumen — sonst feuert sie nach dem Abbruch noch
        // einmal und lehnt ein bereits abgeschlossenes Versprechen ab.
        stopIdle();
        xhr.abort();
        reject(makeAbortError());
      });
    }

    xhr.send(
      JSON.stringify({
        history: req.history,
        locale: req.locale,
        currency: req.currency,
        today: req.today,
        ...(req.lastSearch ? { lastSearch: req.lastSearch } : {}),
      }),
    );
  });
}
