/**
 * Die gespeicherten Unterhaltungen mit Bo — Liste, Verlauf, Umbenennen, Löschen.
 *
 * Getrennt von `chat.ts`, obwohl beide dasselbe Thema haben: Dort läuft der
 * STROM (XHR, SSE, Stimmungen, Werkzeug-Ereignisse), hier stehen gewöhnliche
 * JSON-Aufrufe. Die beiden haben außer dem Wort „Chat" nichts gemeinsam — eine
 * Datei daraus zu machen hieße, den 200-Zeilen-Parser neben vier Einzeilern zu
 * halten.
 *
 * Alles hier ist kontogebunden: Ohne gültiges Zeichen antwortet der Server mit
 * 401, und das ist KEIN Fehler im Sinne der Oberfläche — siehe `ChatAuthError`.
 */
import { API_BASE_URL } from "./client";
import { loadAuthToken } from "@/lib/auth/tokenStorage";
import { useSearchStore } from "@/stores/searchStore";

export interface ChatThreadSummary {
  id: string;
  /** Der Server vergibt ihn erst, wenn der erste Austausch durch ist. */
  title: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string;
  messageCount: number;
  /**
   * Angeheftet / archiviert — Zeitpunkt statt Ja-Nein.
   *
   * Angeheftete stehen in der Liste oben (der Server sortiert, nicht der
   * Client), archivierte kommen standardmäßig gar nicht erst mit.
   */
  pinnedAt: string | null;
  archivedAt: string | null;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant";
  /**
   * Was in der Blase steckt. `text` trägt `content`, alles andere `payload` —
   * ein Suchergebnis, eine Abfahrtstafel, eine ausgeführte Aktion.
   */
  kind: "text" | "result" | "board" | "action";
  content: string | null;
  payload: Record<string, unknown> | null;
  /** Laufende Nummer INNERHALB der Unterhaltung — der Anker fürs Nachladen. */
  seq: number;
  createdAt: string;
}

export interface ChatThreadDetail {
  conversation: ChatThreadSummary & { lastSearch?: Record<string, unknown> | null };
  messages: ChatMessageRow[];
  hasMore: boolean;
}

/**
 * Die Schlüssel liegen HIER, nicht bei den Komponenten.
 *
 * Die Liste wird an mindestens drei Stellen angefasst: die Schublade zeigt sie,
 * „Neuer Chat" schiebt oben etwas ein, das Löschen nimmt etwas heraus. Als
 * Zeichenkette an jeder dieser Stellen getippt, geht genau ein Tippfehler lange
 * unbemerkt durch — der Schreibvorgang landet dann in einem zweiten,
 * unbeobachteten Eintrag und die Liste ändert sich einfach nicht.
 */
/**
 * Eine Seite der Chat-Liste.
 *
 * Sie steht beim Datenzugriff und nicht in der Schublade, weil sie zwei Seiten
 * betrifft: Die Schublade lädt damit, und der Bo-Bildschirm holt dieselbe erste
 * Seite vorab. Zwei verschiedene Zahlen wären zwei verschiedene Antworten unter
 * demselben Schlüssel — der Vorabruf wäre dann wertlos, weil die Schublade ihn
 * sofort überschreibt.
 */
export const CHAT_THREADS_PAGE_SIZE = 20;

export const chatThreadsKey = ["chatThreads"] as const;
/**
 * Der Schlüssel EINES Kontos.
 *
 * Die Liste gehört dem angemeldeten Nutzer, also gehört er in den Schlüssel.
 * Ohne ihn überlebt sie einen Kontowechsel im Zwischenspeicher und zeigt die
 * Unterhaltungen des vorigen Kontos weiter.
 *
 * `chatThreadsKey` bleibt das Präfix: Ein `invalidateQueries` darauf trifft
 * jeden Konto-Eintrag, ohne dass der Aufrufer die Kennung kennen muss.
 */
export function chatThreadsKeyFor(userId: string | null) {
  return [...chatThreadsKey, userId ?? "anon"] as const;
}
export const chatThreadKey = (id: string) => ["chatThread", id] as const;

/**
 * 401 als eigener Typ — damit die Oberfläche „Anmelden" statt „Fehler" zeigt.
 *
 * Ohne diese Unterscheidung sieht ein abgemeldeter Nutzer eine rote
 * Fehlermeldung mit „Erneut versuchen", und der Knopf kann per Bauart nichts
 * ausrichten: Es ist nichts kaputt, es fehlt nur die Anmeldung.
 */
export class ChatAuthError extends Error {
  constructor(message = "Login required") {
    super(message);
    this.name = "ChatAuthError";
  }
}

/**
 * Das Zeichen NOTFALLS direkt aus dem Schlüsselbund holen.
 *
 * Wortgleich zu `resolveAuthToken` im Assistenten-Screen, und aus demselben
 * Grund: Das Zeichen liegt im Schlüsselbund des Geräts, und der Weg von dort in
 * den Speicher führt über Verzögerung, Lesevorgang und Netz-Aufruf. Wer in
 * diesem Fenster lädt — und die Schublade wird gern als Erstes geöffnet —,
 * fragte sonst ohne Kopfzeile an und bekäme ein 401, obwohl der Nutzer
 * angemeldet ist.
 *
 * Der Speicher bleibt der schnelle Weg; der Schlüsselbund ist nur der Rückfall,
 * und was dort gefunden wird, wandert gleich in den Speicher.
 */
