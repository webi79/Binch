import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  date,
  numeric,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type TravelMode = "FLIGHT" | "TRAIN" | "BUS" | "CRUISE";
export type LocationType = TravelMode | "ALL";

export const searchRequests = pgTable(
  "search_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mode: varchar("mode", { length: 16 }).notNull().$type<TravelMode>(),
    origin: varchar("origin", { length: 64 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    originLabel: text("origin_label"),
    destLabel: text("dest_label"),
    departDate: date("depart_date").notNull(),
    /** Exakter Abfahrts-Wunsch (der User wählt im Picker Datum UND Uhrzeit).
     *  Muss Teil der Cache-Identität sein — sonst bediente eine 08:00-Suche
     *  die 18:00-Suche derselben Strecke aus dem Cache. */
    departTime: timestamp("depart_time", { withTimezone: true }),
    returnDate: date("return_date"),
    passengers: integer("passengers").notNull().default(1),
    currency: varchar("currency", { length: 8 }).notNull().default("EUR"),
    ipHash: varchar("ip_hash", { length: 64 }),
    userId: uuid("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    modeCreated: index("idx_search_requests_mode_created").on(t.mode, t.createdAt),
    originDest: index("idx_search_requests_origin_dest").on(t.origin, t.destination),
  }),
);

export const providerResponses = pgTable(
  "provider_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => searchRequests.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 64 }).notNull(),
    mode: varchar("mode", { length: 16 }).notNull().$type<TravelMode>(),
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms"),
    rawResponse: jsonb("raw_response"),
    resultCount: integer("result_count").notNull().default(0),
    error: text("error"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    request: index("idx_provider_responses_request").on(t.requestId),
    providerFetched: index("idx_provider_responses_provider").on(t.provider, t.fetchedAt),
  }),
);

export const searchResults = pgTable(
  "search_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => searchRequests.id, { onDelete: "cascade" }),
    providerResponseId: uuid("provider_response_id").references(() => providerResponses.id, {
      onDelete: "set null",
    }),
    mode: varchar("mode", { length: 16 }).notNull().$type<TravelMode>(),
    provider: varchar("provider", { length: 64 }).notNull(),
    providerLogo: text("provider_logo"),
    origin: varchar("origin", { length: 64 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    originLabel: text("origin_label"),
    destLabel: text("dest_label"),
    departTime: timestamp("depart_time", { withTimezone: true }).notNull(),
    arriveTime: timestamp("arrive_time", { withTimezone: true }).notNull(),
    originTz: varchar("origin_tz", { length: 64 }),
    destinationTz: varchar("destination_tz", { length: 64 }),
    dateOnly: boolean("date_only").notNull().default(false),
    durationMinutes: integer("duration_minutes").notNull(),
    stops: integer("stops").notNull().default(0),
    stopLabels: jsonb("stop_labels").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    legs: jsonb("legs").$type<unknown[]>(),
    price: numeric("price", { precision: 12, scale: 2 }).notNull(),
    currency: varchar("currency", { length: 8 }).notNull(),
    deepLink: text("deep_link").notNull(),
    /** Provider-spezifischer Booking-Token (z.B. SerpAPI google_flights
     *  `booking_token`) — wird beim Direct-Purchase-Flow benötigt. Persistieren
     *  damit auch Cache-Hits den vollen Buchungs-Flow ermöglichen. */
    bookingToken: text("booking_token"),
    flightNumber: varchar("flight_number", { length: 16 }),
    operatedBy: text("operated_by"),
    isRefundable: boolean("is_refundable"),
    baggageIncluded: boolean("baggage_included"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    request: index("idx_search_results_request").on(t.requestId),
    price: index("idx_search_results_price").on(t.price),
  }),
);

export const redirectTokens = pgTable(
  "redirect_tokens",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    resultId: uuid("result_id")
      .notNull()
      .references(() => searchResults.id, { onDelete: "cascade" }),
    deepLink: text("deep_link").notNull(),
    /** SerpAPI / provider booking_token used to resolve a direct-purchase URL
     *  on click via the provider's 2nd-stage booking-options API. */
    bookingToken: text("booking_token"),
    /** Snapshot of the search context (mode/origin/destination/dates/passengers/
     *  currency) needed to re-issue the 2nd SerpAPI call. */
    bookingContext: jsonb("booking_context").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    clickCount: integer("click_count").notNull().default(0),
  },
  (t) => ({
    expires: index("idx_redirect_tokens_expires").on(t.expiresAt),
  }),
);

