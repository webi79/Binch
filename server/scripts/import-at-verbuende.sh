#!/usr/bin/env bash
# Importiert GTFS-Stops österreichischer Verbünde in die locations-Tabelle.
#
# ⚠️  EMPFOHLEN STATTDESSEN: `OSM_COUNTRY=AT npx tsx scripts/import-osm-stops.ts`
#     Das holt ALLE Bus/Tram/Train-Stops für ganz Österreich aus OpenStreetMap
#     in einem Schwung (60s, ~62k Stops). Brauchst kein MVO-Login, kein PDF-
#     Wirrwarr. HAFAS-Departures funktionieren via Multi-Profile-Routing
#     (vor/vvt/svv/stv/etc.) automatisch sobald die Stops in der DB sind.
#
# Dieses Script bleibt erhalten für den Fall dass du LIEBER die offiziellen
# GTFS-Schedules importieren willst (z.B. weil du sie für eigene Routing-Logik
# brauchst statt nur Live-Departures).
#
# AUTOMATISCH (ohne Login):
#   wl — Wiener Linien (Wien Stadt: U-Bahn, Tram, Stadtbusse, ~5k Stops)
#
# MANUELL DOWNLOAD nötig (Login wall):
#   svv vvt ooevv stv vkg vvv  — über data.mobilitaetsverbuende.at
#   Registrieren (kostenlos, E-Mail) → ZIPs runterladen → ablegen unter
#   /tmp/binch-gtfs-at/<verbund>.zip → Script erneut starten
#
# Aufruf:
#   ./scripts/import-at-verbuende.sh            # alle die ZIPs haben + WL auto
#   ./scripts/import-at-verbuende.sh wl         # nur Wiener Linien
#   ./scripts/import-at-verbuende.sh svv vvt    # nur die genannten (Cache)

set -euo pipefail

WORKDIR="${TMPDIR:-/tmp}/binch-gtfs-at"
mkdir -p "$WORKDIR"

# Auto-downloadbare Verbünde mit ihrer direkten ZIP-URL (kein Login).
declare -A AUTO_FEEDS=(
  [wl]="https://www.wienerlinien.at/ogd_routen/wienerlinien-ogd.zip"
)

# Verbünde die manuell runtergeladen werden müssen (Login wall).
MANUAL_VERBUENDE=(svv vvt ooevv stv vkg vvv)

ALL_VERBUENDE=("${!AUTO_FEEDS[@]}" "${MANUAL_VERBUENDE[@]}")

if [[ $# -eq 0 ]]; then
  VERBUENDE=("${ALL_VERBUENDE[@]}")
else
  VERBUENDE=("$@")
fi

cd "$(dirname "$0")/.."

verify_zip() {
  local f="$1"
  [[ -s "$f" ]] || return 1
  local magic
  magic=$(head -c 2 "$f" | od -An -c | tr -d ' \n')
  [[ "$magic" == "PK" ]]
}

missing_manual=()

for verbund in "${VERBUENDE[@]}"; do
  zip="$WORKDIR/$verbund.zip"
  extract="$WORKDIR/$verbund"

  echo ""
  echo "=== $verbund ==="

  # Auto-Download falls möglich
  if [[ -n "${AUTO_FEEDS[$verbund]:-}" ]] && [[ ! -s "$zip" ]]; then
    echo "  Download ${AUTO_FEEDS[$verbund]}…"
    curl -fL --retry 3 -o "$zip" "${AUTO_FEEDS[$verbund]}" || {
      echo "  ⚠️  Download fehlgeschlagen — überspringe"
      continue
    }
  fi

  if [[ ! -f "$zip" ]]; then
    echo "  ℹ️  Keine ZIP unter $zip"
    echo "      Manuell von data.mobilitaetsverbuende.at runterladen und hier ablegen."
    missing_manual+=("$verbund")
    continue
  fi

  if ! verify_zip "$zip"; then
    echo "  ⚠️  $zip ist keine gültige ZIP (vermutlich HTML/Login-Seite) — überspringe"
    missing_manual+=("$verbund")
    continue
  fi

  echo "  Entpacken…"
  rm -rf "$extract"
  mkdir -p "$extract"
  unzip -q -o "$zip" -d "$extract"

  if [[ ! -f "$extract/stops.txt" ]]; then
    found=$(find "$extract" -maxdepth 3 -name "stops.txt" -print -quit)
    if [[ -n "$found" ]]; then
      extract=$(dirname "$found")
      echo "  (stops.txt in Unterordner: $extract)"
    else
      echo "  ❌ Keine stops.txt im Archiv — überspringe"
      continue
    fi
  fi

  echo "  Importiere…"
  GTFS_DIR="$extract" \
    GTFS_COUNTRY="Austria" \
    GTFS_CODE_PREFIX="gtfs:at:$verbund:" \
    npx tsx scripts/import-gtfs.ts

  echo "  ✅ $verbund fertig"
done

echo ""
echo "Stops in locations-Tabelle (AT):"
docker compose exec -T db psql -U binch -d binch -c \
  "SELECT split_part(code, ':', 3) AS verbund, COUNT(*) FROM locations WHERE code LIKE 'gtfs:at:%' GROUP BY verbund ORDER BY COUNT(*) DESC;" 2>/dev/null || true

if [[ ${#missing_manual[@]} -gt 0 ]]; then
  echo ""
  echo "🟡 Noch fehlend (Login bei data.mobilitaetsverbuende.at nötig):"
  for v in "${missing_manual[@]}"; do
    echo "   $v — als /tmp/binch-gtfs-at/$v.zip ablegen, dann erneut laufen lassen"
  done
fi
