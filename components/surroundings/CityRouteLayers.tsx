import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { GeoJSONSource, Layer } from "@maplibre/maplibre-react-native";
import type { CityRoutes, RoutePlan } from "@/stores/searchStore";
import { useAccent } from "@/lib/theme/accent";
import { RouteLayer, routeLineCollection } from "@/components/surroundings/RouteLayer";
import {
  LINE_SOURCE_MAXZOOM,
  LINE_SOURCE_TOLERANCE,
} from "@/components/surroundings/lineSourceTuning";

/**
 * Die Verbindungen des Stadt-Blatts auf der Karte — wie im Beispiel von Google:
 * die gewählte im Akzent, die übrigen grau dahinter, jede mit ihrer Dauer in
 * einer Blase an der Linie.
 *
 * Die gewählte zeichnet die bestehende `RouteLayer` (Linie, Start, Umstiege,
 * Ziel) — dieselbe Darstellung wie „Auf Karte zeigen" aus der Ergebnisliste.
 * Neu sind nur die grauen Alternativen und die Blasen. Beide rechnen mit
 * derselben Linienführung wie die gewählte (`routeLineCollection`).
 *
 * Eine graue Linie oder ihre Blase anzutippen wählt diese Verbindung; das Blatt
 * markiert daraufhin ihre Karte.
 *
 * Alles hier sind Ebenen der Karte selbst (GeoJSON, von der GPU gezeichnet) —
 * nichts davon wird beim Verschieben Bild für Bild neu gesetzt.
 */

const ALT_SRC = "city-alt-src";
const PILL_SRC = "city-pill-src";

/** Grau wie die zurückgenommenen Texte der Blätter (`g2`). */
const ALT_COLOR = "#8E8E93";

/**
 * Feste Stil-Objekte — Begründung an `ROUND_LINE` in RouteLayer.tsx: Literale im
 * JSX gingen bei jedem Durchgang neu an die Karte.
 */
type LayerProps = ComponentProps<typeof Layer>;
type LineProps = Extract<LayerProps, { type: "line" }>;
type SymbolProps = Extract<LayerProps, { type: "symbol" }>;
const ROUND_LINE: LineProps["layout"] = { "line-cap": "round", "line-join": "round" };
const ALT_CASING_PAINT: LineProps["paint"] = {
  "line-color": "#14181A",
  "line-width": 7,
  "line-opacity": 0.6,
};
const ALT_LINE_PAINT: LineProps["paint"] = {
  "line-color": ALT_COLOR,
  "line-width": 4,
  "line-opacity": 0.9,
};
const PILL_ALT_FILTER: SymbolProps["filter"] = ["!=", ["get", "sel"], true];
const PILL_SEL_FILTER: SymbolProps["filter"] = ["==", ["get", "sel"], true];
const PILL_ALT_LAYOUT: SymbolProps["layout"] = {
  "icon-image": ["concat", "route-pill-dark-", ["to-string", ["get", "len"]]],
  "icon-size": 1 / 3,
  "text-field": ["get", "label"],
  "text-font": ["Noto Sans Regular"],
  "text-size": 13,
  "icon-allow-overlap": false,
  "text-allow-overlap": false,
};
const PILL_ALT_PAINT: SymbolProps["paint"] = { "text-color": "#F4F4F5" };

/** Zeichenzahl, für die es eine Blase gibt — siehe build-route-pills.mjs. */
function pillLen(label: string): number {
  return Math.max(2, Math.min(9, label.length));
}

/**
 * Ein Punkt auf der Linie, `frac` des Weges vom Start. Gerechnet in Grad —
 * für die Lage einer Blase genau genug, und ohne Projektion.
 */
