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

// Google liefert Zeiten als naive LOKALZEIT am jeweiligen Flughafen — ohne
// Offset/Zeitzone. Wir speichern die Wall-Clock-Komponenten als UTC-ISO und
// markieren die Result-Zone als "UTC", sodass der Client sie via
// formatInTimeZone(.,"UTC") VERBATIM anzeigt (kein Geräte-TZ-Doppel-Offset =
// der gemeldete "+2h"-Bug). „Floating local time": robust für jeden Flughafen
// ohne IATA→IANA-DB, für die Anzeige korrekt (Dauer kommt aus Googles `raw`).
const FLIGHT_TZ = "UTC";

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
    // Travel-Class aus dem Client mappen — Default Economy.
    //   search.class.economy  → ECONOMY
    //   search.class.business → BUSINESS
    //   search.class.first    → FIRST
    let flightClass = "ECONOMY";
    if (input.travelClass === "search.class.business") flightClass = "BUSINESS";
    else if (input.travelClass === "search.class.first") flightClass = "FIRST";
    url.searchParams.set("travel_class", flightClass);
    url.searchParams.set("type", input.returnDate ? "1" : "2");

    // Die google-flights2-API ist STARK nicht-deterministisch: dieselbe Anfrage
    // liefert mal 0, mal das KORREKTE günstige Set (z.B. 8 Flüge, Pegasus 185€ =
    // wie Google), mal ein „Garbage"-Set aus vielen teuren Mehrleg-Combos (z.B.
    // 57 Flüge, Eurowings/SWISS 1502€). NICHT nach Anzahl wählen — das Garbage-Set
    // ist GRÖSSER aber falsch. Stattdessen über bis zu SEARCH_MAX_ATTEMPTS das
    // Ergebnis mit dem GÜNSTIGSTEN Min-Preis behalten (bei ähnlichem Preis gewinnt
    // die längere Liste). So bekommen wir das echte, günstige Google-Set, sobald
    // es in EINEM der Versuche auftaucht. 3 Versuche deckeln die Latenz unter dem
    // 25s-Client-Timeout. Mehr Treffer gibt's on-demand über „Mehr Ergebnisse".
    const SEARCH_MAX_ATTEMPTS = 3;
    const minPrice = (rs: NormalizedResult[]): number => {
      let m = Infinity;
      for (const r of rs) if (r.price > 0 && r.price < m) m = r.price;
      return m;
    };
    let statusCode = 0;
    let raw: unknown = null;
    let best: NormalizedResult[] = [];
    let bestMin = Infinity;

    for (let attempt = 0; attempt < SEARCH_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 400));
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: {
            "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
            "x-rapidapi-host": RAPIDAPI_HOST,
          },
          signal,
        });
      } catch {
        break; // Abbruch (z.B. Signal) → raus
      }
      statusCode = res.status;
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok || !body) continue;
      const parsed = parseGoogleFlights(body, input);
      if (parsed.length === 0) continue;
      const m = minPrice(parsed);
      // Deutlich günstiger (<90 %) = das richtige Set → übernehmen. Ähnlicher
      // Preis (±10 %, gleicher „Modus") → die größere Liste gewinnt. Deutlich
      // teurer → verwerfen (Garbage-Mode).
      const isBetter =
        best.length === 0 ||
        m < bestMin * 0.9 ||
        (m <= bestMin * 1.1 && parsed.length > best.length);
      if (isBetter) {
        best = parsed;
        bestMin = m;
        raw = body;
      }
    }

    return { results: best, raw, statusCode, durationMs: Date.now() - start };
  },
};

interface GfAirport {
  // Echte Felder der google-flights2 API: airport_name + airport_code.
  // Die alten Felder `id`/`name` waren ein Mismatch und liefen leer durch.
  airport_name?: string;
  airport_code?: string;
  time?: string;
  // Legacy-Compat: ältere Wrapper-Versionen hatten id/name. Wir lesen sie
  // als Fallback damit ein Provider-Update uns nicht stillschweigend bricht.
  id?: string;
  name?: string;
  airport?: string;
}

