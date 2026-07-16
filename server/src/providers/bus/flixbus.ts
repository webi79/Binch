import { config } from "../../config.js";
import { BoundedTtlCache } from "../../util/boundedCache.js";
import { isoOffset } from "../../util/isoOffset.js";
import { normStationName } from "../../util/stationName.js";
import { resolveMotisPlace } from "../../services/motisPlaces.js";
import { buildShopLink, isoToDmy } from "./flixbusLink.js";
import { searchFlixbusViaRapid } from "./flixbusRapid.js";
import type {
  SearchProvider,
  ProviderSearchInput,
  ProviderResult,
  NormalizedResult,
  LegInfo,
} from "../types.js";

/**
 * FlixBus über FlixBus' EIGENE öffentliche API (global.api.flixbus.com) — die,
 * die auch shop.flixbus.com selbst benutzt. Kein Key, kein Kontingent.
 *
 * Vorher lief das über einen RapidAPI-Wrapper (flixbus2), der dieselbe Quelle
 * weiterreicht — aber verlustbehaftet. Zwei Dinge gingen dabei kaputt:
 *
 * 1. ZEITEN. Der Wrapper schneidet den Zeitzonen-Offset ab:
 *        FlixBus:  "2026-07-15T13:50:00+02:00"
 *        Wrapper:  "2026-07-15T13:50:00.000"
 *    Wir hängten ein „Z" an und behandelten die Ortszeit als UTC. Zusammen mit
 *    dem fehlenden originTz (der alte Code kommentierte „die Timezone-Anzeige
 *    übernimmt der Client via originTz" — gesetzt hat er es nie) rechnete der
 *    Client die Gerätezeit ein ZWEITES Mal drauf: Ein Bus um 13:50 stand in der
 *    App als 15:50. Zwei Stunden daneben — man verpasst den Bus.
 *
 * 2. TRIP-IDENTITÄT. Der Wrapper liefert keine `uid` und keine Stations-IDs,
 *    nur Namen. Die Original-API gibt beides.
 *
 * Was FlixBus NICHT hergibt: einen Deeplink auf eine konkrete Fahrt. Der Shop
 * kennt offiziell nur `departureCity`, `arrivalCity`, `rideDate`, `adult`,
 * `children`, `bike_slot`, `currency`, `_locale` — keinen Trip-Parameter. Ein
 * „direkt zum Ticket"-Link ist damit nicht baubar; wir liefern die exakt
 * vorbelegte Tagessuche (siehe buildShopLink).
 */

const FLIX_API = "https://global.api.flixbus.com";

/** Form beibehalten — `liveLocations.flixbusLiveLocations` hängt daran. */
export interface AutocompleteItem {
  id?: string;
  name?: string;
  city?: { id?: string; name?: string };
  country?: { code?: string; name?: string };
}

export class FlixbusApiError extends Error {
  constructor(
    public statusCode: number,
    public apiMessage: string,
  ) {
    super(`FlixBus API ${statusCode}: ${apiMessage}`);
    this.name = "FlixbusApiError";
  }
}

/** Erkennt Stop-IDs aus ÖPNV-Quellen (HAFAS, GTFS, db-rest, StaDa), für die
 *  FlixBus garantiert keine Trips hat. Solche Searches früh skippen spart einen
 *  Roundtrip + verhindert Phantom-Matches gegen zufällige FlixBus-Städte. */
function looksLikeTransitStopId(code: string | undefined): boolean {
  if (!code) return false;
  if (/^\d{6,9}$/.test(code)) return true;
  if (/^(gtfs|dbrest|sta|airport):/.test(code)) return true;
  return false;
}

interface FlixCity {
  id?: string;
  name?: string;
  country?: string;
  is_flixbus_city?: boolean;
}