function pointAlong(plan: RoutePlan, frac: number): [number, number] | null {
  const coords: [number, number][] = [];
  for (const f of routeLineCollection(plan.waypoints, plan.legs).features) {
    for (const c of f.geometry.coordinates) coords.push(c as [number, number]);
  }
  if (coords.length === 0) return null;
  if (coords.length === 1) return coords[0]!;
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot(coords[i]![0] - coords[i - 1]![0], coords[i]![1] - coords[i - 1]![1]);
    seg.push(d);
    total += d;
  }
  let want = total * frac;
  for (let i = 0; i < seg.length; i++) {
    if (want <= seg[i]! || i === seg.length - 1) {
      const t = seg[i]! === 0 ? 0 : Math.min(1, want / seg[i]!);
      const a = coords[i]!;
      const b = coords[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    want -= seg[i]!;
  }
  return coords[coords.length - 1]!;
}

export const CityRouteLayers = memo(function CityRouteLayers({
  routes,
  onSelect,
}: {
  routes: CityRoutes;
  onSelect: (index: number) => void;
}) {
  const accent = useAccent();
  const tone = accent.id === "mint" ? "mint" : "lime";
  const selected = routes.plans[routes.selected];

  /** Alle NICHT gewählten Strecken, Etappe für Etappe, mit ihrer Nummer. */
  const altGeo = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: routes.plans.flatMap((plan, idx) =>
        idx === routes.selected
          ? []
          : routeLineCollection(plan.waypoints, plan.legs).features.map((f) => ({
              ...f,
              properties: { ...f.properties, idx },
            })),
      ),
    }),
    [routes.plans, routes.selected],
  );

  /**
   * Eine Blase je Strecke. Die gewählte sitzt in der Mitte ihrer Linie; die
   * grauen bei einem Drittel — laufen zwei Strecken ein Stück gemeinsam,
   * stapeln sich die Blasen sonst genau übereinander.
   */
  const pillGeo = useMemo(
    () => ({
      type: "FeatureCollection" as const,
      features: routes.plans.flatMap((plan, idx) => {
        const sel = idx === routes.selected;
        const at = pointAlong(plan, sel ? 0.5 : 0.33);
        const label = routes.durations[idx] ?? "";
        if (!at || !label) return [];
        return [
          {
            type: "Feature" as const,
            geometry: { type: "Point" as const, coordinates: at },
            properties: { idx, sel, label, len: pillLen(label) },
          },
        ];
      }),
    }),
    [routes.plans, routes.selected, routes.durations],
  );

  const pressIdx = useCallback(
    (e: { nativeEvent: { features: GeoJSON.Feature[] } }) => {
      const f = e.nativeEvent.features.find((x) => typeof x.properties?.idx === "number");
      if (f) onSelect(f.properties!.idx as number);
    },
    [onSelect],
  );
  // Fest, damit `RouteLayer` (memo) nicht bei jedem Durchgang mitläuft.
  const pressSelected = useCallback(() => onSelect(routes.selected), [onSelect, routes.selected]);
  const pillSelLayout = useMemo<SymbolProps["layout"]>(
    () => ({
      "icon-image": ["concat", `route-pill-${tone}-`, ["to-string", ["get", "len"]]],
      "icon-size": 1 / 3,
      "text-field": ["get", "label"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 13,
      "icon-allow-overlap": true,
      "text-allow-overlap": true,
    }),
    [tone],
  );
  const pillSelPaint = useMemo<SymbolProps["paint"]>(
    () => ({ "text-color": accent.textOnSolid }),
    [accent.textOnSolid],
  );

  if (!selected) return null;

  return (
    <>
      {/* Unten: die grauen Alternativen, mit dunkler Kante wie die gewählte. */}
      <GeoJSONSource
        id={ALT_SRC}
        data={altGeo}
        maxzoom={LINE_SOURCE_MAXZOOM}
        tolerance={LINE_SOURCE_TOLERANCE}
        onPress={pressIdx}
      >
        <Layer id="city-alt-casing" type="line" layout={ROUND_LINE} paint={ALT_CASING_PAINT} />
        <Layer id="city-alt-line" type="line" layout={ROUND_LINE} paint={ALT_LINE_PAINT} />
      </GeoJSONSource>

      {/* Darüber die gewählte — die bestehende Darstellung mit Halten. */}
      <RouteLayer
        waypoints={selected.waypoints}
        legs={selected.legs}
        mode={selected.mode}
        // Antippbar, damit ein Tipp auf die gewählte Linie kein Tipp auf die
        // freie Karte ist — der holte im Nur-Karte-Modus die Oberfläche zurück.
        onPress={pressSelected}
      />

      {/* Ganz oben die Blasen. */}
      <GeoJSONSource id={PILL_SRC} data={pillGeo} onPress={pressIdx}>
        {/* Die grauen weichen einander aus, … */}
        <Layer
          id="city-pill-alt"
          type="symbol"
          filter={PILL_ALT_FILTER}
          layout={PILL_ALT_LAYOUT}
          paint={PILL_ALT_PAINT}
        />
        {/* … die gewählte steht immer. */}
        <Layer
          id="city-pill-sel"
          type="symbol"
          filter={PILL_SEL_FILTER}
          layout={pillSelLayout}
          paint={pillSelPaint}
        />
      </GeoJSONSource>
    </>
  );
});
