import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, sessions } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../util/password.js";
import { randomToken } from "../util/hash.js";

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const registerSchema = z.object({
  email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  firstName: z.string().min(1).max(80).transform((s) => s.trim()),
  lastName: z.string().min(1).max(80).transform((s) => s.trim()),
});

const loginSchema = z.object({
  email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(200),
});

interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarDataUrl: string | null;
}

function toPublic(u: typeof users.$inferSelect): PublicUser {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    avatarDataUrl: u.avatarDataUrl ?? null,
  };
}

const MAX_AVATAR_BYTES = 800 * 1024; // ~800 KB raw base64 cap (≈ 600 KB binary)
const avatarSchema = z.object({
  /** Either a `data:image/...;base64,...` URL or null to remove. */
  dataUrl: z.string().nullable(),
});

function bearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

async function resolveSession(token: string): Promise<PublicUser | null> {
  const [row] = await db
    .select({
      uid: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarDataUrl: users.avatarDataUrl,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .limit(1);

  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.token, token));
    return null;
  }

  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.token, token));

  return {
    id: row.uid,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarDataUrl: row.avatarDataUrl ?? null,
  };
}

async function createSession(userId: string): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return token;
}

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/check-email", async (req, reply) => {
    // Schmaler Endpoint nur für den BinchAuthScreen — entscheidet ob der
    // User in Schritt 1 (Email) auf den Login-Pfad (Konto existiert) oder
    // Register-Pfad (Neukunde) gehen soll. Kein PW, kein Token. Returns
    // {exists: boolean}.
    const schema = z.object({ email: z.string().email().toLowerCase() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid email" });
    }
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, parsed.data.email))
      .limit(1);
    return { exists: rows.length > 0 };
  });

  app.post("/api/auth/register", async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { email, password, firstName, lastName } = parsed.data;

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = await hashPassword(password);
    const inserted = await db
      .insert(users)
      .values({ email, passwordHash, firstName, lastName })
      .returning();
    const created = inserted[0];
    if (!created) {
      return reply.code(500).send({ error: "Failed to create user" });
    }

    const token = await createSession(created.id);
    return { token, user: toPublic(created) };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { email, password } = parsed.data;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = await createSession(user.id);
    return { token, user: toPublic(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = bearerToken(req);
    if (token) {
      await db.delete(sessions).where(eq(sessions.token, token));
    }
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const me = await resolveSession(token);
    if (!me) return reply.code(401).send({ error: "Invalid or expired session" });
    return { user: me };
  });

  app.put("/api/auth/avatar", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const me = await resolveSession(token);
    if (!me) return reply.code(401).send({ error: "Invalid or expired session" });

    const parsed = avatarSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { dataUrl } = parsed.data;

    if (dataUrl !== null) {
      if (!dataUrl.startsWith("data:image/")) {
        return reply.code(400).send({ error: "Expected image data URL" });
      }
      if (dataUrl.length > MAX_AVATAR_BYTES) {
        return reply.code(413).send({ error: "Avatar too large" });
      }
    }

    const [updated] = await db
      .update(users)
      .set({ avatarDataUrl: dataUrl, updatedAt: new Date() })
      .where(eq(users.id, me.id))
      .returning();
    if (!updated) return reply.code(500).send({ error: "Failed to update avatar" });
    return { user: toPublic(updated) };
  });

  // Best-effort cleanup of expired sessions on startup. Cheap because of
  // the expires_at index.
  await db.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
}
