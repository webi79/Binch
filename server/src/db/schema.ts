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
  bigint,
  primaryKey,
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
    /**
     * Klasse bzw. Kabine der Suche (i18n-Schlüssel), leer = Standard.
     *
     * Gehört zur Cache-Identität: Ohne sie legte eine Suche in der 1. Klasse
     * ihre Treffer unter demselben Schlüssel ab wie eine normale — die nächste
     * normale Suche derselben Strecke bekam bis zu vier Stunden lang Preise der
     * 1. Klasse. Die Standard-Klasse (2. Klasse, Economy, Standard-Sitz) wird
     * als leer gespeichert, siehe `normalizeTravelClass` in searchService.ts.
     */
    travelClass: varchar("travel_class", { length: 64 }),
    // `ip_hash` gibt es nicht mehr (Migration 0031): ein ungesalzener SHA-256
    // der IP, bei IPv4 in Minuten umkehrbar — geschrieben, nie gelesen, nie
    // gelöscht. Die Rate-Limits zählen im Speicher (util/rateLimit.ts).
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
    // Für die Kaskade beim Aufräumen (services/retention.ts): Löscht eine
    // Suche ihre Anbieter-Antworten, setzt Postgres hier `provider_response_id`
    // auf NULL — ohne Index las es dafür je Antwort die ganze Tabelle.
    providerResponse: index("idx_search_results_provider_response").on(t.providerResponseId),
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
    // Kaskade beim Löschen alter Ergebnisse (services/retention.ts) und die
    // Prüfung „hängt hier noch ein gültiges Token?".
    result: index("idx_redirect_tokens_result").on(t.resultId),
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

/**
 * Bo-Unterhaltungen. Bisher lag der Verlauf ausschließlich im Client — ein
 * Gerätewechsel oder ein geleerter App-Speicher hat ihn mitgenommen.
 *
 * Bewusst denormalisiert: `lastMessageAt`, `lastMessagePreview` und
 * `messageCount` sind aus `chat_messages` ableitbar, stehen aber redundant
 * hier. Der häufigste Zugriff ist die Übersichts-Liste („meine letzten
 * Unterhaltungen"), und die soll die (um Größenordnungen dickere) Nachrichten-
 * Tabelle gar nicht erst anfassen: Ein Index-Scan über
 * (user_id, last_message_at) liefert die Seite fertig aus. Preis dafür ist,
 * dass diese drei Spalten beim Schreiben einer Antwort mitgezogen werden
 * müssen — das passiert in derselben Transaktion (siehe routes/chat.ts).
 */
export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Aus der ersten Nutzer-Nachricht abgeleitet, an Wortgrenze gekürzt.
     *  Null, solange die Unterhaltung leer ist (per POST angelegt, aber noch
     *  nichts gesagt). */
    title: varchar("title", { length: 120 }),
    locale: varchar("locale", { length: 8 }).notNull().default("de"),
    /** Sortier-Schlüssel der Liste. Beim Anlegen = createdAt, damit eine
     *  leere Unterhaltung nicht ans Ende der Keyset-Pagination fällt. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Angeheftet / archiviert — als ZEITPUNKT, nicht als Ja-Nein.
     *
     * Der Zeitstempel sagt zusätzlich, WANN es passiert ist, und genau daran
     * ordnen sich die angehefteten Unterhaltungen untereinander: zuletzt
     * angeheftet steht oben. Mit einem Booleschen bräuchte man dafür eine
     * zweite Spalte.
     */
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastMessagePreview: varchar("last_message_preview", { length: 200 }),
    messageCount: integer("message_count").notNull().default(0),
    /** Letzte Such-Parameter dieser Unterhaltung (aus dem `search_result`-
     *  Event mit isMain). Der Client schickt sie beim nächsten Turn als
     *  `lastSearch` zurück — mit dem Verlauf auf dem Server überlebt dieser
     *  Kontext jetzt auch das Wiederöffnen auf einem anderen Gerät.
     *  JSONB statt Spalten: reine Durchreiche, nie eine Filterbedingung. */
    lastSearch: jsonb("last_search").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /** Deckt die Liste komplett ab: filtern nach user_id, sortieren nach
     *  last_message_at (DESC), Keyset-Cursor statt OFFSET. */
    userRecent: index("idx_chat_conversations_user_recent").on(t.userId, t.lastMessageAt),
    /**
     * Die Standard-Liste fragt „meine, nicht archivierten, angeheftete zuerst".
     * Der Index deckt die ersten beiden Bedingungen; die Sortierung darüber
     * läuft im Speicher — bei einer Handvoll hundert Zeilen pro Nutzer ist das
     * billiger als ein Ausdrucks-Index, der bei jedem Schreiben mitgepflegt
     * werden müsste.
     */
    userPinned: index("idx_chat_conversations_user_pinned").on(t.userId, t.pinnedAt),
  }),
);

