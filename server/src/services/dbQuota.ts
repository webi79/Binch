/**
 * DAS BAHN-KONTINGENT — EIN Zähler für alles, was an bahn.de geht.
 *
 * Beide Sidecars (dbweb für die Suche, dbrest für Tafeln, Fahrten, Orte) fragen
 * bei bahn.de, und bahn.de lässt pro ausgehender IP rund 60 Anfragen pro Minute
 * zu. Bisher zählte nur die Abfahrtstafel mit; Suche, Preise, Gleisverläufe,
 * Fahrt-Details, Umkreis und Ortssuche hatten eigene oder gar keine Grenzen —
 * zusammen kamen sie über das Limit, und dann traf die Sperre die SUCHE.
 *
 * STUFEN — wer wie weit an den Eimer darf (Anteil des Minutenbudgets, der für
 * die höheren Stufen frei bleiben muss):
 *
 *   search      Suche, Stationsauflösung, Preise        — bis zum Deckel
 *   board       Abfahrts-/Ankunftstafel, Umkreis        — lässt 20 % frei
 *   detail      Fahrt-Details (Zeitleiste)               — lässt 30 % frei
 *   background  Gleisverläufe, Vorlauf, Auffrischen,
 *               Live-Ortssuche                           — lässt 45 % frei
 *
 * SPUREN — eine je ausgehender IP. Heute eine (die beiden Sidecars aus der
 * Konfiguration). Kommen weitere IPs dazu, bekommt jede ihr eigenes
 * Sidecar-Paar und wird in `DB_LANES` eingetragen; jede Anfrage nimmt dann die
 * Spur mit den meisten freien Plätzen. Deshalb geben alle Aufrufer die
 * Adressen der ZUGETEILTEN Spur weiter (`lane.dbwebUrl` / `lane.dbrestUrl`)
 * statt der festen aus der Konfiguration.
 *
 * Gezählt wird über ein gleitendes Minutenfenster je Spur. Meldet bahn.de eine
 * Sperre (429/403), pausiert die Spur (`reportDbThrottled`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config.js";

export type DbPriority = "search" | "board" | "detail" | "background";

export interface DbLane {
  id: string;
  dbwebUrl: string;
  dbrestUrl: string;
}

interface LaneState extends DbLane {
  perMinute: number;
  /** Zeitpunkte der Anfragen der letzten Minute, aufsteigend. */
  times: number[];
  pausedUntil: number;
}

const WINDOW_MS = 60_000;

/** Anteil des Minutenbudgets, den eine Stufe den höheren freilassen muss. */
const RESERVE_SHARE: Record<DbPriority, number> = {
  search: 0,
  board: 0.2,
  detail: 0.3,
  background: 0.45,
};

/** So lange ruht eine Spur nach einer Sperre von bahn.de. */
const THROTTLE_PAUSE_MS = 30_000;

function loadLanes(): LaneState[] {
  const perMinute = config.DB_QUOTA_PER_MIN;
  if (config.DB_LANES) {
    // Eine kaputte Einstellung darf den Server nicht am Start hindern —
    // dann eben die eine Spur aus der Konfiguration, mit Warnung.
    let parsed: Array<Partial<DbLane> & { perMinute?: number }> = [];
    try {
      const raw: unknown = JSON.parse(config.DB_LANES);
      if (Array.isArray(raw)) parsed = raw as typeof parsed;
      else console.warn("[dbQuota] DB_LANES ist keine Liste — ignoriert");
    } catch {
      console.warn("[dbQuota] DB_LANES ist kein gültiges JSON — ignoriert");
    }
    const lanes = parsed
      .filter((l) => l.dbwebUrl && l.dbrestUrl)
      .map((l, i) => ({
        id: l.id ?? `lane${i + 1}`,
        dbwebUrl: l.dbwebUrl!,
        dbrestUrl: l.dbrestUrl!,
        perMinute: l.perMinute ?? perMinute,
        times: [] as number[],
        pausedUntil: 0,
      }));
    if (lanes.length > 0) return lanes;
  }
  return [
    {
      id: "default",
      dbwebUrl: config.DBWEB_BASE_URL,
      dbrestUrl: config.DBREST_BASE_URL,
      perMinute,
      times: [],
      pausedUntil: 0,
    },
  ];
}

