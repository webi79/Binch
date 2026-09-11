import { memo, useCallback, useMemo } from "react";
import { useT } from "@/lib/i18n/useT";
import { SPACE } from "@/lib/theme/spacing";
import { FilterChips } from "@/components/ui/FilterChips";
import type { TravelMode } from "@/types/search";

/**
 * Die Kategorie-Auswahl über den gespeicherten Reisen.
 *
 * VIER Knöpfe, nicht fünf: Alle, Flüge, Züge, Busse. Kreuzfahrten haben
 * bewusst keinen — es gibt sie in der App, aber eine eigene Kategorie dafür
 * stünde in fast jeder Sitzung leer, und ein Knopf, hinter dem nie etwas ist,
 * ist schlechter als keiner. Unter „Alle" erscheinen sie trotzdem.
 *
 * Die Form kommt aus `FilterChips` und wird mit der Sortier-Reihe des
 * Ergebnis-Screens geteilt — dieselbe Aufgabe, dieselbe Gestalt.
 */
export type SavedFilter = "all" | Extract<TravelMode, "FLIGHT" | "TRAIN" | "BUS">;

const IDS: { id: SavedFilter; key: string }[] = [
  { id: "all", key: "saved.filter.all" },
  { id: "FLIGHT", key: "saved.filter.flights" },
  { id: "TRAIN", key: "saved.filter.trains" },
  { id: "BUS", key: "saved.filter.buses" },
];

export const SavedFilterRow = memo(function SavedFilterRow({
  value,
  onChange,
}: {
  value: SavedFilter;
  onChange: (v: SavedFilter) => void;
}) {
  const t = useT();
  const items = useMemo(() => IDS.map((it) => ({ id: it.id, label: t(it.key) })), [t]);
  const pick = useCallback((id: string) => onChange(id as SavedFilter), [onChange]);

  return (
    <FilterChips
      items={items}
      value={value}
      onChange={pick}
      /**
       * KEIN eigener seitlicher Abstand — und das ist der Fix, nicht das
       * Weglassen einer Kleinigkeit.
       *
       * Die Reihe steht im Kopf der `SectionList`, und deren `contentContainer`
       * polstert bereits um `GUTTER`. Hier denselben Rand noch einmal zu setzen
       * ergab vierzig statt zwanzig Punkte: Die Knöpfe standen sichtbar weiter
       * innen als die Karten darunter, obwohl beide „am Rand" gemeint waren.
       * Mit null stehen sie auf derselben Kante wie die Karten — und genau das
       * war gewollt.
       */
      contentPadding={0}
      /** Der Abstand nach unten trennt die Reihe von der ersten Karte. */
      style={{ marginBottom: SPACE.md }}
    />
  );
});