/**
 * Städte-Autocomplete. Liefert die Treffer in der Reihenfolge der API (nach
 * deren `score` sortiert) — NICHT umsortieren.
 *
 * Der alte RapidAPI-Pfad sortierte absteigend nach `importance_order`. Das ist
 * kein Score, sondern ein über die Liste abwärts laufender Zähler; Fuzzy-Treffer
 * weiter unten trugen einen globalen Wert von 100 und wurden dadurch nach oben
 * gehievt: „Berlin ZOB" löste auf MANNHEIM ZOB auf, und die Suche Berlin→München
 * zeigte 8 Verbindungen ab Mannheim. Siehe util/stationName.ts.
 */
export async function flixbusAutocomplete(
  query: string,
  signal?: AbortSignal,
): Promise<AutocompleteItem[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const url = new URL(`${FLIX_API}/search/autocomplete/cities`);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("lang", "de");

  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new FlixbusApiError(res.status, await res.text().catch(() => ""));

  const raw = (await res.json().catch(() => null)) as FlixCity[] | null;
  if (!Array.isArray(raw)) return [];

  // Die API liefert CITIES (keine Stationen) → das Item ist selbst die Stadt.
  return raw
    .filter((c) => c.id && c.name)
    .map((c) => ({
      id: c.id,
      name: c.name,
      city: { id: c.id, name: c.name },
      country: { code: c.country },
    }));
}

/**
 * Bounded + TTL statt `new Map()`.
 *
 * Keys sind freie User-Eingaben (unbegrenzter Keyspace) — eine nackte Map wächst
 * für immer. Und eine einmal danebengegriffene Stadt bliebe ewig kleben; genau
 * so ein klebender Fehltreffer wäre der Mannheim-Bug gewesen, wenn er nicht
 * schon beim Auflösen entstanden wäre. 24 h reichen: City-IDs sind stabil.
 */
const cityIdCache = new BoundedTtlCache<string | null>(500, 24 * 60 * 60 * 1000);

/**
 * Notbremse gegen die undokumentierte API.
 *
 * FlixBus' öffentliche API (die ihre eigene Website nutzt) nennt kein Rate-Limit
 * und schickt keine Quota-Header — gedrosselt würde still per AWS-WAF. Gemessen:
 * 30 Anfragen in 3 Wellen à 10 parallel → 30× HTTP 200, kein Drosseln. Das ist
 * KEIN Beweis, dass es kein Limit gibt.
 *
 * Also: Sobald sie uns mit 429/403 abweist, pausieren wir sie für ein paar
 * Minuten, statt weiter dagegen zu laufen. Das schützt uns vor einer härteren
 * Sperre und ist der Gegenseite gegenüber anständig. Die Bus-Suche fällt dabei
 * NICHT aus — motis-bus (offene GTFS-Daten, kein Limit) liefert weiter.
 */
const COOLDOWN_MS = 5 * 60 * 1000;
let blockedUntil = 0;

/**
 * Label → FlixBus-City-ID.
 *
 * Exakter Stadtname gewinnt, sonst der relevanteste Treffer der API. Nötig, weil
 * FlixBus Flughäfen/Vororte als EIGENE Städte führt: Für „Berlin" steht
 * „Berlin (Flughafen)" mit an, und wer darauf landet, sieht nur
 * Flughafen-Abfahrten und den ZOB gar nicht.
 */
async function resolveFlixCityId(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(code)) return code;

  const candidates = [label, code].filter((x): x is string => !!x);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    const cached = cityIdCache.get(key);
    if (cached !== undefined) {
      if (cached) return cached;
      continue;
    }

    const hits = await flixbusAutocomplete(candidate, signal);
    if (hits.length === 0) {
      cityIdCache.set(key, null);
      continue;
    }

    const wanted = normStationName(candidate);
    const exact = hits.find((h) => h.name && normStationName(h.name) === wanted);
    const id = (exact ?? hits[0])?.id ?? null;
    cityIdCache.set(key, id);
    if (id) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Such-Response von global.api.flixbus.com/search/service/v4/search
