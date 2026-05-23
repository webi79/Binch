/**
 * Shared Rate-Limiter + Background-Refresh-Queue für db-vendo.
 *
 * Zwei Prioritätsstufen über einem gemeinsamen 50/min-Budget:
 *   - „user"       → User wartet auf Response (SearchHero, Stop-Tap, Locations).
 *                    Darf bis HARD_CAP ziehen. Bekommt im Konflikt Vorrang.
 *   - „background" → SWR-Refresh, History-Route-Refresh, Pre-Cache.
 *                    Darf nur bis (HARD_CAP - USER_RESERVE) → User-Calls
 *                    haben dadurch immer freie Slots.
 *
 * Queue:
 *   - Background-Refreshes werden via `enqueueRefresh` registriert
 *   - Dedup per `key` — 100 parallele Refresh-Wünsche für dieselbe Route
 *     ergeben 1 Task
 *   - Worker tickt alle 1.5 s, holt höchste Priorität, prüft Background-Budget
 *   - Falls Budget alle: Worker idled, Task bleibt liegen
 *   - Max-Age pro Task (Default 5 min) — stale Refreshes verfallen
 *
 * Headroom-Strategie:
 *   - DB-Limit:       60/min IPv4
 *   - Unser HARD_CAP: 50/min (10 Slots gegen Clock-Skew + interne Retries)
 *   - USER_RESERVE:   20 → Background darf max 30/min ziehen
 *   - Resultat: User-Traffic-Spike auf 30/min schiebt Background komplett raus,
 *               User kann noch bis 50/min weiter feuern
 */

const WINDOW_MS = 60_000;
const HARD_CAP = 50;
const USER_RESERVE = 20; // 20 Slots immer für User — Background-Cap = 30/min
const WORKER_TICK_MS = 1500; // 40/min Worker-Tickrate (gedeckelt durch Budget)
const DEFAULT_TASK_MAX_AGE_MS = 5 * 60_000;

const outboundTimes: number[] = [];

function pruneOld(): number {
  const cutoff = Date.now() - WINDOW_MS;
  while (outboundTimes.length > 0 && outboundTimes[0]! < cutoff) outboundTimes.shift();
  return outboundTimes.length;
}

/** Aktueller Outbound-Druck (Calls in den letzten 60s). */
export function dbVendoBudgetUsed(): number {
  return pruneOld();
}

/** Versuch einen User-Slot zu reservieren. Liefert true wenn Budget da. */
export function claimUserBudget(): boolean {
  const usage = pruneOld();
  if (usage >= HARD_CAP) return false;
  outboundTimes.push(Date.now());
  return true;
}

/** Versuch einen Background-Slot zu reservieren (strenger gecapped). */
export function claimBackgroundBudget(): boolean {
  const usage = pruneOld();
  if (usage >= HARD_CAP - USER_RESERVE) return false;
  outboundTimes.push(Date.now());
  return true;
}

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

async function tick(): Promise<void> {
  if (tasks.size === 0) return;

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
  if (dbVendoBudgetUsed() >= HARD_CAP - USER_RESERVE) return;

  tasks.delete(best.key);
  try {
    await best.execute();
  } catch {
    // Refresh-Fehler ignorieren — der nächste User-Access triggert eine
    // neue Anfrage (entweder direkt oder erneut enqueued).
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
