import Constants from "expo-constants";
import { Location, SearchParams, SearchResponse, TravelMode } from "@/types/search";

export const API_BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string })?.apiBaseUrl ?? "http://localhost:3000";

function buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
  const url = new URL(path, API_BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Default 20s timeout für Search-Calls, 8s für Locations/kleine Calls.
// Verhindert dass der Client minutenlang hängt wenn der Server unerreichbar ist.
async function getJson<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms — Server nicht erreichbar (${url})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Optionale Such-Flags. `nocache=1` umgeht den 2h-Server-Cache (für Refresh). */
export interface SearchOptions {
  nocache?: boolean;
  /** Pagination-Token aus einer vorherigen SearchResponse — für „Später"-
   *  Pagination bei TRAIN. Wenn gesetzt, umgeht der Server automatisch den
   *  Cache und ruft den Provider mit HAFAS-laterThan auf. */
  paginationToken?: string;
}

function searchParamsForApi(p: SearchParams, opt?: SearchOptions) {
  return {
    origin: p.origin,
    destination: p.destination,
    originLabel: p.originLabel,
    destLabel: p.destLabel,
    departDate: p.departDate,
    // returnDate + travelClass müssen mitgereicht werden, sonst ignoriert
    // der Server die Hin&Rück-Auswahl bzw. die Klasse komplett.
    ...(p.returnDate ? { returnDate: p.returnDate } : {}),
    ...(p.travelClass ? { travelClass: p.travelClass } : {}),
    // departTime nur durchreichen wenn explizit gesetzt (Surroundings-Tap).
    // Bei normaler Suche bleibt's leer → Server snapt auf Standard-Zeit.
    ...(p.departTime ? { departTime: p.departTime } : {}),
    passengers: p.passengers,
    currency: p.currency,
    ...(opt?.nocache ? { nocache: "1" } : {}),
    ...(opt?.paginationToken ? { paginationToken: opt.paginationToken } : {}),
  };
}

export function searchFlights(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  // 25s: die Flugsuche pollt die flaky API mehrfach (keep-best) + persistiert
  // viele Treffer → kann länger dauern als der 20s-Default. Loader läuft solange.
  return getJson("/api/search/flights", searchParamsForApi(p, opt), 25_000);
}

export function searchTrains(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  return getJson("/api/search/trains", searchParamsForApi(p, opt));
}

export function searchBuses(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  return getJson("/api/search/buses", searchParamsForApi(p, opt));
}

export function searchCruises(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  return getJson("/api/search/cruises", searchParamsForApi(p, opt));
}

export function searchByMode(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  if (p.mode === "FLIGHT") return searchFlights(p, opt);
  if (p.mode === "TRAIN") return searchTrains(p, opt);
  if (p.mode === "CRUISE") return searchCruises(p, opt);
  return searchBuses(p, opt);
}

export function fetchLocations(query: string, mode: TravelMode | "ALL" = "ALL"): Promise<Location[]> {
  // 15s Timeout: bei Cold-Start des Servers / parallelen Hintergrund-Imports
  // dauert die erste Antwort manchmal mehrere Sekunden. 8s war zu knapp.
  return getJson<{ results: Location[] }>("/api/locations", { q: query, mode }, 15_000).then(
    (r) => r.results ?? [],
  );
}

export type LocationByCode =
  | { code: string; label: string; exists: true }
  | { code: string; exists: false };

/** Batch-Lookup: holt für eine Liste von Codes den aktuellen Label-Stand aus
 *  der DB. Wenn ein Code nicht mehr existiert → `exists: false`. Wird beim
 *  App-Start für die Validierung persistierter Recent-Searches benutzt. */
export function fetchLocationsByCodes(codes: string[]): Promise<LocationByCode[]> {
  if (codes.length === 0) return Promise.resolve([]);
  return getJson<{ results: LocationByCode[] }>(
    "/api/locations/by-codes",
    { codes: codes.join(",") },
    10_000,
  ).then((r) => r.results ?? []);
}

export type SurroundingsKind = "train" | "subway" | "bus" | "tram" | "airport" | "cruise";
export type SurroundingsMode = "transit" | "airport" | "cruise";

export interface SurroundingsMarker {
  id: string;
  /** Dominante Mode-Kategorie — primary icon im Marker. */
  type: SurroundingsKind;
  /** Alle Mode-Kategorien die am Stop verkehren, sortiert nach Häufigkeit.
   *  Bei multi-modalen Stops (z.B. „Dortmund Barop Parkhaus": U-Bahn + Bus)
   *  rendert MarkerLayer eine breitere Pille mit beiden Icons nebeneinander. */
  kinds: SurroundingsKind[];
  latitude: number;
  longitude: number;
  selected?: boolean;
  label?: string;
}

export interface SurroundingsListItem {
  id: string;
  name: string;
  kinds: SurroundingsKind[];
  distance: string;
  lines?: { id: string; color: string }[];
  selected?: boolean;
}

export interface SurroundingsResponse {
  markers: SurroundingsMarker[];
  list: SurroundingsListItem[];
}

export interface TripPolylinesResponse {
  /** Map: tripId → Array von [lng, lat]-Coords entlang der Schienen. */
  polylines: Record<string, [number, number][]>;
}

/**
 * Lädt die geographischen Polylines (echte Schienen-/Straßen-Geometrie) für
 * eine Liste von HAFAS Trip-IDs. On-demand vom Frontend aufgerufen wenn der
 * User „Route anzeigen" klickt.
 */
export function fetchTripPolylines(tripIds: string[]): Promise<TripPolylinesResponse> {
  if (tripIds.length === 0) return Promise.resolve({ polylines: {} });
  return getJson<TripPolylinesResponse>(
    "/api/trips/polyline",
    { ids: tripIds.join(",") },
    15_000,
  );
}

/** Trip-Detail (genau ein Trip mit allen Stopovers) — wird von StopDetailSheet
 *  benutzt um beim Tap auf eine Bus-/Zug-Abfahrt direkt die LegTimeline zu
 *  öffnen, ohne den Booking-DetailsOverlay zu durchlaufen. Viel billiger als
 *  ein voller `/api/search/...`-Call: HAFAS macht hier kein Routing. */
export interface TripDetailResponse {
  id: string;
  mode: "TRAIN" | "BUS";
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departTime: string;
  arriveTime: string;
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  line?: string;
  product?: string;
  fahrtNr?: string;
  direction?: string;
  originTz?: string;
  destinationTz?: string;
  legs: Array<{
    origin: string;
    destination: string;
    originLabel?: string;
    destLabel?: string;
    originLat?: number;
    originLng?: number;
    destLat?: number;
    destLng?: number;
    departTime: string;
    arriveTime: string;
    durationMinutes: number;
    departPlatform?: string;
    arrivePlatform?: string;
    line?: string;
    product?: string;
    fahrtNr?: string;
    direction?: string;
    stops?: number;
    stopovers?: Array<{
      name?: string;
      arrival?: string;
      departure?: string;
      platform?: string;
    }>;
    tripId?: string;
  }>;
}

export function fetchTripDetail(
  tripId: string,
  opts: { fromStopId?: string; fromStopLabel?: string; stopCode?: string; direction?: string } = {},
): Promise<TripDetailResponse> {
  // tripId muss als Query-Param gesendet werden — Path-Param funktioniert
  // nicht weil HAFAS-IDs `#`/`|`/Padding-Spaces enthalten, an denen Fastify's
  // Router scheitert. URL-Builder kodiert den Query-Wert sauber.
  //   fromStopId    — optionaler HAFAS-Stop-Id-Filter, slicet Stops auf
  //                   User-Halt bis Endstation.
  //   fromStopLabel — Name des User-Halts als Fallback wenn die ID nicht in
  //                   den Trip-Stopovers matched (passiert bei BVG/VBB-Bus-
  //                   Stops wo lokale IDs nicht mit HAFAS-Trip-Body IDs
  //                   übereinstimmen).
  //   stopCode      — interner Stop-Code (`gtfs:at:…`, `sta:…`, …). Daraus
  //                   leitet der Server das HAFAS-Profil ab.
  return getJson<TripDetailResponse>(
    "/api/trips/detail",
    {
      tripId,
      ...(opts.fromStopId ? { fromStopId: opts.fromStopId } : {}),
      ...(opts.fromStopLabel ? { fromStopLabel: opts.fromStopLabel } : {}),
      ...(opts.stopCode ? { stopCode: opts.stopCode } : {}),
      ...(opts.direction ? { direction: opts.direction } : {}),
    },
    12_000,
  );
}

export function fetchSurroundings(input: {
  latitude: number;
  longitude: number;
  distance?: number;
  mode: SurroundingsMode;
  limit?: number;
  /** Aktuelles Zoom-Level der Karte — Backend filtert Stop-Kategorien danach. */
  zoom?: number;
}): Promise<SurroundingsResponse> {
  return getJson<SurroundingsResponse>(
    "/api/surroundings",
    {
      latitude: input.latitude,
      longitude: input.longitude,
      distance: input.distance ?? 1500,
      mode: input.mode,
      limit: input.limit ?? 60,
      zoom: input.zoom,
    },
    10_000,
  );
}

export interface StopBoardItem {
  id: string;
  plannedTime: string;
  actualTime: string | null;
  delayMinutes: number | null;
  line: string;
  product: string | null;
  direction: string;
  platform: string | null;
  cancelled: boolean;
}

export interface StopBoardResponse {
  results: StopBoardItem[];
  fetchedAt: string;
  validUntil: string;
  stop: { code: string; label: string; hafasId: string | null };
}

export function fetchStopDepartures(code: string): Promise<StopBoardResponse> {
  return getJson<StopBoardResponse>(`/api/stops/${encodeURIComponent(code)}/departures`, undefined, 10_000);
}

export function fetchStopArrivals(code: string): Promise<StopBoardResponse> {
  return getJson<StopBoardResponse>(`/api/stops/${encodeURIComponent(code)}/arrivals`, undefined, 10_000);
}

/**
 * Buchungs-Redirect. `locale` bringt den User in der Sprache der App auf die
 * Anbieter-Seite (FlixBus: shop.flixbus.de statt shop.global.flixbus.com).
 *
 * Die Sprache geht bewusst ERST hier mit, nicht schon in die Suche: Der Deeplink
 * wird serverseitig zusammen mit dem Ergebnis gecacht, und die Sprache im
 * Cache-Key hätte den Cache je Sprache vervierfacht — auch bei den Flügen, wo
 * das Anbieter-Kontingent knapp ist. Der Server lokalisiert den Link beim
 * Weiterleiten (routes/redirect.ts).
 */
export function redirectUrl(token: string, locale?: string): string {
  const base = `${API_BASE_URL}/redirect/${token}`;
  return locale ? `${base}?lang=${encodeURIComponent(locale)}` : base;
}

export interface FlightBookingOption {
  name: string;
  code?: string;
  website?: string;
  price?: number;
  currency?: string;
  isAirline?: boolean;
  /** Per-Anbieter-Token. Client baut daraus die URL für `Linking.openURL`:
   *  `${API_BASE_URL}/api/flights/booking-url?token=...`.
   *  Server resolved den Token zu RapidAPI und 302-redirected zum Anbieter. */
  providerToken: string;
  /** Bereits serverseitig aufgelöster Direkt-Deeplink (enthält den echten
   *  Website-Preis). Wenn gesetzt, öffnet der Client diesen direkt statt den
   *  token-basierten Redirect-Umweg zu gehen. */
  resolvedUrl?: string;
}

export interface FlightBookingOptionsResponse {
  options: FlightBookingOption[];
}

export function flightBookingUrl(providerToken: string): string {
  return `${API_BASE_URL}/api/flights/booking-url?token=${encodeURIComponent(providerToken)}`;
}

/** Holt alle Anbieter-Optionen für einen Google-Flights `bookingToken`.
 *  Wird vom DetailsOverlay beim Öffnen aufgerufen (Flight-Mode + Token). */
export function fetchFlightBookingOptions(input: {
  token: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  passengers?: number;
  currency?: string;
  /** App-Sprache (de/en/fr/es) — Anbieter-Deeplinks öffnen in dieser Sprache. */
  lang?: string;
  /** Card-/Suchpreis dieses Flugs — Detail-Günstigster wird darauf gesnappt. */
  searchPrice?: number;
}): Promise<FlightBookingOptionsResponse> {
  const params = new URLSearchParams({
    token: input.token,
    origin: input.origin,
    destination: input.destination,
    departDate: input.departDate,
  });
  if (input.returnDate) params.set("returnDate", input.returnDate);
  if (input.passengers !== undefined) params.set("passengers", String(input.passengers));
  if (input.currency) params.set("currency", input.currency);
  if (input.lang) params.set("lang", input.lang);
  if (input.searchPrice !== undefined && input.searchPrice > 0) {
    params.set("searchPrice", String(input.searchPrice));
  }
  // 18s: die google-flights2-API ist flaky (liefert denselben Token mal leer,
  // mal „Invalid"), daher retryt der Server mehrfach (RETRY_ATTEMPTS) + löst
  // Deeplinks auf. Das braucht im Worst Case >12s — lieber etwas länger laden
  // (Skeletons) als auf den Single-Provider-Fallback zu kippen.
  return getJson<FlightBookingOptionsResponse>(`/api/flights/booking-options?${params.toString()}`, undefined, 18_000);
}

export interface ParsedTicketResponse {
  fields: {
    mode?: "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
    carrier?: string;
    flightNumber?: string;
    fromCode?: string;
    fromCity?: string;
    fromStation?: string;
    toCode?: string;
    toCity?: string;
    toStation?: string;
    departTime?: string;
    arriveTime?: string;
    durationMinutes?: number;
    passenger?: string;
    seat?: string;
    wagon?: string;
    travelClass?: string;
    bookingRef?: string;
  };
  pageImage: string;
  pageWidth: number;
  pageHeight: number;
  pageCount: number;
  originalName?: string;
  /** Aus dem PDF rausgeschnittenes Original-Code-Bild (QR/Aztec/Barcode).
   *  Bit-genau gecroppt aus dem Page-PNG — NICHT regeneriert, also scanbar.
   *  null wenn Vision den Code nicht lokalisieren konnte. */
  codeImage?: string | null;
  /** Form-Faktor des Codes — bestimmt das Aspect-Ratio im Detail-Screen. */
  codeType?: "qr" | "barcode" | null;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarDataUrl: string | null;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

async function postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
  const url = buildUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = (j && typeof j === "object" && "error" in j ? String(j.error) : "") || "";
    } catch {
      /* ignore */
    }
    throw new Error(detail || `API ${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function authCheckEmail(email: string): Promise<{ exists: boolean }> {
  return postJson("/api/auth/check-email", { email });
}

export function authRegister(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}): Promise<AuthResponse> {
  return postJson("/api/auth/register", input);
}

export function authLogin(input: { email: string; password: string }): Promise<AuthResponse> {
  return postJson("/api/auth/login", input);
}

export function authLogout(token: string): Promise<void> {
  return postJson<void>("/api/auth/logout", {}, token);
}

export async function authMe(token: string): Promise<AuthUser> {
  const url = buildUrl("/api/auth/me");
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
  const j = (await res.json()) as { user: AuthUser };
  return j.user;
}

export async function authUpdateAvatar(
  token: string,
  dataUrl: string | null,
): Promise<AuthUser> {
  const url = buildUrl("/api/auth/avatar");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) {
    let msg = `API ${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && typeof j === "object" && "error" in j) msg = String(j.error);
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const j = (await res.json()) as { user: AuthUser };
  return j.user;
}

/** Error mit HTTP-Status — Caller unterscheidet 401 (Login nötig) und
 *  429 (Konto-Tageslimit) von generischen Parse-Fehlern. */
export class TicketParseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TicketParseError";
  }
}

export async function parseTicketPdf(
  uri: string,
  name: string,
  mimeType = "application/pdf",
  token?: string | null,
): Promise<ParsedTicketResponse> {
  const url = `${API_BASE_URL}/api/tickets/parse`;
  const form = new FormData();
  form.append("file", {
    uri,
    name,
    type: mimeType,
  } as unknown as Blob);

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TicketParseError(
      `API ${res.status} ${res.statusText} for ${url}${txt ? ` :: ${txt}` : ""}`,
      res.status,
    );
  }
  return (await res.json()) as ParsedTicketResponse;
}
