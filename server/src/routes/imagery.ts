/**
 * ESRI WORLD IMAGERY — nur in den Lücken, nur im Freikontingent, nur für die App.
 *
 * WARUM DURCHGEREICHT (und nicht der Schlüssel in der App): Ein Schlüssel auf dem
 * Gerät lässt sich auslesen und dann an uns vorbei beliebig nutzen — keine
 * Grenze, die wir setzen, hielte dann. Deshalb bleibt er hier, und die App holt
 * die Kacheln über `/api/tiles/esri/{z}/{x}/{y}`.
 *
 * DURCHREICHEN, NICHT SPEICHERN: Esris Rahmenvertrag (E204, 01.08.2025, 3.2 c)
 * verbietet, Basiskarten-Daten abzulegen („Customer may not otherwise scrape,
 * download, or store Data"); ein gemeinsamer Zwischenspeicher auf dem Server
 * wäre genau das. Diese Route speichert deshalb NICHTS — jede Kachel geht von
 * Esri direkt an das anfragende Gerät, das sie wie von Esri angegeben einen Tag
 * selbst behalten darf (`Cache-Control: private`, kein gemeinsamer Speicher
 * dazwischen). Das massenhafte Abziehen (E300, Punkt 10) verhindert der
 * Türsteher (services/esriGuard.ts).
 *
 * DER ABLAUF:
 *   1. Die App holt `/api/imagery/esri` (mit ihrer Installations-Kennung) und
 *      bekommt — wenn sie darf — eine Kachel-Adresse mit einem SCHEIN für heute.
 *   2. Jede Kachel-Anfrage trägt Kennung und Schein; der Türsteher prüft
 *      Sperren, Tagesdeckel (500 je Gerät), Tempo und Abtast-Muster.
 *   3. Gezählt wird exakt hier, in zwei Töpfen (Tabelle `imagery_usage`):
 *      - je ABRECHNUNGSZEITRAUM (Esri setzt das Freikontingent am Stichtag des
 *        Kontos zurück, `ESRI_CYCLE_DAY`, nicht am Monatsersten), Deckel
 *        `ESRI_MONTHLY_TILE_CAP` (1,9 Mio. von 2 Mio. frei);
 *      - je TAG ein Budget: Rest des Zeitraums ÷ verbleibende Tage. Auch viele
 *        IPs zusammen verbrauchen so höchstens einen Tagesanteil — der Rest des
 *        Zeitraums bleibt für die übrigen Tage.
 *   Ist ein Topf leer, ist Esri aus — es entstehen keine Kosten.
 *
 * FEHLERFALL = AUS: Ist der Stand eines Topfes nicht aus der Datenbank gelesen
 * (Neustart, Datenbank weg), gilt er als voll, bis das Lesen gelingt. Sonst
 * zählte ein Server nach einem Fehler wieder ab null und öffnete den Deckel.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { imageryUsage } from "../db/schema.js";
import { EsriGuard, ipKey, utcDay } from "../services/esriGuard.js";
import { amtlichesLuftbild } from "./tiles.js";
import { ipLimiter } from "../util/rateLimit.js";

/**
 * Esris Bilddienst „World Imagery" — 256-px-JPEG. Nicht die neueren „Static
 * Basemap Tiles": Die liefern 512-px-PNG, für Luftbilder ein Vielfaches an
 * Datenvolumen auf dem Telefon. Abgerechnet wird beides gleich (je Kachel).
 */
const UPSTREAM = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile";

/**
 * Pflicht-Nennung laut Esri (Text, kein Logo). Als Verweise: MapLibre auf
 * Android führt im ⓘ-Dialog nur verlinkte Teile auf.
 */
const ATTRIBUTION =
  '<a href="https://www.esri.com">Powered by Esri</a> · ' +
  '<a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community</a>';

const MIN_ZOOM = 13;
const MAX_ZOOM = 19;

