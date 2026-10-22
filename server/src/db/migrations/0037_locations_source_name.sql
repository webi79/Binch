-- Name des Halts im aktuellen Fahrplan (Okt. 2026). Der Monatsabgleich schreibt
-- `label` nie (teils von Hand korrigiert; Abgleich und Suche vergleichen darauf),
-- also hießen alte Zeilen weiter „Hbf Nord", obwohl der Fahrplan „Hauptbahnhof
-- Nord" sagt. Aus dieser Spalte wird der Anzeigename berechnet. Leere Spalte,
-- ohne Vorgabewert — nichts wird umgeschrieben.
ALTER TABLE "locations" ADD COLUMN "source_name" text;