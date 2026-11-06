/**
 * TEST-MITTEILUNG — Profil → Einstellungen → Mitteilungen.
 *
 * Ob eine Mitteilung auf dem Handy ERSCHEINT, weiß nur das Handy: Firebase
 * nimmt auch an, was der Hersteller danach verwirft. Der Server schickt die
 * Test-Mitteilung nach `delaySec` über denselben Weg und Kanal wie die
 * Erinnerungen — so lässt sie sich auch bei geschlossener App prüfen
 * (server/src/routes/alerts.ts, `POST /api/alerts/test`).
 */
import { API_BASE_URL } from "@/lib/api/client";
import { registeredPushToken } from "@/lib/notifications/push";
import { prepareReminderChannel } from "@/lib/notifications/tripReminders";

export const TEST_DELAY_SEC = 10;

export type TestPushResult = "queued" | "noToken" | "tooSoon" | "failed";

export async function sendTestPush(title: string, body: string): Promise<TestPushResult> {
  await prepareReminderChannel();
  const token = await registeredPushToken();
  if (!token) return "noToken";
  try {
    const res = await fetch(`${API_BASE_URL}/api/alerts/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Push-Token": token },
      body: JSON.stringify({ title, body, delaySec: TEST_DELAY_SEC }),
    });
    if (res.status === 429) return "tooSoon";
    return res.ok ? "queued" : "failed";
  } catch {
    return "failed";
  }
}
