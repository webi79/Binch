/**
 * DAS KONTO SELBST — Daten herunterladen und Konto löschen.
 *
 * Beides verlangt die DSGVO (Art. 20 Übertragbarkeit, Art. 17 Löschung), und
 * beide App-Läden verlangen das Löschen IN der App, sobald man darin ein Konto
 * anlegen kann. Erreichbar in der App unter Profil → Deine Daten.
 *
 * Gelöscht wird SOFORT und vollständig, ohne Wartefrist: Jede Tabelle, die an
 * einem Konto hängt, verweist mit `ON DELETE CASCADE` auf `users` (Sitzungen,
 * Anmelde-Verknüpfungen, Bos Gedächtnis, Chats samt Nachrichten, verknüpfte
 * Geräte samt deren Preisalarmen, Preisalarme des Kontos). Ein einziges
 * `DELETE` reicht also, und eine Tabelle, die künftig dazukommt, ist nur dann
 * dabei, wenn sie ebenso verweist — wer eine anlegt, muss das hier prüfen.
 * `search_requests.user_id` hat keinen Verweis, wird aber auch nie
 * geschrieben (siehe `runLive` in searchService.ts).
 */
import type { FastifyInstance } from "fastify";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  boMemories,
  chatConversations,
  chatMessages,
  priceAlerts,
  pushTokens,
  sessions,
  userIdentities,
  users,
} from "../db/schema.js";
import { bearerToken, resolveSession } from "../services/authSession.js";
import { rateLimit } from "../util/rateLimit.js";
import { remindersOfDevices } from "../services/tripReminders.js";
import { tasksForExport } from "../services/boTasks.js";

/** Ein Export ist teuer (alle Chats), ein Löschversuch selten — beides knapp begrenzt. */
const EXPORT_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 };
const DELETE_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