export const providers = pgTable("providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  mode: varchar("mode", { length: 16 }).notNull().$type<TravelMode>(),
  name: varchar("name", { length: 64 }).notNull().unique(),
  displayName: text("display_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(100),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    /**
     * NULLABLE, seit es Anmeldung über Apple und Google gibt.
     *
     * Wer sich nur über einen Anbieter anmeldet, hat bei uns nie ein Passwort
     * gesetzt — ein Pflichtfeld zwänge zu einem Platzhalter-Hash, und ein
     * Platzhalter, gegen den irgendwann jemand verifiziert, ist eine
     * Hintertür. `null` heißt eindeutig: Dieses Konto hat kein Passwort, der
     * Passwort-Login ist dafür gesperrt.
     */
    passwordHash: text("password_hash"),
    firstName: varchar("first_name", { length: 80 }).notNull(),
    lastName: varchar("last_name", { length: 80 }).notNull(),
    /** data: URL (image/jpeg base64) — capped at ~256x256 client-side. */
    avatarDataUrl: text("avatar_data_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailIdx: index("idx_users_email").on(t.email),
  }),
);

/**
 * Anmeldungen über Apple und Google.
 *
 * Eigene Tabelle statt Spalten an `users`, aus drei Gründen:
 *  • Ein Konto darf mehrere Anbieter haben (heute Google, morgen zusätzlich
 *    Apple — dieselbe Person, dasselbe Konto).
 *  • Die Kennung des Anbieters (`sub`) ist die einzige stabile Größe. E-Mails
 *    ändern sich, und Apples „Private Relay" liefert für dieselbe Person
 *    pro App eine andere Adresse.
 *  • Ein eindeutiger Index über (Anbieter, Kennung) macht das Verknüpfen
 *    atomar — ohne ihn könnten zwei gleichzeitige Anmeldungen zwei Konten
 *    anlegen.
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** "google" | "apple" */
    provider: varchar("provider", { length: 16 }).notNull(),
    /** Die `sub`-Kennung aus dem ID-Token des Anbieters. */
    providerUserId: varchar("provider_user_id", { length: 255 }).notNull(),
    /** Die E-Mail, die der Anbieter mitgeschickt hat — nur zur Nachvollzieh-
     *  barkeit. Verknüpft wird über `providerUserId`, nie über die E-Mail. */
    email: varchar("email", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Verhindert doppelte Verknüpfungen UND macht das Anlegen wettlauffest. */
    providerUnique: uniqueIndex("uq_user_identities_provider_uid").on(
      t.provider,
      t.providerUserId,
    ),
    userIdx: index("idx_user_identities_user").on(t.userId),
  }),
);

export const sessions = pgTable(
  "sessions",
  {
    /** Random opaque bearer token; sent by clients in Authorization header. */
    token: varchar("token", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index("idx_sessions_user").on(t.userId),
    expiresIdx: index("idx_sessions_expires").on(t.expiresAt),
  }),
);

