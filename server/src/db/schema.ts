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
    passwordHash: text("password_hash").notNull(),
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
    code: varchar("code", { length: 16 }).primaryKey(),
    label: text("label").notNull(),
    city: text("city"),
    country: text("country"),
    type: varchar("type", { length: 16 }).notNull().$type<LocationType>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    type: index("idx_locations_type").on(t.type),
  }),
);
