# TODO

Living document — bitte aktuell halten beim Arbeiten. Grobe Themen, keine Akzeptanzkriterien.

## 🚧 Stubs / Screens ohne Inhalt

- [ ] [`app/(tabs)/saved.tsx`](app/(tabs)/saved.tsx) — nur Title + Empty-State, keine Speicher-Logik. `favoriteResultIds` im Store wird nirgends ausgelesen.
- [ ] [`app/(tabs)/surroundings.tsx`](app/(tabs)/surroundings.tsx) — Platzhalter. i18n-Keys `surroundings.title` / `surroundings.subtitle` müssen in `dict.ts` ergänzt werden.

## 🐛 Bekannte Bugs

- [ ] Voice-Screen navigiert bei unvollständigem Parsing zu `/search/${mode.toLowerCase()}s` (z.B. `/search/flights`) — diese Routen existieren nicht. Sollte vermutlich auf `/search` zurückspringen.

## 🔌 Nicht implementiert

- [ ] Filter-UI — Pill ist da, kein Sheet/Modal dahinter
- [ ] Multi-City-Suche — Strings da, Form-Logik fehlt
- [ ] Hin- + Rückreise — `returnDate` im Typ vorhanden, UI fehlt
- [ ] Auth — Login/Signup-Strings in i18n, keine Screens
- [ ] Ticket-Upload / PDF-Import für „Saved"
- [ ] Bookmarks/Favoriten anzeigen — `favoriteResultIds` wird gesetzt, aber nirgends gelistet

## 🏗️ Infrastruktur

- [ ] Keine Tests (kein Jest, keine `*.test.tsx`)
- [ ] Kein Linter / Prettier-Config
- [ ] Keine CI
- [ ] API-URL hardcoded in `app.json` → `.env` / EAS-Profile wären sauberer
- [ ] Kein Crash-/Error-Reporting (Sentry o.ä.)
- [ ] Keine README für Menschen (CLAUDE.md ist für Claude)

## 🎨 UI / UX offen

- [ ] Dark/Gray-Theme konsistent durchziehen — aktuell Mix aus mode-spezifischen Farben und Tailwind-`dark:`-Variants
- [ ] Loading- / Error-States in Results polishen
- [ ] Skeleton-Loader für Listen
