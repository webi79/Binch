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
import { API_BASE_URL } from "./client";
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
  | { type: "search_result"; result: SearchResult; params: LastSearchParams }
  | { type: "stop_board"; stop: { code: string; label: string }; board: "departures" | "arrivals" }
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
        if (xhr.status !== 0 && xhr.status !== 200 && xhr.readyState === 4) {
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
          resolve();
        }
      }
    };

    xhr.onerror = () => {
      reject(new Error("Chat API network error — server unreachable?"));
    };

    xhr.ontimeout = () => {
      reject(new Error("Chat API timeout"));
    };

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
        xhr.abort();
        reject(makeAbortError());
        return;
      }
      req.signal.addEventListener("abort", () => {
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
