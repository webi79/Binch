import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runSearch } from "../services/searchService.js";
import type { TravelMode } from "../db/schema.js";

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
  for (const { path, mode } of MODE_PATHS) {
    app.get(path, async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
      }
      const result = await runSearch({
        ...parsed.data,
        mode,
        ip: req.ip,
      });
      return result;
    });
  }
}
