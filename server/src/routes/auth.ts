import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, sessions } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../util/password.js";
import { randomToken } from "../util/hash.js";
import { bearerToken, resolveSession, hashSessionToken } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";

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

async function createSession(userId: string): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Nur den HASH persistieren — das Roh-Token sieht ausschließlich der Client.
  await db.insert(sessions).values({ token: hashSessionToken(token), userId, expiresAt });
  return token;
}

/** IP-basierte Limits für die unauthentifizierten Auth-Endpoints — hier gibt
 *  es noch kein Konto als Anker. Bremst Brute-Force (login) und Konto-
 *  Enumeration (check-email). Zahlen großzügig genug für legitime Tippfehler. */
const AUTH_LIMITS = {
  checkEmail: { limit: 20, windowMs: 15 * 60 * 1000 },
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  register: { limit: 5, windowMs: 60 * 60 * 1000 },
} as const;

export async function authRoutes(app: FastifyInstance) {
  app.post("/api/auth/check-email", async (req, reply) => {
    const rl = rateLimit("auth-check-email", req.ip, AUTH_LIMITS.checkEmail.limit, AUTH_LIMITS.checkEmail.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
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
    const rl = rateLimit("auth-register", req.ip, AUTH_LIMITS.register.limit, AUTH_LIMITS.register.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
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
    const rl = rateLimit("auth-login", req.ip, AUTH_LIMITS.login.limit, AUTH_LIMITS.login.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
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
      await db.delete(sessions).where(eq(sessions.token, hashSessionToken(token)));
    }
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req, reply) => {
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const me = await resolveSession(token);
    if (!me) return reply.code(401).send({ error: "Invalid or expired session" });
    // Avatar separat nachladen — resolveSession lässt die schwere Spalte
    // bewusst weg (siehe Kommentar dort). /me ist der einzige Endpoint der
    // sie braucht, und der wird nur beim App-Start aufgerufen.
    const [avatarRow] = await db
      .select({ avatarDataUrl: users.avatarDataUrl })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1);
    const user: PublicUser = { ...me, avatarDataUrl: avatarRow?.avatarDataUrl ?? null };
    return { user };
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
  // Einmalige Migration: Sessions aus der Klartext-Ära (Token ≠ sha256-Hex)
  // sind nach der Hash-Umstellung unerreichbar — direkt löschen.
  await db.delete(sessions).where(sql`${sessions.token} !~ '^[0-9a-f]{64}$'`);
}
