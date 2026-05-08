import { db } from "../db/client.js";
import { providerResponses, searchRequests, searchResults } from "../db/schema.js";
import type { TravelMode } from "../db/schema.js";
import { activeProvidersForMode } from "../providers/registry.js";
import type { LegInfo, NormalizedResult, ProviderSearchInput } from "../providers/types.js";
import { sha256 } from "../util/hash.js";
import { issueRedirectToken } from "./tokenService.js";

export interface SearchInput extends ProviderSearchInput {
  mode: TravelMode;
  ip?: string;
}

export interface ClientResult {
  id: string;
  mode: TravelMode;
  provider: string;
  providerLogo?: string;
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  departTime: string;
  arriveTime: string;
  originTz?: string;
  destinationTz?: string;
  dateOnly?: boolean;
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  legs?: LegInfo[];
  price: number;
  currency: string;
  redirectToken: string;
  flightNumber?: string;
  operatedBy?: string;
  isRefundable?: boolean;
  baggageIncluded?: boolean;
}

export interface SearchOutput {
  results: ClientResult[];
  source: "live" | "cache";
  fetchedAt: string;
}

interface Candidate {
  result: NormalizedResult;
  provider: string;
  providerResponseId: string;
}

export async function runSearch(input: SearchInput): Promise<SearchOutput> {
  const [request] = await db
    .insert(searchRequests)
    .values({
      mode: input.mode,
      origin: input.origin,
      destination: input.destination,
      originLabel: input.originLabel,
      destLabel: input.destLabel,
      departDate: input.departDate,
      returnDate: input.returnDate,
      passengers: input.passengers,
      currency: input.currency,
      ipHash: input.ip ? sha256(input.ip) : null,
    })
    .returning({ id: searchRequests.id });

  if (!request) throw new Error("Failed to insert search request");

  const providers = activeProvidersForMode(input.mode);
  const candidates: Candidate[] = [];

  await Promise.all(
    providers.map(async (p) => {
      const start = Date.now();
      try {
        const out = await p.search(input);
        const [pr] = await db
          .insert(providerResponses)
          .values({
            requestId: request.id,
            provider: p.name,
            mode: input.mode,
            statusCode: out.statusCode,
            durationMs: out.durationMs || Date.now() - start,
            rawResponse: out.raw as never,
            resultCount: out.results.length,
          })
          .returning({ id: providerResponses.id });
        if (!pr) return;
        for (const r of out.results) {
          candidates.push({ result: r, provider: p.name, providerResponseId: pr.id });
        }
      } catch (e) {
        await db.insert(providerResponses).values({
          requestId: request.id,
          provider: p.name,
          mode: input.mode,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
      }
    }),
  );

  const deduped = dedupe(candidates, input.mode);

  const flatResults: ClientResult[] = [];
  if (deduped.length > 0) {
    const inserted = await db
      .insert(searchResults)
      .values(
        deduped.map((c) => ({
          requestId: request.id,
          providerResponseId: c.providerResponseId,
          mode: input.mode,
          provider: c.provider,
          providerLogo: c.result.providerLogo,
          origin: c.result.origin,
          destination: c.result.destination,
          originLabel: c.result.originLabel,
          destLabel: c.result.destLabel,
          departTime: new Date(c.result.departTime),
          arriveTime: new Date(c.result.arriveTime),
          originTz: c.result.originTz,
          destinationTz: c.result.destinationTz,
          dateOnly: c.result.dateOnly ?? false,
          durationMinutes: c.result.durationMinutes,
          stops: c.result.stops,
          stopLabels: c.result.stopLabels,
          legs: c.result.legs,
          price: c.result.price.toFixed(2),
          currency: c.result.currency,
          deepLink: c.result.deepLink,
          flightNumber: c.result.flightNumber,
          operatedBy: c.result.operatedBy,
          isRefundable: c.result.isRefundable,
          baggageIncluded: c.result.baggageIncluded,
        })),
      )
      .returning();

    for (let i = 0; i < inserted.length; i++) {
      const row = inserted[i]!;
      const candidate = deduped[i]?.result;
      const token = await issueRedirectToken(row.id, row.deepLink, {
        bookingToken: candidate?.bookingToken,
        bookingContext: {
          mode: row.mode,
          origin: input.origin,
          destination: input.destination,
          departDate: input.departDate,
          returnDate: input.returnDate,
          passengers: input.passengers,
          currency: input.currency,
        },
      });
      flatResults.push({
        id: row.id,
        mode: row.mode,
        provider: row.provider,
        providerLogo: row.providerLogo ?? undefined,
        origin: row.origin,
        destination: row.destination,
        originLabel: row.originLabel ?? undefined,
        destLabel: row.destLabel ?? undefined,
        departTime: row.departTime.toISOString(),
        arriveTime: row.arriveTime.toISOString(),
        originTz: row.originTz ?? undefined,
        destinationTz: row.destinationTz ?? undefined,
        dateOnly: row.dateOnly,
        durationMinutes: row.durationMinutes,
        stops: row.stops,
        stopLabels: row.stopLabels,
        legs: (row.legs as LegInfo[] | null) ?? undefined,
        price: Number(row.price),
        currency: row.currency,
        redirectToken: token,
        flightNumber: row.flightNumber ?? undefined,
        operatedBy: row.operatedBy ?? undefined,
        isRefundable: row.isRefundable ?? undefined,
        baggageIncluded: row.baggageIncluded ?? undefined,
      });
    }
  }

  flatResults.sort((a, b) => a.price - b.price);

  return {
    results: flatResults,
    source: "live",
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Dedupe across providers: same physical journey returned by multiple APIs is collapsed
 * to a single entry. We keep the cheapest variant.
 */
function dedupe(candidates: Candidate[], mode: TravelMode): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = fingerprint(c.result, mode);
    const existing = map.get(key);
    if (!existing || c.result.price < existing.result.price) {
      map.set(key, c);
    }
  }
  return Array.from(map.values());
}

function fingerprint(r: NormalizedResult, mode: TravelMode): string {
  const dep = roundToMinute(r.departTime);
  const arr = roundToMinute(r.arriveTime);
  const route = `${r.origin}->${r.destination}`;

  if (mode === "FLIGHT" && r.flightNumber) {
    return `flight:${r.flightNumber.toUpperCase()}|${dep}|${route}`;
  }
  const op = (r.operatedBy ?? "").toLowerCase();
  return `${mode.toLowerCase()}:${op}|${dep}|${arr}|${route}`;
}

function roundToMinute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(Math.floor(t / 60000) * 60000).toISOString();
}
