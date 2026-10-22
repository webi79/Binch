import Constants from "expo-constants";
import { Location, SearchParams, SearchResponse, TravelMode } from "@/types/search";
import { clientIdHeader } from "./clientId";
import type { LiveFlightInfo, LiveTrip } from "@/lib/live/types";

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
  const idHeader = await clientIdHeader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      // Die Installations-Kennung für die Rate-Limits (siehe clientId.ts).
      headers: { ...(init.headers as Record<string, string> | undefined), ...idHeader },
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timeout after ${timeoutMs}ms — Server nicht erreichbar (${url})`);
    }
    throw err;
  } finally {
    /**
     * Der Zeitgeber wird abgeräumt — mit offen genanntem Preis.
     *
     * Hier stand er absichtlich OHNE Löschung, damit das Abbruch-Signal auch das
     * Lesen des Rumpfes noch abdeckt. Das Argument stimmt, nur ist die Rechnung
     * andersherum aufgegangen: Jede Anfrage ließ dafür einen Wecker samt
     * `AbortController` und der ganzen Schließung (`url`, `init`) bis zu zwanzig
     * Sekunden liegen. Der Ergebnis-Bildschirm feuert pro Suche mehrere Anfragen
     * — Erstabruf, ein Wiederversuch, die stille Auffrischung alle fünf Minuten
     * —, und die lagen damit über Minuten gleichzeitig an. Sichtbar wird das
     * nicht als Fehler, sondern als Grundrauschen auf dem JS-Strang, genau in
     * einem Bildschirm, aus dem an einem Dutzend Stellen Arbeit herausgehalten
     * wird.
     *
     * WAS DAMIT WEGFÄLLT, damit es niemand aus Versehen wieder einbaut: Ein
     * Server, der Kopfzeilen schickt und den Rumpf stehen lässt, wird von dieser
     * Uhr nicht mehr abgefangen. Alle vier Aufrufer lesen den Rumpf unmittelbar
     * nach der Rückkehr (`postJson`, `authMe`, `authUpdateAvatar`,
     * `parseTicketPdf`), das Fenster ist also klein — und `getJson`, über das
     * die gesamte Suche läuft, hält es seit jeher genauso.
     *
     * `finally` läuft auch auf dem Abbruch-Pfad, und das ist unschädlich: Ist
     * der Wecker schon gefeuert, ist `clearTimeout` wirkungslos; der `catch`
     * darüber hat den `AbortError` da bereits in die freundliche Meldung
     * übersetzt.
     */
    clearTimeout(timer);
  }
}

async function getJson<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  const url = buildUrl(path, params);
  const idHeader = await clientIdHeader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      // Die Installations-Kennung für die Rate-Limits (siehe clientId.ts).
      headers: { Accept: "application/json", ...idHeader },
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
  | { code: string; label: string; detail?: string; platform?: string; replacedBy?: string; exists: true }
  | { code: string; exists: false };

/** Batch-Lookup: holt für eine Liste von Codes den aktuellen Label-Stand aus
 *  der DB. Wenn ein Code nicht mehr existiert → `exists: false`; wurde der Halt
 *  als veraltet/doppelt entfernt, kommt sein Ersatz am selben Ort (`replacedBy`,
 *  Name und Zusatz von dort). Wird beim App-Start für die Validierung
 *  persistierter Recent-Searches benutzt. */
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
  /** Offizieller Name des Halts. */
  label?: string;
  /** Zusatz, nur bei gleichnamigem Halt daneben (zwei Straßenseiten, Steige). */
  detail?: string;
  /** Steig-Bezeichnung („3") — nur bei einem einzelnen Bus-Steig einer Station. */
  platform?: string;
}

export interface SurroundingsListItem {
  id: string;
  name: string;
  detail?: string;
  /** Wie beim Marker: Steig-Bezeichnung eines einzelnen Bus-Steigs. */
  platform?: string;
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
    /** Ortszeit-Zone von Ab- und Ankunft dieses Legs (IANA oder „+01:00"). */
    originTz?: string;
    destTz?: string;
  }>;
}

export function fetchTripDetail(
  tripId: string,
  opts: {
    fromStopId?: string;
    fromStopLabel?: string;
    stopCode?: string;
    direction?: string;
    /** Tafel der getippten Zeile. Bei `arrivals` ist `direction` die Herkunft,
     *  und der Server zeigt die Fahrt BIS zum Halt statt ab ihm. */
    board?: "departures" | "arrivals";
    /** Zeit der getippten Tafel-Zeile (ISO). Legt bei Fahrten aus den
     *  Länder-Fahrplänen (NL/BE/CZ/UK) den Betriebstag fest. */
    atTime?: string;
  } = {},
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
      ...(opts.board === "arrivals" ? { board: opts.board } : {}),
      ...(opts.atTime ? { atTime: opts.atTime } : {}),
    },
    12_000,
  );
}

/**
 * Live-Ansicht: Halte mit Lage und Zeiten plus Linienführung einer Fahrt
 * (`server/src/routes/trips.ts`). Wo das Fahrzeug gerade ist, rechnet die App
 * daraus selbst (`lib/live/motion.ts`).
 */
export function fetchLiveTrip(
  tripId: string,
  opts: { stopCode?: string; atTime?: string } = {},
): Promise<LiveTrip> {
  return getJson<LiveTrip>(
    "/api/live/trip",
    {
      tripId,
      ...(opts.stopCode ? { stopCode: opts.stopCode } : {}),
      ...(opts.atTime ? { atTime: opts.atTime } : {}),
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
  /** Nur Flugtafeln: beide Enden des Fluges mit Plan- und erwarteten Zeiten —
   *  daraus rechnet die Live-Ansicht, wo das Flugzeug gerade ist. */
  flight?: LiveFlightInfo;
}

export interface StopBoardResponse {
  results: StopBoardItem[];
  fetchedAt: string;
  validUntil: string;
  stop: {
    code: string;
    /** Offizieller Name des Halts (derselbe wie in der Zeitleiste). */
    label: string;
    hafasId: string | null;
    /** Zusatz, nur bei gleichnamigem Halt daneben („Rochdale Road · Stop RA"). */
    detail?: string;
    /** Ortszeit-Zone des Halts (IANA) — die Zeiten der Tafel werden in IHR gezeigt. */
    tz?: string;
    /** Die Zeiten stammen von einem ANDEREN Halt in der Nähe (> 30 m, anderer
     *  Name) — die Tafel sagt das über der Liste. */
    servedBy?: { name: string; distanceM: number };
    /** Steig-Bezeichnung („3") — nur bei einem einzelnen Bus-Steig einer Station. */
    platform?: string;
  };
}

export function fetchStopDepartures(code: string): Promise<StopBoardResponse> {
  return getJson<StopBoardResponse>(`/api/stops/${encodeURIComponent(code)}/departures`, undefined, 10_000);
}

export function fetchStopArrivals(code: string): Promise<StopBoardResponse> {
  return getJson<StopBoardResponse>(`/api/stops/${encodeURIComponent(code)}/arrivals`, undefined, 10_000);
}

/** Antwort von `/api/tiles/aerial/abdeckung` — siehe dort (server/src/routes/tiles.ts). */
export interface AerialCoverage {
  /** Liegt an dieser Stelle ein amtliches Orthofoto (nicht nur Copernicus)? */
  amtlich: boolean;
  /** Welcher Landesdienst, oder `null`. */
  quelle: string | null;
  /** Wie tief die Satellitenkarte hier zoomen darf. */
  maxZoom: number;
  /** Eine Landesquelle war gerade nicht erreichbar — die Antwort ist unsicher. */
  vorlaeufig?: boolean;
}

export function fetchAerialCoverage(latitude: number, longitude: number): Promise<AerialCoverage> {
  return getJson<AerialCoverage>(
    "/api/tiles/aerial/abdeckung",
    { lat: latitude.toFixed(5), lon: longitude.toFixed(5) },
    10_000,
  );
}

/** Antwort von `/api/imagery/esri` — siehe server/src/routes/imagery.ts. */
export interface EsriImagery {
  /** Darf diese App gerade Esri zeigen (Schlüssel da, Deckel nicht erreicht, nicht gesperrt)? */
  enabled: boolean;
  /** Kachel-Pfad mit Kennung und Tages-Schein, ohne Rechnername (`/api/tiles/esri/{z}/{x}/{y}?…`). */
  tilePath?: string;
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
  remainingToday?: number;
  reason?: string;
}

export function fetchEsriImagery(): Promise<EsriImagery> {
  return getJson<EsriImagery>("/api/imagery/esri", undefined, 10_000);
}

/** Ein Fußweg entlang der Straßen — siehe `server/src/routes/walk.ts`. */
export interface WalkRoute {
  /** [lng, lat] — GeoJSON-Reihenfolge. */
  coords: [number, number][];
  durationMinutes: number;
  distanceMeters: number;
}

/**
 * Fußweg von A nach B. `null`, wenn es keinen gibt oder das Ziel zu weit ist
 * (über rund 5 km Luftlinie fragt der Server gar nicht erst).
 */
export function fetchWalkRoute(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): Promise<WalkRoute | null> {
  return getJson<{ route: WalkRoute | null }>(
    "/api/walk",
    {
      fromLat: from.latitude.toFixed(5),
      fromLng: from.longitude.toFixed(5),
      toLat: to.latitude.toFixed(5),
      toLng: to.longitude.toFixed(5),
    },
    12_000,
  ).then((r) => r.route);
}

/** Warum ein Verkehrsmittel für eine Stadt nicht angeboten wird — siehe `server/src/routes/tripPlan.ts`. */
export type CityModeReason =
  | "same_place"
  | "too_close"
  | "too_far"
  | "no_land_link"
  | "no_airport"
  | "no_station";

export type CityModePlan =
  | { available: true; origin: Location & { latitude: number; longitude: number }; destination: Location & { latitude: number; longitude: number } }
  | { available: false; reason: CityModeReason };

export type CityTripMode = "TRAIN" | "BUS" | "FLIGHT";

export interface CityTripPlan {
  distanceKm: number;
  destination: { name: string; country: string | null };
  modes: Record<CityTripMode, CityModePlan>;
}

/**
 * Vorlauf des Stadt-Blatts: Welche Verkehrsmittel sind vom eigenen Standort in
 * diese Stadt sinnvoll, und von welcher Station zu welcher? Fragt KEINEN
 * Anbieter — die Suche danach läuft über `searchByMode`, nur für das gewählte
 * Verkehrsmittel.
 */
export function fetchCityTripPlan(
  from: { latitude: number; longitude: number } | null,
  to: { name: string; latitude: number; longitude: number },
  /**
   * In der Such-Slide gewählte Orte (Kennungen). Sie ersetzen Standort bzw.
   * angetippte Stadt — der Server plant damit ALLE Verkehrsmittel neu.
   */
  codes?: {
    fromCode?: string | null;
    fromLabel?: string | null;
    toCode?: string | null;
    toLabel?: string | null;
  },
): Promise<CityTripPlan> {
  const params: Record<string, string> = {};
  // Die Beschriftung reist mit: Steht die Kennung nicht in der Orts-Tabelle
  // (Treffer der Live-Suche), löst der Server über sie auf.
  if (codes?.fromCode) {
    params.fromCode = codes.fromCode;
    if (codes.fromLabel) params.fromLabel = codes.fromLabel;
  } else if (from) {
    params.fromLat = from.latitude.toFixed(5);
    params.fromLng = from.longitude.toFixed(5);
  }
  if (codes?.toCode) {
    params.toCode = codes.toCode;
    if (codes.toLabel) params.toLabel = codes.toLabel;
  } else {
    params.toLat = to.latitude.toFixed(5);
    params.toLng = to.longitude.toFixed(5);
    params.toName = to.name;
  }
  return getJson<CityTripPlan>("/api/trip-plan/city", params, 15_000);
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

/**
 * Ein Preis-Alarm auf einer Strecke.
 *
 * Der Besitzer ist die PUSH-KENNUNG des Geräts, nicht ein Konto — ein Alarm
 * soll ohne Anmeldung funktionieren. Liegt trotzdem ein Sitzungs-Token vor,
 * geht es mit: Der Server verknüpft den Alarm dann zusätzlich mit dem Konto,
 * und er überlebt einen Gerätewechsel.
 */
export interface CreatePriceAlertInput {
  pushToken: string;
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  /** ISO „yyyy-MM-dd". */
  departDate: string;
  /** ISO „yyyy-MM-dd" oder weggelassen — eine einfache Fahrt hat keine. */
  returnDate?: string;
  /** Reisende und Klasse gehören zum Preis — siehe `PriceAlert`. */
  passengers: number;
  travelClass: string;
  currency: string;
  basePrice: number;
  desiredPrice: number;
  notifyOnRise: boolean;
}

/**
 * Die Zeitgrenze der drei Alarm-BEDIENWEGE — deutlich kürzer als die 20s.
 *
 * WARUM ÜBERHAUPT KÜRZER: An diesen dreien steht ein Mensch und sieht auf einen
 * Schalter. Läuft der Server nicht, während das WLAN steht, antwortet niemand —
 * und es kommt auch kein „Verbindung abgelehnt" zurück, das sofort da wäre: Die
 * Verbindung HÄNGT. Nachgemessen gegen einen Rechner, der Pakete schluckt: Bis
 * zu 10,5 Sekunden dauert es, bis Android von sich aus aufgibt; bleibt er
 * länger stumm, schlägt bei 20 Sekunden unsere eigene Grenze zu. Der Schalter
 * sprang also um, und erst zehn bis zwanzig Sekunden später kam die Meldung,
 * dass es nicht geklappt hat. Genau so wurde es berichtet.
 *
 * WARUM AUSGERECHNET FÜNF: Diese Aufrufe schicken ein paar Dutzend Bytes und
 * lesen eine leere Antwort. Selbst über eine schlechte Mobilfunkstrecke ist das
 * in ein bis zwei Sekunden erledigt; fünf lassen Luft für das Doppelte. Wer
 * länger braucht, hat kein langsames Netz, sondern keines.
 *
 * WARUM DAS GEFAHRLOS IST: Alle drei sind WIEDERHOLBAR. Kommt ein abgebrochener
 * Aufruf beim Server doch noch an, ist der zweite Versuch derselbe Vorgang:
 * Pausieren setzt denselben Merker; Löschen trifft eine Zeile, die es nicht mehr
 * gibt (der Server sagt „Unknown alert", und das gilt hier als Erfolg); Anlegen
 * ERSETZT den bestehenden Alarm derselben Strecke, statt einen zweiten daneben
 * zu legen. Ohne diese Eigenschaft wäre eine kurze Grenze nicht zu verantworten.
 *
 * `listPriceAlerts` bleibt bei 20 Sekunden: Der Abgleich läuft beim App-Start im
 * Hintergrund, dort wartet niemand — und was er nicht schafft, holt der nächste
 * Start nach. Eine kurze Grenze wäre dort nur eine zusätzliche Gelegenheit zu
 * scheitern.
 */
export const ALERT_ACTION_TIMEOUT_MS = 5000;

/**
 * @param timeoutMs Wie lange gewartet wird. Vorgabe sind 20 Sekunden — der
 *   ABGLEICH beim App-Start läuft im Hintergrund, dort wartet niemand, und ein
 *   früher Abbruch wäre nur eine zusätzliche Gelegenheit zu scheitern. Wer den
 *   Alarm im Blatt anlegt oder wieder einschaltet, sieht dagegen auf den
 *   Bildschirm und bekommt `ALERT_ACTION_TIMEOUT_MS` mitgegeben.
 *
 *   Hier stand die kurze Grenze fest verdrahtet — und traf damit auch den
 *   Abgleich, der genau davon ausgenommen sein sollte (siehe die Begründung an
 *   der Konstante).
 */
export async function createPriceAlert(
  input: CreatePriceAlertInput,
  authToken?: string | null,
  timeoutMs: number = 20000,
): Promise<{ id: string }> {
  const url = buildUrl("/api/alerts");
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(input),
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as { id: string };
}

/**
 * Ein Alarm, wie der SERVER ihn führt.
 *
 * Nur die Felder, die der Abgleich braucht — nicht alles, was die Tabelle hat.
 */
export interface ServerPriceAlert {
  id: string;
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string;
  returnDate: string;
  passengers: number;
  travelClass: string;
  currency: string;
  basePrice: string;
  /** ISO-Zeitpunkt oder `null` — gesetzt, sobald der Alarm gemeldet HAT. */
  lastNotifiedAt: string | null;
  /** Der Preis, mit dem gemeldet wurde. Nicht der zuletzt gesehene. */
  notifiedPrice: string | null;
  active: boolean;
}

/**
 * Die Alarme dieses Geräts beim Server erfragen.
 *
 * WOZU: Damit die App erfährt, was passiert ist, WÄHREND SIE NICHT LIEF. Eine
 * Meldung, die bei toter App eintrifft, zeigt Android nativ an — ohne
 * JavaScript zu starten. Tippt der Nutzer sie an, holt der Tipp sie ab; öffnet
 * er die App stattdessen normal, erfährt sie davon auf KEINEM anderen Weg. Der
 * Server ist dann die einzige Quelle: Er weiß, welcher Alarm gemeldet hat und
 * mit welchem Preis.
 *
 * Die Kennung ist auch hier die Berechtigung und geht im Kopf mit — dieselbe
 * Begründung wie beim Löschen.
 */
export async function listPriceAlerts(
  pushToken: string,
  authToken?: string | null,
): Promise<ServerPriceAlert[]> {
  const url = buildUrl("/api/alerts");
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
        "X-Push-Token": pushToken,
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
    },
    20000,
  );
  if (!res.ok) throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
  const json = (await res.json()) as { alerts?: ServerPriceAlert[] };
  return json.alerts ?? [];
}

/**
 * Einen Alarm PAUSIEREN oder wieder aufnehmen.
 *
 * Der Unterschied zum Löschen ist der ganze Punkt: Der Schalter auf der Karte
 * rief bisher `deletePriceAlert`, „aus" war also eine Kündigung. Gemeint ist
 * eine Pause — die Zeile bleibt mit Kennung, Schwelle und zuletzt gesehenem
 * Preis stehen, nur die Prüfung überspringt sie.
 *
 * Die Push-Kennung geht im Kopf mit: Sie ist auf dem Server die Berechtigung,
 * genau wie beim Löschen.
 *
 * Rückgabe statt Ausnahme, weil der Aufrufer die beiden Fälle verschieden
 * behandeln muss:
 *  • `"ok"` — umgelegt.
 *  • `"gone"` — die Zeile liegt dort nicht (mehr). Beim EINSCHALTEN muss sie
 *    dann neu angelegt werden; beim Ausschalten ist nichts mehr zu tun.
 * Alles andere (kein Netz, unbekanntes Gerät, 5xx) wirft — dort wäre ein
 * stiller Erfolg genau die Lüge, gegen die hier mehrfach geschrieben wurde.
 */
export async function updatePriceAlertActive(
  id: string,
  pushToken: string,
  active: boolean,
): Promise<"ok" | "gone"> {
  const url = buildUrl(`/api/alerts/${encodeURIComponent(id)}`);
  const res = await fetchWithTimeout(
    url,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Push-Token": pushToken },
      body: JSON.stringify({ active }),
    },
    ALERT_ACTION_TIMEOUT_MS,
  );
  if (res.ok) return "ok";
  if (res.status === 404) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    /**
     * Nur der unbekannte ALARM heißt „weg". Die unbekannte KENNUNG heißt, dass
     * gar nichts erreicht wurde — dieselbe Unterscheidung wie beim Löschen, und
     * aus demselben Grund: Die zweite als Erfolg zu lesen hieße, einen Alarm
     * für pausiert zu halten, der munter weitermeldet.
     */
    if (detail?.error === "Unknown alert") return "gone";
  }
  throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
}

/**
 * Einen Preis-Alarm löschen.
 *
 * Die Push-Kennung geht MIT, und zwar nicht als Beifang: Sie ist auf dem Server
 * die Berechtigung. Ohne sie könnte jeder fremde Alarme löschen, der eine
 * Kennung errät.
 */
export async function deletePriceAlert(id: string, pushToken: string): Promise<void> {
  const url = buildUrl(`/api/alerts/${encodeURIComponent(id)}`);
  const res = await fetchWithTimeout(
    url,
    {
      method: "DELETE",
      /**
       * Die Kennung im KOPF, nicht in der URL.
       *
       * Sie ist hier die Berechtigung — wer sie hat, darf löschen. Im
       * Query-String landete sie in jedem Zugriffsprotokoll zwischen App und
       * Server. Der Server nimmt beides an, damit eine ältere installierte App
       * weiterhin funktioniert.
       */
      headers: { "X-Push-Token": pushToken },
    },
    ALERT_ACTION_TIMEOUT_MS,
  );
  if (res.ok) return;
  /**
   * Die beiden 404 sind NICHT dasselbe — und diese Unterscheidung fehlte.
   *
   * Der Server antwortet mit 404 in zwei Fällen, und sie bedeuten das Gegenteil
   * voneinander:
   *
   *  • `Unknown alert` — der Alarm liegt dort nicht (mehr). Das ist der BEWEIS,
   *    dass er weg ist, also genau das Ziel. Ihn als Fehler zu behandeln machte
   *    eine Listenzeile dauerhaft unlöschbar: Wer eine ältere Sicherung der
   *    App-Daten zurückspielt, hat lokal einen Eintrag mit einer Server-Kennung,
   *    die es nicht mehr gibt — und bekam bei jedem Tipp auf den Papierkorb
   *    „konnte nicht gelöscht werden", ohne Ausweg.
   *  • `Unknown device` — die Push-Kennung ist dem Server fremd. Dann wurde
   *    NICHTS gelöscht, und der Alarm meldet weiter. Hier ist Scheitern richtig.
   *
   * Zuvor galt beides als Erfolg (der alte Fehler), danach beides als Fehler
   * (mein Gegenschlag, zu breit). Richtig ist die Trennung.
   */
  if (res.status === 404) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    if (detail?.error === "Unknown alert") return;
  }
  throw new Error(`API ${res.status} ${res.statusText} for ${url}`);
}