// ---------------------------------------------------------------------------

interface FlixPoint {
  /** ISO MIT Offset — "2026-07-15T13:50:00+02:00". Der Grund für den Umbau. */
  date?: string;
  city_id?: string;
  station_id?: string;
}

interface FlixLeg {
  ride_id?: string;
  departure?: FlixPoint;
  arrival?: FlixPoint;
  operator_id?: string;
}

interface FlixTrip {
  uid?: string;
  status?: string;
  departure?: FlixPoint;
  arrival?: FlixPoint;
  price?: { total?: number; total_with_platform_fee?: number };
  legs?: FlixLeg[];
}

interface FlixSearchResponse {
  trips?: Array<{ results?: Record<string, FlixTrip> }>;
  stations?: Record<string, { id?: string; name?: string }>;
}

interface FlixFetch {
  ok: boolean;
  raw: unknown;
  statusCode: number;
}

async function fetchFlixTrips(
  fromCityId: string,
  toCityId: string,
  isoDate: string,
  input: ProviderSearchInput,
  signal?: AbortSignal,
): Promise<FlixFetch> {
  const url = new URL(`${FLIX_API}/search/service/v4/search`);
  url.searchParams.set("from_city_id", fromCityId);
  url.searchParams.set("to_city_id", toCityId);
  url.searchParams.set("departure_date", isoToDmy(isoDate));
  url.searchParams.set("products", JSON.stringify({ adult: input.passengers }));
  url.searchParams.set("currency", input.currency);
  url.searchParams.set("locale", "de");
  url.searchParams.set("search_by", "cities");
  url.searchParams.set("include_after_midnight_rides", "1");

  const res = await fetch(url, { headers: { accept: "application/json" }, signal });
  const raw = (await res.json().catch(() => null)) as unknown;
  return { ok: res.ok && raw !== null, raw, statusCode: res.status };
}

