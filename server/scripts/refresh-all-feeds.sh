#!/usr/bin/env bash
# Iteriert über gtfs-feeds.conf und ruft import-gtfs-feed.sh für jeden aktiven
# Feed. Wird vom `gtfs-refresh`-Sidecar-Container wöchentlich aufgerufen.
#
# Lokal manuell laufen lassen via:
#   ./scripts/refresh-all-feeds.sh
#
# Im Container:
#   wird vom Service-Entrypoint in einer Loop mit `sleep 604800` (1 Woche)
#   ausgeführt — keine extra cron-Dependency nötig.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$SCRIPT_DIR/gtfs-feeds.conf"

if [[ ! -f "$CONF" ]]; then
  echo "❌ $CONF nicht gefunden"
  exit 1
fi

cd "$SCRIPT_DIR/.."

started=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Merker für „wurde in diesem Lauf etwas neu eingespielt?" (siehe REINDEX unten).
RUN_MARK="${TMPDIR:-/tmp}/binch-gtfs-schedule/.run-started"
mkdir -p "$(dirname "$RUN_MARK")" && touch "$RUN_MARK"
echo ""
echo "================================================"
echo " GTFS-Refresh started at $started"
echo "================================================"

# Postgres-Vacuum NACH allen Imports — nimmt das Dead-Tuple-Aufräumen vorweg.
# Autovacuum tut's auch, aber explizit ist nach einem Re-Import sinnvoll
# (purge+insert lässt viele tote Rows zurück).
ok=0
fail=0
while IFS='|' read -r feed_id url active rest; do
  # Skip Kommentare und Leerzeilen
  [[ -z "$feed_id" || "$feed_id" =~ ^[[:space:]]*# ]] && continue
  feed_id=$(echo "$feed_id" | xargs)
  active=$(echo "${active:-1}" | xargs)
  [[ "$active" != "1" ]] && {
    echo "[$feed_id] inactive — skip"
    continue
  }
  url=$(echo "$url" | xargs)
  echo ""
  echo "--- $feed_id ---"
  # `</dev/null`: Der Import darf die Feed-Liste dieser Schleife nicht lesen.
  if ./scripts/import-gtfs-feed.sh "$feed_id" "$url" </dev/null; then
    ok=$((ok + 1))
    # OTP-Coupling: Wenn das Volume gemounted ist UND der Feed in OTP-relevanten
    # Ländern ist (aktuell nur NL), kopieren wir die ZIP rüber damit OTP beim
    # nächsten Restart einen frischen Graph bauen kann. Die alte graph.obj
    # wird gelöscht — der nächste OTP-Start triggert einen Rebuild.
    if [[ -n "${OTP_FEED_DIR:-}" && -d "${OTP_FEED_DIR}" ]]; then
      case "$feed_id" in
        nl-ovapi)
          src_zip="${TMPDIR:-/tmp}/binch-gtfs-schedule/$feed_id/feed.zip"
          if [[ -f "$src_zip" ]]; then
            echo "Copying $feed_id feed to OTP volume…"
            cp "$src_zip" "${OTP_FEED_DIR}/${feed_id}.zip"
            # Alter Graph muss weg — OTP rebuildet beim nächsten Start.
            rm -f "${OTP_FEED_DIR}/graph.obj" "${OTP_FEED_DIR}/streetGraph.obj"
            echo "OTP graph invalidated (will rebuild on next otp restart)"
          fi
          ;;
      esac
    fi
  else
    echo "❌ $feed_id failed"
    fail=$((fail + 1))
  fi
done < "$CONF"

echo ""
echo "Refresh: $ok ok, $fail failed"

# DB-Aufräumen: VACUUM und ANALYZE auf den GTFS-Tabellen.
# Lock-mäßig harmlos (VACUUM ohne FULL blockt nicht), und sorgt dafür dass die
# Index-Statistics frisch sind nach dem Re-Import. Verhindert auch DB-Bloat
# nach `purge + insert` (alte Tuples warten sonst auf autovacuum).
echo ""
echo "Running VACUUM ANALYZE on gtfs_* tables…"
if [[ -n "${DATABASE_URL:-}" ]]; then
  # Im Container: DATABASE_URL ist gesetzt — direkt psql.
  psql "$DATABASE_URL" -c "VACUUM ANALYZE gtfs_stop_times, gtfs_trips, gtfs_routes, gtfs_stops, gtfs_calendar, gtfs_calendar_dates;" 2>&1 | tail -3 || true
  # Der Import löscht und schreibt einen Feed in EINER Transaktion neu. Die
  # Tabelle verkraftet das (VACUUM gibt den Platz zur Wiederverwendung frei),
  # die Indizes nicht: Sie wuchsen Woche für Woche — `gtfs_stop_times_pk` stand
  # im Okt. 2026 bei 17 GB, davon rund 70 % Ballast. Neu aufbauen, sobald etwas
  # neu eingespielt wurde; CONCURRENTLY sperrt weder Lesen noch Schreiben.
  if [[ -n "$(find "${TMPDIR:-/tmp}/binch-gtfs-schedule" -maxdepth 2 -name imported -newer "$RUN_MARK" 2>/dev/null)" ]]; then
    echo "Indizes der Fahrplantabellen neu aufbauen…"
    for idx in gtfs_stop_times_pk gtfs_stop_times_stop gtfs_trips_pk gtfs_calendar_dates_lookup; do
      psql "$DATABASE_URL" -c "REINDEX INDEX CONCURRENTLY $idx;" 2>&1 | tail -1 || true
    done
  fi
else
  # Lokal vom Host: über docker compose.
  docker compose exec -T db psql -U binch -d binch -c "VACUUM ANALYZE gtfs_stop_times, gtfs_trips, gtfs_routes, gtfs_stops, gtfs_calendar, gtfs_calendar_dates;" 2>&1 | tail -3 || true
fi

ended=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "GTFS-Refresh finished at $ended"
# Fehlschlag melden — der Takt (gtfs-refresh-loop.sh) versucht es dann früher.
[[ "$fail" -eq 0 ]]
