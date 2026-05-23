import type { TravelMode } from "../db/schema.js";

export interface ProviderSearchInput {
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
