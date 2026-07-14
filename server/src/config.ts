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
  // dbweb-Sidecar (db-vendo-client, DB_PROFILE=dbweb → int.bahn.de). Liefert
  // pro Zug-Verbindung PREIS + Recon-Token (für den bahn.de-Direkt-Buchungs-
  // link). Anders als das db/dbnav-Profil NICHT geblockt (anderer Host), aber
  // ~60 req/min limitiert → Enrichment ist best-effort + gecacht.
  DBWEB_BASE_URL: z.string().default("http://localhost:3002"),
  // bahn.de „Reise teilen" — Recon → vbid → Direkt-Buchungslink.
  BAHN_TEILEN_URL: z.string().default("https://www.bahn.de/web/api/angebote/verbindung/teilen"),
  // Provider an/aus schaltbar (falls Transitous mal zickt oder wir bewusst
  // nur DB fahren wollen). Bewusst KEIN z.coerce.boolean() — das macht aus
  // dem String "false" ein true (Boolean("false")===true). Nur "false"/"0"
  // schalten ab, alles andere (inkl. unset → Default) lässt an.
  MOTIS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

  /**
   * db-vendo als SUCH-Provider (Zug + Bus) — über den DBWEB-Sidecar (int.bahn.de).
   *
   * Historie: Stand vorher auf AUS, weil die DB uns blockte (403 OPS_BLOCKED,
   * 0 Treffer bei 72 Aufrufen). Das war KEINE IP-Sperre, sondern Akamais
   * TLS-Fingerprinting — Nodes Cipher-Liste verrät den Nicht-Browser. Mit
   * `NODE_OPTIONS=--tls-cipher-list=<Chrome>` auf den Sidecars (docker-compose.yml)
   * antwortet int.bahn.de wieder.
   *
   * Warum das die WICHTIGSTE Zug-Quelle ist: db-vendo redet mit DBs eigener
   * Routing-Engine. Seine Ergebnisse sind per Konstruktion die, die auch bahn.de
   * zeigt — inklusive korrekter GLEISE, korrekter ZUGNAMEN (RJX 63, nicht IC 63)
   * und PREISEN. Genau die drei Dinge, die MOTIS aus offenen GTFS-Daten nicht
   * korrekt liefern kann (DELFI hat für Köln Hbf Gleis 85-91 statt 1-11).
   *
   * MOTIS bleibt parallel aktiv: es deckt ab, was DB nicht verkauft (Schweizer
   * Nahverkehr, Tram/Bus-Zubringer). Beide laufen im Registry parallel, der
   * Dedupe in searchService führt sie zusammen.
   */
  DBVENDO_SEARCH_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

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
