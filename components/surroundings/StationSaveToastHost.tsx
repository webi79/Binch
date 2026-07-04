/**
 * Rendert den Station-Speichern-Toast am Screen-Level (analog SavedToastHost
 * für Flüge). Wird global in app/_layout.tsx gemountet und vom Store getrieben
 * (showStationToast/hideStationToast). key={toast.key} remountet pro Toast →
 * Animation + Auto-Hide triggern neu.
 */
import { useSearchStore } from "@/stores/searchStore";
import { SaveToast } from "./SaveToast";

export function StationSaveToastHost() {
  const toast = useSearchStore((s) => s.stationToast);
  const hide = useSearchStore((s) => s.hideStationToast);
  if (!toast) return null;
  return (
    <SaveToast
      key={toast.key}
      visible
      title={toast.title}
      subtitle={toast.subtitle}
      onHide={hide}
    />
  );
}
