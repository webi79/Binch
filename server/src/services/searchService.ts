import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { providerResponses, searchRequests, searchResults } from "../db/schema.js";
import type { TravelMode } from "../db/schema.js";
import { activeProvidersForMode, activeFallbackProvidersForMode } from "../providers/registry.js";
import { enrichTrainResults } from "./trainPricing.js";
import type {
  LegInfo,
  NormalizedResult,
  ProviderSearchInput,
  SearchProvider,
} from "../providers/types.js";
import { sha256 } from "../util/hash.js";
import { issueRedirectToken } from "./tokenService.js";
import { enqueueRefresh as enqueueDbVendoRefresh } from "./dbVendoQueue.js";

export interface SearchInput extends ProviderSearchInput {
  mode: TravelMode;
  ip?: string;
  nocache?: boolean;
}

export interface ClientResult {
  id: string;
  mode: TravelMode;
  /** "OUTBOUND" = Hinfahrt (Default), "RETURN" = Rückfahrt (nur bei
   *  Round-Trip-Train-Suchen befüllt). Client paart Hin/Rück je nach
   *  aktivem Sort-Tab. */
  direction?: "OUTBOUND" | "RETURN";
  provider: string;
  providerLogo?: string;
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  departTime: string;
  arriveTime: string;
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
  originTz?: string;
  destinationTz?: string;
  dateOnly?: boolean;
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  legs?: LegInfo[];
  price: number;
  currency: string;
  /** Direkter Provider-URL — wird nur dann an den Client geschickt, wenn kein
   *  redirectToken existiert (z.B. RETURN-Treffer, die wir noch nicht
   *  persistieren). ResultCard fällt auf diesen Wert zurück. */
  deepLink?: string;
  redirectToken: string;
  /** Google-Flights/SerpAPI Token — nur bei mode=FLIGHT. Client braucht ihn
   *  um via /api/flights/booking-options die Multi-Provider-Liste zu laden
   *  (Expedia, Booking, Kiwi, trip.com etc.). */
  bookingToken?: string;
  flightNumber?: string;
  operatedBy?: string;
  isRefundable?: boolean;
  baggageIncluded?: boolean;
}

export interface SearchOutput {
  results: ClientResult[];
  source: "live" | "cache";
  fetchedAt: string;
  /** Pagination-Token vom Train-Provider (HAFAS laterRef). Nur bei
   *  mode=TRAIN gesetzt — der Client zeigt damit den „Später"-Button im
   *  Result-Screen und schickt das Token an /api/search/trains/more. */
  paginationToken?: string;
}

interface Candidate {
  result: NormalizedResult;
  provider: string;
  providerResponseId: string;
}

// =============================================================
// Intelligentes Caching
// =============================================================
//
// 3-Stufen-Strategie pro Anfrage:
//
//   1. Cache-Lookup (DB) → frisch?  → sofort zurück, nichts weiter tun
//                          stale?   → sofort zurück + Background-Refresh feuern
//                          fehlt?   → live fetch
//   2. In-Flight-Coalescing: gleiche Suche von mehreren Usern parallel
//      löst nur EINEN Provider-Call aus, die anderen await'n auf dasselbe
//      Promise.
//   3. Per-Mode-TTL: Trains haben stabilere Fahrpläne → längerer Cache,
//      Flights wechseln Preise oft → kürzerer Cache.

/** TTL für „frische" Daten — solange wir noch nicht im Background refreshen.
 *  Werte sind ein Trade-off zwischen Preisaktualität und API-Quota:
 *    - Niedrig = häufige Refreshes = aktuelle Preise = mehr Provider-Calls
 *    - Hoch = seltene Refreshes = ggf. veraltete Preise = günstiger
 *  Da SWR ab 50% der TTL refresht, ist die effektive Stale-Garantie TTL/2. */
const CACHE_TTL_BY_MODE: Record<TravelMode, number> = {
  TRAIN: 4 * 60 * 60 * 1000, //   4 h  — Fahrpläne stabil, Preise bei DB selten
  // 5 min: Flugpreise UND Googles booking_token-Gültigkeit ändern sich schnell.
  // Ein zu lang gecachtes Result servierte einen veralteten booking_token →
  // getBookingDetails liefert dann Fallback-/abweichende Preise. Kurzer Cache
  // hält Token + Preise frisch (mehr Quota, aber Plan upgegradet).
  FLIGHT: 5 * 60 * 1000, //       5 min
  BUS: 30 * 60 * 1000, //         30 min → Preise max 15 min stale
  CRUISE: 12 * 60 * 60 * 1000, // 12 h — selten Änderungen
};

