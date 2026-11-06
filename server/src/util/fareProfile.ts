/**
 * TARIFPROFIL — Ermäßigungskarte und Deutschlandticket des Reisenden.
 *
 * Die App kennt sie aus Profil → Einstellungen → Reisen und schickt sie bei
 * jeder Zugsuche als kurze Kennung mit: „bc50", „bc50+dt", „dt" oder leer.
 * Die DB rechnet damit den Preis, den dieser Mensch wirklich zahlt — Binch
 * schätzt nichts, es fragt nur mit den richtigen Angaben an.
 *
 * Die Kennung ist TEIL DER IDENTITÄT einer Suche und eines Preisalarms: Ein
 * BahnCard-Preis darf nie aus dem Cache bei jemandem ohne BahnCard landen, und
 * ein Alarm darf nur mit Preisen desselben Tarifs verglichen werden. Deshalb
 * gibt es genau EINE Schreibweise (`formatFareProfile`) — „dt+bc50" und
 * „bc50+dt" wären sonst zwei Cache-Einträge für dasselbe.
 *
 * Nur Zugsuchen haben eines (`fareProfileFor`). Flug, Bus und Schiff fragen
 * keine DB-Tarife an; dort trennte die Kennung nur den Cache ohne Nutzen.
 */
import type { TravelMode } from "../db/schema.js";

export const RAIL_CARDS = ["bc25", "bc50", "bc100", "vorteilscard", "halbtax", "ga", "klimaticket"] as const;
export type RailCard = (typeof RAIL_CARDS)[number];

/** Namen, wie die Anbieter sie schreiben — für Bos Kontext. */
export const RAIL_CARD_NAMES: Record<RailCard, string> = {
  bc25: "BahnCard 25",
  bc50: "BahnCard 50",
  bc100: "BahnCard 100",
  vorteilscard: "ÖBB Vorteilscard",
  halbtax: "SBB Halbtax",
  ga: "SBB GA",
  klimaticket: "KlimaTicket Ö",
};

/** Mindest-Umstiegszeiten, die die App anbietet (Minuten). */
export const TRANSFER_MINUTES = [10, 15, 20] as const;

/**
 * Seit 28.10.2026 auch, WAS gesucht wird — nicht nur, was es kostet:
 * `dto` nur Verbindungen mit Deutschlandticket, `t10`/`t15`/`t20` Mindest-
 * Umstiegszeit, `bike` Fahrrad-Mitnahme. Alles, was Treffer oder Preise einer
 * Zugsuche ändert, steht hier — damit es automatisch Teil von Cache- und
 * Alarm-Identität ist. Kanonische Reihenfolge: Karte, dt, dto, tN, bike.
 */
export interface FareProfile {
  card: RailCard | null;
  /** Deutschlandticket vorhanden: Nahverkehr kostet dann nichts extra. */
  dTicket: boolean;
  /** Nur Verbindungen, die das Deutschlandticket abdeckt. */
  dTicketOnly: boolean;
  /** Mindest-Umstiegszeit in Minuten, `null` = wie die Bahn es vorsieht. */
  transferMin: number | null;
  /** Nur Verbindungen mit Fahrrad-Mitnahme. */
  bike: boolean;
}

const NONE: FareProfile = { card: null, dTicket: false, dTicketOnly: false, transferMin: null, bike: false };

/** Unbekannte Teile fallen weg — eine kaputte Kennung wird zu „kein Profil", nie zu einem Fehler. */
export function parseFareProfile(raw?: string | null): FareProfile {
  if (!raw) return NONE;
  const out: FareProfile = { ...NONE };
  for (const part of raw.toLowerCase().split("+")) {
    const p = part.trim();
    if (p === "dt") out.dTicket = true;
    else if (p === "dto") out.dTicketOnly = true;
    else if (p === "bike") out.bike = true;
    else if (/^t\d{1,2}$/.test(p) && (TRANSFER_MINUTES as readonly number[]).includes(Number(p.slice(1)))) out.transferMin = Number(p.slice(1));
    else if ((RAIL_CARDS as readonly string[]).includes(p)) out.card = p as RailCard;
  }
  return out;
}

export function formatFareProfile(p: FareProfile): string {
  return [
    p.card,
    p.dTicket ? "dt" : null,
    p.dTicketOnly ? "dto" : null,
    p.transferMin ? `t${p.transferMin}` : null,
    p.bike ? "bike" : null,
  ]
    .filter(Boolean)
    .join("+");
}

/** Die kanonische Kennung für eine Suche dieser Art — leer außer bei Zügen. */
export function fareProfileFor(mode: TravelMode | undefined, raw?: string | null): string {
  return mode === "TRAIN" ? formatFareProfile(parseFareProfile(raw)) : "";
}

/**
 * Die Parameter für `/journeys` des db-vendo-Sidecars (lib/api-parsers.js dort).
 *
 * Die BahnCard gilt in der Klasse, in der gereist wird: Wer 1. Klasse sucht,
 * bekommt die BahnCard 1. Klasse angesetzt. Eine Karte der anderen Klasse
 * ermäßigt dort ohnehin nicht — und eine zweite Einstellung „Klasse der Karte"
 * wäre eine Frage mehr für einen Fall, den es kaum gibt.
 */
export function dbVendoFareParams(p: FareProfile, firstClass: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (firstClass) out.firstClass = "true";
  const cls = firstClass ? "1st" : "2nd";
  switch (p.card) {
    case "bc25":
    case "bc50":
    case "bc100":
      out.loyaltyCard = `bahncard-${cls}-${p.card.slice(2)}`;
      break;
    case "vorteilscard":
      out.loyaltyCard = "vorteilscard";
      break;
    case "halbtax":
      out.loyaltyCard = "halbtaxabo";
      break;
    case "ga":
      out.loyaltyCard = `generalabonnement-${cls}`;
      break;
    case "klimaticket":
      out.loyaltyCard = "at-klimaticket";
      break;
    default:
      break;
  }
  if (p.dTicket) out.deutschlandTicketDiscount = "true";
  if (p.dTicketOnly) out.deutschlandTicketConnectionsOnly = "true";
  if (p.transferMin) out.transferTime = String(p.transferMin);
  if (p.bike) out.bike = "true";
  return out;
}

/**
 * Dieselben Vorgaben für MOTIS (/v6/plan) — sonst mischte die zweite Quelle
 * Verbindungen dazu, die gegen sie verstoßen (ICE bei „nur Deutschlandticket",
 * 4 Minuten Umstieg bei „mindestens 15").
 */
export function motisFareParams(p: FareProfile): { transitModes: string | null; extra: string } {
  return {
    // Nur Nahverkehr: ohne Fern-, Hochgeschwindigkeits- und Nachtzüge, ohne Fernbus.
    transitModes: p.dTicketOnly ? "REGIONAL_FAST_RAIL,REGIONAL_RAIL,SUBURBAN,TRAM,SUBWAY,BUS,FERRY" : null,
    extra: (p.transferMin ? `&minTransferTime=${p.transferMin}` : "") + (p.bike ? "&requireBikeTransport=true" : ""),
  };
}
