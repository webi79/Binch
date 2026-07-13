import { config } from "../../config.js";
import type { BookingContext } from "../../services/tokenService.js";
import type { FlightBookingOption } from "./googleFlightsBooking.js";

// Booking-Optionen für SearchAPI.io. Im Gegensatz zu google-flights2:
//   - EIN Call liefert pro Anbieter Name + ECHTER Preis + Buchungs-Request
//     (kein ~15%-Aufschlag → kein Ratio-Hack nötig).
//   - Der Buchungslink ist ein POST-Formular an Googles `clk/f`-Endpoint, das
//     per Meta-Refresh auf die finale (lokalisierte) Anbieterseite weiterleitet.
//     Wir lösen das serverseitig auf → fertige `resolvedUrl` für den Client.
//   - Round-Trip: der Such-Token ist ein `departure_token` (Hinflug-Auswahl).
//     Hier holen wir damit on-demand die Rückflüge (günstigsten) und dann dessen
//     Provider — 2 Calls, aber nur beim Detail-Öffnen, nicht pro Suche.
const SEARCH_URL = `${config.SEARCHAPI_BASE_URL}/api/v1/search`;

const FETCH_TIMEOUT_MS = 8_000;
const RESOLVE_TIMEOUT_MS = 4_500;
// Booking-Optionen sind on-demand (beim Detail-Öffnen) → moderat cachen. 30min
// balanciert Kosten (kein Re-Fetch beim erneuten Öffnen) gegen Deeplink-Ablauf
// (die aufgelösten Anbieter-URLs tragen kurzlebige Session-Tokens).
const OPTIONS_CACHE_TTL_MS = 30 * 60 * 1000;
const OPTIONS_CACHE_MAX = 500;
// SearchAPI liefert pro Flug bis ~25 Anbieter; Cap nur als Sicherheitsnetz.
const MAX_RESOLVE = 30;
// Mobile-UA, damit Googles clk/f die (mobile) Meta-Refresh-Seite liefert.
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

interface SaBookingRequest {
  url?: string;
  post_data?: string;
}
interface SaBookingOption {
  book_with?: string;
  price?: number;
  fare_type?: string;
  baggage_prices?: string[];
  airline_logos?: string[];
  booking_request?: SaBookingRequest;
}
// One-way: die Anbieter-Felder liegen DIREKT auf dem Array-Element. Round-Trip:
// sie sind unter `together` (kombiniert) bzw. `departing` verschachtelt. Wir
// behandeln beide (siehe `o.together ?? o.departing ?? o`).
type SaBookingEntry = SaBookingOption & {
  together?: SaBookingOption;
  departing?: SaBookingOption;
};
interface SaSearchResponse {
  best_flights?: { booking_token?: string; price?: number }[];
  other_flights?: { booking_token?: string; price?: number }[];
  booking_options?: SaBookingEntry[];
  error?: string;
}

interface CachedOptions {
  options: FlightBookingOption[];
  expiresAt: number;
}
const optionsCache = new Map<string, CachedOptions>();

function cacheKey(token: string, ctx: BookingContext): string {
  return `${token}|${ctx.passengers ?? 1}|${(ctx.currency ?? "EUR").toUpperCase()}`;
}
function readCache(key: string): FlightBookingOption[] | null {
  const hit = optionsCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    optionsCache.delete(key);
    return null;
  }
  return hit.options;
}
function writeCache(key: string, options: FlightBookingOption[]): void {
  if (optionsCache.size >= OPTIONS_CACHE_MAX) {
    const oldest = optionsCache.keys().next().value;
    if (oldest !== undefined) optionsCache.delete(oldest);
  }
  optionsCache.set(key, { options, expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS });
}

