import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations, providerResponses, searchRequests, searchResults } from "../db/schema.js";
import type { TravelMode } from "../db/schema.js";
import { activeProvidersForMode, activeFallbackProvidersForMode } from "../providers/registry.js";
import { enrichTrainResults } from "./trainPricing.js";
import type {
  LegInfo,
  NormalizedResult,
  ProviderResult,
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
 * 2026-07-13T18:08Z: Routing an exakte MOTIS-Stop-ID statt Koordinate (Route
 *   endet am gewählten Halt statt Nachbar-Stop) + DB-nahes Ranking
 *   (Verbindungsqualität statt Preis) + maxTransfers=5 + Zug-Dedup.
 * 2026-07-13T21:06Z: Fußwege sind jetzt Teil der Reise (Zeiten/Dauer/Legs) —
 *   vorher endeten Routen sichtbar am falschen Halt („Billoweg") und die Dauer
 *   log. Bus in den Zug-Modi (wie DB Navigator). Stop-ID nur noch bei
 *   kanonischem Geocode-Treffer (sonst Koordinate) → keine Phantom-Fußwege
 *   zwischen Referenzdaten-Dubletten mehr. Linien-Platzhalter „0" gefixt.
 * 2026-07-13T21:40Z: Suchzeitpunkt gefixt (heute → ab jetzt statt ab Mitternacht;
 *   künftiges Datum → ab 08:00 statt nur Nachtzüge) + „Später"-Pagination.
 *
 * 2026-07-13T21:58Z: Uhrzeit aus dem Picker wird durchgereicht (war weggeworfen)
 *   → alte Rows stammen aus der Mitternachts-Ära und zeigen Nachtzüge.
 * 2026-07-13T22:23Z: Feed-Alias-Fußwege raus (München Hbf → „München Hauptbahnhof“)
 *   + Selbst-Fußwege (Bahnsteigwechsel). Abfahrt/Dauer stimmten dadurch nicht.
 *
 * WICHTIG: Wert nie in die Zukunft setzen (== aktuelle Deploy-Zeit), sonst
 * qualifiziert keine frisch geschriebene Row → Cache komplett aus.
 */
const RESULT_SCHEMA_EPOCH = new Date("2026-07-14T00:01:00Z");

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
        // Die gewählte Uhrzeit ist Teil der Such-Identität: eine 08:00-Suche
        // darf NICHT aus dem Cache einer 18:00-Suche derselben Strecke bedient
        // werden. Früher wurde bei gesetzter departTime der Cache komplett
        // übersprungen — seit der Picker die Uhrzeit liefert, wäre damit jede
        // Suche ungecacht gewesen.
        input.departTime
          ? eq(searchRequests.departTime, new Date(input.departTime))
          : isNull(searchRequests.departTime),
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

  const fresh = dropDeparted(out);
  sortResults(fresh, input.mode);

  return {
    output: {
      results: fresh,
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
      // Uhrzeit gehört zur Cache-Identität (siehe loadFromCache).
      departTime: input.departTime ? new Date(input.departTime) : null,
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
          const out = await withProviderTimeout(p, input);
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

  // Fallback — zwei Auslöser.
  //
  // 1. Die Primaries lieferten NICHTS. Bei Flügen heißt das SearchAPI-Ausfall
  //    oder Round-Trip (SearchAPI ist one-way-only), bei Zug/Bus: DB kennt die
  //    Strecke nicht oder blockt uns gerade. So verbrennt der Doppel-Call im
  //    Normalfall keine Quota.
  //
  // 2. NUR Zug/Bus: Die Strecke verlässt Deutschland.
  //
  //    DBs Routing wird jenseits der Grenze dünn — und zwar nicht nur in der
  //    Beschriftung. Gemessen an London Waterloo → St Pancras:
  //        db-vendo:  Waterloo-EAST → London Bridge → St Pancras   23 Min, 1 Umstieg
  //        MOTIS:     Waterloo → Euston (Northern Line)            10 Min, direkt
  //    DB kennt die Londoner U-Bahn nicht, schiebt einen ANDEREN Bahnhof unter
  //    (Waterloo East) und routet über den Fernbahn-Umweg. Die Verbindung fährt
  //    wirklich, ist aber die schlechtere Hälfte des Netzes.
  //
  //    In Amsterdam ist es harmlos (Route identisch, nur „IC 2718" statt
  //    „Intercity") — aber unterscheiden können wir das vorher nicht. Also holen
  //    wir bei Auslandsberührung die Zweitmeinung ein und lassen den Dedupe
  //    entscheiden.
  //
  //    Innerdeutsch — der weit überwiegende Fall — bleibt es bei db-vendo allein:
  //    dort ist DB die bessere Quelle (Preise, echte Gleise, echte Zugnamen) und
  //    die Suche bleibt schnell.
  const crossesBorder =
    (input.mode === "TRAIN" || input.mode === "BUS") && !(await isDomesticGerman(input));
  if (candidates.length === 0 || crossesBorder) {
    await runProviders(activeFallbackProvidersForMode(input.mode));
  }

  const deduped = dedupe(candidates, input.mode);

  // Hin- und Rückfahrten getrennt behandeln: Rückfahrten persistieren wir
  // (noch) nicht — das DB-Schema hat keine `direction`-Spalte, und der
  // Round-Trip-Cache ist eh deaktiviert (siehe loadFromCache). Rück-Treffer
  // bekommen keinen redirectToken; der Client nutzt für sie deepLink direkt.
  let outboundCandidates = deduped.filter((c) => c.result.direction !== "RETURN");
  const returnCandidates = deduped.filter((c) => c.result.direction === "RETURN");

  // Zug-Enrichment: EIN int.bahn.de-Call ersetzt bei Match die MOTIS-Route
  // komplett durch bahn.des Route (Legs/Gleise/Label/Preis/Recon) → Anzeige =
  // Buchung. Best-effort — bei Drosselung/non-DE bleiben die MOTIS-Routen.
  // NUR für Treffer OHNE Preis. Seit db-vendo die primäre Zug-Quelle ist, bringen
  // die Ergebnisse Preis, Gleise und bahn.de-Route bereits mit — die Anreicherung
  // wäre ein weiterer int.bahn.de-Call, der nichts hinzufügt (und Kontingent wie
  // Sekunden kostet). Gebraucht wird sie nur noch, wenn MOTIS als Reserve
  // eingesprungen ist: dessen Treffer haben price=0.
  const needsPricing = outboundCandidates.filter((c) => !(c.result.price > 0));
  if (input.mode === "TRAIN" && needsPricing.length > 0) {
    await enrichTrainResults(needsPricing.map((c) => c.result), input);
    // NOCHMAL deduplizieren: Das Enrichment ersetzt Label und Route durch die
    // von bahn.de. Zwei MOTIS-Varianten desselben Zuges (z.B. „IC 63" aus DELFI
    // und „RJX 63" aus dem Referenz-Feed) überleben den ersten Dedup, weil ihre
    // Labels sich unterscheiden — nach der Ersetzung sind sie identisch und
    // stünden doppelt in der Liste.
    outboundCandidates = dedupe(outboundCandidates, input.mode);
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

  const liveResults = dropDeparted(flatResults);
  sortResults(liveResults, input.mode);

  return {
    results: liveResults,
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

/**
 * Modi, deren Provider den exakten Abfahrts-Wunsch auswerten (MOTIS/dbVendo).
 * Flüge und Kreuzfahrten suchen tagesweise — ihre Provider LESEN `departTime`
 * gar nicht. Nähme man die Uhrzeit trotzdem in die Cache-Identität, zersplitterte
 * sie deren Cache je gewählter Minute: gleiche Ergebnisse, aber jedes Mal ein
 * frischer Provider-Call — bei Google-Flights direkt verbrannte Quota.
 */
const MODES_USING_DEPART_TIME = new Set<TravelMode>(["TRAIN", "BUS"]);

/**
 * Die im Picker gewählte Uhrzeit soll in JEDER Kategorie zählen. Bei Zug/Bus ist
 * sie der Suchzeitpunkt (der Provider startet dort). Flüge/Kreuzfahrten liefern
 * immer den ganzen Tag — dort wirkt sie als FILTER auf die Ergebnisse. Das
 * geschieht bewusst NACH dem Cache: der bleibt tagesweise und teilt sich über
 * alle Uhrzeiten (sonst kostete jede Minute einen frischen Provider-Call — bei
 * Google-Flights direkt Quota). `dateOnly` (Kreuzfahrten ohne Uhrzeit) bleibt.
 */
function applyRequestedTime(out: SearchOutput, rawInput: SearchInput): SearchOutput {
  if (!rawInput.departTime || MODES_USING_DEPART_TIME.has(rawInput.mode)) return out;
  const from = Date.parse(rawInput.departTime);
  if (!Number.isFinite(from)) return out;
  const results = out.results.filter((r) => r.dateOnly || Date.parse(r.departTime) >= from);
  // Nie in eine leere Liste filtern — dann lieber den ganzen Tag zeigen, als
  // dem User zu suggerieren, es gäbe an dem Tag gar nichts.
  return results.length > 0 ? { ...out, results } : out;
}

export async function runSearch(rawInput: SearchInput): Promise<SearchOutput> {
  const out = await runSearchUncut(rawInput);
  return applyRequestedTime(out, rawInput);
}

async function runSearchUncut(rawInput: SearchInput): Promise<SearchOutput> {
  const input: SearchInput = MODES_USING_DEPART_TIME.has(rawInput.mode)
    ? rawInput
    : { ...rawInput, departTime: undefined };

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
 * Umstiegsstrafe (Minuten) fürs Zug-Ranking. Die DB-Reiseauskunft bevorzugt
 * spürbar umstiegsarme Verbindungen: eine Route mit einem Umstieg mehr muss
 * ~20 min schneller sein, um überhaupt höher zu ranken. Genau das trennt die
 * „gute" Verbindung (IC direkt / IC + eine S-Bahn) von der Pareto-Odyssee
 * (Regionalzug-Kette mit 4-6 Umstiegen), die MOTIS als früheste-Ankunft-
 * Alternative mitliefert.
 */
/**
 * Schon abgefahrene Verbindungen gehören nicht in die Liste. Nötig, weil der
 * Postgres-Cache Zug-Ergebnisse bis zu 4 h lang ausliefert — ohne diesen Filter
 * stehen dort Züge, die längst weg sind. `dateOnly` (Kreuzfahrten ohne Uhrzeit)
 * bleibt unangetastet. Kleine Karenz, damit ein gerade abfahrender Zug nicht
 * mitten im Blättern verschwindet.
 */
const DEPARTED_GRACE_MS = 2 * 60_000;

function dropDeparted<T extends { departTime: string; dateOnly?: boolean }>(rows: T[]): T[] {
  const cutoff = Date.now() - DEPARTED_GRACE_MS;
  return rows.filter((r) => r.dateOnly || Date.parse(r.departTime) >= cutoff);
}

/**
 * `price === 0` heißt „kein Preis bekannt" (MOTIS liefert keine Tarife), NICHT
 * „geschenkt". Im Dedup wäre ein preisloser Treffer sonst billiger als jeder
 * echte Preis und würde den bepreisten VERDRÄNGEN — bei gleicher Verbindung aus
 * zwei Providern (MOTIS-Bus 0 € vs. FlixBus 25 €) verlöre der User den Preis.
 * Auch in der Preis-Sortierung gehören preislose Treffer ans Ende.
 */
function effectivePrice(r: { price: number }): number {
  return r.price > 0 ? r.price : Number.MAX_SAFE_INTEGER;
}

const TRANSFER_PENALTY_MIN = 20;

/**
 * Zusatzgewicht für Gehminuten. Gehen ist anstrengender als Sitzen — Reise-
 * auskünfte gewichten Fußwege daher schwerer als Fahrzeit (üblich: Faktor
 * 1.5-2). Die Gehzeit steckt schon voll in `durationMinutes`; dieser Aufschlag
 * macht daraus effektiv Faktor 1.5. Ohne ihn läge eine Verbindung mit 19 min
 * Fußweg gleichauf mit einer gleich langen, in der man durchsitzt.
 */
const WALK_EXTRA_WEIGHT = 0.5;

/**
 * „Verbindungsqualität" à la DB: Reisezeit + Umstiegsstrafe + Geh-Aufschlag.
 * Kleiner = besser.
 *
 * Die Umstiegsstrafe wird an der Reiselänge skaliert: 20 min sind bei einer
 * 4-Stunden-Fernfahrt richtig (verpasster Anschluss kostet viel), bei einer
 * 21-Minuten-Stadtfahrt aber absurd — dort verdrängte sie sonst die schnellere
 * S-Bahn-Verbindung zugunsten einer langsamen, umstiegsfreien Tram.
 */
function connectionScore(r: {
  durationMinutes: number;
  stops: number;
  legs?: LegInfo[] | null;
}): number {
  const walkMin = (r.legs ?? [])
    .filter((l) => l.walking)
    .reduce((sum, l) => sum + (l.durationMinutes || 0), 0);
  const perTransfer = Math.min(TRANSFER_PENALTY_MIN, 0.15 * r.durationMinutes);
  return (
    r.durationMinutes +
    perTransfer * Math.max(0, r.stops) +
    WALK_EXTRA_WEIGHT * walkMin
  );
}

/**
 * Ergebnis-Sortierung je Modus (in-place). Züge werden nach Verbindungsqualität
 * sortiert (DB-nah — MOTIS liefert nur Routing, keine brauchbaren Preise, und
 * die DB sortiert selbst nicht nach Preis), alle anderen Modi nach Preis.
 * Gleichstand → frühere Abfahrt zuerst.
 */
function sortResults<
  T extends { price: number; durationMinutes: number; stops: number; departTime: string },
>(results: T[], mode: TravelMode): void {
  if (mode === "TRAIN") {
    results.sort(
      (a, b) =>
        connectionScore(a) - connectionScore(b) ||
        Date.parse(a.departTime) - Date.parse(b.departTime),
    );
  } else {
    // effectivePrice: preislose Treffer (price 0 = „Tarif unbekannt") gehören ans
    // ENDE, nicht als vermeintlich Günstigste an die Spitze.
    results.sort(
      (a, b) =>
        effectivePrice(a) - effectivePrice(b) ||
        Date.parse(a.departTime) - Date.parse(b.departTime),
    );
  }
}

/**
 * Dedupe across providers: same physical journey returned by multiple APIs is collapsed
 * to a single entry. We keep the cheapest variant.
 */
/**
 * Datenqualität der Quelle — Tiebreak, wenn zwei Provider DIESELBE Fahrt liefern.
 *
 * db-vendo redet mit DBs eigener Routing-Engine: echte Gleise, echte Zugnamen
 * (RJX 63), Preis und Buchungslink. MOTIS routet auf offenen GTFS-Daten — dort
 * hat Köln Hbf die Gleise 85-91 (real: 1-11) und der RJX heißt „IC".
 *
 * Ohne diesen Tiebreak gewinnt bei gleicher Verbindungsqualität einfach der
 * Provider, der im Registry vorne steht (MOTIS) — wir hätten zu jeder DB-Fahrt
 * die schlechteren Daten behalten. Er greift NUR bei Gleichstand: findet MOTIS
 * die objektiv bessere Verbindung, gewinnt weiter MOTIS.
 */
const SOURCE_TRUST: Record<string, number> = { "db-vendo": 2, trainline: 1 };
const sourceTrust = (provider: string): number => SOURCE_TRUST[provider] ?? 0;

/**
 * Kein Provider darf die ganze Suche mitreißen.
 *
 * Bisher lief `p.search(input)` OHNE Timeout und ohne AbortSignal. Für eine
 * Fernbus-Suche Frankfurt → Rom brauchte motis-bus (öffentliches Transitous)
 * 41 SEKUNDEN, während FlixBus nach 3,5 s fertig war. Der Client bricht nach
 * 20 s ab — der User sah also „Server nicht erreichbar", obwohl 31 Ergebnisse
 * vorlagen und ein Anbieter längst geliefert hatte.
 *
 * Jetzt bekommt jeder Provider ein eigenes Zeitfenster. Läuft es ab, brechen wir
 * SEINE Anfrage ab (das Signal geht bis in den fetch durch) und arbeiten mit dem
 * weiter, was die anderen geliefert haben. Ein langsamer Anbieter kostet dann
 * Vollständigkeit, nicht die ganze Suche.
 *
 * 15 s ist bewusst großzügig: Eine kalte Zug-Suche über die öffentliche
 * MOTIS-Instanz braucht regulär 9-13 s. Wir wollen den Ausreißer kappen, nicht
 * den Normalfall.
 */
const PROVIDER_TIMEOUT_MS = 15_000;

async function withProviderTimeout(
  p: SearchProvider,
  input: ProviderSearchInput,
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await Promise.race([
      p.search(input, controller.signal),
      new Promise<ProviderResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              results: [],
              raw: { error: "provider_timeout", timeoutMs: PROVIDER_TIMEOUT_MS },
              statusCode: 0,
              durationMs: PROVIDER_TIMEOUT_MS,
            }),
          PROVIDER_TIMEOUT_MS,
        ),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(candidates: Candidate[], mode: TravelMode): Candidate[] {
  const map = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = fingerprint(c.result, mode);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, c);
      continue;
    }
    let better: boolean;
    if (mode === "TRAIN") {
      // Züge: die qualitativ beste Variante behalten (weniger Umstiege /
      // schneller); bei Gleichstand die vertrauenswürdigere Quelle. Preise
      // taugen hier nicht als Tiebreak — MOTIS-Treffer sind ohne Anreicherung 0.
      const score = connectionScore(c.result);
      const prev = connectionScore(existing.result);
      better =
        score < prev || (score === prev && sourceTrust(c.provider) > sourceTrust(existing.provider));
    } else if (mode === "BUS") {
      // Busse: hier ist der Preis echt (FlixBus & Co.), also entscheidet er —
      // aber bei GLEICHEM Preis die bessere Verbindung. Sonst behielten wir von
      // zwei Varianten derselben Abfahrt zufällig die mit mehr Umstiegen, nur
      // weil sie zuerst kam.
      const price = effectivePrice(c.result);
      const prevPrice = effectivePrice(existing.result);
      better =
        price < prevPrice ||
        (price === prevPrice && connectionScore(c.result) < connectionScore(existing.result));
    } else {
      better = effectivePrice(c.result) < effectivePrice(existing.result);
    }
    if (better) {
      map.set(key, c);
    }
  }
  return Array.from(map.values());
}

/**
 * Liegen BEIDE Endpunkte in Deutschland?
 *
 * Entscheidet, ob MOTIS als Zweitmeinung mitläuft (siehe Aufrufstelle). Bei
 * unbekanntem Land lieber `false` — dann holen wir die Zweitmeinung, statt uns
 * auf DB zu verlassen, wo wir es nicht wissen.
 */
async function isDomesticGerman(input: SearchInput): Promise<boolean> {
  try {
    const rows = await db
      .select({ code: locations.code, country: locations.country })
      .from(locations)
      .where(inArray(locations.code, [input.origin, input.destination]));
    if (rows.length < 2) return false;
    return rows.every((r) => r.country === "Germany");
  } catch {
    return false;
  }
}

function fingerprint(r: NormalizedResult, mode: TravelMode): string {
  const dep = roundToMinute(r.departTime);
  const arr = roundToMinute(r.arriveTime);
  const route = `${r.origin}->${r.destination}`;

  // Zug UND Bus: Fast-Duplikate kollabieren. Dieselbe IC 198 ab derselben Minute
  // einmal mit einem und einmal mit drei Zürcher Tram-Umstiegen ist EINE
  // Verbindung — DB zeigt pro Abfahrt genau die beste Variante. Darum nur erstes
  // Fahrzeug + dessen Abfahrt + Strecke im Key (NICHT Ankunft/Stops, sonst
  // bleiben die Varianten getrennt); dedupe() behält die beste Qualität.
  //
  // BUS war hier lange nicht dabei und lief in den generischen Zweig unten —
  // dort steht die Ankunft im Key, also überlebten die Varianten. Ergebnis:
  // „FlixBus 380, 12:00" stand doppelt in der Liste (einmal mit 1, einmal mit
  // 2 Umstiegen). Es ist derselbe Pareto-Artefakt wie bei den Zügen, weil beide
  // aus MOTIS kommen — also dieselbe Regel.
  //
  // Anker ist die Abfahrt des ersten FAHRZEUGS, nicht der Reisebeginn: seit
  // Fußwege Teil der Reise sind, schwankt der Reisebeginn mit dem Fußweg-Routing
  // — dieselbe Fahrt bekäme sonst je Variante einen anderen Key.
  if (mode === "TRAIN" || mode === "BUS") {
    const firstTransit = r.legs?.find((l) => !l.walking);
    const vehicleDep = roundToMinute(firstTransit?.departTime ?? r.departTime);
    const first = (r.flightNumber ?? r.operatedBy ?? "").toUpperCase();
    return `${mode.toLowerCase()}:${first}|${vehicleDep}|${route}`;
  }
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
