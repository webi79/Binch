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
| `/api/search/trains` | Züge suchen | gleiche wie Flüge + `travelClass`, `fareProfile` („bc50+dt+dto+t15+bike": Karte, Deutschlandticket, nur D-Ticket, Mindest-Umstieg, Fahrrad — `server/src/util/fareProfile.ts`; gilt für DB, MOTIS und die Preis-Anreicherung; Teil von Cache- UND Alarm-Identität) |
| `/api/search/buses` | Busse suchen | gleiche wie Flüge |
| `/api/search/cruises` | Kreuzfahrten suchen | gleiche wie Flüge |
| `/api/locations` | Autocomplete für Orte | `q` (string), `mode` (`FLIGHT` \| `TRAIN` \| `BUS` \| `CRUISE` \| `ALL`) |
| `/redirect/{token}` | Buchungs-Redirect (im Browser/InApp geöffnet, kein API-Call) | — |
| `/api/live/trip` | Live-Ansicht: Halte mit Lage + Zeiten, Linienführung, `boardIndex` | `tripId`, `stopCode`, `atTime` |
| `DELETE /api/auth/me` | Konto löschen — sofort, alles per `ON DELETE CASCADE` (neue Konto-Tabellen MÜSSEN so auf `users` verweisen) | Bearer-Token |
| `/api/auth/me/export` | Datenauskunft als JSON (ohne Kennwort/Push-Kennung); die App hängt ihre Gerätedaten an | Bearer-Token |
| `PUT /api/reminders` | Abfahrts-/Ausstiegs-Erinnerungen eines Geräts ERSETZEN; der Server schickt sie per Push (`services/tripReminders.ts`, lokale Wecker kamen auf Xiaomi nicht an) | `X-Push-Token`, `items[]` |
| `POST /api/alerts/test` | Test-Mitteilung an das EIGENE Gerät nach `delaySec` (≤ 15, Kanal `trip-reminders`, 1×/20 s) — Einstellungen → Mitteilungen → „Zustellung prüfen". Jeder Versand steht als `[push] kanal→kennung…:ok` im Server-Log; ob es ERSCHEINT, belegt nur `push_tokens.last_delivered_at` (App quittiert Empfang/Tipp) | `X-Push-Token`, `title`, `body`, `delaySec` |
| `/api/bo/tasks` (GET/POST, `/:id` PATCH/DELETE, `/:id/run` POST, `/:id/runs` GET) | Bos geplante Aufgaben (eigener Bereich „Geplant" im Bo-Fenster, geöffnet aus der Seitenleiste: `components/assistant/ScheduledPage.tsx` + Blatt `TaskSheet.tsx`; Server `services/boTasks.ts`): Lage einer Zugstrecke zur Uhrzeit an gewählten Tagen (Bitmaske Mo=1…So=64), optional Wache bis `watchUntil` (alle 10 Min, nur NEUE Störungen). Nur mit Konto, max. 5 aktive. Angelegt wird im Blatt (Von/Nach = Ortswähler der Suche, Uhrzeit = `TimeSheet` des Datumswählers). Bo legt NICHT selbst an: Werkzeug `propose_task` → Ereignis `task_proposal` → Karte → App schickt POST erst nach „Anlegen". Texte feste Vorlagen (de/en/fr/es), „unbekannt" ist nie „alles gut" (Echtzeit über `departRealtime`: 0 Min = pünktlich, keine Angabe = unbekannt); Push-Kanal `bo-updates`, Schalter `push_tokens.bo_updates_enabled`. Das Gerät wird über `push_tokens.user_id` gefunden: Die App meldet `/api/alerts/device` mit Bearer-Token an, `POST /api/auth/logout` mit `pushToken` löst es wieder | Bearer-Token |

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
- `durationMinutes`, `stops`, `stopLabels[]` — `stops` zählt die **Umstiege** (Flug: Zwischenlandungen), `stopLabels` nennt die Umstiegshalte; die Halte unterwegs stehen am Leg (`legs[].stops`/`stopovers`). Eine einzelne Fahrt (Tafel → Zeitleiste) hat `stops: 0`.
- `price`, `currency`
- `deepLink` — server-only, wird vom Backend durch `redirectToken` ersetzt bevor's an den Client geht
- `redirectToken` — Client baut damit `${API_BASE_URL}/redirect/${token}`
- optional: `isRefundable`, `baggageIncluded`, `flightNumber`, `operatedBy`

### Response: `/api/locations`

```ts
{ results: Location[] }
// Location = { code, label, detail?, city, country, type: TravelMode | "ALL" }
```

**Haltestellennamen:** `label` ist überall (Suche, Karte, Tafel, `/api/locations/by-codes`, Bo) der **offizielle Anzeigename** — DB-Spalte `locations.display_name`, sonst `locations.label`. Das DB-`label` selbst bleibt der volle Quellname („Oldham, Rochdale Road / Oldham College (Stop RA)") und dient nur Abgleichen (Tafel, HAFAS, Dubletten, Kartengruppierung); die Suche findet über beide. `detail` („Rochdale Road · Stop RA") gibt es nur bei gleichnamigem Halt derselben Art ≤ 400 m — dezent neben dem Namen zeigen, nie im Namen. In Großbritannien, wo beide Straßenseiten gleich heißen, ist es sonst das häufigste Fahrtziel von dort („→ Truro"). Regeln: `server/scripts/lib/stopNames.ts`, Bestand: `server/scripts/fix-stop-names.ts`. Der Monatsabgleich schreibt `label` nie (teils von Hand korrigiert); den heutigen Fahrplan-Namen hält `source_name` (Migration 0037). Der Anzeigename übernimmt ihn nur, wenn er kein Wort verliert und eines hinzufügt („Hbf Nord" → „Hauptbahnhof Nord"; der Ort vorn aus dem alten Präfix-Skript bleibt). Ausnahme Wien (`viennaName`): Bus, Tram und U-Bahn heißen wie bei den Wiener Linien („Hauptbahnhof", „Rennweg" — ohne den Bezirksteil des alten Präfix-Skripts und ohne „Wien"), Bahnhöfe behalten den ÖBB-Namen („Wien Mitte"). Steige aus Fahrplänen tragen den Namen ihrer Station, OSM-Masten ihren eigenen. **Gleichnamige Halte verschiedener Verkehrsart (S-Bahnhof und Bushalt „Dortmund Universität") sind nie derselbe Halt** — weder in der Suche (`isSameStop` in `locationService.ts`, Treffer tragen `kind`) noch auf der Karte; gleichnamige Halte derselben Art: in der Suche ein Treffer, auf der Karte einzeln (Bus) bzw. eine Station aus mehreren Quellen (Bahn/Stadtbahn).

**Tafel** (`/api/stops/:code/{departures|arrivals}`): `stop = { code, label, hafasId, detail?, tz?, servedBy? }` — `tz` ist die Ortszeit-Zone des Halts; die Tafel-Zeiten (UTC) werden in ihr angezeigt, mit Hinweis „Ortszeit (UTC+1)", wenn sie von der Gerätezeit abweicht (`localTimeHint` in `lib/time-format.ts`). `servedBy = { name, distanceM }` heißt: Die Zeiten stammen von einem ANDEREN, nahen Halt (> 30 m, anderer Name) — die App sagt das über der Liste („Zeiten von „X" · 48 m entfernt").

**Tafel-Quellen** (`boardForStop` in `server/src/routes/stops.ts`, Stand 27.10.2026): Fahrplan (NL/FR/GB/CZ/BE …) → Bus-/Tram-Steig über MOTIS → DE über MOTIS (Kontingent!) → HAFAS-Profil → MOTIS. Tote HAFAS-Endpunkte: VVT + SVV (liefern HTML → Tirol/Salzburg über `oebb`), BLS/ZVV/TPG (DNS weg → Schweiz läuft über MOTIS). Bahnhöfe mit ÖBB-Nummer (81…) immer über `oebb`, liefert ein Verbund-Profil nichts → `oebb`, dann MOTIS. Multi-HAFAS fragt nur die Verkehrsarten des Halts ab (`products`, sonst blieben am Wiener Hbf von 25 Abfahrten 8 Züge). Eine Tafel liefert 25 Abfahrten; eine gespeicherte mit < 5 noch kommenden gilt als verbraucht (`stillUpcoming` in `stopInfoService.ts`), die App lädt eine offene Tafel nach, wenn ihr der Vorrat ausgeht. **MOTIS-Halt-Wahl** (`motisClient.ts`/`motisPlaces.ts`): Der Geocoder liefert je Name EINEN Vertreter aus irgendeinem Feed — oft einen Spiegel aus dem Fahrplan eines anderen Landes (`be-sncb` „Frankfurt Main (DE)", `nl-OpenOV` „Innsbruck Hbf", `eu-flixbus`): `feedRank` stellt sie hinten an. Der `at-Railway-…-Reference-Data`-Feed ist für ÖSTERREICHISCHE Halte (`_at:`/`_Pat:`) der Bahnfahrplan selbst, kein Referenz-Abbild (`isReferenceFeedId`). Die Knoten-Entdeckung prüft, ob es den gekürzten Eltern-Knoten gibt (Berlin Hbf: `de-VBB_…:900003200` → 404). Liefert der gewählte Halt 0 Fahrten, probiert die Tafel gleichnamige Halte an unserer Koordinate (`motisBoardAlternatives`) und merkt sich den Treffer.

**Korrigierte Lagen** (`position_fixed_at`, Migration 0039): `fix-stop-positions.ts` setzt die Marke, der Monatsabgleich (`import-gtfs.ts`, `import-stada.ts`) schreibt dort keine Lage mehr — trainline führt manche Bahnhöfe Hunderte Meter daneben (Graz Hbf 530 m) und hätte jede Korrektur monatlich zurückgedreht. Österreichische `sta:`-Bahnhöfe gegen die ÖBB-Lage (`client.stop(uic)`) geprüft statt gegen den gleichnamigen MVO-Halt: zwei Orte, zwei Bahnhöfe (Tulln vs. Tulln Stadt).

**Steige** (`locations.parent_code` = Station, `platform` = Steig; Migration 0035): Eine Station mit ≥ 2 Steigen hat je Steig eine eigene Zeile (`server/scripts/lib/gtfsStands.ts`, angelegt im Monatsabgleich `import-gtfs.ts`). Die Karte zeigt die Steige statt der Station (Bus- und Tram-Steige einzeln, U-Bahn und Bahn je Station EIN Marker mit EINER Tafel über alle Gleise — gruppiert nach dem Namen der Station, `parentName` in `routes/surroundings.ts`), die Suche nur die Station — deren Tafel umfasst alle Steige, jede Abfahrt mit ihrem Steig. Die Tafel eines Bus-Steigs zeigt nur seine Abfahrten (MOTIS `/v1/map/stops` → Steig, dann `stoptimes …&radius=5&exactRadius=true`). gtfs.de nummeriert jede Veröffentlichung neu → `GTFS_IDS=unstable`: Zuordnung über Name + Lage statt Kennung. Prüfwerkzeuge (Feed ↔ DB, alle Länder): `~/binch-backups/stops-audit-2026-10-22/`.

**Österreich** (seit 27.10.2026): alle Verbünde + Bahn mit Steigen aus data.mobilitaetsverbuende.at (Konto in `server/.env`: `MVO_USER`/`MVO_PASSWORD`, in einfachen Anführungszeichen — refresh-stops.sh liest `.env` per Bash). `scripts/fetch-at-gtfs.ts` führt die 9 Datensätze zu EINEM GTFS zusammen (einzeln überschrieben sie Arten und Steige gemeinsamer Stationen); `stops-feeds.conf`: `mvo:52,53,…`. Lizenz: keine Nutzung als Grundlage für Fahrscheinvertrieb (Vertragsstrafe 20 000 € je Verstoß; Weiterleiten zu den Anbieter-Shops hat der Nutzer als zulässig entschieden), Quellenangabe Pflicht — Profil → Support → Datenquellen (`SOURCES` in `app/(tabs)/settings.tsx`). Erster Abgleich eines Landes mit vielen Fremd-Halten (OSM, StaDa): `GTFS_STANDS_FIRST=1`, sonst fällt fast jede Station samt Steigen als „gibt es schon" heraus. Steig-Bezeichnungen mit ausgeschriebenem Wort („Mast1 (Millstätter Straße)") gelten nicht als Steig (`standPlatform` in gtfsStands.ts).

**Entfernte Halte** (`location_replacements`, Migration 0036): Veraltete oder doppelte Zeilen werden nie einfach gelöscht, sondern mit Ersatz am selben Ort (`scripts/apply-stop-replacements.ts`, Trockenlauf + Sicherung + `--undo`). Alte Codes leiten um: `/api/locations/by-codes` liefert `replacedBy` (die App tauscht damit gespeicherte Stationen und Verlauf), Tafel und Suche lösen sie selbst auf. Der Monatsabgleich legt eine entfernte Kennung nicht wieder an. Zwillinge (zwei Zeilen auf demselben Punkt) entschied früher die zufällige DB-Reihenfolge — jetzt gewinnt die Zeile mit Steigen. Fälle B1–B6 (veraltet, Verbund-Kopie, Zwilling, Feed-Zwilling, OSM-Dublette, verrutschter Geist) stehen im Kopf des Skripts; Namensprüfung ist Pflicht (Straßenarten wie „Road" zählen nicht, „Bay G" ≠ „Bay F"), `--recheck` prüft eine eingespielte Runde nach.

**Prüfung gegen den Fahrplan** (`~/binch-backups/stops-audit-2026-10-22/error_rate.py`, Masten aus `points/*.jsonl.gz` via `feed_points.py`): misst fehlende/zusammengelegte Halte, doppelte Marker, Geister, falsche Namen — unabhängig vom Import. Daraus die Pläne für `apply-stop-replacements.ts`, `fix-stop-modes.ts` (falsche Verkehrsart: Tafel filterte sonst die echten Abfahrten weg; mit `kinds_plan.py` auch fehlende Nebenarten an geteilten Masten — Bus an einem Tramhalt zählt schon ab 10 Fahrten, `kindsForStop`, nicht an Bahnhöfen) und `mark-unserved-stops.ts` (`unserved_at`, Migration 0038: Bus/Tram ohne Bedienung in DE/NL/CH/England sowie überzählige OSM-Marker, deren Mast schon einen eigenen hat — `plan_1027.py`, immer aus `db-stops-all.csv` samt ausgeblendeten rechnen; Karte und Suche blenden aus, Code bleibt auflösbar; wiederholbar, bediente werden wieder sichtbar). Geister in BE/FR/PL/CZ/AT/Schottland/Wales sind NICHT prüfbar (Fahrpläne unvollständig). Station mit genau EINEM Mast steht auf dem Mast, nicht auf dem Fahrplan-Mittelpunkt (bis 1 km daneben; `import-gtfs.ts`, Bestand per `fix-stop-positions.ts`).

**Bo** (`server/src/services/chatAgent.ts`, Haiku 5.5, seit 28.10.2026 breiter): Reisen bleibt der Kern, er beantwortet aber auch Wissensfragen und sucht im Web (`web_search_20250305` — die Filter-Fassungen gibt es für Haiku nicht; 1 Cent je Suche, Deckel `BO_WEB_SEARCHES_PER_DAY` = 30 je Konto/Tag, dann fehlt das Werkzeug). Quellen gehen als Ereignis `sources` unter die Antwort und werden gespeichert (Pflicht: Wer Suchergebnisse zeigt, zeigt die Quellen). **Gedächtnis je Konto** (`bo_memories` + `users.bo_memory_enabled`, Migration 0040, `services/boMemory.ts`): Bo schreibt es selbst über `remember`/`forget` (Nummer `[#n]`, `replace_id` statt Dubletten, nie Sensibles oder Web-Inhalte), jeder Turn bekommt es samt Vorname und den neuesten anderen Chats in den UNGECACHTEN zweiten System-Block — im Turn fest (Denkblöcke!). `past_chats` liest frühere Chats (Stichwortsuche oder Kürzel = 8 Zeichen der UUID), alles an `userId` gebunden. Vermerke „Gemerkt: …" als Ereignis `memory` (Zeilen-Art `note`). Verwaltung: Profil → Einstellungen → Bo (`/api/chat/memory` GET/PATCH/DELETE). `pause_turn` (Websuche gibt ab) wird fortgesetzt, höchstens zweimal. **Vage Wünsche** („zeig mir eine günstige Reise", ein Event): Websuche → Ziel, Start, Datum, Verkehrsmittel herausziehen → bis zu drei `search_journey` parallel; Preise NIE aus Webseiten, nur aus unserer Suche. Such-Budget je Nachricht 6 Einheiten (`search_journey` 1, `plan_multimodal` 2, `takeSearchBudget`) — Flugsuchen kosten beim Anbieter, Zugsuchen am DB-Kontingent. Quellen werden über den ganzen Turn gesammelt (die Websuche steht oft im ersten Aufruf, der Text im letzten).

**Live-Ansicht** (Sende-Knopf an der Tafel-Zeile → Karte verfolgt das Fahrzeug): Es gibt KEINE echten Positionsdaten — die App rechnet die Lage aus Fahrplan + Echtzeit-Verspätung (`lib/live/motion.ts`: Trapez-Fahrt je Stück, Mindest-Haltezeit; `lib/live/flight.ts`: Großkreis, Steig-/Sinkflug, Rollzeiten — Flüge aus `StopBoardItem.flight` der Flugtafel). Die Info-Karte zeigt Fahrplanzeiten (wie die Tafel), nie die simulierten. Fahrzeuge sind echte 3D-Netze in einer eigenen MapLibre-Ebene (`modules/live-models`: Kotlin hängt eine `CustomLayer` per MLRN-Tag ein, C++/GLES3 zeichnet weltfest samt Schatten; hängt sich nach einem Stilwechsel selbst wieder ein). Netze aus `server/scripts/build-live-models.mjs` (Maße → `lib/live/liveModelSpecs.ts`); nur die Fähre ist noch `fill-extrusion` (`lib/live/shapes.ts`). Das Graue der Strecke endet unter der Fahrzeugmitte (`hiddenHalfM` in `lib/live/features.ts`). Kartenebene `components/live/LiveVehicleLayer.tsx`, Bedienung + Folge-Kamera `components/live/LiveOverlay.tsx`. Prüfen ohne Gerät: `~/binch-backups/live-tests/` (Tests + `render/scene.mts` für mbgl-render).

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
