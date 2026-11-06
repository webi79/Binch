/**
 * Erst sagen, wofür — dann fragen. Vor jeder Abfrage einer Berechtigung durch
 * das System (Standort, Mikrofon, Mitteilungen, Fotos) fährt unser Blatt hoch
 * (`components/permissions/PermissionSheet.tsx`), Vorbild Google Maps.
 *
 * Ablauf: „Weiter" lässt das Blatt STEHEN, der System-Dialog kommt darüber.
 * Erteilt → ein Haken zeichnet sich, dann fährt das Blatt hinaus. Beim Mikrofon
 * fährt es stattdessen auf die Höhe des Aufnahme-Blattes zusammen und übergibt
 * (`handoffHeight`, `releasePrimer`). Verweigert → es fährt einfach hinaus.
 * „Nicht jetzt" lässt den System-Dialog aus; beim nächsten Mal wird wieder
 * gefragt.
 *
 * Kein Blatt, wenn das System gar nicht mehr fragen würde: Steht die
 * Berechtigung schon, oder ist sie endgültig verweigert, geht es ohne Umweg
 * zum bisherigen Ablauf (Aufrufer zeigen dort z. B. „in den Einstellungen
 * erlauben").
 */
import { useSyncExternalStore } from "react";
import { isTransitionBusy } from "@/lib/nav/transitionBusy";

export type PermissionKind = "location" | "microphone" | "notifications" | "photos";
export type PrimerChoice = "continue" | "later";
/** ask = wartet auf die Wahl · asking = System-Dialog läuft · granted = Haken · handoff = Übergabe ans Aufnahme-Blatt. */
export type PrimerPhase = "ask" | "asking" | "granted" | "handoff";

export interface PrimerRequest {
  kind: PermissionKind;
  /** Jede Anfrage neu gezählt — das Blatt baut den Inhalt dann frisch auf. */
  session: number;
  phase: PrimerPhase;
  /** Nur bei `handoff`: auf diese Höhe fährt das Blatt zusammen (Unterkante bleibt). */
  handoffHeight?: number;
}

/** Haken zeichnen und kurz stehen lassen, bevor das Blatt geht. */
export const GRANTED_MS = 1100;
/** So lange fährt das Blatt bei der Übergabe zusammen. */
export const HANDOFF_MS = 360;
/** Spätestens dann verschwindet das Blatt nach einer Übergabe, auch wenn niemand übernimmt. */
const HANDOFF_GUARD_MS = 1500;
/** So lange fährt das Blatt höchstens hinaus (`softSheetMotion`, große Blätter). */
const SHEET_GONE_MS = 300;
/**
 * Sanft statt sofort: Erst kommt ein laufender Übergang zur Ruhe, dann der
 * Aufbau (ein paar Bilder hintereinander pünktlich), dann eine kurze
 * Atempause — das Blatt fährt nie gleichzeitig mit einer anderen Bewegung oder
 * einem schweren Aufbau hoch.
 *
 * Vorher stand für den Standort beim Öffnen der Karte eine feste Pause von
 * 1,5 s — „kommt viel zu spät" (04.11.2026). Gewartet wird jetzt, solange
 * wirklich etwas läuft, und danach nur noch kurz.
 */
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SOFT_DELAY_MS = 220;
const SETTLE_MAX_MS = 3000;
/** Wie viele pünktliche Bilder am Stück als „Ruhe" gelten, und was pünktlich heißt. */
const CALM_FRAMES = 6;
const CALM_FRAME_MS = 24;
const CALM_MAX_MS = 1500;

/**
 * Bis die Bilder wieder pünktlich kommen — spätestens nach `CALM_MAX_MS`.
 *
 * `requestAnimationFrame` läuft im Takt des UI-Strangs (RN hängt es an dessen
 * Choreographer): Baut dort gerade die Karte ihren Stil auf oder mountet ein
 * Bildschirm, kommen die Rückrufe verspätet. Sechs pünktliche hintereinander
 * heißen: Der Strang hat jetzt Luft für die Fahrt des Blattes.
 */
