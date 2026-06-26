import type { BookingContext } from "../../services/tokenService.js";
import {
  getFlightBookingOptions as gf2GetOptions,
  getFlightBookingUrl as gf2GetUrl,
  resolveFlightBookingUrl as gf2Resolve,
  type FlightBookingOption,
} from "./googleFlightsBooking.js";
import {
  getSearchApiBookingOptions,
  getSearchApiRoundTripBookingOptions,
  resolveSearchApiBookingUrl,
  resolveSearchApiRoundTripBookingUrl,
} from "./searchApiFlightsBooking.js";

// Dispatcher: SearchAPI-Ergebnisse tragen ein Präfix auf dem bookingToken
// (siehe searchApiFlights.ts):
//   "sapi:"    = One-way booking_token
//   "sapi-rt:" = Round-Trip departure_token (Booking holt damit Rückflüge+Provider)
// google-flights2-Ergebnisse (Fallback) haben kein Präfix. So landet jeder Token
// beim richtigen Resolver, ohne dass wir den Provider separat durchreichen müssen.
const ONEWAY = "sapi:";
const ROUNDTRIP = "sapi-rt:";

export async function getBookingOptions(
  token: string,
  ctx: BookingContext,
): Promise<FlightBookingOption[]> {
  if (token.startsWith(ROUNDTRIP)) {
    return getSearchApiRoundTripBookingOptions(token.slice(ROUNDTRIP.length), ctx);
  }
  if (token.startsWith(ONEWAY)) {
    return getSearchApiBookingOptions(token.slice(ONEWAY.length), ctx);
  }
  return gf2GetOptions(token, ctx);
}

export async function resolveBookingUrl(
  token: string,
  ctx: BookingContext,
): Promise<string | null> {
  if (token.startsWith(ROUNDTRIP)) {
    return resolveSearchApiRoundTripBookingUrl(token.slice(ROUNDTRIP.length), ctx);
  }
  if (token.startsWith(ONEWAY)) {
    return resolveSearchApiBookingUrl(token.slice(ONEWAY.length), ctx);
  }
  return gf2Resolve(token, ctx);
}

/** Per-Anbieter-URL-Auflösung — nur google-flights2 nutzt kurzlebige per-Anbieter-
 *  Tokens. SearchAPI-Anbieter tragen `resolvedUrl` direkt; dieser Pfad wird für
 *  sie nicht gebraucht (leerer providerToken → null → Client-Fallback). */
export async function getBookingUrlByProviderToken(providerToken: string): Promise<string | null> {
  if (!providerToken) return null;
  return gf2GetUrl(providerToken);
}
