-- GTFS-Schedule-Tabellen für Länder ohne HAFAS-Profile (NL/FR/IT/ES/CZ/…).
-- Eine Tabelle pro GTFS-Entity, feed_id als Diskriminator pro Land/Quelle.

CREATE TABLE IF NOT EXISTS gtfs_calendar (
  feed_id varchar(32) NOT NULL,
  service_id varchar(128) NOT NULL,
  monday boolean NOT NULL DEFAULT false,
  tuesday boolean NOT NULL DEFAULT false,
  wednesday boolean NOT NULL DEFAULT false,
  thursday boolean NOT NULL DEFAULT false,
  friday boolean NOT NULL DEFAULT false,
  saturday boolean NOT NULL DEFAULT false,
  sunday boolean NOT NULL DEFAULT false,
  start_date date NOT NULL,
  end_date date NOT NULL
);
CREATE INDEX IF NOT EXISTS gtfs_calendar_pk ON gtfs_calendar (feed_id, service_id);

CREATE TABLE IF NOT EXISTS gtfs_calendar_dates (
  feed_id varchar(32) NOT NULL,
  service_id varchar(128) NOT NULL,
  date date NOT NULL,
  exception_type int NOT NULL
);
CREATE INDEX IF NOT EXISTS gtfs_calendar_dates_lookup ON gtfs_calendar_dates (feed_id, service_id, date);
CREATE INDEX IF NOT EXISTS gtfs_calendar_dates_date ON gtfs_calendar_dates (feed_id, date);

CREATE TABLE IF NOT EXISTS gtfs_routes (
  feed_id varchar(32) NOT NULL,
  route_id varchar(128) NOT NULL,
  agency_id varchar(64),
  short_name text,
  long_name text,
  type int NOT NULL DEFAULT 3,
  color varchar(8),
  text_color varchar(8)
);
CREATE INDEX IF NOT EXISTS gtfs_routes_pk ON gtfs_routes (feed_id, route_id);

CREATE TABLE IF NOT EXISTS gtfs_trips (
  feed_id varchar(32) NOT NULL,
  trip_id varchar(192) NOT NULL,
  route_id varchar(128) NOT NULL,
  service_id varchar(128) NOT NULL,
  headsign text,
  direction_id int
);
CREATE INDEX IF NOT EXISTS gtfs_trips_pk ON gtfs_trips (feed_id, trip_id);
CREATE INDEX IF NOT EXISTS gtfs_trips_service ON gtfs_trips (feed_id, service_id);
CREATE INDEX IF NOT EXISTS gtfs_trips_route ON gtfs_trips (feed_id, route_id);

CREATE TABLE IF NOT EXISTS gtfs_stop_times (
  feed_id varchar(32) NOT NULL,
  trip_id varchar(192) NOT NULL,
  stop_sequence int NOT NULL,
  stop_id varchar(128) NOT NULL,
  arrival_seconds int NOT NULL,
  departure_seconds int NOT NULL,
  pickup_type int DEFAULT 0,
  drop_off_type int DEFAULT 0
);
CREATE INDEX IF NOT EXISTS gtfs_stop_times_pk ON gtfs_stop_times (feed_id, trip_id, stop_sequence);
CREATE INDEX IF NOT EXISTS gtfs_stop_times_stop ON gtfs_stop_times (feed_id, stop_id, departure_seconds);
