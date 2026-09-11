/**
 * Trennschärfe der Preis-Alarme — gegen die ECHTE Datenbank, ohne echten Versand.
 *
 * Die Frage, die dieses Skript beantwortet: Kann eine Meldung am FALSCHEN Gerät
 * oder für die FALSCHE Strecke landen? Geprüft wird durch Ausführen, nicht durch
 * Lesen.
 *
 *   npx tsx --env-file=.env scripts/alerts-selftest.ts
 *
 * DREI SICHERUNGEN, damit der Test nichts kaputt macht:
 *
 *  1. `admin.initializeApp` wird VOR dem ersten Aufruf durch eine Attrappe
 *     ersetzt. Damit geht keine einzige Nachricht an Firebase — obwohl in
 *     `.env` ein echter Dienstkontoschlüssel steht. Die Attrappe schreibt
 *     stattdessen mit, WELCHE Kennung welchen Text bekommen hätte; genau das
 *     ist der Messwert, um den es hier geht.
 *  2. Alle angelegten Kennungen tragen das Präfix `selftest-`, alle Strecken
 *     das Präfix `SELFTEST-`. Nach jedem Durchlauf wird geprüft, dass keine
 *     aufgezeichnete Nachricht an eine fremde Kennung ging.
 *  3. Vorher und nachher wird die Menge ALLER fremden Zeilen (Kennungen und
 *     Alarme) verglichen. Weicht sie ab, ist der Test selbst der Schaden.
 */
import admin from "firebase-admin";

/* ────────────────────────────────────────────────────────────────────────────
 * Die Attrappe. Muss stehen, bevor irgendetwas `sendPush` auslöst.
 * ──────────────────────────────────────────────────────────────────────────── */

interface Recorded {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  collapseKey?: string;
  channelId?: string;
  tag?: string;
}

