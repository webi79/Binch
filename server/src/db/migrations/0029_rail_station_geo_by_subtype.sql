-- Ersetzt den Teil-Index aus 0028: Bahnhöfe über ihre UNTERART statt über die
-- HAFAS-Kennung. Praha hl.n. und Warszawa Centralna haben keine Kennung (nur
-- StaDa bzw. OSM) und fielen damit aus „die Bahnhöfe der Stadt" heraus.
DROP INDEX IF EXISTS "idx_locations_rail_geo";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_rail_geo" ON "locations" ("latitude", "longitude") WHERE "type" = 'TRAIN' AND "subtype" IN ('LONG_DISTANCE', 'REGIONAL', 'SUBURBAN');
