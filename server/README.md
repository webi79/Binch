# binch-server

Backend für die Binch-Mobile-App. Aggregiert Such-Anfragen über mehrere externe Provider pro Travel-Mode (Flug / Zug / Bus / Kreuzfahrt), normalisiert die Ergebnisse, schreibt alles in Postgres und liefert dem Client eine einheitliche Liste mit kurzlebigen Redirect-Tokens.

## Stack

- Node 20 + Fastify 5
- PostgreSQL 16
- Drizzle ORM (Migrations + Queries)
- Zod (Validation)

## Setup (lokal)

```bash
# 1. Postgres starten
docker compose up -d

# 2. Dependencies + .env
cp .env.example .env
npm install

# 3. Schema migrieren
npm run db:generate     # erstellt SQL-Migration aus schema.ts (einmalig nach Schema-Änderung)
npm run db:migrate      # wendet Migrations an

# 4. Dev-Server
npm run dev
```

Server läuft default auf `http://localhost:3000`.
DB-Connection-String in `.env` → `DATABASE_URL=postgres://binch:binch@localhost:5432/binch`.

## Tokens einfügen

Pro Provider gibt's einen Slot in `.env`:

```
SKYSCANNER_API_KEY=
AMADEUS_CLIENT_ID=
AMADEUS_CLIENT_SECRET=
TRAINLINE_API_KEY=
DB_VENDO_API_KEY=
FLIXBUS_API_KEY=
BUSBUD_API_KEY=
CRUISEDIRECT_API_KEY=
```

Der jeweilige Provider unter `src/providers/<mode>/<name>.ts` enthält den TODO-Marker, wo der echte API-Call rein muss. Provider ohne Token werden im Registry automatisch übersprungen (`isConfigured()` → `false`).

## Routen

| Methode | Pfad | Beschreibung |
|---|---|---|
| GET | `/health` | Health-Check |
| GET | `/api/search/flights` | Flugsuche (alle aktiven FLIGHT-Provider parallel) |
| GET | `/api/search/trains` | Zugsuche |
| GET | `/api/search/buses` | Bussuche |
| GET | `/api/search/cruises` | Kreuzfahrtsuche |
| GET | `/api/locations?q=…&mode=…` | Autocomplete für Orte |
| GET | `/redirect/:token` | Konsumiert Redirect-Token, leitet auf Provider-DeepLink um |

Query-Parameter für Search siehe `src/routes/search.ts`.

## Datenbank-Tabellen

- `search_requests` — was der User gesucht hat (mit IP-Hash, kein Klartext)
- `provider_responses` — Roh-JSON jedes Providers + Latenz / Fehler (für Debug + Replay)
- `search_results` — normalisierte Treffer
- `redirect_tokens` — kurzlebige URL-Tokens (TTL via `REDIRECT_TOKEN_TTL_SECONDS`)
- `providers` — Provider-Registry (für UI / Steuerung — Code-Registry ist Source of Truth)
- `locations` — Autocomplete-Cache

Schema in [`src/db/schema.ts`](src/db/schema.ts), Migrations in `src/db/migrations/` (auto-generated).

## Provider-Architektur

```
src/providers/
  types.ts             # SearchProvider Interface
  registry.ts          # Mode → Provider[] Mapping
  flight/
    skyscanner.ts
    amadeus.ts
  train/
    trainline.ts
    dbVendo.ts
  bus/
    flixbus.ts
    busbud.ts
  cruise/
    cruisedirect.ts
```

Neuen Provider hinzufügen:
1. Datei unter `src/providers/<mode>/<name>.ts` anlegen (siehe bestehende als Vorlage)
2. Token-Slot in `.env.example` + `src/config.ts` ergänzen
3. In `src/providers/registry.ts` dem Mode-Array hinzufügen

## Deploy / Migration auf externen Server

Alles geht über `DATABASE_URL` — egal ob Neon, Supabase, RDS, Render, Railway, …

```bash
# Build
npm run build

# Migrate auf Ziel-DB
DATABASE_URL=postgres://… npm run db:migrate

# Start
DATABASE_URL=postgres://… npm start
```

Oder als Container: `Dockerfile` ist im Repo. Beispiel (Fly.io / Railway):

```bash
docker build -t binch-server .
docker run -p 3000:3000 --env-file .env binch-server
```
