/**
 * LocationPickerHost — am Root-Layout gemountet damit der LocationPicker
 * vom App-Start an warm ist (kein Cold-Start beim ersten Open im
 * SearchHero). Gleicher Pattern wie DatePickerHost.
 */
import { useSearchStore } from "@/stores/searchStore";
import { LocationPicker } from "./LocationPicker";

export function LocationPickerHost() {
  const request = useSearchStore((s) => s.locationPickerRequest);
  const closeLocationPicker = useSearchStore((s) => s.closeLocationPicker);
  const confirmLocationPicker = useSearchStore((s) => s.confirmLocationPicker);

  const visible = request !== null;

  return (
    <LocationPicker
      visible={visible}
      onClose={closeLocationPicker}
      onSelect={confirmLocationPicker}
      field={request?.field ?? "from"}
      mode={request?.mode ?? "ALL"}
      suggested={request?.suggested ?? []}
    />
  );
}
