/**
 * MESSSONDE (vorübergehend) — die Hälfte der Sonde, die einen React-Baum
 * braucht: Bildrückruf auf dem UI-Strang, Store- und Abfrage-Ereignisse.
 * Siehe lib/perf/transitionProbe.ts; ohne Server im eigenen Netz rendert sie
 * nichts und hängt sich nirgends ein.
 */
import { useEffect } from "react";
import { makeMutable, runOnJS, runOnUI, useFrameCallback } from "react-native-reanimated";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchStore } from "@/stores/searchStore";
import { PROBE_ON, isProbeOpen, probeEvent, registerUiProbe } from "@/lib/perf/transitionProbe";

/** Lücken auf dem UI-Strang, flach als [Zeit, Dauer, Zeit, Dauer, …] ab Fensterbeginn. */
const uiGaps = makeMutable<number[]>([]);
/** Bilder je Abstand — Grenzen siehe `transitionProbe.ts`. */
const uiHist = makeMutable<number[]>([0, 0, 0, 0, 0, 0]);
let pendingDone: ((gaps: [number, number][], hist?: number[]) => void) | null = null;

function receiveUiGaps(flat: number[], hist: number[]): void {
  const done = pendingDone;
  pendingDone = null;
  const pairs: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i]!, flat[i + 1]!]);
  done?.(pairs, hist);
}

export function TransitionProbeHost() {
  return PROBE_ON ? <ProbeInner /> : null;
}

function ProbeInner() {
  const queryClient = useQueryClient();
  const frame = useFrameCallback((f) => {
    "worklet";
    const d = f.timeSincePreviousFrame;
    if (d == null) return;
    const bucket = d <= 10 ? 0 : d <= 14 ? 1 : d <= 19 ? 2 : d <= 28 ? 3 : d <= 45 ? 4 : 5;
    uiHist.value = uiHist.value.map((n, i) => (i === bucket ? n + 1 : n));
    if (d > 20 && uiGaps.value.length < 80) {
      uiGaps.value = [...uiGaps.value, Math.round(f.timeSinceFirstFrame), Math.round(d)];
    }
  }, false);

  useEffect(
    () =>
      registerUiProbe({
        start: () => {
          uiGaps.value = [];
          uiHist.value = [0, 0, 0, 0, 0, 0];
          frame.setActive(true);
        },
        stop: (done) => {
          frame.setActive(false);
          pendingDone = done;
          runOnUI(() => {
            "worklet";
            const flat = uiGaps.value;
            uiGaps.value = [];
            runOnJS(receiveUiGaps)(flat, uiHist.value);
          })();
        },
      }),
    [frame],
  );

  // Welche Store-Felder sich im Fenster ändern — die üblichen Auslöser eines Commits.
  useEffect(
    () =>
      useSearchStore.subscribe((s, prev) => {
        if (!isProbeOpen()) return;
        const a = s as unknown as Record<string, unknown>;
        const b = prev as unknown as Record<string, unknown>;
        for (const k of Object.keys(a)) {
          if (a[k] !== b[k] && typeof a[k] !== "function") probeEvent(`store:${k}`);
        }
      }),
    [],
  );

  // Fertige Abfragen im Fenster — deren Antwort rendert die Komponente, die zuhört.
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((e) => {
        if (!isProbeOpen()) return;
        if (e.type === "updated" && e.action.type === "success") {
          probeEvent(`query:${String(e.query.queryKey[0])}`);
        }
      }),
    [queryClient],
  );

  return null;
}
