import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchLiveTrip } from "@/lib/api/client";
import { flightModel, groundModel, type LiveModel } from "./model";
import type { LiveSession } from "./types";

export type LiveStatus = "loading" | "error" | "ready";

/**
 * Das Modell zur Live-Sitzung. Eine Fahrt kommt vom Server (Halte, Zeiten,
 * Linienführung), ein Flug wird ganz in der App gerechnet (Flughäfen und Zeiten
 * hat die Flugtafel schon geliefert).
 *
 * NACHLADEN nur, wenn es etwas Neues geben kann: Mit Echtzeit (Verspätungen)
 * jede Minute, solange die Ansicht im Bild ist; ein reiner Fahrplan ändert sich
 * nicht. Der Server hält jede Fahrt 30 s vor, und DB-Fahrten kosten dort
 * Kontingent — darum nicht öfter.
 */
export function useLiveModel(session: LiveSession | null, active: boolean): { model: LiveModel | null; status: LiveStatus } {
  const trip = session?.kind === "trip" ? session : null;
  const query = useQuery({
    queryKey: ["live-trip", trip?.tripId ?? null, trip?.stopCode ?? null, trip?.atTime ?? null],
    queryFn: () => fetchLiveTrip(trip!.tripId, { stopCode: trip!.stopCode, atTime: trip!.atTime }),
    enabled: trip != null && active,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
    refetchInterval: (q) => (q.state.data?.realtime ? 60_000 : false),
  });
  const data = query.data;
  const model = useMemo(() => {
    if (!session) return null;
    if (session.kind === "flight") {
      return flightModel(session.flight, {
        line: session.line,
        direction: session.direction,
        boardIndex: session.boardIndex,
      });
    }
    return data ? groundModel(data) : null;
  }, [session, data]);
  const status: LiveStatus = model
    ? "ready"
    : session?.kind === "flight" || query.isError || (data != null && model == null)
      ? "error"
      : "loading";
  return { model, status };
}

/** Ist die App im Vordergrund? Im Hintergrund ruht jeder Takt der Live-Ansicht. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);
  return active;
}
