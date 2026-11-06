/**
 * Die Route einer Verbindung bildschirmfüllend zeigen (`/search/route-map`) —
 * der Routen-Knopf auf jeder Ergebnis-Karte.
 *
 * Herausgelöst aus `ResultCard`, damit das Kalender-Blatt denselben Weg gehen
 * kann, nur NACH seiner Ausfahrt: Die Routen-Karte ist ein Bildschirm im
 * Navigations-Stapel und läge sonst unter dem Blatt, das am Wurzel-Layout
 * hängt (components/saved/CalendarSheet.tsx).
 *
 * PUSH im selben Stapel — kein Tab-Wechsel, kein `router.replace` mit
 * `previousHref`. Was darunter liegt, bleibt gemountet; Zurück auf der Karte
 * ruft `router.back()`.
 *
 * Gibt `false` zurück, wenn sich aus der Verbindung keine Route bauen lässt.
 */
import { router } from "expo-router";
import { fetchTripPolylines } from "@/lib/api/client";
import { buildRoutePlan } from "@/lib/routing/buildRoute";
import { useSearchStore } from "@/stores/searchStore";
import type { SearchResult } from "@/types/search";

export function openRouteMap(result: SearchResult): boolean {
  const plan = buildRoutePlan(result);
  if (!plan) return false;
  useSearchStore.getState().setRoute({ ...plan });
  router.push("/search/route-map");

  const tripIds = plan.legs.map((l) => l.tripId).filter((id): id is string => Boolean(id));
  if (tripIds.length > 0) {
    fetchTripPolylines(tripIds)
      .then((r) => useSearchStore.getState().setRoutePolylines(r.polylines))
      .catch(() => {});
  }
  return true;
}
