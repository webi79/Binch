/**
 * In-Memory Fixed-Window Rate-Limiter.
 *
 * Bewusst simpel: der Server läuft als EINE Instanz (Docker), In-Memory
 * reicht. Bei Multi-Instanz-Deployment müsste das in Redis/Postgres wandern.
 *
 * Key-Konvention: `scope` trennt die Feature-Budgets (z.B. "chat",
 * "ticket-parse", "login"), `key` ist die Identität (User-ID für konto-
 * gebundene Limits, IP für unauthentifizierte Endpoints).
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Ab dieser Map-Größe werden abgelaufene Fenster ausgeräumt — hält den
 *  Speicher bounded, auch wenn ein Angreifer viele IPs/Keys durchprobiert. */
const PRUNE_THRESHOLD = 10_000;

function pruneExpired(now: number): void {
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Sekunden bis das Fenster resettet — für Retry-After-Header. */
  retryAfterSec: number;
  remaining: number;
}

export function rateLimit(
  scope: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const mapKey = `${scope}:${key}`;

  let w = windows.get(mapKey);
  if (!w || w.resetAt <= now) {
    if (windows.size >= PRUNE_THRESHOLD) pruneExpired(now);
    w = { count: 0, resetAt: now + windowMs };
    windows.set(mapKey, w);
  }

  w.count += 1;
  const retryAfterSec = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
  if (w.count > limit) {
    return { allowed: false, retryAfterSec, remaining: 0 };
  }
  return { allowed: true, retryAfterSec, remaining: limit - w.count };
}
