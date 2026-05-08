import { config } from "../../config.js";
import type {
  SearchProvider,
  ProviderSearchInput,
  ProviderResult,
  NormalizedResult,
  LegInfo,
  StopoverInfo,
} from "../types.js";

// FlixBus über RapidAPI (flixbus2-Variante).
// Spec siehe RapidAPI: https://rapidapi.com/.../flixbus2
//   - /autocomplete?query=...               → Stationen + Cities suchen
//   - /search-trips?from_id=...&to_id=...   → Trips abrufen (Datum DD.MM.YYYY)
//
// Wenn ihr später einen direkten Affiliate-Vertrag (Awin/FlixBus) habt:
// search() austauschen, der Rest des Codes (DB-Caching, Redirect-Tokens,
// Aggregation in searchService.ts) bleibt unverändert.

export interface AutocompleteItem {
  id?: string;
  legacy_id?: number | string;
  name?: string;
  is_train?: boolean;
  importance_order?: number;
  score?: number;
  city?: { id?: string; legacy_id?: number | string; name?: string };
  country?: { code?: string; name?: string };
  zipcode?: string;
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

/**
 * Ruft FlixBus-Autocomplete für eine Suchanfrage auf. Liefert die Roh-Liste
 * (Stations + Cities) sortiert nach Bus-Vorrang und Importance.
 *
 * Wirft `FlixbusApiError` bei Quota-Überschreitung / API-Fehlern, damit der
 * Aufrufer das in DB / Logs sichtbar macht statt stillschweigend [] zurückzugeben.
 */
export async function flixbusAutocomplete(
  query: string,
  signal?: AbortSignal,
): Promise<AutocompleteItem[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1 || !config.RAPIDAPI_KEY) return [];

  const url = new URL(`https://${config.FLIXBUS_RAPIDAPI_HOST}/autocomplete`);
  url.searchParams.set("query", trimmed);

  const res = await fetch(url, { headers: rapidHeaders(), signal });
  const raw = (await res.json().catch(() => null)) as unknown;

  // RapidAPI signalisiert Quota / Plan-Probleme als 200/429 mit { message: "..." }.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "message" in raw) {
    const msg = String((raw as { message?: unknown }).message ?? "");
    if (msg) throw new FlixbusApiError(res.status, msg);
  }
  if (!res.ok) {
    throw new FlixbusApiError(res.status, JSON.stringify(raw).slice(0, 300));
  }

  const list: AutocompleteItem[] = Array.isArray(raw)
    ? (raw as AutocompleteItem[])
    : ((raw as { cities?: AutocompleteItem[]; data?: AutocompleteItem[]; results?: AutocompleteItem[] })
        ?.cities ??
        (raw as { data?: AutocompleteItem[] })?.data ??
        (raw as { results?: AutocompleteItem[] })?.results ??
        []);

  return [...list].sort((a, b) => {
    if (a.is_train !== b.is_train) return a.is_train ? 1 : -1;
    return (b.importance_order ?? b.score ?? 0) - (a.importance_order ?? a.score ?? 0);
  });
}

interface FxFare {
  price?: number;
  currency?: string;
  additional_info?: string;
}

interface FxSegment {
  dep_offset?: string;
  arr_offset?: string;
  dep_name?: string;
  arr_name?: string;
  dep_id?: string;
  arr_id?: string;
  intermediate_stop?: { name?: string; arr_offset?: string; dep_offset?: string }[];
  product_type?: string;
  product?: string;
  line?: string;
  line_code?: string;
  direction?: string;
}

interface FxJourney {
  dep_offset?: string;
  arr_offset?: string;
  dep_name?: string;
  arr_name?: string;
  duration?: string;
  changeovers?: number;
  segments?: FxSegment[];
  deeplink?: string;
  fares?: FxFare[];
}

interface FxSearchResponse {
  headers?: { response_id?: number };
  journeys?: FxJourney[];
}

const cityIdCache = new Map<string, { cityId: string; stationId: string | null }>();

export const flixbusProvider: SearchProvider = {
  name: "flixbus",
  mode: "BUS",

  isConfigured() {
    return Boolean(config.RAPIDAPI_KEY);
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { results: [], raw: { skipped: "no rapidapi key" }, statusCode: 0, durationMs: 0 };
    }

    let fromId: string | null;
    let toId: string | null;
    try {
      fromId = await resolveFlixId(input.origin, input.originLabel, signal);
      toId = await resolveFlixId(input.destination, input.destLabel, signal);
    } catch (e) {
      if (e instanceof FlixbusApiError) {
        return {
          results: [],
          raw: { error: "flixbus_api_error", message: e.apiMessage, statusCode: e.statusCode },
          statusCode: e.statusCode,
          durationMs: Date.now() - start,
        };
      }
      throw e;
    }
    if (!fromId || !toId) {
      return {
        results: [],
        raw: {
          skipped: "could not resolve flixbus id",
          origin: input.origin,
          destination: input.destination,
        },
        statusCode: 0,
        durationMs: Date.now() - start,
      };
    }

    const url = new URL(`https://${config.FLIXBUS_RAPIDAPI_HOST}/trips`);
    url.searchParams.set("from_id", fromId);
    url.searchParams.set("to_id", toId);
    url.searchParams.set("date", isoToDmy(input.departDate));
    url.searchParams.set("time", "00:00");
    url.searchParams.set("adult", String(input.passengers));
    url.searchParams.set("search_by", "cities");
    url.searchParams.set("currency", input.currency);

    const res = await fetch(url, {
      headers: rapidHeaders(),
      signal,
    });
    const statusCode = res.status;
    const raw = (await res.json().catch(() => null)) as unknown;
    const durationMs = Date.now() - start;

    if (!res.ok || !raw) {
      return { results: [], raw, statusCode, durationMs };
    }

    return {
      results: parseFlixJourneys(raw, input),
      raw,
      statusCode,
      durationMs,
    };
  },
};

