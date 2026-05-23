/**
 * Import-Script: Bahn-Stationen mit UIC-Codes (= HAFAS-IDs) und Coords aus
 * dem trainline-eu/stations Open-Data-Dataset (https://github.com/trainline-eu/stations).
 *
 * Quelle: Public-Domain-CSV mit ~30k europäischen Bahn-Stationen, inkl. UIC-IDs,
 * Namen, Lat/Lng und Land. Wir filtern auf "is_suggestable=t" + gültige UIC + Coords.
 *
 * Ergebnis in `locations` (type=TRAIN, source="stada", hafas_id=<UIC>).
 * Vorteil: einmal importiert → Autocomplete UND Trip-Search-ID-Auflösung
 * passieren komplett ohne db-rest-Live-Calls.
 *
 * Datei wird unter /tmp/trainline-stations.csv erwartet. Download:
 *   curl -L -o /tmp/trainline-stations.csv \
 *     https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv
 *
 * Ausführung aus dem server/-Verzeichnis:
 *   npm run import:stada
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const CSV_PATH = process.env.STADA_CSV_PATH ?? "/tmp/trainline-stations.csv";
const CHUNK = 200;

interface StadaRow {
  code: string;
  label: string;
  city: string;
  country: string | null;
  type: "TRAIN";
  latitude: string;
  longitude: string;
  hafasId: string;
  /** trainline-eu liefert nur „grobe" Bahnstationen, keine S-/U-Bahn-Stops →
   *  alles als REGIONAL kategorisieren (umfasst Fern, Regional, IC etc.).
   *  Im Frontend rendert das als train-Marker. */
  subtype: "REGIONAL";
  /** StaDa-Stationen sind ausschließlich Bahn — ein-Element-Array. Bei
   *  Multi-Mode-Hubs ergänzen GTFS-Imports die weiteren Kinds in der DB. */
  kinds: ["train"];
  source: "stada";
}

/** Minimal-Parser für trainline-eu CSV. Trennzeichen ist Semikolon, Werte können
 *  in Quotes stehen, manche Zeilen enthalten Quotes selbst (escaped via "). */
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split("\n");
  const headers = parseRow(lines[0]);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = fields[j] ?? "";
    }
    out.push(row);
  }
  return out;
}

function parseRow(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Land-Code (DE, FR, ...) → vollständiger Name. Nur die häufigsten — alle anderen
 *  bleiben als Code stehen, das ist akzeptabel für den seltenen Fall. */
const COUNTRY_NAMES: Record<string, string> = {
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  PT: "Portugal",
  NL: "Netherlands",
  BE: "Belgium",
  LU: "Luxembourg",
  AT: "Austria",
  CH: "Switzerland",
  GB: "United Kingdom",
  IE: "Ireland",
  DK: "Denmark",
  SE: "Sweden",
  NO: "Norway",
  FI: "Finland",
  PL: "Poland",
  CZ: "Czech Republic",
  SK: "Slovakia",
  HU: "Hungary",
  SI: "Slovenia",
  HR: "Croatia",
  RO: "Romania",
  BG: "Bulgaria",
  GR: "Greece",
};

async function main() {
  console.log(`[stada] reading ${CSV_PATH}…`);
  const text = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(text);
  console.log(`[stada] parsed ${rows.length} raw rows`);

  // Für DE/AT/CH liefert trainline-eu eine eigene `db_id`/`obb_id`/`cff_id` —
  // das sind die echten HAFAS-Station-IDs der jeweiligen Bahn (genau die, die
  // db-rest u.a. brauchen). Die `uic` daneben ist nur die europäische
  // Train-Number-Kennung und KOLLIDIERT oft mit HAFAS-IDs anderer Stationen:
  // z.B. hat „Werl" uic=8010378, aber 8010378 ist gleichzeitig die db_id von
  // „Wilhelmshorst". Wenn wir einfach UIC als hafasId nutzen, fragen wir bei
  // db-rest die falsche Station ab → Suchergebnisse für Wilhelmshorst statt
  // Werl. Deshalb für diese Länder IMMER die Carrier-ID bevorzugen, UIC nur
  // als Fallback nutzen. Für andere Länder bleibt UIC die korrekte Quelle.
  const CARRIER_BY_COUNTRY: Record<string, { id: string; enabled: string }> = {
    DE: { id: "db_id", enabled: "db_is_enabled" },
    AT: { id: "obb_id", enabled: "obb_is_enabled" },
    CH: { id: "cff_id", enabled: "cff_is_enabled" },
  };

  const out: StadaRow[] = [];
  const seenCode = new Set<string>();
  let fromUic = 0;
  let fromCarrier = 0;
  for (const r of rows) {
    // Filter: nur suggestable-Stationen + Coords.
    if (r["is_suggestable"] !== "t") continue;
    const lat = parseFloat(r["latitude"] ?? "");
    const lng = parseFloat(r["longitude"] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = r["name"]?.trim();
    if (!name) continue;

    const countryCode = r["country"]?.trim() ?? "";
    const uic = r["uic"]?.trim();
    const carrier = CARRIER_BY_COUNTRY[countryCode];
    let carrierId: string | null = null;
    if (carrier) {
      const cId = r[carrier.id]?.trim();
      const cEnabled = r[carrier.enabled];
      if (cId && /^\d{7,8}$/.test(cId) && cEnabled === "t") carrierId = cId;
    }

    let rawHafas: string | null = null;
    if (carrierId) {
      rawHafas = carrierId;
      fromCarrier++;
    } else if (uic && /^\d{7,8}$/.test(uic)) {
      rawHafas = uic;
      fromUic++;
    }
    if (!rawHafas) continue;

    // HAFAS-IDs für Deutschland sind 7-stellig (z.B. 8011160 für Berlin Hbf).
    // 8-stellige Werte sind SNCF mit Prüfziffer am Ende → letzte streichen.
    const hafasId = rawHafas.length === 8 ? rawHafas.slice(0, 7) : rawHafas;
    const code = `sta:${hafasId}`;
    if (seenCode.has(code)) continue;
    seenCode.add(code);

    out.push({
      code,
      label: name,
      city: name,
      country: COUNTRY_NAMES[countryCode] ?? (countryCode || null),
      type: "TRAIN",
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      hafasId,
      subtype: "REGIONAL",
      kinds: ["train"],
      source: "stada",
    });
  }

  console.log(
    `[stada] filtered to ${out.length} stations (${fromUic} via UIC, ${fromCarrier} via Carrier-ID)`,
  );

  for (let i = 0; i < out.length; i += CHUNK) {
    const batch = out.slice(i, i + CHUNK);
    await db
      .insert(locations)
      .values(batch)
      .onConflictDoUpdate({
        target: locations.code,
        set: {
          label: sql`excluded.label`,
          city: sql`excluded.city`,
          country: sql`excluded.country`,
          type: sql`excluded.type`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          hafasId: sql`excluded.hafas_id`,
          subtype: sql`excluded.subtype`,
          kinds: sql`excluded.kinds`,
          source: sql`excluded.source`,
        },
      });
    console.log(`[stada]   ${Math.min(i + CHUNK, out.length)} / ${out.length}`);
  }

  console.log("[stada] done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[stada] failed:", err);
  process.exit(1);
});
