/**
 * OSM-basierter Stop-Importer.
 *
 * Holt alle ÖPNV-Stops (Bus/Tram/Train) für ein gegebenes Land via Overpass-API
 * und schreibt sie in `locations`. Brauchen wir, weil die offiziellen GTFS-
 * Feeds vieler Verbünde nur hinter Login zugänglich sind (data.mobilitaets-
 * verbuende.at, transit.land, etc.) — OSM ist immer public, kein API-Key, und
 * die Mapping-Community deckt Bus-/Tram-Stops in vielen Ländern besser ab als
 * manche offiziellen Feeds (besonders ÖPNV-Stops).
 *
 * Schedule-Daten brauchen wir hier nicht — Live-Departures liefert HAFAS via
 * unser Multi-Profile-Setup, sobald der Stop in `locations` ist.
 *
 * Aufruf:
 *   OSM_COUNTRY=AT npx tsx scripts/import-osm-stops.ts
 *   OSM_COUNTRY=DK npx tsx scripts/import-osm-stops.ts
 *
 * Env-Vars:
 *   OSM_COUNTRY      — ISO-3166-1 alpha-2 (z.B. "AT", "DE", "PL")
 *   OSM_COUNTRY_NAME — Anzeige-Name in `locations.country` (Default: ISO-Map)
 *   OVERPASS_URL     — Eigene Overpass-Instanz (Default: overpass-api.de)
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const COUNTRY = (process.env.OSM_COUNTRY ?? "AT").toUpperCase();
const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

const ISO_TO_NAME: Record<string, string> = {
  AT: "Austria",
  DE: "Germany",
  CH: "Switzerland",
  NL: "Netherlands",
  BE: "Belgium",
  PL: "Poland",
  CZ: "Czech Republic",
  DK: "Denmark",
  LU: "Luxembourg",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  SK: "Slovakia",
  HU: "Hungary",
  PT: "Portugal",
  GB: "United Kingdom",
  IE: "Ireland",
  SE: "Sweden",
  NO: "Norway",
  FI: "Finland",
  HR: "Croatia",
  SI: "Slovenia",
  RO: "Romania",
  GR: "Greece",
};
const COUNTRY_NAME = process.env.OSM_COUNTRY_NAME ?? ISO_TO_NAME[COUNTRY] ?? COUNTRY;

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  version?: number;
  elements: OsmNode[];
}

type LocationType = "TRAIN" | "BUS";
type Subtype = "LONG_DISTANCE" | "REGIONAL" | "SUBURBAN" | "SUBWAY" | "TRAM" | "BUS" | "COACH" | "FERRY";
type Kind = "train" | "subway" | "tram" | "bus" | "ferry";

interface StopRow {
  code: string;
  label: string;
  city: string | null;
  country: string;
  type: LocationType;
  latitude: string;
  longitude: string;
  hafasId: string | null;
  subtype: Subtype;
  kinds: Kind[];
  source: string;
}

/** OSM-Tag-Kombination → unser Subtype/Kind/Type.
 *  Priorität: spezifischer geht vor (subway > tram > train > bus). */
function classify(tags: Record<string, string>): { type: LocationType; subtype: Subtype; kind: Kind } | null {
  const station = tags["station"];
  const railway = tags["railway"];
  const tram = tags["tram"];
  const subway = tags["subway"];
  const lightRail = tags["light_rail"];
  const highway = tags["highway"];
  const publicTransport = tags["public_transport"];

  // U-Bahn / Metro
  if (subway === "yes" || station === "subway" || railway === "subway_entrance") {
    return { type: "TRAIN", subtype: "SUBWAY", kind: "subway" };
  }
  // Tram / Stadtbahn
  if (tram === "yes" || railway === "tram_stop" || station === "tram" || lightRail === "yes") {
    return { type: "TRAIN", subtype: "TRAM", kind: "tram" };
  }
  // Eisenbahn (Station / Halt)
  if (railway === "station" || railway === "halt") {
    // Kleine Heuristik: Long-Distance-Marker im Namen? Sonst REGIONAL.
    return { type: "TRAIN", subtype: "REGIONAL", kind: "train" };
  }
  // Bushaltestelle
  if (highway === "bus_stop" || tags["bus"] === "yes") {
    return { type: "BUS", subtype: "BUS", kind: "bus" };
  }
  // Generic public_transport stops: schauen ob bus_stop oder Tram dabei steht
  if (publicTransport === "stop_position" || publicTransport === "platform" || publicTransport === "station") {
    if (tags["bus"] === "yes") return { type: "BUS", subtype: "BUS", kind: "bus" };
    if (tags["tram"] === "yes") return { type: "TRAIN", subtype: "TRAM", kind: "tram" };
    if (tags["train"] === "yes" || tags["railway"] === "yes") {
      return { type: "TRAIN", subtype: "REGIONAL", kind: "train" };
    }
    if (tags["subway"] === "yes") return { type: "TRAIN", subtype: "SUBWAY", kind: "subway" };
  }
  return null;
}

