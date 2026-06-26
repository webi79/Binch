import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { searchLocations } from "../services/locationService.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";

const querySchema = z.object({
  q: z.string().min(1),
  mode: z.enum(["FLIGHT", "TRAIN", "BUS", "CRUISE", "ALL"]).default("ALL"),
});

// Cap damit ein Client nicht versehentlich tausend Codes auf einmal anfragt.
// 60 reicht für unsere Persistenz-Validation: 30 RecentSearches × 2 (origin+dest).
const BY_CODES_MAX = 200;

const byCodesQuerySchema = z.object({
  codes: z.string().min(1),
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

  // Batch-Lookup für persistierte Recents/Saved-Stations. Pro Code liefern wir
  // `exists` (gibt's noch in der DB?) + `label` (aktuelle Anzeige). Client nutzt
  // das beim App-Start um stale Einträge zu prunen / Labels zu syncen — z.B.
  // wenn wir nach DB-Cleanup einen sta:-Code gelöscht oder umgelabelt haben.
  app.get("/api/locations/by-codes", async (req, reply) => {
    const parsed = byCodesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const codes = Array.from(
      new Set(
        parsed.data.codes
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    ).slice(0, BY_CODES_MAX);
    if (codes.length === 0) return { results: [] };

    const rows = await db
      .select({ code: locations.code, label: locations.label })
      .from(locations)
      .where(inArray(locations.code, codes));

    const byCode = new Map(rows.map((r) => [r.code, r.label]));
    const results = codes.map((code) => {
      const label = byCode.get(code);
      return label != null
        ? { code, label, exists: true as const }
        : { code, exists: false as const };
    });
    return { results };
  });
}