export const locations = pgTable(
  "locations",
  {
    /** Eindeutiger Code. Format hängt von der Quelle ab:
     *  - IATA-Code (3 Buchstaben) für Flughäfen
     *  - "PORT-XXX" für Häfen
     *  - "sta:<uic>" für StaDa-Bahnhöfe (UIC 7-stellig = HAFAS-ID)
     *  - "gtfs:<stop_id>" für GTFS-DE-Stops
     *  Länge auf 64 hochgesetzt, da GTFS-IDs lang sein können (z.B. "de:01:5100:1:1"). */
    code: varchar("code", { length: 64 }).primaryKey(),
    label: text("label").notNull(),
    city: text("city"),
    country: text("country"),
    type: varchar("type", { length: 16 }).notNull().$type<LocationType>(),
    /** GPS-Koordinaten. Numeric mit Präzision 9 → ~1 m Genauigkeit. */
    latitude: numeric("latitude", { precision: 9, scale: 6 }),
    longitude: numeric("longitude", { precision: 9, scale: 6 }),
    /** HAFAS-Station-ID (UIC 7-stellig). Wenn gesetzt → kann direkt für
     *  /journeys-Trip-Search genutzt werden, keine Live-ID-Auflösung nötig.
     *  Bei StaDa-Stationen aus dem DB-Netz immer gesetzt; bei GTFS-Stops nur,
     *  wenn der GTFS-Stop-ID UIC-konform ist. */
    hafasId: varchar("hafas_id", { length: 16 }),
    /** Dominante Verkehrsart (häufigste Subtype-Kategorie an dem Stop),
     *  abgeleitet aus GTFS route_type:
     *    LONG_DISTANCE — Fernverkehr (ICE/IC/EC, TGV, AVE…)
     *    REGIONAL      — Regionalbahn (RB/RE/IRE)
     *    SUBURBAN      — S-Bahn / Commuter Rail
     *    SUBWAY        — U-Bahn / Metro
     *    TRAM          — Straßenbahn / Light Rail
     *    BUS           — Stadtbus
     *    COACH         — Fernbus
     *    FERRY         — Fähre
     *  Wird im Frontend für Sortier-Priorität benutzt. Für die Anzeige
     *  selber zählt `kinds` (s.u.). Null bei Airports/Ports — die haben
     *  einen eigenen Marker-Type. */
    subtype: varchar("subtype", { length: 16 }),
    /** Alle Modi die an diesem Stop verkehren (Kategorien). z.B. an
     *  „Dortmund Barop Parkhaus" hält U-Bahn UND Bus → kinds=["subway","bus"].
     *  Wird vom Frontend genutzt um eine Multi-Mode-Pille (mehrere Icons in
     *  einer Box) zu rendern statt nur das dominante Icon. Sortiert nach
     *  Häufigkeit absteigend. Werte:
     *    train (= rail-like: long-distance/regional/suburban)
     *    subway, tram, bus (= bus + coach), ferry */
    kinds: text("kinds").array(),
    /** Datenquelle — für Updates und Debugging. "stada", "gtfs", "iata", "port", "local". */
    source: varchar("source", { length: 16 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    type: index("idx_locations_type").on(t.type),
    hafasIdIdx: index("idx_locations_hafas_id").on(t.hafasId),
    // Beschleunigt ILIKE-Prefix-Suchen über Label und City beim Autocomplete.
    labelIdx: index("idx_locations_label").on(t.label),
    cityIdx: index("idx_locations_city").on(t.city),
    // Composite-Index für Bounding-Box-Queries im Surroundings-Endpoint.
    // Ohne diesen Index macht Postgres bei zoom 9-12 (80km Radius) einen
    // Seq-Scan über ~400k Rows — der Surroundings-Call dauert dann mehrere
    // Sekunden, Map-Marker flackern weil der Client mit Cache-Daten arbeitet.
    geoIdx: index("idx_locations_geo").on(t.latitude, t.longitude),
  }),
);

/**
 * Städte aus GeoNames cities5000. Wird genutzt um Stops administrativ einer
 * Stadt zuzuordnen (z.B. „Anrath Bahnhof" → city = „Willich"), damit der
 * Autocomplete via ILIKE-Suche auf `locations.city` Stops auch über den
 * Gemeindenamen findet.
 */
export const cities = pgTable(
  "cities",
  {
    geonameId: integer("geoname_id").primaryKey(),
    name: text("name").notNull(),
    asciiName: text("ascii_name"),
    country: text("country"),
    latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
    longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
    population: integer("population"),
    /** GeoNames feature_code (PPL, PPLA, PPLA2, PPLA3, PPLA4, PPLX, …).
     *  - PPL    = populated place (generisch)
     *  - PPLA*  = seat of an administrative division (PPLA = Landeshauptstadt,
     *             PPLA2/3/4 = Hauptort des admin2/3/4-Gebiets, also Kreis-/
     *             Gemeindesitz)
     *  - PPLX   = Ortsteil (Section of populated place)
     *  Wird genutzt um Ortsteile (PPLX) ihrer übergeordneten Gemeinde
     *  (PPLA3/PPLA4 mit gleichem admin4-Code) zuzuordnen. */
    featureCode: varchar("feature_code", { length: 16 }),
    /** Hierarchische Admin-Codes (GeoNames):
     *    admin1 = Bundesland/Region (z.B. NW für NRW)
     *    admin2 = Regierungsbezirk
     *    admin3 = Kreis
     *    admin4 = Gemeinde/Kommune (Amtlicher Gemeindeschlüssel-Suffix)
     *  Anrath (PPLX) und Willich (PPLA4) teilen denselben admin4 — darüber
     *  ordnen wir den Ortsteil seiner Gemeinde zu. */
    admin1: varchar("admin1", { length: 16 }),
    admin2: varchar("admin2", { length: 32 }),
    admin3: varchar("admin3", { length: 32 }),
    admin4: varchar("admin4", { length: 32 }),
  },
  (t) => ({
    nameIdx: index("idx_cities_name").on(t.name),
    countryIdx: index("idx_cities_country").on(t.country),
    // Schnelles Lookup „welche Stadt ist Hauptort des admin4-Gebiets X?"
    adminIdx: index("idx_cities_admin").on(t.admin1, t.admin2, t.admin3, t.admin4),
  }),
);

/**
 * GTFS-Schedule-Tabellen — speichern planmäßige Fahrpläne pro Land/Feed.
 *
 * Wozu? Für Länder ohne funktionierendes HAFAS-Profile (NL/FR/IT/ES/CZ/etc.)
 * können wir Live-Departures nicht über hafas-client holen. Stattdessen
 * importieren wir die offiziellen GTFS-Schedule-Feeds (open data, kein Login)
 * in diese Tabellen und beantworten Departure-Anfragen per SQL-JOIN.
 *
 * `feed_id` ist ein Diskriminator (z.B. "nl-ovapi", "fr-transport") damit
 * mehrere Länder nebeneinander koexistieren ohne Konflikt. Re-Import eines
 * Feeds soll alle alten Rows mit demselben feed_id löschen und neu schreiben.
 *
 * stop_id in den GTFS-Tabellen ist DER GTFS-ORIGINAL-STOP-ID (z.B.
 * "stoparea:525388"), nicht unser `locations.code` mit `gtfs:nl:` Präfix.
 * Beim Departure-Lookup wird das Präfix vom Code abgezogen.
 */
export const gtfsCalendar = pgTable(
  "gtfs_calendar",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    serviceId: varchar("service_id", { length: 128 }).notNull(),
    monday: boolean("monday").notNull().default(false),
    tuesday: boolean("tuesday").notNull().default(false),
    wednesday: boolean("wednesday").notNull().default(false),
    thursday: boolean("thursday").notNull().default(false),
    friday: boolean("friday").notNull().default(false),
    saturday: boolean("saturday").notNull().default(false),
    sunday: boolean("sunday").notNull().default(false),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
  },
  (t) => ({
    pk: index("gtfs_calendar_pk").on(t.feedId, t.serviceId),
  }),
);

