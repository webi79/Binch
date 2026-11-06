import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runSearch } from "../services/searchService.js";
import { EXPENSIVE_IP_CEILING_FACTOR, ipLimiter, rateLimit } from "../util/rateLimit.js";
import { evaluateAlerts } from "../services/priceAlerts.js";
import type { TravelMode } from "../db/schema.js";
import { fareProfileFor } from "../util/fareProfile.js";

// Per-IP-Budget der Suche. Zwei Fenster: das Minutenfenster gegen Bursts, das
// Stundenfenster gegen den langsamen Dauertropf. 20/min ist um ein Vielfaches
// über echter Nutzung (ein Mensch sucht ein paar Mal pro Minute), aber kappt
// ein hämmerndes Skript hart. Jede Suche kann bis zu 3 RapidAPI- + weitere
// Provider-Calls auslösen — deshalb ist genau HIER der Deckel am wichtigsten.
const SEARCH_LIMITS = [
  { limit: 20, windowMs: 60 * 1000 },
  { limit: 120, windowMs: 60 * 60 * 1000 },
];
// ?nocache=1 umgeht den Cache und ERZWINGT frische Provider-Calls — auch für
// populäre Routen, die sonst gratis aus dem Cache kämen. Damit ist es der
// teuerste Modus und bekommt ein eigenes, enges Budget: Pull-to-Refresh (ein
// paar Mal die Minute) bleibt möglich, als Waffe taugt es nicht.
const NOCACHE_LIMIT = { limit: 6, windowMs: 60 * 1000 };

/**
 * Ein Datum, wie die App es schickt: `yyyy-MM-dd` oder ein voller
 * ISO-Zeitstempel. Vorher reichte „irgendein Text" — ein kaputtes Datum lief
 * bis in die Datenbank und kam als 500 mit deren roher Meldung zurück.
 */
const isoDateLike = z
  .string()
  .min(1)
  .max(40)
  .refine((v) => /^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: "Expected an ISO date (yyyy-MM-dd or ISO timestamp)",
  });

// .max() überall: die Werte landen in Cache-Keys, DB-Zeilen und Provider-URLs
// — ohne Deckel wären sie nur durch die URL-Gesamtlänge begrenzt.
const querySchema = z.object({
  origin: z.string().min(1).max(200),
  destination: z.string().min(1).max(200),
  originLabel: z.string().max(300).optional(),
  destLabel: z.string().max(300).optional(),
  departDate: isoDateLike,
  /** Optional ISO-UTC-Zeitstempel — Surroundings-Tap setzt das, normale Suche
   *  lässt's weg. Wird vom dbVendo-Provider als Suchfenster-Start verwendet. */
  departTime: isoDateLike.optional(),
  // Leer = einfache Fahrt. Als `undefined` weiter — ein leerer Text lief bis in
  // die Datumsspalte und endete als 500.
  returnDate: z
    .union([isoDateLike, z.literal("")])
    .optional()
    .transform((v) => v || undefined),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  // Groß geschrieben — die Alarm-Auswertung vergleicht die Währung zeichengenau.
  currency: z
    .string()
    .max(8)
    .default("EUR")
    .transform((v) => v.trim().toUpperCase()),
  /** i18n-Key (z.B. "search.class.business"). Provider entscheiden selbst,
   *  ob/wie sie das umsetzen — wir reichen den Wert nur durch. */
  travelClass: z.string().max(60).optional(),
  /** Ermäßigungskarte + Deutschlandticket (util/fareProfile.ts) — vereinheitlicht in `runSearch`. */
  fareProfile: z.string().max(40).optional(),
  /** ?nocache=1 erzwingt frische Provider-Anfrage, sonst greift der 2h-Cache. */
  nocache: z.coerce.boolean().optional(),
  /** ?nearby=1 erlaubt das Ausweichen auf nahegelegene Flughäfen. Nur wenn der
   *  Nutzer das im Leerzustand ausdrücklich anfordert (siehe SearchInput). */
  nearby: z.coerce.boolean().optional(),
  /** „Später"-Pagination: opaques Token aus der vorherigen Suche
   *  (HAFAS laterRef). Wird nur von TRAIN-Provider unterstützt; bei
   *  anderen Modes ignoriert. */
  paginationToken: z.string().max(2000).optional(),
});

const MODE_PATHS: Array<{ path: string; mode: TravelMode }> = [
  { path: "/api/search/flights", mode: "FLIGHT" },
  { path: "/api/search/trains", mode: "TRAIN" },
  { path: "/api/search/buses", mode: "BUS" },
  { path: "/api/search/cruises", mode: "CRUISE" },
];

/** Siehe die Prüfung vor `evaluateAlerts`: Spielraum für die Zeitzone. */
const ALERT_WINDOW_SLACK_MS = 90 * 60 * 1000;

