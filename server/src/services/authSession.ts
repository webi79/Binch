/**
 * Shared Session-Auflösung für alle Routes die einen eingeloggten User
 * brauchen (auth.ts, chat.ts, tickets.ts, …). Vorher lebte das privat in
 * auth.ts — mit kontogebundenen Rate-Limits brauchen es mehrere Routes.
 */
import type { FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, sessions } from "../db/schema.js";

/** lastSeenAt nur updaten wenn älter als das — sonst schreibt JEDER
 *  authentifizierte Request die Statistik-Spalte (Write-Amplification). */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export function bearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m && m[1] ? m[1].trim() : null;
}

/** Löst Bearer-Token → User auf. Bewusst OHNE avatarDataUrl: die Spalte kann
 *  ~800 KB Base64 halten und würde sonst bei jedem Auth-Check mit aus der DB
 *  gezogen. Endpoints die den Avatar brauchen (/me) laden ihn separat. */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      uid: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
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

  if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.token, token));
  }

  return {
    id: row.uid,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
  };
}

/** Convenience: Bearer aus dem Request ziehen und auflösen.
 *  null = kein/ungültiges Token → Route antwortet 401. */
export async function requireUser(req: FastifyRequest): Promise<SessionUser | null> {
  const token = bearerToken(req);
  if (!token) return null;
  return resolveSession(token);
}