export const flixbusProvider: SearchProvider = {
  name: "flixbus",
  mode: "BUS",

  // Kein Key nötig — FlixBus' eigene API ist offen. Auch während eines Cooldowns
  // bleiben wir aktiv: dann übernimmt der RapidAPI-Notfallpfad (siehe search()).
  isConfigured() {
    return true;
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();

    if (looksLikeTransitStopId(input.origin) || looksLikeTransitStopId(input.destination)) {
      return {
        results: [],
        raw: { skipped: "transit_stop_id", origin: input.origin, destination: input.destination },
        statusCode: 0,
        durationMs: Date.now() - start,
      };
    }

    // Zeitzonen der Endpunkte — dieselbe geteilte Auflösung wie beim Zug-Provider
    // (24h-Cache). Ohne sie rendert der Client die UTC-Zeit in der GERÄTE-Zone;
    // für einen Bus in Spanien wäre das schlicht falsch. BEIDE Pfade brauchen sie:
    // der Notfallpfad muss aus der Ortszeit des Wrappers erst korrektes UTC
    // rechnen (siehe flixbusRapid.ts).
    const [fromPlace, toPlace] = await Promise.all([
      resolveMotisPlace(input.origin, input.originLabel, signal).catch(() => null),
      resolveMotisPlace(input.destination, input.destLabel, signal).catch(() => null),
    ]);
    const tz = { origin: fromPlace?.tz, destination: toPlace?.tz };

    /** Notfallpfad: bezahlter RapidAPI-Zugang mit bekanntem Kontingent. */
    const fallback = async (reason: string): Promise<ProviderResult> => {
      const results = await searchFlixbusViaRapid(input, tz, signal);
      if (!results) {
        return {
          results: [],
          raw: { error: "flixbus_unavailable", reason },
          statusCode: 0,
          durationMs: Date.now() - start,
        };
      }
      return {
        results,
        raw: { source: "rapidapi_fallback", reason, count: results.length },
        statusCode: 200,
        durationMs: Date.now() - start,
      };
    };

    // Sperrt uns die offene API gerade aus? Dann gar nicht erst anklopfen.
    if (Date.now() < blockedUntil) return fallback("cooldown");

    let fromId: string | null;
    let toId: string | null;
    let outbound: FlixFetch;
    let returnLeg: FlixFetch | null;
    try {
      // PARALLEL: unabhängige Autocomplete-Calls (~0,3-1 s je Cache-Miss) —
      // sequenziell zahlte jede unkachierte Suche beide nacheinander.
      [fromId, toId] = await Promise.all([
        resolveFlixCityId(input.origin, input.originLabel, signal),
        resolveFlixCityId(input.destination, input.destLabel, signal),
      ]);
      if (!fromId || !toId) {
        return {
          results: [],
          raw: { skipped: "could not resolve flixbus city", origin: input.origin, destination: input.destination },
          statusCode: 0,
          durationMs: Date.now() - start,
        };
      }

      [outbound, returnLeg] = await Promise.all([
        fetchFlixTrips(fromId, toId, input.departDate, input, signal),
        input.returnDate
          ? fetchFlixTrips(toId, fromId, input.returnDate, input, signal)
          : Promise.resolve(null),
      ]);
    } catch (e) {
      // JEDER Fehler führt auf den Notfallpfad, nicht nur ein HTTP-Status.
      // Vorher fingen wir hier nur FlixbusApiError ab — ein Netzwerkfehler (DNS,
      // Timeout, Verbindungsabbruch) lässt `fetch` aber WERFEN, flog also durch
      // und riss den Provider mit, statt umzuschalten. Im Test mit unerreichbarem
      // Host sprang der Fallback deshalb nicht an. Genau dann braucht man ihn.
      if (e instanceof FlixbusApiError) noteRateLimit(e.statusCode);
      return fallback(e instanceof Error ? e.message : "unknown error");
    }
    const durationMs = Date.now() - start;

    // NUR bei einem FEHLER auf den Notfallpfad. Eine LEERE Antwort ist kein
    // Fehler: Beide Wege fragen dieselbe Quelle — wenn die offene API sagt „auf
    // dieser Strecke fährt nichts", würde RapidAPI dasselbe sagen und wir hätten
    // einen Call aus dem Kontingent für nichts verbrannt.
    if (!outbound.ok) {
      noteRateLimit(outbound.statusCode);
      return fallback(`trips ${outbound.statusCode}`);
    }

    const outboundResults = parseTrips(outbound.raw, input, tz, {
      fromCityId: fromId,
      toCityId: toId,
      rideDate: input.departDate,
    }).map((r) => ({ ...r, direction: "OUTBOUND" as const }));

    let returnResults: NormalizedResult[] = [];
    if (returnLeg?.ok && input.returnDate) {
      returnResults = parseTrips(
        returnLeg.raw,
        {
          ...input,
          origin: input.destination,
          destination: input.origin,
          originLabel: input.destLabel,
          destLabel: input.originLabel,
        },
        // Rückfahrt → Zonen tauschen.
        { origin: tz.destination, destination: tz.origin },
        { fromCityId: toId, toCityId: fromId, rideDate: input.returnDate },
      ).map((r) => ({ ...r, direction: "RETURN" as const }));
    }

    return {
      results: [...outboundResults, ...returnResults],
      raw: returnLeg ? { outbound: outbound.raw, return: returnLeg.raw } : outbound.raw,
      statusCode: outbound.statusCode,
      durationMs,
    };
  },
};

/** 429/403 → FlixBus für COOLDOWN_MS pausieren (siehe blockedUntil oben). */
function noteRateLimit(statusCode: number): void {
  if (statusCode === 429 || statusCode === 403) {
    blockedUntil = Date.now() + COOLDOWN_MS;
  }
}

