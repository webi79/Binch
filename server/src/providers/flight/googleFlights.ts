import { config } from "../../config.js";
import type {
  SearchProvider,
  ProviderSearchInput,
  ProviderResult,
  NormalizedResult,
  LegInfo,
} from "../types.js";

const RAPIDAPI_HOST = "google-flights2.p.rapidapi.com";
const SEARCH_URL = `https://${RAPIDAPI_HOST}/api/v1/searchFlights`;

export const googleFlightsProvider: SearchProvider = {
  name: "google-flights",
  mode: "FLIGHT",

  isConfigured() {
    return Boolean(config.RAPIDAPI_KEY);
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no token" }, statusCode: 0, durationMs: 0 };
    }

    const url = new URL(SEARCH_URL);
    url.searchParams.set("departure_id", input.origin);
    url.searchParams.set("arrival_id", input.destination);
    url.searchParams.set("outbound_date", input.departDate);
    if (input.returnDate) url.searchParams.set("return_date", input.returnDate);
    url.searchParams.set("adults", String(input.passengers));
    url.searchParams.set("currency", input.currency);
    url.searchParams.set("travel_class", "ECONOMY");
    url.searchParams.set("type", input.returnDate ? "1" : "2");

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
      signal,
    });

    const statusCode = res.status;
    const raw = (await res.json().catch(() => null)) as unknown;
    const durationMs = Date.now() - start;

    if (!res.ok || !raw) {
      return { results: [], raw, statusCode, durationMs };
    }

    return {
      results: parseGoogleFlights(raw, input),
      raw,
      statusCode,
      durationMs,
    };
  },
};

interface GfAirport {
  id?: string;
  name?: string;
  time?: string;
  airport?: string;
  airport_code?: string;
}

interface GfFlight {
  departure_airport?: GfAirport;
  arrival_airport?: GfAirport;
  duration?: number;
  airline?: string;
  airline_logo?: string;
  flight_number?: string;
  travel_class?: string;
}

interface GfItinerary {
  flights?: GfFlight[];
  layovers?: { id?: string; name?: string }[];
  duration?: { raw?: number; text?: string } | number;
  price?: number | string;
  booking_token?: string;
  departure_token?: string;
}

interface GfResponse {
  status?: boolean;
  data?: {
    itineraries?: { topFlights?: GfItinerary[]; otherFlights?: GfItinerary[] };
    topFlights?: GfItinerary[];
    otherFlights?: GfItinerary[];
  };
  itineraries?: GfItinerary[];
}

function parseGoogleFlights(raw: unknown, input: ProviderSearchInput): NormalizedResult[] {
  const r = raw as GfResponse;
  const buckets: GfItinerary[] = [];
  if (r.data?.itineraries?.topFlights) buckets.push(...r.data.itineraries.topFlights);
  if (r.data?.itineraries?.otherFlights) buckets.push(...r.data.itineraries.otherFlights);
  if (r.data?.topFlights) buckets.push(...r.data.topFlights);
  if (r.data?.otherFlights) buckets.push(...r.data.otherFlights);
  if (r.itineraries) buckets.push(...r.itineraries);

  const out: NormalizedResult[] = [];
  for (let i = 0; i < buckets.length; i++) {
    const it = buckets[i];
    if (!it) continue;
    const flights = it.flights ?? [];
    const first = flights[0];
    const last = flights[flights.length - 1];
    if (!first || !last) continue;

    const depart =
      first.departure_airport?.time ?? first.departure_airport?.id ? toIso(first.departure_airport?.time) : null;
    const arrive = last.arrival_airport?.time ? toIso(last.arrival_airport?.time) : null;
    if (!depart || !arrive) continue;

    const durationMinutes =
      typeof it.duration === "number"
        ? it.duration
        : typeof it.duration === "object" && typeof it.duration?.raw === "number"
          ? it.duration.raw
          : Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60000));

    const stopLabels = (it.layovers ?? []).map((l) => l.name ?? l.id ?? "").filter(Boolean);

    const legs: LegInfo[] = [];
    for (const f of flights) {
      const fDep = toIso(f.departure_airport?.time);
      const fArr = toIso(f.arrival_airport?.time);
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

    const priceNum =
      typeof it.price === "number"
        ? it.price
        : typeof it.price === "string"
          ? Number(it.price.replace(/[^\d.]/g, ""))
          : Number.NaN;
    if (!Number.isFinite(priceNum) || priceNum <= 0) continue;

    const token = it.booking_token ?? it.departure_token ?? `${i}`;

    out.push({
      externalId: `gflights:${token}`,
      origin: first.departure_airport?.id ?? input.origin,
      destination: last.arrival_airport?.id ?? input.destination,
      originLabel: first.departure_airport?.name ?? input.originLabel,
      destLabel: last.arrival_airport?.name ?? input.destLabel,
      departTime: depart,
      arriveTime: arrive,
      durationMinutes,
      stops: Math.max(0, flights.length - 1),
      stopLabels,
      legs: legs.length > 0 ? legs : undefined,
      price: priceNum,
      currency: input.currency,
      deepLink: buildDeepLink(token, input, depart, first.flight_number),
      bookingToken: it.booking_token ?? undefined,
      flightNumber: first.flight_number,
      operatedBy: first.airline,
      providerLogo: first.airline_logo,
    });
  }
  return out;
}

function toIso(value?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * SerpAPI's `booking_token` ist nur via 2nd-Call-API einlösbar — Google selbst
 * akzeptiert ihn nicht als URL-Parameter. Wir konstruieren stattdessen eine
 * Google-Flights-URL mit Origin/Destination/Datum + Filter auf die spezifische
 * Flugnummer (`tt=o`, `flight=<NR>`), sodass die Suchergebnisseite auf genau
 * diese Verbindung vor-filtert. So wenig "Liste mit mehreren Tickets" wie ohne
 * direkten Airline-API-Zugang machbar ist.
 */
function buildDeepLink(
  _token: string,
  input: ProviderSearchInput,
  departIso: string | null,
  flightNumber?: string,
): string {
  const params = new URLSearchParams({
    f: input.origin,
    t: input.destination,
    d: input.departDate,
    tt: "o",
  });
  if (flightNumber) params.set("flight", flightNumber.replace(/\s+/g, ""));
  if (departIso) {
    const m = departIso.match(/T(\d{2}):(\d{2})/);
    if (m) params.set("dt", `${m[1]}:${m[2]}`);
  }
  return `https://www.google.com/travel/flights?${params.toString()}`;
}
