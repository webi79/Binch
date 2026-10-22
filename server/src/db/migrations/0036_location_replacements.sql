-- Entfernte Haltestellen und ihr Ersatz am selben Ort (Okt. 2026): veraltete
-- Zeilen, die kein aktueller Fahrplan mehr führt, und Kopien desselben Halts aus
-- einem zweiten Fahrplan. Alte Kennungen in gespeicherten Stationen, im
-- Suchverlauf und in Tafel-Aufrufen landen so beim Ersatz; der Monatsabgleich
-- legt eine entfernte Kennung nicht wieder an, solange ihr Ersatz daneben steht.
-- Neue, leere Tabelle — nichts wird umgeschrieben.
CREATE TABLE IF NOT EXISTS "location_replacements" (
	"old_code" varchar(64) PRIMARY KEY NOT NULL,
	"new_code" varchar(64) NOT NULL,
	"reason" varchar(16) NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL
);