interface LinkContext {
  fromCityId: string;
  toCityId: string;
  rideDate: string;
}

function parseTrips(
  raw: unknown,
  input: ProviderSearchInput,
  tz: { origin?: string; destination?: string },
  link: LinkContext,
): NormalizedResult[] {
  const r = raw as FlixSearchResponse;
  const stations = r.stations ?? {};
  const stationName = (id?: string) => (id ? stations[id]?.name : undefined);

  const out: NormalizedResult[] = [];
  const deepLink = buildShopLink({
    fromCityId: link.fromCityId,
    toCityId: link.toCityId,
    rideDate: link.rideDate,
    passengers: input.passengers,
    currency: input.currency,
  });

  for (const group of r.trips ?? []) {
    for (const trip of Object.values(group.results ?? {})) {
      // Die Zeiten tragen ihren Offset → new Date() liefert direkt korrektes UTC.
      const depart = toIso(trip.departure?.date);
      const arrive = toIso(trip.arrival?.date);
      if (!depart || !arrive) continue;

      // Nicht buchbare Fahrten (ausverkauft, storniert) gehören nicht in die Liste.
      if (trip.status && trip.status !== "available") continue;

      const price = trip.price?.total;
      if (typeof price !== "number" || price <= 0) continue;

      const legs: LegInfo[] = [];
      for (const leg of trip.legs ?? []) {
        const legDep = toIso(leg.departure?.date);
        const legArr = toIso(leg.arrival?.date);
        if (!legDep || !legArr) continue;
        legs.push({
          origin: leg.departure?.station_id ?? "",
          destination: leg.arrival?.station_id ?? "",
          originLabel: stationName(leg.departure?.station_id),
          destLabel: stationName(leg.arrival?.station_id),
          departTime: legDep,
          arriveTime: legArr,
          // Zone dieses Halts aus dem Offset — FlixBus' Stations-Dictionary
          // führt keine Zeitzone, die Zeitstempel tragen sie aber.
          originTz: isoOffset(leg.departure?.date),
          destTz: isoOffset(leg.arrival?.date),
          durationMinutes: Math.max(1, Math.round((Date.parse(legArr) - Date.parse(legDep)) / 60_000)),
          // Die Original-API führt keine Liniennummern (der RapidAPI-Wrapper
          // erfand „FlixBus N951" aus internen Feldern). Marke statt Fantasie.
          line: "FlixBus",
          product: "bus",
          stops: 0,
        });
      }

      // Umstiege = Fahrten minus 1. Bei Direktverbindungen liefert die API
      // manchmal legs: [] → dann 0.
      const stops = Math.max(0, legs.length - 1);
      const stopLabels = legs.slice(0, -1).map((l) => l.destLabel ?? "").filter(Boolean);

      out.push({
        externalId: `flixbus:${trip.uid ?? `${depart}:${price}`}`,
        origin: input.origin,
        destination: input.destination,
        originLabel: stationName(trip.departure?.station_id) ?? input.originLabel ?? input.origin,
        destLabel: stationName(trip.arrival?.station_id) ?? input.destLabel ?? input.destination,
        departTime: depart,
        arriveTime: arrive,
        originTz: tz.origin,
        destinationTz: tz.destination,
        durationMinutes: Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60_000)),
        stops,
        stopLabels,
        legs: legs.length > 0 ? legs : undefined,
        // `total` ist der Preis, den der Shop in der Trefferliste zeigt — genau
        // das sieht der User nach dem Klick. (`total_with_platform_fee` kommt
        // dort erst an der Kasse dazu; hier stünde sonst eine andere Zahl als
        // auf der Zielseite.)
        price,
        currency: input.currency,
        deepLink,
        operatedBy: "FlixBus",
        providerLogo: "https://logos.flixbus.com/flixbus.png",
      });
    }
  }
  return out;
}

/** ISO mit Offset → ISO-UTC. */
function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}