/**
 * Programmkennungen, die keine App sind. Die App selbst (MapLibre) sendet
 * ihre eigene; ein Skript, das sich nicht einmal die Mühe macht, eine fremde
 * vorzutäuschen, wird gleich abgewiesen. (Kein Schutz für sich — nur die
 * erste, billigste Hürde.)
 */
const SCRIPT_AGENT =
  /\b(curl|wget|python|aiohttp|httpx|go-http-client|node-fetch|undici|axios|postman|insomnia|httpie|libwww|java\/|scrapy|headless|phantomjs)\b/i;

const guard = new EsriGuard();
let log: FastifyBaseLogger | null = null;

/* ── Zeiträume ────────────────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60_000;

/** Beginn des laufenden Esri-Abrechnungszeitraums (UTC, „JJJJ-MM-TT"). */
function cycleStart(t: number): Date {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const dayIn = (yy: number, mm: number) =>
    Math.min(config.ESRI_CYCLE_DAY, new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate());
  const thisMonth = Date.UTC(y, m, dayIn(y, m));
  return t >= thisMonth ? new Date(thisMonth) : new Date(Date.UTC(y, m - 1, dayIn(y, m - 1)));
}

function nextCycleStart(t: number): number {
  const s = cycleStart(t);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth() + 1;
  return Date.UTC(y, m, Math.min(config.ESRI_CYCLE_DAY, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()));
}

/* ── Zähler: im Speicher, alle 10 s in die Datenbank ─────────────────────── */

/**
 * Ein Topf (Zeitraum oder Tag). `known` erst, wenn sein Stand gelesen ist —
 * vorher gilt er als voll. Ungespeicherte Kacheln bleiben ihrem Schlüssel
 * zugeordnet, auch über einen Wechsel hinweg.
 */
class Counter {
  key = "";
  count = 0;
  known = false;
  private loading: Promise<void> | null = null;
  private lastTry = 0;
  private unsaved = new Map<string, number>();

  constructor(
    private readonly provider: string,
    private readonly keyOf: (t: number) => string,
  ) {}

  async ensure(t: number): Promise<void> {
    const k = this.keyOf(t);
    if (k !== this.key) {
      // Wechsel SOFORT, vor jedem await — sonst überschriebe eine zweite
      // Anfrage die Zählung der ersten.
      this.key = k;
      this.count = this.unsaved.get(k) ?? 0;
      this.known = false;
      this.loading = null;
      this.lastTry = 0;
    }
    if (!this.known && !this.loading && t - this.lastTry > 5_000) {
      this.lastTry = t;
      const key = k;
      this.loading = (async () => {
        try {
          const rows = await db.execute(
            sql`SELECT tiles FROM ${imageryUsage} WHERE provider = ${this.provider} AND month = ${key}`,
          );
          const r = (rows as unknown as { rows: Array<{ tiles: string | number }> }).rows[0];
          if (this.key === key) {
            this.count += r ? Number(r.tiles) : 0;
            this.known = true;
          }
        } catch (err) {
          log?.error({ err: (err as Error).message, provider: this.provider }, "[esri] Zählerstand nicht lesbar — Esri bleibt aus");
        } finally {
          this.loading = null;
        }
      })();
    }
    if (this.loading) await this.loading;
  }

  add(n: number): void {
    this.count += n;
    this.unsaved.set(this.key, (this.unsaved.get(this.key) ?? 0) + n);
  }

