import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { priceAlerts, pushTokens } from "../db/schema.js";
import { requireUser } from "../services/authSession.js";
import { ipLimiter } from "../util/rateLimit.js";
import { fareProfileFor } from "../util/fareProfile.js";
import { replaceReminders } from "../services/tripReminders.js";
import { sendPush } from "../services/priceAlerts.js";

/**
 * Preis-Alarme — Anlegen, Auflisten, Pausieren, Löschen.
 *
 * KEIN Konto nötig, und das ist eine Entscheidung: Wer die App installiert und
 * einen Alarm setzt, soll ihn bekommen, ohne sich vorher anzumelden. Der
 * Schlüssel ist deshalb die Push-Kennung des GERÄTS.
 *
 * Ist zusätzlich jemand angemeldet, wird das Konto am Alarm VERMERKT —
 * ausgewertet wird es noch nicht. Hier stand, der Alarm überlebe damit einen
 * Gerätewechsel; das war ein Versprechen ohne Deckung: Gelesen und gelöscht
 * wird ausschließlich über die Push-Kennung, und zugestellt wird an sie. Damit
 * das Versprechen wahr wird, müssten Lesen, Löschen UND das Umhängen der
 * Kennung beim Anmelden auf einem neuen Gerät zusammen gebaut werden — ein
 * halber Lesepfad wäre schlechter als keiner, er zeigte Alarme, die weder
 * zustellen noch löschbar sind.
 *
 * Den Kennungs-Wechsel auf DEMSELBEN Gerät fängt bereits etwas anderes ab: Die
 * App gleicht ihre gemerkten Alarme beim Start gegen den Server ab
 * (`lib/notifications/syncAlerts.ts`). Übrig bleibt der Gerätewechsel ohne
 * Datenübernahme — dafür lohnt der Umbau, wenn ihn jemand vermisst. Das ist der Preis dafür, dass die Funktion ohne
 * Anmeldung überhaupt benutzbar ist.
 */

/** Eigenes Budget: Alarme legt man einzeln an, nicht im Sekundentakt. */
const ALERT_LIMITS = [
  { limit: 30, windowMs: 60 * 1000 },
  { limit: 200, windowMs: 60 * 60 * 1000 },
];

const registerSchema = z.object({
  token: z.string().min(10).max(255),
  platform: z.string().max(16).optional(),
  /** Sprache der App — bestimmt den Text der Meldung. Siehe `pushTokens.locale`. */
  locale: z.string().max(5).optional(),
  /** IANA-Zeitzone — bestimmt die Ruhezeit. Siehe `pushTokens.timezone`. */
  timezone: z.string().max(64).optional(),
  /** Marke und Modell — nur für die Fehlersuche. Siehe `pushTokens.deviceModel`. */
  deviceModel: z.string().max(64).optional(),
  /** Die Schalter aus den Einstellungen der App — fehlen sie (ältere Fassung), bleibt der Stand. */
  notificationsEnabled: z.boolean().optional(),
  priceAlertsEnabled: z.boolean().optional(),
  boUpdatesEnabled: z.boolean().optional(),
});

/**
 * Ein ISO-Tagesdatum, das es WIRKLICH gibt.
 *
 * Eine Regex allein reicht nicht: `2026-13-45` und `2026-02-30` haben die
 * richtige Form, sind aber keine Daten. Postgres wies sie beim Einfügen mit
 * `22008` zurück, Fastify machte daraus einen 500er — und reichte dabei die
 * Datenbank-Meldung samt SQLSTATE nach außen. Aus der App heraus kaum
 * auslösbar (der Kalender liefert nur gültige Tage), aber es war der einzige
 * Weg im ganzen Satz, auf dem Interna den Server verlassen.
 *
 * Geprüft wird über den Rückweg: Ein `Date` normalisiert Unsinn stillschweigend
 * (aus dem 30. Februar wird der 2. März). Stimmt die zurückgeschriebene
 * Zeichenkette nicht mit der Eingabe überein, war die Eingabe kein Datum.
 */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Kein gültiges Datum");