async function resolveAuthToken(): Promise<string | null> {
  const fromStore = useSearchStore.getState().authToken;
  if (fromStore) return fromStore;
  try {
    const stored = await loadAuthToken();
    if (stored) {
      useSearchStore.setState({ authToken: stored });
      return stored;
    }
  } catch {
    // Kein Zugriff auf den Schlüsselbund — dann eben ohne. Der Server antwortet
    // mit 401, und daraus wird unten ein `ChatAuthError`.
  }
  return null;
}

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(path, API_BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Eine eigene Frist statt der aus `client.ts`.
 *
 * `fetchWithTimeout` dort ist nicht ausgeführt, und diese Datei darf `client.ts`
 * nicht umbauen. Die 10 Sekunden sind großzügig für vier Aufrufe, die alle nur
 * eine Tabelle abfragen — wichtiger ist, dass es ÜBERHAUPT eine Grenze gibt:
 * Ohne sie hängt die Schublade bei totem Backend dauerhaft im Ladezustand,
 * statt „Erneut versuchen" anzubieten.
 */
const TIMEOUT_MS = 10_000;

async function request<T>(
  path: string,
  init: RequestInit,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = buildUrl(path, params);
  const token = await resolveAuthToken();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${TIMEOUT_MS}ms — Server nicht erreichbar (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    // Der Rumpf trägt `{ error: "Login required" }` — der Text ist für den
    // Nutzer aber ohnehin unbrauchbar, die Oberfläche setzt ihren eigenen.
    throw new ChatAuthError();
  }

  if (!res.ok) {
    // Wie in `postJson` von `client.ts`: Der Server nennt den Grund oft selbst
    // („Conversation not found"), und der ist beim Suchen im Protokoll deutlich
    // mehr wert als eine nackte Zahl.
    let detail = "";
    try {
      const j = (await res.json()) as unknown;
      if (j && typeof j === "object" && "error" in j) detail = String((j as { error: unknown }).error);
    } catch {
      /* Rumpf war kein JSON — dann eben nur der Status. */
    }
    throw new Error(detail || `API ${res.status} ${res.statusText} for ${url}`);
  }

  // 204 beim Löschen — `res.json()` würde daran scheitern.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Eine Seite der Unterhaltungsliste, neueste zuerst.
 *
 * `nextCursor` ist für uns undurchsichtig und wird nur zurückgereicht: Der
 * Server entscheidet, woran er die Seite aufhängt (Zeitstempel, Kennung,
 * beides). Wer hier etwas hineinliest, bricht bei der nächsten Server-Änderung.
 */
export function fetchChatThreads(opts?: {
  limit?: number;
  cursor?: string;
}): Promise<{ items: ChatThreadSummary[]; nextCursor: string | null }> {
  return request<{ items: ChatThreadSummary[]; nextCursor: string | null }>(
    "/api/chat/conversations",
    { method: "GET" },
    { limit: opts?.limit ?? CHAT_THREADS_PAGE_SIZE, cursor: opts?.cursor },
  ).then((r) => ({
    // Ein Server, der bei leerer Liste `items` weglässt, darf die Schublade
    // nicht mit „undefined ist kein Array" zerlegen.
    items: r?.items ?? [],
    nextCursor: r?.nextCursor ?? null,
  }));
}

/**
 * Der Verlauf EINER Unterhaltung.
 *
 * `before` ist eine `seq`, keine Seitenzahl: Ältere Nachrichten holt man, indem
 * man die kleinste bereits vorliegende Nummer mitgibt. Das bleibt auch dann
 * richtig, wenn währenddessen oben etwas dazukommt — eine Seitenzahl würde
 * dabei verrutschen.
 */
export function fetchChatThread(
  id: string,
  opts?: { limit?: number; before?: number },
): Promise<ChatThreadDetail> {
  return request<ChatThreadDetail>(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: "GET" },
    { limit: opts?.limit ?? 50, before: opts?.before },
  );
}

/**
 * Löschen und Umbenennen — bewusst KEIN `useMutation`.
 *
 * Die App benutzt das nirgends, und die zwei Dinge, die es bringt (Zustand des
 * Vorgangs, Wiederholung), erledigt die aufrufende Stelle hier ohnehin selbst.
 * Die Liste wird danach per `setQueryData` fortgeschrieben statt neu geholt:
 * Was gelöscht wurde, weiß der Aufrufer schon — eine zweite Anfrage brächte
 * keine neue Erkenntnis, nur einen sichtbaren Nachlade-Zucker.
 *
 * Ein Anlegen fehlt hier absichtlich (`POST /api/chat/conversations`): Die
 * Schublade legt nichts an, sie meldet den Wunsch über `onNewChat` nach außen.
 */
export function deleteChatThread(id: string): Promise<void> {
  return request<void>(`/api/chat/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function renameChatThread(id: string, title: string): Promise<void> {
  return patchChatThread(id, { title });
}

export function setChatThreadPinned(id: string, pinned: boolean): Promise<void> {
  return patchChatThread(id, { pinned });
}

export function setChatThreadArchived(id: string, archived: boolean): Promise<void> {
  return patchChatThread(id, { archived });
}

/**
 * Alle drei Änderungen laufen über denselben Aufruf.
 *
 * Der Server nimmt Titel, Anheften und Archivieren in EINEM PATCH entgegen und
 * fasst nur die Felder an, die im Rumpf stehen. Drei getrennte Fassungen hier
 * wären drei Stellen, an denen sich der Pfad ändern kann.
 */
function patchChatThread(
  id: string,
  body: { title?: string; pinned?: boolean; archived?: boolean },
): Promise<void> {
  return request<{ conversation: ChatThreadSummary }>(
    `/api/chat/conversations/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  ).then(() => undefined);
}
