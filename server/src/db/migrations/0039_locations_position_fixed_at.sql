-- Korrigierte Lagen festhalten (Okt. 2026): scripts/fix-stop-positions.ts setzt die Spalte, der
-- Monatsabgleich (import-gtfs.ts, import-stada.ts) schreibt dort keine Lage mehr — sonst holte er
-- die alte zurück (trainline führt Graz Hbf 530 m neben dem Bahnhof). Leere Spalte — nichts wird umgeschrieben.
ALTER TABLE "locations" ADD COLUMN "position_fixed_at" timestamp with time zone;