  async flush(): Promise<void> {
    for (const [k, n] of [...this.unsaved]) {
      if (n <= 0) {
        this.unsaved.delete(k);
        continue;
      }
      // Den laufenden Topf erst schreiben, wenn sein Stand gelesen ist —
      // sonst stünde das Geschriebene beim Lesen doppelt in der Summe.
      if (k === this.key && !this.known) continue;
      this.unsaved.delete(k);
      try {
        const rows = await db.execute(sql`
          INSERT INTO ${imageryUsage} (provider, month, tiles, updated_at)
          VALUES (${this.provider}, ${k}, ${n}, now())
          ON CONFLICT (provider, month)
          DO UPDATE SET tiles = ${imageryUsage}.tiles + EXCLUDED.tiles, updated_at = now()
          RETURNING tiles`);
        const total = Number((rows as unknown as { rows: Array<{ tiles: string | number }> }).rows[0]?.tiles ?? 0);
        // Mit dem Stand der Datenbank abgleichen — zählt ein zweiter Server
        // (oder die Entwicklung mit demselben Schlüssel) mit, sieht dieser es.
        if (k === this.key && this.known) this.count = Math.max(this.count, total + (this.unsaved.get(k) ?? 0));
      } catch (err) {
        this.unsaved.set(k, (this.unsaved.get(k) ?? 0) + n);
        log?.error({ err: (err as Error).message, provider: this.provider }, "[esri] Zählerstand nicht gespeichert");
      }
    }
  }
}

const period = new Counter("esri", (t) => cycleStart(t).toISOString().slice(0, 10));
const today = new Counter("esri-day", (t) => utcDay(t));

/** Gespeichert wird alle 10 s und beim Herunterfahren (index.ts). */
export async function flushEsriUsage(): Promise<void> {
  await period.flush();
  await today.flush();
}
setInterval(() => void flushEsriUsage(), 10_000).unref();

/** Verbrauchsstufen, die je Zeitraum einmal protokolliert werden. */
const warned = new Set<string>();

/** Warum Esri gerade aus ist — oder `null`, wenn es läuft. Prüft beide Töpfe. */
async function budgetDeny(): Promise<string | null> {
  const t = Date.now();
  await Promise.all([period.ensure(t), today.ensure(t)]);
  if (!period.known || !today.known) return "unknown";
  const cap = config.ESRI_MONTHLY_TILE_CAP;
  for (const p of [50, 80, 95, 100]) {
    const tag = `${period.key}:${p}`;
    if (period.count >= (cap * p) / 100 && !warned.has(tag)) {
      warned.add(tag);
      log?.warn({ used: period.count, cap, period: period.key }, `[esri] ${p} % des Kontingents verbraucht`);
    }
  }
  if (period.count >= cap) return "cap";
  // Tagesbudget: was zu Tagesbeginn übrig war, gleich auf die restlichen Tage verteilt.
  const daysLeft = Math.max(1, Math.ceil((nextCycleStart(t) - Date.UTC(...ymd(t))) / DAY_MS));
  const startOfDay = period.count - today.count;
  const budget = Math.floor((cap - startOfDay) / daysLeft);
  if (today.count >= budget) return "day-budget";
  return null;
}

