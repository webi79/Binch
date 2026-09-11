/**
 * Die Fehler-Einstufung gegen das ECHTE Firebase halten.
 *
 * `scripts/alerts-selftest.ts` prüft die Einstufung mit einer Attrappe: Es
 * schiebt `messaging/registration-token-not-registered` oder
 * `messaging/invalid-argument` in die Antwort und sieht nach, was der Server
 * daraufhin löscht. Das prüft die Logik — aber nicht die Annahme, auf der sie
 * steht: dass Firebase für eine unbrauchbare Kennung wirklich DIESE Codes
 * schickt und nicht andere.
 *
 * Dieses Skript schließt die Lücke. Es legt ein eigenes Gerät mit einer
 * offensichtlich erfundenen Kennung an, hängt einen Alarm auf eine erfundene
 * Strecke daran und lässt `evaluateAlerts` unverändert laufen — mit echten
 * Zugangsdaten, gegen das echte Firebase.
 *
 *   npx tsx --env-file=.env scripts/alerts-selftest-fcm.ts
 *
 * SICHERHEIT: Vor dem Versand wird geprüft, WELCHE Zeilen die Strecke trifft.
 * Ist auch nur eine dabei, deren Kennung nicht mit `selftest-` beginnt, bricht
 * das Skript ab, ohne etwas zu verschicken. An ein echtes Gerät geht hier
 * nichts.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { priceAlerts, pushTokens } from "../src/db/schema.js";
import { evaluateAlerts } from "../src/services/priceAlerts.js";

const TOKEN = "selftest-fcm-probe-0000000000";
const ORIGIN = "SELFTEST-FCM-O";
const DEST = "SELFTEST-FCM-D";
const DEPART = "2026-12-01";

async function wipe() {
  const mine = await db
    .select({ id: pushTokens.id })
    .from(pushTokens)
    .where(like(pushTokens.token, "selftest-%"));
  if (mine.length > 0) {
    const ids = mine.map((r) => r.id);
    await db.delete(priceAlerts).where(inArray(priceAlerts.pushTokenId, ids));
    await db.delete(pushTokens).where(inArray(pushTokens.id, ids));
  }
}

await wipe();

const [device] = await db
  .insert(pushTokens)
  .values({ token: TOKEN, platform: "android", locale: "de" })
  .returning({ id: pushTokens.id });

await db.insert(priceAlerts).values({
  pushTokenId: device!.id,
  mode: "TRAIN",
  origin: ORIGIN,
  destination: DEST,
  originLabel: "Selbsttest A",
  destLabel: "Selbsttest B",
  departDate: DEPART,
  returnDate: "",
  currency: "EUR",
  basePrice: "100",
  desiredPrice: "90",
  notifyOnRise: false,
});

// SICHERUNG: Wen würde diese Strecke treffen?
const targets = await db
  .select({ token: pushTokens.token })
  .from(priceAlerts)
  .innerJoin(pushTokens, eq(pushTokens.id, priceAlerts.pushTokenId))
  .where(
    and(
      eq(priceAlerts.active, true),
      eq(priceAlerts.mode, "TRAIN"),
      eq(priceAlerts.origin, ORIGIN),
      eq(priceAlerts.destination, DEST),
      eq(priceAlerts.departDate, DEPART),
      eq(priceAlerts.returnDate, ""),
    ),
  );
console.log(`Empfänger dieser Strecke: ${targets.map((t) => t.token).join(", ")}`);
if (targets.length !== 1 || !targets[0]!.token.startsWith("selftest-")) {
  console.error("ABBRUCH: unerwarteter Empfänger — es wird nichts verschickt.");
  await wipe();
  await pool.end();
  process.exit(1);
}

// Die Warnung von `sendPush` mitschneiden — dort steht der echte Fehlercode.
const warnings: string[] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
  realWarn(...args);
};

console.log("\nVerschicke über die PRODUKTIONS-Kette an eine erfundene Kennung …");
await evaluateAlerts(
  {
    mode: "TRAIN",
    origin: ORIGIN,
    destination: DEST,
    departDate: DEPART,
    currency: "EUR",
    passengers: 1,
    travelClass: "",
  },
  [{ price: 10 }],
);
console.warn = realWarn;

const [survived] = await db
  .select({ id: pushTokens.id })
  .from(pushTokens)
  .where(eq(pushTokens.token, TOKEN));

console.log("\n── Ergebnis ──");
if (warnings.length === 0) {
  console.log("Keine Warnung protokolliert.");
  console.log(
    survived
      ? "Die Kennung lebt → Firebase hat die Nachricht ANGENOMMEN oder es gibt keine Zugangsdaten."
      : "Die Kennung ist GELÖSCHT → Firebase hat sie als „nicht registriert\" eingestuft.",
  );
} else {
  for (const w of warnings) console.log(`  ${w}`);
  console.log(
    survived
      ? "\nDie Kennung LEBT: Dieser Fehler wurde NICHT als „Gerät weg\" gewertet — richtig,\n" +
          "solange es ein Fehler des Absenders oder des Dienstes ist."
      : "\nDie Kennung wurde GELÖSCHT.",
  );
}
if (!survived) {
  console.log("(Der Alarm daran ist per Kaskade mitgegangen.)");
}

await wipe();
const leftovers = await db
  .select({ token: pushTokens.token })
  .from(pushTokens)
  .where(like(pushTokens.token, "selftest-%"));
console.log(
  `\nAufgeräumt. Verbliebene selftest-Kennungen: ` +
    `${leftovers.length === 0 ? "keine" : leftovers.map((r) => r.token).join(", ")}`,
);
await pool.end();
process.exit(leftovers.length === 0 ? 0 : 1);
