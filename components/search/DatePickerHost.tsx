/**
 * DatePickerHost — Root-Level Wrapper für den BinchDatePicker.
 *
 * BinchDatePicker ist IMMER gemountet (LocationPicker-Pattern): kein Cold-
 * Start beim ersten Open. Visibility wird via Store-State (`datePickerRequest`)
 * gesteuert; der Slide selbst läuft auf dem UI-Thread via SharedValues.
 */
import { useMemo } from "react";
import { useSearchStore } from "@/stores/searchStore";
import { useT } from "@/lib/i18n/useT";
import { BinchDatePicker } from "./BinchDatePicker";

export function DatePickerHost() {
  const request = useSearchStore((s) => s.datePickerRequest);
  const closeDatePicker = useSearchStore((s) => s.closeDatePicker);
  const confirmDatePicker = useSearchStore((s) => s.confirmDatePicker);
  const t = useT();

  // Wenn der Picker gerade nicht offen ist, mounten wir den BinchDatePicker
  // TROTZDEM mit visible=false → er bleibt für die ganze Session im Tree,
  // slidet beim nächsten Open instant auf UI-Thread rein.
  const visible = request !== null;
  const fieldLabel = useMemo(
    () =>
      request?.field === "return"
        ? t("search.return")
        : t("search.departure"),
    [request?.field, t],
  );

  return (
    <BinchDatePicker
      visible={visible}
      onClose={closeDatePicker}
      minimumDate={request?.minimumDate ?? undefined}
      initialDate={request?.initialDate ?? null}
      fieldLabel={fieldLabel}
      onConfirmDate={({ year, month, day, hour, minute }) => {
        const picked = new Date(year, month, day, hour, minute, 0, 0);
        confirmDatePicker(picked);
      }}
    />
  );
}
