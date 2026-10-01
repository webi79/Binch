-- Trigramm-Indizes für die Ortssuche.
--
-- WARUM: `searchLocations` filtert mit `ILIKE '%…%'` über Label, Stadt, Land und
-- Code. Ein Muster mit führendem Platzhalter kann kein B-Baum bedienen — Postgres
-- las deshalb bei JEDEM Tastendruck die ganze Tabelle. Gemessen an 1,6 Mio
-- Zeilen (437 MB): 495 ms als paralleler Komplettscan, also rund anderthalb
-- Kern-Sekunden pro getipptem Buchstaben.
--
-- Mit `pg_trgm` wird daraus ein Bitmap-Index-Scan: dieselbe Abfrage 142 ms,
-- der Endpunkt von rund 530 ms auf 11 bis 41 ms. Die vier Indizes zusammen
-- wiegen 182 MB.
--
-- Alle VIER Spalten brauchen einen: Die Bedingung ist ein ODER über alle vier,
-- und fehlt für eine davon der Index, muss Postgres wieder die ganze Tabelle
-- lesen — der Gewinn wäre komplett dahin.
--
-- `IF NOT EXISTS`, weil die Indizes auf dem Entwicklungsstand bereits von Hand
-- angelegt wurden.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_label_trgm" ON "locations" USING gin ("label" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_city_trgm" ON "locations" USING gin ("city" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_country_trgm" ON "locations" USING gin ("country" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_code_trgm" ON "locations" USING gin ("code" gin_trgm_ops);
