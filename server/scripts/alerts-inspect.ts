/**
 * NUR LESEN: Welcher Alarm hängt an welcher Kennung?
 *
 * `alerts:status` zeigt Geräte und Alarme getrennt — die entscheidende Frage
 * bei „keine Meldung kommt an" ist aber die VERBINDUNG: Ein Alarm, der noch an
 * der Kennung einer alten Installation hängt, wird von Firebase anstandslos
 * angenommen und trotzdem nirgends zugestellt.
 *
 *   npx tsx --env-file=.env scripts/alerts-inspect.ts
 */
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { priceAlerts, pushTokens } from "../src/db/schema.js";

const short = (t: string) => `${t.slice(0, 12)}…${t.slice(-6)}`;
const iso = (d: Date | null | undefined) => d?.toISOString() ?? "—";

const toks = await db.select().from(pushTokens).orderBy(desc(pushTokens.updatedAt));
console.log(`Kennungen: ${toks.length} (neueste zuerst)`);
toks.forEach((t, i) => {
  console.log(
    `  ${i + 1}. ${t.deviceModel ?? "unbekanntes Gerät"}  —  ${short(t.token)}  ${t.platform}  loc=${t.locale ?? "—"}  tz=${t.timezone ?? "—"}\n` +
      `      angelegt ${iso(t.createdAt)}  gemeldet ${iso(t.updatedAt)}\n` +
      `      empfangen ${iso(t.lastDeliveredAt)}  angetippt ${iso(t.lastTappedAt)}`,
  );
});

console.log("\nAlarme:");
const rows = await db
  .select({ a: priceAlerts, tok: pushTokens.token, upd: pushTokens.updatedAt })
  .from(priceAlerts)
  .innerJoin(pushTokens, eq(pushTokens.id, priceAlerts.pushTokenId));
if (rows.length === 0) console.log("  (keine)");
for (const r of rows) {
  const rank = toks.findIndex((t) => t.token === r.tok) + 1;
  console.log(
    `  [${r.a.mode}] ${r.a.originLabel} – ${r.a.destLabel} ${r.a.departDate}${r.a.returnDate ? ` / ${r.a.returnDate}` : ""}\n` +
      `      aktiv=${r.a.active}  Grundpreis ${r.a.basePrice}  Schwelle ${r.a.desiredPrice} ${r.a.currency}` +
      `  pax=${r.a.passengers}  cls="${r.a.travelClass}"\n` +
      `      hängt an Kennung Nr. ${rank}: ${short(r.tok)}  ${rank === 1 ? "← die AKTUELLE" : "← eine ÄLTERE, dort kommt nichts an"}\n` +
      `      gemeldet ${iso(r.a.lastNotifiedAt)}  zuletzt gesehen ${r.a.lastSeenPrice ?? "—"}`,
  );
}
await pool.end();
