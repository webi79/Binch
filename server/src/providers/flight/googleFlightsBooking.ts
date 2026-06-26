import { config } from "../../config.js";
import type { BookingContext } from "../../services/tokenService.js";

const RAPIDAPI_HOST = "google-flights2.p.rapidapi.com";
const DETAILS_URL = `https://${RAPIDAPI_HOST}/api/v1/getBookingDetails`;
const URL_URL = `https://${RAPIDAPI_HOST}/api/v1/getBookingURL`;

interface RawProvider {
  id?: string;
  title?: string;
  website?: string;
  price?: number;
  is_airline?: boolean;
  token?: string;
  bookings?: unknown;
}

interface DetailsResponse {
  status?: boolean;
  data?: RawProvider[];
  bag_info?: unknown;
}

interface UrlResponse {
  status?: boolean;
  data?: string;
}

/**
 * Single Buchungs-Option (1 Anbieter) zu einem Flug-Itinerary.
 *
 * `providerToken` ist NICHT der Search-Token sondern ein per-Anbieter-Token den
 * Google Flights pro Provider ausstellt. Der Client schickt ihn zurück an
 * unseren `/api/flights/booking-url`-Endpoint sobald der User „Zur Seite" tippt,
 * und wir resolven ihn DANN erst zum echten Deeplink (= 1 RapidAPI-Call pro
 * Klick statt N Klicks-Worth pro Sheet-Open).
 */
export interface FlightBookingOption {
  /** Anbieter-Name aus der Google-Flights-Response (Eurowings, Booking.com, Expedia, …). */
  name: string;
  /** Anbieter-Kurzcode (EW, BOOKING, EXPEDIA, KIWI, …). */
  code?: string;
  /** Domain für Logo-Inferenz und Anzeige. */
  website?: string;
  /** Preis in der angefragten Währung. */
  price?: number;
  currency?: string;
  /** True wenn der Anbieter die Fluggesellschaft selbst ist. */
  isAirline?: boolean;
  /** Token den der Client an `/api/flights/booking-url` schickt um den
   *  Deeplink zu resolven. NICHT der Search-Token. */
  providerToken: string;
  /** Bereits aufgelöster finaler Buchungs-Deeplink (inkl. Website-Preis). Wird
   *  serverseitig beim Sheet-Open mitaufgelöst, damit `price` der echte
   *  Anbieterpreis ist und der Client direkt dorthin springen kann. */
  resolvedUrl?: string;
}

const COMMON_HEADERS = () => ({
  "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
  "x-rapidapi-host": RAPIDAPI_HOST,
});

/** Per-Versuch-Timeout für RapidAPI-Calls. Bewusst knapp (statt 12s) gehalten,
 *  damit bis zu RETRY_ATTEMPTS Versuche + Backoff noch komfortabel in das 12s-
 *  Timeout passen, das der Client (getJson) auf die booking-options-Route legt.
 *  Normale Antworten kommen in <1s; ein einzelner träger Versuch wird so nach
 *  8s abgebrochen statt die ganze Retry-Kette zu blockieren. */
const FETCH_TIMEOUT_MS = 6_000;
// Kürzeres Timeout fürs parallele Deeplink-Auflösen: ein einzelner träger
// Anbieter soll nicht das ganze Sheet-Open blockieren (Promise wartet sonst
// auf den langsamsten). Lieber Fallback-Preis als Hänger.
const RESOLVE_TIMEOUT_MS = 4_500;

