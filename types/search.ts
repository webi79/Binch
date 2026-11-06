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
  /**
   * Tarifprofil der Zugsuche (BahnCard, Deutschlandticket) — siehe
   * lib/travel/fareProfile.ts. Fehlt es bei einer Zugsuche, setzt
   * `searchByMode` das aus den Einstellungen ein.
   */
  fareProfile?: string;
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
  /** HAFAS Trip-ID — vom Client zur Polyline-Abruf weitergereicht. */
  tripId?: string;
  /** Gefährdung an GENAU dieser Stelle (laut Quelle, z. B. DB):
   *  "cancelled" = diese Teilstrecke fällt aus,
   *  "connectionAtRisk" = der Umstieg IN diese Teilstrecke ist voraussichtlich
   *  nicht zu schaffen. */
  warning?: JourneyWarning;
}

/** Von der Quelle gemeldete Gefährdung einer Verbindung. Solche Treffer stehen
 *  hinter den funktionierenden; ausgefallene kommen ohne Preis. */
export type JourneyWarning = "connectionAtRisk" | "cancelled";

export interface SearchResult {
  /**
   * Womit gesucht wurde — vom Client nach der Antwort eingetragen
   * (`searchByMode`), nicht vom Server. Die Detail-Ansicht und gespeicherte
   * Reisen zeigen damit die echte Klasse, den Tarif und Hin/Rück statt fester
   * Vorgaben. Fehlt bei älteren gespeicherten Reisen.
   */
  travelClass?: string;
  fareProfile?: string;
  roundTrip?: boolean;
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
  departTime: string; // ISO datetime (UTC) — SOLL (Fahrplanzeit)
  arriveTime: string; // ISO datetime (UTC) — SOLL (Fahrplanzeit)
  /** Echtzeit-Verspätung in Minuten. Wenn > 0: UI zeigt die neue Ist-Zeit
   *  (= departTime + delay) klein und streicht die SOLL-Zeit rot durch. */
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
  originTz?: string; // IANA timezone for departure wall-clock time
  destinationTz?: string; // IANA timezone for arrival wall-clock time
  dateOnly?: boolean; // true = only the calendar date is real, time is unknown
  durationMinutes: number;
  stops: number;
  stopLabels: string[];
  legs?: LegInfo[];
  /** Gefährdet laut Quelle — die betroffene Stelle steht an `legs[].warning`. */
  warning?: JourneyWarning;
  /** NUR Client: Hinweis über der Zeitleiste. "noTicketOffer" setzt der
   *  Abfahrts-Tipp, wenn die Buchungssuche den Zug nicht fand und stattdessen
   *  die Fahrt selbst gezeigt wird (StopDetailSheet). Kommt nie vom Server. */
  timelineNotice?: "noTicketOffer";
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
  /** Offizieller Name — so, wie ihn der Nutzer sehen soll (Server: `display_name`). */
  label: string;
  /**
   * Unterscheidungs-Zusatz („Rochdale Road · Stop RA"), nur wenn ein
   * gleichnamiger Halt derselben Art daneben steht. Dezent neben dem Namen
   * zeigen, nie im Namen.
   */
  detail?: string;
  /**
   * Steig-Bezeichnung („3") eines einzelnen Bus-Steigs einer Station — die App
   * zeigt sie als „Steig 3" vor dem Zusatz (lib/surroundings/standLabel.ts).
   */
  platform?: string;
  city: string;
  country: string;
  type: TravelMode | "ALL";
  /**
   * Genaue Verkehrsart eines Halts (Server: aus `subtype`) — fürs Symbol: Eine
   * U-Bahn-Station steht sonst als „Bus" da, wenn dort auch Busse fahren, und
   * gleichnamige Treffer verschiedener Art (S-Bahnhof und Bushaltestelle)
   * müssen sich unterscheiden lassen.
   */
  kind?: "train" | "subway" | "tram" | "bus" | "ferry";
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