const sent: Recorded[] = [];
type Verdict = { success: boolean; error?: { code: string; message: string } };
let responder: (token: string, idx: number) => Verdict = () => ({ success: true });
let fcmCalls = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(admin as any).credential.cert = () => ({ getAccessToken: async () => ({}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(admin as any).initializeApp = () => ({
  messaging: () => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendEach: async (msgs: any[]) => {
      fcmCalls += 1;
      const responses = msgs.map((m, i) => {
        sent.push({
          token: m.token,
          title: m.notification?.title ?? "",
          body: m.notification?.body ?? "",
          data: m.data ?? {},
          collapseKey: m.android?.collapseKey,
          channelId: m.android?.notification?.channelId,
          tag: m.android?.notification?.tag,
        });
        return responder(m.token, i);
      });
      return {
        responses,
        successCount: responses.filter((r) => r.success).length,
        failureCount: responses.filter((r) => !r.success).length,
      };
    },
  }),
});

const { db, pool } = await import("../src/db/client.js");
const { priceAlerts, pushTokens } = await import("../src/db/schema.js");
const { evaluateAlerts, cheapestPrice } = await import("../src/services/priceAlerts.js");
const { and, eq, inArray, like, sql } = await import("drizzle-orm");

/* ────────────────────────────────────────────────────────────────────────────
 * Buchführung
 * ──────────────────────────────────────────────────────────────────────────── */

let pass = 0;
const failures: string[] = [];
let section = "";

function head(s: string) {
  section = s;
  console.log(`\n\x1b[1m${s}\x1b[0m`);
}
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  \x1b[32mOK  \x1b[0m ${name}${detail ? `  — ${detail}` : ""}`);
  } else {
    failures.push(`[${section}] ${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31mFEHL\x1b[0m ${name}${detail ? `  — ${detail}` : ""}`);
  }
}
function note(s: string) {
  console.log(`       \x1b[2m${s}\x1b[0m`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Hilfen
 * ──────────────────────────────────────────────────────────────────────────── */

const DEPART = "2026-12-01";
const RETURN = "2026-12-08";

/**
 * Die Währungszeichen — ZWEITE Kopie, absichtlich.
 *
 * Der Dienst hat seine eigene Zuordnung. Würde diese Prüfung sie importieren,
 * prüfte sie die Zuordnung gegen sich selbst und ein vertauschtes Zeichen fiele
 * nie auf. Wer dort etwas ändert, muss es hier nachziehen — genau das ist der
 * Zweck. Wo kein Zeichen steht, erwartet der Text das Kürzel (CHF, SEK).
 */
const SYM: Record<string, string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };

/**
 * ZEITZONEN, die zur LAUFZEIT gewählt werden — und warum das sein muss.
 *
 * Die Auswertung stellt zwischen 22 und 8 Uhr ORTSZEIT nichts zu. Die
 * Testgeräte hatten keine Zone, fielen damit auf „Europe/Berlin" zurück — und
 * ab 22 Uhr schlug deshalb JEDE Prüfung fehl, die eine Meldung erwartet. Das
 * sah aus wie ein kaputtes Produkt und war die Uhr: zehn Stunden am Tag war
 * dieser Selbsttest rot, ohne dass sich etwas geändert hätte.
 *
 * Deshalb wird die Zone gesucht statt gesetzt. `AWAKE_TZ` ist eine, in der es
 * GERADE Tag ist; die gibt es immer, weil die Ruhezeit nur zehn der
 * vierundzwanzig Stunden abdeckt. `QUIET_TZ` ist eine, in der gerade Ruhezeit
 * ist — auch die gibt es immer, und damit lässt sich die Regel endlich in
 * beide Richtungen prüfen statt sie nur zu erleiden.
 */
const ZONES = [
  "Europe/Berlin",
  "America/New_York",
  "Asia/Tokyo",
  "Pacific/Auckland",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "America/Sao_Paulo",
  "Africa/Nairobi",
  "Australia/Perth",
  "Pacific/Honolulu",
];
function hourIn(tz: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: tz }).format(new Date()),
  );
}
const AWAKE_TZ = ZONES.find((z) => hourIn(z) >= 8 && hourIn(z) < 22) ?? "Europe/Berlin";
const QUIET_TZ = ZONES.find((z) => hourIn(z) >= 22 || hourIn(z) < 8);

async function mkDevice(
  name: string,
  locale = "de",
  timezone: string = AWAKE_TZ,
): Promise<{ id: string; token: string }> {
  const token = `selftest-${name}-0000000000`;
  const [row] = await db
    .insert(pushTokens)
    .values({ token, platform: "android", locale, timezone })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { locale, timezone, updatedAt: new Date() },
    })
    .returning({ id: pushTokens.id });
  return { id: row!.id, token };
}

interface AlertSpec {
  device: { id: string };
  mode?: string;
  origin: string;
  destination: string;
  departDate?: string;
  returnDate?: string;
  currency?: string;
  /** Reisende und Klasse gehören seit dem Fix zum Alarm-Schlüssel. */
  passengers?: number;
  travelClass?: string;
  base: number;
  desired: number;
  rise?: boolean;
  lastNotifiedAt?: Date | null;
}

async function mkAlert(s: AlertSpec): Promise<string> {
  const [row] = await db
    .insert(priceAlerts)
    .values({
      pushTokenId: s.device.id,
      mode: s.mode ?? "TRAIN",
      origin: s.origin,
      destination: s.destination,
      originLabel: `L:${s.origin}`,
      destLabel: `L:${s.destination}`,
      departDate: s.departDate ?? DEPART,
      returnDate: s.returnDate ?? "",
      currency: s.currency ?? "EUR",
      passengers: s.passengers ?? 1,
      travelClass: s.travelClass ?? "",
      basePrice: String(s.base),
      desiredPrice: String(s.desired),
      notifyOnRise: s.rise ?? false,
      lastNotifiedAt: s.lastNotifiedAt ?? null,
    })
    .returning({ id: priceAlerts.id });
  return row!.id;
}

/** Eine Suche nachstellen. Gibt zurück, was die Attrappe aufgefangen hat. */
async function search(
  input: {
    mode?: string;
    origin: string;
    destination: string;
    departDate?: string;
    returnDate?: string;
    /** Die Währung DIESER Suche — Vorgabe wie in der Suchroute: EUR. */
    currency?: string;
    /** Reisende und Klasse DIESER Suche — Vorgabe wie in der Suchroute. */
    passengers?: number;
    travelClass?: string;
  },
  prices: number[],
): Promise<Recorded[]> {
  sent.length = 0;
  await evaluateAlerts(
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mode: (input.mode ?? "TRAIN") as any,
      origin: input.origin,
      destination: input.destination,
      departDate: input.departDate ?? DEPART,
      returnDate: input.returnDate,
      currency: input.currency ?? "EUR",
      passengers: input.passengers ?? 1,
      travelClass: input.travelClass ?? "",
    },
    prices.map((p) => ({ price: p })),
  );
  // Sicherung 2: nie eine fremde Kennung.
  const foreign = sent.filter((m) => !m.token.startsWith("selftest-"));
  if (foreign.length > 0) {
    console.error("\n\x1b[41m ABBRUCH \x1b[0m Nachricht an FREMDE Kennung:", foreign);
    process.exit(1);
  }
  return [...sent];
}

async function alertRow(id: string) {
  const [r] = await db
    .select({
      lastSeenPrice: priceAlerts.lastSeenPrice,
      lastNotifiedAt: priceAlerts.lastNotifiedAt,
      desiredPrice: priceAlerts.desiredPrice,
      basePrice: priceAlerts.basePrice,
      returnDate: priceAlerts.returnDate,
      notifyOnRise: priceAlerts.notifyOnRise,
      active: priceAlerts.active,
    })
    .from(priceAlerts)
    .where(eq(priceAlerts.id, id))
    .limit(1);
  return r ?? null;
}

async function snapshot() {
  const t = await db
    .select({ id: pushTokens.id, token: pushTokens.token })
    .from(pushTokens);
  const a = await db.select({ id: priceAlerts.id }).from(priceAlerts);
  return {
    foreignTokens: t.filter((r) => !r.token.startsWith("selftest-")).map((r) => r.id).sort(),
    foreignAlertIds: new Set(a.map((r) => r.id)),
    all: { tokens: t.length, alerts: a.length },
  };
}

/**
 * Aufräumen — ÜBER DIE KENNUNG, nicht über die Strecke.
 *
 * Hier stand `delete from price_alerts where origin like 'ST%'`, und das war
 * gefährlich: `STR` ist Stuttgart, `STO` ist Stockholm. Ein echter Flug-Alarm
 * ab Stuttgart hätte auf dieses Muster gepasst und wäre beim Aufräumen des
 * Tests mitgelöscht worden.
 *
 * Der Umweg über die Kennung kann das nicht: Jeder hier angelegte Alarm hängt
 * an einem Gerät mit dem Präfix `selftest-`, und ein echtes Gerät trägt eine
 * FCM-Kennung, die niemals so beginnt. Die Kaskade erledigt den Rest — die
 * ausdrückliche Löschung davor ist nur der Beleg, dass es auch ohne sie stimmt.
 */
async function wipeSelftest() {
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

/* ══════════════════════════════════════════════════════════════════════════ */

console.log("\x1b[1m═══ Preis-Alarme: Trennschärfe-Prüfung ═══\x1b[0m");

const before = await snapshot();
console.log(
  `Bestand vorher: ${before.all.tokens} Kennungen, ${before.all.alerts} Alarme ` +
    `(davon fremd: ${before.foreignTokens.length} Kennungen, ${before.foreignAlertIds.size} Alarme)`,
);
await wipeSelftest(); // Reste eines abgebrochenen Laufs
const baseline = await snapshot();
const realAlertIds = new Set(baseline.foreignAlertIds);

/* ── 1. Gerätetrennung ─────────────────────────────────────────────────────── */
head("1. Gerätetrennung — zwei Geräte, zwei verschiedene Strecken");
{
  const A = await mkDevice("dev-a");
  const B = await mkDevice("dev-b");
  const aId = await mkAlert({ device: A, origin: "SELFTEST-1OA", destination: "SELFTEST-1DA", base: 100, desired: 50 });
  const bId = await mkAlert({ device: B, origin: "SELFTEST-1OB", destination: "SELFTEST-1DB", base: 100, desired: 50 });

  const msgs = await search({ origin: "SELFTEST-1OA", destination: "SELFTEST-1DA" }, [30]);
  check("genau EINE Nachricht", msgs.length === 1, `${msgs.length}`);
  check("und zwar an Gerät A", msgs[0]?.token === A.token, msgs[0]?.token ?? "—");
  check("nicht an Gerät B", !msgs.some((m) => m.token === B.token));

  const ra = await alertRow(aId);
  const rb = await alertRow(bId);
  check("A: gemeldet + Preis nachgeführt", ra?.lastNotifiedAt != null && Number(ra?.lastSeenPrice) === 30);
  check(
    "B: von der fremden Strecke NICHT berührt",
    rb?.lastNotifiedAt == null && rb?.lastSeenPrice == null,
    `lastSeen=${rb?.lastSeenPrice ?? "null"} lastNotified=${rb?.lastNotifiedAt ?? "null"}`,
  );
  note(`Titel A: „${msgs[0]?.title}"`);
}

/* ── 2. Dieselbe Strecke, zwei Geräte ──────────────────────────────────────── */
head("2. Dieselbe Strecke, zwei Geräte — jedes mit EIGENER Schwelle");
{
  const A = await mkDevice("dev-c", "de");
  const B = await mkDevice("dev-d", "fr");
  const aId = await mkAlert({ device: A, origin: "SELFTEST-2O", destination: "SELFTEST-2D", base: 100, desired: 50 });
  const bId = await mkAlert({ device: B, origin: "SELFTEST-2O", destination: "SELFTEST-2D", base: 90, desired: 20 });

  // Preis 30: unter A's Schwelle (50), über B's (20).
  const m1 = await search({ origin: "SELFTEST-2O", destination: "SELFTEST-2D" }, [30, 45]);
  check("nur A wird gemeldet", m1.length === 1 && m1[0]?.token === A.token, `${m1.length} Nachricht(en)`);
  const rb1 = await alertRow(bId);
  check(
    "B wurde GESEHEN (Preis nachgeführt), aber nicht gemeldet",
    Number(rb1?.lastSeenPrice) === 30 && rb1?.lastNotifiedAt == null,
  );
  /**
   * Die SCHWELLE steht seit der Umstellung nicht mehr im Text — bewusst.
   *
   * Der Rumpf trägt jetzt Anrede, Strecke und Preis; die eigene Schwelle war
   * die Information, die als erste weichen musste, weil sie in vierzig Zeichen
   * nicht neben den Preis passt und der Nutzer sie ohnehin selbst gesetzt hat.
   * Was hier zu prüfen bleibt, ist deshalb nicht der Wortlaut, sondern die
   * TRENNUNG: dass A's Nachricht an A geht und A's Sprache trägt.
   */
  check("A's Meldung trägt A's Sprache (de)", m1[0]?.title === "Preis-Alarm", m1[0]?.title ?? "");

  // Beide Entprellungen zurücksetzen, dann Preis 15: unter beiden Schwellen.
  await db.update(priceAlerts).set({ lastNotifiedAt: null }).where(inArray(priceAlerts.id, [aId, bId]));
  const m2 = await search({ origin: "SELFTEST-2O", destination: "SELFTEST-2D" }, [15]);
  check("beide bekommen ihre eigene Nachricht", m2.length === 2, `${m2.length}`);
  const toA = m2.find((m) => m.token === A.token);
  const toB = m2.find((m) => m.token === B.token);
  check("A genau einmal, B genau einmal", !!toA && !!toB && new Set(m2.map((m) => m.token)).size === 2);
  /**
   * Die Sprache steckt seit der Umstellung im TITEL, nicht im Rumpf.
   *
   * Der Rumpf ist bis auf die Anrede sprachneutral — Strecke, Trennzeichen,
   * Preis. Der Titel benennt die Sache und ist damit die einzige Stelle, an der
   * sich Deutsch von Französisch unterscheiden lässt. Genau darauf wird
   * geprüft: zwei Geräte, dieselbe Strecke, derselbe Preis — und trotzdem zwei
   * verschiedene Titel.
   */
  check(
    "Sprache je Gerät (A=de, B=fr)",
    toA?.title === "Preis-Alarm" && toB?.title === "Alerte prix",
    `A: „${toA?.title}" | B: „${toB?.title}"`,
  );
  /**
   * Beide nennen denselben Preis — aber NICHT denselben Prozentsatz.
   *
   * Der Rumpf trägt seit der Erweiterung, um wie viel der Preis gefallen ist,
   * und das misst sich am GRUNDPREIS DES JEWEILIGEN ALARMS: A hat 100 gesetzt,
   * B hat 90. Aus demselben Fundpreis von 15 werden damit 85 % und 83 %.
   *
   * Das ist die schärfere Prüfung als die frühere auf Gleichheit: Sie zeigt,
   * dass jedes Gerät seine EIGENEN Zahlen bekommt und nicht die des anderen —
   * genau die Verwechslung, gegen die dieser ganze Abschnitt gebaut ist.
   */
  check(
    "beide nennen denselben Fundpreis",
    toA?.body.includes("15 €") === true && toB?.body.includes("15 €") === true,
    `A: „${toA?.body}" | B: „${toB?.body}"`,
  );
  /**
   * DER DATENTEIL wird mitgeprüft — er ist kein Beiwerk.
   *
   * Die App verwirft eine Meldung ohne `price` absichtlich: Eine Zeile unter der
   * Glocke, die „0 EUR" behauptet, wäre schlimmer als keine. Genau das passierte
   * unbemerkt, als das Testskript seine eigene Nutzlast baute und diese beiden
   * Felder nicht mitschickte — auf dem Handy stand eine tadellose Meldung, und
   * in der App geschah nichts. Von außen sah das aus wie ein kaputtes Produkt.
   *
   * Der Text allein zu prüfen reicht deshalb nicht. Was die App VERARBEITET,
   * steht in `data`, und hier wird es angesehen.
   */
  check(
    "der Datenteil trägt Preis und Änderung (nicht nur der Text)",
    toA?.data.price === "15" && toA?.data.pct === "85" && toB?.data.pct === "83",
    `A: price=${toA?.data.price} pct=${toA?.data.pct} | B: pct=${toB?.data.pct}`,
  );
  check(
    "… und alles, was der Tipp zum Öffnen der Suche braucht",
    toA?.data.type === "priceAlert" &&
      !!toA?.data.mode &&
      !!toA?.data.origin &&
      !!toA?.data.destination &&
      !!toA?.data.originLabel &&
      !!toA?.data.destLabel &&
      !!toA?.data.departDate &&
      !!toA?.data.passengers &&
      !!toA?.data.currency,
    JSON.stringify(toA?.data),
  );
  check(
    "aber JEDER seinen eigenen Prozentsatz (A: 100→15 = -85%, B: 90→15 = -83%)",
    toA?.body.includes("-85%") === true && toB?.body.includes("-83%") === true,
    `A: „${toA?.body}" | B: „${toB?.body}"`,
  );
  note(`A(de): „${toA?.title}" / „${toA?.body}"`);
  note(`B(fr): „${toB?.title}" / „${toB?.body}"`);
}

/* ── 3. Streckentrennung, Feld für Feld ────────────────────────────────────── */
head("3. Streckentrennung — jedes Schlüsselfeld einzeln verändert");
{
  const A = await mkDevice("dev-e");
  const oneWay = await mkAlert({ device: A, origin: "SELFTEST-3O", destination: "SELFTEST-3D", base: 100, desired: 90 });

  const cases: Array<[string, Parameters<typeof search>[0]]> = [
    ["Verkehrsmittel (TRAIN→BUS)", { mode: "BUS", origin: "SELFTEST-3O", destination: "SELFTEST-3D" }],
    ["Start (SELFTEST-3O→SELFTEST-3O-X)", { origin: "SELFTEST-3O-X", destination: "SELFTEST-3D" }],
    ["Ziel (SELFTEST-3D→SELFTEST-3D-X)", { origin: "SELFTEST-3O", destination: "SELFTEST-3D-X" }],
    ["Hinreise-Datum (+1 Tag)", { origin: "SELFTEST-3O", destination: "SELFTEST-3D", departDate: "2026-12-02" }],
    ["Rückreise gesetzt statt leer", { origin: "SELFTEST-3O", destination: "SELFTEST-3D", returnDate: RETURN }],
  ];
  for (const [name, input] of cases) {
    const m = await search(input, [1]);
    const r = await alertRow(oneWay);
    check(`${name} → keine Meldung`, m.length === 0, `${m.length}`);
    check(`${name} → nicht einmal gesehen`, r?.lastSeenPrice == null);
  }
  const hit = await search({ origin: "SELFTEST-3O", destination: "SELFTEST-3D" }, [1]);
  check("Gegenprobe: exakte Strecke → Meldung", hit.length === 1 && hit[0]?.token === A.token);

  // Andersherum: Alarm MIT Rückreise, Suche OHNE.
  const rt = await mkAlert({
    device: A,
    origin: "SELFTEST-3RO",
    destination: "SELFTEST-3RD",
    returnDate: RETURN,
    base: 100,
    desired: 90,
  });
  const noRet = await search({ origin: "SELFTEST-3RO", destination: "SELFTEST-3RD" }, [1]);
  check("Hin-und-Rück-Alarm + einfache Suche → keine Meldung", noRet.length === 0, `${noRet.length}`);
  check("… und nicht gesehen", (await alertRow(rt))?.lastSeenPrice == null);
  const emptyStr = await search({ origin: "SELFTEST-3RO", destination: "SELFTEST-3RD", returnDate: "" }, [1]);
  check('returnDate="" (leere Zeichenkette) → ebenfalls keine Meldung', emptyStr.length === 0);
  const withRet = await search({ origin: "SELFTEST-3RO", destination: "SELFTEST-3RD", returnDate: RETURN }, [1]);
  check("Gegenprobe: passende Rückreise → Meldung", withRet.length === 1);

  // Datum als voller Zeitstempel (die Suchroute erlaubt bis zu 40 Zeichen).
  const dtId = await mkAlert({ device: A, origin: "SELFTEST-3TO", destination: "SELFTEST-3TD", base: 100, desired: 90 });
  const dt = await search(
    { origin: "SELFTEST-3TO", destination: "SELFTEST-3TD", departDate: `${DEPART}T00:00:00.000Z` },
    [1],
  );
  note(
    `departDate als voller Zeitstempel: ${dt.length} Meldung(en), ` +
      `lastSeen=${(await alertRow(dtId))?.lastSeenPrice ?? "null"}`,
  );

  // Abgeschaltete Alarme.
  const off = await mkAlert({ device: A, origin: "SELFTEST-3XO", destination: "SELFTEST-3XD", base: 100, desired: 90 });
  await db.update(priceAlerts).set({ active: false }).where(eq(priceAlerts.id, off));
  const m = await search({ origin: "SELFTEST-3XO", destination: "SELFTEST-3XD" }, [1]);
  check("inaktiver Alarm → keine Meldung", m.length === 0);
}

/* ── 4. Schwellenlogik ─────────────────────────────────────────────────────── */
head("4. Schwellenlogik — über / genau auf / unter der Schwelle, notifyOnRise");
{
  const A = await mkDevice("dev-f");
  const mk = async (tag: string, base: number, desired: number, rise = false) => ({
    id: await mkAlert({
      device: A,
      origin: `SELFTEST-4${tag}O`,
      destination: `SELFTEST-4${tag}D`,
      base,
      desired,
      rise,
    }),
    route: { origin: `SELFTEST-4${tag}O`, destination: `SELFTEST-4${tag}D` },
  });

  const over = await mk("A", 100, 50);
  check("Preis 51 > Schwelle 50 → keine Meldung", (await search(over.route, [51])).length === 0);
  check("… aber gesehen (Preis nachgeführt)", Number((await alertRow(over.id))?.lastSeenPrice) === 51);

  const exact = await mk("B", 100, 50);
  const em = await search(exact.route, [50]);
  check("Preis 50 == Schwelle 50 → Meldung (price <= desired)", em.length === 1, `${em.length}`);
  note(`Genau auf der Schwelle: „${em[0]?.title}" / „${em[0]?.body}"`);

  const under = await mk("C", 100, 50);
  check("Preis 49 < Schwelle 50 → Meldung", (await search(under.route, [49])).length === 1);

  const noRise = await mk("D", 100, 50, false);
  check("Preis 150 > Grundpreis, notifyOnRise=false → keine Meldung", (await search(noRise.route, [150])).length === 0);

  const yesRise = await mk("E", 100, 50, true);
  const rm = await search(yesRise.route, [150]);
  check("Preis 150 > Grundpreis, notifyOnRise=true → Meldung", rm.length === 1);
  /**
   * Sturz und Anstieg trennt der TITEL, und das 🎉 trennt sie ein zweites Mal.
   *
   * Der Rumpf ist in beiden Fällen gleich gebaut — Anrede, Strecke, Preis. Ohne
   * den Titel wäre eine schlechte Nachricht von einer guten nicht zu
   * unterscheiden; deshalb wird beides geprüft: der andere Titel UND das
   * fehlende Zeichen.
   */
  check(
    "… und zwar die STEIGT-Meldung",
    rm[0]?.title === "Preis gestiegen" && rm[0]?.body.includes("🎉") === false,
    `„${rm[0]?.title}" / „${rm[0]?.body}"`,
  );
  note(`Steigt-Text: „${rm[0]?.title}" / „${rm[0]?.body}"`);

  const eqBase = await mk("F", 100, 50, true);
  check("Preis 100 == Grundpreis, notifyOnRise=true → keine Meldung", (await search(eqBase.route, [100])).length === 0);
}

/* ── 5. Entprellung ────────────────────────────────────────────────────────── */
head("5. Entprellung — zwölf Stunden, auch bei zehn fremden Suchen");
{
  const A = await mkDevice("dev-g");
  const id = await mkAlert({ device: A, origin: "SELFTEST-5O", destination: "SELFTEST-5D", base: 100, desired: 50 });
  const route = { origin: "SELFTEST-5O", destination: "SELFTEST-5D" };

  check("erste Suche → Meldung", (await search(route, [40])).length === 1);
  let total = 0;
  for (let i = 0; i < 10; i += 1) total += (await search(route, [40 - i])).length;
  check("zehn weitere fremde Suchen → 0 Meldungen", total === 0, `${total}`);
  check(
    "aber der zuletzt gesehene Preis wird weiter nachgeführt",
    Number((await alertRow(id))?.lastSeenPrice) === 31,
    `${(await alertRow(id))?.lastSeenPrice}`,
  );

  await db
    .update(priceAlerts)
    .set({ lastNotifiedAt: new Date(Date.now() - 11.9 * 3600_000) })
    .where(eq(priceAlerts.id, id));
  check("nach 11h54 → immer noch stumm", (await search(route, [40])).length === 0);

  await db
    .update(priceAlerts)
    .set({ lastNotifiedAt: new Date(Date.now() - 12.1 * 3600_000) })
    .where(eq(priceAlerts.id, id));
  check("nach 12h06 → meldet wieder", (await search(route, [40])).length === 1);
}

/* ── 6. Preislose Treffer ──────────────────────────────────────────────────── */
head("6. Preislose Treffer — die 0 darf nie „günstigster Preis\" sein");
{
  check("cheapestPrice([0,0,0]) === 0", cheapestPrice([{ price: 0 }, { price: 0 }, { price: 0 }]) === 0);
  check("cheapestPrice([0,49,0,88]) === 49", cheapestPrice([{ price: 0 }, { price: 49 }, { price: 0 }, { price: 88 }]) === 49);
  check("cheapestPrice([]) === 0", cheapestPrice([]) === 0);
  check("cheapestPrice([-5, 30]) === 30 (negativ zählt nicht)", cheapestPrice([{ price: -5 }, { price: 30 }]) === 30);

  const A = await mkDevice("dev-h");
  const id = await mkAlert({ device: A, origin: "SELFTEST-6O", destination: "SELFTEST-6D", base: 100, desired: 50 });
  const route = { origin: "SELFTEST-6O", destination: "SELFTEST-6D" };

  const allZero = await search(route, [0, 0, 0, 0]);
  check("ALLE Treffer preislos → keine Meldung", allZero.length === 0);
  check("… und gar nicht erst geprüft (lastSeenPrice bleibt leer)", (await alertRow(id))?.lastSeenPrice == null);

  const mixed = await search(route, [0, 0, 80, 0]);
  check("gemischt (0,0,80,0) → 80 gilt, nicht 0 → keine Meldung bei Schwelle 50", mixed.length === 0);
  check("… und 80 wurde als gesehener Preis vermerkt", Number((await alertRow(id))?.lastSeenPrice) === 80);

  const mixed2 = await search(route, [0, 0, 40, 0]);
  check(
    "gemischt (0,0,40,0) → Meldung mit 40, nicht mit 0",
    mixed2.length === 1 && mixed2[0]!.body.includes("· 40 €") && !mixed2[0]!.body.includes("· 0 "),
    mixed2[0]?.body ?? "",
  );
}

/* ── 7. Währung ────────────────────────────────────────────────────────────── */
head("7. Währung — trennt sie jetzt sauber? (Nachprüfung der Korrektur)");
{
  /**
   * Die App lässt EUR, USD, GBP, JPY, CHF und SEK zu (`app/(tabs)/settings.tsx`).
   * Ein Alarm trägt die Währung, in der er gesetzt wurde; geprüft wird er im
   * Nachlauf JEDER fremden Suche auf dieser Strecke — und die kommt in der
   * Währung des FREMDEN Nutzers. Yen ist der klarste Fall: dort liegen die
   * Beträge rund hundertmal höher.
   */
  const A = await mkDevice("dev-i", "de");
  const B = await mkDevice("dev-i2", "de");

  /**
   * DER KERNTEST: dieselbe Strecke, dieselbe ZAHL als Schwelle, verschiedene
   * Währungen. Wird die Währung nicht mitverglichen, trifft jede Suche beide.
   */
  const eurId = await mkAlert({
    device: A,
    origin: "SELFTEST-7O",
    destination: "SELFTEST-7D",
    currency: "EUR",
    base: 100,
    desired: 50,
  });
  const jpyId = await mkAlert({
    device: B,
    origin: "SELFTEST-7O",
    destination: "SELFTEST-7D",
    currency: "JPY",
    base: 100,
    desired: 50,
  });

  const inEur = await search({ origin: "SELFTEST-7O", destination: "SELFTEST-7D", currency: "EUR" }, [40]);
  check("EUR-Suche → genau EINE Meldung", inEur.length === 1, `${inEur.length}`);
  check("… an das Gerät mit dem EUR-Alarm", inEur[0]?.token === A.token, inEur[0]?.token ?? "—");
  check("… und der Text nennt EUR", inEur[0]?.body.includes(`40 ${SYM.EUR}`) === true, inEur[0]?.body ?? "");
  check(
    "der JPY-Alarm wurde NICHT EINMAL GESEHEN",
    (await alertRow(jpyId))?.lastSeenPrice == null,
    `lastSeen=${(await alertRow(jpyId))?.lastSeenPrice ?? "null"}`,
  );

  const inJpy = await search({ origin: "SELFTEST-7O", destination: "SELFTEST-7D", currency: "JPY" }, [40]);
  check("JPY-Suche → genau EINE Meldung", inJpy.length === 1, `${inJpy.length}`);
  check("… an das Gerät mit dem JPY-Alarm", inJpy[0]?.token === B.token, inJpy[0]?.token ?? "—");
  check("… und der Text nennt JPY", inJpy[0]?.body.includes(`40 ${SYM.JPY}`) === true, inJpy[0]?.body ?? "");
  note(`EUR-Meldung: „${inEur[0]?.body}"   JPY-Meldung: „${inJpy[0]?.body}"`);

  // (b) Der alte Fehlalarm: JPY-Alarm, fremde EUR-Suche mit kleiner Zahl.
  const jpyOnly = await mkAlert({
    device: A,
    origin: "SELFTEST-7RO",
    destination: "SELFTEST-7RD",
    currency: "JPY",
    base: 16500, // ≈ 100 EUR
    desired: 8250, // ≈ 50 EUR
  });
  const foreignEur = await search(
    { origin: "SELFTEST-7RO", destination: "SELFTEST-7RD", currency: "EUR" },
    [95],
  );
  check(
    "JPY-Alarm (≤8250) + fremde EUR-Suche (95) → kein Fehlalarm",
    foreignEur.length === 0,
    foreignEur.length > 0 ? `FEHLALARM: „${foreignEur[0]?.title}"` : "still",
  );
  check(
    "… und lastSeenPrice bleibt unverschmutzt (keine 95 „JPY\")",
    (await alertRow(jpyOnly))?.lastSeenPrice == null,
    `${(await alertRow(jpyOnly))?.lastSeenPrice ?? "null"}`,
  );

  // (c) Der alte verpasste Sturz: EUR-Alarm, fremde JPY-Suche.
  const eurOnly = await mkAlert({
    device: A,
    origin: "SELFTEST-7JO",
    destination: "SELFTEST-7JD",
    currency: "EUR",
    base: 100,
    desired: 50,
  });
  const foreignJpy = await search(
    { origin: "SELFTEST-7JO", destination: "SELFTEST-7JD", currency: "JPY" },
    [6600],
  );
  check("EUR-Alarm + fremde JPY-Suche → schweigt", foreignJpy.length === 0, `${foreignJpy.length}`);
  check(
    "… und der Yen-Betrag landet NICHT als EUR im Alarm",
    (await alertRow(eurOnly))?.lastSeenPrice == null,
    `${(await alertRow(eurOnly))?.lastSeenPrice ?? "null"}`,
  );
  note("Bewusst KEINE Umrechnung: der echte 40-EUR-Sturz bleibt hier ungemeldet — das ist die gewählte Abwägung.");

  // (d) Alle sechs Währungen der App gegeneinander.
  const CUR = ["EUR", "USD", "GBP", "JPY", "CHF", "SEK"];
  const devices: Record<string, { id: string; token: string }> = {};
  for (const c of CUR) {
    devices[c] = await mkDevice(`cur-${c.toLowerCase()}`);
    await mkAlert({
      device: devices[c]!,
      origin: "SELFTEST-7AO",
      destination: "SELFTEST-7AD",
      currency: c,
      base: 100,
      desired: 60,
    });
  }
  let crossTalk = 0;
  for (const c of CUR) {
    const m = await search({ origin: "SELFTEST-7AO", destination: "SELFTEST-7AD", currency: c }, [50]);
    const right = m.length === 1 && m[0]?.token === devices[c]!.token && m[0]!.body.includes(`50 ${SYM[c] ?? c}`);
    if (!right) crossTalk += 1;
  }
  check(
    "sechs Alarme gleicher Zahl in sechs Währungen: jede Suche trifft GENAU ihren",
    crossTalk === 0,
    `${CUR.length - crossTalk}/${CUR.length} richtig`,
  );

  // (e) Groß-/Kleinschreibung — der Server normalisiert nicht.
  const lowerId = await mkAlert({
    device: A,
    origin: "SELFTEST-7LO",
    destination: "SELFTEST-7LD",
    currency: "eur",
    base: 100,
    desired: 50,
  });
  const upperSearch = await search(
    { origin: "SELFTEST-7LO", destination: "SELFTEST-7LD", currency: "EUR" },
    [40],
  );
  note(
    `Alarm mit „eur", Suche mit „EUR": ${upperSearch.length} Meldung(en), ` +
      `lastSeen=${(await alertRow(lowerId))?.lastSeenPrice ?? "null"} — ` +
      "die App schreibt immer groß (searchStore: code.toUpperCase()), der Server prüft es aber nicht nach.",
  );
  void eurId;
}

/* ── 7b. Die übrigen Felder der Such-Identität ─────────────────────────────── */
head("7b. Passagierzahl und Reiseklasse gehören zum Alarm-Schlüssel");
{
  const A = await mkDevice("dev-q");

  /**
   * `dbVendo.ts:764` rechnet `perPaxPrice * pax` — der Preis in der Antwort ist
   * der GESAMTPREIS der Reisegruppe. Ein Alarm aus einer Suche für vier
   * Personen trägt also einen Vierfach-Grundpreis; die Suche eines Fremden für
   * eine Person liefert ein Viertel davon.
   */
  const groupId = await mkAlert({
    device: A,
    origin: "SELFTEST-7PO",
    destination: "SELFTEST-7PD",
    passengers: 4,
    base: 240, // 4 × 60 EUR
    desired: 200,
  });
  const solo = await search(
    { origin: "SELFTEST-7PO", destination: "SELFTEST-7PD", passengers: 1 },
    [60],
  ); // fremde 1-Personen-Suche
  check(
    "4-Personen-Alarm (≤200) + fremde 1-Personen-Suche (60) → keine Meldung",
    solo.length === 0,
    solo.length > 0 ? `es kam eine Meldung: „${solo[0]?.title}"` : "keine Meldung",
  );
  if (solo.length > 0) note(`Text: „${solo[0]?.body}" — der Preis gilt für EINE Person, der Grundpreis für VIER.`);
  note(`lastSeenPrice: ${(await alertRow(groupId))?.lastSeenPrice}`);

  const busId = await mkAlert({
    device: A,
    origin: "SELFTEST-7CO",
    destination: "SELFTEST-7CD",
    travelClass: "search.class.business",
    base: 420, // Business
    desired: 350,
  });
  const eco = await search(
    { origin: "SELFTEST-7CO", destination: "SELFTEST-7CD", travelClass: "search.class.economy" },
    [95],
  ); // fremde Economy-Suche
  check(
    "Business-Alarm (≤350) + fremde Economy-Suche (95) → keine Meldung",
    eco.length === 0,
    eco.length > 0 ? `es kam eine Meldung: „${eco[0]?.title}"` : "keine Meldung",
  );
  if (eco.length > 0) note(`Text: „${eco[0]?.body}" — der Preis ist Economy, der Alarm war auf Business gesetzt.`);
  note(`lastSeenPrice: ${(await alertRow(busId))?.lastSeenPrice}`);

  // Gegenproben: Die PASSENDE Suche muss weiterhin melden — sonst hätte der
  // Fix die Funktion abgeschaltet statt sie zu schärfen.
  const group = await search(
    { origin: "SELFTEST-7PO", destination: "SELFTEST-7PD", passengers: 4 },
    [180],
  );
  check(
    "4-Personen-Alarm (≤200) + passende 4-Personen-Suche (180) → Meldung",
    group.length === 1,
    group.length === 1 ? `„${group[0]?.title}"` : `${group.length} Meldungen`,
  );
  const bus = await search(
    { origin: "SELFTEST-7CO", destination: "SELFTEST-7CD", travelClass: "search.class.business" },
    [300],
  );
  check(
    "Business-Alarm (≤350) + passende Business-Suche (300) → Meldung",
    bus.length === 1,
    bus.length === 1 ? `„${bus[0]?.title}"` : `${bus.length} Meldungen`,
  );
}

/* ── 8. Tote Kennungen ─────────────────────────────────────────────────────── */
head("8. Tote Kennungen — nur die betroffene stirbt");
{
  const A = await mkDevice("dev-j");
  const B = await mkDevice("dev-k");
  const C = await mkDevice("dev-l");
  const route = { origin: "SELFTEST-8O", destination: "SELFTEST-8D" };
  const ids = {
    a: await mkAlert({ device: A, origin: "SELFTEST-8O", destination: "SELFTEST-8D", base: 100, desired: 90 }),
    b: await mkAlert({ device: B, origin: "SELFTEST-8O", destination: "SELFTEST-8D", base: 100, desired: 90 }),
    c: await mkAlert({ device: C, origin: "SELFTEST-8O", destination: "SELFTEST-8D", base: 100, desired: 90 }),
  };
  // Jedes Gerät hat zusätzlich einen Alarm auf einer ANDEREN Strecke — der darf
  // beim Aufräumen der toten Kennung ebenfalls nicht danebengehen.
  const other = {
    a: await mkAlert({ device: A, origin: "SELFTEST-8XO", destination: "SELFTEST-8XD", base: 100, desired: 90 }),
    b: await mkAlert({ device: B, origin: "SELFTEST-8XO", destination: "SELFTEST-8XD", base: 100, desired: 90 }),
    c: await mkAlert({ device: C, origin: "SELFTEST-8XO", destination: "SELFTEST-8XD", base: 100, desired: 90 }),
  };

  // (a) Firebase meldet für B: Kennung nicht registriert.
  responder = (token) =>
    token === B.token
      ? { success: false, error: { code: "messaging/registration-token-not-registered", message: "not registered" } }
      : { success: true };
  const m = await search(route, [10]);
  check("alle drei bekamen einen Zustellversuch", m.length === 3, `${m.length}`);

  const live = await db
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(like(pushTokens.token, "selftest-dev-%"));
  const liveSet = new Set(live.map((r) => r.token));
  check("B's Kennung ist gelöscht", !liveSet.has(B.token));
  check("A's Kennung lebt", liveSet.has(A.token));
  check("C's Kennung lebt", liveSet.has(C.token));
  check("B's Alarme sind mitkaskadiert", (await alertRow(ids.b)) == null && (await alertRow(other.b)) == null);
  check(
    "A's und C's Alarme UNBERÜHRT (beide Strecken)",
    (await alertRow(ids.a)) != null &&
      (await alertRow(ids.c)) != null &&
      (await alertRow(other.a)) != null &&
      (await alertRow(other.c)) != null,
  );

  // (b) Der Regressionstest: invalid-argument ist ein Fehler des ABSENDERS.
  const D = await mkDevice("dev-m");
  const E = await mkDevice("dev-n");
  const r2 = { origin: "SELFTEST-8BO", destination: "SELFTEST-8BD" };
  const dId = await mkAlert({ device: D, origin: "SELFTEST-8BO", destination: "SELFTEST-8BD", base: 100, desired: 90 });
  const eId = await mkAlert({ device: E, origin: "SELFTEST-8BO", destination: "SELFTEST-8BD", base: 100, desired: 90 });
  responder = () => ({ success: false, error: { code: "messaging/invalid-argument", message: "bad payload" } });
  const m2 = await search(r2, [10]);
  check("beide Zustellversuche scheitern mit invalid-argument", m2.length === 2);
  const live2 = await db
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(inArray(pushTokens.token, [D.token, E.token]));
  check("KEINE Kennung gelöscht (Absender-Fehler ≠ Gerät weg)", live2.length === 2, `${live2.length}/2 leben`);
  check("beide Alarme leben weiter", (await alertRow(dId)) != null && (await alertRow(eId)) != null);

  // (c) Weitere Fehlercodes, die nicht löschen dürfen.
  for (const code of [
    "messaging/internal-error",
    "messaging/server-unavailable",
    "messaging/message-rate-exceeded",
    "messaging/third-party-auth-error",
    "messaging/authentication-error",
    "messaging/mismatched-credential",
  ]) {
    await db.update(priceAlerts).set({ lastNotifiedAt: null }).where(inArray(priceAlerts.id, [dId, eId]));
    responder = () => ({ success: false, error: { code, message: "x" } });
    await search(r2, [10]);
    const alive = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(inArray(pushTokens.token, [D.token, E.token]));
    check(`${code} löscht nichts`, alive.length === 2, `${alive.length}/2`);
  }

  // (d) invalid-registration-token — der zweite Code, der löschen SOLL.
  const F = await mkDevice("dev-o");
  const G = await mkDevice("dev-p");
  const r3 = { origin: "SELFTEST-8CO", destination: "SELFTEST-8CD" };
  await mkAlert({ device: F, origin: "SELFTEST-8CO", destination: "SELFTEST-8CD", base: 100, desired: 90 });
  const gId = await mkAlert({ device: G, origin: "SELFTEST-8CO", destination: "SELFTEST-8CD", base: 100, desired: 90 });
  responder = (token) =>
    token === F.token
      ? { success: false, error: { code: "messaging/invalid-registration-token", message: "bad token" } }
      : { success: true };
  await search(r3, [10]);
  const live3 = await db
    .select({ token: pushTokens.token })
    .from(pushTokens)
    .where(inArray(pushTokens.token, [F.token, G.token]));
  check("invalid-registration-token → nur F gelöscht", live3.length === 1 && live3[0]?.token === G.token);
  check("G's Alarm unberührt", (await alertRow(gId)) != null);

  responder = () => ({ success: true });
}

/* ── 8b. Eindeutigkeit — über die ECHTE Route, nicht nachgebaut ────────────── */
head("8b. Eindeutigkeit je Gerät und Strecke (POST /api/alerts, laufender Server)");
{
  const base = "http://localhost:3000";
  const up = await fetch(`${base}/api/alerts`).then((r) => r.status).catch(() => 0);
  if (up === 0) {
    note("Server auf :3000 nicht erreichbar — Abschnitt übersprungen.");
  } else {
    /**
     * Jeder Aufruf durch dieselbe Schleuse — mit Wiederholung bei 429.
     *
     * Der Anfrage-Zähler des Servers liegt im Speicher und wird nach IP
     * geführt; im Docker-Netz kommen ALLE Aufrufe vom selben Gateway. Läuft
     * parallel noch jemand gegen denselben Server, teilen sich beide die 30
     * Anfragen pro Minute, und dieser Abschnitt fällt reihenweise durch, ohne
     * dass am Prüfgegenstand etwas falsch wäre. Die Wiederholung wartet genau
     * die Zeit ab, die der Server selbst nennt.
     */
    const http = async (url: string, init?: RequestInit): Promise<Response> => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const r = await fetch(url, init);
        if (r.status !== 429) return r;
        const wait = Number(r.headers.get("retry-after") ?? "2");
        await new Promise((res) => setTimeout(res, (Number.isFinite(wait) ? wait : 2) * 1000 + 700));
      }
      return fetch(url, init);
    };

    const token = "selftest-http-dev-0000000000";
    const reg = await http(`${base}/api/alerts/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, platform: "android", locale: "de" }),
    });
    check("Gerät registriert", reg.ok, `HTTP ${reg.status}`);

    const post = async (body: Record<string, unknown>) => {
      const r = await http(`${base}/api/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: (await r.json().catch(() => ({}))) as { id?: string } };
    };
    const common = {
      pushToken: token,
      mode: "TRAIN",
      origin: "SELFTEST-9O",
      destination: "SELFTEST-9D",
      originLabel: "L:ST9O",
      destLabel: "L:ST9D",
      departDate: DEPART,
      currency: "EUR",
      notifyOnRise: false,
    };

    // (1) Einfache Fahrt (returnDate weggelassen) — zweimal.
    const one1 = await post({ ...common, basePrice: 100, desiredPrice: 80 });
    const one2 = await post({ ...common, basePrice: 100, desiredPrice: 40 });
    check("beide Anlagen erfolgreich", one1.status === 200 && one2.status === 200, `${one1.status}/${one2.status}`);
    check("gleiche Alarm-Kennung → ERSETZT, nicht dupliziert", one1.json.id === one2.json.id, `${one1.json.id} / ${one2.json.id}`);
    const r1 = await alertRow(one2.json.id!);
    check("neue Schwelle übernommen (80 → 40)", Number(r1?.desiredPrice) === 40, `${r1?.desiredPrice}`);
    check('returnDate ist die leere Zeichenkette, nicht NULL', r1?.returnDate === "", JSON.stringify(r1?.returnDate));

    // (2) Ersetzen setzt die Entprellung zurück.
    await db.update(priceAlerts).set({ lastNotifiedAt: new Date() }).where(eq(priceAlerts.id, one2.json.id!));
    check("Vorbedingung: Entprellung läuft", (await alertRow(one2.json.id!))?.lastNotifiedAt != null);
    const one3 = await post({ ...common, basePrice: 100, desiredPrice: 30 });
    check("erneutes Anlegen → gleiche Kennung", one3.json.id === one2.json.id);
    check("… und Entprellung zurückgesetzt", (await alertRow(one3.json.id!))?.lastNotifiedAt == null);

    // (3) Dieselbe Strecke MIT Rückreise ist ein eigener Alarm.
    const rt1 = await post({ ...common, returnDate: RETURN, basePrice: 180, desiredPrice: 150 });
    check("Hin-und-Rück ist ein EIGENER Alarm", rt1.json.id !== one3.json.id, `${rt1.json.id}`);
    const rt2 = await post({ ...common, returnDate: RETURN, basePrice: 180, desiredPrice: 120 });
    check("… und ersetzt sich ebenfalls selbst", rt2.json.id === rt1.json.id);
    check("… ohne den Einfach-Alarm anzufassen", Number((await alertRow(one3.json.id!))?.desiredPrice) === 30);

    const [row_n] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(priceAlerts)
      .where(and(like(priceAlerts.origin, "SELFTEST-9%")));
    // `count(*)` liefert immer genau eine Zeile; TypeScript weiß das nicht und
    // hält die Liste für möglicherweise leer. Der Vorgabewert ist deshalb kein
    // Zugeständnis an einen echten Fall — er ist billiger als ein `!`, das beim
    // nächsten Umbau still falsch würde.
    const n = row_n?.n ?? -1;
    check("insgesamt genau ZWEI Zeilen für diese Strecke", n === 2, `${n}`);

    // (4) Ein ZWEITES Gerät auf derselben Strecke ist unabhängig.
    const token2 = "selftest-http-dev2-0000000000";
    await http(`${base}/api/alerts/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: token2, platform: "ios", locale: "en" }),
    });
    const other = await post({ ...common, pushToken: token2, basePrice: 100, desiredPrice: 90 });
    check("zweites Gerät bekommt eine EIGENE Kennung", other.json.id !== one3.json.id, `${other.json.id}`);
    check("Schwelle des ersten Geräts unverändert", Number((await alertRow(one3.json.id!))?.desiredPrice) === 30);

    // (5) Fremdes Löschen mit falscher Kennung greift nicht — und sagt es.
    const del = await http(
      `${base}/api/alerts/${one3.json.id}?pushToken=${encodeURIComponent(token2)}`,
      { method: "DELETE" },
    );
    check("DELETE mit FREMDER Push-Kennung → 404 statt stillem 204", del.status === 404, `HTTP ${del.status}`);
    check("… und der Alarm lebt weiter", (await alertRow(one3.json.id!)) != null);
    const delOk = await http(
      `${base}/api/alerts/${other.json.id}?pushToken=${encodeURIComponent(token2)}`,
      { method: "DELETE" },
    );
    check("DELETE mit der EIGENEN Kennung → 204", delOk.status === 204, `HTTP ${delOk.status}`);
    check("… und der Alarm ist weg", (await alertRow(other.json.id!)) == null);

    /* ── Die Änderungen dieser Runde, im Prüfgebiet ── */

    // (6) Ersetzen setzt auch den zuletzt gesehenen Preis zurück.
    await db
      .update(priceAlerts)
      .set({ lastSeenPrice: "77" })
      .where(eq(priceAlerts.id, one3.json.id!));
    check("Vorbedingung: alter lastSeenPrice steht", Number((await alertRow(one3.json.id!))?.lastSeenPrice) === 77);
    const one4 = await post({ ...common, basePrice: 100, desiredPrice: 25 });
    check("Ersetzen → gleiche Kennung", one4.json.id === one3.json.id);
    check(
      "… und lastSeenPrice auf null zurückgesetzt (gehört zur alten Schwelle)",
      (await alertRow(one4.json.id!))?.lastSeenPrice == null,
      `${(await alertRow(one4.json.id!))?.lastSeenPrice ?? "null"}`,
    );

    // (7) Unmögliche Datumsangaben werden geprüft, nicht an Postgres gereicht.
    const badDate = await post({ ...common, departDate: "2026-13-45", basePrice: 100, desiredPrice: 50 });
    check("departDate 2026-13-45 → 400 statt 500", badDate.status === 400, `HTTP ${badDate.status}`);
    const badFeb = await post({ ...common, departDate: "2026-02-30", basePrice: 100, desiredPrice: 50 });
    check("departDate 2026-02-30 (30. Februar) → 400", badFeb.status === 400, `HTTP ${badFeb.status}`);
    const badRet = await post({ ...common, returnDate: "2026-13-45", basePrice: 100, desiredPrice: 50 });
    check("returnDate 2026-13-45 → 400", badRet.status === 400, `HTTP ${badRet.status}`);

    // (8) returnDate: "" heißt einfache Fahrt und wird angenommen.
    const emptyRet = await post({ ...common, returnDate: "", basePrice: 100, desiredPrice: 20 });
    check('returnDate: "" → angenommen', emptyRet.status === 200, `HTTP ${emptyRet.status}`);
    check(
      '… und trifft DENSELBEN Alarm wie ein fehlendes returnDate',
      emptyRet.json.id === one4.json.id,
      `${emptyRet.json.id} vs ${one4.json.id}`,
    );

    // (9) Push-Kennung im Kopf statt im Query-String.
    const viaHeader = await http(`${base}/api/alerts`, { headers: { "X-Push-Token": token } });
    const hdrJson = (await viaHeader.json()) as { alerts?: unknown[] };
    check("GET /api/alerts mit X-Push-Token → 200", viaHeader.status === 200, `HTTP ${viaHeader.status}`);
    check("… liefert die Alarme dieses Geräts", (hdrJson.alerts?.length ?? 0) > 0, `${hdrJson.alerts?.length ?? 0}`);
    const viaHeaderForeign = await http(`${base}/api/alerts`, { headers: { "X-Push-Token": token2 } });
    const fJson = (await viaHeaderForeign.json()) as { alerts?: unknown[] };
    check(
      "… und für das ZWEITE Gerät nur dessen eigene (hier: keine mehr)",
      (fJson.alerts?.length ?? -1) === 0,
      `${fJson.alerts?.length ?? "?"}`,
    );

    // (10) Ein vorhandenes, aber ungültiges Bearer-Token ist ein Fehler.
    const badAuth = await http(`${base}/api/alerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer voellig-erfundenes-token-0000",
      },
      body: JSON.stringify({ ...common, basePrice: 100, desiredPrice: 50 }),
    });
    check("ungültiges Bearer-Token → 401 statt stiller Anonymität", badAuth.status === 401, `HTTP ${badAuth.status}`);

    // (11) Fremde Push-Kennung im Rumpf: unbekanntes Gerät.
    const unknownDev = await post({
      ...common,
      pushToken: "selftest-nie-registriert-000",
      basePrice: 100,
      desiredPrice: 50,
    });
    check("unbekannte Push-Kennung → 404", unknownDev.status === 404, `HTTP ${unknownDev.status}`);
  }
}

/* ── 9. Fremdeinwirkung ausgeschlossen ─────────────────────────────────────── */
head("9. Sicherung: kein fremdes Gerät wurde je angeschrieben");
{
  check(`Firebase-Attrappe wurde ${fcmCalls}× aufgerufen, echtes Firebase 0×`, fcmCalls > 0);
  const after = await snapshot();
  const untouched =
    JSON.stringify(after.foreignTokens) === JSON.stringify(baseline.foreignTokens) &&
    [...realAlertIds].every((id) => after.foreignAlertIds.has(id));
  check("alle fremden Kennungen und Alarme unverändert vorhanden", untouched);
}

/* ── Aufräumen ─────────────────────────────────────────────────────────────── */
head("Aufräumen");
{
  await wipeSelftest();
  const [row_t] = await db
    .select({ t: sql<number>`count(*)::int` })
    .from(pushTokens)
    .where(like(pushTokens.token, "selftest-%"));
  const [row_a] = await db
    .select({ a: sql<number>`count(*)::int` })
    .from(priceAlerts)
    .where(like(priceAlerts.origin, "SELFTEST-%"));
  // Siehe oben — `count(*)` hat immer eine Zeile.
  const t = row_t?.t ?? -1;
  const a = row_a?.a ?? -1;
  check("keine selftest-Kennung mehr da", t === 0, `${t}`);
  check("kein SELFTEST-Alarm mehr da", a === 0, `${a}`);

  const after = await snapshot();
  check(
    "Bestand exakt wie vorher",
    after.all.tokens === baseline.all.tokens && after.all.alerts === baseline.all.alerts,
    `${after.all.tokens} Kennungen / ${after.all.alerts} Alarme (vorher ${baseline.all.tokens}/${baseline.all.alerts})`,
  );
}

console.log(
  `\n\x1b[1m${failures.length === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} bestanden, ${failures.length} durchgefallen\x1b[0m`,
);
for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
await pool.end();
process.exit(failures.length === 0 ? 0 : 1);
