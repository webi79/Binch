/**
 * Eine ECHTE Meldung an ein registriertes Gerät schicken — zum Prüfen der
 * letzten Meile.
 *
 * DIE MELDUNG KOMMT AUS DER DATENBANK, nicht aus einer festen Zeichenkette.
 * Hier stand eine erfundene Strecke (Köln–Bielefeld), fest eingebaut — und das
 * war ein Fehler, kein Detail: Auf dem Handy stand dann ein Alarm, den es nicht
 * gab, für ein Gerät, dem er nicht gehörte. Wer das sieht, muss annehmen, die
 * Alarme seien kaputt. Ein Test, der etwas anderes zeigt als den Ernstfall,
 * prüft auch etwas anderes.
 *
 *   npm run alerts:test-push
 *
 * Gibt es für das Gerät keinen Alarm, wird die Meldung ausdrücklich als TEST
 * beschriftet und trägt KEIN `type` — dann ist auf dem Bildschirm zu sehen,
 * dass sie keiner ist, und ein Tipp darauf öffnet bewusst nichts.
 */
import admin from "firebase-admin";
import { and, desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { priceAlerts, pushTokens, users } from "../src/db/schema.js";
import { buildAlertPush, markNotified } from "../src/services/priceAlerts.js";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
const app = raw
  ? admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount) })
  : admin.initializeApp({ credential: admin.credential.applicationDefault() });

const devices = await db
  .select({
    id: pushTokens.id,
    token: pushTokens.token,
    platform: pushTokens.platform,
    locale: pushTokens.locale,
    updatedAt: pushTokens.updatedAt,
    lastDeliveredAt: pushTokens.lastDeliveredAt,
  })
  .from(pushTokens)
  .orderBy(desc(pushTokens.updatedAt))
  .limit(5);

if (devices.length === 0) {
  console.log("Keine registrierte Kennung. Öffne die App einmal — sie meldet sich beim Start selbst an.");
  await pool.end();
  process.exit(0);
}

console.log(`${devices.length} Kennung(en) gefunden, neueste zuerst:`);
devices.forEach((r, i) => {
  const t = r.token;
  console.log(`  ${i + 1}. ${t.slice(0, 12)}…${t.slice(-6)}  (${r.platform ?? "?"}, ${r.updatedAt?.toISOString() ?? "?"})`);
});

/**
 * Den Alarm suchen — zuerst für DIESES Gerät, sonst irgendeinen aktiven.
 *
 * Der Rückfall ist wichtig: Push-Kennungen wechseln (Neuinstallation,
 * Wiederherstellung), und ein Alarm, der noch an der alten hängt, gehört
 * trotzdem demselben Menschen. Ohne den Rückfall zeigte der Test „kein Alarm",
 * obwohl einer in der Datenbank steht — genau die Verwirrung, die er ausräumen
 * soll. Welcher Fall zutrifft, sagt er unten ausdrücklich.
 */
const columns = {
  // Die Kennung gehört MIT ausgewählt: Ohne sie ließe sich der Alarm nach dem
  // Versand nicht als gemeldet vermerken — siehe `markNotified` weiter unten.
  id: priceAlerts.id,
  mode: priceAlerts.mode,
  origin: priceAlerts.origin,
  destination: priceAlerts.destination,
  originLabel: priceAlerts.originLabel,
  destLabel: priceAlerts.destLabel,
  departDate: priceAlerts.departDate,
  currency: priceAlerts.currency,
  basePrice: priceAlerts.basePrice,
  desiredPrice: priceAlerts.desiredPrice,
  lastSeenPrice: priceAlerts.lastSeenPrice,
  pushTokenId: priceAlerts.pushTokenId,
  returnDate: priceAlerts.returnDate,
  passengers: priceAlerts.passengers,
  travelClass: priceAlerts.travelClass,
  userId: priceAlerts.userId,
};

const target = devices[0]!;

let [alert] = await db
  .select(columns)
  .from(priceAlerts)
  .where(and(eq(priceAlerts.pushTokenId, target.id), eq(priceAlerts.active, true)))
  .orderBy(desc(priceAlerts.createdAt))
  .limit(1);
let ownedByTarget = Boolean(alert);