export const gtfsCalendarDates = pgTable(
  "gtfs_calendar_dates",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    serviceId: varchar("service_id", { length: 128 }).notNull(),
    date: date("date").notNull(),
    /** 1 = service added on this date, 2 = service removed on this date. */
    exceptionType: integer("exception_type").notNull(),
  },
  (t) => ({
    lookup: index("gtfs_calendar_dates_lookup").on(t.feedId, t.serviceId, t.date),
    byDate: index("gtfs_calendar_dates_date").on(t.feedId, t.date),
  }),
);

export const gtfsRoutes = pgTable(
  "gtfs_routes",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    routeId: varchar("route_id", { length: 128 }).notNull(),
    agencyId: varchar("agency_id", { length: 64 }),
    shortName: text("short_name"),
    longName: text("long_name"),
    /** GTFS route_type — 0=tram, 1=subway, 2=rail, 3=bus, 4=ferry, etc. */
    type: integer("type").notNull().default(3),
    color: varchar("color", { length: 8 }),
    textColor: varchar("text_color", { length: 8 }),
  },
  (t) => ({
    pk: index("gtfs_routes_pk").on(t.feedId, t.routeId),
  }),
);

export const gtfsTrips = pgTable(
  "gtfs_trips",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    tripId: varchar("trip_id", { length: 192 }).notNull(),
    routeId: varchar("route_id", { length: 128 }).notNull(),
    serviceId: varchar("service_id", { length: 128 }).notNull(),
    headsign: text("headsign"),
    directionId: integer("direction_id"),
  },
  (t) => ({
    pk: index("gtfs_trips_pk").on(t.feedId, t.tripId),
    byService: index("gtfs_trips_service").on(t.feedId, t.serviceId),
    byRoute: index("gtfs_trips_route").on(t.feedId, t.routeId),
  }),
);

