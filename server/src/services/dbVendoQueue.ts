import { dbHasRoom, withDbPriority } from "./dbQuota.js";

/**
 * Background-Refresh-Queue für db-vendo.
 *
 * Das Budget (wie viele Anfragen pro Minute an bahn.de gehen dürfen, mit
 * Vorrang für die Suche) steht in services/dbQuota.ts. Hier liegt nur die
 * Warteschlange für das Auffrischen im Hintergrund:
 *   - Aufträge werden via `enqueueRefresh` registriert
 *   - Dedup per `key` — 100 parallele Refresh-Wünsche für dieselbe Route
 *     ergeben 1 Task
 *   - Worker tickt alle 1.5 s, holt höchste Priorität, prüft das Budget der
 *     Stufe `background`; ist es alle, bleibt der Auftrag liegen
 *   - Max-Age pro Task (Default 5 min) — stale Refreshes verfallen
 */

/**
 * Das Budget selbst steht seit Sept. 2026 in services/dbQuota.ts — EIN Zähler
 * für alles, was an bahn.de geht (vorher zählten hier nur die Tafeln). Diese
 * Datei ist nur noch die Warteschlange für das Auffrischen im Hintergrund.
 */
const WORKER_TICK_MS = 1500; // 40/min Worker-Tickrate (gedeckelt durch Budget)
const DEFAULT_TASK_MAX_AGE_MS = 5 * 60_000;

interface RefreshTask {
  /** Dedup-Key — gleicher Key überschreibt vorhandene Tasks (höhere Priorität gewinnt). */
  key: string;
  /** Höher = wird zuerst abgearbeitet. */
  priority: number;
  enqueuedAt: number;
  maxAgeMs: number;
  execute: () => Promise<unknown>;
}

const tasks = new Map<string, RefreshTask>();
let workerTimer: NodeJS.Timeout | null = null;

export interface EnqueueOpts {
  /** Eindeutiger Key — bei doppelten Inserts gewinnt die höhere Priorität. */
  key: string;
  /** Höher = wichtiger. Default 0. Beispiel: 10 für viel-frequentierte Top-Stops. */
  priority?: number;
  /** Nach so vielen ms verfällt der Task ungeöffnet. Default 5 min. */
  maxAgeMs?: number;
  /** Tut den Refresh. Fehler werden geschluckt (next access retried). */
  execute: () => Promise<unknown>;
}

/** Reiht einen Background-Refresh in die Queue ein. */
export function enqueueRefresh(opts: EnqueueOpts): void {
  const priority = opts.priority ?? 0;
  const existing = tasks.get(opts.key);
  if (existing && existing.priority >= priority) {
    // Wir haben schon einen mindestens so wichtigen Task für den Key — Skip.
    return;
  }
  tasks.set(opts.key, {
    key: opts.key,
    priority,
    enqueuedAt: Date.now(),
    maxAgeMs: opts.maxAgeMs ?? DEFAULT_TASK_MAX_AGE_MS,
    execute: opts.execute,
  });
}

/**
 * Längste Laufzeit eines Auftrags, bevor die Schlange weitergeht — eine
 * Zugsuche im Hintergrund braucht höchstens ihre Anbieter-Grenze (15 s) plus
 * Preise (≈ 13 s); das Doppelte davon ist sicher „hängt".
 */
const TASK_WATCHDOG_MS = 60_000;

/** Läuft gerade ein Auftrag? Die Uhr tickt ohne zu warten — ohne diesen Merker
 *  starteten langsame Aufträge überlappend, alle nach derselben Budget-Prüfung. */
let ticking = false;

async function tick(): Promise<void> {
  if (tasks.size === 0 || ticking) return;
  ticking = true;
  try {
    await runNext();
  } finally {
    ticking = false;
  }
}

async function runNext(): Promise<void> {

  // Expirierte Tasks abräumen, höchste Priorität raussuchen.
  const now = Date.now();
  let best: RefreshTask | null = null;
  for (const t of tasks.values()) {
    if (now - t.enqueuedAt > t.maxAgeMs) {
      tasks.delete(t.key);
      continue;
    }
    if (!best || t.priority > best.priority) best = t;
  }
  if (!best) return;

  // Background-Druck gate — wenn das Budget für Background-Calls schon voll
  // ist (User-Reserve sicher halten), idlen. Task bleibt in der Map. Der
  // eigentliche Slot-Claim passiert IM execute() durch den Fetch selbst
  // (`claimBackgroundBudget`), sodass jede physische dbRest-Anfrage gezählt
  // wird (inkl. Retries innerhalb eines fetchFromDbRest-Calls).
  if (!dbHasRoom("background")) return;

  tasks.delete(best.key);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // Alles, was dieser Auftrag bei der Bahn fragt, zählt als Hintergrund —
    // auch wenn er dieselbe Funktion wie eine echte Suche aufruft.
    //
    // Mit Wachhund: Die Aufträge laufen einer nach dem anderen (`ticking`).
    // Hängt einer (Sidecar antwortet nicht), stünde sonst die ganze Schlange.
    // Nach `TASK_WATCHDOG_MS` geht es weiter; der hängende Auftrag darf im
    // Hintergrund noch zu Ende laufen.
    await Promise.race([
      withDbPriority("background", () => best.execute()),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("watchdog")), TASK_WATCHDOG_MS);
      }),
    ]);
  } catch {
    // Refresh-Fehler ignorieren — der nächste User-Access triggert eine
    // neue Anfrage (entweder direkt oder erneut enqueued).
  } finally {
    clearTimeout(watchdog);
  }
}

/** Startet den Worker. Idempotent. */
export function startDbVendoQueue(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => void tick(), WORKER_TICK_MS);
  // unref damit das Node-Process beim Shutdown nicht am Worker hängt.
  workerTimer.unref();
}

/** Stoppt den Worker. Wird im Shutdown-Handler aufgerufen. */
export function stopDbVendoQueue(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}

/** Aktuelle Queue-Größe. Für Monitoring/Debug. */
export function backgroundQueueSize(): number {
  return tasks.size;
}
