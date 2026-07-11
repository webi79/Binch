import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIRECT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  // Self-hosted db-rest (Docker) — siehe docker-compose.yml.
  // Public Instanz https://v6.db.transport.rest ist unzuverlässig, deshalb default lokal.
  DBREST_BASE_URL: z.string().default("http://localhost:3001"),
  // MOTIS-Routing-Backend (Zug-Verbindungen aus offenen GTFS-Daten, kein
  // DB-Kontakt → unblockbar, kein Rate-Limit). Default = öffentliche
  // Transitous-Instanz als ÜBERGANG (nur Dev/Low-Traffic — deren Policy
  // ist FOSS/non-profit). Sobald die eigene MOTIS-Box auf Hetzner steht:
  // MOTIS_BASE_URL auf die eigene Instanz flippen, sonst nichts ändern.
  MOTIS_BASE_URL: z.string().default("https://api.transitous.org/api"),
  // Provider an/aus schaltbar (falls Transitous mal zickt oder wir bewusst
  // nur DB fahren wollen).
  MOTIS_ENABLED: z.coerce.boolean().default(true),

  RAPIDAPI_KEY: z.string().optional(),
  // SearchAPI.io — primärer Google-Flights-Provider (zuverlässiger Scraper:
  // volle Provider-Listen + günstige Tarife). google-flights2 (RAPIDAPI_KEY)
  // bleibt als Fallback, falls SearchAPI mal 0 Treffer liefert.
  // .trim() fängt versehentliche Leerzeichen im .env-Wert ab (z.B. "KEY= abc").
  SEARCHAPI_API_KEY: z.string().trim().optional(),
  SEARCHAPI_BASE_URL: z.string().default("https://www.searchapi.io"),
  SKYSCANNER_API_KEY: z.string().optional(),
  AMADEUS_CLIENT_ID: z.string().optional(),
  AMADEUS_CLIENT_SECRET: z.string().optional(),
  TRAINLINE_API_KEY: z.string().optional(),
  DB_VENDO_API_KEY: z.string().optional(),
  FLIXBUS_API_KEY: z.string().optional(),
  FLIXBUS_RAPIDAPI_HOST: z.string().default("flixbus2.p.rapidapi.com"),
  FLIXBUS_AFFILIATE_ID: z.string().optional(),
  BUSBUD_API_KEY: z.string().optional(),
  CRUISEDIRECT_API_KEY: z.string().optional(),

  // AeroDataBox via RapidAPI — Flughafen-Departures/Arrivals.
  AERODATABOX_KEY: z.string().optional(),
  AERODATABOX_RAPIDAPI_HOST: z.string().default("aerodatabox.p.rapidapi.com"),

  // Anthropic Claude — Travel-Agent „Bo" (Haiku 4.5). Optional: ohne Key
  // antwortet /api/chat/stream mit 503 statt den Server-Boot zu blocken.
  ANTHROPIC_API_KEY: z.string().optional(),

  // CORS-Allowlist, kommasepariert (z.B. "https://app.binch.example").
  // Ungesetzt (Dev): jeder Origin wird reflektiert. Native App-Clients
  // senden keinen Origin-Header — CORS betrifft nur Browser-Clients.
  // Beim Hetzner-Prod-Deployment setzen!
  CORS_ORIGINS: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