/** Ab welchem Alter (relativ zur TTL) wir im Hintergrund auffrischen. */
const STALE_REFRESH_RATIO = 0.5;

/** Hard-Limit: über diesem Alter ignorieren wir den Cache komplett. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 h

/**
 * Cache-Schema-Epoche. Suchergebnisse, die VOR diesem Zeitpunkt gecacht wurden,
 * werden ignoriert (als wären sie abgelaufen) — nutzt die vorhandene
 * `created_at`-Spalte, keine DB-Migration nötig.
 *
 * BEI JEDER ÄNDERUNG AN DER ERGEBNIS-STRUKTUR/ANREICHERUNG auf die aktuelle
 * Deploy-Zeit hochsetzen (neue Felder, geändertes Label/Gleis/Preis-Enrichment,
 * neue Normalisierung …). Alte Rows fallen dann automatisch raus → kein
 * manuelles Cache-Leeren mehr.
 *
 * 2026-07-12T22:50Z: dbweb-Label/Gleis-Enrichment (ECE 190 statt DELFI IC 190).
 * 2026-07-13T13:15Z: dbweb-ROUTE-Ersetzung (ganze Route von bahn.de statt MOTIS).
 * 2026-07-13T18:00Z: Zug-transitModes um Nahverkehr erweitert (SUBURBAN/TRAM/
 *   SUBWAY) → Ziele wie Zürich Brunau lieferten vorher 0 Ergebnisse (gecacht).
 */
const RESULT_SCHEMA_EPOCH = new Date("2026-07-13T18:00:00Z");

/** In-Flight-Map: Schlüssel = cacheKey, Wert = Promise des laufenden Calls. */
const inFlight = new Map<string, Promise<SearchOutput>>();

function cacheKey(input: SearchInput): string {
  return [
    input.mode,
    input.origin,
    input.destination,
    input.departDate,
    input.returnDate ?? "",
    input.passengers,
    input.currency,
    // travelClass MUSS in den Key — sonst würde eine Economy-Suche eine
    // Business-Suche aus dem Cache bedienen (gleiche Strecke, andere Klasse).
    input.travelClass ?? "",
    // departTime ebenso: der Surroundings-Departure-Tap verschiebt damit das
    // dbVendo-Suchfenster. Ohne Key-Anteil würde ein 09:00-Tap die gecachten
    // 14:00-Ergebnisse derselben Strecke/Tag serviert bekommen.
    input.departTime ?? "",
  ].join("|");
}

interface CachedHit {
  output: SearchOutput;
  ageMs: number;
}

