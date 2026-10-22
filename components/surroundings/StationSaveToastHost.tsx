/**
 * Rendert die zweizeilige Bestätigung (Station gespeichert, Preisalarm
 * angelegt) am Screen-Level — im selben Aussehen wie „Ticket gespeichert"
 * (`GlideToast`). Wird global in app/_layout.tsx gemountet und vom Store
 * getrieben (showStationToast/hideStationToast). key={toast.key} remountet pro
 * Meldung → Animation + Auto-Hide triggern neu.
 */
import { GlideToast } from "@/components/ui/GlideToast";
import { useSearchStore } from "@/stores/searchStore";

export function StationSaveToastHost() {
  const toast = useSearchStore((s) => s.stationToast);
  const hide = useSearchStore((s) => s.hideStationToast);
  if (!toast) return null;
  return <GlideToast key={toast.key} title={toast.title} subtitle={toast.subtitle} onHidden={hide} />;
}
