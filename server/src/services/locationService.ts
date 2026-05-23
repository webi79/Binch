import { ilike, or, and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import type { LocationType } from "../db/schema.js";
import { flixbusLiveLocations, dbRestLiveLocations } from "./liveLocations.js";

export interface ClientLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: LocationType;
  /** GPS-Koordinaten. Nach StaDa- und GTFS-Import in der DB hinterlegt → kein
   *  Live-Call mehr nötig. Frontend nutzt das für Map-Fly-To im Surroundings-Tab. */
  latitude?: number;
  longitude?: number;
  /** HAFAS-Station-ID (UIC 7-stellig). Wenn gesetzt → Trip-Search kann die
   *  Station direkt verwenden, ohne db-rest-Live-Lookup für die ID-Auflösung. */
  hafasId?: string;
}

/**
 * Sucht Locations für die Autocomplete.
 *
 * Strategie nach StaDa+GTFS-Import (alle relevanten Stations + Stops liegen
 * lokal mit Coords + HAFAS-IDs vor):
 *   - FLIGHT/CRUISE: ausschließlich lokale DB (wie immer)
 *   - ALL:           ausschließlich lokale DB → KEINE Live-Calls mehr! Spart
 *                    pro Surroundings-Search alle db-rest/FlixBus-Calls.
 *   - TRAIN/BUS:     lokale DB zuerst. Live-Fallback NUR wenn die lokale Suche
 *                    wenige Treffer liefert (Tippfehler, neue Stationen).
 *                    Reduziert Live-Calls drastisch — typische User-Queries
 *                    werden komplett offline beantwortet.
 *
 * Live-Quellen werden parallel gefetcht und mit lokalen Treffern gemerged.
 * Dedup: über `code`. Bei externen Treffern hat der `code`-Prefix das Format
 * `flix:<uuid>` bzw. `dbrest:<id>`, lokale Einträge haben `sta:<uic>` oder `gtfs:<id>`.
 */
/** Wenn lokal weniger als so viele Treffer kommen, fragen wir Live nach. */
const LIVE_FALLBACK_THRESHOLD = 3;

export async function searchLocations(
  query: string,
  type: LocationType | "ALL",
  limit = 20,
): Promise<ClientLocation[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  // searchLocalDb braucht ein höheres Limit als das finale Output-Limit, weil
  // mergeAndCap räumlich dedupt — wenn 2 von 20 Rows dupes sind, würden wir
  // nach Dedup nur 18 ausspucken statt 20. Mit 2× Limit ist Puffer da.
  const fetchLimit = limit * 2;

  if (type === "ALL") {
    const dbResults = await searchLocalDb(q, type, fetchLimit);
    return mergeAndCap(dbResults, limit);
  }

  const dbResults = await searchLocalDb(q, type, fetchLimit);

  if ((type === "BUS" || type === "TRAIN") && dbResults.length < LIVE_FALLBACK_THRESHOLD) {
    // Lokal zu wenig — Live als Fallback befragen.
    const live = type === "BUS" ? flixbusLiveLocations(q) : dbRestLiveLocations(q);
    const liveResults = await live.catch(() => []);
    return mergeAndCap([...dbResults, ...liveResults], limit);
  }

  return mergeAndCap(dbResults, limit);
}

