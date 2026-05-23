#!/usr/bin/env bash
# Download + Import eines GTFS-Feeds für ein Land in unsere Schedule-Tabellen.
#
# Aufruf:
#   ./scripts/import-gtfs-feed.sh nl-ovapi https://gtfs.ovapi.nl/nl/gtfs-nl.zip
#   ./scripts/import-gtfs-feed.sh fr-transport https://transport.data.gouv.fr/foo.zip
#
# Bekannte Feeds (musste manuell aktuelle URL checken, ändern sich):
#   nl-ovapi      — https://gtfs.ovapi.nl/nl/gtfs-nl.zip
#   be-irail      — https://gtfs.irail.be/nmbs/gtfs/latest.zip (nur Züge)
#   fr-sncf       — https://eu.ftp.opendatasoft.com/sncf/gtfs/export-intercites-gtfs-last.zip
#   gb-bods       — https://data.bus-data.dft.gov.uk/timetable/download/gtfsfile/... (geo-Auswahl)
#   cz-cisjr      — https://data.pid.cz/PID_GTFS.zip
#   it-trenitalia — kein unified Feed; pro Region
#
# Voraussetzungen:
#   - DB läuft (docker compose up -d db)
#   - server/.env vorhanden mit DATABASE_URL
#   - unzip + curl + npx + tsx im PATH

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <feed_id> <url>"
  echo "Example: $0 nl-ovapi https://gtfs.ovapi.nl/nl/gtfs-nl.zip"
  exit 1
fi

FEED_ID="$1"
URL="$2"
WORKDIR="${TMPDIR:-/tmp}/binch-gtfs-schedule/$FEED_ID"
mkdir -p "$WORKDIR"
ZIP="$WORKDIR/feed.zip"

cd "$(dirname "$0")/.."

if [[ ! -s "$ZIP" ]]; then
  echo "Download $URL → $ZIP"
  curl -fL --retry 3 -o "$ZIP" "$URL" || {
    echo "❌ Download fehlgeschlagen"
    exit 1
  }
fi

# Sanity-Check
magic=$(head -c 2 "$ZIP" | od -An -c | tr -d ' \n')
if [[ "$magic" != "PK" ]]; then
  echo "❌ Keine ZIP-Datei (Magic-Bytes fehlen — vermutlich HTML)"
  rm -f "$ZIP"
  exit 1
fi

echo "Entpacken nach $WORKDIR/extracted…"
rm -rf "$WORKDIR/extracted"
mkdir -p "$WORKDIR/extracted"
unzip -q -o "$ZIP" -d "$WORKDIR/extracted"

# Falls stops.txt in einem Unterordner liegt
EXTRACT_DIR="$WORKDIR/extracted"
if [[ ! -f "$EXTRACT_DIR/stops.txt" ]]; then
  found=$(find "$EXTRACT_DIR" -maxdepth 3 -name "stops.txt" -print -quit)
  if [[ -n "$found" ]]; then
    EXTRACT_DIR=$(dirname "$found")
    echo "(stops.txt in Unterordner: $EXTRACT_DIR)"
  else
    echo "❌ Keine stops.txt im Archiv"
    exit 1
  fi
fi

# .env laden für DATABASE_URL
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -v "^#" .env | grep -v "^$")
  set +a
fi

echo "Importiere…"
GTFS_DIR="$EXTRACT_DIR" GTFS_FEED_ID="$FEED_ID" npx tsx scripts/import-gtfs-schedule.ts

echo ""
echo "Done. Aktuelle Feeds in der DB:"
docker compose exec -T db psql -U binch -d binch -c \
  "SELECT feed_id, COUNT(*) AS stop_times FROM gtfs_stop_times GROUP BY feed_id ORDER BY feed_id;" 2>/dev/null || true
