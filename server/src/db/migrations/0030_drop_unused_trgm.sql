-- Die Trigramm-Indizes auf `label` und `city` aus 0024 sind seit 0027 verwaist:
-- Die Ortssuche vergleicht auf `label_fold`/`city_fold` (eigene Indizes), und
-- sonst durchsucht niemand diese Spalten per Muster. Zusammen 169 MB — die
-- Tabelle samt Indizes passte damit nicht mehr in `shared_buffers`.
-- Die einfachen B-Baum-Indizes (`idx_locations_label`, `idx_locations_city`)
-- bleiben: exakte Vergleiche (Chat-Agent) nutzen sie.
DROP INDEX IF EXISTS "idx_locations_label_trgm";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_locations_city_trgm";