function fetchWithTimeout(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

/**
 * Free-Plan-Resilienz für `google-flights2`. Der Anbieter drosselt auf dem
 * RapidAPI-Free-Plan (150 req/Monat) LAUTLOS: statt eines Fehlers liefert er
 * HTTP 200 + `status: true` + `data: []` (leeres Array). Für den User sieht das
 * aus wie „nur ein Provider, lädt aber nichts" + Redirect zur Google-Flights-
 * Suchseite (weil ohne Optionen kein Direkt-Deeplink auflösbar ist).
 *
 * Zwei Gegenmaßnahmen:
 *   1. Retry-mit-Backoff: ein leeres `data` wird als transientes Throttling
 *      gewertet und nach kurzem Delay erneut versucht — in der Praxis liefert
 *      der 2./3. Versuch dann die volle Provider-Liste.
 *   2. In-Memory-Cache (2h): einmal erfolgreich aufgelöste Optionen werden pro
 *      bookingToken gecacht. So verbrennt ein erneutes Öffnen desselben Flugs
 *      KEIN weiteres Quota, und der /redirect-Pfad (der via
 *      resolveFlightBookingUrl dieselben Optionen nochmal braucht) übersteht
 *      eine spätere Drossel-Phase. Bewusst lang (2h) wegen des 150-req/Monat-
 *      Free-Plans — Quota-Sparen schlägt Minuten-frische Preise.
 *
 *      Tradeoff: die in den Optionen enthaltenen Provider-Tokens sind Google-
 *      seitig kurzlebig (~Minuten–1h). Innerhalb der 2h bleibt die Anbieter-
 *      ANZEIGE (Name/Preis) gültig; der „Zur Seite"-Direktlink kann nach Ablauf
 *      des Provider-Tokens aber nicht mehr auflösbar sein → /redirect fällt
 *      dann auf den deepLink (Google-Flights-Suchseite) zurück.
 */
// Die google-flights2-API ist NICHT-deterministisch: derselbe gültige
// booking_token liefert mal Provider, mal `Invalid booking_token`, mal leer —
// Sekunden auseinander, OHNE Rate-Limit (per Pro-Plan bestätigt). Mehr Versuche
// = öfter ein „guter" Moment = seltener eine leere Provider-Liste. Da die
// Deeplink-Auflösung jetzt PARALLEL läuft (~2-4s statt früher serialisiert ~9s),
// ist Budget frei: 5 Versuche (realistisch ~1.5s je leerer/Invalid-Antwort +
// Backoff ≈ 9s) + parallele Auflösung passen komfortabel ins 18s-Client-Timeout.
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_MS = 350;
// 10min: kurz genug, dass Preise frisch bleiben (Flugpreise + booking_token-
// Gültigkeit ändern sich schnell), lang genug, dass wiederholtes Öffnen
// desselben Flugs nicht jedes Mal Quota verbrennt. Vorher 2h — das konnte
// veraltete Preise/Tokens servieren.
const OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
const OPTIONS_CACHE_MAX = 500;
// Sicherheits-Cap für die Anzahl parallel aufgelöster Anbieter. Wir lösen ALLE
// angezeigten Anbieter auf (echter Website-Preis + funktionierender Direkt-Link
// — sonst läuft der Token bis zum Tap ab). Kein Rate-/Burst-Limit (Pro-Plan) →
// parallel. Empirisch liefert die API max. ~11-13 Anbieter pro Flug; mit 30 ist
// der Cap praktisch nie wirksam und reduziert die Anzahl garantiert nicht.
const MAX_RESOLVE = 30;
// Empirisch sehr konsistenter Aufschlag-Faktor (getBookingDetails-Preis liegt
// ~15 % über dem echten Website-Preis → ×0.87). Wird NUR als Fallback genutzt,
// wenn KEIN Anbieter einen echten Website-Preis liefert (z.B. nur die Airline
// kommt zurück), sodass auch dann nicht der aufgeblähte Preis angezeigt wird.
// Bevorzugt wird immer der dynamisch gemessene Faktor.
const FALLBACK_PRICE_RATIO = 0.87;

interface CachedOptions {
  options: FlightBookingOption[];
  expiresAt: number;
}
const optionsCache = new Map<string, CachedOptions>();

function optionsCacheKey(bookingToken: string, ctx: BookingContext): string {
  return `${bookingToken}|${ctx.passengers ?? 1}|${(ctx.currency ?? "EUR").toUpperCase()}`;
}

function readOptionsCache(key: string): FlightBookingOption[] | null {
  const hit = optionsCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    optionsCache.delete(key);
    return null;
  }
  return hit.options;
}

