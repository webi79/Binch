import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { searchLocations } from "../services/locationService.js";

const querySchema = z.object({
  q: z.string().min(1),
  mode: z.enum(["FLIGHT", "TRAIN", "BUS", "CRUISE", "ALL"]).default("ALL"),
});

export async function locationsRoutes(app: FastifyInstance) {
  app.get("/api/locations", async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const results = await searchLocations(parsed.data.q, parsed.data.mode);
    return { results };
  });
}
