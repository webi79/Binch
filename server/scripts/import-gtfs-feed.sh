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

# Vermerk „letzter Import dieser Datei ist vollständig durchgelaufen".
DONE="$WORKDIR/imported"

# Das Entpackte IMMER wegräumen, auch wenn ein Schritt scheitert (`set -e`):
# Sonst blieben nach einem Fehlschlag knapp 10 GB (britischer Feed) auf dem
# Volume `gtfs-work` liegen — bei jedem weiteren Fehlschlag erneut.
trap 'rm -rf "$WORKDIR/extracted"' EXIT

# Vor weniger als sechs Tagen vollständig eingespielt? Dann gar nicht erst
# nachfragen. Schlägt EIN Feed fehl, versucht der Takt (gtfs-refresh-loop.sh)
# es nach einem Tag erneut — für ALLE Feeds. Eine Quelle, die die bedingte
# Nachfrage (`-z`) nicht beherrscht, würde dann täglich neu geladen und
# eingespielt (der britische: über eine Stunde). `GTFS_FORCE=1` erzwingt.
if [[ "${GTFS_FORCE:-0}" != "1" && "${GTFS_REUSE_ZIP:-0}" != "1" && -f "$DONE" \
  && -n "$(find "$DONE" -mmin -$((6 * 24 * 60)) 2>/dev/null)" ]]; then
  echo "Vor weniger als 6 Tagen vollständig eingespielt — übersprungen."
  exit 0
fi

# IMMER bei der Quelle nachfragen — bedingt (`-z`): Ist die Datei dort nicht
# neuer als unsere, kommt nichts, und der Import entfällt, sofern der letzte
# vollständig war.
#
# Vorher wurde nur geladen, wenn noch GAR KEINE Datei da war. Der Container
# behält sein /tmp über Neustarts — der wöchentliche Refresh spielte damit seit
# Mai 2026 dieselben Dateien immer wieder ein; der Prager Feed war da schon seit
# Juni abgelaufen. `GTFS_REUSE_ZIP=1` nimmt lokal bewusst die vorhandene Datei.
# Nie ewig hängen: Verbindung in 30 s, und ein Download, der fünf Minuten lang
# unter 1 KB/s liegt, gilt als tot — sonst blockiert ein einziger stehender Feed
# alle übrigen, bis jemand den Container neu startet. `--retry-all-errors`:
# Auch ein vom Server abgebrochener Datenstrom (HTTP/2 „stream reset", so fiel
# der Prager Feed im September 2026 aus) wird noch zweimal versucht.
CURL_OPTS=(--connect-timeout 30 --speed-limit 1024 --speed-time 300 --retry 2 --retry-delay 30 --retry-all-errors)

if [[ "${GTFS_REUSE_ZIP:-0}" == "1" && -s "$ZIP" ]]; then
  echo "Nehme vorhandene $ZIP (GTFS_REUSE_ZIP=1)"
else
  NEW="$ZIP.new"
  rm -f "$NEW"
  echo "Download $URL → $ZIP"
  # -R: Zeitstempel der Quelle übernehmen — daran misst `-z` beim nächsten Mal.
  if [[ -s "$ZIP" ]]; then
    curl -fLR "${CURL_OPTS[@]}" -z "$ZIP" -o "$NEW" "$URL" || {
      echo "❌ Download fehlgeschlagen"
      rm -f "$NEW"
      exit 1
    }
  else
    curl -fLR "${CURL_OPTS[@]}" -o "$NEW" "$URL" || {
      echo "❌ Download fehlgeschlagen"
      rm -f "$NEW"
      exit 1
    }
  fi
  if [[ -s "$NEW" ]]; then
    if [[ "$(head -c 2 "$NEW" | od -An -c | tr -d ' \n')" != "PK" ]]; then
      echo "❌ Keine ZIP-Datei (Magic-Bytes fehlen — vermutlich HTML)"
      rm -f "$NEW"
      exit 1
    fi
    mv "$NEW" "$ZIP"
  elif [[ -f "$DONE" ]]; then
    echo "Quelle unverändert — der letzte Import gilt weiter."
    exit 0
  else
    echo "Quelle unverändert, aber kein vollständiger Import vermerkt — importiere die vorhandene Datei."
  fi
fi
rm -f "$DONE"

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
touch "$DONE"
# Das Entpackte wird nicht mehr gebraucht — die ZIP bleibt für die bedingte
# Nachfrage. Allein der britische Feed sind entpackt knapp 10 GB. (Der `trap`
# oben räumt auch nach einem Fehlschlag.)
rm -rf "$WORKDIR/extracted"

echo ""
echo "Done. Aktuelle Feeds in der DB:"
# `</dev/null`: Vom Host aus läuft dieses Skript in der `while read`-Schleife
# von refresh-all-feeds.sh — `docker compose exec` läse sonst deren restliche
# Feed-Liste von stdin, und nur der erste Feed würde je aufgefrischt.
docker compose exec -T db psql -U binch -d binch </dev/null -c \
  "SELECT feed_id, COUNT(*) AS stop_times FROM gtfs_stop_times GROUP BY feed_id ORDER BY feed_id;" 2>/dev/null || true
