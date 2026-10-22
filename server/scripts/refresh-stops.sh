#!/usr/bin/env bash
# Der MONATLICHE Abgleich der Haltestellen und Bahnhöfe (`locations`).
#
# Nur ERGÄNZEN und AUFFRISCHEN, nie löschen und nie korrigierte Felder
# überschreiben (siehe `GTFS_MODE=refresh` in import-gtfs.ts und
# `STADA_MODE=refresh` in import-stada.ts): neue Halte kommen dazu, vorhandene
# bekommen die Lage und Verkehrsarten der Quelle; Label, Stadt und Bahn-ID
# bleiben. Danach setzt `enrich-stops-city.ts` die Stadt der neuen Halte.
#
# `reimport:all` ist dafür NICHT gedacht — es löscht die ganze Tabelle und baut
# sie nicht vollständig wieder auf (siehe scripts/wipe-locations.ts).
#
# Takt: gtfs-refresh-loop.sh (alle 30 Tage, nach einem Fehlschlag 1 Tag).
# Von Hand:  ./scripts/refresh-stops.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."
CONF="$SCRIPT_DIR/stops-feeds.conf"
WORK="${TMPDIR:-/tmp}/binch-gtfs-schedule/stops"
# Genug Speicher für die großen Feeds: Der Schweizer (gtfs_complete, über 200 MB
# gepackt) lief mit Nodes Vorgabe in „JavaScript heap out of memory". Der
# Container hat 3 GB (docker-compose.yml, `gtfs-refresh`).
export NODE_OPTIONS="--max-old-space-size=2560"

# Wie in import-gtfs-feed.sh: nie ewig hängen, Abbrüche erneut versuchen.
CURL_OPTS=(--connect-timeout 30 --speed-limit 1024 --speed-time 300 --retry 2 --retry-delay 30 --retry-all-errors)

