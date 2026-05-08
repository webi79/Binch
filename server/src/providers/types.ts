import type { TravelMode } from "../db/schema.js";

export interface ProviderSearchInput {
  origin: string;
  destination: string;
  originLabel?: string;
  destLabel?: string;
  departDate: string;
  returnDate?: string;
  passengers: number;
  currency: string;
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
}

export interface NormalizedResult {
  externalId: string;
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
}

export interface SearchProvider {
  name: string;
  mode: TravelMode;
  isConfigured(): boolean;
  search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult>;
}
