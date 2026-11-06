/**
 * Tarifprofil der Zugsuche — Ermäßigungskarte und Deutschlandticket aus
 * Profil → Einstellungen → Reisen.
 *
 * Geht als kurze Kennung an den Server („bc50", „bc50+dt", „dt" oder leer),
 * der damit bei der DB genau den Preis anfragt, den dieser Mensch zahlt. Die
 * Schreibweise ist dieselbe wie in server/src/util/fareProfile.ts: Sie ist
 * Teil des Cache-Schlüssels und der Preisalarme, und zwei Schreibweisen für
 * dasselbe Profil wären zwei getrennte Einträge.
 *
 * Nur Züge haben eines — Flug, Bus und Schiff fragen keine DB-Tarife an.
 */
import { useSearchStore } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

export const RAIL_CARDS = ["bc25", "bc50", "bc100", "vorteilscard", "halbtax", "ga", "klimaticket"] as const;
export type RailCard = (typeof RAIL_CARDS)[number];

/**
 * Namen der Karten, wie ihre Anbieter sie schreiben — Markennamen, nicht
 * übersetzt. `short` für enge Stellen (Vorschau, Kopf der Suche).
 */
export const RAIL_CARD_LABEL: Record<RailCard, { name: string; short: string }> = {
  bc25: { name: "BahnCard 25", short: "BC 25" },
  bc50: { name: "BahnCard 50", short: "BC 50" },
  bc100: { name: "BahnCard 100", short: "BC 100" },
  vorteilscard: { name: "ÖBB Vorteilscard", short: "Vorteilscard" },
  halbtax: { name: "SBB Halbtax", short: "Halbtax" },
  ga: { name: "SBB GA", short: "GA" },
  klimaticket: { name: "KlimaTicket Ö", short: "KlimaTicket" },
};

/** Mindest-Umstiegszeiten, die angeboten werden (Minuten); 0 = wie die Bahn es vorsieht. */
export const TRANSFER_MINUTES = [0, 10, 15, 20] as const;
export type TransferMinutes = (typeof TRANSFER_MINUTES)[number];

/**
 * Seit 28.10.2026 auch, WAS gesucht wird: `dto` nur Verbindungen mit
 * Deutschlandticket, `t10`/`t15`/`t20` Mindest-Umstiegszeit, `bike`
 * Fahrrad-Mitnahme. Reihenfolge wie am Server: Karte, dt, dto, tN, bike.
 */
export function formatFareProfile(
  card: RailCard | null,
  dTicket: boolean,
  opts: { dTicketOnly?: boolean; transferMinutes?: number; bike?: boolean } = {},
): string {
  return [
    card,
    dTicket ? "dt" : null,
    dTicket && opts.dTicketOnly ? "dto" : null,
    opts.transferMinutes ? `t${opts.transferMinutes}` : null,
    opts.bike ? "bike" : null,
  ]
    .filter(Boolean)
    .join("+");
}

/**
 * Was am Preis eines Treffers hängt, lesbar: „BahnCard 50 + Deutschlandticket".
 * `null` ohne Karte und ohne Deutschlandticket. Für die Detail-Ansicht — wer
 * den Preis sieht, soll wissen, wofür er gilt.
 */
export function fareProfileLabel(fp?: string | null): string | null {
  if (!fp) return null;
  const parts = fp.split("+");
  const card = parts.find((x): x is RailCard => (RAIL_CARDS as readonly string[]).includes(x));
  const names = [card ? RAIL_CARD_LABEL[card].name : null, parts.includes("dt") ? "Deutschlandticket" : null].filter(Boolean);
  return names.length > 0 ? names.join(" + ") : null;
}

const LONG_DISTANCE_PRODUCTS = new Set([
  // DB (db-vendo)
  "nationalExpress",
  "national",
  // MOTIS
  "HIGHSPEED_RAIL",
  "LONG_DISTANCE",
  "NIGHT_RAIL",
  "COACH",
]);
const LONG_DISTANCE_LINE = /^(ICE|IC|EC|ECE|EN|NJ|RJX?|TGV|THA|EST|FLX)\b/;

/**
 * Deckt das Deutschlandticket diese Zugverbindung ab?
 *
 * Nur, wenn mit D-Ticket gesucht wurde, die Bahn KEINEN Preis nennt (für
 * abgedeckte Fahrten lässt sie ihn weg — gemessen Köln → Koblenz: alle RE ohne
 * Preis, ICE/IC unverändert) und KEINE Teilstrecke Fernverkehr ist. Dann steht
 * an der Karte „Mit Deutschlandticket" statt „Tarif beim Anbieter".
 */
export function coveredByDTicket(r: {
  mode: TravelMode;
  price: number;
  fareProfile?: string;
  legs?: { product?: string; line?: string; walking?: boolean }[];
}): boolean {
  if (r.mode !== "TRAIN" || r.price > 0 || !r.fareProfile?.split("+").includes("dt")) return false;
  const rides = (r.legs ?? []).filter((l) => !l.walking);
  if (rides.length === 0) return false;
  return rides.every((l) => !(l.product && LONG_DISTANCE_PRODUCTS.has(l.product)) && !LONG_DISTANCE_LINE.test(l.line ?? ""));
}

type FareState = {
  railCard: RailCard | null;
  dTicket: boolean;
  dTicketOnly: boolean;
  transferMinutes: TransferMinutes;
  bikeCarriage: boolean;
};

/** Die Kennung für eine Suche dieser Art, aus dem aktuellen Speicherstand. */
export function fareProfileFor(mode: TravelMode, st: FareState = useSearchStore.getState()): string {
  return mode === "TRAIN"
    ? formatFareProfile(st.railCard, st.dTicket, {
        dTicketOnly: st.dTicketOnly,
        transferMinutes: st.transferMinutes,
        bike: st.bikeCarriage,
      })
    : "";
}

/** Dasselbe reaktiv — für Abfrage-Schlüssel, die bei einem Wechsel neu laden sollen. */
export function useFareProfile(mode: TravelMode): string {
  return useSearchStore((st) => fareProfileFor(mode, st));
}
