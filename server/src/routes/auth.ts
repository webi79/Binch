import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, sessions, userIdentities } from "../db/schema.js";
import { hashPassword, verifyPassword } from "../util/password.js";
import { randomToken } from "../util/hash.js";
import { bearerToken, resolveSession, hashSessionToken } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";
import { verifyOAuthIdToken, OAuthVerifyError } from "../services/oauthVerify.js";

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const registerSchema = z.object({
  email: z.string().email().max(255).transform((s) => s.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  firstName: z.string().min(1).max(80).transform((s) => s.trim()),
  lastName: z.string().min(1).max(80).transform((s) => s.trim()),
});

/**
 * Namen kommen NUR bei Apple aus dem Client (das Token trägt sie nicht) und
 * sind reine Anzeigedaten — begrenzt, aber unkritisch. Das Token selbst ist
 * großzügig begrenzt: Apple- und Google-Token liegen bei 1-2 KB, alles darüber
 * ist kein Token.
 */
const oauthSchema = z.object({
  provider: z.enum(["google", "apple"]),
  idToken: z.string().min(20).max(8192),
  // Getrimmt und leere Zeichenketten zu `undefined`: Sonst legte ein vom Client
  // geschicktes `firstName: ""` ein Konto mit leerem Vornamen an — `??` fängt
  // nur `null`/`undefined`, nicht den Leerstring.
  firstName: z.string().max(80).transform((v) => v.trim() || undefined).optional(),
  lastName: z.string().max(80).transform((v) => v.trim() || undefined).optional(),
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

// Einmal berechneter, gecachter argon2-Hash gegen den bei nicht-existenten
// Usern verifiziert wird — allein zum Angleichen der Login-Antwortzeit (siehe
// Timing-Oracle im Login-Handler). Lazy, damit das teure Hashing nicht bei jedem
// Server-Start läuft, sondern erst beim ersten Fehl-Login.
let dummyHashCache: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  if (!dummyHashCache) dummyHashCache = hashPassword("binch-timing-equalizer-not-a-real-password");
  return dummyHashCache;
}

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
  /**
   * Höher als beim Registrieren, obwohl auch dieser Weg Konten anlegen kann.
   *
   * Der Grund: Hier zählt JEDER Aufruf, auch der erfolgreiche — und ein Nutzer
   * braucht oft mehrere. Er probiert ein zweites Google-Konto, weil das erste
   * schon ein Passwort-Konto ist; er meldet sich ab und wieder an; er tippt
   * doppelt. Mit 10 war das nach ein paar Minuten Ausprobieren erschöpft, und
   * danach kam die Absage, bevor das Token überhaupt angesehen wurde.
   *
   * Missbrauch bremst das weiterhin: Wer Konten anlegen will, braucht für JEDES
   * ein eigenes, echtes Google-Konto — die Ratenbegrenzung ist hier nicht die
   * einzige Hürde, sondern die zweite.
   */
  oauth: { limit: 30, windowMs: 60 * 60 * 1000 },
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
      // Timing-Oracle schließen: Ohne diesen Dummy-Verify kehrt „User existiert
      // nicht" SOFORT zurück, während „User existiert, PW falsch" erst den
      // ~50-100 ms teuren argon2-Verify durchläuft. An dieser Zeitdifferenz
      // könnte ein Angreifer trotz generischer Fehlermeldung enumerieren, welche
      // E-Mails registriert sind. Wir verifizieren daher gegen einen konstanten
      // Dummy-Hash, damit beide Pfade gleich lange brauchen.
      await verifyPassword(password, await dummyPasswordHash());
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    /**
     * Konten OHNE Passwort können sich nicht mit Passwort anmelden.
     *
     * `passwordHash` ist nullable, seit es Apple und Google gibt: Wer sich nur
     * über einen Anbieter angemeldet hat, hat hier nie eins gesetzt. Der Dummy-
     * Verify muss trotzdem laufen — sonst kehrt genau dieser Fall sofort zurück
     * und verrät über die Antwortzeit, dass es das Konto gibt und wie es
     * angelegt wurde. Dieselbe Begründung wie beim unbekannten Konto oben.
     */
    if (user.passwordHash == null) {
      await verifyPassword(password, await dummyPasswordHash());
      return reply.code(401).send({ error: "Invalid credentials" });
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = await createSession(user.id);
    return { token, user: toPublic(user) };
  });

  /**
   * Anmeldung über Apple oder Google.
   *
   * Der Client hat beim Anbieter ein ID-Token geholt und schickt es hier hin.
   * Was mit dem Token passiert, steht in `services/oauthVerify.ts` — kurz: Es
   * wird gegen den öffentlichen Schlüsselsatz des Anbieters geprüft, samt
   * Aussteller, Empfänger und Gültigkeit. Erst danach darf irgendetwas anderes
   * passieren.
   */
  app.post("/api/auth/oauth", async (req, reply) => {
    // Dasselbe Limit wie beim Registrieren: Der Endpunkt kann Konten anlegen.
    const rl = rateLimit("auth-oauth", req.ip, AUTH_LIMITS.oauth.limit, AUTH_LIMITS.oauth.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
    const parsed = oauthSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { provider, idToken, firstName, lastName } = parsed.data;

    let identity;
    try {
      identity = await verifyOAuthIdToken(provider, idToken);
    } catch (err) {
      const unconfigured = err instanceof OAuthVerifyError && err.reason === "unconfigured";
      // Den GRUND nur ins Log, nie an den Client: Ob ein Token abgelaufen,
      // falsch signiert oder für eine fremde App ausgestellt war, ist genau die
      // Rückmeldung, mit der man eine Umgehung Schritt für Schritt austestet.
      req.log.warn({ err, provider }, "OAuth-Token abgelehnt");
      return reply
        .code(unconfigured ? 503 : 401)
        .send({ error: unconfigured ? "Provider not configured" : "Invalid credentials" });
    }

    // 1. Kennt der Anbieter dieses Konto bei uns schon? Das ist der Normalfall
    //    ab der zweiten Anmeldung.
    const [existing] = await db
      .select()
      .from(userIdentities)
      .where(
        and(
          eq(userIdentities.provider, identity.provider),
          eq(userIdentities.providerUserId, identity.subject),
        ),
      )
      .limit(1);

    if (existing) {
      const [user] = await db.select().from(users).where(eq(users.id, existing.userId)).limit(1);
      if (!user) {
        // Verwaiste Verknüpfung — kann nur durch einen Datenfehler entstehen.
        req.log.error({ identityId: existing.id }, "Verknüpfung ohne Konto");
        return reply.code(401).send({ error: "Invalid credentials" });
      }
      const token = await createSession(user.id);
      return { token, user: toPublic(user) };
    }

    /**
     * 2. Neu. Jetzt die heikle Frage: Gibt es schon ein Konto mit dieser
     *    E-Mail, und dürfen wir daran andocken?
     *
     * NUR wenn der Anbieter die E-Mail ausdrücklich als BESTÄTIGT meldet.
     * Ohne diese Bedingung wäre die Funktion eine Konto-Übernahme: Wer bei
     * einem Anbieter eine unbestätigte Adresse einträgt, die bei uns schon
     * einem Konto gehört, käme sonst in dieses fremde Konto. Meldet der
     * Anbieter die Adresse nicht als bestätigt, verknüpfen wir NICHT. Ein
     * eigenes Konto entsteht dann auch nicht — `users.email` ist eindeutig —,
     * sondern der Fall endet unten in einer klaren 409-Antwort.
     */
    if (identity.email && identity.emailVerified) {
      const [byEmail] = await db
        .select()
        .from(users)
        .where(eq(users.email, identity.email))
        .limit(1);
      if (byEmail) {
        /**
         * NUR an Konten andocken, die selbst über einen Anbieter entstanden
         * sind (`passwordHash === null`).
         *
         * Der Grund ist nicht Vorsicht, sondern eine konkrete Übernahme:
         * `/api/auth/register` legt ein Konto mit beliebiger E-Mail an, und es
         * gibt in diesem Server KEINE E-Mail-Bestätigung. „Diese Adresse gehört
         * diesem Konto" ist bei einem Passwort-Konto also eine unbelegte
         * Behauptung des Registrierenden.
         *
         * Wer sich fremd registriert und wartet, bekäme sonst genau das: Meldet
         * sich die echte Person später über Google an, hinge ihre BESTÄTIGTE
         * Identität am unbestätigten Konto des Angreifers — der über sein
         * Passwort und seine alte Sitzung weiter Zugriff hat. Die schwächere
         * Seite gewönne.
         *
         * Bei einem Konto ohne Passwort stellt sich die Frage nicht: Es ist
         * selbst nur über ein signiertes Anbieter-Token entstanden, seine
         * E-Mail ist also bereits bewiesen.
         */
        if (byEmail.passwordHash !== null) {
          return reply.code(409).send({ error: "Email already registered" });
        }
        await db.insert(userIdentities).values({
          userId: byEmail.id,
          provider: identity.provider,
          providerUserId: identity.subject,
          email: identity.email,
        });
        const token = await createSession(byEmail.id);
        return { token, user: toPublic(byEmail) };
      }
    }

    // 3. Neues Konto.
    //
    // Ohne E-Mail geht das nicht: Sie ist bei uns Pflicht und eindeutig. Apple
    // liefert sie nur bei der ALLERERSTEN Anmeldung mit — kommt hier nichts an,
    // hat der Nutzer die App bei Apple schon einmal verbunden und muss die
    // Verknüpfung dort erst lösen. Das sagen wir ihm auch so.
    if (!identity.email) {
      return reply.code(409).send({ error: "No email from provider" });
    }

    // Namen: Google schickt sie im Token, Apple NUR beim ersten Mal und dann im
    // Client, nicht im Token. Deshalb nimmt die Route sie zusätzlich entgegen —
    // sie sind reine Anzeigedaten und werden nie für Zugriffsentscheidungen
    // benutzt, dürfen also aus dem Client kommen.
    const first = identity.firstName ?? firstName ?? identity.email.split("@")[0] ?? "Gast";
    const last = identity.lastName ?? lastName ?? "";

    /**
     * Zwei gleichzeitige Anmeldungen mit demselben Token dürfen nicht als 500
     * enden.
     *
     * Beide lesen oben „keine Identität" und laufen weiter; die zweite schlägt
     * beim Einfügen gegen den eindeutigen Index auf. Ohne Behandlung reicht
     * Fastify die Postgres-Meldung samt Constraint-Namen nach außen — und der
     * Nutzer sieht einen Absturz, obwohl seine Anmeldung eigentlich in Ordnung
     * war. Der Index verhindert weiterhin zuverlässig doppelte Konten; hier
     * geht es darum, den Verstoß als das zu behandeln, was er ist: Jemand war
     * eine Millisekunde schneller.
     */
    let created: typeof users.$inferSelect;
    try {
      created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: identity.email!,
          // KEIN Platzhalter-Hash: Das Konto hat kein Passwort, und genau das
          // soll in der Datenbank stehen. Siehe Kommentar am Schema.
          passwordHash: null,
          firstName: first.slice(0, 80),
          lastName: last.slice(0, 80),
        })
        .returning();
      // `returning()` ist typseitig ein Array — nach einem `insert` mit genau
      // einem Wert kann es nicht leer sein, TypeScript weiß das nur nicht.
      if (!user) throw new Error("Konto konnte nicht angelegt werden");
      await tx.insert(userIdentities).values({
        userId: user.id,
        provider: identity.provider,
        providerUserId: identity.subject,
        email: identity.email,
      });
      return user;
      });
    } catch (err) {
      // Verstoß gegen einen eindeutigen Index (Postgres-Code 23505). Der
      // Normalfall dahinter: Ein paralleler Aufruf war schneller. Wir lesen die
      // inzwischen angelegte Verknüpfung neu und melden ganz normal an — das
      // macht den Endpunkt idempotent statt fehleranfällig.
      const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
        ?? (err as { code?: string })?.code;
      if (code !== "23505") throw err;

      const [again] = await db
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.provider, identity.provider),
            eq(userIdentities.providerUserId, identity.subject),
          ),
        )
        .limit(1);
      if (again) {
        const [u] = await db.select().from(users).where(eq(users.id, again.userId)).limit(1);
        if (u) {
          const t = await createSession(u.id);
          return { token: t, user: toPublic(u) };
        }
      }
      // Kein Wettlauf, sondern eine bereits vergebene E-Mail — etwa wenn der
      // Anbieter sie nicht als bestätigt meldet und oben deshalb nicht
      // verknüpft wurde. Klare Ansage statt Absturz.
      req.log.warn({ provider }, "OAuth: E-Mail bereits vergeben");
      return reply.code(409).send({ error: "Email already registered" });
    }

    const token = await createSession(created.id);
    // Bewusst 200 wie die anderen beiden Zweige. Mit 201 verriet der Endpunkt,
    // ob die Adresse vorher schon im System war — und genau das ist die
    // Information, die niemand von außen bekommen soll.
    return { token, user: toPublic(created) };
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
