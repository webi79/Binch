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
