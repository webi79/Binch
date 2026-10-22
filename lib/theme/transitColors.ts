/**
 * DIE FARBEN DER VERKEHRSMITTEL — eine Quelle für die ganze App.
 *
 * Bis zum 21.10.2026 hatte jede Stelle ihre eigene Farbwelt: Ein Bus war auf
 * der Karte lila, in der Verbindungsliste Flix-grün; ein Regionalzug hier
 * bernstein, dort orange, im Live-Punkt gelb; die U-Bahn mal dunkel-, mal
 * hellblau; die Tram dunkelgrau, grau oder rot. Jetzt gilt überall dasselbe —
 * Vorbild sind die Kästen der Karte. Symbole und Schrift darauf sind weiß.
 *
 * Die Kästen selbst sind fertige Bilder: `MODE_FILL` in
 * server/scripts/build-marker-icons.mjs trägt dieselben Werte (von Hand gleich
 * halten), ebenso die Zierstreifen der 3D-Modelle
 * (server/scripts/build-live-models.mjs → lib/live/liveModelSpecs.ts).
 * Flüge tragen den Akzent der App (`accent.dark`), keine feste Farbe.
 */
export const TRANSIT_COLOR = {
  /** ICE, IC, EC — DB-Rot, wie bei DB und Google Maps. */
  longDistance: "#EC0016",
  /** RE, RB und Züge ohne nähere Angabe — Bernstein. */
  regional: "#E8A800",
  /** S-Bahn — Grün. */
  suburban: "#3D8C40",
  /** U-Bahn — Dunkelblau. */
  subway: "#1F3A8A",
  /** Straßenbahn — Dunkelgrau. */
  tram: "#2A2A2C",
  /** Bus, auch Ersatzverkehr — Lila. */
  bus: "#9D5FE0",
  /** Fähre, Schiff — Stahlblau. */
  ferry: "#6B95B5",
  /** Unbekannte Verkehrsart — Grau. */
  other: "#6E6E73",
} as const;

export type TransitCategory = keyof typeof TRANSIT_COLOR | "flight";

/** Fernverkehr? (ICE/IC/EC, MOTIS HIGHSPEED_RAIL/LONG_DISTANCE/NIGHT_RAIL, HAFAS national…) */
export function isLongDistance(product: string | null | undefined): boolean {
  return /highspeed|long_distance|night_rail|national|^ice|^ic\b|^ec\b/i.test(product ?? "");
}

/**
 * Die Verkehrsart einer Fahrt — aus dem Produkt der Quelle (HAFAS „regional",
 * MOTIS „REGIONAL_RAIL" …) und, wo vorhanden, dem Liniennamen: Ersatzverkehr
 * („Bus RB59", „SEV RE1") führen die Quellen unter dem Zug, gefahren wird Bus.
 * Transitous liefert deutsche S-Bahnen als `metro`.
 */
export function transitCategory(product: string | null | undefined, line?: string | null): TransitCategory {
  if (/^(bus|sev)\b/i.test((line ?? "").trim())) return "bus";
  const p = (product ?? "").toLowerCase();
  if (isLongDistance(p)) return "longDistance";
  if (/flight|airplane/.test(p)) return "flight";
  if (/suburban|metro|s-bahn|sbahn/.test(p)) return "suburban";
  if (/subway|underground|u-bahn|ubahn/.test(p)) return "subway";
  if (/tram|stadtbahn|light/.test(p)) return "tram";
  if (/bus|coach/.test(p)) return "bus";
  if (/ferry|ship|boat/.test(p)) return "ferry";
  if (/regional|express|rail|train/.test(p)) return "regional";
  return "other";
}

/** Dieselbe Farbe als durchscheinende Fläche (`rgba`) — für getönte Hintergründe. */
export function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}
