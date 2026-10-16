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
/**
 * Harte Obergrenze. Stundenfenster laufen eine Stunde lang nicht ab — wer mit
 * ständig neuen Client-Kennungen anfragt, füllte die Tabelle sonst beliebig
 * (und jede Einfügung jenseits von `PRUNE_THRESHOLD` durchsuchte sie ganz).
 * Darüber fliegen die ältesten Einträge (die Map hält die Einfügereihenfolge).
 */
const HARD_CAP = 50_000;
let lastPruneAt = 0;

function pruneExpired(now: number): void {
  // Höchstens einmal pro Sekunde komplett durchsehen.
  if (now - lastPruneAt < 1000) return;
  lastPruneAt = now;
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
  if (windows.size > HARD_CAP) {
    let drop = windows.size - Math.floor(HARD_CAP * 0.9);
    for (const k of windows.keys()) {
      if (drop-- <= 0) break;
      windows.delete(k);
    }
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
 * Wie viel mehr eine IP insgesamt darf als ein einzelner Client — für alle, die
 * sich eine IP teilen (Mobilfunk-NAT, WLAN im Büro). Gegen jemanden, der die
 * Client-Kennung bei jeder Anfrage wechselt, hält diese Obergrenze trotzdem.
 *
 * Die Kennung ist unsigniert — jeder kann sie frei erfinden. Wo eine Anfrage
 * bezahlte Anbieter oder das Bahn-Kontingent kostet (Suche, Buchungsoptionen,
 * Fahrten, Reiseplan), gibt der Aufrufer deshalb einen kleineren Faktor an
 * (`EXPENSIVE_IP_CEILING_FACTOR`): Mit zehn hob eine erfundene Kennung pro
 * Anfrage die Suche einer IP von 20 auf 200 pro Minute — genug, um das ganze
 * Bahn-Kontingent allein zu verbrauchen.
 */
const IP_CEILING_FACTOR = 10;
export const EXPENSIVE_IP_CEILING_FACTOR = 3;

/** Die Installations-Kennung der App (`X-Client-Id`, siehe lib/api/clientId.ts). */
function clientIdOf(req: { headers?: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers?.["x-client-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === "string" && /^[A-Za-z0-9-]{16,64}$/.test(id) ? id : null;
}

/**
 * Rate-Limit als Fastify-preHandler für die UNAUTHENTIFIZIERTEN, teuren
 * Endpoints (Suche, Booking-Optionen, Locations, Surroundings, Stops, Trips).
 *
 * Warum überhaupt: Diese Routen lösen bezahlte Provider-Calls aus (RapidAPI,
 * SearchAPI, SerpAPI) bzw. verbrauchen das knappe DB-Kontingent (60 req/min).
 * Ohne Limit könnte EINE IP sie in Sekunden leerlaufen lassen — Kosten- und
 * Quota-Erschöpfung. Chat/Ticket-Parse sind schon auth+konto-limitiert, diese
 * hier waren komplett offen.
 *
 * WER gezählt wird: Schickt die App ihre Installations-Kennung mit
 * (`X-Client-Id`), gelten die Fenster PRO CLIENT — und pro IP eine Obergrenze
 * vom `IP_CEILING_FACTOR`-fachen. Vorher zählte nur die IP, und hinter einem
 * Mobilfunk-NAT teilten sich viele Nutzer denselben Topf. Ohne Kennung (alte
 * App-Versionen, Fremde) bleibt es beim Fenster pro IP.
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
  opts: { ipCeilingFactor?: number } = {},
) {
  const ceilingFactor = opts.ipCeilingFactor ?? IP_CEILING_FACTOR;
  return async function preHandler(
    req: { ip: string; headers?: Record<string, string | string[] | undefined> },
    reply: {
      code: (n: number) => { header: (k: string, v: string | number) => { send: (b: unknown) => unknown } };
    },
  ): Promise<unknown | void> {
    const client = clientIdOf(req);
    for (const b of buckets) {
      /**
       * Erst die IP-Obergrenze, dann der Client — und den Client nur, wenn die
       * IP noch darf. Sonst legte jede Anfrage mit neuer Kennung einen Eintrag
       * an, auch wenn sie ohnehin abgewiesen wurde.
       */
      let denied: RateLimitResult | null = null;
      if (client) {
        const ip = rateLimit(`${scope}:${b.windowMs}:ipc`, req.ip, b.limit * ceilingFactor, b.windowMs);
        denied = ip.allowed ? null : ip;
        if (!denied) {
          const c = rateLimit(`${scope}:${b.windowMs}:client`, client, b.limit, b.windowMs);
          denied = c.allowed ? null : c;
        }
      } else {
        const ip = rateLimit(`${scope}:${b.windowMs}`, req.ip, b.limit, b.windowMs);
        denied = ip.allowed ? null : ip;
      }
      if (denied) {
        return reply
          .code(429)
          .header("Retry-After", denied.retryAfterSec)
          .send({ error: "Too many requests", retryAfterSec: denied.retryAfterSec });
      }
    }
  };
}
