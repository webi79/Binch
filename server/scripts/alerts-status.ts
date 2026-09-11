/**
 * Der Zustand der Alarm-Kette in einem Blick — ohne etwas zu verschicken.
 *
 * Gedacht für die Frage „ist die letzte Meile bewiesen?". Sie ist es genau
 * dann, wenn eine Kennung eine Bestätigung trägt: Alles davor (Firebase nimmt
 * an, Nachrichten-Kennung kommt zurück) beweist nur, dass die Nachricht in der
 * Warteschlange lag.
 *
 *   npm run alerts:status
 */
import { desc } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { priceAlerts, pushTokens } from "../src/db/schema.js";

const tokens = await db
  .select({
    token: pushTokens.token,
    platform: pushTokens.platform,
    createdAt: pushTokens.createdAt,
    lastDeliveredAt: pushTokens.lastDeliveredAt,
    lastTappedAt: pushTokens.lastTappedAt,
    deviceModel: pushTokens.deviceModel,
  })
  .from(pushTokens)
  .orderBy(desc(pushTokens.updatedAt))
  .limit(10);

console.log(`Geräte: ${tokens.length}`);
for (const d of tokens) {
  const t = d.token;
  console.log(`  ${d.deviceModel ?? "unbekanntes Gerät"}  —  ${t.slice(0, 12)}…${t.slice(-6)}  (${d.platform ?? "?"})`);
  console.log(`     registriert:  ${d.createdAt?.toISOString() ?? "?"}`);
  console.log(`     empfangen:    ${d.lastDeliveredAt?.toISOString() ?? "— noch nie bestätigt"}`);
  console.log(`     angetippt:    ${d.lastTappedAt?.toISOString() ?? "— noch nie"}`);
}

const alerts = await db
  .select({
    mode: priceAlerts.mode,
    originLabel: priceAlerts.originLabel,
    destLabel: priceAlerts.destLabel,
    departDate: priceAlerts.departDate,
    desiredPrice: priceAlerts.desiredPrice,
    currency: priceAlerts.currency,
    lastSeenPrice: priceAlerts.lastSeenPrice,
    lastNotifiedAt: priceAlerts.lastNotifiedAt,
    active: priceAlerts.active,
  })
  .from(priceAlerts)
  .orderBy(desc(priceAlerts.createdAt))
  .limit(20);

console.log(`\nAlarme: ${alerts.length}`);
for (const a of alerts) {
  console.log(
    `  [${a.mode}] ${a.originLabel} – ${a.destLabel} am ${a.departDate}` +
      `  ≤ ${a.desiredPrice} ${a.currency}` +
      `  | zuletzt gesehen: ${a.lastSeenPrice ?? "—"}` +
      `  | gemeldet: ${a.lastNotifiedAt?.toISOString() ?? "—"}` +
      `${a.active ? "" : "  (inaktiv)"}`,
  );
}

const proven = tokens.some((d) => d.lastDeliveredAt || d.lastTappedAt);
console.log(
  `\nLetzte Meile: ${proven ? "NACHGEWIESEN — ein Gerät hat den Empfang bestätigt." : "noch offen — keine Bestätigung eines Geräts."}`,
);
await pool.end();
process.exit(0);