function airportCode(a?: GfAirport): string {
  return a?.airport_code ?? a?.id ?? "";
}
function airportName(a?: GfAirport): string | undefined {
  return a?.airport_name ?? a?.name ?? a?.airport;
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

    const depart = first.departure_airport?.time ? toIso(first.departure_airport.time) : null;
    const arrive = last.arrival_airport?.time ? toIso(last.arrival_airport.time) : null;
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
        origin: airportCode(f.departure_airport),
        destination: airportCode(f.arrival_airport),
        originLabel: airportName(f.departure_airport),
        destLabel: airportName(f.arrival_airport),
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
    // Itineraries ohne Preis NICHT mehr droppen — wir zeigen sie mit Preis=0
    // an, ResultCard rendert dann „Tarif beim Anbieter" statt einer Zahl.
    // Google Flights liefert auf manchen Strecken ein paar Flüge ohne Preis
    // (z.B. Codeshares wo SerpAPI keinen Live-Preis ziehen konnte). Bevor
    // wir die abwerfen, lieber dem User zeigen + Click führt zur Buchungs-
    // seite wo er den Echt-Preis sieht.
    const safePrice = Number.isFinite(priceNum) && priceNum > 0 ? priceNum : 0;

    const token = it.booking_token ?? it.departure_token ?? `${i}`;

    out.push({
      externalId: `gflights:${token}`,
      origin: airportCode(first.departure_airport) || input.origin,
      destination: airportCode(last.arrival_airport) || input.destination,
      originLabel: airportName(first.departure_airport) ?? input.originLabel,
      destLabel: airportName(last.arrival_airport) ?? input.destLabel,
      // "UTC" = die Wall-Clock-Zeiten werden verbatim angezeigt (siehe FLIGHT_TZ).
      originTz: FLIGHT_TZ,
      destinationTz: FLIGHT_TZ,
      departTime: depart,
      arriveTime: arrive,
      durationMinutes,
      stops: Math.max(0, flights.length - 1),
      stopLabels,
      legs: legs.length > 0 ? legs : undefined,
      price: safePrice,
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
  // Naive Lokalzeit "2026-6-23 07:15" (unpadded) oder "2026-06-23T07:15":
  // Wall-Clock-Komponenten als UTC interpretieren (NICHT new Date(), das von
  // der Server-TZ abhängt und das Format inkonsistent parst). Siehe FLIGHT_TZ.
  const m = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!)).toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Best-effort Sprache/Land pro Währung für die Google-Flights-Fallback-URL.
 *  Locale wird serverseitig (noch) nicht durchgereicht, daher leiten wir `hl`
 *  (Sprache) + `gl` (Land) aus der vom User gewählten Währung ab. `curr` ist
 *  immer korrekt (= die App-Währung) — das ist der Teil der den USD-Bug fixt. */
const CURRENCY_LOCALE: Record<string, { hl: string; gl: string }> = {
  EUR: { hl: "de", gl: "DE" },
  USD: { hl: "en", gl: "US" },
  GBP: { hl: "en", gl: "GB" },
  CHF: { hl: "de", gl: "CH" },
  PLN: { hl: "pl", gl: "PL" },
};

/**
 * SerpAPI's `booking_token` ist nur via 2nd-Call-API einlösbar — Google selbst
 * akzeptiert ihn nicht als URL-Parameter. Wir konstruieren stattdessen eine
 * Google-Flights-URL mit Origin/Destination/Datum + Filter auf die spezifische
 * Flugnummer (`tt=o`, `flight=<NR>`), sodass die Suchergebnisseite auf genau
 * diese Verbindung vor-filtert. So wenig "Liste mit mehreren Tickets" wie ohne
 * direkten Airline-API-Zugang machbar ist.
 *
 * WICHTIG: `curr` (Währung) + `hl`/`gl` (Sprache/Land) müssen mit — ohne `curr`
 * rendert Google Flights die Seite in USD (Geo-Default), sodass der User „den
 * gleichen Preis in Dollar" sieht obwohl die App EUR anzeigt. Mit `curr` ist
 * die Fallback-Seite in derselben Währung wie die App-Anzeige.
 */
function buildDeepLink(
  _token: string,
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