export async function accountRoutes(app: FastifyInstance) {
  /**
   * Alles, was der Server über dieses Konto weiß, als EINE JSON-Datei.
   *
   * Lesbar statt vollständig roh: Kennwort-Hash, Sitzungs-Schlüssel und
   * Push-Kennungen fehlen bewusst — sie sind Zugangsdaten, keine Angaben über
   * den Menschen, und in einer Datei, die per Mail oder Cloud weiterwandert,
   * wären sie ein Risiko. Dass es sie gibt, steht trotzdem drin (Sitzungen,
   * Geräte, Anmeldearten).
   */
  app.get("/api/auth/me/export", async (req, reply) => {
    const rl = rateLimit("account-export", req.ip, EXPORT_LIMIT.limit, EXPORT_LIMIT.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const me = await resolveSession(token);
    if (!me) return reply.code(401).send({ error: "Invalid or expired session" });

    const [profile] = await db
      .select({
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        avatarDataUrl: users.avatarDataUrl,
        boMemoryEnabled: users.boMemoryEnabled,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, me.id))
      .limit(1);
    if (!profile) return reply.code(404).send({ error: "Not found" });

    const [identities, sessionRows, memory, conversations, devices, alerts] = await Promise.all([
      db
        .select({ provider: userIdentities.provider, email: userIdentities.email, createdAt: userIdentities.createdAt })
        .from(userIdentities)
        .where(eq(userIdentities.userId, me.id)),
      db
        .select({ createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.userId, me.id))
        .orderBy(desc(sessions.lastSeenAt)),
      db
        .select({ content: boMemories.content, createdAt: boMemories.createdAt, updatedAt: boMemories.updatedAt })
        .from(boMemories)
        .where(eq(boMemories.userId, me.id))
        .orderBy(asc(boMemories.createdAt)),
      db
        .select({
          id: chatConversations.id,
          title: chatConversations.title,
          locale: chatConversations.locale,
          createdAt: chatConversations.createdAt,
          lastMessageAt: chatConversations.lastMessageAt,
          pinnedAt: chatConversations.pinnedAt,
          archivedAt: chatConversations.archivedAt,
        })
        .from(chatConversations)
        .where(eq(chatConversations.userId, me.id))
        .orderBy(asc(chatConversations.createdAt)),
      db
        .select({
          id: pushTokens.id,
          platform: pushTokens.platform,
          deviceModel: pushTokens.deviceModel,
          locale: pushTokens.locale,
          timezone: pushTokens.timezone,
          notificationsEnabled: pushTokens.notificationsEnabled,
          priceAlertsEnabled: pushTokens.priceAlertsEnabled,
          createdAt: pushTokens.createdAt,
          updatedAt: pushTokens.updatedAt,
        })
        .from(pushTokens)
        .where(eq(pushTokens.userId, me.id)),
      db
        .select({
          mode: priceAlerts.mode,
          origin: priceAlerts.origin,
          destination: priceAlerts.destination,
          originLabel: priceAlerts.originLabel,
          destLabel: priceAlerts.destLabel,
          departDate: priceAlerts.departDate,
          returnDate: priceAlerts.returnDate,
          passengers: priceAlerts.passengers,
          travelClass: priceAlerts.travelClass,
          currency: priceAlerts.currency,
          basePrice: priceAlerts.basePrice,
          desiredPrice: priceAlerts.desiredPrice,
          notifyOnRise: priceAlerts.notifyOnRise,
          active: priceAlerts.active,
          lastSeenPrice: priceAlerts.lastSeenPrice,
          lastNotifiedAt: priceAlerts.lastNotifiedAt,
          createdAt: priceAlerts.createdAt,
        })
        .from(priceAlerts)
        .where(eq(priceAlerts.userId, me.id)),
    ]);

    // Nachrichten in EINER Abfrage für alle Chats, dann zugeordnet.
    const convIds = conversations.map((c) => c.id);
    const messages =
      convIds.length === 0
        ? []
        : await db
            .select({
              conversationId: chatMessages.conversationId,
              role: chatMessages.role,
              kind: chatMessages.kind,
              content: chatMessages.content,
              payload: chatMessages.payload,
              createdAt: chatMessages.createdAt,
            })
            .from(chatMessages)
            .where(inArray(chatMessages.conversationId, convIds))
            .orderBy(asc(chatMessages.conversationId), asc(chatMessages.seq));
    const byConv = new Map<string, Omit<(typeof messages)[number], "conversationId">[]>();
    for (const { conversationId, ...m } of messages) {
      const list = byConv.get(conversationId) ?? [];
      list.push(m);
      byConv.set(conversationId, list);
    }

    // Noch wartende Erinnerungen der Geräte dieses Kontos.
    const reminders = await remindersOfDevices(devices.map((d) => d.id));
    // Bos geplante Aufgaben (ohne Läufe — die sind kurzlebige Meldungen).
    const boTasks = await tasksForExport(me.id);

    const exportedAt = new Date();
    const file = {
      format: "binch-account-export",
      version: 1,
      exportedAt: exportedAt.toISOString(),
      // Was nur auf dem Gerät liegt (gespeicherte Reisen, Suchverlauf,
      // Einstellungen), hängt die App selbst als `device` an.
      profile,
      signInMethods: identities,
      sessions: sessionRows,
      bo: { memoryEnabled: profile.boMemoryEnabled, memory, tasks: boTasks },
      chats: conversations.map(({ id, ...c }) => ({ ...c, messages: byConv.get(id) ?? [] })),
      devices: devices.map(({ id: _id, ...d }) => d),
      reminders,
      priceAlerts: alerts,
    };

    const day = exportedAt.toISOString().slice(0, 10);
    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="binch-daten-${day}.json"`)
      .header("Cache-Control", "no-store")
      .send(JSON.stringify(file, null, 2));
  });

  /**
   * Konto löschen — endgültig.
   *
   * Die App fragt zweimal nach, bevor sie das schickt; hier genügt eine
   * gültige Sitzung. Danach gibt es das Konto nicht mehr: dieselbe
   * E-Mail-Adresse kann sich neu registrieren und beginnt leer.
   */
  app.delete("/api/auth/me", async (req, reply) => {
    const rl = rateLimit("account-delete", req.ip, DELETE_LIMIT.limit, DELETE_LIMIT.windowMs);
    if (!rl.allowed) {
      return reply.code(429).header("Retry-After", rl.retryAfterSec).send({ error: "Too many requests" });
    }
    const token = bearerToken(req);
    if (!token) return reply.code(401).send({ error: "Unauthorized" });
    const me = await resolveSession(token);
    if (!me) return reply.code(401).send({ error: "Invalid or expired session" });

    const deleted = await db.delete(users).where(eq(users.id, me.id)).returning({ id: users.id });
    if (deleted.length === 0) return reply.code(404).send({ error: "Not found" });
    req.log.info({ account: "deleted" }, "account deleted");
    return reply.code(204).send();
  });
}