# Vom Host aus: .env für DATABASE_URL (im Container steht sie in der Umgebung).
if [[ -z "${DATABASE_URL:-}" && -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -v "^#" .env | grep -v "^$")
  set +a
fi

echo ""
echo "================================================"
echo " Haltestellen-Abgleich started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "================================================"

# Lädt $2 nach $1/feed.zip — nur wenn die Quelle neuer ist. Rückgabe:
# 0 = neue Datei da, 2 = unverändert (und schon eingespielt), 1 = Fehler.
fetch() {
  local dir="$1" url="$2" zip="$1/feed.zip" new="$1/feed.zip.new"
  mkdir -p "$dir"
  rm -f "$new"
  if [[ -s "$zip" ]]; then
    curl -fLR "${CURL_OPTS[@]}" -z "$zip" -o "$new" "$url" || { rm -f "$new"; return 1; }
  else
    curl -fLR "${CURL_OPTS[@]}" -o "$new" "$url" || { rm -f "$new"; return 1; }
  fi
  if [[ -s "$new" ]]; then
    mv "$new" "$zip"
    rm -f "$dir/imported"
    return 0
  fi
  [[ -f "$dir/imported" ]] && return 2
  return 0
}

ok=0
fail=0
# Präfixe aller Feeds — ein Feed muss die längeren unter seinem eigenen kennen
# („gtfs:de:vbb:" unter „gtfs:de:"), deren Zeilen gehören nicht ihm.
ALL_PREFIXES="$(grep -v '^[[:space:]]*#' "$CONF" | cut -d'|' -f4 | grep -v '^$')"

while IFS='|' read -r feed_id url country prefix active ids rest; do
  [[ -z "$feed_id" || "$feed_id" =~ ^[[:space:]]*# ]] && continue
  [[ "$(echo "${active:-1}" | xargs)" != "1" ]] && { echo "[$feed_id] inaktiv — übersprungen"; continue; }
  dir="$WORK/$feed_id"
  echo ""
  echo "--- $feed_id ($country) ---"
  # Erst vor Kurzem vollständig abgeglichen (Wiederholung nach einem Fehlschlag
  # eines ANDEREN Feeds)? Dann nicht erneut — siehe import-gtfs-feed.sh.
  if [[ -f "$dir/imported" && -n "$(find "$dir/imported" -mmin -$((25 * 24 * 60)) 2>/dev/null)" ]]; then
    echo "Vor weniger als 25 Tagen abgeglichen — übersprungen."
    ok=$((ok + 1))
    continue
  fi
  fetch "$dir" "$url" </dev/null
  rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "Quelle unverändert — der letzte Abgleich gilt weiter."
    ok=$((ok + 1))
    continue
  fi
  if [[ $rc -ne 0 ]]; then
    echo "❌ $feed_id: Download fehlgeschlagen"
    fail=$((fail + 1))
    continue
  fi
  if [[ "$(head -c 2 "$dir/feed.zip" | od -An -c | tr -d ' \n')" != "PK" ]]; then
    echo "❌ $feed_id: keine ZIP-Datei"
    rm -f "$dir/feed.zip"
    fail=$((fail + 1))
    continue
  fi
  rm -rf "$dir/extracted" && mkdir -p "$dir/extracted"
  # Ein halb entpacktes Archiv (Platte voll, kaputte ZIP) darf nicht als
  # „abgeglichen" durchgehen — sonst fehlten Halte bis zum nächsten Monat.
  if ! unzip -q -o "$dir/feed.zip" -d "$dir/extracted" </dev/null; then
    echo "❌ $feed_id: Entpacken fehlgeschlagen"
    rm -rf "$dir/extracted"
    fail=$((fail + 1))
    continue
  fi
  gtfs_dir="$dir/extracted"
  if [[ ! -f "$gtfs_dir/stops.txt" ]]; then
    found=$(find "$gtfs_dir" -maxdepth 3 -name "stops.txt" -print -quit)
    [[ -n "$found" ]] && gtfs_dir=$(dirname "$found")
  fi
  # 6. Spalte „unstable": Der Feed nummeriert jede Veröffentlichung neu (gtfs.de)
  # — der Abgleich ordnet dann über Name + Lage zu (import-gtfs.ts, GTFS_IDS).
  other="$(echo "$ALL_PREFIXES" | awk -v p="$prefix" 'index($0, p) == 1 && $0 != p' | paste -sd, -)"
  # Liegt der Feed unter einem breiteren (Verbund unter gtfs.de), stellt der die
  # Steige — sonst kämen sie doppelt (GTFS_STANDS in import-gtfs.ts).
  covered="$(echo "$ALL_PREFIXES" | awk -v p="$prefix" 'index(p, $0) == 1 && $0 != p' | head -1)"
  stands=1
  [[ -n "$covered" ]] && stands=0
  if GTFS_MODE=refresh GTFS_DIR="$gtfs_dir" GTFS_COUNTRY="$country" GTFS_CODE_PREFIX="$prefix" \
    GTFS_IDS="$(echo "${ids:-stable}" | xargs)" GTFS_OTHER_PREFIXES="$other" GTFS_STANDS="$stands" \
    npx tsx scripts/import-gtfs.ts </dev/null; then
    touch "$dir/imported"
    ok=$((ok + 1))
  else
    echo "❌ $feed_id: Import fehlgeschlagen"
    fail=$((fail + 1))
  fi
  # Entpackt wird nur für den Import gebraucht; die ZIP bleibt für die
  # bedingte Nachfrage beim nächsten Mal.
  rm -rf "$dir/extracted"
done < "$CONF"

echo ""
echo "--- stada (Bahnhöfe) ---"
fetch "$WORK/stada" "https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv" </dev/null
rc=$?
if [[ $rc -eq 2 ]]; then
  echo "Quelle unverändert — der letzte Abgleich gilt weiter."
elif [[ $rc -eq 0 ]] && STADA_MODE=refresh STADA_CSV_PATH="$WORK/stada/feed.zip" npx tsx scripts/import-stada.ts </dev/null; then
  touch "$WORK/stada/imported"
else
  echo "❌ stada fehlgeschlagen"
  fail=$((fail + 1))
fi

echo ""
echo "--- Städte der neuen Halte ---"
npx tsx scripts/enrich-stops-city.ts </dev/null || fail=$((fail + 1))

# Bereinigung (scripts/fix-stop-data.ts) NACH den Städten — Land und Stadt der
# neuen Halte prüft sie mit — und VOR den Anzeigenamen. Ohne sie kamen von Hand
# gelöschte Dubletten mit dem nächsten Abgleich als „neue Halte" zurück: Der
# Import kennt nur seinen Feed, nicht unsere Löschungen. Halte mit eigenen
# Fahrten und Halte mit Preis-Alarm löscht sie nie; Sicherungen nach $WORK/fix.
# Zwei Durchgänge: Die Dubletten-Regel paart nur Halte desselben Landes, und
# Länder korrigiert erst der erste (Okt. 2026: 593 Dubletten erst im zweiten).
echo ""
echo "--- Bereinigung ---"
for pass in 1 2; do
  FIX_OUT="$WORK/fix" npx tsx scripts/fix-stop-data.ts --apply </dev/null || { fail=$((fail + 1)); break; }
done

# Offizielle Anzeigenamen (display_name/display_detail, scripts/lib/stopNames.ts)
# NACH den Städten: Der britische Ortsvorsatz („Calbourne, Sun Inn") fällt nur
# weg, wenn er die Stadt des Halts ist. Die Importe setzen die Namen schon
# selbst; dieser Lauf holt nach, was sich durch die Städte noch ändert, und
# schreibt nur Abweichungen (Sicherungen nach $WORK/names).
echo ""
echo "--- Anzeigenamen ---"
FIX_OUT="$WORK/names" npx tsx scripts/fix-stop-names.ts --apply </dev/null || fail=$((fail + 1))

if [[ -n "${DATABASE_URL:-}" ]]; then
  psql "$DATABASE_URL" -c "VACUUM ANALYZE locations;" </dev/null 2>&1 | tail -1 || true
fi

echo ""
echo "Haltestellen-Abgleich: $ok ok, $fail fehlgeschlagen — fertig $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
[[ "$fail" -eq 0 ]]
