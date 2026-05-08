import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runSearch } from "../services/searchService.js";
import type { TravelMode } from "../db/schema.js";

const querySchema = z.object({
  origin: z.string().min(1),
  destination: z.string().min(1),
  originLabel: z.string().optional(),
  destLabel: z.string().optional(),
  departDate: z.string().min(1),
  returnDate: z.string().optional(),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  currency: z.string().default("EUR"),
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
