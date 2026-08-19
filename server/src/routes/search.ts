import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runSearch } from "../services/searchService.js";
import { ipLimiter, rateLimit } from "../util/rateLimit.js";
import type { TravelMode } from "../db/schema.js";

// Per-IP-Budget der Suche. Zwei Fenster: das Minutenfenster gegen Bursts, das
// Stundenfenster gegen den langsamen Dauertropf. 20/min ist um ein Vielfaches
// über echter Nutzung (ein Mensch sucht ein paar Mal pro Minute), aber kappt
// ein hämmerndes Skript hart. Jede Suche kann bis zu 3 RapidAPI- + weitere
// Provider-Calls auslösen — deshalb ist genau HIER der Deckel am wichtigsten.
const SEARCH_LIMITS = [
  { limit: 20, windowMs: 60 * 1000 },
  { limit: 120, windowMs: 60 * 60 * 1000 },
];
// ?nocache=1 umgeht den Cache und ERZWINGT frische Provider-Calls — auch für
// populäre Routen, die sonst gratis aus dem Cache kämen. Damit ist es der
// teuerste Modus und bekommt ein eigenes, enges Budget: Pull-to-Refresh (ein
// paar Mal die Minute) bleibt möglich, als Waffe taugt es nicht.
const NOCACHE_LIMIT = { limit: 6, windowMs: 60 * 1000 };

// .max() überall: die Werte landen in Cache-Keys, DB-Zeilen und Provider-URLs
// — ohne Deckel wären sie nur durch die URL-Gesamtlänge begrenzt.
const querySchema = z.object({
  origin: z.string().min(1).max(200),
  destination: z.string().min(1).max(200),
  originLabel: z.string().max(300).optional(),
  destLabel: z.string().max(300).optional(),
  departDate: z.string().min(1).max(40),
  /** Optional ISO-UTC-Zeitstempel — Surroundings-Tap setzt das, normale Suche
   *  lässt's weg. Wird vom dbVendo-Provider als Suchfenster-Start verwendet. */
  departTime: z.string().max(40).optional(),
  returnDate: z.string().max(40).optional(),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  currency: z.string().max(8).default("EUR"),
  /** i18n-Key (z.B. "search.class.business"). Provider entscheiden selbst,
   *  ob/wie sie das umsetzen — wir reichen den Wert nur durch. */
  travelClass: z.string().max(60).optional(),
  /** ?nocache=1 erzwingt frische Provider-Anfrage, sonst greift der 2h-Cache. */
  nocache: z.coerce.boolean().optional(),
  /** ?nearby=1 erlaubt das Ausweichen auf nahegelegene Flughäfen. Nur wenn der
   *  Nutzer das im Leerzustand ausdrücklich anfordert (siehe SearchInput). */
  nearby: z.coerce.boolean().optional(),
  /** „Später"-Pagination: opaques Token aus der vorherigen Suche
   *  (HAFAS laterRef). Wird nur von TRAIN-Provider unterstützt; bei
   *  anderen Modes ignoriert. */
  paginationToken: z.string().max(2000).optional(),
});

const MODE_PATHS: Array<{ path: string; mode: TravelMode }> = [
  { path: "/api/search/flights", mode: "FLIGHT" },
  { path: "/api/search/trains", mode: "TRAIN" },
  { path: "/api/search/buses", mode: "BUS" },
  { path: "/api/search/cruises", mode: "CRUISE" },
];

export async function searchRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("search", SEARCH_LIMITS);
  for (const { path, mode } of MODE_PATHS) {
    app.get(path, { preHandler }, async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
      }
      // nocache: enges Zusatz-Budget OBEN DRAUF (der generelle Limiter lief schon
      // im preHandler). Nur nocache-Requests zählen gegen dieses Budget.
      if (parsed.data.nocache) {
        const rl = rateLimit("search-nocache", req.ip, NOCACHE_LIMIT.limit, NOCACHE_LIMIT.windowMs);
        if (!rl.allowed) {
          return reply
            .code(429)
            .header("Retry-After", rl.retryAfterSec)
            .send({ error: "Too many refreshes", retryAfterSec: rl.retryAfterSec });
        }
      }
      const result = await runSearch({
        ...parsed.data,
        mode,
        ip: req.ip,
        // Query heißt `nearby`, intern `allowNearby` — explizit abbilden, ein
        // Spread würde das Feld stillschweigend verschlucken.
        allowNearby: parsed.data.nearby === true,
      });
      return result;
    });
  }
}
