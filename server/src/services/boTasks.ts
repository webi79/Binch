/**
 * GEPLANTE AUFGABEN — Bo führt sie selbst aus und meldet sich (Tabellen
 * `bo_tasks`, `bo_task_runs`; in der App: Bo → Seitenleiste → „Geplant").
 *
 * Stufe 1 kennt eine Art: `route_status`, die Lage auf einer Strecke —
 * Ausfälle, Verspätungen, Gleiswechsel, gefährdete Anschlüsse.
 *
 * ZEITPLAN: an gewählten Wochentagen zu einer Ortszeit („Werktags 8:00"). Mit
 * `watchUntil` beobachtet Bo danach weiter, alle zehn Minuten bis zu dieser
 * Uhrzeit, und meldet sich nur bei einer NEUEN Störung.
 *
 * WAHRHEIT: Jede Aussage kommt aus der Abfrage dieses Laufs, mit Stand. Kam
 * keine Echtzeit, sagt der Text genau das — „keine Meldung" ist nie
 * „alles planmäßig". Die Texte sind feste Vorlagen mit den echten Werten,
 * keine KI: sofort da, kostenlos, nichts erfunden.
 *
 * KOSTEN: Eine DB-Abfrage je Lauf (Gleise in DE stimmen nur aus dieser Quelle;
 * MOTIS ist der Rückfall — ohne Gleise). Gleiche Strecken im selben Fenster
 * teilen sich eine Abfrage; der Lauf zur Uhrzeit startet je Aufgabe bis zu zwei
 * Minuten früher, damit nicht alle „um 8" in derselben Sekunde anfragen.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, lte, notInArray } from "drizzle-orm";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { db } from "../db/client.js";
import { boTaskRuns, boTasks, pushTokens, type BoTaskNotify, type BoTaskStatus } from "../db/schema.js";
import { dbVendoProvider } from "../providers/train/dbVendo.js";
import { motisProvider } from "../providers/train/motis.js";
import type { NormalizedResult, ProviderSearchInput } from "../providers/types.js";
import { sendPushCounted, type PushMessage } from "./priceAlerts.js";

/** Höchstens so viele AKTIVE Aufgaben je Konto. */
export const TASK_LIMIT = 5;
const LOOP_MS = 30_000;
const WATCH_EVERY_MS = 10 * 60_000;
/** Bis so lange nach der Uhrzeit gilt ein Lauf noch als „der zur Uhrzeit" (Neustart, volle Schleife). */
const SCHEDULE_GRACE_MS = 5 * 60_000;
/** Ohne Wache: verspätet nachholen nur bis dahin — eine 8-Uhr-Lage um halb zehn hilft niemandem. */
const LATE_LIMIT_MS = 30 * 60_000;
const LOOKAHEAD_MS = 2 * 3_600_000;
/** Mitteilungen verfallen danach — eine Lage von 8 Uhr ist um 9 überholt. */
const PUSH_TTL_MS = 30 * 60_000;
const RUNS_KEPT = 30;
const BATCH = 10;
const MANUAL_COOLDOWN_MS = 60_000;
const ROUTE_CACHE_MS = 2 * 60_000;
/** Der Kanal, den die App für diese Mitteilungen anlegt. */
const CHANNEL = "bo-updates";
/** Bitmaske der Wochentage, Index = ISO-Wochentag − 1 (Mo = 1 … So = 64). */
const DAY_BITS = [1, 2, 4, 8, 16, 32, 64];

export type BoTask = typeof boTasks.$inferSelect;
type Trigger = "schedule" | "watch" | "manual";
type Locale = "de" | "en" | "fr" | "es";

export class TaskLimitError extends Error {}

// ---------------------------------------------------------------------------
// Zeitplan
// ---------------------------------------------------------------------------

function at(ymd: string, hm: string, tz: string): Date {
  return fromZonedTime(`${ymd}T${hm}:00`, tz);
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO-Wochentag (1 = Mo) eines Kalendertags in `tz` — über Mittag, keine Sommerzeit-Kante. */
function isoWeekday(ymd: string, tz: string): number {
  return Number(formatInTimeZone(at(ymd, "12:00", tz), tz, "i"));
}

/** Vorlauf je Aufgabe (0–119 s), aus der Kennung — immer derselbe. */
function leadMs(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 120) * 1000;
}