function ymd(t: number): [number, number, number] {
  const d = new Date(t);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/* ── Esri-Gesundheit: abgelaufener Schlüssel, Störung ─────────────────────── */

let upstreamDownUntil = 0;
let upstreamReason = "";

function markUpstream(status: number): void {
  // 401/403/498/499: Schlüssel abgelaufen, widerrufen oder Konto gesperrt —
  // länger aus. 429/5xx: Esri gestört oder bremst — kurz aus.
  const keyProblem = [401, 403, 498, 499].includes(status);
  const ms = keyProblem ? 5 * 60_000 : 60_000;
  const reason = keyProblem ? "key" : "upstream";
  if (Date.now() >= upstreamDownUntil || upstreamReason !== reason) {
    log?.error({ status }, keyProblem
      ? "[esri] Schlüssel abgelehnt (abgelaufen/widerrufen?) — Esri 5 min aus, ESRI_API_KEY prüfen"
      : "[esri] Esri antwortet mit Fehler — 1 min aus");
  }
  upstreamDownUntil = Date.now() + ms;
  upstreamReason = reason;
}

/* ── Der Schein: an Kennung und Tag gebunden, signiert ────────────────────── */

function ticketSecret(): string {
  // Eigenes Geheimnis, wenn gesetzt — dann bleiben die Scheine beim Tausch des
  // Esri-Schlüssels gültig. Sonst vom Schlüssel abgeleitet.
  return config.ESRI_TICKET_SECRET ?? `binch-esri-ticket:${config.ESRI_API_KEY ?? ""}`;
}

function ticketFor(clientId: string, day: string): string {
  return createHmac("sha256", ticketSecret()).update(`${clientId}.${day}`).digest("base64url").slice(0, 32);
}

function ticketValid(clientId: string, ticket: string): boolean {
  const t = Date.now();
  // Heute — oder gestern, für Geräte, die kurz nach Mitternacht (UTC) ihren
  // neuen Schein noch nicht abgeholt haben.
  for (const day of [utcDay(t), utcDay(t - DAY_MS)]) {
    const want = Buffer.from(ticketFor(clientId, day));
    const got = Buffer.from(ticket);
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

const CLIENT_ID = /^[A-Za-z0-9-]{16,64}$/;

function clientIdOf(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers["x-client-id"];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === "string" && CLIENT_ID.test(id) ? id : null;
}

/** Für das Protokoll: nur der Anfang der Kennung (keine Verfolgbarkeit über Protokolle). */
const shortId = (id: string) => `${id.slice(0, 6)}…`;

const tileParams = z.object({
  z: z.coerce.number().int().min(MIN_ZOOM).max(MAX_ZOOM),
  x: z.coerce.number().int().min(0),
  y: z.coerce.number().int().min(0),
});
const tileQuery = z.object({
  c: z.string().regex(CLIENT_ID),
  t: z.string().min(16).max(64),
});

export async function imageryRoutes(app: FastifyInstance) {
  log = app.log;
  const configLimiter = ipLimiter("imagery-config", [{ limit: 60, windowMs: 60_000 }]);

  /** Darf diese App gerade Esri zeigen — und wenn ja, über welche Adresse? */
  app.get("/api/imagery/esri", { preHandler: configLimiter }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    if (config.ESRI_TERMINATED) return { enabled: false, reason: "terminated" };
    if (!config.ESRI_API_KEY) return { enabled: false, reason: "no-key" };
    if (Date.now() < upstreamDownUntil) return { enabled: false, reason: upstreamReason };
    const budget = await budgetDeny();
    if (budget) return { enabled: false, reason: budget };
    const clientId = clientIdOf(req);
    if (!clientId) return { enabled: false, reason: "no-client" };
    const deny = guard.admit(clientId, req.ip);
    if (deny) return { enabled: false, reason: deny };
    const ticket = ticketFor(clientId, utcDay(Date.now()));
    return {
      enabled: true,
      // Ohne Rechnername — die App setzt ihre Server-Adresse davor.
      tilePath: `/api/tiles/esri/{z}/{x}/{y}?c=${clientId}&t=${ticket}`,
      minzoom: MIN_ZOOM,
      maxzoom: MAX_ZOOM,
      attribution: ATTRIBUTION,
      remainingToday: guard.remaining(clientId),
    };
  });

  /**
   * Eine Esri-Kachel — durchgereicht, nicht gespeichert.
   *
   * Abgelehnt wird mit 404 und `no-store`: MapLibre fragt eine fehlende Kachel
   * dann nicht in einer Schleife neu an (bei 429 täte es das), und darunter
   * scheint die Rückfallebene (Copernicus bzw. das weltweite Satellitenbild).
   *
   * `logLevel: "warn"`: Die Adresse trägt Installations-Kennung, Schein und
   * Ort — als Anfrage-Protokoll wäre das eine Ortsspur je Gerät.
   */
  app.get("/api/tiles/esri/:z/:x/:y", { logLevel: "warn" }, async (req, reply) => {
    const empty = () => reply.code(404).header("Cache-Control", "no-store").send();
    if (!config.ESRI_API_KEY || config.ESRI_TERMINATED) return empty();
    const p = tileParams.safeParse(req.params);
    const q = tileQuery.safeParse(req.query);
    if (!p.success || !q.success) return empty();
    const { z: zoom, x, y } = p.data;
    if (x >= 2 ** zoom || y >= 2 ** zoom) return empty();
    const ua = req.headers["user-agent"] ?? "";
    if (!ua || SCRIPT_AGENT.test(ua)) return empty();
    // Aus einem Browser? Dann bettet jemand unsere Kacheln in eine fremde
    // Seite ein (ein `<img>` braucht kein CORS). MapLibre in der App sendet
    // keine dieser Kopfzeilen; jeder heutige Browser sendet `Sec-Fetch-*`.
    const h = req.headers;
    if (h["sec-fetch-mode"] || h["sec-fetch-site"] || h["sec-fetch-dest"] || h.origin || h.referer) return empty();
    const { c: clientId, t: ticket } = q.data;
    if (!ticketValid(clientId, ticket)) return empty();
    if (Date.now() < upstreamDownUntil) return empty();
    if (await budgetDeny()) return empty();
    // Hier gibt es ein amtliches Bild (oder es ist gerade unklar) — dann kein
    // Esri: Die App zeigt darunter das bessere Bild, und es kostet nichts.
    if ((await amtlichesLuftbild(zoom, x, y)) !== false) return empty();
    const deny = guard.check(clientId, req.ip, zoom, x, y);
    if (deny) {
      if (deny === "script-speed" || deny === "script-scan") {
        log?.warn({ reason: deny, ip: ipKey(req.ip), client: shortId(clientId) }, "[esri] Kennung als Skript gesperrt (24 h)");
      }
      return empty();
    }

    /** Vorübergehend nicht zu bekommen: 503 — darauf versucht MapLibre es später erneut. */
    const later = () => reply.code(503).header("Cache-Control", "no-store").send();
    try {
      // `blankTile=false`: Wo Esri auf dieser Stufe nichts hat, kommt sonst ein
      // graues „Map data not yet available"-Bild — abgerechnet und über die
      // Rückfallebene gelegt. So kommt stattdessen ein 404.
      const res = await fetch(
        `${UPSTREAM}/${zoom}/${y}/${x}?blankTile=false&token=${encodeURIComponent(config.ESRI_API_KEY)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      const type = res.headers.get("content-type") ?? "";
      const blank = res.headers.get("blank-tile") === "true";
      if (!res.ok || !type.startsWith("image/") || blank) {
        guard.release(clientId, req.ip);
        // 404 (bzw. ein Platzhalter) heißt bei Esri „keine Kachel hier" — kein
        // Fehler. Alles andere schon, auch ein 200 mit JSON (Esri meldet
        // Schlüsselfehler teils so).
        if (res.status === 404 || blank) return empty();
        let status = res.status;
        if (res.ok) {
          const body = await res.text().catch(() => "");
          const m = /"code"\s*:\s*(\d{3})/.exec(body);
          status = m ? Number(m[1]) : 502;
        }
        markUpstream(status);
        return status === 429 || status >= 500 ? later() : empty();
      }
      const body = Buffer.from(await res.arrayBuffer());
      // Esri rechnet jede gelieferte Kachel ab — genau die zählen wir.
      period.add(1);
      today.add(1);
      return reply
        .header("Content-Type", type)
        // Esri selbst sendet `max-age=86400`. `private`: nur das Gerät, kein
        // gemeinsamer Zwischenspeicher (Proxy, CDN) unterwegs.
        .header("Cache-Control", "private, max-age=86400")
        .send(body);
    } catch {
      // Zeitüberschreitung oder Netzfehler — vorübergehend.
      guard.release(clientId, req.ip);
      return later();
    }
  });
}
