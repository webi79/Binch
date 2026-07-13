CREATE TABLE IF NOT EXISTS "gtfs_calendar" (
	"feed_id" varchar(32) NOT NULL,
	"service_id" varchar(128) NOT NULL,
	"monday" boolean DEFAULT false NOT NULL,
	"tuesday" boolean DEFAULT false NOT NULL,
	"wednesday" boolean DEFAULT false NOT NULL,
	"thursday" boolean DEFAULT false NOT NULL,
	"friday" boolean DEFAULT false NOT NULL,
	"saturday" boolean DEFAULT false NOT NULL,
	"sunday" boolean DEFAULT false NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtfs_calendar_dates" (
	"feed_id" varchar(32) NOT NULL,
	"service_id" varchar(128) NOT NULL,
	"date" date NOT NULL,
	"exception_type" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtfs_routes" (
	"feed_id" varchar(32) NOT NULL,
	"route_id" varchar(128) NOT NULL,
	"agency_id" varchar(64),
	"short_name" text,
	"long_name" text,
	"type" integer DEFAULT 3 NOT NULL,
	"color" varchar(8),
	"text_color" varchar(8)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtfs_stop_times" (
	"feed_id" varchar(32) NOT NULL,
	"trip_id" varchar(192) NOT NULL,
	"stop_sequence" integer NOT NULL,
	"stop_id" varchar(128) NOT NULL,
	"arrival_seconds" integer NOT NULL,
	"departure_seconds" integer NOT NULL,
	"pickup_type" integer DEFAULT 0,
	"drop_off_type" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtfs_stops" (
	"feed_id" varchar(32) NOT NULL,
	"stop_id" varchar(128) NOT NULL,
	"parent_station" varchar(128),
	"name" text,
	"location_type" integer DEFAULT 0,
	"latitude" numeric,
	"longitude" numeric
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtfs_trips" (
	"feed_id" varchar(32) NOT NULL,
	"trip_id" varchar(192) NOT NULL,
	"route_id" varchar(128) NOT NULL,
	"service_id" varchar(128) NOT NULL,
	"headsign" text,
	"direction_id" integer
);
--> statement-breakpoint
ALTER TABLE "search_requests" ADD COLUMN IF NOT EXISTS "depart_time" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_calendar_pk" ON "gtfs_calendar" USING btree ("feed_id","service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_calendar_dates_lookup" ON "gtfs_calendar_dates" USING btree ("feed_id","service_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_calendar_dates_date" ON "gtfs_calendar_dates" USING btree ("feed_id","date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_routes_pk" ON "gtfs_routes" USING btree ("feed_id","route_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_stop_times_pk" ON "gtfs_stop_times" USING btree ("feed_id","trip_id","stop_sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_stop_times_stop" ON "gtfs_stop_times" USING btree ("feed_id","stop_id","departure_seconds");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_stops_pk" ON "gtfs_stops" USING btree ("feed_id","stop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_stops_parent" ON "gtfs_stops" USING btree ("feed_id","parent_station");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_stops_geo" ON "gtfs_stops" USING btree ("feed_id","latitude","longitude");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_trips_pk" ON "gtfs_trips" USING btree ("feed_id","trip_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_trips_service" ON "gtfs_trips" USING btree ("feed_id","service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gtfs_trips_route" ON "gtfs_trips" USING btree ("feed_id","route_id");