async function loadFromCache(input: SearchInput): Promise<CachedHit | null> {
  // travelClass wird (noch) nicht in der DB-Tabelle gespeichert — daher
  // können wir bei klassenspezifischen Suchen den DB-Cache nicht sicher
  // bedienen (Economy-Resultate würden eine Business-Anfrage beantworten).
  // Lieber live fetchen als falsche Klassenpreise liefern.
  if (input.travelClass) return null;

  // departTime (Surroundings-Departure-Tap) verschiebt das dbVendo-Such-
  // fenster, wird aber ebenfalls nicht in der DB-Tabelle unterschieden —
  // ein Cache-Hit könnte Ergebnisse eines anderen Zeitfensters liefern.
  if (input.departTime) return null;

  // Round-Trip: Rückfahrt-Treffer werden nicht persistiert (kein `direction`
  // im Schema). Ein Cache-Hit würde nur die Hinfahrten liefern, was den
  // Round-Trip kaputtmacht. Lieber live fetchen.
  if (input.returnDate) return null;

  const maxAge = Math.max(CACHE_TTL_BY_MODE[input.mode], CACHE_MAX_AGE_MS);
  const since = new Date(Date.now() - maxAge);
  // Nie älter als die Schema-Epoche servieren → alte Ergebnis-Struktur fällt raus.
  const effectiveSince = since > RESULT_SCHEMA_EPOCH ? since : RESULT_SCHEMA_EPOCH;

  const [match] = await db
    .select({ id: searchRequests.id, createdAt: searchRequests.createdAt })
    .from(searchRequests)
    .where(
      and(
        eq(searchRequests.mode, input.mode),
        eq(searchRequests.origin, input.origin),
        eq(searchRequests.destination, input.destination),
        eq(searchRequests.departDate, input.departDate),
        input.returnDate
          ? eq(searchRequests.returnDate, input.returnDate)
          : isNull(searchRequests.returnDate),
        eq(searchRequests.passengers, input.passengers),
        eq(searchRequests.currency, input.currency),
        gte(searchRequests.createdAt, effectiveSince),
      ),
    )
    .orderBy(desc(searchRequests.createdAt))
    .limit(1);

  if (!match) return null;

  const rows = await db
    .select()
    .from(searchResults)
    .where(eq(searchResults.requestId, match.id));

  if (rows.length === 0) return null;

  const out: ClientResult[] = [];
  for (const row of rows) {
    const token = await issueRedirectToken(row.id, row.deepLink, {
      // bookingToken aus dem persistierten Result → Cache-Hits können auch
      // den Direct-Purchase-Flow (SerpAPI 2nd-stage) bedienen.
      bookingToken: row.bookingToken ?? undefined,
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
    out.push({
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
      bookingToken: row.bookingToken ?? undefined,
      flightNumber: row.flightNumber ?? undefined,
      operatedBy: row.operatedBy ?? undefined,
      isRefundable: row.isRefundable ?? undefined,
      baggageIncluded: row.baggageIncluded ?? undefined,
    });
  }

  out.sort((a, b) => a.price - b.price);

  return {
    output: {
      results: out,
      source: "cache",
      fetchedAt: match.createdAt.toISOString(),
    },
    ageMs: Date.now() - match.createdAt.getTime(),
  };
}

/**
 * Hauptpfad bei Cache-Miss: hits providers, dedupliziert, persistiert, gibt
 * neue Tokens aus. Wird via in-flight-Map dedupliziert wenn mehrere User
 * gleichzeitig die exakt selbe (uncached) Suche absenden.
 */
async function runLive(input: SearchInput): Promise<SearchOutput> {
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

  const candidates: Candidate[] = [];
  // Pagination-Token vom (ersten) Provider der einen liefert. Bei TRAIN ist
  // das dbVendo — andere Modes bleiben undefined.
  let paginationToken: string | undefined;

  const runProviders = async (list: SearchProvider[]) => {
    await Promise.all(
      list.map(async (p) => {
        const start = Date.now();
        try {
          const out = await p.search(input);
          if (out.paginationToken && !paginationToken) {
            paginationToken = out.paginationToken;
          }
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
  };

  await runProviders(activeProvidersForMode(input.mode));
  // Fallback (FLIGHT: google-flights2) nur wenn die Primaries 0 Treffer lieferten
  // — z.B. SearchAPI-Ausfall oder Round-Trip (SearchAPI = one-way-only). So
  // verbrennt der Doppel-Call im Normalfall keine Quota.
  if (candidates.length === 0) {
    await runProviders(activeFallbackProvidersForMode(input.mode));
  }

  const deduped = dedupe(candidates, input.mode);

  // Hin- und Rückfahrten getrennt behandeln: Rückfahrten persistieren wir
  // (noch) nicht — das DB-Schema hat keine `direction`-Spalte, und der
  // Round-Trip-Cache ist eh deaktiviert (siehe loadFromCache). Rück-Treffer
  // bekommen keinen redirectToken; der Client nutzt für sie deepLink direkt.
  const outboundCandidates = deduped.filter((c) => c.result.direction !== "RETURN");
  const returnCandidates = deduped.filter((c) => c.result.direction === "RETURN");

  // Zug-Enrichment: EIN int.bahn.de-Call ersetzt bei Match die MOTIS-Route
  // komplett durch bahn.des Route (Legs/Gleise/Label/Preis/Recon) → Anzeige =
  // Buchung. Best-effort — bei Drosselung/non-DE bleiben die MOTIS-Routen.
  if (input.mode === "TRAIN" && outboundCandidates.length > 0) {
    await enrichTrainResults(outboundCandidates.map((c) => c.result), input);
  }

  const flatResults: ClientResult[] = [];
  if (outboundCandidates.length > 0) {
    const inserted = await db
      .insert(searchResults)
      .values(
        outboundCandidates.map((c) => ({
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
          bookingToken: c.result.bookingToken,
          flightNumber: c.result.flightNumber,
          operatedBy: c.result.operatedBy,
          isRefundable: c.result.isRefundable,
          baggageIncluded: c.result.baggageIncluded,
        })),
      )
      .returning();

    for (let i = 0; i < inserted.length; i++) {
      const row = inserted[i]!;
      const candidate = outboundCandidates[i]?.result;
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
          // Für den Zug-Direkt-Buchungslink („Reise teilen"): Station-Namen +
          // die konkrete Verbindungs-Abfahrt als hinfahrtDatum.
          originLabel: input.originLabel,
          destLabel: input.destLabel,
          departTime: row.departTime.toISOString(),
        },
      });
      flatResults.push({
        id: row.id,
        mode: row.mode,
        direction: "OUTBOUND",
        provider: row.provider,
        providerLogo: row.providerLogo ?? undefined,
        origin: row.origin,
        destination: row.destination,
        originLabel: row.originLabel ?? undefined,
        destLabel: row.destLabel ?? undefined,
        departTime: row.departTime.toISOString(),
        arriveTime: row.arriveTime.toISOString(),
        // Verspätung NICHT persistiert (realtime) → nur in der Live-Antwort aus
        // dem Candidate; Cache-Hits zeigen dann keinen veralteten Delay.
        departDelayMinutes: candidate?.departDelayMinutes,
        arriveDelayMinutes: candidate?.arriveDelayMinutes,
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
        // bookingToken durchreichen: der Client braucht ihn für den
        // `/api/flights/booking-options`-Call (Multi-Provider-Liste im
        // DetailsOverlay). Ohne ihn fragt React-Query nichts ab → User sieht
        // nur die Airline ohne OTAs wie Booking/Expedia/Kiwi.
        bookingToken: row.bookingToken ?? undefined,
        flightNumber: row.flightNumber ?? undefined,
        operatedBy: row.operatedBy ?? undefined,
        isRefundable: row.isRefundable ?? undefined,
        baggageIncluded: row.baggageIncluded ?? undefined,
      });
    }
  }

  // Return-Treffer: ohne DB-Persistence, ohne redirectToken — der Client
  // nutzt deepLink direkt (Rück-Optionen sind in dieser Iteration nur für die
  // Pairing-Logik im Frontend gedacht, keine eigene Buchungs-Detail-Seite).
  // Loop-Index in der ID → garantiert eindeutig, selbst wenn zwei Return-
  // Treffer denselben externalId hätten (HAFAS-refreshToken-Kollision oder
  // Provider-Fallback-Index-Kollision). Sonst löst React beim Rendern der
  // FlatList einen "two children with the same key"-Fehler aus.
  for (let i = 0; i < returnCandidates.length; i++) {
    const c = returnCandidates[i]!;
    flatResults.push({
      id: `return:${i}:${c.result.externalId}`,
      mode: input.mode,
      direction: "RETURN",
      provider: c.provider,
      providerLogo: c.result.providerLogo,
      origin: c.result.origin,
      destination: c.result.destination,
      originLabel: c.result.originLabel,
      destLabel: c.result.destLabel,
      departTime: c.result.departTime,
      arriveTime: c.result.arriveTime,
      originTz: c.result.originTz,
      destinationTz: c.result.destinationTz,
      dateOnly: c.result.dateOnly ?? false,
      durationMinutes: c.result.durationMinutes,
      stops: c.result.stops,
      stopLabels: c.result.stopLabels,
      legs: c.result.legs,
      price: c.result.price,
      currency: c.result.currency,
      // Direkter Bahn.de/FlixBus-URL — ResultCard.bookUrl fällt auf deepLink
      // zurück wenn redirectToken leer ist. Damit funktionieren Buchungs-
      // Buttons für Rück-Treffer auch ohne DB-Persistence.
      deepLink: c.result.deepLink,
      redirectToken: "",
      bookingToken: c.result.bookingToken,
      flightNumber: c.result.flightNumber,
      operatedBy: c.result.operatedBy,
      isRefundable: c.result.isRefundable,
      baggageIncluded: c.result.baggageIncluded,
    });
  }

  flatResults.sort((a, b) => a.price - b.price);

  return {
    results: flatResults,
    source: "live",
    fetchedAt: new Date().toISOString(),
    paginationToken,
  };
}

/** Fire-and-forget Background-Refresh — füllt den Cache mit frischen Daten,
 *  ohne dass der aktuelle User darauf wartet.
 *
 *  Bei TRAIN-Searches geht der Refresh in die geteilte db-vendo-Queue, damit
 *  ein History-Refresh-Sturm (z.B. 10 000 User mit gespeicherten Zugrouten
 *  öffnen morgens die App) nicht das 60/min-Limit von db-vendo aufbraucht und
 *  damit aktive SearchHero-Anfragen blockiert. Andere Modes (FLIGHT/BUS/CRUISE)
 *  treffen unterschiedliche Provider und haben dort eigene Quotas — bei denen
 *  bleibt's beim direkten Fire-and-forget.
 *
 *  Coalescing-Map verhindert dass mehrere parallele Stale-Hits den gleichen
 *  Background-Refresh feuern. */
function triggerBackgroundRefresh(input: SearchInput, key: string) {
  if (inFlight.has(key)) return;

  const refreshFn = () => {
    if (inFlight.has(key)) return Promise.resolve();
    const promise = runLive({ ...input, nocache: true })
      .catch((e) => {
        console.warn(`[search] background refresh failed for ${key}:`, e instanceof Error ? e.message : e);
        return null as unknown as SearchOutput;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise as Promise<SearchOutput>);
    return promise;
  };

  if (input.mode === "TRAIN") {
    enqueueDbVendoRefresh({
      key: `search:${key}`,
      // Träume aus der Recent-History (history-Refresh) hängen oft an
      // populären Routen — Priorität 5 ist Mittelmaß zwischen Pre-Cache (10)
      // und Long-Tail (0).
      priority: 5,
      // 30 min ist großzügig — Fahrpläne sind stabil, auch späte Refreshes
      // produzieren noch nutzbare Daten.
      maxAgeMs: 30 * 60_000,
      execute: refreshFn,
    });
    return;
  }

  refreshFn();
}

export async function runSearch(input: SearchInput): Promise<SearchOutput> {
  const key = cacheKey(input);
  const ttl = CACHE_TTL_BY_MODE[input.mode];

  // 1. Cache-Lookup (außer ?nocache=1 ODER bei Pagination — da brauchen wir
  //    immer frische Provider-Daten, der laterRef-Token hat keinen Cache-Sinn).
  if (!input.nocache && !input.paginationToken) {
    const cached = await loadFromCache(input);
    if (cached && cached.ageMs <= ttl + (CACHE_MAX_AGE_MS - ttl)) {
      const isStale = cached.ageMs > ttl * STALE_REFRESH_RATIO;
      if (isStale && cached.ageMs <= ttl) {
        // Frisch genug zum servieren, aber >50 % TTL → background refresh.
        triggerBackgroundRefresh(input, key);
      }
      if (cached.ageMs <= ttl) {
        return cached.output;
      }
      // Cache älter als TTL, aber innerhalb max-age: trotzdem live fetch
      // (mit Coalescing) — der Stale-Refresh wird im normalen Flow gemacht.
    }
  }

  // 2. Coalescing — wenn gerade ein Provider-Call für dieselbe Suche läuft,
  //    hänge dich dran statt einen zweiten zu feuern. Greift auch bei nocache=1
  //    (5 gleichzeitige Force-Refreshes = 1 Provider-Call).
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  // 3. Echter Live-Fetch — neuen In-Flight-Eintrag registrieren damit
  //    parallele Anfragen dranhängen können.
  const promise = runLive(input).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
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
    // ANKUNFT + STOPS gehören in den Fingerprint, sonst kollabieren völlig
    // verschiedene Umsteigeverbindungen mit demselben ERSTEN Flug auf einen
    // Eintrag (z.B. 57 DTM→HRG-Itineraries, alle mit erstem Eurowings-Flug aber
    // anderen Anschlüssen/Ankünften → wurden auf 2 reduziert). dep+arr+stops+
    // erste Flugnummer identifiziert echte Duplikate, behält aber distinkte Reisen.
    return `flight:${r.flightNumber.toUpperCase()}|${dep}|${arr}|${r.stops}|${route}`;
  }
  const op = (r.operatedBy ?? "").toLowerCase();
  return `${mode.toLowerCase()}:${op}|${dep}|${arr}|${route}`;
}

function roundToMinute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(Math.floor(t / 60000) * 60000).toISOString();
}
