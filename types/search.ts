export type TravelMode = "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";

export interface SearchParams {
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string; // ISO date string
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

export interface SearchResult {
  id: string;
  mode: TravelMode;
  provider: string;
  providerLogo?: string;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departTime: string; // ISO datetime (UTC)
  arriveTime: string; // ISO datetime (UTC)
  originTz?: string; // IANA timezone for departure wall-clock time
  destinationTz?: string; // IANA timezone for arrival wall-clock time
  dateOnly?: boolean; // true = only the calendar date is real, time is unknown
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  legs?: LegInfo[];
  price: number;
  currency: string;
  deepLink?: string; // server-side only — frontend uses redirectToken
  redirectToken: string; // client builds ${API_BASE_URL}/redirect/${token}
  isRefundable?: boolean;
  baggageIncluded?: boolean;
  flightNumber?: string;
  operatedBy?: string;
}

export interface Location {
  code: string;
  label: string;
  city: string;
  country: string;
  type: TravelMode | "ALL";
}

export interface SearchResponse {
  results: SearchResult[];
  source: "cache" | "live";
  fetchedAt: string;
}
