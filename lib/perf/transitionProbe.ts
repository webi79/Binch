/**
 * MESSSONDE (vorübergehend) — Ruckler in Blatt-Fahrten am Gerät messen, OHNE adb.
 *
 * Warum: Jede Ruckel-Diagnose aus dem Code war in dieser App mindestens einmal
 * falsch (feedback_measure_dont_infer_transitions). Die logcat-Sonde
 * (lib/live/probe.ts) braucht ein Kabel bzw. drahtloses Debugging; diese hier
 * schickt ihre Messung an den eigenen Entwicklungs-Server, solange die App
 * GEGEN EINEN SERVER IM EIGENEN NETZ läuft (`PROBE_ON`). Ein Build für eine
 * echte Domain misst nichts und sendet nichts.
 *
 * Was gemessen wird, je Fahrt (`markTransitionBusy` öffnet ein Fenster):
 *  • UI-Strang: Bildlücken über 20 ms (Reanimated-Bildrückruf, siehe
 *    `TransitionProbeHost`) — das Ruckeln selbst.
 *  • React-Commits im Fenster (über den Devtools-Haken, `installCommitHook`) —
 *    die bekannte Ursache: Jeder Commit schreibt die Lage animierter Blätter
 *    verspätet zurück (feedback_reanimated_commit_race).
 *  • JS-Strang: Lücken über 24 ms (rAF).
 *  • Was den Commit auslöste: geänderte Store-Felder, fertige Abfragen.
 *
 * Gemeldet wird nur eine Fahrt mit Befund (Lücke oder Commit). Auswerten:
 * `docker logs server-binch-server-1 | grep '"probe"'`.
 *
 * NACH DER AUSWERTUNG ENTFERNEN: diese Datei, `TransitionProbeHost` im
 * Wurzel-Layout, den Haken in `index.js`, den Aufruf in transitionBusy.ts und
 * die Route `/api/debug/probe`.
 */
import Constants from "expo-constants";

function isPrivateHost(url: string): boolean {
  const m = /^https?:\/\/([^/:]+)/i.exec(url);
  const host = m?.[1] ?? "";
  if (host === "localhost" || host === "127.0.0.1") return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

const API = ((Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ?? "").replace(/\/$/, "");
export const PROBE_ON = isPrivateHost(API);

/** Wie lange nach dem Ende der Fahrt noch mitgeschrieben wird — Nachzügler zählen mit. */
const TAIL_MS = 250;

let open = false;
let startAt = 0;
let endAt = 0;
let finishTimer: ReturnType<typeof setTimeout> | null = null;
let commits: number[] = [];
let jsGaps: [number, number][] = [];
let events: [number, string][] = [];
let hookInjected = false;
let reportAlways = false;
let scrollTimer: ReturnType<typeof setInterval> | null = null;
let uiControl:
  | { start: () => void; stop: (done: (gaps: [number, number][], hist?: number[]) => void) => void }
  | null = null;

const now = () => performance.now();
const rel = () => Math.round(now() - startAt);

/**
 * Den Devtools-Haken setzen — MUSS vor dem Laden des React-Renderers laufen
 * (der prüft ihn einmal beim Laden), deshalb aus `index.js` vor allem anderen.
 * Der Renderer ruft ihn in Try/Catch auf; im Release-Build liest ihn sonst
 * niemand (geprüft: nur ReactFabric-prod und Debug-Werkzeuge im Dev-Build).
 */
export function installCommitHook(): void {
  const g = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
  if (!PROBE_ON || g.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== undefined) return;
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject() {
      hookInjected = true;
      return 1;
    },
    onCommitFiberRoot() {
      if (open) commits.push(rel());
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    checkDCE() {},
  };
}

/** Vom Host: Start/Stopp des Bildrückrufs auf dem UI-Strang. */
export function registerUiProbe(control: typeof uiControl): () => void {
  uiControl = control;
  return () => {
    if (uiControl === control) uiControl = null;
  };
}

/** Läuft gerade ein Messfenster? — damit die Zuhörer außerhalb nichts tun. */
export function isProbeOpen(): boolean {
  return open;
}

/** Ein Ereignis im offenen Fenster festhalten (Store-Feld, Abfrage, Marke). */
export function probeEvent(label: string): void {
  if (open && events.length < 60) events.push([rel(), label]);
}

/** Aus `markTransitionBusy` — öffnet bzw. verlängert das Messfenster. */
export function probeTransition(durationMs: number): void {
  if (!PROBE_ON) return;
  const t = now();
  const end = t + durationMs + 80 + TAIL_MS;
  if (open) {
    if (end > endAt) endAt = end;
    return;
  }
  open = true;
  startAt = t;
  endAt = end;
  commits = [];
  jsGaps = [];
  events = [];
  uiControl?.start();
  let last = t;
  const tick = (ts: number) => {
    if (!open) return;
    const d = ts - last;
    if (d > 24 && jsGaps.length < 40) jsGaps.push([Math.round(ts - startAt), Math.round(d)]);
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  scheduleFinish();
}

/**
 * Scroll-Geste im Bo-Chat: Das Fenster bleibt offen, solange sie läuft, und wird
 * immer gemeldet — samt Verteilung der Bildabstände, denn bei 120 Hz ist ein
 * einzelnes verlorenes Bild (16,7 ms) noch keine Lücke über 20 ms.
 */
export function probeThreadScroll(on: boolean): void {
  if (!PROBE_ON) return;
  if (on) {
    reportAlways = true;
    probeTransition(900);
    probeEvent("scroll");
    scrollTimer ??= setInterval(() => probeTransition(900), 500);
  } else if (scrollTimer) {
    clearInterval(scrollTimer);
    scrollTimer = null;
    probeEvent("scroll-ruhe");
  }
}

function scheduleFinish(): void {
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = setTimeout(() => {
    finishTimer = null;
    if (now() < endAt) {
      scheduleFinish();
      return;
    }
    finish();
  }, Math.max(16, endAt - now()));
}

function finish(): void {
  open = false;
  const durMs = Math.round(endAt - startAt);
  const snapshot = { commits, jsGaps, events };
  const always = reportAlways;
  reportAlways = false;
  const send = (uiGaps: [number, number][], hist?: number[]) => {
    if (!always && uiGaps.length === 0 && snapshot.commits.length === 0 && snapshot.jsGaps.length === 0) return;
    const body = JSON.stringify({
      durMs,
      hook: hookInjected,
      /** Bilder je Abstand: ≤10, ≤14, ≤19, ≤28, ≤45, >45 ms. */
      hist,
      ui: uiGaps.slice(0, 40),
      js: snapshot.jsGaps,
      commits: snapshot.commits.slice(0, 60),
      events: snapshot.events,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    fetch(`${API}/api/debug/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  };
  if (uiControl) uiControl.stop(send);
  else send([]);
}