function calmFrames(): Promise<void> {
  return new Promise((resolve) => {
    const until = Date.now() + CALM_MAX_MS;
    let last = 0;
    let calm = 0;
    const tick = (now: number) => {
      calm = last && now - last < CALM_FRAME_MS ? calm + 1 : 0;
      last = now;
      if (calm >= CALM_FRAMES || Date.now() > until) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function settleDown(delayMs: number): Promise<void> {
  const until = Date.now() + SETTLE_MAX_MS;
  while (isTransitionBusy() && Date.now() < until) await wait(100);
  await calmFrames();
  await wait(delayMs);
}

export interface PrimerOptions {
  /** Nur Mikrofon: auf diese Höhe zusammenfahren und ans Aufnahme-Blatt übergeben. */
  handoffHeight?: number;
  /** Atempause vor dem Blatt, nachdem alles zur Ruhe gekommen ist (Standard kurz). */
  delayMs?: number;
  /** Nach der Pause noch gefragt? Sonst still „Nicht jetzt" (z. B. Bo inzwischen zu). */
  stillWanted?: () => boolean;
}

let open: PrimerRequest | null = null;
let instantClose = false;
let session = 0;
let settle: ((choice: PrimerChoice) => void) | null = null;
let handoffGuard: ReturnType<typeof setTimeout> | null = null;
/** Ein Ablauf je Art — fragen zwei Stellen gleichzeitig, bekommen beide sein Ergebnis. */
const inflight = new Map<PermissionKind, Promise<unknown>>();
const listeners = new Set<() => void>();

function publish(next: PrimerRequest | null, instant = false): void {
  open = next;
  instantClose = instant;
  for (const fn of listeners) fn();
}


/** Das Blatt zeigen und auf die Wahl warten. */
function askPrimer(kind: PermissionKind): Promise<PrimerChoice> {
  // Wartet noch eine andere Art, macht sie Platz — zwei Blätter übereinander gibt es nicht.
  settle?.("later");
  session += 1;
  const mine = session;
  publish({ kind, session: mine, phase: "ask" });
  return new Promise<PrimerChoice>((resolve) => {
    settle = (choice) => {
      settle = null;
      if (choice === "later") publish(null);
      // „Weiter": Das Blatt bleibt stehen, der System-Dialog kommt darüber.
      else if (open?.session === mine) publish({ ...open, phase: "asking" });
      resolve(choice);
    };
  });
}

/** Vom Blatt: „Weiter", „Nicht jetzt", Wisch, Zurück-Taste oder Tipp daneben. */
export function answerPrimer(choice: PrimerChoice): void {
  settle?.(choice);
}

/** Das Aufnahme-Blatt steht — das zusammengefahrene Blatt darf ohne Fahrt verschwinden. */
export function releasePrimer(): void {
  if (handoffGuard) clearTimeout(handoffGuard);
  handoffGuard = null;
  if (open?.phase === "handoff") publish(null, true);
}

/** Geht das Blatt gerade ohne Fahrt (nach einer Übergabe)? */
export function primerClosesInstantly(): boolean {
  return instantClose;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function usePrimer(): PrimerRequest | null {
  return useSyncExternalStore(subscribe, () => open);
}

interface PermissionLike {
  granted: boolean;
  canAskAgain: boolean;
}

/**
 * Die Berechtigung über unser Blatt anfragen. `null` heißt „Nicht jetzt" — der
 * Aufrufer bleibt dann still (kein „verweigert"-Hinweis, keine Einstellungen).
 *
 * Mit `handoffHeight` (nur Mikrofon) endet eine Erlaubnis nicht mit Haken und
 * Ausfahrt, sondern das Blatt bleibt auf dieser Höhe stehen, bis der Aufrufer
 * sein Aufnahme-Blatt zeigt und `releasePrimer()` ruft.
 */
export function requestWithPrimer<P extends PermissionLike>(
  kind: PermissionKind,
  get: () => Promise<P>,
  request: () => Promise<P>,
  opts?: PrimerOptions,
): Promise<P | null> {
  const running = inflight.get(kind) as Promise<P | null> | undefined;
  if (running) return running;
  const flow = runPrimer(kind, get, request, opts).finally(() => inflight.delete(kind));
  inflight.set(kind, flow);
  return flow;
}

async function runPrimer<P extends PermissionLike>(
  kind: PermissionKind,
  get: () => Promise<P>,
  request: () => Promise<P>,
  opts?: PrimerOptions,
): Promise<P | null> {
  let now: P | null = null;
  try {
    now = await get();
  } catch {
    // Ohne Auskunft lieber einmal zu viel erklären als ungefragt den System-Dialog zeigen.
  }
  if (now?.granted) return now;
  if (now && !now.canAskAgain) return request();
  await settleDown(opts?.delayMs ?? SOFT_DELAY_MS);
  if (opts?.stillWanted && !opts.stillWanted()) return null;
  if ((await askPrimer(kind)) === "later") return null;

  let res: P;
  try {
    res = await request();
  } catch (e) {
    publish(null);
    throw e;
  }
  if (!res.granted) {
    publish(null);
    return res;
  }
  if (opts?.handoffHeight && open) {
    publish({ ...open, phase: "handoff", handoffHeight: opts.handoffHeight });
    await wait(HANDOFF_MS);
    handoffGuard = setTimeout(releasePrimer, HANDOFF_GUARD_MS);
    return res;
  }
  if (open) publish({ ...open, phase: "granted" });
  await wait(GRANTED_MS);
  publish(null);
  // Erst wenn es draußen ist, geht es weiter — sonst liefe z. B. der Kartenflug unter der Ausfahrt.
  await wait(SHEET_GONE_MS);
  return res;
}
