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

## Anmeldung über Apple und Google

Der Endpunkt `POST /api/auth/oauth` nimmt ein **ID-Token** des Anbieters
entgegen und prüft es gegen dessen öffentlichen Schlüsselsatz
(`src/services/oauthVerify.ts`). Ohne Konfiguration antwortet er mit `503` —
lieber gar keine Anmeldung als eine ungeprüfte.

### Umgebungsvariablen (`server/.env`)

```bash
# Kommagetrennt. ALLE Client-IDs, die zu dieser App gehören — Google vergibt
# pro Plattform eine eigene, und das Token trägt die der Plattform, auf der es
# entstanden ist. Es dürfen nur die eigenen drinstehen: Diese Liste ist die
# Prüfung, die verhindert, dass ein gültiges Token einer FREMDEN App als
# Anmeldung durchgeht.
GOOGLE_CLIENT_IDS=1234-android.apps.googleusercontent.com,1234-ios.apps.googleusercontent.com

# Für Apple die Bundle-ID der App (bei nativer Anmeldung ist sie der Empfänger).
APPLE_CLIENT_IDS=com.binch.mobile
```

Dieselben IDs müssen auf der Client-Seite stehen (`app.config.js` → `extra`),
gefüllt aus `GOOGLE_CLIENT_ID_ANDROID`, `GOOGLE_CLIENT_ID_IOS`,
`GOOGLE_CLIENT_ID_WEB`. Fehlen sie dort, blendet der Anmelde-Bildschirm den
Knopf aus, statt einen anzubieten, der nicht funktioniert.

### Was der Endpunkt tut

1. Prüft Signatur, Aussteller (`iss`), Empfänger (`aud`) und Gültigkeit.
2. Sucht die Verknüpfung über `(provider, sub)` — **nie** über die E-Mail.
3. Ist sie neu und meldet der Anbieter die E-Mail als **bestätigt**, hängt er
   sie an ein bestehendes Konto mit dieser Adresse. Ohne Bestätigung nicht —
   das wäre sonst eine Konto-Übernahme.
4. Sonst legt er ein Konto ohne Passwort an (`password_hash` ist `NULL`).

### Migration

`src/db/migrations/0013_*.sql` legt `user_identities` an und macht
`users.password_hash` nullable. Vor dem Start einspielen:

```bash
npm run db:migrate
```
