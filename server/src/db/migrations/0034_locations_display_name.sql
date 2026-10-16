-- Offizieller Anzeigename und Unterscheidungs-Zusatz der Haltestellen.
--
-- `label` trägt den Namen der Quelle samt allem, was gleichnamige Halte
-- auseinanderhält („Oldham, Rochdale Road / Oldham College (Stop RA)"). Er
-- bleibt, wie er ist — Tafel, Bahn-Ortssuche und Dubletten-Prüfung gleichen
-- über ihn ab. Angezeigt wird künftig `display_name` („Oldham College", NULL =
-- `label` ist schon der offizielle Name), und `display_detail` nur dort, wo ein
-- gleichnamiger Halt daneben steht. Regeln: scripts/lib/stopNames.ts.
--
-- Beide Spalten ohne Vorgabewert: das Anlegen ist damit nur ein Eintrag im
-- Katalog, die Tabelle wird nicht umgeschrieben.
ALTER TABLE "locations" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "display_detail" text;--> statement-breakpoint
-- Die Ortssuche findet über BEIDE Namen: „Rochdale Road" über `label`,
-- „Riverside Close" (der Fahrplan-Name eines OSM-Halts namens „Glovers Close")
-- über `display_name`. Ausdrucks-Index statt gespeicherter Spalte wie bei
-- `label_fold` (0027): Eine gespeicherte Spalte hätte die ganze Tabelle samt
-- elf Indizes neu geschrieben, minutenlang gesperrt. Nur Zeilen MIT eigenem
-- Anzeigenamen — alle anderen findet schon `label_fold`. Die Suche muss genau
-- diesen Ausdruck verwenden (`f_unaccent(display_name)`), sonst greift er nicht.
CREATE INDEX IF NOT EXISTS "idx_locations_display_name_fold_trgm" ON "locations" USING gin (f_unaccent("display_name") gin_trgm_ops) WHERE "display_name" IS NOT NULL;