export type ChatMessageRole = "user" | "assistant";
/** Was die Zeile im Chat wird: eine Sprechblase (`text`), eine Ergebniskarte
 *  (`result`), eine Abfahrtstafel (`board`) oder ein Aktions-Knopf (`action`). */
export type ChatMessageKind = "text" | "result" | "board" | "action";

/**
 * Einzelne Chat-Zeilen, aufsteigend nach `seq` innerhalb einer Unterhaltung.
 *
 * `content` ist eine eigene Spalte, `payload` dagegen JSONB — das ist kein
 * Zufall, sondern die Trennlinie zwischen Gesprächs- und Anzeige-Daten: Der
 * Agent baut die Historie für Claude ausschließlich aus role + content (siehe
 * ChatMessage in services/chatAgent.ts). Diese Spalte wird also gelesen,
 * gelängt und limitiert — das gehört nach SQL. Die Anhänge (Treffer,
 * Stop-Board, Action) sieht das Modell nie; sie gehen nur zurück an den
 * Client, der sie rendert, und ihre Form variiert pro Typ und wandert mit dem
 * Frontend. Ein Spalten-Schema dafür wäre eine Wartungslast ohne Gegenwert.
 *
 * Der Unique-Index auf (conversation_id, seq) ist die Reihenfolge-Garantie:
 * Der Client rendert Karten und Knöpfe als eigene Nachrichten NACH dem Text.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).notNull().$type<ChatMessageRole>(),
    kind: varchar("kind", { length: 16 }).notNull().default("text").$type<ChatMessageKind>(),
    /** Nur bei kind="text" gesetzt — der reine Gesprächstext. */
    content: text("content"),
    /** Nur bei den Anhang-Kinds gesetzt: das rohe SSE-Event-Payload
     *  (result/params, stop/board, action/payload). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Fortlaufend ab 1 pro Unterhaltung. Wird in der Transaktion aus
     *  MAX(seq)+1 vergeben, nicht aus einem vorher gelesenen Wert. */
    seq: integer("seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    convSeq: uniqueIndex("uq_chat_messages_conv_seq").on(t.conversationId, t.seq),
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
    /**
     * Name aus der Quelle, VOLLSTÄNDIG — mit allem, was gleichnamige Halte
     * auseinanderhält („Oldham, Rochdale Road / Oldham College (Stop RA)").
     * Damit gleichen Tafel, Bahn-Ortssuche, Dubletten-Prüfung, Kartengruppierung
     * und Suche ab. ANGEZEIGT wird es nicht direkt — siehe `displayName`.
     */
    label: text("label").notNull(),
    /**
     * Der offizielle Name, so wie ihn der Nutzer sehen soll („Oldham College" —
     * derselbe Name wie in der Zeitleiste der Fahrt). NULL = `label` ist es
     * schon. Gesetzt von `scripts/fix-stop-names.ts` bzw. den Importen
     * (Regeln in `scripts/lib/stopNames.ts`). Die API liefert ihn als `label`.
     */
    displayName: text("display_name"),
    /**
     * Unterscheidungs-Zusatz („Rochdale Road · Stop RA") — NUR gesetzt, wenn
     * ein Halt derselben Art mit demselben Anzeigenamen in der Nähe steht. Die
     * App zeigt ihn dezent neben dem Namen, nie im Namen. Die API liefert ihn
     * als `detail`.
     */
    displayDetail: text("display_detail"),
    /**
     * Der Name des Halts im AKTUELLEN Fahrplan, geschrieben vom Monatsabgleich
     * (`import-gtfs.ts`). `label` schreibt der Abgleich nie (teils von Hand
     * korrigiert, und darüber gleichen Abgleich und Suche ab) — so hießen alte
     * Zeilen weiter „Hbf Nord", obwohl der Fahrplan längst „Hauptbahnhof Nord"
     * sagt. Grundlage für `displayName` (scripts/lib/stopNames.ts). NULL = Quelle
     * ohne Abgleich (OSM, StaDa) — dann zählt `label`.
     */
    sourceName: text("source_name"),
    /**
     * Seit wann hier laut Fahrplan nichts mehr hält: kein Mast dieser Verkehrsart in der Nähe,
     * geprüft nur gegen vollständige Fahrpläne (DE, NL, CH, England) und nur für Bus und Tram.
     * Karte und Suche zeigen solche Halte nicht — gespeicherte Stationen, Verlauf und Tafeln
     * finden sie weiter über den Code. NULL = bedient bzw. nicht prüfbar. Gesetzt (und bei neuer
     * Bedienung wieder geleert) von `scripts/mark-unserved-stops.ts`.
     */
    unservedAt: timestamp("unserved_at", { withTimezone: true }),
    city: text("city"),
    country: text("country"),
    /**
     * `label` bzw. `city` ohne Akzente (`f_unaccent`, Migration 0026/0027) —
     * die Ortssuche vergleicht auf diesen Spalten, damit „Munchen" München
     * findet. Von Postgres berechnet und gespeichert; nie selbst schreiben.
     * Gespeichert statt pro Abfrage gerechnet: Bei kurzen Eingaben („be")
     * greift kein Trigramm-Index, und die Funktion lief dann über alle Zeilen.
     */
    labelFold: text("label_fold").generatedAlwaysAs(sql`f_unaccent(label)`),
    cityFold: text("city_fold").generatedAlwaysAs(sql`f_unaccent(city)`),
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
    /**
     * Nur bei STEIGEN (Bussteig, Bahnsteig, Mast): der Code ihrer Station.
     * Eine Station mit Steigen erscheint nicht selbst auf der Karte, sondern
     * über ihre Steige — jeder Bus-Steig mit eigener Tafel. Die Suche zeigt
     * dagegen nur die Station; deren Tafel umfasst alle Steige. Gesetzt von
     * `scripts/lib/gtfsStands.ts` (Monatsabgleich).
     */
    parentCode: varchar("parent_code", { length: 64 }),
    /** Steig-/Gleisbezeichnung aus dem Fahrplan („3", „A") — nur bei Steigen. */
    platform: varchar("platform", { length: 16 }),
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
    // Steige einer Station; trägt auch die Frage der Karte „hat diese Station Steige?".
    parentCodeIdx: index("idx_locations_parent_code").on(t.parentCode).where(sql`${t.parentCode} IS NOT NULL`),
  }),
);