function writeOptionsCache(key: string, options: FlightBookingOption[]): void {
  // Harte Größen-Obergrenze (FIFO: ältesten Insert rauswerfen). Bei 150
  // req/Monat bleibt der Cache winzig — der Guard ist nur Sicherheitsnetz.
  if (optionsCache.size >= OPTIONS_CACHE_MAX) {
    const oldest = optionsCache.keys().next().value;
    if (oldest !== undefined) optionsCache.delete(oldest);
  }
  optionsCache.set(key, { options, expiresAt: Date.now() + OPTIONS_CACHE_TTL_MS });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Liest den ECHTEN Website-Preis aus einem aufgelösten Buchungs-Deeplink.
 *
 * Hintergrund: `getBookingDetails.price` ist Googles Buchungs-Panel-Schätzung
 * und liegt konsistent ~15 % ÜBER dem Preis, den der Anbieter tatsächlich auf
 * seiner Seite zeigt. Google bettet den real angezeigten Preis aber in den
 * Deeplink ein — je nach Anbieter unter `DisplayedPrice` (die meisten OTAs),
 * `tpr` (Vueling) o.ä. So bekommen wir „In-App-Preis == Website-Preis".
 *
 * Airline-Direct-Deeplinks (eurowings.com etc.) haben oft KEINEN Preis in der
 * URL → undefined, dann behalten wir den getBookingDetails-Preis als Fallback.
 */
function extractDisplayedPrice(url: string, wantCurrency: string): number | undefined {
  const want = wantCurrency.toUpperCase();
  const num = (s: string) => {
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  // Die meisten OTAs: DisplayedPrice + DisplayedPriceCurrency. ACHTUNG: manche
  // (lastminute, Gotogate) betten den Preis in USD ein, obwohl UserCurrency=EUR
  // — den dürfen wir NICHT als EUR anzeigen. Nur verwenden wenn die Währung
  // passt (oder keine angegeben ist).
  const dp = url.match(/[?&]DisplayedPrice=([0-9]+(?:[.,][0-9]+)?)/i);
  if (dp) {
    const cur = url.match(/[?&]DisplayedPriceCurrency=([A-Za-z]{3})/i)?.[1]?.toUpperCase();
    return !cur || cur === want ? num(dp[1]!) : undefined;
  }
  // Vueling u.a.: tpr + cur.
  const tpr = url.match(/[?&]tpr=([0-9]+(?:[.,][0-9]+)?)/i);
  if (tpr) {
    const cur = url.match(/[?&]cur=([A-Za-z]{3})/i)?.[1]?.toUpperCase();
    return !cur || cur === want ? num(tpr[1]!) : undefined;
  }
  return undefined;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Einzel-Versuch-Variante von `getFlightBookingUrl` (ohne Retry) — für das
 * parallele Auflösen ALLER Anbieter beim Sheet-Open. Mit Retry würde N Anbieter
 * × 3 Versuche zu viele Calls/Latenz erzeugen; ein Fehlschlag pro Anbieter ist
 * unkritisch (dann Fallback auf getBookingDetails-Preis + token-basierte URL).
 */
async function resolveBookingUrlOnce(providerToken: string): Promise<string | null> {
  if (!config.RAPIDAPI_KEY || !providerToken) return null;
  try {
    const res = await fetchWithTimeout(
      URL_URL,
      {
        method: "POST",
        headers: { ...COMMON_HEADERS(), "Content-Type": "application/json" },
        body: JSON.stringify({ token: providerToken }),
      },
      RESOLVE_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as UrlResponse;
    if (!data.status || typeof data.data !== "string" || !data.data.startsWith("http")) {
      return null;
    }
    return data.data;
  } catch {
    return null;
  }
}

/**
 * Holt alle Buchungs-Anbieter für ein Google-Flights-Search-`booking_token`.
 *
 * Hinweise:
 *   - Die API liefert i.d.R. 15-25 Anbieter (Airline-Direct + OTAs).
 *   - Tokens haben eine kurze TTL (Search-Token ~10min). Bei Cache-Hits aus
 *     unserer 10min-TTL-Welt können sie bereits abgelaufen sein → leere Liste.
 *   - Wir geben NUR die Provider-Tokens an den Client weiter, keine URLs.
 *     URLs werden erst on-demand beim „Zur Seite"-Tap aufgelöst (siehe
 *     `getFlightBookingUrl`). Das spart bei 20+ Anbietern massiv Kosten.
 */
export async function getFlightBookingOptions(
  bookingToken: string,
  ctx: BookingContext,
): Promise<FlightBookingOption[]> {
  if (!config.RAPIDAPI_KEY) return [];
  if (!ctx.origin || !ctx.destination || !ctx.departDate) return [];

  const cacheKey = optionsCacheKey(bookingToken, ctx);
  const cached = readOptionsCache(cacheKey);
  if (cached) return cached;

  const url = new URL(DETAILS_URL);
  url.searchParams.set("departure_id", ctx.origin);
  url.searchParams.set("arrival_id", ctx.destination);
  url.searchParams.set("outbound_date", ctx.departDate);
  if (ctx.returnDate) url.searchParams.set("return_date", ctx.returnDate);
  url.searchParams.set("adults", String(ctx.passengers ?? 1));
  url.searchParams.set("currency", (ctx.currency ?? "EUR").toUpperCase());
  url.searchParams.set("travel_class", "ECONOMY");
  url.searchParams.set("type", ctx.returnDate ? "1" : "2");
  url.searchParams.set("booking_token", bookingToken);

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    // Linearer Backoff zwischen den Versuchen (0ms, 600ms, 1200ms) — gibt der
    // Free-Plan-Drossel Zeit, sich zu lösen, ohne das 12s-Client-Timeout zu
    // sprengen.
    if (attempt > 0) await sleep(RETRY_BASE_MS * attempt);

    let res: Response;
    try {
      res = await fetchWithTimeout(url, { method: "GET", headers: COMMON_HEADERS() });
    } catch {
      continue; // Netzwerk/Timeout → nächster Versuch
    }
    if (!res.ok) continue;

    let data: DetailsResponse;
    try {
      data = (await res.json()) as DetailsResponse;
    } catch {
      continue;
    }
    if (!data.status || !Array.isArray(data.data)) continue;

    const out: FlightBookingOption[] = [];
    const seenTokens = new Set<string>();
    for (const p of data.data) {
      if (!p.token || !p.title) continue;
      if (seenTokens.has(p.token)) continue;
      seenTokens.add(p.token);
      out.push({
        name: p.title,
        code: p.id,
        website: p.website,
        price: typeof p.price === "number" ? p.price : undefined,
        currency: (ctx.currency ?? "EUR").toUpperCase(),
        isAirline: p.is_airline === true,
        providerToken: p.token,
      });
    }

    // Leeres `data` trotz HTTP 200 = stille Free-Plan-Drossel → retry.
    if (out.length === 0) continue;

    // Dedup nach Anbieter-NAME (zusätzlich zur Token-Dedup): getBookingDetails
    // liefert denselben Anbieter oft MEHRFACH mit verschiedenen Fares/Preisen
    // (z.B. Turkish Airlines 4×: 207/229/247/271€ — gleicher Name, andere Tokens).
    // Ungefiltert sieht der User 5× denselben Namen, und echte andere Anbieter
    // gehen optisch unter. Wir behalten pro Name den GÜNSTIGSTEN Eintrag — der
    // Klick führt zur Anbieterseite, wo die übrigen Fare-Optionen stehen.
    const byName = new Map<string, FlightBookingOption>();
    for (const o of out) {
      const k = o.name.trim().toLowerCase();
      const prev = byName.get(k);
      const op = typeof o.price === "number" ? o.price : Infinity;
      const pp = prev && typeof prev.price === "number" ? prev.price : Infinity;
      if (!prev || op < pp) byName.set(k, o);
    }
    const providers = Array.from(byName.values());

    // JEDEN angezeigten Anbieter beim Öffnen auflösen → echter Website-Preis
    // (DisplayedPrice/tpr) UND ein bereits aufgelöster `resolvedUrl`. Kritisch:
    // nur so funktioniert der Deeplink zuverlässig — der per-Anbieter-Token ist
    // KURZLEBIG; löst der Client ihn erst beim Tap auf, ist er oft abgelaufen
    // („Could not resolve booking URL – token may be expired"). Indem wir hier
    // (Token frisch) alle auflösen, geben wir fertige URLs raus. Kein Rate-Limit
    // (Pro-Plan) → alle parallel; 10min-Cache → kein Re-Resolve beim erneuten
    // Öffnen. MAX_RESOLVE deckelt nur pathologisch viele Anbieter. Deeplink NICHT
    // umschreiben (signierte Base64-Tokens → URL-Round-Trip korrumpiert sie).
    providers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const toResolve = providers.slice(0, MAX_RESOLVE);
    const want = (ctx.currency ?? "EUR").toUpperCase();

    const resolved = await Promise.all(toResolve.map(async (o) => {
      const resolvedUrl = await resolveBookingUrlOnce(o.providerToken);
      const displayed = resolvedUrl ? extractDisplayedPrice(resolvedUrl, want) : undefined;
      return { o, resolvedUrl, displayed, raw: o.price };
    }));

    // Korrektur-Faktor (Median Website-Preis / getBookingDetails-Preis ~0.87)
    // für Anbieter ohne echten Website-Preis (Airlines ohne URL-Preis /
    // USD-Deeplinks). Erst ab 2 Messpunkten dynamisch (#3: einzelner Messpunkt
    // schwankt zu stark), sonst stabiler empirischer Fallback.
    const ratios = resolved
      .filter((r) => r.displayed !== undefined && typeof r.raw === "number" && r.raw > 0)
      .map((r) => r.displayed! / (r.raw as number));
    const ratio = ratios.length >= 2 ? median(ratios) : FALLBACK_PRICE_RATIO;

    // `_exact` = Preis aus echtem DisplayedPrice (vs. geschätzt) — intern fürs
    // searchPrice-Snapping (#1). Vor der Rückgabe entfernt.
    type Enriched = FlightBookingOption & { _exact: boolean };
    const enriched: Enriched[] = resolved.map((r) => ({
      ...r.o,
      price:
        r.displayed ??
        (typeof r.raw === "number" ? Math.round(r.raw * ratio) : r.raw),
      resolvedUrl: r.resolvedUrl ?? undefined,
      _exact: r.displayed !== undefined,
    }));

    // KEIN Ausreißer-Filter mehr: wir zeigen ALLE Anbieter wie Google. Da jetzt
    // jeder Anbieter seinen ECHTEN Website-Preis hat (alle aufgelöst), ist auch
    // ein teurer Premium-Reseller eine legitime Option, die Google ebenfalls
    // listet. Der frühere 2.5×-Filter hat auf Strecken mit breiter Preisspanne
    // legit Anbieter rausgeworfen → wir zeigten weniger als Google.

    // #1 (Kernfix): Detail-Günstigster == Card-Preis. `ctx.searchPrice`
    // (= it.price = Card) ist Googles verlässlicher Günstigster (meist die
    // Airline-Direct-Fare). Ist der günstigste Anbieter NUR faktor-geschätzt
    // (kein echter Website-Preis) UND nah am searchPrice (<25% Abweichung = es
    // ist dieselbe Option, nur geschätzt), snappen wir ihn EXAKT auf den
    // searchPrice → Detail zeigt denselben Preis wie das Suchergebnis (behebt
    // „beim Klick steht ein anderer Preis"). Bei großer Abweichung (Scraper-
    // Subset ohne den günstigen Anbieter) NICHT snappen — dann ist die Lücke
    // echt und wir verfälschen nichts.
    const sp = ctx.searchPrice;
    if (typeof sp === "number" && sp > 0 && enriched.length > 0) {
      let idx = 0;
      for (let i = 1; i < enriched.length; i++) {
        const pi = enriched[i]!.price;
        const pm = enriched[idx]!.price;
        if (typeof pi === "number" && (typeof pm !== "number" || pi < pm)) idx = i;
      }
      const cheapest = enriched[idx]!;
      if (
        !cheapest._exact &&
        typeof cheapest.price === "number" &&
        Math.abs(cheapest.price - sp) / sp < 0.25
      ) {
        enriched[idx] = { ...cheapest, price: sp };
      }
    }

    // _exact ist intern — vor Cache/Rückgabe entfernen.
    const final: FlightBookingOption[] = enriched.map(({ _exact, ...o }) => o);
    writeOptionsCache(cacheKey, final);
    return final;
  }

  // #2: Sichtbarkeit — nach allen Retries kein verwertbares Ergebnis. Echte
  // HTTP-/Netzwerk-Fehler werden in der Route geloggt; hier machen wir das
  // „lautlose Leer" sichtbar, damit es in den Logs von einem echten „nur
  // Airline" unterscheidbar ist.
  console.warn(
    `[booking-options] empty after ${RETRY_ATTEMPTS} attempts for token ${bookingToken.slice(0, 12)}…`,
  );
  return [];
}

/**
 * Resolves einen einzelnen Provider-Token in den finalen Booking-Deeplink.
 * Wird vom Client per `/api/flights/booking-url`-Redirect-Endpoint genutzt:
 *   User klickt „Zur Seite" → Client öffnet unseren Redirect-Endpoint →
 *   Server ruft hier auf → 302 zum Anbieter.
 */
export async function getFlightBookingUrl(providerToken: string): Promise<string | null> {
  if (!config.RAPIDAPI_KEY) return null;
  if (!providerToken) return null;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_MS * attempt);

    let res: Response;
    try {
      res = await fetchWithTimeout(URL_URL, {
        method: "POST",
        headers: { ...COMMON_HEADERS(), "Content-Type": "application/json" },
        body: JSON.stringify({ token: providerToken }),
      });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    let data: UrlResponse;
    try {
      data = (await res.json()) as UrlResponse;
    } catch {
      continue;
    }
    // Kein verwertbarer Deeplink (leer / kein http) = Drossel oder abgelaufener
    // Provider-Token → retry; bei dauerhaftem Fehlschlag fällt /redirect auf
    // den deepLink zurück.
    if (!data.status || typeof data.data !== "string" || !data.data.startsWith("http")) {
      continue;
    }
    return data.data;
  }

  return null;
}

/**
 * Backwards-compatible: liefert ersten Provider-Deeplink für den
 * /redirect/:token-Pfad (Standard-„Zur Seite"-Button auf nicht-Flug-Pfaden
 * bzw. wenn der Client noch das alte Token-Modell nutzt).
 */
export async function resolveFlightBookingUrl(
  bookingToken: string,
  ctx: BookingContext,
): Promise<string | null> {
  const options = await getFlightBookingOptions(bookingToken, ctx);
  if (options.length === 0) return null;
  const first = options[0]!;
  return getFlightBookingUrl(first.providerToken);
}
