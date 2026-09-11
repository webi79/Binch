/**
 * Was weiß Firebase über die registrierten Kennungen — OHNE etwas zuzustellen?
 *
 * Bei „es kommt nichts an" gibt es drei mögliche Bruchstellen, und sie sehen
 * von außen gleich aus:
 *
 *   1. Firebase kennt die Kennung nicht mehr (Neuinstallation, App gelöscht).
 *   2. Firebase nimmt die Nachricht an, das Gerät verwirft sie (Kanal fehlt,
 *      Meldungen abgeschaltet, Energiesparen).
 *   3. Die Nachricht liegt in der Warteschlange, das Gerät schläft.
 *
 * Der TROCKENLAUF (`dryRun`) trennt Fall 1 von 2 und 3: Firebase prüft die
 * Kennung vollständig, stellt aber nichts zu. Kommt hier eine Kennungs-Nummer
 * zurück, LEBT die Kennung — dann liegt der Fehler auf dem Gerät, nicht im
 * Server und nicht in der Datenbank.
 *
 *   npx tsx --env-file=.env scripts/alerts-diagnose.ts
 *
 * Es geht KEINE Meldung an irgendein Gerät.
 */
import admin from "firebase-admin";
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { priceAlerts, pushTokens } from "../src/db/schema.js";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT fehlt in .env — ohne Zugangsdaten geht hier nichts.");
  await pool.end();
  process.exit(1);
}
const app = admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
});

const short = (t: string) => `${t.slice(0, 12)}…${t.slice(-6)}`;
const iso = (d: Date | null | undefined) => d?.toISOString() ?? "—";

const toks = await db.select().from(pushTokens).orderBy(desc(pushTokens.updatedAt));
console.log(`${toks.length} Kennung(en), neueste zuerst. Trockenlauf — es wird nichts zugestellt.\n`);

let alive = 0;
for (const [i, t] of toks.entries()) {
  const n = await db
    .select({ id: priceAlerts.id })
    .from(priceAlerts)
    .where(eq(priceAlerts.pushTokenId, t.id));
  const active = n.length;
  let verdict: string;
  try {
    const id = await app.messaging().send(
      {
        token: t.token,
        notification: { title: "Trockenlauf", body: "wird nicht zugestellt" },
        android: { notification: { channelId: "price-alerts" } },
      },
      true, // dryRun
    );
    alive += 1;
    verdict = `LEBT — Firebase würde zustellen (${id.split("/").pop()})`;
  } catch (e) {
    const code = (e as { errorInfo?: { code?: string } }).errorInfo?.code ?? String(e);
    verdict = `TOT — ${code}`;
  }
  console.log(
    `${i + 1}. ${t.deviceModel ?? "unbekanntes Gerät"}  ${short(t.token)}  loc=${t.locale ?? "—"}  Alarme=${active}\n` +
      `   angelegt ${iso(t.createdAt)}  gemeldet ${iso(t.updatedAt)}\n` +
      `   empfangen ${iso(t.lastDeliveredAt)}  angetippt ${iso(t.lastTappedAt)}\n` +
      `   ${verdict}`,
  );
}

console.log(
  `\n${alive} von ${toks.length} Kennungen leben bei Firebase.\n` +
    (alive > 0
      ? "Lebt die NEUESTE Kennung und kommt trotzdem nichts an, liegt es auf dem GERÄT:\n" +
        "  • Einstellungen → Apps → Binch → Benachrichtigungen: gibt es dort „Preis-Alarme“?\n" +
        "    Fehlt der Kanal oder ist er aus, verwirft Android die Meldung lautlos.\n" +
        "  • Akku/Energiesparen: ist die App „eingeschränkt“, hält das System sie zurück."
      : "Keine lebende Kennung — die App muss sich neu anmelden (einmal öffnen)."),
);
await pool.end();
process.exit(0);
