import Constants from "expo-constants";
import { Location, SearchParams, SearchResponse, TravelMode } from "@/types/search";

export const API_BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string })?.apiBaseUrl ?? "http://localhost:3000";

/**
 * Adressen im eigenen Netz — dort ist http die einzige realistische Option,
 * weil man für eine LAN-IP kein gültiges Zertifikat bekommt.
 *
 * Bewusst eng: nur die drei privaten IPv4-Bereiche (RFC 1918), Loopback und die
 * Emulator-Adressen. Ein öffentlicher Hostname passt hier NIE — eine versehentlich
 * auf http stehende Produktions-Domain scheitert also weiterhin laut.
 */
function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  // Android-Emulator: 10.0.2.2 = Host-Rechner, 10.0.3.2 = Genymotion.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

// Defense-in-Depth gegen unverschlüsselten Transport: Ein PRODUKTIONS-Build darf
// niemals über http:// sprechen — dort reisen Login-Passwort, Bearer-Token,
// Suchen, Chat und Ticket-PDFs für jeden im Netz mitlesbar. Eine http-URL auf
// eine öffentliche Domain ist ein Fehlkonfigurations-Unfall, der LAUT scheitern
// soll (Startup-Crash mit klarer Meldung) statt still Klartext zu senden.
//
// Ausgenommen bleibt der Server im eigenen Netz: Dafür war die Regel nie gedacht
// (siehe isPrivateHost). Vorher hing die Ausnahme allein an `__DEV__` — damit
// konnte ein Release-Build auf dem Gerät gar nicht mehr mit dem lokalen Backend
// reden, obwohl genau das der Testfall ist. Das Schutzziel bleibt: Klartext ins
// offene Internet ist weiterhin ein harter Fehler.
if (!__DEV__ && API_BASE_URL.startsWith("http://") && !isPrivateHost(API_BASE_URL)) {
  throw new Error(
    `[binch] Unsicherer API-Base im Release-Build: ${API_BASE_URL}. ` +
      `Produktion MUSS https:// nutzen (Caddy-Proxy). ` +
      `EXPO_PUBLIC_API_BASE_URL auf die https-Domain setzen.`,
  );
}

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
/**
 * `fetch` mit Zeitgrenze — für ALLE Aufrufe, nicht nur die lesenden.
 *
 * `getJson` hatte eine, die schreibenden Pfade (Login, Avatar, Ticket-Upload)
 * nicht. Bei totem oder langsamem Backend hingen die unbegrenzt. Im schlimmsten
 * Fall beim Ticket-Upload: Der Dialog setzt dabei `busy`, und das deaktiviert
 * gleichzeitig Wisch-Geste und Hintergrund-Tipp — das Blatt klebte dann auf dem
 * Ladekreis, und der einzige Ausweg war die Hardware-Zurück-Taste.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    /**
     * Der Zeitgeber LÄUFT WEITER — und zwar absichtlich.
     *
     * Hier stand ein `finally { clearTimeout(timer) }` mit dem Kommentar, es
     * greife „erst nach dem `await` der Aufrufer". Das stimmt nicht: Ein
     * `finally` läuft beim Verlassen DIESER Funktion, also bevor irgendein
     * Aufrufer `res.json()` überhaupt anfasst. Die Uhr war damit genau in dem
     * Abschnitt aus, den sie schützen sollte — ein Server, der Kopfzeilen sendet
     * und den Rumpf stehen lässt, hing weiterhin unbegrenzt. Genau der Fall, den
     * der Kommentar über dieser Funktion als Grund nennt („das Blatt klebte auf
     * dem Ladekreis").
     *
     * Ohne Löschen deckt das Signal auch das Lesen des Rumpfes ab. Der Zeitgeber
     * feuert nach einer erfolgreichen Antwort trotzdem noch einmal ins Leere —
     * `abort()` auf eine bereits gelesene Antwort tut nichts. Das ist der Preis:
     * ein anhängiger Zeitgeber je Anfrage, höchstens für die Dauer der
     * Zeitgrenze.
     *
     * Ein abgebrochenes Lesen meldet sich beim Aufrufer als roher `AbortError`,
     * nicht mit dem freundlichen Text unten — der ist nur für den Abbruch beim
     * Verbindungsaufbau erreichbar. Unschön, aber allemal besser als ein Aufruf,
     * der nie zurückkommt.
     */
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms — Server nicht erreichbar (${url})`);
    }
    throw err;
  }
}

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
  /** Nur Flüge: auf nahegelegene Flughäfen ausweichen. Wird ausschließlich
   *  gesetzt, wenn der Nutzer das im Leerzustand ausdrücklich anfordert —
   *  ungefragt untergeschobene Alternativen wären irreführend. */
  nearby?: boolean;
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
    ...(opt?.nearby ? { nearby: "1" } : {}),
    ...(opt?.paginationToken ? { paginationToken: opt.paginationToken } : {}),
  };
}

export function searchFlights(p: SearchParams, opt?: SearchOptions): Promise<SearchResponse> {
  // 60s: Die Flugsuche zieht mehrere Stichproben (die Datenquelle liefert
  // sporadisch leere Antworten) und weicht bei Flughäfen ohne Linienverkehr
  // zusätzlich auf den nächstgelegenen aus — nachgemessen z.B. Bern→Tel Aviv
  // 44s bis zu 72 Treffern ab Basel. Mit den bisherigen 25s brach der Client
  // genau dann ab und zeigte „keine Verbindungen", obwohl der Server längst
  // Ergebnisse hatte. Solange läuft der Such-Loader.
  return getJson("/api/search/flights", searchParamsForApi(p, opt), 60_000);
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
  // 60s: Der Anbieter-Endpoint von google-flights2 braucht nachgemessen 10-30s
  // pro Antwort (nicht <1s, wie lange angenommen). Mit den bisherigen 18s brach
  // der Client regelmäßig ab, BEVOR der Server fertig war — und selbst wenn er
  // wartete, lief serverseitig jeder Versuch in ein zu knappes Zeitlimit.
  // Solange geladen wird, zeigt das Detail-Overlay Skelette; das ist besser als
  // eine leere Anbieterliste. Nachgemessen am fertigen Endpoint: 41,6s kalt
  // (30s Anbieter-Abfrage + parallele Deeplink-Auflösung), 7ms warm — die
  // Antwort wird serverseitig 30min gecacht. Der Client startet den Abruf
  // bereits beim Antippen der Karte, ein Teil der Wartezeit ist also verdeckt.
  return getJson<FlightBookingOptionsResponse>(`/api/flights/booking-options?${params.toString()}`, undefined, 60_000);
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
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }, 20000);
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

/**
 * Anmeldung über Apple oder Google.
 *
 * Geschickt wird nur das ID-Token des Anbieters. Geprüft wird es
 * ausschließlich serverseitig gegen dessen öffentlichen Schlüsselsatz — der
 * Client kann dazu nichts beitragen und soll es auch nicht.
 */
export function authOAuth(input: {
  provider: "google" | "apple";
  idToken: string;
  firstName?: string;
  lastName?: string;
}): Promise<AuthResponse> {
  return postJson("/api/auth/oauth", input);
}

export function authLogout(token: string): Promise<void> {
  return postJson<void>("/api/auth/logout", {}, token);
}

export async function authMe(token: string): Promise<AuthUser> {
  const url = buildUrl("/api/auth/me");
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  }, 20000);
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText}`);
  const j = (await res.json()) as { user: AuthUser };
  return j.user;
}

export async function authUpdateAvatar(
  token: string,
  dataUrl: string | null,
): Promise<AuthUser> {
  const url = buildUrl("/api/auth/avatar");
  const res = await fetchWithTimeout(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ dataUrl }),
  }, 20000);
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

  const res = await fetchWithTimeout(url, {
    method: "POST",
    body: form,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }, 60000);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new TicketParseError(
      `API ${res.status} ${res.statusText} for ${url}${txt ? ` :: ${txt}` : ""}`,
      res.status,
    );
  }
  return (await res.json()) as ParsedTicketResponse;
}
