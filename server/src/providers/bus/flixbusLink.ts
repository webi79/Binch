import { config } from "../../config.js";

/**
 * Buchungslink in den FlixBus-Shop — EINE Quelle für beide Pfade (offene API und
 * RapidAPI-Notfall), damit sie nicht auseinanderlaufen.
 *
 * Vorbelegt mit Städten, Datum, Personenzahl und der WÄHRUNG DER APP. Vorher kam
 * der Link ungefiltert aus der API und trug deren Vorgaben (`currency=EUR`,
 * `_locale=en`) — er passte also weder zur eingestellten Währung noch zur Sprache.
 *
 * `_locale` lassen wir bewusst WEG: Dann wählt der Shop die Sprache nach dem
 * Gerät des Users. Setzten wir sie fest, müssten wir die App-Sprache bis hierher
 * durchreichen und hätten sie im Cache-Key — für ein reines Anzeigedetail.
 *
 * Eine konkrete FAHRT lässt sich nicht verlinken: Der Shop akzeptiert offiziell
 * nur departureCity/arrivalCity/rideDate/adult/children/bike_slot/currency/_locale,
 * keinen Trip-Parameter. Es bleibt die exakt vorbelegte Tagessuche.
 */
export interface ShopLinkInput {
  fromCityId: string;
  toCityId: string;
  /** ISO-Datum der Fahrt (Hin- ODER Rückrichtung). */
  rideDate: string;
  passengers: number;
  currency: string;
}

/** "2026-05-15" → "15.05.2026" */
export function isoToDmy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function buildShopLink(link: ShopLinkInput): string {
  const params = new URLSearchParams({
    departureCity: link.fromCityId,
    arrivalCity: link.toCityId,
    rideDate: isoToDmy(link.rideDate),
    adult: String(link.passengers),
    children: "0",
    bike_slot: "0",
    currency: link.currency,
  });
  if (config.FLIXBUS_AFFILIATE_ID) params.set("partner", config.FLIXBUS_AFFILIATE_ID);
  return `https://shop.flixbus.com/search?${params.toString()}`;
}