/** Eine UUID, wie Postgres sie erwartet — geprüft, bevor sie dorthin geht. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ackSchema = z.object({
  token: z.string().min(10).max(255),
  /** „received" = die App hat sie bekommen, „tapped" = jemand hat sie geöffnet. */
  kind: z.enum(["received", "tapped"]),
});

/**
 * Der Schalter auf der Karte — mehr ist an einem bestehenden Alarm änderbar.
 *
 * Bewusst nur dieses eine Feld: Alles andere (Strecke, Datum, Schwelle) ist
 * Teil der Identität des Alarms — der eindeutige Index steht genau darauf. Wer
 * das ändern will, legt ihn neu an; `POST` ersetzt den bestehenden dann von
 * selbst.
 */
const patchSchema = z.object({ active: z.boolean() });

const createSchema = z.object({
  /** Die Push-Kennung des Geräts — sie ist der Besitzer des Alarms. */
  pushToken: z.string().min(10).max(255),
  mode: z.enum(["FLIGHT", "TRAIN", "BUS", "CRUISE"]),
  origin: z.string().min(1).max(64),
  destination: z.string().min(1).max(64),
  originLabel: z.string().min(1).max(160),
  destLabel: z.string().min(1).max(160),
  departDate: isoDate,
  /**
   * Leer, fehlend oder ein Datum — alle drei erlaubt.
   *
   * Die leere Zeichenkette MUSS durchgehen: Sie ist intern der Wert für
   * „einfache Fahrt" (siehe `returnDate` im Schema), und der lokale Typ der App
   * erlaubt sie ausdrücklich. Die alte Regex wies sie ab; gut ging das nur,
   * weil beide heutigen Aufrufer `returnDate || undefined` schicken. Der
   * nächste, der das Feld schlicht durchreicht, bekäme ein „400 Invalid" ohne
   * erkennbaren Grund.
   */
  returnDate: z.union([isoDate, z.literal("")]).optional(),
  /**
   * Groß geschrieben, ERZWUNGEN statt vereinbart.
   *
   * Seit die Auswertung die Währung mitvergleicht, ist Groß-/Kleinschreibung
   * der Unterschied zwischen „meldet" und „meldet nie, ohne jede Spur". Heute
   * trägt es, weil die App ihre Auswahl ohnehin groß schreibt — das ist eine
   * Absprache, keine Garantie. Ein `transform` macht eine daraus.
   */
  currency: z
    .string()
    .min(1)
    .max(8)
    .transform((v) => v.trim().toUpperCase()),
  /** Reisende und Klasse gehören zum Preis — siehe Schema. */
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  travelClass: z.string().max(60).default(""),
  /** Tarifprofil der Suche, aus der der Alarm stammt — vereinheitlicht über `fareProfileFor`. */
  fareProfile: z.string().max(40).default(""),
  basePrice: z.number().positive().max(1_000_000),
  desiredPrice: z.number().positive().max(1_000_000),
  notifyOnRise: z.boolean().default(false),
});

/**
 * Die Push-Kennung aus der Anfrage — bevorzugt aus dem KOPF, nicht der URL.
 *
 * Sie ist hier die Berechtigung: Wer sie hat, darf die Alarme dieses Geräts
 * sehen und löschen. In einem Query-String landet sie damit in jedem
 * Zugriffsprotokoll, das zwischen App und Server steht — beim Reverse-Proxy,
 * im Container-Log, in jedem Fehlerbericht. Berechtigungen gehören nicht in
 * URLs.
 *
 * Der Query-Weg bleibt als Rückfall bestehen: Eine bereits installierte App
 * schickt sie noch dort, und ein Server, der sie plötzlich ablehnt, macht aus
 * einem Sicherheits-Feinschliff einen Ausfall.
 */
function pushTokenOf(req: {
  headers: Record<string, unknown>;
  query: unknown;
}): string | null {
  const head = req.headers["x-push-token"];
  if (typeof head === "string" && head.length > 0) return head;
  const q = (req.query as { pushToken?: string } | undefined)?.pushToken;
  return typeof q === "string" && q.length > 0 ? q : null;
}