function fetchWithTimeout(url: string | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

const CURRENCY_LOCALE: Record<string, { hl: string; gl: string }> = {
  EUR: { hl: "de", gl: "de" },
  USD: { hl: "en", gl: "us" },
  GBP: { hl: "en", gl: "gb" },
  CHF: { hl: "de", gl: "ch" },
  PLN: { hl: "pl", gl: "pl" },
};

/** Gemeinsame Such-Params für alle google_flights-Calls (Such-Kontext aus ctx).
 *  flight_type/return_date richten sich nach ctx.returnDate. */
function baseParams(ctx: BookingContext): Record<string, string> {
  const want = (ctx.currency ?? "EUR").toUpperCase();
  const loc = CURRENCY_LOCALE[want] ?? { hl: "en", gl: "us" };
  const p: Record<string, string> = {
    engine: "google_flights",
    departure_id: ctx.origin!,
    arrival_id: ctx.destination!,
    outbound_date: ctx.departDate!,
    adults: String(ctx.passengers ?? 1),
    currency: want,
    hl: loc.hl,
    gl: loc.gl,
  };
  if (ctx.returnDate) {
    p.flight_type = "round_trip";
    p.return_date = ctx.returnDate;
  } else {
    p.flight_type = "one_way";
  }
  return p;
}

/** Ein google_flights-GET gegen SearchAPI. Gibt das geparste JSON zurück (oder
 *  null bei HTTP-/Netzwerk-/Parse-Fehler). */
async function saGet(params: Record<string, string>): Promise<SaSearchResponse | null> {
  const url = new URL(SEARCH_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { Authorization: `Bearer ${config.SEARCHAPI_API_KEY}` } },
      FETCH_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    return (await res.json()) as SaSearchResponse;
  } catch {
    return null;
  }
}

/**
 * Löst den POST-Formular-Buchungslink (Googles `clk/f`) zur finalen Anbieter-URL
 * auf. clk/f antwortet mit einer HTML-Seite, die per Meta-Refresh zur echten,
 * lokalisierten Anbieterseite weiterleitet — wir parsen diese Ziel-URL heraus.
 */
