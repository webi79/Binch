import type { TravelMode } from "../db/schema.js";

export interface ProviderSearchInput {
  /** Gesuchter Modus. Wird von searchService immer mitgegeben (SearchInput
   *  erweitert dieses Interface) — war nur nie deklariert, weshalb Provider, die
   *  in MEHREREN Registries hängen, nicht filtern konnten. db-vendo lieferte
   *  dadurch ZÜGE in die Bus-Suche. */
  mode?: TravelMode;
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  departDate: string;
  /** Optionaler Ziel-Zeitpunkt der Abfahrt (UTC-ISO). Wird vom Surroundings-
   *  Departure-Tap-Flow gesetzt: User klickt einen konkreten Zug um 16:29 →
   *  wir wollen, dass die Suche um genau diese Zeit ihr Fenster ansetzt, statt
   *  ab "jetzt" weil HAFAS sonst nur 10 Journeys liefert und der Ziel-Zug
   *  außerhalb des Fensters liegen kann. Provider die kein Zeit-Targeting
   *  unterstützen (Flug-/Bus-APIs) ignorieren das Feld. */
  departTime?: string;
  returnDate?: string;
  passengers: number;
  currency: string;
  /** i18n-Key wie vom Client gesetzt (z.B. "search.class.business"). Provider
   *  entscheiden selbst, ob/wie sie filtern. Wenn nicht gesetzt = keine
   *  Klassen-Präferenz. */
  travelClass?: string;
  /** „Später"-Pagination: opaques Token aus einer vorherigen Provider-Response
   *  (HAFAS laterRef). Provider die das unterstützen (db-vendo) holen damit
   *  die Folge-Seite statt den Standard-Start. Andere ignorieren's. */
  paginationToken?: string;
}

export interface StopoverInfo {
  name?: string;
  arrival?: string;
  departure?: string;
  platform?: string;
}

export interface LegInfo {
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  /** Lat/Lng des Origin-Stops — für Routen-Darstellung auf der Karte. */
  originLat?: number;
  originLng?: number;
  destLat?: number;
  destLng?: number;
  departTime: string;
  arriveTime: string;
  /**
   * Zeitzone DIESES Legs — IANA-Name ("Europe/London") oder UTC-Offset ("+02:00").
   * date-fns-tz versteht beides.
   *
   * Ohne das rendert der Client jede Leg-ABFAHRT in der Zone des Reisestarts und
   * jede Leg-ANKUNFT in der des Reiseziels. Bei einer Fahrt über eine
   * Zeitzonengrenze (Dortmund → London) wird damit die Ankunft des ERSTEN Legs
   * (in Brüssel) in London-Zeit angezeigt — eine Stunde zu früh. Fällt es nicht
   * auf, weil die Endzeiten stimmen; die Umstiege dazwischen sind falsch.
   *
   * Fehlt es, fällt der Client auf die Reise-Zone zurück (altes Verhalten).
   */
  originTz?: string;
  destTz?: string;

  /** Echtzeit-Verspätung in Minuten für die Timeline (durchgestrichene Soll-
   *  Zeit + Ist-Zeit). departTime/arriveTime bleiben SOLL. */
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
  durationMinutes: number;
  departPlatform?: string;
  arrivePlatform?: string;
  line?: string;
  product?: string;
  fahrtNr?: string;
  direction?: string;
  walking?: boolean;
  stops?: number;
  stopovers?: StopoverInfo[];
  /** HAFAS-Trip-ID — wird gebraucht für Polyline-Abruf (`/trips/{id}?polyline=true`). */
  tripId?: string;
}

export interface NormalizedResult {
  externalId: string;
  /** "OUTBOUND" = Hinfahrt (Default wenn nicht gesetzt), "RETURN" = Rückfahrt.
   *  Wird vom Train-Provider bei Round-Trip-Suchen befüllt; Client paart darauf
   *  basierend je nach aktivem Sort-Tab. */
  direction?: "OUTBOUND" | "RETURN";
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  departTime: string;
  arriveTime: string;
  /** Echtzeit-Verspätung in Minuten (Ist − Soll) für die Anzeige „Fahrplanzeit
   *  durchgestrichen + neue Zeit klein drüber". Nur gesetzt wenn > 0 und
   *  Realtime-Daten vorliegen. departTime/arriveTime bleiben die SOLL-Zeit. */
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
  deepLink: string;
  /** Provider-specific opaque token (e.g. SerpAPI google_flights `booking_token`)
   *  that lets the redirect endpoint resolve a direct-purchase URL via the
   *  provider's 2nd-stage booking API. */
  bookingToken?: string;
  flightNumber?: string;
  operatedBy?: string;
  isRefundable?: boolean;
  baggageIncluded?: boolean;
  providerLogo?: string;
}

export interface ProviderResult {
  results: NormalizedResult[];
  raw: unknown;
  statusCode: number;
  durationMs: number;
  /** Opaque Pagination-Token den der Client später an
   *  `/api/search/trains/more` schickt um die nächste Seite zu holen. Aktuell
   *  nur vom db-vendo-Provider gesetzt (HAFAS-laterRef). Andere Provider
   *  liefern undefined — dann zeigt der Client keinen „Später"-Button. */
  paginationToken?: string;
}

export interface SearchProvider {
  name: string;
  mode: TravelMode;
  isConfigured(): boolean;
  search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult>;
}