function rapidHeaders(): Record<string, string> {
  return {
    "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
    "x-rapidapi-host": config.FLIXBUS_RAPIDAPI_HOST,
  };
}

async function resolveFlixId(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  // Wenn der Input bereits wie eine UUID aussieht, direkt verwenden.
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(code)) return code;

  const candidates = [label, code].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    const cached = cityIdCache.get(key);
    if (cached) return cached.cityId;

    const sorted = await flixbusAutocomplete(candidate, signal);
    if (sorted.length === 0) continue;
    const first = sorted[0];
    const cityId = first?.city?.id ?? first?.id;
    if (cityId) {
      cityIdCache.set(key, { cityId, stationId: first?.id ?? null });
      return cityId;
    }
  }
  return null;
}

function parseFlixJourneys(raw: unknown, input: ProviderSearchInput): NormalizedResult[] {
  const r = raw as FxSearchResponse;
  const journeys = r.journeys ?? [];

  const out: NormalizedResult[] = [];
  for (let i = 0; i < journeys.length; i++) {
    const j = journeys[i];
    if (!j) continue;

    const depart = parseLocalIso(j.dep_offset);
    const arrive = parseLocalIso(j.arr_offset);
    if (!depart || !arrive) continue;

    const durationMinutes = parseHmDuration(j.duration, depart, arrive);

    const fare = j.fares?.[0];
    const price = typeof fare?.price === "number" ? fare.price : Number.NaN;
    if (!Number.isFinite(price) || price <= 0) continue;

    const stops = typeof j.changeovers === "number" ? j.changeovers : 0;
    const stopLabels: string[] = [];
    if (j.segments && j.segments.length > 1) {
      for (let s = 0; s < j.segments.length - 1; s++) {
        const seg = j.segments[s];
        if (seg?.arr_name) stopLabels.push(seg.arr_name);
      }
    }

    const legs: LegInfo[] = [];
    for (const seg of j.segments ?? []) {
      const segDep = parseLocalIso(seg.dep_offset);
      const segArr = parseLocalIso(seg.arr_offset);
      if (!segDep || !segArr) continue;
      const segDuration = Math.max(
        1,
        Math.round((Date.parse(segArr) - Date.parse(segDep)) / 60000),
      );
      const stopovers: StopoverInfo[] = (seg.intermediate_stop ?? [])
        .map((s) => ({
          name: s.name,
          arrival: parseLocalIso(s.arr_offset) ?? undefined,
          departure: parseLocalIso(s.dep_offset) ?? undefined,
        }))
        .filter((s) => s.name);
      legs.push({
        origin: seg.dep_id ?? "",
        destination: seg.arr_id ?? "",
        originLabel: seg.dep_name,
        destLabel: seg.arr_name,
        departTime: segDep,
        arriveTime: segArr,
        durationMinutes: segDuration,
        line: seg.line_code ?? seg.line,
        product: "bus",
        direction: seg.direction,
        stops: stopovers.length,
        stopovers: stopovers.length > 0 ? stopovers : undefined,
      });
    }

    out.push({
      externalId: `flixbus:${depart}:${j.dep_name ?? input.origin}:${j.arr_name ?? input.destination}:${i}`,
      origin: input.origin,
      destination: input.destination,
      originLabel: j.dep_name ?? input.originLabel,
      destLabel: j.arr_name ?? input.destLabel,
      departTime: depart,
      arriveTime: arrive,
      durationMinutes,
      stops,
      stopLabels,
      legs: legs.length > 0 ? legs : undefined,
      price,
      currency: fare?.currency ?? input.currency,
      deepLink: j.deeplink ?? buildBookingFallback(input),
      operatedBy: "FlixBus",
      providerLogo: "https://logos.flixbus.com/flixbus.png",
    });
  }
  return out;
}

// "2024-10-30T00:15:00.000" — kein Z, kein Offset. Local time relativ zur
// Abfahrtsstation. Wir parsen als-ob-UTC, damit Date.parse stabil ist —
// die echte Timezone-Anzeige übernimmt der Client via originTz/destinationTz.
function parseLocalIso(value: string | undefined): string | null {
  if (!value) return null;
  const withZ = /Z|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// "09:15" → 555 Minuten
function parseHmDuration(value: string | undefined, depart: string, arrive: string): number {
  if (typeof value === "string") {
    const m = value.match(/^(\d+):(\d{1,2})$/);
    if (m && m[1] && m[2]) return Number(m[1]) * 60 + Number(m[2]);
  }
  return Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60000));
}

// "2026-05-15" → "15.05.2026"
function isoToDmy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function buildBookingFallback(input: ProviderSearchInput): string {
  const params = new URLSearchParams({
    departureCity: input.originLabel ?? input.origin,
    arrivalCity: input.destLabel ?? input.destination,
    rideDate: isoToDmy(input.departDate),
    adult: String(input.passengers),
    currency: input.currency,
  });
  if (config.FLIXBUS_AFFILIATE_ID) {
    params.set("partner", config.FLIXBUS_AFFILIATE_ID);
  }
  return `https://shop.flixbus.com/search?${params.toString()}`;
}