async function resolveDeeplink(br?: SaBookingRequest): Promise<string | null> {
  if (!br?.url || !br?.post_data) return null;
  try {
    const res = await fetchWithTimeout(
      br.url,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
        body: br.post_data,
      },
      RESOLVE_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const html = await res.text();
    // 1) Meta-Refresh: <meta http-equiv="refresh" content="0; url=https://…">
    // 2) Fallback: erste externe (nicht-Google) https-URL im HTML.
    const m =
      html.match(/content=["'][^"']*?url=([^"']+)["']/i) ??
      html.match(/(https?:\/\/(?!www\.google|schema|gstatic|googleapis)[^"'\s\\<>]{15,})/i);
    if (!m) return null;
    const url = m[1]!
      .replace(/&amp;/g, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\u0026/gi, "&");
    return url.startsWith("http") ? url : null;
  } catch {
    return null;
  }
}

function hostOf(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** booking_options → de-dupliziert (günstigster pro Anbieter-Name) → Deeplinks
 *  parallel aufgelöst → FlightBookingOption[]. Preise sind bereits echt. */
async function resolveOptions(
  rawOpts: SaBookingEntry[] | undefined,
  want: string,
): Promise<FlightBookingOption[]> {
  const opts = rawOpts ?? [];
  if (opts.length === 0) return [];

  const byName = new Map<string, SaBookingOption>();
  for (const o of opts) {
    const t = o.together ?? o.departing ?? o;
    if (!t?.book_with || !t.booking_request) continue;
    const k = t.book_with.trim().toLowerCase();
    const prev = byName.get(k);
    const op = typeof t.price === "number" ? t.price : Infinity;
    const pp = prev && typeof prev.price === "number" ? prev.price : Infinity;
    if (!prev || op < pp) byName.set(k, t);
  }
  const providers = Array.from(byName.values())
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MAX_RESOLVE);

  return Promise.all(
    providers.map(async (t) => {
      const resolvedUrl = await resolveDeeplink(t.booking_request);
      return {
        name: t.book_with!,
        website: hostOf(resolvedUrl),
        price: typeof t.price === "number" ? t.price : undefined,
        currency: want,
        // SearchAPI markiert Airline-Direktanbieter nicht explizit; der Client
        // zeigt eine generische Notiz. providerToken bleibt leer — der Client
        // nutzt resolvedUrl direkt (kein per-Anbieter-Token-Roundtrip).
        providerToken: "",
        resolvedUrl: resolvedUrl ?? undefined,
      } satisfies FlightBookingOption;
    }),
  );
}

/** One-way: Buchungs-Anbieter für ein SearchAPI-`booking_token` (1 Call). */
export async function getSearchApiBookingOptions(
  bookingToken: string,
  ctx: BookingContext,
): Promise<FlightBookingOption[]> {
  if (!config.SEARCHAPI_API_KEY) return [];
  if (!ctx.origin || !ctx.destination || !ctx.departDate) return [];

  const key = cacheKey(`ow:${bookingToken}`, ctx);
  const cached = readCache(key);
  if (cached) return cached;

  const want = (ctx.currency ?? "EUR").toUpperCase();
  const data = await saGet({ ...baseParams(ctx), booking_token: bookingToken });
  if (!data || data.error) return [];
  const final = await resolveOptions(data.booking_options, want);
  writeCache(key, final);
  return final;
}

/**
 * Round-Trip: aus einem `departure_token` (Hinflug-Auswahl) on-demand die
 * Buchungs-Anbieter holen. 2 Calls: (1) Rückflüge zu diesem Hinflug → günstigste
 * Kombination (deren booking_token = der angezeigte RT-Preis); (2) Provider zu
 * dieser booking_token. Passiert nur beim Detail-Öffnen, nicht pro Suche.
 */
export async function getSearchApiRoundTripBookingOptions(
  departureToken: string,
  ctx: BookingContext,
): Promise<FlightBookingOption[]> {
  if (!config.SEARCHAPI_API_KEY) return [];
  if (!ctx.origin || !ctx.destination || !ctx.departDate || !ctx.returnDate) return [];

  const key = cacheKey(`rt:${departureToken}`, ctx);
  const cached = readCache(key);
  if (cached) return cached;

  const want = (ctx.currency ?? "EUR").toUpperCase();
  // 1) Rückflüge zu diesem Hinflug.
  const rdata = await saGet({ ...baseParams(ctx), departure_token: departureToken });
  if (!rdata || rdata.error) return [];
  const returns = [...(rdata.best_flights ?? []), ...(rdata.other_flights ?? [])]
    .filter((r) => r.booking_token)
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER));
  const cheapest = returns[0];
  if (!cheapest?.booking_token) return [];

  // 2) Provider zur günstigsten Hin+Rück-Kombination.
  const odata = await saGet({ ...baseParams(ctx), booking_token: cheapest.booking_token });
  if (!odata || odata.error) return [];
  const final = await resolveOptions(odata.booking_options, want);
  writeCache(key, final);
  return final;
}

/** /redirect-Pfad One-way: günstigsten Anbieter-Deeplink auflösen. */
export async function resolveSearchApiBookingUrl(
  bookingToken: string,
  ctx: BookingContext,
): Promise<string | null> {
  const options = await getSearchApiBookingOptions(bookingToken, ctx);
  for (const o of options) if (o.resolvedUrl) return o.resolvedUrl;
  return null;
}

/** /redirect-Pfad Round-Trip: günstigsten Anbieter-Deeplink auflösen. */
export async function resolveSearchApiRoundTripBookingUrl(
  departureToken: string,
  ctx: BookingContext,
): Promise<string | null> {
  const options = await getSearchApiRoundTripBookingOptions(departureToken, ctx);
  for (const o of options) if (o.resolvedUrl) return o.resolvedUrl;
  return null;
}
