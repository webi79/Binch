import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { inArray, sql } from "drizzle-orm";
import { searchLocations } from "../services/locationService.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { ipLimiter } from "../util/rateLimit.js";
import { resolveReplacements } from "../services/locationReplacements.js";

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
  // Locations-Autocomplete: tippt der User, feuert das oft — daher großzügig,
  // aber gedeckelt gegen Skript-Fluten (jeder Miss kann einen Geocoder-Call
  // auslösen).
  const preHandler = ipLimiter("locations", [{ limit: 90, windowMs: 60 * 1000 }]);
  app.get("/api/locations", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    /**
     * Auch das Gerät darf die Trefferliste behalten.
     *
     * Androids HTTP-Schicht hält GET-Antworten mit dieser Kopfzeile selbst vor,
     * und zwar über den App-Start hinaus. Wer „berlin" schon einmal getippt
     * hat, bekommt die Liste beim nächsten Mal ohne Netzaufruf — der Server
     * sieht die Anfrage gar nicht erst.
     *
     * Fünf Minuten sind reichlich für eine Tipp-Sitzung und kurz genug, dass
     * ein Datenimport zeitnah durchschlägt. Der Bestand ändert sich ohnehin nur
     * dann.
     */
    reply.header("Cache-Control", "public, max-age=300");
    const results = await searchLocations(parsed.data.q, parsed.data.mode);
    // `matchLabel` ist nur für die Namensprüfung im Chat da (siehe ClientLocation).
    return { results: results.map(({ matchLabel: _full, ...rest }) => rest) };
  });

  // Batch-Lookup für persistierte Recents/Saved-Stations. Pro Code liefern wir
  // `exists` (gibt's noch in der DB?) + `label` (aktuelle Anzeige). Client nutzt
  // das beim App-Start um stale Einträge zu prunen / Labels zu syncen — z.B.
  // wenn wir nach DB-Cleanup einen sta:-Code gelöscht oder umgelabelt haben.
  // `label` ist der ANGEZEIGTE Name (offiziell, `display_name`), dazu `detail`
  // wo ein gleichnamiger Halt daneben steht — so bekommen auch gespeicherte
  // Stationen und der Verlauf beim nächsten Start den richtigen Namen.
  app.get("/api/locations/by-codes", { preHandler }, async (req, reply) => {
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

    const load = (list: string[]) =>
      db
        .select({
          code: locations.code,
          label: sql<string>`coalesce(${locations.displayName}, ${locations.label})`,
          detail: locations.displayDetail,
          // Steig-Bezeichnung nur bei einem Bus- oder Tram-Steig (wie Karte und
          // Tafel) — eine gespeicherte Station behält so ihr „Steig 3".
          platform: sql<string | null>`CASE WHEN ${locations.parentCode} IS NOT NULL
            AND coalesce(${locations.subtype}, CASE WHEN ${locations.type} = 'BUS' THEN 'BUS' END) IN ('BUS', 'COACH', 'TRAM')
            THEN ${locations.platform} END`,
        })
        .from(locations)
        .where(inArray(locations.code, list));
    const rows = await load(codes);
    const byCode = new Map(rows.map((r) => [r.code, r]));

    /**
     * Entfernte Halte (veraltet oder doppelt, `location_replacements`): Die
     * App bekommt den Ersatz am selben Ort mitgeteilt (`replacedBy`) und
     * tauscht die Kennung in gespeicherten Stationen und im Verlauf aus —
     * statt sie als „gibt es nicht" zu verwerfen.
     */
    const missing = codes.filter((c) => !byCode.has(c));
    const replaced = missing.length > 0 ? await resolveReplacements(missing) : new Map<string, string>();
    if (replaced.size > 0) {
      for (const r of await load([...new Set(replaced.values())])) byCode.set(r.code, r);
    }

    const results = codes.map((code) => {
      const target = replaced.get(code);
      const row = byCode.get(target ?? code);
      return row != null
        ? {
            code,
            label: row.label,
            ...(row.detail ? { detail: row.detail } : {}),
            ...(row.platform ? { platform: row.platform } : {}),
            ...(target ? { replacedBy: target } : {}),
            exists: true as const,
          }
        : { code, exists: false as const };
    });
    return { results };
  });
}