/**
 * Entfernte Haltestellen und ihr Ersatz (Okt. 2026): veraltete Zeilen, die kein
 * aktueller Fahrplan mehr führt, und Kopien desselben Halts aus einem zweiten
 * Fahrplan (Verbund neben gtfs.de) — jeweils mit dem Halt, der am selben Ort
 * an ihre Stelle tritt. Gespeicherte Stationen, Suchverlauf und Tafeln, die die
 * alte Kennung noch tragen, landen so beim Ersatz statt im Leeren; der
 * Monatsabgleich legt eine entfernte Kennung nicht wieder an, solange ihr
 * Ersatz daneben steht.
 * Angelegt von `scripts/apply-stop-replacements.ts`.
 */
export const locationReplacements = pgTable("location_replacements", {
  oldCode: varchar("old_code", { length: 64 }).primaryKey(),
  newCode: varchar("new_code", { length: 64 }).notNull(),
  /** „veraltet" (nicht mehr im Fahrplan) oder „doppelt" (Kopie aus einem zweiten Fahrplan). */
  reason: varchar("reason", { length: 16 }).notNull(),
  replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * Ein Gerät, das Meldungen empfangen kann.
 *
 * EIGENE Tabelle und nicht eine Spalte an `users`, aus zwei Gründen. Erstens
 * hat eine Person mehrere Geräte, und eine Meldung gehört auf jedes davon.
 * Zweitens — und das ist der wichtigere — braucht ein Preis-Alarm kein Konto:
 * Wer die App installiert und einen Alarm setzt, soll ihn bekommen, ohne sich
 * vorher anzumelden. Der Schlüssel ist deshalb das GERÄT, die Verknüpfung mit
 * einem Konto ist optional und kommt später dazu, wenn sich jemand anmeldet.
 *
 * `token` ist die Kennung des Expo-Push-Dienstes („ExponentPushToken[…]"). Sie
 * ist gerätegebunden und kann sich ändern (Neuinstallation, Wiederherstellung)
 * — deshalb eindeutig und mit `updatedAt`: Meldet dasselbe Gerät eine neue
 * Kennung, ersetzt sie die alte, statt eine Karteileiche zu hinterlassen.
 */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: varchar("token", { length: 255 }).notNull().unique(),
    /** Optional: gesetzt, sobald das Gerät angemeldet ist. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    platform: varchar("platform", { length: 16 }),
    /**
     * Die Sprache des Geräts — für den TEXT der Meldung.
     *
     * Sie muss hier stehen und nicht am Alarm: Geschrieben wird der Text erst
     * beim Verschicken, und zwar auf dem Server. Er hat sonst keine Möglichkeit,
     * sie zu erfahren — die App ist in dem Moment nicht beteiligt.
     *
     * Ohne dieses Feld wären alle Meldungen deutsch, in einer App mit vier
     * Sprachen. Ein Franzose bekäme „Jetzt 21 statt 27 EUR" — was er entweder
     * nicht versteht oder für einen Fehler hält.
     */
    locale: varchar("locale", { length: 5 }).notNull().default("en"),
    /**
     * Marke und Modell des Geräts — damit man WEISS, welches Handy das ist.
     *
     * Nicht für die Meldung: für die Fehlersuche. Bei fünf Kennungen desselben
     * Menschen — Neuinstallationen, zwei Testgeräte — steht in der Tabelle
     * sonst nur eine Zeichenkette wie „cih0oVrl…QCpiRs", und die Frage „auf
     * welchem Gerät kam es an?" ist von hier aus nicht zu beantworten. Genau
     * daran ist eine Diagnose stundenlang hängen geblieben.
     *
     * Kommt aus `Platform.constants` von React Native, ohne zusätzliche
     * Abhängigkeit. Es ist keine Kennung eines Menschen: „Xiaomi 23127PN0CG"
     * beschreibt ein Modell, das es millionenfach gibt.
     */
    deviceModel: varchar("device_model", { length: 64 }),
    /**
     * Die Zeitzone des Geräts — für die RUHEZEIT.
     *
     * Ein Preis-Alarm ist keine dringende Nachricht. Er um drei Uhr nachts zu
     * schicken, weil zufällig jemand am anderen Ende der Welt diese Strecke
     * gesucht hat, ist genau die Sorte Aufdringlichkeit, wegen der Leute
     * Meldungen ganz abschalten — und dann ist die Funktion tot statt laut.
     *
     * Der Server kann die Ortszeit nicht erraten: Er weiß nur, wann eine fremde
     * Suche lief, und die kann von überall kommen. Deshalb meldet das Gerät
     * seine Zone (IANA, z.B. „Europe/Berlin") beim Registrieren mit.
     */
    timezone: varchar("timezone", { length: 64 }).notNull().default("Europe/Berlin"),
    /**
     * Wann dieses Gerät zuletzt eine Meldung EMPFANGEN hat — von ihm selbst
     * bestätigt.
     *
     * Der Grund für diese Spalte: Dass Firebase eine Nachricht annimmt und eine
     * Kennung zurückgibt, ist KEIN Beweis, dass sie auf dem Gerät ankam. Sie
     * kann in der Warteschlange liegen, vom Energiesparmodus zurückgehalten
     * werden oder an einem abgeschalteten Kanal scheitern — Firebase meldet in
     * allen drei Fällen Erfolg. Der einzige belastbare Nachweis kommt vom
     * Gerät.
     *
     * `lastTappedAt` ist der stärkere der beiden: Empfangen kann die App auch
     * im Hintergrund melden, angetippt heißt, ein Mensch hat die Meldung
     * gesehen.
     */
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastTappedAt: timestamp("last_tapped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUser: index("idx_push_tokens_user").on(t.userId),
  }),
);

/**
 * Ein Preis-Alarm auf einer STRECKE.
 *
 * Bewusst auf der Strecke und nicht auf einer einzelnen Verbindung: Der
 * günstigste Zug von Köln nach Bielefeld am 12. September ist morgen ein
 * anderer als heute. Ein Alarm auf genau einer Verbindung ginge fast immer ins
 * Leere.
 *
 * DER INDEX IST DER GANZE ENTWURF. Geprüft wird nicht in einem eigenen Lauf,
 * der die Anbieter abfragt — das verbietet sich, das Kontingent der Bahn liegt
 * bei rund 60 Anfragen pro Minute und gehört der Suche. Geprüft wird, wenn
 * IRGENDJEMAND diese Strecke sucht: Die Antwort liegt dann ohnehin vor, und es
 * bleibt ein indizierter Nachschlag. Kosten für die Anbieter: null.
 *
 * `lastNotifiedAt` und `lastSeenPrice` sind die Entprellung. Ohne sie feuerte
 * derselbe Alarm bei JEDER fremden Suche auf dieser Strecke erneut — bei einer
 * beliebten Verbindung also im Minutentakt.
 */
export const priceAlerts = pgTable(
  "price_alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Das Gerät, das die Meldung bekommt. Ein Alarm ohne Ziel wäre sinnlos. */
    pushTokenId: uuid("push_token_id")
      .notNull()
      .references(() => pushTokens.id, { onDelete: "cascade" }),
    /** Optional, wie bei `pushTokens` — ein Alarm braucht kein Konto. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),

    mode: varchar("mode", { length: 8 }).notNull(),
    origin: varchar("origin", { length: 64 }).notNull(),
    destination: varchar("destination", { length: 64 }).notNull(),
    /** Nur zur Anzeige in der Meldung — Codes sagen niemandem etwas. */
    originLabel: varchar("origin_label", { length: 160 }).notNull(),
    destLabel: varchar("dest_label", { length: 160 }).notNull(),
    departDate: date("depart_date").notNull(),
    /**
     * Die Rückreise — LEERE ZEICHENKETTE bei einer einfachen Fahrt, nicht `null`.
     *
     * Sie muss mit in den Schlüssel, und das ist keine Genauigkeitsfrage,
     * sondern eine Preisfrage: Eine Suche mit Rückreise liefert eine andere
     * Trefferliste als dieselbe Strecke ohne, und damit einen anderen
     * günstigsten Preis. Ohne dieses Feld verglich ein Alarm, der aus einer Hin-
     * und Rückreise gesetzt wurde, seine Schwelle mit dem Preis einer einfachen
     * Fahrt — und feuerte bei der nächsten fremden Suche sofort.
     *
     * WARUM KEIN `date` UND KEIN `null`: In Postgres gelten zwei `NULL` als
     * VERSCHIEDEN. Der eindeutige Index unten hätte für einfache Fahrten also
     * gar nicht gegriffen — man hätte beliebig viele Alarme auf dieselbe
     * Strecke anlegen können, und das Ersetzen eines bestehenden (der
     * `onConflictDoUpdate`-Pfad) wäre still ins Leere gelaufen. Eine leere
     * Zeichenkette ist ein Wert wie jeder andere und macht beides richtig.
     */
    returnDate: varchar("return_date", { length: 10 }).notNull().default(""),
    /**
     * Reisende und Klasse — beide gehören in den Schlüssel, und zwar aus
     * demselben Grund wie die Währung.
     *
     * Der Preis in einer Antwort ist der GESAMTPREIS der Reisegruppe (siehe
     * `dbVendo.ts`, dort wird der Preis je Person mit der Zahl multipliziert).
     * Ohne diese beiden Felder verglich der Server eine Schwelle, die für vier
     * Personen in der Business-Klasse gesetzt wurde, mit dem Preis einer
     * fremden Suche für eine Person in der Economy — und meldete einen
     * sensationellen Sturz von 420 auf 95. Wer darauf tippt, findet 420.
     *
     * Der SUCH-Cache führt beide längst in seinem Schlüssel; der Alarm hatte sie
     * nicht. Es ist dieselbe Klasse Fehler wie bei der Währung: eine Zahl gegen
     * eine Schwelle gehalten, die etwas anderes bedeutete.
     */
    passengers: integer("passengers").notNull().default(1),
    /** i18n-Schlüssel der Klasse, oder leer. Wird nur verglichen, nie gedeutet. */
    travelClass: varchar("travel_class", { length: 60 }).notNull().default(""),

    currency: varchar("currency", { length: 8 }).notNull(),
    /**
     * Der Preis, der beim Anlegen auf dem Bildschirm stand.
     *
     * Gespeichert, weil ohne ihn später nicht mehr zu sagen wäre, worauf sich
     * die gewählte Schwelle bezog — und weil die Meldung „war 27, ist jetzt 21"
     * ungleich mehr sagt als „ist jetzt 21".
     */
    basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(),
    desiredPrice: numeric("desired_price", { precision: 10, scale: 2 }).notNull(),
    notifyOnRise: boolean("notify_on_rise").notNull().default(false),

    /** Zuletzt bei einer Prüfung gesehener günstigster Preis. */
    lastSeenPrice: numeric("last_seen_price", { precision: 10, scale: 2 }),
    lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
    /**
     * Der Preis, mit dem GEMELDET wurde — nicht der zuletzt gesehene.
     *
     * Die beiden sind verschieden, und der Unterschied ist der Grund für diese
     * Spalte: `lastSeenPrice` wird bei JEDER Prüfung fortgeschrieben, auch wenn
     * nichts gemeldet wurde. Wer später fragt „mit welcher Zahl kam die
     * Meldung?", bekäme also irgendeinen späteren Preis.
     *
     * Gebraucht wird das, weil die App eine Meldung verpassen kann: Kommt sie
     * an, während die App tot ist, und öffnet der Nutzer die App später NORMAL
     * statt über die Meldung, erfährt sie davon auf keinem anderen Weg — Android
     * hat die Meldung nativ angezeigt, ohne dass JavaScript lief. Der Server ist
     * dann die einzige Quelle, und er muss die Zahl von damals kennen, nicht
     * eine von heute. Wir schätzen keine Preise; ein nachträglich eingesetzter
     * wäre genau das.
     */
    notifiedPrice: numeric("notified_price", { precision: 10, scale: 2 }),
    /** Abgelaufen oder vom Nutzer abgeschaltet — bleibt für den Verlauf stehen. */
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    /**
     * Der Nachschlage-Index der Prüfung. Genau die vier Felder, mit denen eine
     * Suche hereinkommt, und `active` davor, damit abgeschaltete Alarme gar
     * nicht erst gelesen werden.
     */
    byRoute: index("idx_price_alerts_route").on(
      t.active,
      t.mode,
      t.origin,
      t.destination,
      t.departDate,
    ),
    byToken: index("idx_price_alerts_token").on(t.pushTokenId),
    /** Eine Strecke trägt je Gerät höchstens einen Alarm — siehe Client. */
    /**
     * Die Rückreise gehört MIT in die Eindeutigkeit: Dieselbe Strecke einmal
     * einfach und einmal hin und zurück sind zwei verschiedene Beobachtungen
     * mit zwei verschiedenen Preisen, nicht ein Alarm, der den anderen ersetzt.
     */
    uniquePerDevice: uniqueIndex("uq_price_alerts_device_route").on(
      t.pushTokenId,
      t.mode,
      t.origin,
      t.destination,
      t.departDate,
      t.returnDate,
      // Vier Personen in der Business sind eine ANDERE Beobachtung als eine in
      // der Economy — kein Alarm, der den anderen ersetzt.
      t.passengers,
      t.travelClass,
      t.currency,
    ),
  }),
);

/**
 * Verbrauch von Luftbild-Anbietern mit Freikontingent (routes/imagery.ts) —
 * heute nur Esri: 2 Mio. Kacheln je Abrechnungszeitraum frei, darüber kostet
 * es. Der Server zählt jede durchgereichte Kachel und schaltet Esri ab, bevor
 * das Kontingent (oder das Tagesbudget) erreicht ist.
 */
export const imageryUsage = pgTable(
  "imagery_usage",
  {
    provider: varchar("provider", { length: 32 }).notNull(),
    /**
     * Der Zeitraum, „JJJJ-MM-TT" (UTC): beim Anbieter-Topf („esri") der Beginn
     * des Abrechnungszeitraums, beim Tages-Topf („esri-day") der Tag. Der Name
     * stammt aus der ersten Fassung, in der hier nur Monate standen.
     */
    month: varchar("month", { length: 10 }).notNull(),
    tiles: bigint("tiles", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.month] }),
  }),
);
