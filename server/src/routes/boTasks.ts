/**
 * /api/bo/tasks — Bos geplante Aufgaben (services/boTasks.ts).
 *
 * Nur mit Konto: Die Aufgaben hängen am Konto, ihre Mitteilungen gehen an alle
 * seine Geräte. Angelegt wird ausschließlich hier — Bo schlägt im Chat nur vor
 * (`propose_task`), und die App schickt den Vorschlag erst nach dem Tipp auf
 * „Anlegen".
 *
 *   GET    /api/bo/tasks            → { tasks, limit }
 *   POST   /api/bo/tasks            → { task }        (409 limit)
 *   PATCH  /api/bo/tasks/:id        → { task }        (an/aus, Uhrzeit, Melden …)
 *   DELETE /api/bo/tasks/:id        → 204
 *   POST   /api/bo/tasks/:id/run    → { run }         („Jetzt prüfen", 429 bei Wiederholung)
 *   GET    /api/bo/tasks/:id/runs   → { runs }        (Verlauf, neueste zuerst)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireUser } from "../services/authSession.js";
import { ipLimiter } from "../util/rateLimit.js";
import {
  createTask,
  deleteTask,
  listRuns,
  listTasks,
  runNow,
  TASK_LIMIT,
  TaskLimitError,
  updateTask,
  type BoTask,
} from "../services/boTasks.js";

const LIMITS = [
  { limit: 30, windowMs: 60 * 1000 },
  { limit: 300, windowMs: 60 * 60 * 1000 },
];

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const createSchema = z
  .object({
    kind: z.literal("route_status"),
    title: z.string().trim().min(1).max(60),
    origin: z.string().trim().min(1).max(64),
    destination: z.string().trim().min(1).max(64),
    originLabel: z.string().trim().min(1).max(160),
    destLabel: z.string().trim().min(1).max(160),
    days: z.number().int().min(1).max(127),
    time: z.string().regex(HM),
    watchUntil: z.string().regex(HM).nullable().optional(),
    timezone: z.string().min(1).max(64).refine(validTimezone, "Unbekannte Zeitzone"),
    notify: z.enum(["always", "issues"]),
    locale: z.enum(["de", "en", "fr", "es"]).default("de"),
    conversationId: z.string().regex(UUID_RE).nullable().optional(),
  })
  .refine((v) => v.origin !== v.destination, "Start und Ziel sind gleich")
  .refine((v) => !v.watchUntil || v.watchUntil > v.time, "Wache endet vor dem Start");

const patchSchema = z
  .object({
    active: z.boolean().optional(),
    notify: z.enum(["always", "issues"]).optional(),
    time: z.string().regex(HM).optional(),
    days: z.number().int().min(1).max(127).optional(),
    watchUntil: z.string().regex(HM).nullable().optional(),
    title: z.string().trim().min(1).max(60).optional(),
    origin: z.string().trim().min(1).max(64).optional(),
    destination: z.string().trim().min(1).max(64).optional(),
    originLabel: z.string().trim().min(1).max(160).optional(),
    destLabel: z.string().trim().min(1).max(160).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nichts zu ändern")
  .refine((v) => !v.origin || !v.destination || v.origin !== v.destination, "Start und Ziel sind gleich")
  .refine((v) => !v.time || !v.watchUntil || v.watchUntil > v.time, "Wache endet vor dem Start");

/** Was die App von einer Aufgabe sieht — ohne Konto-Kennung. */
function dto(t: BoTask) {
  return {
    id: t.id,
    kind: t.kind,
    title: t.title,
    origin: t.origin,
    destination: t.destination,
    originLabel: t.originLabel,
    destLabel: t.destLabel,
    days: t.days,
    time: t.time,
    watchUntil: t.watchUntil,
    timezone: t.timezone,
    notify: t.notify,
    active: t.active,
    nextRunAt: t.nextRunAt,
    lastRunAt: t.lastRunAt,
    lastStatus: t.lastStatus,
    lastSummary: t.lastSummary,
    conversationId: t.conversationId,
    createdAt: t.createdAt,
  };
}

async function userOr401(req: FastifyRequest, reply: FastifyReply) {
  const user = await requireUser(req);
  if (!user) {
    reply.code(401).send({ error: "Login required" });
    return null;
  }
  return user;
}

function idParam(req: FastifyRequest): string | null {
  const id = (req.params as { id?: string }).id;
  return id && UUID_RE.test(id) ? id : null;
}

export async function boTasksRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("boTasks", LIMITS);

  app.get("/api/bo/tasks", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const tasks = await listTasks(user.id);
    return { tasks: tasks.map(dto), limit: TASK_LIMIT };
  });

  app.post("/api/bo/tasks", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    try {
      const task = await createTask(user.id, parsed.data);
      req.log.info({ task: task.id.slice(0, 8), time: task.time, days: task.days }, "bo task created");
      return reply.code(201).send({ task: dto(task) });
    } catch (e) {
      if (e instanceof TaskLimitError) return reply.code(409).send({ error: "limit", limit: TASK_LIMIT });
      throw e;
    }
  });

  app.patch("/api/bo/tasks/:id", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "Bad id" });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    try {
      const task = await updateTask(user.id, id, parsed.data);
      if (!task) return reply.code(404).send({ error: "Not found" });
      if (task.watchUntil && task.watchUntil <= task.time) {
        // Uhrzeit hinter die Wache geschoben — die Wache gilt dann nicht mehr.
        const fixed = await updateTask(user.id, id, { watchUntil: null });
        return { task: dto(fixed ?? task) };
      }
      return { task: dto(task) };
    } catch (e) {
      if (e instanceof TaskLimitError) return reply.code(409).send({ error: "limit", limit: TASK_LIMIT });
      throw e;
    }
  });

  app.delete("/api/bo/tasks/:id", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "Bad id" });
    const ok = await deleteTask(user.id, id);
    return ok ? reply.code(204).send() : reply.code(404).send({ error: "Not found" });
  });

  app.post("/api/bo/tasks/:id/run", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "Bad id" });
    const run = await runNow(user.id, id);
    if (run === "notFound") return reply.code(404).send({ error: "Not found" });
    if (run === "tooSoon") return reply.code(429).send({ error: "Too soon" });
    if (run === "limit") return reply.code(409).send({ error: "limit", limit: TASK_LIMIT });
    return { run };
  });

  app.get("/api/bo/tasks/:id/runs", { preHandler }, async (req, reply) => {
    const user = await userOr401(req, reply);
    if (!user) return;
    const id = idParam(req);
    if (!id) return reply.code(400).send({ error: "Bad id" });
    const runs = await listRuns(user.id, id);
    if (!runs) return reply.code(404).send({ error: "Not found" });
    return { runs };
  });
}