const lanes: LaneState[] = loadLanes();

function used(lane: LaneState, now: number): number {
  const cutoff = now - WINDOW_MS;
  while (lane.times.length > 0 && lane.times[0]! < cutoff) lane.times.shift();
  return lane.times.length;
}

function capFor(lane: LaneState, priority: DbPriority): number {
  return Math.floor(lane.perMinute * (1 - RESERVE_SHARE[priority]));
}

/** Die freieste Spur, die für diese Stufe noch (mindestens `minFree`) Platz hat — oder null. */
function pickLane(priority: DbPriority, now: number, minFree = 1): LaneState | null {
  let best: LaneState | null = null;
  let bestFree = 0;
  for (const lane of lanes) {
    if (lane.pausedUntil > now) continue;
    const free = capFor(lane, priority) - used(lane, now);
    if (free >= minFree && free > bestFree) {
      best = lane;
      bestFree = free;
    }
  }
  return best;
}

function toPublic(lane: LaneState): DbLane {
  return { id: lane.id, dbwebUrl: lane.dbwebUrl, dbrestUrl: lane.dbrestUrl };
}

/**
 * Einen Platz nehmen, ohne zu warten — die Spur oder null. Jede PHYSISCHE
 * Anfrage an einen Sidecar braucht einen (auch Wiederholungen).
 */
export function tryAcquireDb(priority: DbPriority = currentDbPriority()): DbLane | null {
  const lane = takeLane(priority);
  if (!lane) markDenied();
  return lane;
}

/** Platz nehmen, ohne ein Scheitern im Kontext zu vermerken (für Warteschleifen). */
function takeLane(priority: DbPriority): DbLane | null {
  const now = Date.now();
  const lane = pickLane(priority, now);
  if (!lane) return null;
  lane.times.push(now);
  return toPublic(lane);
}

/**
 * Einen Platz nehmen und dafür höchstens `waitMs` warten. Gewartet wird, bis
 * in einer Spur der älteste Eintrag aus dem Fenster fällt (oder eine Pause
 * endet) — nicht in festen kurzen Schritten.
 */
export async function acquireDb(
  priority: DbPriority = currentDbPriority(),
  waitMs = 0,
  /** Hat der Aufrufer aufgegeben (Zeitgrenze der Suche), wird nicht weiter gewartet. */
  signal?: AbortSignal,
): Promise<DbLane | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // Ein Zwischenversuch, der scheitert, ist noch kein „verweigert" — erst
    // das endgültige Aufgeben (unten) wird im Kontext vermerkt.
    const lane = signal?.aborted ? null : takeLane(priority);
    if (lane) return lane;
    const now = Date.now();
    /**
     * Ruhen ALLE Spuren über die Frist hinaus (Sperre von bahn.de), wird kein
     * Platz mehr frei — sofort aufgeben statt die Frist abzusitzen. Sonst
     * wartete jede Zugsuche nach einer Sperre 8 s (Station) plus 8 s (Fahrten)
     * ins Leere und kam erst nach ihrer Zeitgrenze zum Ersatz (MOTIS).
     */
    const hopeless = lanes.every((l) => l.pausedUntil > deadline);
    if (now >= deadline || signal?.aborted || hopeless) {
      markDenied();
      return null;
    }
    let next = deadline;
    for (const l of lanes) {
      if (l.pausedUntil > now) next = Math.min(next, l.pausedUntil);
      else if (l.times.length > 0) next = Math.min(next, l.times[0]! + WINDOW_MS);
    }
    await new Promise((r) => setTimeout(r, Math.max(50, Math.min(next - now + 5, 1_000))));
  }
}

