/**
 * DREI Sonden, die den Zustellweg AUFTEILEN — statt ihn als Ganzes zu prüfen.
 *
 * „Es kommt nichts an" ist keine Diagnose, sondern eine Beobachtung: Server,
 * Firebase, Funkweg, Android und die App liegen alle dahinter, und jedes Glied
 * kann eine Meldung lautlos verschlucken. `alerts:diagnose` hat die vorderen
 * Glieder ausgeschlossen — Firebase kennt das Gerät und würde zustellen. Was
 * danach passiert, sieht man von hier aus nicht mehr.
 *
 * NICHT der Kanal. Das war die erste Vermutung und sie ist widerlegt:
 * `expo-notifications` 0.32.17 weicht bei einem unbekannten Kanal auf seinen
 * eigenen aus (`BaseNotificationBuilder.kt`, „Channel '%s' doesn't exists.
 * Fallback to '%s' channel") und legt den bei Bedarf selbst an. Ein fehlender
 * Kanal verwirft nichts. Die Sonden prüfen deshalb, was übrig bleibt.
 *
 * Die drei unterscheiden sich in genau einem Punkt:
 *
 *   A  die volle Fassung   — Meldung + Kanal + Kennzeichen + Sammel-Schlüssel,
 *                            Zeichen für Zeichen das, was der Ernstfall schickt
 *   B  die nackte Fassung  — nur Titel und Rumpf, sonst nichts
 *   C  nur Daten           — ohne Meldungsteil; Android zeigt nichts an, die APP
 *                            muss sich melden, wenn sie offen ist
 *
 * ABLESEN:
 *   A und B kommen an  → die Zustellung ist heil.
 *   nur B kommt an     → an A liegt es: Kennzeichen, Sammel-Schlüssel oder
 *                        Kanalangabe. Dann weiß ich genau, wo ich ansetze.
 *   keine, aber C      → Firebase ERREICHT die App; Android zeigt nur nichts an.
 *                        Dann sind die Meldungen für die App abgeschaltet oder
 *                        das Energiesparen hält sie zurück.
 *   gar nichts         → die Nachrichten erreichen das Gerät nicht. Auf vielen
 *                        Herstellern beendet das Wegwischen aus der Übersicht
 *                        die App vollständig; dann stellt Android gar nichts
 *                        mehr zu, bis sie wieder geöffnet wird.
 *
 * WICHTIG: Die App muss WÄHREND des Laufs OFFEN und im Vordergrund sein. Nur
 * dann kann C sich melden, und nur dann trennt der Lauf „erreicht die App
 * nicht" von „erreicht sie, wird aber nicht angezeigt".
 *
 *   npm run alerts:probe
 *
 * Die Sonden tragen KEIN `type` — ein Tipp darauf öffnet bewusst nichts.
 */
import admin from "firebase-admin";
import { desc, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { pushTokens } from "../src/db/schema.js";

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error("FIREBASE_SERVICE_ACCOUNT fehlt in .env.");
  await pool.end();
  process.exit(1);
}
const app = admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(raw) as admin.ServiceAccount),
});

const [target] = await db.select().from(pushTokens).orderBy(desc(pushTokens.updatedAt)).limit(1);
if (!target) {
  console.log("Keine Kennung. Öffne die App einmal.");
  await pool.end();
  process.exit(0);
}
console.log(`Ziel: ${target.token.slice(0, 12)}…${target.token.slice(-6)}  (angelegt ${target.createdAt?.toISOString()})`);
console.log(`Bisher empfangen: ${target.lastDeliveredAt?.toISOString() ?? "— noch nie"}\n`);
console.log("HALTE DIE APP OFFEN, solange dieser Lauf läuft — sonst kann Sonde C nichts melden.\n");

const stamp = new Date().toLocaleTimeString("de-DE");

const probes: { name: string; msg: admin.messaging.Message; erwartet: string }[] = [
  {
    name: "A  volle Fassung (wie der Ernstfall)",
    erwartet: "Meldung + Kanal + Kennzeichen + Sammel-Schlüssel, hohe Priorität",
    msg: {
      token: target.token,
      notification: { title: `A · volle Fassung (${stamp})`, body: "Sonde A — wie ein echter Alarm" },
      data: { probe: "A" },
      android: {
        priority: "high",
        collapseKey: "TRAIN|PROBE-A|PROBE-A|2026-12-01|",
        notification: { channelId: "price-alerts", tag: "TRAIN|PROBE-A|PROBE-A|2026-12-01|" },
      },
    },
  },
  {
    name: "B  nackte Fassung",
    erwartet: "nur Titel und Rumpf — kein Kanal, kein Kennzeichen, kein Sammel-Schlüssel",
    msg: {
      token: target.token,
      notification: { title: `B · nackt (${stamp})`, body: "Sonde B — nur Titel und Rumpf" },
    },
  },
  {
    name: "C  nur Daten, ohne Meldungsteil",
    erwartet: "zeigt NICHTS an; bestätigt aber, wenn die App offen ist",
    msg: {
      token: target.token,
      data: { probe: "C" },
      android: { priority: "high" },
    },
  },
];

for (const p of probes) {
  try {
    const id = await app.messaging().send(p.msg);
    console.log(`${p.name}\n   abgeschickt (${id.split("/").pop()})\n   ${p.erwartet}`);
  } catch (e) {
    const code = (e as { errorInfo?: { code?: string } }).errorInfo?.code ?? String(e);
    console.log(`${p.name}\n   FEHLER: ${code}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

const before = target.lastDeliveredAt?.getTime() ?? 0;
const deadline = Date.now() + 25_000;
let confirmed: Date | null = null;
process.stdout.write("\nWarte auf eine Bestätigung der App ");
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

console.log(
  confirmed
    ? `\nDie App hat sich gemeldet (${confirmed.toISOString()}).\n` +
        "Damit steht fest: Firebase ERREICHT die App. Was auf dem Bildschirm\n" +
        "erscheint und was nicht, entscheidet danach allein Android."
    : "\nKeine Bestätigung. Das heißt für sich genommen wenig, wenn die App nicht\n" +
        "offen war — entscheidend ist, WELCHE der Sonden auf dem Bildschirm stehen.",
);
console.log(
  "\n── Was steht jetzt auf dem Handy? ──\n" +
    "  A und B    → die Zustellung ist heil; der Fehler lag woanders.\n" +
    "  nur B      → an A liegt es — Kennzeichen, Sammel-Schlüssel oder Kanalangabe.\n" +
    "  nur A      → unerwartet; dann melde dich, das kehrt die Annahme um.\n" +
    "  keine, C bestätigt → Firebase erreicht die App, Android zeigt nichts an:\n" +
    "               Einstellungen → Apps → Binch → Benachrichtigungen prüfen.\n" +
    "  gar nichts → die Nachrichten erreichen das Gerät nicht. Häufigste Ursache:\n" +
    "               die App wurde aus der Übersicht weggewischt und damit beendet,\n" +
    "               oder sie steht unter „Akku eingeschränkt“.",
);
await pool.end();
process.exit(0);
