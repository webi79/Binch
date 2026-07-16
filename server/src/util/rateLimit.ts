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

/**
 * Prüft ein Feature-Budget für die IP OHNE die Anfrage zu zählen. Für den
 * nocache-Sub-Check, der NACH dem generellen Limiter läuft: sonst würde die
 * normale Suche doppelt gezählt.
 */
export function peekRateLimit(
  scope: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const r = rateLimit(scope, key, limit, windowMs);
  // Zählung zurücknehmen — wir wollten nur wissen, ob noch Budget da ist.
  const w = windows.get(`${scope}:${key}`);
  if (w && w.count > 0) w.count -= 1;
  return r;
}

/**
 * Per-IP-Rate-Limit als Fastify-preHandler für die UNAUTHENTIFIZIERTEN, teuren
 * Endpoints (Suche, Booking-Optionen, Locations, Surroundings, Stops, Trips).
 *
 * Warum überhaupt: Diese Routen lösen bezahlte Provider-Calls aus (RapidAPI,
 * SearchAPI, SerpAPI) bzw. verbrauchen das knappe DB-Kontingent (60 req/min).
 * Ohne Limit könnte EINE IP sie in Sekunden leerlaufen lassen — Kosten- und
 * Quota-Erschöpfung. Chat/Ticket-Parse sind schon auth+konto-limitiert, diese
 * hier waren komplett offen.
 *
 * Mehrere Fenster (z.B. pro Minute UND pro Stunde) fangen zwei Angriffsprofile:
 * das Minutenfenster den Burst, das Stundenfenster den langsamen Dauertropf,
 * der jedes Minutenfenster gerade so ausreizt.
 *
 * `req.ip` respektiert X-Forwarded-For nur mit Fastifys trustProxy (siehe
 * config.TRUST_PROXY) — hinter einem Reverse-Proxy MUSS das an sein, sonst
 * landen alle Nutzer im selben Bucket (die Peer-IP ist dann der Proxy).
 */
export function ipLimiter(
  scope: string,
  buckets: Array<{ limit: number; windowMs: number }>,
) {
  return async function preHandler(
    req: { ip: string },
    reply: {
      code: (n: number) => { header: (k: string, v: string | number) => { send: (b: unknown) => unknown } };
    },
  ): Promise<unknown | void> {
    for (const b of buckets) {
      const rl = rateLimit(`${scope}:${b.windowMs}`, req.ip, b.limit, b.windowMs);
      if (!rl.allowed) {
        return reply
          .code(429)
          .header("Retry-After", rl.retryAfterSec)
          .send({ error: "Too many requests", retryAfterSec: rl.retryAfterSec });
      }
    }
  };
}