const OVERPASS_QUERY = (iso: string) => `
[out:json][timeout:300];
area["ISO3166-1"="${iso}"][admin_level=2]->.country;
(
  node(area.country)["highway"="bus_stop"];
  node(area.country)["railway"="tram_stop"];
  node(area.country)["railway"="station"];
  node(area.country)["railway"="halt"];
  node(area.country)["public_transport"="station"];
);
out body;
`;

async function fetchStops(iso: string): Promise<OsmNode[]> {
  // Overpass kann lange brauchen — Country-Queries ~30-90s, große Länder
  // mehrere Minuten. Abort-Timeout entsprechend großzügig.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6 * 60_000); // 6 Min hard cap

  try {
    console.log(`[osm:${iso}] querying Overpass…`);
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": "binch-mobile/0.1" },
      body: OVERPASS_QUERY(iso),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Overpass ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as OverpassResponse;
    return data.elements ?? [];
  } finally {
    clearTimeout(timer);
  }
}

const CHUNK = 500;

async function main(): Promise<void> {
  const t0 = Date.now();
  const nodes = await fetchStops(COUNTRY);
  console.log(`[osm:${COUNTRY}] got ${nodes.length} OSM nodes in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const rows: StopRow[] = [];
  const seenCode = new Set<string>();
  let skippedNoName = 0;
  let skippedNoCoords = 0;
  let skippedUnclassified = 0;

  for (const node of nodes) {
    const tags = node.tags ?? {};
    // Bevorzugt `name`, fallback uic_name (offizielle UIC-Bezeichnung) und
    // schließlich ref (Linien-Kürzel). Stops ohne irgendeinen Namen skippen.
    const name = (tags["name"] ?? tags["uic_name"] ?? tags["ref"] ?? "").trim();
    if (!name) {
      skippedNoName++;
      continue;
    }
    if (!Number.isFinite(node.lat) || !Number.isFinite(node.lon)) {
      skippedNoCoords++;
      continue;
    }
    const cls = classify(tags);
    if (!cls) {
      skippedUnclassified++;
      continue;
    }
    const code = `osm:${node.id}`;
    if (seenCode.has(code)) continue;
    seenCode.add(code);
    rows.push({
      code,
      label: name,
      city: tags["addr:city"] ?? null,
      country: COUNTRY_NAME,
      type: cls.type,
      latitude: node.lat.toFixed(6),
      longitude: node.lon.toFixed(6),
      hafasId: null, // OSM-IDs sind keine HAFAS-IDs — multi-profile resolve sie via coord+name
      subtype: cls.subtype,
      kinds: [cls.kind],
      source: "osm",
    });
  }

  console.log(`[osm:${COUNTRY}] kept ${rows.length} stops (skipped: ${skippedNoName} no-name, ${skippedNoCoords} no-coords, ${skippedUnclassified} unclassified)`);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
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
          subtype: sql`excluded.subtype`,
          kinds: sql`excluded.kinds`,
          source: sql`excluded.source`,
        },
      });
    if ((i / CHUNK) % 20 === 0) {
      console.log(`[osm:${COUNTRY}]   ${Math.min(i + CHUNK, rows.length)} / ${rows.length}`);
    }
  }

  console.log(`[osm:${COUNTRY}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[osm:${COUNTRY}] failed:`, err);
  process.exit(1);
});
