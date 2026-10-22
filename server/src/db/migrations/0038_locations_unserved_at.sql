-- Halte, an denen laut Fahrplan nichts mehr hält (Okt. 2026): Karte und Suche blenden sie
-- aus, gespeicherte Stationen und Tafeln finden sie weiter über den Code. Gesetzt und bei neuer
-- Bedienung wieder geleert von scripts/mark-unserved-stops.ts. Leere Spalte — nichts wird umgeschrieben.
ALTER TABLE "locations" ADD COLUMN "unserved_at" timestamp with time zone;