import { config } from "../../config.js";
import type {
  SearchProvider,
  ProviderSearchInput,
  ProviderResult,
  NormalizedResult,
  LegInfo,
} from "../types.js";

// SearchAPI.io — Google-Flights-Scraper in Profi-Qualität. Primärer Flug-Provider:
// volle Provider-Listen (10-25 statt google-flights2 „manchmal 2/oft leer") + die
// günstigen Tarife, die google-flights2 droppt. google-flights2 bleibt als
// Fallback in der Registry, falls SearchAPI mal 0 Treffer liefert.
const SEARCH_URL = `${config.SEARCHAPI_BASE_URL}/api/v1/search`;

// Wie bei google-flights2: SearchAPI liefert Zeiten als naive LOKALZEIT am
// jeweiligen Flughafen (getrennt als date + time, ohne Offset). Wir speichern die
// Wall-Clock-Komponenten als UTC-ISO und markieren die Zone als "UTC" → der Client
// zeigt sie via formatInTimeZone(.,"UTC") VERBATIM an (kein Geräte-TZ-Doppel-Offset).
const FLIGHT_TZ = "UTC";

/**
 * Kontingent-Sperre. SearchAPI drosselt MONATLICH: Ist das Kontingent
 * aufgebraucht, kommt auf jeden Call ein 429 („You have used all of the
 * searches for the month"). Der lief hier still als „0 Treffer, kein Fehler"
 * durch — 32 Calls in einer Woche, alle leer, nie aufgefallen. Jede Flugsuche
 * verbrannte damit erst einen sinnlosen SearchAPI-Call und fiel DANN auf den
 * langsamen google-flights-Fallback (8-15 s) zurück.
 *
 * Nach einem 429 melden wir uns deshalb für eine Weile als unkonfiguriert →
 * die Registry überspringt uns, der Fallback startet sofort. 6 h statt
 * „bis Monatsende", damit ein Plan-Upgrade/Reset ohne Neustart wieder greift.
 */
const QUOTA_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let quotaBlockedUntil = 0;

