-- Steige als eigene Halte.
--
-- Bisher las der Import je Station nur EINE Zeile ein — „Dortmund Hörde Bf"
-- mit fünf Bus-Steigen und zwei U-Bahn-Gleisen war ein einziger Bus-Marker,
-- die U-Bahn fiel unter die 30-%-Schwelle der Verkehrsarten ganz weg.
-- Jetzt bekommt jeder Steig eine eigene Zeile mit `parent_code` = Code seiner
-- Station und `platform` = Steig-/Gleisbezeichnung aus dem Fahrplan. Die Karte
-- zeigt eine Station mit Steigen über diese (jeder Bus-Steig mit eigener Tafel),
-- die Suche nur die Station (Tafel über alle Steige).
--
-- Beide Spalten ohne Vorgabewert: nur ein Eintrag im Katalog, die Tabelle wird
-- nicht umgeschrieben. Der Index ist partiell — nur Steige tragen den Wert.
ALTER TABLE "locations" ADD COLUMN "parent_code" varchar(64);--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "platform" varchar(16);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_locations_parent_code" ON "locations" USING btree ("parent_code") WHERE "locations"."parent_code" IS NOT NULL;