export async function searchRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("search", SEARCH_LIMITS, { ipCeilingFactor: EXPENSIVE_IP_CEILING_FACTOR });
  for (const { path, mode } of MODE_PATHS) {
    app.get(path, { preHandler }, async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
      }
      // nocache: enges Zusatz-Budget OBEN DRAUF (der generelle Limiter lief schon
      // im preHandler). Nur nocache-Requests zählen gegen dieses Budget.
      if (parsed.data.nocache) {
        const rl = rateLimit("search-nocache", req.ip, NOCACHE_LIMIT.limit, NOCACHE_LIMIT.windowMs);
        if (!rl.allowed) {
          return reply
            .code(429)
            .header("Retry-After", rl.retryAfterSec)
            .send({ error: "Too many refreshes", retryAfterSec: rl.retryAfterSec });
        }
      }
      const result = await runSearch({
        ...parsed.data,
        mode,
        ip: req.ip,
        // Query heißt `nearby`, intern `allowNearby` — explizit abbilden, ein
        // Spread würde das Feld stillschweigend verschlucken.
        allowNearby: parsed.data.nearby === true,
      });
      /**
       * Preis-Alarme im NACHLAUF prüfen — bewusst ohne `await`.
       *
       * Hier hängt die ganze Alarm-Funktion, und sie hängt genau hier, weil an
       * dieser Stelle eine frische Trefferliste für eine Strecke vorliegt, für
       * die gerade jemand bezahlt hat (oder die aus dem Cache kam). Ein eigener
       * Lauf, der Alarme abarbeitet und dafür die Anbieter befragt, wäre der
       * naheliegende Weg und der falsche: Das Kontingent bei db-vendo liegt bei
       * rund 60 Anfragen pro Minute und gehört der SUCHE. So kostet die Prüfung
       * die Anbieter nichts — es bleibt ein indizierter Nachschlag.
       *
       * NICHT abgewartet, und das ist kein Schludern: Der Suchende hat mit
       * fremden Alarmen nichts zu tun, und seine Antwort darf nicht auf einen
       * Push-Dienst warten. `evaluateAlerts` wirft nie (es fängt intern alles
       * ab), es kann hier also keine unbehandelte Ablehnung entstehen.
       *
       * Auch bei einer Antwort aus dem Cache: Der Preis darin ist gültig, und
       * der Server hält ihn über seine eigene Auffrischung frisch.
       */
      /**
       * NICHT bei „Mehr Ergebnisse" — und das ist kein Feinschliff, sondern
       * die Regel „wir schätzen keine Preise".
       *
       * Mit `paginationToken` liefert der Anbieter die NÄCHSTE Seite, also
       * spätere Verbindungen desselben Tages. Deren günstigster Preis ist nicht
       * der günstigste der Strecke — er ist der günstigste eines Ausschnitts,
       * und der liegt fast immer höher. Daraus folgten zwei Schäden auf einmal:
       * Der zuletzt gesehene Preis wäre falsch fortgeschrieben, und ein Alarm
       * mit „auch bei Anstieg melden" feuerte eine Meldung über einen Anstieg,
       * den es nie gab. Wer sie anträfe, sähe in der Liste daraufhin eine
       * andere Zahl als in der Meldung.
       *
       * Geprüft wird deshalb nur auf der ERSTEN Seite. Sie enthält den
       * vollständigen Satz, gegen den ein Alarm gemeint ist.
       */
      if (parsed.data.paginationToken) return result;
      /**
       * Und nur, wenn die Suche den TAG abdeckt — nicht bloß einen späten
       * Ausschnitt.
       *
       * Mit einer gewählten Uhrzeit (etwa 18:00) fehlen die Fahrten davor; ihr
       * günstigster Preis ist der eines Ausschnitts, und ein Alarm mit „auch bei
       * Anstieg melden" meldete einen Anstieg, den es nicht gab. „Ab jetzt"
       * zählt als ganzer Tag: Früher Abgefahrenes kann ohnehin niemand mehr
       * kaufen. Anderthalb Stunden Spielraum decken die Zeitzone ab (das Datum
       * ist ein Kalendertag, die Uhrzeit UTC).
       */
      if (parsed.data.departTime) {
        const windowStart = Date.parse(parsed.data.departTime);
        const dayStart = Date.parse(`${parsed.data.departDate}T00:00:00Z`);
        const coveredFrom = Math.max(Date.now(), Number.isFinite(dayStart) ? dayStart : 0);
        if (Number.isFinite(windowStart) && windowStart - coveredFrom > ALERT_WINDOW_SLACK_MS) {
          return result;
        }
      }

      void evaluateAlerts(
        {
          mode,
          origin: parsed.data.origin,
          destination: parsed.data.destination,
          departDate: parsed.data.departDate,
          returnDate: parsed.data.returnDate,
          // Die Währung der Suche — ohne sie verglich der Server Beträge in
          // verschiedenen Währungen als wären es dieselben.
          currency: parsed.data.currency,
          // Und Reisende plus Klasse: Der Preis ist der Gesamtpreis der Gruppe.
          passengers: parsed.data.passengers,
          travelClass: parsed.data.travelClass ?? "",
          // Und der Tarif: Ein BahnCard-Preis prüft nur Alarme mit BahnCard.
          fareProfile: fareProfileFor(mode, parsed.data.fareProfile),
        },
        result.results,
      );
      return result;
    });
  }
}
