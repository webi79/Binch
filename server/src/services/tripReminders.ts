/**
 * Versand der Abfahrts- und Ausstiegs-Erinnerungen (Tabelle `trip_reminders`).
 *
 * Alle 30 Sekunden: fällige Zeilen holen und dabei LÖSCHEN (ein Schritt —
 * keine Erinnerung geht zweimal raus, auch wenn ein Lauf länger braucht),
 * abgelaufene oder abgeschaltete still verwerfen, den Rest über Firebase
 * schicken. Die Frist für Firebase ist die Zeit bis zum Ablauf: Eine
 * Abfahrts-Erinnerung, die erst nach der Abfahrt ankäme, soll gar nicht kommen.
 *
 * Kein Nachholen nach einem Fehlschlag: Ging Firebase nicht, ist die Zeile
 * trotzdem weg. Eine Erinnerung zehn Minuten zu spät ist schlimmer als keine.
 */
import { eq, inArray, lte } from "drizzle-orm";
import { db } from "../db/client.js";
import { pushTokens, tripReminders } from "../db/schema.js";
import { sendPush, type PushMessage } from "./priceAlerts.js";

const INTERVAL_MS = 30_000;
const BATCH = 200;
/** Der Kanal, den die App für Erinnerungen anlegt (lib/notifications/tripReminders.ts). */
const CHANNEL = "trip-reminders";

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    // Fällige Zeilen in EINEM Schritt nehmen und löschen.
    const due = await db
      .delete(tripReminders)
      .where(
        inArray(
          tripReminders.id,
          db
            .select({ id: tripReminders.id })
            .from(tripReminders)
            .where(lte(tripReminders.fireAt, now))
            .orderBy(tripReminders.fireAt)
            .limit(BATCH),
        ),
      )
      .returning();
    if (due.length === 0) return;

    const devices = await db
      .select({ id: pushTokens.id, token: pushTokens.token, on: pushTokens.notificationsEnabled })
      .from(pushTokens)
      .where(inArray(pushTokens.id, [...new Set(due.map((r) => r.pushTokenId))]));
    const byId = new Map(devices.map((d) => [d.id, d]));

    const messages: PushMessage[] = [];
    let off = 0;
    let expired = 0;
    for (const r of due) {
      const device = byId.get(r.pushTokenId);
      const ttlMs = r.expiresAt.getTime() - now.getTime();
      // Abgelaufen oder Meldungen am Gerät aus: verwerfen, nicht schicken.
      if (!device || !device.on) {
        off++;
        continue;
      }
      if (ttlMs <= 0) {
        expired++;
        continue;
      }
      messages.push({
        to: device.token,
        title: r.title,
        body: r.body,
        tag: `reminder:${r.key}`,
        channelId: CHANNEL,
        data: { type: "tripReminder", kind: r.kind, key: r.key },
        ttlMs,
      });
    }
    // Verworfenes belegen — sonst sähe es im Protokoll aus, als sei nichts fällig gewesen.
    if (off + expired > 0) {
      // eslint-disable-next-line no-console
      console.log(`[tripReminders] ${due.length} fällig, verworfen: ${off} Meldungen aus, ${expired} abgelaufen`);
    }
    if (messages.length > 0) await sendPush(messages);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[tripReminders] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startReminderLoop(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref?.();
}

export function stopReminderLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Alle Erinnerungen eines Geräts durch die neue Liste ersetzen. */
export async function replaceReminders(
  pushTokenId: string,
  items: { key: string; kind: string; fireAt: Date; expiresAt: Date; title: string; body: string }[],
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.delete(tripReminders).where(eq(tripReminders.pushTokenId, pushTokenId));
    if (items.length === 0) return 0;
    const rows = await tx
      .insert(tripReminders)
      .values(items.map((i) => ({ ...i, pushTokenId })))
      .onConflictDoNothing()
      .returning({ id: tripReminders.id });
    return rows.length;
  });
}

/** Für die Datenauskunft: die noch wartenden Erinnerungen der Geräte eines Kontos. */
export async function remindersOfDevices(pushTokenIds: string[]) {
  if (pushTokenIds.length === 0) return [];
  return db
    .select({
      kind: tripReminders.kind,
      fireAt: tripReminders.fireAt,
      title: tripReminders.title,
      body: tripReminders.body,
    })
    .from(tripReminders)
    .where(inArray(tripReminders.pushTokenId, pushTokenIds));
}
