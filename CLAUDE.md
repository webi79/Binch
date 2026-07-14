# Binch Mobile

## Worum geht's?

**Binch** ist eine multi-modale Reise-Such-App für Mobile (iOS/Android/Web): Flüge, Züge, Busse und Kreuzfahrten in einer einzigen Suche. Besonderheiten: Split-Ticket-Erkennung, mehrsprachige UI (de/en/fr/es), Voice-Input und zeitzonen-bewusste Anzeige.

Die App ist reiner Frontend-Client — der Backend-Server liegt separat unter `apiBaseUrl` (siehe unten).

## Tech Stack

- **Expo SDK 54** / React Native 0.81.5 / React 19
- **expo-router 6** — file-based routing
- **NativeWind 4** + Tailwind 3 — Styling
- **Zustand 5** — Client-State, persistiert via AsyncStorage
- **TanStack Query 5** — Server-State / Caching
- `lucide-react-native`, `date-fns` + `date-fns-tz`, `zod`
- `expo-speech-recognition` — Voice-Input
- TypeScript strict mode

## Projektstruktur

```
app/                    expo-router Routen
  _layout.tsx           QueryClientProvider, SafeAreaProvider, GestureHandler
  (tabs)/
    _layout.tsx         Bottom-Tabs (4 sichtbar + search hidden)
    index.tsx           Home
    saved.tsx           Saved (Stub)
    surroundings.tsx    POI/Umgebung (Stub)
    settings.tsx        Theme/Sprache/Währung
    search/
      _layout.tsx       Stack
      index.tsx         Such-Hero
      results.tsx       Ergebnisliste
      voice.tsx         Voice-Eingabe

components/
  home/                 HomeHeader, CategoryGrid, PopularTrips, RecentSearches, PromoCard
  search/               SearchHero, LocationInput, ModeSearchForm
  results/              ResultCard

lib/
  api/client.ts         API-Client (siehe Backend-Sektion)
  i18n/                 dict.ts (en/de/fr/es) + useT-Hook
  airports/timezones.ts 250+ IATA → IANA Timezone-Mapping
  voice/parse.ts        parseVoice(): Regex-Parser für Sprachbefehle
  time-format.ts        Zeitzonen-bewusste Anzeige

stores/
  searchStore.ts        Zustand: activeMode, locale, currency, theme,
                        recentSearches (max 5), recentSpots, favoriteResultIds

types/
  search.ts             TravelMode, SearchParams, SearchResult,
                        Location, SearchResponse

assets/search/          Hero-Images: flights.png, trains.png, buses.png, cruises.png
```

## Routen

| Route | Zweck |
|---|---|
| `(tabs)/` | Home |
| `(tabs)/saved` | Gespeicherte Trips (Stub) |
| `(tabs)/surroundings` | POI/Umgebung (Stub) |
| `(tabs)/settings` | Theme / Sprache / Währung |
| `(tabs)/search/` | Such-Hero (hidden tab) |
| `(tabs)/search/results` | Ergebnisliste |
| `(tabs)/search/voice` | Spracheingabe |

## Konventionen

- **Path-Alias**: `@/*` → Projekt-Root (siehe `tsconfig.json`)
- **i18n**: Alle UI-Strings über `useT()` aus `lib/i18n/useT.ts`. Locales: `en`, `de`, `fr`, `es`. Dictionary in `lib/i18n/dict.ts`.
- **Zeiten**: `SearchResult.departTime`/`arriveTime` sind ISO-UTC. Anzeige immer mit `originTz` / `destinationTz` (IANA) via `lib/time-format.ts`.
- **Brand-Farben** (`tailwind.config.js`): `brand.green #22C55E`, `brand.dark #363636`, `brand.gray #5E5E5E`
- **State**: `searchStore.ts` ist die Single Source of Truth für mode/locale/currency/theme + Recents/Favoriten. Persistiert automatisch.

## Backend / API-Vertrag

Backend lebt im selben Repo unter [`server/`](./server/) (Node 20 + Fastify 5 + Drizzle ORM + PostgreSQL 16). Setup + Architektur in [`server/README.md`](./server/README.md).

**Base URL**: aus `app.json` → `expo.extra.apiBaseUrl`. Aktuell hardcoded `http://192.168.2.84:3000` (lokaler Dev-Server). Fallback in `lib/api/client.ts`: `http://localhost:3000`.

Alle Endpoints sind GET, JSON, kein Auth-Header.

Pro Travel-Mode aggregiert das Backend **mehrere Provider parallel** (siehe `server/src/providers/registry.ts`). Tokens leben in `server/.env` — Provider ohne Token werden automatisch übersprungen.

### Zug-Quellen: db-vendo + MOTIS (wichtig)

Zwei Provider laufen parallel, `searchService.dedupe()` führt sie zusammen:

