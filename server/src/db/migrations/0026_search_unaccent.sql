-- Ortssuche ohne Rücksicht auf Akzente und Umlaute.
--
-- WARUM: `ILIKE` unterscheidet „u" und „ü". Wer „Munchen", „Dusseldorf",
-- „Koln" oder „Zurich" tippt (auf vielen Tastaturen der Normalfall), fand
-- nichts — oder Falsches: „Koln" lieferte polnische Haltestellen in Kolno.
--
-- `unaccent` ist nur STABLE (das Wörterbuch ließe sich austauschen) und damit
-- nicht indexfähig. Die Hülle `f_unaccent` legt das Wörterbuch fest und ist
-- IMMUTABLE — so kann ein Ausdrucks-Index sie tragen. Die Suche muss GENAU
-- diesen Ausdruck verwenden (`f_unaccent(label) ILIKE f_unaccent(…)`), sonst
-- greift der Index nicht und Postgres liest wieder die ganze Tabelle.
--
-- Nur Label und Stadt: Land und Code bleiben bei ihren bisherigen Indizes
-- (0024), dort tippt niemand Akzente.
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_label_unaccent_trgm" ON "locations" USING gin (f_unaccent("label") gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_city_unaccent_trgm" ON "locations" USING gin (f_unaccent("city") gin_trgm_ops);
