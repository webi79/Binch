import { config } from "../../config.js";
import type { BookingContext } from "../../services/tokenService.js";

const RAPIDAPI_HOST = "google-flights2.p.rapidapi.com";
const DETAILS_URL = `https://${RAPIDAPI_HOST}/api/v1/getBookingDetails`;
const URL_URL = `https://${RAPIDAPI_HOST}/api/v1/getBookingURL`;

interface RawProvider {
  id?: string;
  title?: string;
  website?: string;
  price?: number;
  is_airline?: boolean;
  token?: string;
  bookings?: unknown;
}

interface DetailsResponse {
  status?: boolean;
  data?: RawProvider[];
  bag_info?: unknown;
}

interface UrlResponse {
  status?: boolean;
  data?: string;
}

/**
 * Single Buchungs-Option (1 Anbieter) zu einem Flug-Itinerary.
 *
 * `providerToken` ist NICHT der Search-Token sondern ein per-Anbieter-Token den
 * Google Flights pro Provider ausstellt. Der Client schickt ihn zurück an
 * unseren `/api/flights/booking-url`-Endpoint sobald der User „Zur Seite" tippt,
 * und wir resolven ihn DANN erst zum echten Deeplink (= 1 RapidAPI-Call pro
 * Klick statt N Klicks-Worth pro Sheet-Open).
 */
export interface FlightBookingOption {
  /** Anbieter-Name aus der Google-Flights-Response (Eurowings, Booking.com, Expedia, …). */
  name: string;
  /** Anbieter-Kurzcode (EW, BOOKING, EXPEDIA, KIWI, …). */
  code?: string;
  /** Domain für Logo-Inferenz und Anzeige. */
  website?: string;
  /** Preis in der angefragten Währung. */
  price?: number;
  currency?: string;
  /** True wenn der Anbieter die Fluggesellschaft selbst ist. */
  isAirline?: boolean;
  /** Token den der Client an `/api/flights/booking-url` schickt um den
   *  Deeplink zu resolven. NICHT der Search-Token. */
  providerToken: string;
}

const COMMON_HEADERS = () => ({
  "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
  "x-rapidapi-host": RAPIDAPI_HOST,
});

/** Timeout für RapidAPI-Calls. Ohne das hängt die Route bei einem trägen
 *  Upstream, was der Client als „Skeleton lädt für immer" sieht — Fallback
 *  auf Airline-Only-Card bekommt er dann nie, weil React-Query stale-time
 *  greift sobald die Antwort doch noch eintrifft (oder gar nicht). */
const FETCH_TIMEOUT_MS = 12_000;

function fetchWithTimeout(url: string | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

/**
 * Holt alle Buchungs-Anbieter für ein Google-Flights-Search-`booking_token`.
 *
 * Hinweise:
 *   - Die API liefert i.d.R. 15-25 Anbieter (Airline-Direct + OTAs).
 *   - Tokens haben eine kurze TTL (Search-Token ~10min). Bei Cache-Hits aus
 *     unserer 10min-TTL-Welt können sie bereits abgelaufen sein → leere Liste.
 *   - Wir geben NUR die Provider-Tokens an den Client weiter, keine URLs.
 *     URLs werden erst on-demand beim „Zur Seite"-Tap aufgelöst (siehe
 *     `getFlightBookingUrl`). Das spart bei 20+ Anbietern massiv Kosten.
 */
export async function getFlightBookingOptions(
  bookingToken: string,
  ctx: BookingContext,
): Promise<FlightBookingOption[]> {
  if (!config.RAPIDAPI_KEY) return [];
  if (!ctx.origin || !ctx.destination || !ctx.departDate) return [];

  const url = new URL(DETAILS_URL);
  url.searchParams.set("departure_id", ctx.origin);
  url.searchParams.set("arrival_id", ctx.destination);
  url.searchParams.set("outbound_date", ctx.departDate);
  if (ctx.returnDate) url.searchParams.set("return_date", ctx.returnDate);
  url.searchParams.set("adults", String(ctx.passengers ?? 1));
  url.searchParams.set("currency", (ctx.currency ?? "EUR").toUpperCase());
  url.searchParams.set("travel_class", "ECONOMY");
  url.searchParams.set("type", ctx.returnDate ? "1" : "2");
  url.searchParams.set("booking_token", bookingToken);

  let res: Response;
  try {
    res = await fetchWithTimeout(url, { method: "GET", headers: COMMON_HEADERS() });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let data: DetailsResponse;
  try {
    data = (await res.json()) as DetailsResponse;
  } catch {
    return [];
  }
  if (!data.status || !Array.isArray(data.data)) return [];

  const out: FlightBookingOption[] = [];
  const seenTokens = new Set<string>();
  for (const p of data.data) {
    if (!p.token || !p.title) continue;
    if (seenTokens.has(p.token)) continue;
    seenTokens.add(p.token);
    out.push({
      name: p.title,
      code: p.id,
      website: p.website,
      price: typeof p.price === "number" ? p.price : undefined,
      currency: (ctx.currency ?? "EUR").toUpperCase(),
      isAirline: p.is_airline === true,
      providerToken: p.token,
    });
  }
  return out;
}

/**
 * Resolves einen einzelnen Provider-Token in den finalen Booking-Deeplink.
 * Wird vom Client per `/api/flights/booking-url`-Redirect-Endpoint genutzt:
 *   User klickt „Zur Seite" → Client öffnet unseren Redirect-Endpoint →
 *   Server ruft hier auf → 302 zum Anbieter.
 */
export async function getFlightBookingUrl(providerToken: string): Promise<string | null> {
  if (!config.RAPIDAPI_KEY) return null;
  if (!providerToken) return null;

  let res: Response;
  try {
    res = await fetchWithTimeout(URL_URL, {
      method: "POST",
      headers: { ...COMMON_HEADERS(), "Content-Type": "application/json" },
      body: JSON.stringify({ token: providerToken }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: UrlResponse;
  try {
    data = (await res.json()) as UrlResponse;
  } catch {
    return null;
  }
  if (!data.status || typeof data.data !== "string" || !data.data.startsWith("http")) {
    return null;
  }
  return data.data;
}

/**
 * Backwards-compatible: liefert ersten Provider-Deeplink für den
 * /redirect/:token-Pfad (Standard-„Zur Seite"-Button auf nicht-Flug-Pfaden
 * bzw. wenn der Client noch das alte Token-Modell nutzt).
 */
export async function resolveFlightBookingUrl(
  bookingToken: string,
  ctx: BookingContext,
): Promise<string | null> {
  const options = await getFlightBookingOptions(bookingToken, ctx);
  if (options.length === 0) return null;
  const first = options[0]!;
  return getFlightBookingUrl(first.providerToken);
}
