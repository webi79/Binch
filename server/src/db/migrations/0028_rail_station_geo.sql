-- Die Bahnhöfe einer Stadt schnell finden — für die Ortssuche („Prag" →
-- Praha hl.n., siehe `mainStationsNear` in services/locationService.ts).
--
-- Nur Bahnhöfe mit HAFAS-Kennung (rund 80 000 statt 1,6 Mio. Zeilen): Der
-- allgemeine Lage-Index scannt für ein Rechteck das ganze Breitenband der
-- Welt (200–600 ms), dieser nur die Bahnhöfe darin.
CREATE INDEX IF NOT EXISTS "idx_locations_rail_geo" ON "locations" ("latitude", "longitude") WHERE "type" = 'TRAIN' AND "hafas_id" IS NOT NULL;