if (!alert) {
  [alert] = await db
    .select(columns)
    .from(priceAlerts)
    .where(eq(priceAlerts.active, true))
    .orderBy(desc(priceAlerts.createdAt))
    .limit(1);
}

/**
 * Der Vorname — auf demselben Weg wie im Ernstfall: über das Konto am Alarm.
 *
 * Ohne Anmeldung steht dort nichts, und dann wird der Rumpf ohne Anrede gebaut.
 * Auch das gehört zum Test: Wer nicht angemeldet ist, soll kein „Hallo Nutzer"
 * sehen.
 */
let firstName: string | null = null;
if (alert?.userId) {
  const [u] = await db
    .select({ firstName: users.firstName })
    .from(users)
    .where(eq(users.id, alert.userId))
    .limit(1);
  firstName = u?.firstName ?? null;
}

/**
 * Kennung und gedachter Preis leben AUSSERHALB des Zweiges.
 *
 * Sie werden weiter unten gebraucht, um den Alarm als gemeldet zu vermerken —
 * nach dem Versand, nicht davor: Was nicht rausgegangen ist, soll auch nicht
 * als gemeldet dastehen.
 */
let alertId: string | null = null;
let pretendPrice = 0;

let title: string;
let body: string;
/** Der Kanal kommt im Ernstfall aus `buildAlertPush` — hier derselbe Wert. */
let channelId = "price-alerts";
let data: Record<string, string>;
let tag: string;

if (alert) {
  /**
   * Der Ernstfall, Zeichen für Zeichen: dieselben Texte, die `evaluateAlerts`
   * baut, nur mit einem gedachten Preis knapp unter der Schwelle.
   */
  const desired = Number(alert.desiredPrice);
  const base = Number(alert.basePrice);
  const pretend = Math.max(1, desired - 1);
  const route = `${alert.originLabel} – ${alert.destLabel}`;
  /**
   * Die GANZE Meldung kommt aus `buildAlertPush` — Texte UND Datenteil.
   *
   * Hier stand beides ein zweites Mal, von Hand nachgebaut, und beides ist
   * weggelaufen: erst die Texte (der Test schickte noch die verworfene
   * Satz-Form), dann der Datenteil. Beim zweiten Mal fehlten `price` und `pct`
   * — die App verwirft eine Meldung ohne Preis absichtlich, also legte der Test
   * nichts unter die Glocke und nahm den Alarm nicht aus „Gespeichert". Das sah
   * aus wie ein kaputtes Produkt und war ein kaputter Test.
   *
   * Ein Test, der etwas anderes verschickt als der Ernstfall, prüft auch etwas
   * anderes. Jetzt kann er es gar nicht mehr.
   */
  const push = buildAlertPush({
    locale: target.locale,
    firstName,
    dropped: true,
    price: pretend,
    basePrice: base,
    currency: alert.currency,
    mode: alert.mode,
    origin: alert.origin,
    destination: alert.destination,
    originLabel: alert.originLabel,
    destLabel: alert.destLabel,
    departDate: alert.departDate,
    returnDate: alert.returnDate || undefined,
    passengers: alert.passengers,
    travelClass: alert.travelClass,
  });
  title = push.title;
  body = push.body;
  tag = push.tag;
  data = push.data;
  channelId = push.channelId;
  alertId = alert.id;
  pretendPrice = pretend;
  console.log(`\nAlarm aus der Datenbank: ${route} am ${alert.departDate}`);
  console.log(`  Schwelle ${desired} ${alert.currency} · zuletzt gesehen ${alert.lastSeenPrice ?? "—"}`);
  console.log(`  Die Testmeldung tut so, als wäre der Preis auf ${pretend} ${alert.currency} gefallen.`);
  if (!ownedByTarget) {
    console.log("  HINWEIS: Dieser Alarm hängt an einer ANDEREN (älteren) Gerätekennung.");
    console.log("  Verschickt wird an die neueste — Kennungen wechseln bei Neuinstallation.");
  }
} else {
  title = "Binch — Testmeldung";
  body = "Die Zustellung funktioniert. Es liegt gerade kein Preis-Alarm vor.";
  tag = "binch-test";
  // KEIN `type`: Sonst öffnete ein Tipp eine Suche für eine erfundene Strecke.
  data = { type: "test" };
  console.log("\nIn der Datenbank steht KEIN aktiver Alarm.");
  console.log("Es geht deshalb eine ausdrücklich als Test beschriftete Meldung raus —");
  console.log("ein Tipp darauf öffnet bewusst nichts.");
}

