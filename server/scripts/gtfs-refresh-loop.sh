#!/usr/bin/env bash
# Takt für den `gtfs-refresh`-Container — zwei Aufgaben, nacheinander:
#
#   • alle 7 Tage die Fahrpläne (`refresh-all-feeds.sh`, gtfs_*-Tabellen)
#   • alle 30 Tage die Haltestellen und Bahnhöfe (`refresh-stops.sh`,
#     `locations` — nur ergänzen und auffrischen, nie löschen)
#
# Gemessen ab dem LETZTEN Lauf, nicht ab dem Containerstart. Vorher stand der
# Refresh am Anfang einer Endlosschleife — jeder Neustart von Docker (bei WSL
# praktisch täglich) löste einen kompletten Lauf aus, allein der britische Feed
# ist über eine Stunde Import. Die Zeitstempel liegen auf dem Volume
# `gtfs-work` und überleben damit auch einen Neuaufbau des Containers.
#
# Schlägt etwas fehl, kommt der nächste Versuch nach einem Tag.

set -uo pipefail
cd "$(dirname "$0")/.."

DIR="${TMPDIR:-/tmp}/binch-gtfs-schedule"
STAMP="$DIR/next-refresh"
STOPS_STAMP="$DIR/next-stops-refresh"
WEEK=604800
MONTH=2592000
DAY=86400
mkdir -p "$DIR"

due_at() {
  local v
  v=$(cat "$1" 2>/dev/null || echo 0)
  [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0
}

while true; do
  now=$(date +%s)
  next=$(due_at "$STAMP")
  next_stops=$(due_at "$STOPS_STAMP")

  if ((next <= now)); then
    if ./scripts/refresh-all-feeds.sh; then
      echo $(($(date +%s) + WEEK)) > "$STAMP"
    else
      echo "Mindestens ein Fahrplan-Feed fehlgeschlagen — neuer Versuch in 24 h"
      echo $(($(date +%s) + DAY)) > "$STAMP"
    fi
    continue
  fi

  if ((next_stops <= now)); then
    if ./scripts/refresh-stops.sh; then
      echo $(($(date +%s) + MONTH)) > "$STOPS_STAMP"
    else
      echo "Haltestellen-Abgleich unvollständig — neuer Versuch in 24 h"
      echo $(($(date +%s) + DAY)) > "$STOPS_STAMP"
    fi
    continue
  fi

  soonest=$((next < next_stops ? next : next_stops))
  echo "Nächster Lauf in $(((soonest - now) / 3600)) h (Fahrpläne in $(((next - now) / 3600)) h, Haltestellen in $(((next_stops - now) / 3600)) h)"
  sleep $((soonest - now))
done
