import { config } from "../../config.js";
import type { BookingContext } from "../../services/tokenService.js";

const RAPIDAPI_HOST = "google-flights2.p.rapidapi.com";
const BOOKING_URL = `https://${RAPIDAPI_HOST}/api/v1/getBookingFlight`;

interface BookingOptionMaybeUrl {
  url?: string;
  book_with_url?: string;
  booking_request?: { url?: string };
  together?: { url?: string; booking_request?: { url?: string } };
  separate_tickets?: Array<{ url?: string; booking_request?: { url?: string } }>;
}

interface BookingResponse {
  data?: {
    booking_options?: BookingOptionMaybeUrl[];
  };
  booking_options?: BookingOptionMaybeUrl[];
}

/**
 * Resolves the SerpAPI/google-flights2 `booking_token` into the airline-/OTA-
 * direct purchase URL by calling the 2nd-stage booking-options endpoint.
 * Returns null when the API is unconfigured, the call fails, or the response
 * shape doesn't carry a usable URL — the caller falls back to the search-page
 * deeplink in that case.
 */
export async function resolveFlightBookingUrl(
  bookingToken: string,
  ctx: BookingContext,
): Promise<string | null> {
  if (!config.RAPIDAPI_KEY) return null;
  if (!ctx.origin || !ctx.destination || !ctx.departDate) return null;

  const url = new URL(BOOKING_URL);
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
    res = await fetch(url, {
      method: "GET",
      headers: {
        "x-rapidapi-key": config.RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let data: BookingResponse;
  try {
    data = (await res.json()) as BookingResponse;
  } catch {
    return null;
  }

  const options = data.data?.booking_options ?? data.booking_options ?? [];
  for (const opt of options) {
    const direct = pickUrl(opt);
    if (direct) return direct;
  }
  return null;
}

function pickUrl(opt: BookingOptionMaybeUrl): string | null {
  if (opt.url) return opt.url;
  if (opt.book_with_url) return opt.book_with_url;
  if (opt.booking_request?.url) return opt.booking_request.url;
  if (opt.together?.url) return opt.together.url;
  if (opt.together?.booking_request?.url) return opt.together.booking_request.url;
  if (opt.separate_tickets) {
    for (const t of opt.separate_tickets) {
      if (t.url) return t.url;
      if (t.booking_request?.url) return t.booking_request.url;
    }
  }
  return null;
}