const res = await app.messaging().send({
  token: target.token,
  notification: { title, body },
  data,
  android: {
    // Ein Eintrag je Strecke: Ein zweiter Lauf ERSETZT die Meldung des ersten,
    // statt sich danebenzulegen.
    collapseKey: tag,
    // Wie im Ernstfall — sonst prüft der Test einen anderen Zustellweg.
    priority: "high",
    notification: { channelId, tag },
  },
});

console.log(`\n  Titel: „${title}"`);
console.log(`  Rumpf: „${body}"`);
/**
 * Den Datenteil MIT AUSGEBEN.
 *
 * Genau hier war nichts zu sehen, als `price` und `pct` fehlten: Auf dem Handy
 * stand eine tadellose Meldung, und die App verwarf sie stillschweigend. Was
 * verschickt wird, gehört auf den Bildschirm — sonst prüft man den halben Weg.
 */
console.log(`  Daten: ${JSON.stringify(data)}`);

console.log("\nAn Firebase übergeben. Nachrichten-Kennung:", res);

/**
 * Den Alarm als GEMELDET vermerken — genau wie es die Auswertung täte.
 *
 * DAS FEHLTE, und es war kein Schönheitsfehler: Die App holt beim Start nach,
 * was sie verpasst hat, und erkennt einen ausgelösten Alarm an `lastNotifiedAt`
 * und `notifiedPrice`. Dieses Skript verschickte zwar eine echte Meldung,
 * schrieb aber nichts in die Datenbank — das Nachholen fand also nie etwas, und
 * es sah aus, als sei es kaputt.
 *
 * Ein Test, der die Wirkung des Ernstfalls nicht hinterlässt, prüft nur die
 * halbe Kette. Über `markNotified` geht es jetzt durch dieselbe Funktion wie
 * die Auswertung; vergessen lässt es sich nicht mehr.
 *
 * Nur bei einem ECHTEN Alarm. Die Ersatz-Testmeldung ohne Alarm hat nichts, was
 * sie vermerken könnte — und dort wäre es auch falsch.
 */
if (alert && alertId) {
  await markNotified([alertId], pretendPrice);
  console.log(`\nIn der Datenbank vermerkt: gemeldet mit ${pretendPrice} ${alert.currency}.`);
  console.log("Damit findet die App den Alarm auch dann, wenn sie die Meldung");
  console.log("verpasst hat und später normal geöffnet wird.");
}

const before = target.lastDeliveredAt?.getTime() ?? 0;
const deadline = Date.now() + 20_000;
let confirmed: Date | null = null;
process.stdout.write("Warte auf Bestätigung des Geräts ");
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1500));
  process.stdout.write(".");
  const [row] = await db
    .select({ d: pushTokens.lastDeliveredAt })
    .from(pushTokens)
    .where(eq(pushTokens.token, target.token))
    .limit(1);
  if (row?.d && row.d.getTime() > before) {
    confirmed = row.d;
    break;
  }
}
console.log("");

if (confirmed) {
  console.log("BESTÄTIGT: Das Gerät hat die Meldung empfangen um", confirmed.toISOString());
  console.log("Damit ist die Zustellung bis auf das Gerät nachgewiesen.");
} else {
  console.log("KEINE Bestätigung innerhalb von 20s. Mögliche Gründe:");
  console.log("  • Die App läuft nicht im Vordergrund — Android stellt die Meldung");
  console.log("    dann ohne JavaScript zu; der Nachweis kommt beim ANTIPPEN.");
  console.log("  • Das Gerät ist im Tiefschlaf; dann steht sie beim nächsten Lauf.");
  console.log("");
  console.log("ZUM PRÜFEN der Liste unter der Glocke: Die App trägt eine Meldung nur ein,");
  console.log("solange sie LÄUFT — oder wenn man die Meldung ANTIPPT. Bei geschlossener");
  console.log("App passiert bis zum Tipp nichts, und das ist kein Fehler.");
  console.log("Nachsehen: npm run alerts:status");
}
await pool.end();
process.exit(0);
