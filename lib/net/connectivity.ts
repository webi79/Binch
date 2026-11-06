/**
 * Erreicht die App Binch? — Gerät offline oder Server nicht erreichbar.
 *
 * Maßgeblich sind die eigenen Anfragen an den Server: `fetch` wird einmal beim
 * Start umhüllt. Jede Anfrage an `API_BASE_URL`, die ganz ohne Antwort
 * scheitert („Network request failed"), meldet „nicht erreichbar", jede Antwort
 * (gleich welcher Status) „erreichbar". So muss keine der vielen Aufruf-Stellen
 * davon wissen.
 *
 * Das Netz des Geräts (expo-network) sagt nur noch, WIE es heißt, wenn nichts
 * durchkommt: ohne Verbindung = „offline", sonst „Server nicht erreichbar". Es
 * allein durfte früher „offline" melden — Android meldete bei manchen Netzen
 * „kein Internet" (`isInternetReachable: false`), während die App munter Daten
 * lud, und der Hinweis stand dauerhaft. Ein Netzwechsel löst nur eine
 * Nachfrage aus; die Antwort entscheidet.
 *
 * Solange der Server fehlt, fragt ein leiser Puls `/health` nach — sonst erführe
 * die App nie, dass er zurück ist, wenn gerade niemand etwas lädt. Im
 * Hintergrund pausiert er.
 */
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { API_BASE_URL } from "@/lib/api/client";

export type Connectivity = "online" | "offline" | "unreachable";

/** Abstand der Nachfragen, solange der Server fehlt. */
const PROBE_EVERY_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;

/** Das Gerät meldet: gar keine Verbindung bzw. verbunden, aber ohne bestätigtes Internet. */
let linkDown = false;
let noInternet = false;
let server = true;
let probing = false;
let installed = false;
let rawFetch: typeof fetch | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(c: Connectivity) => void>();

function current(): Connectivity {
  if (server) return "online";
  return linkDown || noInternet ? "offline" : "unreachable";
}

let last: Connectivity = "online";
function emit(): void {
  const now = current();
  if (now === last) return;
  last = now;
  for (const fn of listeners) fn(now);
}

function setServer(ok: boolean): void {
  if (server === ok) return;
  server = ok;
  emit();
  if (!ok) scheduleProbe();
}

async function probe(): Promise<void> {
  if (!rawFetch || probing) return;
  probing = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await rawFetch(`${API_BASE_URL}/health`, { signal: controller.signal });
    setServer(res.ok);
  } catch {
    setServer(false);
  } finally {
    clearTimeout(timer);
    probing = false;
    if (!server) scheduleProbe();
  }
}

function scheduleProbe(): void {
  if (probeTimer) return;
  probeTimer = setTimeout(() => {
    probeTimer = null;
    if (AppState.currentState === "active") void probe();
    else scheduleProbe();
  }, PROBE_EVERY_MS);
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "url" in input) return String((input as { url: unknown }).url);
  return String(input);
}

/** Nur das echte „keine Antwort" — ein Abbruch durch uns selbst zählt nicht. */
function isNetworkFailure(e: unknown): boolean {
  return e instanceof TypeError && /network request failed/i.test(e.message);
}

/** Einmal beim Start, vor der ersten Anfrage (app/_layout.tsx). */
export function installConnectivity(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  rawFetch = original;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ours = urlOf(input).startsWith(API_BASE_URL);
    try {
      const res = await original(input, init);
      if (ours) setServer(true);
      return res;
    } catch (e) {
      if (ours && isNetworkFailure(e)) setServer(false);
      throw e;
    }
  }) as typeof fetch;

  const applyDevice = (s: Network.NetworkState) => {
    const down = s.isConnected === false;
    const noNet = s.isInternetReachable === false;
    if (down === linkDown && noNet === noInternet) return;
    linkDown = down;
    noInternet = noNet;
    emit();
    // Netz gewechselt: nachfragen statt glauben — Flugmodus scheitert sofort,
    // ein zurückgekehrtes Netz meldet sich mit einer Antwort.
    void probe();
  };
  Network.addNetworkStateListener(applyDevice);
  void Network.getNetworkStateAsync().then(applyDevice).catch(() => {});
  AppState.addEventListener("change", (state) => {
    if (state === "active" && !server) void probe();
  });
}

export function useConnectivity(): Connectivity {
  const [value, set] = useState(current);
  useEffect(() => {
    set(current());
    listeners.add(set);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return value;
}