| | **db-vendo** (DBs eigene Engine, via `dbweb`-Sidecar → int.bahn.de) | **MOTIS** (offene GTFS-Daten, Transitous) |
|---|---|---|
| Routing | identisch zu bahn.de | eigener Pareto-Set |
| Gleise | **korrekt** (Köln Hbf 1-11) | DELFI-Müll (Köln Hbf „85-91") |
| Zugnamen | **korrekt** (RJX 65) | falsch (dort „IC 63") |
| Preise | **ja** (innerdeutsch) | keine |
| Limit | **~60 req/min pro IP** | unlimitiert, self-hostbar |
| Coverage | was DB verkauft | alles (CH-Nahverkehr, Tram/Bus) |

Daraus folgen zwei Regeln, die man nicht versehentlich umdrehen sollte:

1. **Bei Gleichstand gewinnt db-vendo.** `SOURCE_TRUST` in `searchService.ts` — sonst behält der Dedupe zur selben Fahrt die schlechteren Daten, nur weil MOTIS im Registry vorne steht.
2. **Das DB-Kontingent gehört der SUCHE.** Abfahrtstafeln laufen bewusst über MOTIS (`profile === "db"` → MOTIS zuerst, `routes/stops.ts`), sonst fährt die Umgebungs-/Kartenansicht die 60 req/min leer. Preis: in DE fehlen auf den Tafeln oft Gleise.

**Warum das lange nicht ging:** DBs `403 OPS_BLOCKED` war **kein IP-Block**, sondern Akamai-TLS-Fingerprinting — Nodes Cipher-Liste verrät den Nicht-Browser. Fix: `NODE_OPTIONS=--tls-cipher-list=<Chrome-Liste>` auf beiden Sidecars (YAML-Anker `x-chrome-tls` in `server/docker-compose.yml`, dort auch die Messmatrix). Kommt der Block zurück → dort ansetzen, nicht bei IP/User-Agent.

### Endpoints

| Pfad | Zweck | Query-Params |
|---|---|---|
| `/api/search/flights` | Flüge suchen | `origin`, `destination`, `originLabel`, `destLabel`, `departDate` (ISO), `passengers`, `currency` |
| `/api/search/trains` | Züge suchen | gleiche wie Flüge |
| `/api/search/buses` | Busse suchen | gleiche wie Flüge |
| `/api/search/cruises` | Kreuzfahrten suchen | gleiche wie Flüge |
| `/api/locations` | Autocomplete für Orte | `q` (string), `mode` (`FLIGHT` \| `TRAIN` \| `BUS` \| `CRUISE` \| `ALL`) |
| `/redirect/{token}` | Buchungs-Redirect (im Browser/InApp geöffnet, kein API-Call) | — |

### Response: `SearchResponse` (von `/api/search/*`)

```ts
{
  results: SearchResult[]
  source: "cache" | "live"
  fetchedAt: string  // ISO datetime
}
```

### `SearchResult` — Felder die das Backend liefern muss

- `id`, `mode`, `provider`, `providerLogo?`
- `origin`, `destination`, `originLabel`, `destLabel`
- `departTime`, `arriveTime` — ISO datetime, **UTC**
- `originTz?`, `destinationTz?` — IANA timezone (z.B. `Europe/Berlin`)
- `dateOnly?` — `true` wenn nur das Datum bekannt ist, Uhrzeit unbekannt
- `durationMinutes`, `stops`, `stopLabels[]`
- `price`, `currency`
- `deepLink` — server-only, wird vom Backend durch `redirectToken` ersetzt bevor's an den Client geht
- `redirectToken` — Client baut damit `${API_BASE_URL}/redirect/${token}`
- optional: `isRefundable`, `baggageIncluded`, `flightNumber`, `operatedBy`

### Response: `/api/locations`

```ts
{ results: Location[] }
// Location = { code, label, city, country, type: TravelMode | "ALL" }
```

### Fehler-Handling im Client

`lib/api/client.ts` wirft bei nicht-2xx:

```
Error("API {status} {statusText} for {url}")
```

Kein Retry, kein Auth-Header, kein Refresh-Token-Flow.

## App laufen lassen

```bash
npm start          # Dev-Server (wählt platform interaktiv)
npm run ios        # iOS Simulator
npm run android    # Android Emulator/Device
npm run web        # Web (Metro)
```

**Wichtig:**
- Backend muss separat unter `apiBaseUrl` laufen, sonst gehen alle Suchen ins Leere (404 / Network Error).
- Die hardcoded WLAN-IP `192.168.2.84` muss vom Phone/Simulator erreichbar sein. Bei IP-Wechsel `app.json` updaten.
- Voice-Input braucht einen Dev-Client-Build — funktioniert nicht in Expo Go.

### WSL2: KEIN `--tunnel` nötig

Der Dev-Server läuft in WSL2 (NAT), dessen IP (`172.30.x.x`) das Handy nicht
erreicht — Expo würde genau die advertisen, darum griff man früher zu
`--tunnel` (ngrok reißt ständig ab: „Tunnel connection has been closed").

Der Weg über den Windows-Host ist bereits eingerichtet: Portproxy
`0.0.0.0:8081 → WSL:8081` (+ `:3000`) und Firewall-Regel „Expo Metro". Metro ist
damit unter `192.168.2.84:8081` im WLAN erreichbar. `npm start` setzt deshalb
`REACT_NATIVE_PACKAGER_HOSTNAME=192.168.2.84` — Expo nennt dem Handy die
Windows-IP statt der WSL-IP. **Also immer `npm start`, nie `--tunnel`.**

Andere IP: `REACT_NATIVE_PACKAGER_HOSTNAME=<ip> npm start`.

Nach WSL-Neustart kann die WSL-IP wechseln → Portproxy zeigt ins Leere (Handy
verbindet nicht mehr). Dann neu setzen (PowerShell als Admin):

```powershell
$ip = (wsl hostname -I).Split()[0]
netsh interface portproxy set v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=$ip
netsh interface portproxy set v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$ip
```

## Was fehlt noch?

Offene Aufgaben, Stubs und Infrastruktur-Lücken stehen in [`TODO.md`](./TODO.md).
