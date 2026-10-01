-- Label und Stadt ohne Akzente als GESPEICHERTE Spalten (Nachfolger von 0026).
--
-- 0026 hat `f_unaccent(label)` pro Abfrage gerechnet. Mit Index ist das
-- billig — aber bei Eingaben unter drei Zeichen („be") greift kein
-- Trigramm-Index, und die Funktion lief über alle 1,6 Mio. Zeilen: 2,4 s statt
-- vorher 0,7 s. Außerdem rechnete die Rangfolge sie für jeden Treffer mehrfach.
-- Gespeichert kostet die Suche wieder dasselbe wie ohne Akzent-Vergleich.
--
-- Die Ausdrucks-Indizes aus 0026 werden durch Indizes auf den Spalten ersetzt.
ALTER TABLE "locations" ADD COLUMN "label_fold" text GENERATED ALWAYS AS (f_unaccent(label)) STORED;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "city_fold" text GENERATED ALWAYS AS (f_unaccent(city)) STORED;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_locations_label_unaccent_trgm";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_locations_city_unaccent_trgm";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_label_fold_trgm" ON "locations" USING gin ("label_fold" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_city_fold_trgm" ON "locations" USING gin ("city_fold" gin_trgm_ops);