/**
 * Hätte diese Stufe gerade Platz — für `slots` Anfragen in EINER Spur? (Für
 * Arbeiten, die sonst gar nicht erst anfangen; nimmt selbst nichts.)
 */
export function dbHasRoom(priority: DbPriority, slots = 1): boolean {
  return pickLane(priority, Date.now(), slots) != null;
}

/** Anfragen der letzten Minute über alle Spuren — für Protokoll und Übersicht. */
export function dbQuotaUsed(): number {
  const now = Date.now();
  return lanes.reduce((n, l) => n + used(l, now), 0);
}

/** bahn.de hat gesperrt (429/403) — diese Spur eine Weile schonen. */
export function reportDbThrottled(lane: DbLane, pauseMs = THROTTLE_PAUSE_MS): void {
  const l = lanes.find((x) => x.id === lane.id);
  if (l) l.pausedUntil = Math.max(l.pausedUntil, Date.now() + pauseMs);
}

/**
 * Die Spur nur bei einer ECHTEN Sperre pausieren: 429 immer, 403 nur mit
 * `OPS_BLOCKED` im Text.
 *
 * Ein 403 kann auch an der einzelnen Anfrage hängen — Akamai sperrt etwa
 * `Accept-Language: en` auf manchen Pfaden (siehe `fetchTripPolyline` in
 * trips.ts). Pausierte schon so ein Einzelfall die Spur, legte ein
 * Tastendruck in der Ortssuche die SUCHE aller Nutzer für 30 s still. Den
 * Text lesen wir aus einer Kopie — der Aufrufer liest die Antwort selbst.
 */
export async function reportIfBlocked(lane: DbLane, res: Response): Promise<void> {
  if (res.status === 429) {
    reportDbThrottled(lane);
    return;
  }
  if (res.status !== 403) return;
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    // Unlesbar — dann lieber pausieren: Ein unnötiges Ruhen kostet 30 s,
    // ein übersehenes Weiterfeuern in eine Sperre verlängert sie.
    reportDbThrottled(lane);
    return;
  }
  if (/OPS_BLOCKED/i.test(body)) reportDbThrottled(lane);
  else console.warn(`[dbQuota] 403 ohne OPS_BLOCKED — Spur ${lane.id} läuft weiter: ${body.slice(0, 160)}`);
}

/**
 * Die Stufe als Kontext — für Wege, die tief unten dieselbe Funktion wie die
 * Suche benutzen (das Auffrischen einer Suche im Hintergrund ruft denselben
 * Anbieter wie eine echte Suche, soll aber als `background` zählen).
 */
interface DbContext {
  priority: DbPriority;
  /** Hat unser Zähler in diesem Kontext schon eine Anfrage verweigert? */
  denied: boolean;
}
const priorityContext = new AsyncLocalStorage<DbContext>();

export function withDbPriority<T>(priority: DbPriority, fn: () => T): T {
  return priorityContext.run({ priority, denied: false }, fn);
}

export function currentDbPriority(fallback: DbPriority = "search"): DbPriority {
  return priorityContext.getStore()?.priority ?? fallback;
}

/**
 * Wurde in diesem Kontext eine Anfrage an die Bahn von UNS verweigert (kein
 * Platz)? Dann ist ein Ergebnis unvollständig — ein Auffrischen im
 * Hintergrund darf es nicht als neuesten Stand speichern (siehe `runLive` in
 * searchService.ts), sonst verdrängte eine Antwort ohne Bahn (nur MOTIS, ohne
 * Preise) die gute für Stunden.
 */
export function wasDbDenied(): boolean {
  return priorityContext.getStore()?.denied ?? false;
}

function markDenied(): void {
  const ctx = priorityContext.getStore();
  if (ctx) ctx.denied = true;
}
