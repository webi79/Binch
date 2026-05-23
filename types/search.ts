export type TravelMode = "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";

export interface SearchParams {
  mode: TravelMode;
  origin: string;
  destination: string;
  originLabel: string;
  destLabel: string;
  departDate: string; // ISO date string
  /** Optionaler exakter Abfahrts-Zeitpunkt (UTC-ISO). Nur vom Surroundings-
   *  Departure-Tap gesetzt — die normale Suche lässt das leer. Der Server
   *  zentriert sein HAFAS-Suchfenster damit auf den Ziel-Zug, statt bei
   *  „jetzt" anzufangen (sonst kann der Ziel-Zug bei späten Abfahrten aus den
   *  10er-Results rausfallen). */
  departTime?: string;
  returnDate?: string;
  passengers: number;
  currency: string;
  /** Klasse/Kabine/Sitz — der i18n-Key wie in SearchHero zusammengestellt
   *  (z.B. "search.class.business", "search.cabin.balcony"). Der Server
   *  bekommt diesen Key roh und lässt ihn an die Provider durch. */
  travelClass?: string;
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
  /** Lat/Lng des Origin-Stops — wird für die Routen-Darstellung auf der Karte gebraucht. */
  originLat?: number;
  originLng?: number;
  /** Lat/Lng des Destination-Stops. */
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
  /** HAFAS Trip-ID — vom Client zur Polyline-Abruf weitergereicht. */
  tripId?: string;
}

export interface SearchResult {
  id: string;
  mode: TravelMode;
  /** "OUTBOUND" = Hinfahrt (Default wenn nicht gesetzt), "RETURN" = Rückfahrt.
   *  Bei Round-Trip-Train-Suchen liefert der Server Hin- und Rück-Treffer
   *  zusammen; der Client paart sie je nach Sort-Tab. */
  direction?: "OUTBOUND" | "RETURN";
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
  /** Google-Flights/SerpAPI Token. Client nutzt ihn um via
   *  /api/flights/booking-options die Multi-Provider-Liste (Expedia, Kiwi,
   *  trip.com, …) für ein Flight-Itinerary zu laden. Nur bei mode=FLIGHT. */
  bookingToken?: string;
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
  /** Wenn vom Server vorhanden: GPS-Position. Live-Quellen (db-rest Stations,
   *  FlixBus Autocomplete) liefern das mit, lokale DB-Einträge haben es
   *  (noch) nicht — dort macht der Client einen Fallback via AIRPORT_PINS
   *  / CRUISE_PORT_PINS. */
  latitude?: number;
  longitude?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  source: "cache" | "live";
  fetchedAt: string;
  /** „Später"-Pagination-Token (HAFAS laterRef, nur bei mode=TRAIN gesetzt).
   *  Der Client schickt's mit dem nächsten Such-Aufruf als `paginationToken`
   *  zurück um die Folge-Seite zu holen. */
  paginationToken?: string;
}