type Schedule = Pick<BoTask, "id" | "days" | "time" | "watchUntil" | "timezone">;

/** Der nächste Lauf nach `now` — oder `null`, wenn kein Tag gewählt ist. */
export function computeNextRun(task: Schedule, now: Date): Date | null {
  const today = formatInTimeZone(now, task.timezone, "yyyy-MM-dd");
  for (let d = 0; d < 8; d++) {
    const ymd = addDaysYmd(today, d);
    if (!(task.days & DAY_BITS[isoWeekday(ymd, task.timezone) - 1]!)) continue;
    const start = new Date(at(ymd, task.time, task.timezone).getTime() - leadMs(task.id));
    if (start > now) return start;
    if (task.watchUntil) {
      const next = new Date(now.getTime() + WATCH_EVERY_MS);
      if (next < at(ymd, task.watchUntil, task.timezone)) return next;
    }
  }
  return null;
}

/**
 * Der erste Lauf nach Anlegen oder Ändern.
 *
 * Der Vorlauf ist nur Streuung. Liegt die Uhrzeit noch vor uns, der Vorlauf aber
 * schon dahinter („in einer Minute"), läuft die Aufgabe pünktlich zur Uhrzeit —
 * sonst stünde sie still bis zum nächsten gewählten Tag, und es sähe aus, als
 * hätte Bo sie vergessen.
 */
export function firstRun(task: Schedule, now: Date): Date | null {
  const next = computeNextRun(task, now);
  const today = formatInTimeZone(now, task.timezone, "yyyy-MM-dd");
  if (!(task.days & DAY_BITS[isoWeekday(today, task.timezone) - 1]!)) return next;
  const scheduled = at(today, task.time, task.timezone);
  return scheduled > now && (next === null || scheduled < next) ? scheduled : next;
}

/** Was für ein Lauf gerade fällig ist — oder `skip`, wenn er zu spät käme. */
function triggerFor(task: BoTask, now: Date): Trigger | "skip" {
  const today = formatInTimeZone(now, task.timezone, "yyyy-MM-dd");
  const scheduled = at(today, task.time, task.timezone).getTime();
  const t = now.getTime();
  if (t >= scheduled - leadMs(task.id) - 1000 && t <= scheduled + SCHEDULE_GRACE_MS) return "schedule";
  if (task.watchUntil && t < at(today, task.watchUntil, task.timezone).getTime()) return "watch";
  // Ohne Wache: verpasster Lauf (Neustart) — kurz danach noch nachholen, sonst auslassen.
  if (!task.watchUntil && t > scheduled && t - scheduled <= LATE_LIMIT_MS) return "schedule";
  return "skip";
}

// ---------------------------------------------------------------------------
// Abfrage und Auswertung
// ---------------------------------------------------------------------------

interface TripFact {
  line: string;
  /** Geplante Abfahrt (UTC-ISO). */
  depart: string;
  arrive: string;
  platform?: string;
  /** Gleiswechsel: das neue Gleis. */
  platformRt?: string;
  /** Verspätung der Abfahrt in Minuten — fehlt bei Pünktlichkeit und ohne Echtzeit. */
  delay?: number;
  /** Für die Abfahrt liegt Echtzeit vor, auch bei 0 Minuten. */
  realtime: boolean;
  cancelled: boolean;
  atRisk: boolean;
}

interface RouteData {
  source: "db" | "motis" | null;
  trips: TripFact[];
}

const routeCache = new Map<string, { at: number; value: Promise<RouteData> }>();

function factOf(r: NormalizedResult, withPlatforms: boolean): TripFact {
  const legs = (r.legs ?? []).filter((l) => !l.walking);
  const first = legs[0];
  return {
    line: r.flightNumber ?? first?.line ?? "",
    depart: r.departTime,
    arrive: r.arriveTime,
    platform: withPlatforms ? first?.departPlatform : undefined,
    platformRt: withPlatforms ? first?.departPlatformRt : undefined,
    delay: r.departDelayMinutes,
    realtime: r.departRealtime === true || (r.departDelayMinutes ?? 0) > 0,
    cancelled: r.warning === "cancelled" || legs.some((l) => l.warning === "cancelled"),
    atRisk: r.warning === "connectionAtRisk",
  };
}

