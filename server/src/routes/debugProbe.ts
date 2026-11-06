/**
 * MESSSONDE (vorübergehend) — nimmt die Ruckel-Messungen der App entgegen
 * (lib/perf/transitionProbe.ts) und schreibt sie ins Protokoll:
 * `docker logs server-binch-server-1 | grep '"probe"'`.
 *
 * Die App sendet nur gegen einen Server im eigenen Netz. Klein gehalten und
 * gedrosselt, weil die Route ohne Anmeldung offen ist. Nach der Auswertung
 * zusammen mit der Sonde entfernen.
 */
import type { FastifyInstance } from "fastify";
import { rateLimit } from "../util/rateLimit.js";

export async function debugProbeRoutes(app: FastifyInstance) {
  app.post("/api/debug/probe", { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const rl = rateLimit("debug-probe", req.ip, 300, 60 * 60 * 1000);
    if (!rl.allowed) return reply.code(429).send();
    req.log.info({ probe: req.body }, "probe");
    return reply.code(204).send();
  });
}
