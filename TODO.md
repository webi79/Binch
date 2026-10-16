# TODO

Living document — bitte aktuell halten beim Arbeiten. Grobe Themen, keine
Akzeptanzkriterien.

Zuletzt gegen den Code geprüft: 2026-09-02. Was hier stand und inzwischen gebaut
ist, wurde dabei gestrichen — Saved (Tickets, Trips, PDF-Import), Umgebung/Karte,
Anmeldung, Favoriten, Hin-&-Rückreise, das Farbsystem.

## 🐛 Bekannte Bugs

- [ ] [`app/search/voice.tsx:130`](app/search/voice.tsx#L130) und
      [`:141`](app/search/voice.tsx#L141) springen bei unvollständigem Parsing auf
      `/search/${mode.toLowerCase()}s` — also `/search/flights`, `/search/trains`.
      Diese Routen gibt es nicht (nur `index`, `results`, `route-map`, `voice`).
      Erreichbar ist der Screen weiterhin: Das Mikrofon in
      [`SearchBar.tsx`](components/SearchBar.tsx) zeigt standardmäßig dorthin.

## 🔌 Nicht implementiert

- [ ] **Filter-Sheet** — die Pille ist da, aber ohne Handler:
      [`ResultsView.tsx:1326`](components/results/ResultsView.tsx#L1326) ist ein
      `RippleTouch` ganz ohne `onPress`.
- [ ] **Multi-City** — Strings und Typ vorhanden, der Reiter ist auskommentiert
      ([`SearchHero.tsx:165`](components/search/SearchHero.tsx#L165)), Formular-Logik
      fehlt.

## 🧹 Aufräumen

- [ ] **Sprachnachrichten-Dateien werden nie gelöscht.** Jede abgeschickte
      Aufnahme liegt dauerhaft unter `documentDirectory/voice/*.wav`. Der Chat
      kappt seinen Verlauf, die Dateien bleiben — bei täglicher Nutzung wächst das
      unbegrenzt. Beim Kappen mitlöschen (siehe `AssistantScreen`).
- [ ] **Aufräum-Runde Animationen** — [`lib/motion.tsx`](lib/motion.tsx) trägt
      Exporte mit nur noch einem Konsumenten, daneben stehen zwei parallele
      Textur-Systeme und Kommentare, die inzwischen etwas anderes beschreiben als
      der Code tut. Verhaltensneutral, aber nicht nebenbei zu machen.

## 🏗️ Infrastruktur

- [ ] **BEIM HETZNER-UMZUG: Whisper-Modell selbst ausliefern.** Der Client lädt das
      Sprachmodell (`ggml-base-q5_1.bin`, ~60 MB) beim ersten Mikrofon-Druck von
      `huggingface.co/ggerganov/whisper.cpp` — siehe `MODEL_URL` in
      [`lib/assistant/whisper.ts`](lib/assistant/whisper.ts). Fremdes Repository:
      Wird die Datei dort umbenannt, umgezogen oder werden anonyme Zugriffe
      gedrosselt, bekommt **jeder neue Nutzer** kein Modell mehr — und HuggingFace
      sieht die IP jedes Erstnutzers.
      Plan (bewusst NICHT vor dem Umzug, sonst käme außerhalb des WLANs gar kein
      Modell mehr an — `apiBaseUrl` zeigt bis dahin auf `http://192.168.2.84:3000`):
      1. Datei in ein Docker-Volume, per Startskript einmalig geholt und auf Größe
         geprüft. NICHT ins Git (60 MB Binärdatei) und nicht ins Image (bläht jeden
         Build auf).
      2. Ausliefern über Caddy unter z.B. `/static/models/…` mit `ETag` und
         `Range` — dann setzt ein abgebrochener Download fort, statt neu zu
         beginnen, und der Fastify-Prozess bleibt davon unbehelligt.
      3. Client lädt von uns, mit HuggingFace als Rückfall, wenn unsere Adresse
         nicht antwortet. Traffic: ~60 MB je Installation (10.000 Nutzer ≈ 600 GB,
         im Hetzner-Kontingent unkritisch).
- [ ] **BEIM HETZNER-UMZUG: Datenbank absichern.** Seit 01.10.2026 lauscht Postgres nur
      noch auf `127.0.0.1`, das Passwort kommt aus `POSTGRES_PASSWORD` in `server/.env`
      (Rückfall `binch` nur lokal). Offen für den Server:
      1. Starkes `POSTGRES_PASSWORD` setzen — auf einer BESTEHENDEN DB zusätzlich
         `ALTER ROLE binch PASSWORD '…'` (Postgres liest die Variable nur beim ersten
         Start eines leeren Volumes).
      2. `binch` ist Superuser (so legt das Postgres-Image die erste Rolle an). Eigene
         Rolle für den Server anlegen (`binch_app`: nur SELECT/INSERT/UPDATE/DELETE auf
         die Tabellen, `ALTER DEFAULT PRIVILEGES` für künftige) und `DATABASE_URL` von
         `binch-server` darauf umstellen; `binch` bleibt für Migrationen und Importe.
         NICHT `ALTER ROLE binch NOSUPERUSER` — dann hat die DB keinen Superuser mehr.
- [ ] **BEIM HETZNER-UMZUG: Migrationen 0024–0031 NICHT in einem Rutsch auf eine
      befüllte Datenbank.** Drizzles Migrator spielt alle offenen Dateien in EINER
      Transaktion ein: Auf 1,6 Mio `locations`-Zeilen baut das 8 GIN-Indizes, von
      denen spätere Dateien 4 wieder löschen, und `0027` schreibt die ganze Tabelle
      neu (`ADD COLUMN … STORED`) — mit ACCESS-EXCLUSIVE-Sperre bis zum Ende.
      Ortssuche, Such-Auflösung und Karte stünden minutenlang. Und `0027` hat kein
      `IF NOT EXISTS`. Vorgehen: entweder leere DB migrieren und DANN importieren,
      oder die Indizes vorher von Hand `CONCURRENTLY` bauen und im Wartungsfenster
      migrieren (oder 0024–0030 zu einer Netto-Datei zusammenlegen).
- [ ] **Esri-Schlüssel (`ESRI_API_KEY`) läuft am 05.10.2027 ab** (Eintrag „binch-imagery"
      in der ArcGIS Location Platform) — Esri begrenzt API-Schlüssel auf
      höchstens ein Jahr. Vor Ablauf in der ArcGIS Location Platform einen neuen
      erzeugen und in `server/.env` tauschen (sonst fällt die Esri-Ebene still aus,
      die App zeigt dann wieder Copernicus). Verbrauch je Monat: Tabelle
      `imagery_usage`; Deckel `ESRI_MONTHLY_TILE_CAP` (Vorgabe 1,9 Mio.).
- [ ] **MapLibre mit Globus ist SELBST GEBAUT** — aus den noch offenen Pull Requests
      [maplibre-native#4533](https://github.com/maplibre/maplibre-native/pull/4533)
      (Globus) und [#4534](https://github.com/maplibre/maplibre-native/pull/4534)
      (Atmosphäre), dazu unser Patch für Sterne, Milchstraße (Foto ESO/S. Brunier,
      CC BY 4.0 — Nennung über die Quelle `sky-credit`), Erdschatten und weiche
      Polkappen. Version `13.6.1-globe.6` für alle vier Architekturen in
      [`vendor/maplibre-native/`](vendor/maplibre-native/README.md), eingebunden
      über `plugins/withMaplibreGlobe.js`. Offen:
      1. `vendor/` muss mit eingecheckt sein, sonst fehlt die Bibliothek im
         EAS-Build (17 MB).
      2. Sobald MapLibre Globus und Himmel veröffentlicht: Verzeichnis und Plugin
         löschen, maplibre-react-native auf die offizielle Version heben.
- [ ] **Patch für maplibre-react-native ist NICHT eingecheckt**
      (`patches/@maplibre+maplibre-react-native+11.2.1.patch`, Kamerakurve,
      Fling, Gesten-Brücke). Ohne ihn baut EAS die Karte ohne all das. Beim
      Neuerzeugen Bauordner ausschließen, sonst wird er 7 MB groß:
      `npx patch-package @maplibre/maplibre-react-native --exclude 'package\.json$|^android/build/|^android/\.gradle/|^android/\.cxx/|^android/\.classpath$|^android/\.project$|^android/\.settings/'`
- [ ] **Fahrplantabellen dauerhaft schlank halten.** Der Import löscht und schreibt
      einen Feed in EINER Transaktion neu; die Indizes wuchsen dadurch Woche für Woche
      (`gtfs_stop_times_pk` 17 GB, davon ~70 % Ballast). Seit 01.10.2026 baut
      `refresh-all-feeds.sh` sie nach jedem Einspielen `CONCURRENTLY` neu auf
      (DB 43 → 28 GB). Sauberer: `gtfs_stop_times` nach `feed_id` partitionieren und
      je Feed per `DETACH`/`ATTACH` tauschen statt `DELETE`. Und prüfen, ob `gb-gtfs`
      (72 % aller Haltezeiten) nicht besser über MOTIS läuft.
- [ ] Keine Tests (kein Jest, keine `*.test.tsx`)
- [ ] Kein Linter / Prettier-Config
- [ ] Keine CI
- [ ] Kein Crash-/Error-Reporting (Sentry o.ä.)
- [ ] Keine README für Menschen (CLAUDE.md ist für Claude)
- [ ] Backend-URL: nicht mehr fest verdrahtet
      ([`app.config.js:15`](app.config.js#L15) liest `EXPO_PUBLIC_API_BASE_URL`),
      der Rückfall ist aber weiterhin die WLAN-IP `http://192.168.2.84:3000`. Mit
      dem Hetzner-Umzug auf die https-Domain umstellen — Release-Builds blocken
      Klartext-HTTP.

## 🎨 UI / UX offen

- [ ] Skeleton-Loader für die Ergebnisliste — Karte und Detail-Overlay haben
      welche ([`MapSkeleton`](components/surroundings/MapSkeleton.tsx),
      [`DetailsOverlay`](components/results/DetailsOverlay.tsx)), die Trefferliste
      selbst nicht.