async function fetchRoute(task: BoTask, from: Date): Promise<RouteData> {
  const input: ProviderSearchInput = {
    mode: "TRAIN",
    origin: task.origin,
    destination: task.destination,
    originLabel: task.originLabel,
    destLabel: task.destLabel,
    departDate: formatInTimeZone(from, task.timezone, "yyyy-MM-dd"),
    departTime: from.toISOString(),
    passengers: 1,
    currency: "EUR",
  };
  const outbound = (rs: NormalizedResult[]) => rs.filter((r) => r.direction !== "RETURN");
  if (dbVendoProvider.isConfigured()) {
    try {
      const r = await dbVendoProvider.search(input, AbortSignal.timeout(20_000));
      const trips = outbound(r.results).map((x) => factOf(x, true));
      if (trips.length > 0) return { source: "db", trips };
    } catch {
      // Rückfall unten.
    }
  }
  // MOTIS: Gleise in DE sind dort falsch — darum ohne.
  if (motisProvider.isConfigured()) {
    try {
      const r = await motisProvider.search(input, AbortSignal.timeout(20_000));
      const trips = outbound(r.results).map((x) => factOf(x, false));
      if (trips.length > 0) return { source: "motis", trips };
    } catch {
      // Dann eben keine Daten — das sagt der Text.
    }
  }
  return { source: null, trips: [] };
}

/** Gleiche Strecke im selben Fünf-Minuten-Fenster = eine Abfrage für alle. */
function routeData(task: BoTask, from: Date): Promise<RouteData> {
  const key = `${task.origin}|${task.destination}|${Math.floor(from.getTime() / 300_000)}`;
  const now = Date.now();
  const hit = routeCache.get(key);
  if (hit && now - hit.at < ROUTE_CACHE_MS) return hit.value;
  const value = fetchRoute(task, from);
  routeCache.set(key, { at: now, value });
  if (routeCache.size > 200) {
    for (const [k, v] of routeCache) if (now - v.at > ROUTE_CACHE_MS) routeCache.delete(k);
  }
  return value;
}

type IssueKind = "cancelled" | "delay" | "platform" | "connection";
interface Issue {
  kind: IssueKind;
  trip: TripFact;
}

interface Evaluation {
  status: BoTaskStatus;
  trips: TripFact[];
  issues: Issue[];
  /** Für `unknown`: keine Fahrten oder keine Echtzeit. */
  reason?: "noTrips" | "noRealtime";
  issueKey: string | null;
  /** Bei einem Ausfall: die nächste Fahrt, die fährt. */
  alternative?: TripFact;
}

/** Ab so viel Verspätung ist es eine Meldung wert. */
const DELAY_MIN = 5;