export const searchApiFlightsProvider: SearchProvider = {
  name: "searchapi-flights",
  mode: "FLIGHT",

  isConfigured() {
    return Boolean(config.SEARCHAPI_API_KEY) && Date.now() >= quotaBlockedUntil;
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    // Round-Trip: SearchAPI nutzt einen 2-Schritt-Flow — Call 1 (hier) liefert
    // HINFLUG-Optionen, priced auf den Round-Trip-GESAMTpreis, mit einem
    // `departure_token`. Der zweite Schritt (Rückflüge wählen → Provider/Deeplink)
    // passiert erst on-demand beim Detail-Öffnen (siehe searchApiFlightsBooking).
    // Die SUCHE ist also auch bei Round-Trip nur EIN Call. One-way liefert direkt
    // `booking_token`. (Genau dasselbe Hinflug-only-Verhalten wie google-flights2.)
    const roundTrip = Boolean(input.returnDate);

    const loc = CURRENCY_LOCALE[input.currency.toUpperCase()] ?? { hl: "en", gl: "US" };
    const url = new URL(SEARCH_URL);
    url.searchParams.set("engine", "google_flights");
    url.searchParams.set("departure_id", input.origin);
    url.searchParams.set("arrival_id", input.destination);
    url.searchParams.set("outbound_date", input.departDate);
    url.searchParams.set("flight_type", roundTrip ? "round_trip" : "one_way");
    if (input.returnDate) url.searchParams.set("return_date", input.returnDate);
    url.searchParams.set("adults", String(input.passengers));
    url.searchParams.set("currency", input.currency.toUpperCase());
    url.searchParams.set("hl", loc.hl);
    url.searchParams.set("gl", loc.gl.toLowerCase());
    // Travel-Class aus dem Client mappen — Default Economy (SearchAPI nimmt
    // Kleinbuchstaben-Strings: economy / business / first).
    let flightClass = "economy";
    if (input.travelClass === "search.class.business") flightClass = "business";
    else if (input.travelClass === "search.class.first") flightClass = "first";
    url.searchParams.set("travel_class", flightClass);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.SEARCHAPI_API_KEY ?? ""}` },
        signal,
      });
    } catch {
      return { results: [], raw: { error: "fetch failed" }, statusCode: 0, durationMs: Date.now() - start };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (res.status === 429) {
      quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.warn(
        `[searchapi-flights] 429 — Monatskontingent aufgebraucht. Provider pausiert bis ${new Date(quotaBlockedUntil).toISOString()}; Flüge laufen solange über den Fallback (google-flights).`,
      );
    }
    const results = res.ok && body ? parseSearchApi(body, input, roundTrip) : [];
    return { results, raw: body, statusCode: res.status, durationMs: Date.now() - start };
  },
};

interface SaAirport {
  name?: string;
  id?: string;
  date?: string;
  time?: string;
}

interface SaFlight {
  departure_airport?: SaAirport;
  arrival_airport?: SaAirport;
  duration?: number;
  airline?: string;
  airline_logo?: string;
  flight_number?: string;
  travel_class?: string;
}

interface SaItinerary {
  flights?: SaFlight[];
  layovers?: { duration?: number; name?: string; id?: string }[];
  total_duration?: number;
  price?: number;
  type?: string;
  airline_logo?: string;
  booking_token?: string;
  departure_token?: string;
}

interface SaResponse {
  best_flights?: SaItinerary[];
  other_flights?: SaItinerary[];
  error?: string;
}

/** SearchAPI liefert Datum + Zeit getrennt pro Airport ("2026-07-15" + "10:55").
 *  Zusammenfügen zu "2026-07-15 10:55" für toIso (Floating-UTC, s.o.). */
function airportIso(a?: SaAirport): string | null {
  if (!a?.date || !a?.time) return null;
  return toIso(`${a.date} ${a.time}`);
}

function parseSearchApi(
  raw: unknown,
  input: ProviderSearchInput,
  roundTrip: boolean,
): NormalizedResult[] {
  const r = raw as SaResponse;
  if (r.error) return [];
  const buckets: SaItinerary[] = [...(r.best_flights ?? []), ...(r.other_flights ?? [])];

  const out: NormalizedResult[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const it = buckets[i];
    if (!it) continue;
    const flights = it.flights ?? [];
    const first = flights[0];
    const last = flights[flights.length - 1];
    if (!first || !last) continue;

    const depart = airportIso(first.departure_airport);
    const arrive = airportIso(last.arrival_airport);
    if (!depart || !arrive) continue;

    const durationMinutes =
      typeof it.total_duration === "number"
        ? it.total_duration
        : Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60000));

    const stopLabels = (it.layovers ?? []).map((l) => l.name ?? l.id ?? "").filter(Boolean);

    const legs: LegInfo[] = [];
    for (const f of flights) {
      const fDep = airportIso(f.departure_airport);
      const fArr = airportIso(f.arrival_airport);
      if (!fDep || !fArr) continue;
      const fDuration =
        typeof f.duration === "number"
          ? f.duration
          : Math.max(1, Math.round((Date.parse(fArr) - Date.parse(fDep)) / 60000));
      legs.push({
        origin: f.departure_airport?.id ?? "",
        destination: f.arrival_airport?.id ?? "",
        originLabel: f.departure_airport?.name,
        destLabel: f.arrival_airport?.name,
        departTime: fDep,
        arriveTime: fArr,
        durationMinutes: fDuration,
        line: f.flight_number,
        product: "flight",
        fahrtNr: f.flight_number,
        direction: f.airline,
      });
    }

    const price = typeof it.price === "number" && it.price > 0 ? it.price : 0;
    // One-way: booking_token (direkt buchbar). Round-Trip: departure_token (Hin-
    // flug-Auswahl → der Booking-Pfad holt damit die Rückflüge + Provider). Das
    // "sapi:" / "sapi-rt:"-Präfix steuert den Dispatcher (flightBookingDispatch).
    const token = roundTrip ? (it.departure_token ?? "") : (it.booking_token ?? "");
    const prefix = roundTrip ? "sapi-rt:" : "sapi:";

    out.push({
      externalId: `sapiflights:${token || `${i}:${first.flight_number ?? ""}`}`,
      origin: first.departure_airport?.id ?? input.origin,
      destination: last.arrival_airport?.id ?? input.destination,
      originLabel: first.departure_airport?.name ?? input.originLabel,
      destLabel: last.arrival_airport?.name ?? input.destLabel,
      originTz: FLIGHT_TZ,
      destinationTz: FLIGHT_TZ,
      departTime: depart,
      arriveTime: arrive,
      durationMinutes,
      stops: Math.max(0, flights.length - 1),
      stopLabels,
      legs: legs.length > 0 ? legs : undefined,
      price,
      currency: input.currency,
      deepLink: buildDeepLink(input, depart, first.flight_number),
      // Präfix markiert den Token für den Dispatcher: "sapi:" = One-way-
      // booking_token, "sapi-rt:" = Round-Trip-departure_token. Wird vor dem
      // API-Call wieder abgestreift.
      bookingToken: token ? `${prefix}${token}` : undefined,
      flightNumber: first.flight_number,
      operatedBy: first.airline,
      providerLogo: first.airline_logo,
    });
  }
  return out;
}

function toIso(value?: string): string | null {
  if (!value) return null;
  // Naive Lokalzeit "2026-7-15 10:55" → Wall-Clock-Komponenten als UTC
  // interpretieren (NICHT new Date(), das von der Server-TZ abhängt). Siehe FLIGHT_TZ.
  const m = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Best-effort Sprache/Land pro Währung — für `hl`/`gl` (lokalisierte Anbieter-
 *  Deeplinks + Google-Flights-Fallback-URL) und `curr`. */
const CURRENCY_LOCALE: Record<string, { hl: string; gl: string }> = {
  EUR: { hl: "de", gl: "DE" },
  USD: { hl: "en", gl: "US" },
  GBP: { hl: "en", gl: "GB" },
  CHF: { hl: "de", gl: "CH" },
  PLN: { hl: "pl", gl: "PL" },
};

/** Google-Flights-Fallback-URL (vor-gefiltert auf Flugnummer). Wird als
 *  `deepLink` gesetzt; greift nur, falls die booking_options-Auflösung leer ist. */
function buildDeepLink(
  input: ProviderSearchInput,
  departIso: string | null,
  flightNumber?: string,
): string {
  const curr = (input.currency || "EUR").toUpperCase();
  const loc = CURRENCY_LOCALE[curr] ?? { hl: "en", gl: "US" };
  const params = new URLSearchParams({
    f: input.origin,
    t: input.destination,
    d: input.departDate,
    tt: "o",
    curr,
    hl: loc.hl,
    gl: loc.gl,
  });
  if (flightNumber) params.set("flight", flightNumber.replace(/\s+/g, ""));
  if (departIso) {
    const m = departIso.match(/T(\d{2}):(\d{2})/);
    if (m) params.set("dt", `${m[1]}:${m[2]}`);
  }
  return `https://www.google.com/travel/flights?${params.toString()}`;
}