const REMINDER_HORIZON_MS = 60 * 86_400_000;
const remindersSchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().min(1).max(160),
        kind: z.enum(["departure", "arrival"]),
        fireAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(300),
      }),
    )
    .max(80),
});

const testSchema = z.object({
  title: z.string().min(1).max(80),
  body: z.string().min(1).max(200),
  delaySec: z.number().int().min(0).max(15).default(0),
});
const TEST_COOLDOWN_MS = 20_000;
const TEST_TTL_MS = 120_000;
/** Letzter Test je Gerät — im Speicher genügt: Nach einem Neustart darf man wieder. */
const lastTestAt = new Map<string, number>();

export async function alertsRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("alerts", ALERT_LIMITS);

  /**
   * Erinnerungen eines Geräts ERSETZEN (services/tripReminders.ts).
   *
   * Die App schickt bei jedem Abgleich die ganze Liste — leere Liste = keine.
   * Ausweis ist wie bei den Alarmen die Push-Kennung im Kopf; ohne bekanntes
   * Gerät gibt es keinen Empfänger.
   */
  app.put("/api/reminders", { preHandler }, async (req, reply) => {
    const token = pushTokenOf(req);
    if (!token) return reply.code(400).send({ error: "Missing push token" });
    const parsed = remindersSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const [device] = await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, token)).limit(1);
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const now = Date.now();
    const items = parsed.data.items
      .map((i) => ({ ...i, fireAt: new Date(i.fireAt), expiresAt: new Date(i.expiresAt) }))
      // Nichts Vergangenes, nichts ewig Fernes, nichts, was vor dem Schicken schon abliefe.
      .filter(
        (i) =>
          i.fireAt.getTime() > now - 60_000 &&
          i.fireAt.getTime() < now + REMINDER_HORIZON_MS &&
          i.expiresAt.getTime() > i.fireAt.getTime(),
      );
    const count = await replaceReminders(device.id, items);
    // Was wartet jetzt? Ohne diese Zeile war „leere Liste" nicht von „verschickt" zu trennen.
    const next = items.reduce<Date | null>((m, i) => (!m || i.fireAt < m ? i.fireAt : m), null);
    req.log.info(
      { reminders: count, received: parsed.data.items.length, next: next?.toISOString() ?? null },
      "reminders replaced",
    );
    return { count };
  });

  /**
   * TEST-MITTEILUNG an dieses Gerät — Profil → Einstellungen → Mitteilungen.
   *
   * WOZU: Ob eine Mitteilung auf dem Handy ERSCHEINT, weiß nur das Handy.
   * Firebase nimmt auch an, was der Hersteller danach verwirft (Xiaomi ohne
   * Autostart, Akku-Sparen). Mit diesem Knopf prüft man die letzte Meile selbst
   * — auch bei geschlossener App: Der Versand wartet `delaySec`, damit man sie
   * vorher schließen kann.
   *
   * Nur an die EIGENE Kennung (Kopf `X-Push-Token`, muss angemeldet sein), Text
   * von der App (ihre Sprache), höchstens einmal je 20 s und Gerät. Kurze
   * Lebensdauer: Ein Test, der eine Stunde später ankommt, sagt nichts aus.
   */
  app.post("/api/alerts/test", { preHandler }, async (req, reply) => {
    const token = pushTokenOf(req);
    if (!token) return reply.code(400).send({ error: "Missing push token" });
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const [device] = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.token, token))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const last = lastTestAt.get(device.id) ?? 0;
    if (Date.now() - last < TEST_COOLDOWN_MS) return reply.code(429).send({ error: "Too many tests" });
    lastTestAt.set(device.id, Date.now());
    const { title, body, delaySec } = parsed.data;
    setTimeout(() => {
      void sendPush([
        {
          to: token,
          title,
          body,
          tag: "test",
          channelId: "trip-reminders",
          data: { type: "test" },
          ttlMs: TEST_TTL_MS,
        },
      ]);
    }, delaySec * 1000).unref?.();
    req.log.info({ device: device.id.slice(0, 8), delaySec }, "test push queued");
    return reply.code(202).send({ delaySec });
  });

  /**
   * Die Push-Kennung des Geräts hinterlegen.
   *
   * `onConflictDoUpdate` statt Einfügen-oder-Fehler: Dasselbe Gerät meldet sich
   * bei jedem App-Start erneut, und es soll dabei seine Konto-Verknüpfung
   * aktualisieren können (jemand meldet sich an, nachdem er den Alarm gesetzt
   * hat).
   */
  app.post("/api/alerts/device", { preHandler }, async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const me = await requireUser(req);
    // Nur, was mitkam: Eine ältere App-Fassung schickt die Schalter nicht, und
    // dann darf ihr Stand nicht auf die Vorgabe zurückspringen.
    const prefs = {
      ...(parsed.data.notificationsEnabled !== undefined ? { notificationsEnabled: parsed.data.notificationsEnabled } : {}),
      ...(parsed.data.priceAlertsEnabled !== undefined ? { priceAlertsEnabled: parsed.data.priceAlertsEnabled } : {}),
      ...(parsed.data.boUpdatesEnabled !== undefined ? { boUpdatesEnabled: parsed.data.boUpdatesEnabled } : {}),
    };
    const [row] = await db
      .insert(pushTokens)
      .values({
        token: parsed.data.token,
        platform: parsed.data.platform ?? null,
        ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
        ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
        ...(parsed.data.deviceModel ? { deviceModel: parsed.data.deviceModel } : {}),
        ...prefs,
        userId: me?.id ?? null,
      })
      .onConflictDoUpdate({
        target: pushTokens.token,
        set: {
          platform: parsed.data.platform ?? null,
          // Sprache und Zone können sich ändern — beide werden bei jedem Start
          // neu gemeldet.
          ...(parsed.data.locale ? { locale: parsed.data.locale } : {}),
          ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}),
          ...(parsed.data.deviceModel ? { deviceModel: parsed.data.deviceModel } : {}),
          ...prefs,
          // Eine bestehende Verknüpfung NICHT löschen, nur setzen: Anfragen ohne
          // Anmeldung kommen auch vor, während das Konto noch angemeldet ist.
          // Gelöst wird sie beim Abmelden (`/api/auth/logout`).
          ...(me ? { userId: me.id } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({ id: pushTokens.id });
    // `returning` ist typseitig eine Liste — nach einem Einfügen mit
    // Konflikt-Behandlung kommt hier immer genau eine Zeile zurück. Der
    // Wächter ist trotzdem billiger als ein `!`, das beim nächsten Umbau still
    // falsch wird.
    if (!row) return reply.code(500).send({ error: "Insert failed" });
    return { id: row.id };
  });

  /**
   * Empfangsbestätigung des Geräts.
   *
   * WOZU: Dass Firebase eine Nachricht annimmt und eine Nachrichten-Kennung
   * zurückgibt, beweist nur, dass sie in die Warteschlange kam. Ob sie auf dem
   * Gerät ankam, weiß Firebase selbst nicht — Energiesparmodus, ein
   * abgeschalteter Kanal oder eine deinstallierte App führen alle zu „Erfolg"
   * beim Absender. Der einzige belastbare Nachweis kommt vom Gerät, und genau
   * den nimmt dieser Endpunkt an.
   *
   * Bewusst OHNE Anmeldung und ohne Nachrichten-Kennung: Er trägt einen
   * Zeitstempel an eine Kennung, die es schon gibt. Mehr wäre Aufwand für eine
   * Angabe, die niemandem nützt — und wer eine fremde Push-Kennung hat, kann
   * damit ohnehin nur behaupten, dass dieses Gerät etwas empfangen hat.
   */
  app.post("/api/alerts/ack", { preHandler }, async (req, reply) => {
    const parsed = ackSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const now = new Date();
    const res = await db
      .update(pushTokens)
      .set(
        parsed.data.kind === "tapped"
          ? { lastTappedAt: now, lastDeliveredAt: now }
          : { lastDeliveredAt: now },
      )
      .where(eq(pushTokens.token, parsed.data.token))
      .returning({ id: pushTokens.id });
    if (res.length === 0) return reply.code(404).send({ error: "Unknown device" });
    return reply.code(204).send();
  });

  app.post("/api/alerts", { preHandler }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const d = parsed.data;
    if (d.desiredPrice >= d.basePrice) {
      // Ein Wunschpreis über dem aktuellen löste sofort aus — das wäre kein
      // Alarm, sondern eine Meldung über den Ist-Zustand.
      return reply.code(400).send({ error: "desiredPrice must be below basePrice" });
    }
    const [device] = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.token, d.pushToken))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "Unknown device" });

    /**
     * Ein VORHANDENES, aber ungültiges Token ist ein Fehler — kein „anonym".
     *
     * Vorher wurde es still geschluckt: Wessen Sitzung abgelaufen war, legte
     * Alarme ohne Kontobindung an und erfuhr es nie. Ganz ohne Kopfzeile bleibt
     * es dagegen ausdrücklich erlaubt — ein Alarm braucht kein Konto.
     */
    const bearer = req.headers.authorization;
    const me = await requireUser(req);
    if (bearer && !me) return reply.code(401).send({ error: "Invalid or expired session" });
    const [row] = await db
      .insert(priceAlerts)
      .values({
        pushTokenId: device.id,
        userId: me?.id ?? null,
        mode: d.mode,
        origin: d.origin,
        destination: d.destination,
        originLabel: d.originLabel,
        destLabel: d.destLabel,
        departDate: d.departDate,
        returnDate: d.returnDate ?? "",
        // Groß geschrieben abgelegt, damit der Vergleich später trifft.
        currency: d.currency.toUpperCase(),
        passengers: d.passengers,
        travelClass: d.travelClass,
        fareProfile: fareProfileFor(d.mode, d.fareProfile),
        basePrice: String(d.basePrice),
        desiredPrice: String(d.desiredPrice),
        notifyOnRise: d.notifyOnRise,
      })
      /**
       * Eine Strecke trägt je Gerät höchstens EINEN Alarm — ein zweiter ersetzt
       * den ersten. Wer denselben Weg zum selben Datum noch einmal beobachtet,
       * meint fast immer eine andere Schwelle und nicht zwei Meldungen für
       * dasselbe Ereignis. Der eindeutige Index macht das atomar.
       */
      .onConflictDoUpdate({
        target: [
          priceAlerts.pushTokenId,
          priceAlerts.mode,
          priceAlerts.origin,
          priceAlerts.destination,
          priceAlerts.departDate,
          priceAlerts.returnDate,
          priceAlerts.passengers,
          priceAlerts.travelClass,
          priceAlerts.currency,
          priceAlerts.fareProfile,
        ],
        set: {
          basePrice: String(d.basePrice),
          desiredPrice: String(d.desiredPrice),
          notifyOnRise: d.notifyOnRise,
          currency: d.currency.toUpperCase(),
          /**
           * Beim Ersetzen die Konto-Verknüpfung NACHTRAGEN, wenn jemand
           * angemeldet ist.
           *
           * Vorher stand `userId` nicht in dieser Liste: Ein Alarm, der vor der
           * Anmeldung entstand, blieb für immer kontolos — auch wenn dieselbe
           * Person sich später anmeldete und die App ihn beim Start erneut
           * schickte. Damit gab es für die Anrede in der Meldung nie einen
           * Namen.
           *
           * Nur SETZEN, nie löschen: Wer sich abmeldet, soll seine Verknüpfung
           * nicht verlieren — dieselbe Regel wie beim Gerät weiter oben.
           */
          ...(me ? { userId: me.id } : {}),
          originLabel: d.originLabel,
          destLabel: d.destLabel,
          active: true,
          // Entprellung zurücksetzen: Ein neu gesetzter Alarm soll nicht
          // schweigen, weil der alte vor zwei Stunden gemeldet hat.
          lastNotifiedAt: null,
          /**
           * Und den zuletzt gesehenen Preis mit.
           *
           * Er gehört zum ALTEN Alarm: Er sagt, was bei der letzten Prüfung auf
           * dieser Strecke stand, bezogen auf dessen Grundpreis. Bleibt er
           * stehen, während `basePrice` sich ändert, zeigt die Liste eine Zahl,
           * die zu nichts mehr gehört — und es sieht aus, als sei der neue
           * Alarm längst geprüft worden.
           */
          lastSeenPrice: null,
          // Und der gemeldete Preis mit: Er gehört zur Meldung des ALTEN
          // Alarms. Bliebe er stehen, hielte der Abgleich beim nächsten Start
          // einen frisch gesetzten Alarm für einen, der schon ausgelöst hat.
          notifiedPrice: null,
        },
      })
      .returning({ id: priceAlerts.id });
    if (!row) return reply.code(500).send({ error: "Insert failed" });
    return { id: row.id };
  });

  app.get("/api/alerts", { preHandler }, async (req, reply) => {
    const token = pushTokenOf(req);
    if (!token) return reply.code(400).send({ error: "pushToken required" });
    const rows = await db
      .select({
        id: priceAlerts.id,
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
        lastSeenPrice: priceAlerts.lastSeenPrice,
        /**
         * WANN und MIT WELCHEM PREIS zuletzt gemeldet wurde — beides gehört
         * heraus.
         *
         * Daran erkennt die App Alarme, die ausgelöst haben, ohne dass sie es
         * mitbekam: Die Meldung kam an, während sie tot war, und der Nutzer
         * öffnete sie danach normal statt über die Meldung. Auf keinem anderen
         * Weg erfährt sie davon — Android zeigt eine solche Meldung nativ an,
         * ohne JavaScript zu starten. Hier steht die Wahrheit.
         */
        lastNotifiedAt: priceAlerts.lastNotifiedAt,
        notifiedPrice: priceAlerts.notifiedPrice,
        active: priceAlerts.active,
        createdAt: priceAlerts.createdAt,
      })
      .from(priceAlerts)
      .innerJoin(pushTokens, eq(pushTokens.id, priceAlerts.pushTokenId))
      .where(eq(pushTokens.token, token))
      .orderBy(desc(priceAlerts.createdAt))
      .limit(100);
    return { alerts: rows };
  });

  /**
   * Einen Alarm PAUSIEREN oder wieder aufnehmen — ohne ihn wegzuwerfen.
   *
   * WARUM ES DAS GEBEN MUSS: Der Schalter auf der Karte löschte hier bisher.
   * „Aus" hieß, die Zeile verschwand vom Server, „an" legte eine neue an. Für
   * den Nutzer ist das etwas anderes als das, was er tut — er legt einen
   * Schalter um und meint eine Pause, keine Kündigung. Und der Unterschied
   * blieb nicht theoretisch: Die neu angelegte Zeile hatte eine neue Kennung,
   * eine zurückgesetzte Entprellung und keinen zuletzt gesehenen Preis mehr;
   * scheiterte das Anlegen beim Wiedereinschalten, stand in der App ein Alarm,
   * den es nirgends gab.
   *
   * Hier wird deshalb nur ein Merker umgelegt. Alles andere bleibt stehen:
   * Kennung, Grundpreis, Schwelle, `lastSeenPrice`. Die Prüfung liest ohnehin
   * nur aktive Alarme (`evaluateAlerts`), ein pausierter ist damit genauso
   * stumm wie ein gelöschter — nur eben wiederbelebbar.
   *
   * Ein Alarm, dessen Abfahrt schon vorbei ist, lässt sich hier wieder
   * einschalten. Das ist Absicht: Prüfen kann ihn ohnehin nur eine Suche auf
   * genau dieses Datum, und die App sucht nicht in der Vergangenheit. Der
   * tägliche Lauf setzt ihn beim nächsten Mal wieder auf inaktiv. Ihn hier
   * abzulehnen hieße, einen Fehlerweg für einen Fall zu bauen, der nichts
   * auslöst.
   */
  app.patch("/api/alerts/:id", { preHandler }, async (req, reply) => {
    const id = (req.params as { id?: string })?.id;
    const token = pushTokenOf(req);
    if (!id || !token) return reply.code(400).send({ error: "Bad request" });
    // Erst die Form der Kennung, dann erst Postgres — siehe Löschen darunter.
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Bad request" });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    /**
     * Die Push-Kennung MIT in die Bedingung — sie ist hier die Berechtigung,
     * wie beim Löschen. Ohne sie könnte jeder fremde Alarme stummschalten, der
     * eine Alarm-Kennung errät.
     */
    const [device] = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.token, token))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const changed = await db
      .update(priceAlerts)
      .set({ active: parsed.data.active })
      .where(and(eq(priceAlerts.id, id), eq(priceAlerts.pushTokenId, device.id)))
      .returning({ id: priceAlerts.id });
    /**
     * 404 „Unknown alert", wenn nichts umgelegt wurde — und das ist für die App
     * eine ANWEISUNG, keine Sackgasse: Beim Einschalten legt sie den Alarm
     * daraufhin neu an. Die Zeile kann fehlen, weil die Push-Kennung gewechselt
     * hat (Neuinstallation, Wiederherstellung, von Firebase als tot gemeldet)
     * und die Alarme per Kaskade mitgingen.
     *
     * Dieselbe Regel wie beim Löschen: Ein Erfolg, der nichts getan hat, ist
     * schlimmer als ein ehrlicher Fehlschlag.
     */
    if (changed.length === 0) return reply.code(404).send({ error: "Unknown alert" });
    return reply.code(204).send();
  });

  app.delete("/api/alerts/:id", { preHandler }, async (req, reply) => {
    const id = (req.params as { id?: string })?.id;
    const token = pushTokenOf(req);
    if (!id || !token) return reply.code(400).send({ error: "Bad request" });
    /**
     * Die Kennung MUSS eine UUID sein, bevor sie an Postgres geht.
     *
     * Ungeprüft warf die Datenbank `22P02`, Fastify machte daraus einen 500er
     * und reichte SQLSTATE und Original-Meldung nach außen. Aus der App nicht
     * auslösbar (die Kennung stammt immer vom Server), aber es war nach dem
     * Datums-Fix der letzte Weg, auf dem Interna den Server verlassen.
     */
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "Bad request" });
    /**
     * Die Push-Kennung MIT in die Bedingung — sonst könnte jeder fremde Alarme
     * löschen, der eine Kennung errät. Sie ist hier die Berechtigung, deshalb
     * wird sie geprüft und nicht nur mitgeschickt.
     */
    const [device] = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.token, token))
      .limit(1);
    if (!device) return reply.code(404).send({ error: "Unknown device" });
    const gone = await db
      .delete(priceAlerts)
      .where(and(eq(priceAlerts.id, id), eq(priceAlerts.pushTokenId, device.id)))
      .returning({ id: priceAlerts.id });
    /**
     * 204 NUR, wenn wirklich etwas weg ist.
     *
     * Hier stand ein bedingungsloses 204 — genau die Falle, vor der der
     * Kommentar auf der Client-Seite warnt, nur an der anderen Stelle
     * zugeschlagen: Wer eine fremde Alarm-Kennung schickt, löscht nichts und
     * bekommt trotzdem Erfolg gemeldet. Die App entfernt den Eintrag daraufhin
     * aus ihrer Liste, während er auf dem Server liegen bleibt und weiter alle
     * zwölf Stunden meldet — unsichtbar und unlöschbar.
     *
     * Ein Löschen, das nur so tut, ist schlimmer als eines, das scheitert: Beim
     * Scheitern bleibt der Eintrag stehen und man kann es erneut versuchen.
     */
    if (gone.length === 0) return reply.code(404).send({ error: "Unknown alert" });
    return reply.code(204).send();
  });
}