function evaluate(data: RouteData, from: Date, until: Date): Evaluation {
  const seen = new Set<string>();
  const trips = data.trips
    .filter((t) => {
      const d = Date.parse(t.depart);
      return Number.isFinite(d) && d >= from.getTime() - 60_000 && d <= until.getTime();
    })
    .sort((a, b) => Date.parse(a.depart) - Date.parse(b.depart))
    .filter((t) => {
      const k = `${t.line}|${t.depart}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
  if (trips.length === 0) return { status: "unknown", trips, issues: [], reason: "noTrips", issueKey: null };

  const issues: Issue[] = [];
  for (const trip of trips) {
    if (trip.cancelled) issues.push({ kind: "cancelled", trip });
    else {
      if ((trip.delay ?? 0) >= DELAY_MIN) issues.push({ kind: "delay", trip });
      if (trip.platformRt) issues.push({ kind: "platform", trip });
      if (trip.atRisk) issues.push({ kind: "connection", trip });
    }
  }
  if (issues.length > 0) {
    const first = issues.find((i) => i.kind === "cancelled");
    const alternative = first
      ? trips.find((t) => !t.cancelled && Date.parse(t.depart) > Date.parse(first.trip.depart))
      : undefined;
    const issueKey = issues
      .map((i) => `${i.trip.line}|${i.trip.depart}|${i.kind}|${i.trip.delay ?? ""}|${i.trip.platformRt ?? ""}`)
      .sort()
      .join(";")
      .slice(0, 400);
    return { status: "issue", trips, issues, issueKey, alternative };
  }
  // „Alles planmäßig" nur für Fahrten, zu denen die Echtzeit das auch sagt.
  const live = trips.filter((t) => t.realtime);
  return live.length > 0
    ? { status: "ok", trips: live, issues, issueKey: null }
    : { status: "unknown", trips, issues, reason: "noRealtime", issueKey: null };
}

// ---------------------------------------------------------------------------
// Texte — feste Vorlagen mit den echten Werten
// ---------------------------------------------------------------------------

interface Words {
  at: string;
  platform: string;
  ok: string;
  okLine: (ref: string) => string;
  then: (ref: string) => string;
  cancelled: (ref: string) => string;
  next: (ref: string) => string;
  delay: (ref: string, n: number, newTime: string) => string;
  platformChange: (ref: string, rt: string, planned: string) => string;
  connection: (ref: string) => string;
  noRealtime: (ref: string) => string;
  noTrips: string;
  unknown: string;
}

const WORDS: Record<Locale, Words> = {
  de: {
    at: "um",
    platform: "Gleis",
    ok: "Alles planmäßig",
    okLine: (r) => `Alles planmäßig: ${r}.`,
    then: (r) => `Danach ${r}.`,
    cancelled: (r) => `${r} fällt aus.`,
    next: (r) => `Nächste Fahrt: ${r}.`,
    delay: (r, n, t) => `${r} heute ${n} Min später (${t}).`,
    platformChange: (r, rt, p) => `${r} fährt von Gleis ${rt} statt ${p}.`,
    connection: (r) => `${r}: Anschluss gefährdet.`,
    noRealtime: (r) => `Noch keine Echtzeit. Laut Fahrplan: ${r}.`,
    noTrips: "Für diese Strecke kam gerade keine Verbindung – die Lage ist unbekannt.",
    unknown: "Lage unbekannt",
  },
  en: {
    at: "at",
    platform: "platform",
    ok: "All on time",
    okLine: (r) => `All on time: ${r}.`,
    then: (r) => `Then ${r}.`,
    cancelled: (r) => `${r} is cancelled.`,
    next: (r) => `Next: ${r}.`,
    delay: (r, n, t) => `${r} is running ${n} min late (${t}).`,
    platformChange: (r, rt, p) => `${r} leaves from platform ${rt} instead of ${p}.`,
    connection: (r) => `${r}: connection at risk.`,
    noRealtime: (r) => `No live data yet. Timetable: ${r}.`,
    noTrips: "No connections came back for this route – status unknown.",
    unknown: "Status unknown",
  },
  fr: {
    at: "de",
    platform: "voie",
    ok: "Tout est à l'heure",
    okLine: (r) => `Tout est à l'heure : ${r}.`,
    then: (r) => `Ensuite ${r}.`,
    cancelled: (r) => `${r} est supprimé.`,
    next: (r) => `Prochain : ${r}.`,
    delay: (r, n, t) => `${r} a ${n} min de retard (${t}).`,
    platformChange: (r, rt, p) => `${r} part de la voie ${rt} au lieu de ${p}.`,
    connection: (r) => `${r} : correspondance compromise.`,
    noRealtime: (r) => `Pas encore de temps réel. Horaire : ${r}.`,
    noTrips: "Aucune liaison reçue pour ce trajet – situation inconnue.",
    unknown: "Situation inconnue",
  },
  es: {
    at: "de las",
    platform: "vía",
    ok: "Todo puntual",
    okLine: (r) => `Todo puntual: ${r}.`,
    then: (r) => `Después ${r}.`,
    cancelled: (r) => `${r} está cancelado.`,
    next: (r) => `Siguiente: ${r}.`,
    delay: (r, n, t) => `${r} lleva ${n} min de retraso (${t}).`,
    platformChange: (r, rt, p) => `${r} sale de la vía ${rt} en lugar de ${p}.`,
    connection: (r) => `${r}: conexión en riesgo.`,
    noRealtime: (r) => `Aún sin tiempo real. Horario: ${r}.`,
    noTrips: "No llegó ninguna conexión para esta ruta: situación desconocida.",
    unknown: "Situación desconocida",
  },
};

function asLocale(v: string | null | undefined): Locale {
  return v === "en" || v === "fr" || v === "es" ? v : "de";
}

function compose(ev: Evaluation, localeRaw: string, tz: string): { headline: string; text: string } {
  const w = WORDS[asLocale(localeRaw)];
  const hm = (iso: string, plusMin = 0) => formatInTimeZone(new Date(Date.parse(iso) + plusMin * 60_000), tz, "H:mm");
  const ref = (t: TripFact) => `${t.line ? `${t.line} ` : ""}${w.at} ${hm(t.depart)}`.trim();
  const withPlatform = (t: TripFact) => `${ref(t)}${t.platform ? `, ${w.platform} ${t.platformRt ?? t.platform}` : ""}`;

  if (ev.status === "unknown") {
    const text = ev.reason === "noRealtime" && ev.trips[0] ? w.noRealtime(withPlatform(ev.trips[0])) : w.noTrips;
    return { headline: w.unknown, text };
  }
  if (ev.status === "ok") {
    const [a, b] = ev.trips;
    const text = [w.okLine(withPlatform(a!)), b ? w.then(ref(b)) : ""].filter(Boolean).join(" ");
    return { headline: w.ok, text };
  }
  const sentences: string[] = [];
  for (const i of ev.issues.slice(0, 3)) {
    if (i.kind === "cancelled") sentences.push(w.cancelled(ref(i.trip)));
    else if (i.kind === "delay") sentences.push(w.delay(ref(i.trip), i.trip.delay ?? 0, hm(i.trip.depart, i.trip.delay ?? 0)));
    else if (i.kind === "platform") sentences.push(w.platformChange(ref(i.trip), i.trip.platformRt ?? "?", i.trip.platform ?? "?"));
    else sentences.push(w.connection(ref(i.trip)));
  }
  if (ev.alternative) sentences.push(w.next(withPlatform(ev.alternative)));
  const headline = (sentences[0] ?? "").replace(/[.:]\s*$/, "");
  return { headline, text: sentences.join(" ") };
}

// ---------------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------------

export interface TaskRun {
  id: string;
  ranAt: Date;
  trigger: string;
  status: BoTaskStatus;
  title: string;
  body: string;
  facts: Record<string, unknown> | null;
  pushed: boolean;
}

export async function runTask(task: BoTask, trigger: Trigger, now = new Date()): Promise<TaskRun> {
  const today = formatInTimeZone(now, task.timezone, "yyyy-MM-dd");
  const scheduled = at(today, task.time, task.timezone);
  const from = trigger === "schedule" ? new Date(Math.max(now.getTime(), scheduled.getTime())) : now;
  const until =
    trigger !== "manual" && task.watchUntil
      ? new Date(at(today, task.watchUntil, task.timezone).getTime() + 15 * 60_000)
      : new Date(from.getTime() + LOOKAHEAD_MS);

  const data = await routeData(task, from);
  const ev = evaluate(data, from, until);
  const { headline, text } = compose(ev, task.locale, task.timezone);

  let push = false;
  if (trigger === "schedule") push = task.notify === "always" || ev.status === "issue";
  else if (trigger === "watch") push = ev.status === "issue" && ev.issueKey !== task.lastIssueKey;

  const facts = {
    source: data.source,
    checkedAt: now.toISOString(),
    reason: ev.reason ?? null,
    trips: ev.trips,
  };
  const [run] = await db
    .insert(boTaskRuns)
    .values({ taskId: task.id, ranAt: now, trigger, status: ev.status, title: headline.slice(0, 120), body: text.slice(0, 600), facts, pushed: false })
    .returning();

  await db
    .update(boTasks)
    .set({
      lastRunAt: now,
      lastStatus: ev.status,
      lastSummary: text.slice(0, 300),
      // Gemeldete Störung merken; ruhige Lage räumt sie, „unbekannt" lässt sie stehen.
      lastIssueKey: ev.status === "issue" ? ev.issueKey : ev.status === "ok" ? null : task.lastIssueKey,
      // „Jetzt prüfen" verschiebt den Plan nicht.
      ...(trigger === "manual" ? {} : { nextRunAt: task.active ? computeNextRun(task, now) : null }),
      updatedAt: now,
    })
    .where(eq(boTasks.id, task.id));
  await pruneRuns(task.id);

  // Erst vermerken, was wirklich hinausging: Die Zeitleiste sagt sonst „gemeldet",
  // obwohl das Konto gar kein erreichbares Gerät hat.
  if (push && run && (await pushRun(task, run.id, ev))) {
    await db.update(boTaskRuns).set({ pushed: true }).where(eq(boTaskRuns.id, run.id));
    run.pushed = true;
  }
  return run as TaskRun;
}

async function pruneRuns(taskId: string): Promise<void> {
  const keep = await db
    .select({ id: boTaskRuns.id })
    .from(boTaskRuns)
    .where(eq(boTaskRuns.taskId, taskId))
    .orderBy(desc(boTaskRuns.ranAt))
    .limit(RUNS_KEPT);
  if (keep.length < RUNS_KEPT) return;
  await db.delete(boTaskRuns).where(
    and(
      eq(boTaskRuns.taskId, taskId),
      notInArray(
        boTaskRuns.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

/**
 * An alle Geräte des Kontos mit eingeschalteten Mitteilungen — jedes in seiner Sprache.
 *
 * @returns Hat Firebase mindestens eine Nachricht angenommen?
 */
async function pushRun(task: BoTask, runId: string, ev: Evaluation): Promise<boolean> {
  const devices = await db
    .select({ token: pushTokens.token, locale: pushTokens.locale })
    .from(pushTokens)
    .where(
      and(
        eq(pushTokens.userId, task.userId),
        eq(pushTokens.notificationsEnabled, true),
        eq(pushTokens.boUpdatesEnabled, true),
      ),
    );
  if (devices.length === 0) {
    // eslint-disable-next-line no-console
    console.warn("[boTasks] no device:", task.id.slice(0, 8));
    return false;
  }
  const messages: PushMessage[] = devices.map((d) => ({
    to: d.token,
    title: task.title,
    body: compose(ev, d.locale ?? task.locale, task.timezone).text,
    tag: `botask:${task.id}`,
    channelId: CHANNEL,
    data: { type: "boTask", taskId: task.id, runId },
    ttlMs: PUSH_TTL_MS,
  }));
  return ((await sendPushCounted(messages)) ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Schleife
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(boTasks)
      .where(and(eq(boTasks.active, true), lte(boTasks.nextRunAt, now)))
      .orderBy(asc(boTasks.nextRunAt))
      .limit(BATCH);
    for (const task of due) {
      const trigger = triggerFor(task, new Date());
      try {
        if (trigger === "skip") {
          await db.update(boTasks).set({ nextRunAt: computeNextRun(task, new Date()) }).where(eq(boTasks.id, task.id));
          continue;
        }
        await runTask(task, trigger);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[boTasks] run failed:", task.id.slice(0, 8), e);
        // Nicht in einer Schleife hängen bleiben: auf den nächsten regulären Lauf.
        await db
          .update(boTasks)
          .set({ nextRunAt: computeNextRun(task, new Date(Date.now() + 60_000)) })
          .where(eq(boTasks.id, task.id))
          .catch(() => {});
      }
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[boTasks] tick failed:", e);
  } finally {
    running = false;
  }
}

export function startBoTaskLoop(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), LOOP_MS);
  timer.unref?.();
}

export function stopBoTaskLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// Verwaltung (routes/boTasks.ts)
// ---------------------------------------------------------------------------

export interface TaskInput {
  kind: "route_status";
  title: string;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  days: number;
  time: string;
  watchUntil?: string | null;
  timezone: string;
  notify: BoTaskNotify;
  locale: string;
  conversationId?: string | null;
}

async function activeCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(boTasks)
    .where(and(eq(boTasks.userId, userId), eq(boTasks.active, true)));
  return Number(row?.n ?? 0);
}

export async function listTasks(userId: string): Promise<BoTask[]> {
  return db.select().from(boTasks).where(eq(boTasks.userId, userId)).orderBy(asc(boTasks.createdAt));
}

export async function createTask(userId: string, input: TaskInput): Promise<BoTask> {
  if ((await activeCount(userId)) >= TASK_LIMIT) throw new TaskLimitError();
  const id = randomUUID();
  const now = new Date();
  const values = {
    id,
    userId,
    conversationId: input.conversationId ?? null,
    kind: input.kind,
    title: input.title,
    origin: input.origin,
    destination: input.destination,
    originLabel: input.originLabel,
    destLabel: input.destLabel,
    days: input.days,
    time: input.time,
    watchUntil: input.watchUntil ?? null,
    timezone: input.timezone,
    notify: input.notify,
    locale: asLocale(input.locale),
  };
  const [row] = await db
    .insert(boTasks)
    .values({ ...values, nextRunAt: firstRun(values, now) })
    .returning();
  return row!;
}

export async function getTask(userId: string, id: string): Promise<BoTask | null> {
  const [row] = await db
    .select()
    .from(boTasks)
    .where(and(eq(boTasks.id, id), eq(boTasks.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function updateTask(
  userId: string,
  id: string,
  patch: Partial<
    Pick<BoTask, "active" | "notify" | "time" | "days" | "watchUntil" | "title" | "origin" | "destination" | "originLabel" | "destLabel">
  >,
): Promise<BoTask | null> {
  const task = await getTask(userId, id);
  if (!task) return null;
  if (patch.active === true && !task.active && (await activeCount(userId)) >= TASK_LIMIT) throw new TaskLimitError();
  const next = { ...task, ...patch };
  // Andere Strecke: Die letzte Lage galt der alten und darf nicht stehen bleiben.
  const routeChanged = next.origin !== task.origin || next.destination !== task.destination;
  const [row] = await db
    .update(boTasks)
    .set({
      ...patch,
      ...(routeChanged ? { lastRunAt: null, lastStatus: null, lastSummary: null, lastIssueKey: null } : {}),
      nextRunAt: next.active ? firstRun(next, new Date()) : null,
      updatedAt: new Date(),
    })
    .where(eq(boTasks.id, id))
    .returning();
  return row ?? null;
}

export async function deleteTask(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(boTasks)
    .where(and(eq(boTasks.id, id), eq(boTasks.userId, userId)))
    .returning({ id: boTasks.id });
  return rows.length > 0;
}

const lastManual = new Map<string, number>();

/** „Jetzt prüfen" — ohne Mitteilung (man sieht das Ergebnis ja), höchstens einmal je Minute. */
export async function runNow(userId: string, id: string): Promise<TaskRun | "notFound" | "tooSoon" | "limit"> {
  const task = await getTask(userId, id);
  if (!task) return "notFound";
  // Pausiert läuft sie nur, solange ein Platz frei ist.
  if (!task.active && (await activeCount(userId)) >= TASK_LIMIT) return "limit";
  const last = lastManual.get(id) ?? 0;
  if (Date.now() - last < MANUAL_COOLDOWN_MS) return "tooSoon";
  lastManual.set(id, Date.now());
  if (lastManual.size > 1000) lastManual.clear();
  return runTask(task, "manual");
}

export async function listRuns(userId: string, id: string): Promise<TaskRun[] | null> {
  const task = await getTask(userId, id);
  if (!task) return null;
  const rows = await db
    .select()
    .from(boTaskRuns)
    .where(eq(boTaskRuns.taskId, id))
    .orderBy(desc(boTaskRuns.ranAt))
    .limit(20);
  return rows as TaskRun[];
}

/** Für die Datenauskunft: alle Aufgaben eines Kontos (ohne Läufe). */
export async function tasksForExport(userId: string) {
  return db
    .select({
      title: boTasks.title,
      originLabel: boTasks.originLabel,
      destLabel: boTasks.destLabel,
      days: boTasks.days,
      time: boTasks.time,
      watchUntil: boTasks.watchUntil,
      notify: boTasks.notify,
      active: boTasks.active,
      createdAt: boTasks.createdAt,
    })
    .from(boTasks)
    .where(eq(boTasks.userId, userId));
}

/** Für die Prüfskripte (Zeitplan und Texte ohne Datenbank nachrechnen). */
export const __test = { evaluate, compose, triggerFor };