async function searchLocalDb(
  q: string,
  type: LocationType | "ALL",
  limit: number,
): Promise<ClientLocation[]> {
  // Multi-Wort-Suche: jedes Wort muss IRGENDWO in (label, city, country, code)
  // vorkommen. Beispiel: „Willich Anrath" splittet zu ["willich", "anrath"]
  //   → Treffer wenn city="Willich" UND label enthält "anrath"
  //   → Anrath Bahnhof (city=Willich) wird gefunden
  // Wenn die Suche einzeln gelassen würde („%willich anrath%"), würde nichts
  // matchen weil kein einziges Feld die exakte Sequenz enthält.
  // Query-Normalization: User tippt manchmal „Hauptbahnhof", unsere DB-Labels
  // sind aber auf „Hbf" normalisiert. Vor dem Tokenizen ersetzen damit beide
  // Schreibweisen matchen. Word-Boundary in JS-Regex via \b.
  const normalized = q.replace(/\bhauptbahnhof\b/gi, "Hbf");
  const words = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  const wordFilters = words.map((word) => {
    const like = `%${word}%`;
    return or(
      ilike(locations.label, like),
      ilike(locations.city, like),
      ilike(locations.country, like),
      ilike(locations.code, like),
    );
  });
  const textFilter = wordFilters.length > 1 ? and(...wordFilters) : wordFilters[0];

  // Mode-spezifische Filter:
  //   - FLIGHT/CRUISE: nur exakter Type
  //   - BUS/TRAIN: Type passend ODER ALL (Cities sind als ALL gespeichert)
  //   - ALL: kein Filter, alles erlaubt
  let typeFilter;
  if (type === "FLIGHT" || type === "CRUISE") {
    typeFilter = eq(locations.type, type);
  } else if (type === "BUS" || type === "TRAIN") {
    typeFilter = or(eq(locations.type, type), eq(locations.type, "ALL"));
  } else {
    typeFilter = undefined;
  }

  const where = typeFilter ? and(textFilter, typeFilter) : textFilter;

  // Ranking-Logik (von oben nach unten priorisiert):
  //   1. EXAKTER Label-Match (Query = Label, case-insensitive) — Stadt
  //      „Amsterdam" matched vor Bus-Stop „Amsterdam" in Lyon
  //   2. TYPE-Priorität: Cities (type=ALL) vor Major-Stations vor Bus-Stops
  //      Das sortiert „NL-AMS Amsterdam (ALL)" vor osm-Bus-Stops „Amsterdam"
  //   3. Prefix-Match: Label fängt mit Query an > City fängt mit Query an >
  //      sonstwo enthalten
  //   4. Kürzeres Label first (typisch der prominentere Stop)
  const firstWord = words[0] ?? "";
  const prefixLabelLike = `${firstWord}%`;
  const prefixCityLike = `${firstWord}%`;
  const fullQuery = q.trim().toLowerCase();
  const rows = await db
    .select()
    .from(locations)
    .where(where)
    .orderBy(
      // 1. Type=ALL mit exaktem Label-Match: das ist DIE Stadt selbst — IMMER
      //    ganz oben.
      sql`CASE WHEN ${locations.type} = 'ALL' AND LOWER(${locations.label}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 2. CITY-Match: Stops IN der gesuchten Stadt (auch wenn ihr Label
      //    nicht exakt der Stadtname ist). „Amsterdam, Emmastraat" mit
      //    city=Amsterdam schlägt OSM-Bus „Amsterdam" in Lyon (city=null).
      sql`CASE WHEN LOWER(${locations.city}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 3. Exakter Label-Match (für Stops in anderen Städten die zufällig
      //    so heißen — kommen aber NACH den Stops in der echten Stadt).
      sql`CASE WHEN LOWER(${locations.label}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 4. Type-Priorität: Flughäfen > Major-Stations > regional > Bus
      sql`CASE
            WHEN ${locations.type} = 'ALL' THEN 0
            WHEN ${locations.type} = 'FLIGHT' THEN 1
            WHEN ${locations.type} = 'TRAIN' AND ${locations.subtype} IN ('LONG_DISTANCE','REGIONAL') THEN 2
            WHEN ${locations.type} = 'TRAIN' THEN 3
            WHEN ${locations.type} = 'CRUISE' THEN 4
            WHEN ${locations.type} = 'BUS' AND ${locations.subtype} = 'COACH' THEN 5
            WHEN ${locations.type} = 'BUS' THEN 6
            ELSE 7
          END`,
      // 5. Prefix-Match
      sql`CASE WHEN ${locations.label} ILIKE ${prefixLabelLike} THEN 0
               WHEN ${locations.city} ILIKE ${prefixCityLike} THEN 1
               ELSE 2 END`,
      // 6. Tiebreaker: kürzeres Label
      sql`length(${locations.label}) asc`,
    )
    .limit(limit);

  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    city: r.city,
    country: r.country,
    type: r.type,
    latitude: r.latitude !== null ? Number(r.latitude) : undefined,
    longitude: r.longitude !== null ? Number(r.longitude) : undefined,
    hafasId: r.hafasId ?? undefined,
  }));
}

/** Dedup + Cap. Lokale Treffer (haben hafasId + city + country) gewinnen gegen
 *  Live-Fallback-Treffer mit identischer HAFAS-ID — sonst doppelt sichtbar im
 *  Autocomplete ("Dortmund Hbf | Germany" + "Dortmund Hbf | Dortmund Hbf").
 *
 *  Reihenfolge: zuerst alle Lokal-Treffer einsortieren (sie sind im ersten Teil
 *  der Liste), DANN Live-Treffer nur wenn HAFAS-ID noch nicht abgedeckt.
 *  Da Caller `[...dbResults, ...liveResults]` reinpackt, ist die Iteration
 *  über das Array genau diese Reihenfolge — Lokal-First gewinnt automatisch. */
/** Source-Priorität für Dedup. Niedriger = besser (gewinnt). StaDa-Daten sind
 *  am authoritative (DB-StaDa, klare HAFAS-IDs), dann GTFS (offizielle Feeds),
 *  dann OSM (community, viele Plattform-Plattform-Dupes pro Bahnhof). */
function sourceRank(code: string): number {
  if (code.startsWith("sta:")) return 0;
  if (code.startsWith("gtfs:")) return 1;
  if (code.startsWith("osm:")) return 2;
  return 3;
}

/** Erkennt ob zwei Locations praktisch derselbe physische Stop sind:
 *    - Gleicher Name (case-insensitive)
 *    - Selbes Land
 *    - Coords innerhalb ~1km (oder Coords fehlen)
 *  Großzügiger Radius weil große Bahnhof-Plätze (Wien Hbf, Köln Hbf) mehrere
 *  hundert m messen — Plattform-OSM-Nodes und das StaDa-Zentrum müssen alle
 *  in den selben Bucket. city-Feld wird IGNORIERT (StaDa hat oft Stadtteil-
 *  Prefixes wie „Matzleinsdorf" für Wien Hbf, OSM hat city=null). */
function isSameStop(a: ClientLocation, b: ClientLocation): boolean {
  if ((a.label ?? "").toLowerCase().trim() !== (b.label ?? "").toLowerCase().trim()) return false;
  if (a.country !== b.country) return false;
  if (a.latitude == null || b.latitude == null || a.longitude == null || b.longitude == null) {
    // Ohne Coords: gleicher Label+Country reicht (passiert selten, vor allem
    // bei Cities und Airports mit unklarem Hauptzentrum).
    return true;
  }
  const dLat = a.latitude - b.latitude;
  const dLon = a.longitude - b.longitude;
  // ~1km² Bbox-Check (0.01° ≈ 1100m bei mid-Europa). Sub-Frage „Hauptbahnhof"
  // bei großen Städten kann Plätze >500m sein, daher großzügig.
  return Math.abs(dLat) < 0.01 && Math.abs(dLon) < 0.015;
}

function mergeAndCap(list: ClientLocation[], limit: number): ClientLocation[] {
  const seenCodes = new Set<string>();
  const seenHafas = new Set<string>();
  const out: ClientLocation[] = [];
  for (const l of list) {
    if (seenCodes.has(l.code)) continue;
    if (l.hafasId && seenHafas.has(l.hafasId)) continue;

    // Räumliche Dedup: linear-scan über `out` und prüfen ob's schon einen
    // physisch-gleichen Stop gibt. O(n × limit) mit limit ≈ 20, also vertretbar.
    // Linear-Scan statt Bucket-Map weil isSameStop einen Radius-Check macht
    // (Grid-Buckets würden Edge-Cases an Grid-Grenzen verpassen).
    let existingIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (isSameStop(out[i]!, l)) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx >= 0) {
      const existing = out[existingIdx]!;
      if (sourceRank(l.code) < sourceRank(existing.code)) {
        out[existingIdx] = l;
      }
      continue;
    }

    seenCodes.add(l.code);
    if (l.hafasId) seenHafas.add(l.hafasId);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}