/** GTFS-Stops — brauchen wir um Platform-IDs (in stop_times) auf
 *  Parent-Stoparea-IDs (in unserer locations.code) zu mappen. NL z.B. nutzt
 *  `stoparea:513745` als Gruppierungs-Code in locations, aber `3151931`/`3152315`
 *  als einzelne Platform-IDs in stop_times. Eine Departure-Anfrage für die
 *  Stoparea muss ALLE Platform-IDs mit-abdecken. */
export const gtfsStops = pgTable(
  "gtfs_stops",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    stopId: varchar("stop_id", { length: 128 }).notNull(),
    parentStation: varchar("parent_station", { length: 128 }),
    name: text("name"),
    /** 0 = stop/platform, 1 = station, 2 = entrance/exit, ... */
    locationType: integer("location_type").default(0),
    /** Lat/Lon — brauchen wir um OSM-Stops (`osm:1234`) via Coord auf den
     *  nächsten GTFS-Stop mappen zu können. Ohne Coords kein OSM-Fallback. */
    latitude: numeric("latitude"),
    longitude: numeric("longitude"),
  },
  (t) => ({
    pk: index("gtfs_stops_pk").on(t.feedId, t.stopId),
    byParent: index("gtfs_stops_parent").on(t.feedId, t.parentStation),
    byGeo: index("gtfs_stops_geo").on(t.feedId, t.latitude, t.longitude),
  }),
);

export const gtfsStopTimes = pgTable(
  "gtfs_stop_times",
  {
    feedId: varchar("feed_id", { length: 32 }).notNull(),
    tripId: varchar("trip_id", { length: 192 }).notNull(),
    stopSequence: integer("stop_sequence").notNull(),
    stopId: varchar("stop_id", { length: 128 }).notNull(),
    /** Sekunden seit Mitternacht (kann >86400 sein für Trips nach 24:00). */
    arrivalSeconds: integer("arrival_seconds").notNull(),
    departureSeconds: integer("departure_seconds").notNull(),
    /** 0=regular, 1=none, 2=must phone, 3=coordinate with driver. */
    pickupType: integer("pickup_type").default(0),
    dropOffType: integer("drop_off_type").default(0),
  },
  (t) => ({
    pk: index("gtfs_stop_times_pk").on(t.feedId, t.tripId, t.stopSequence),
    // Haupt-Index für Departure-Lookups: pro Stop + Zeit-Range scannen.
    byStop: index("gtfs_stop_times_stop").on(t.feedId, t.stopId, t.departureSeconds),
  }),
);
