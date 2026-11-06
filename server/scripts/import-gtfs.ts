/**
 * Generisches GTFS-Stops-Import-Script mit Verkehrsart-Erkennung über
 * GTFS-route_type. Liest:
 *   - routes.txt    → Map<route_id, route_type>
 *   - trips.txt     → Map<trip_id, route_id>
 *   - stop_times.txt (streamed) → für jeden Stop die route_types der
 *                                 dort haltenden Trips sammeln
 *   - stops.txt     → die eigentlichen Stops
 *
 * Daraus wird pro Stop ein primärer Subtype abgeleitet (FERRY/SUBWAY/TRAM/
 * SUBURBAN/REGIONAL/LONG_DISTANCE/BUS/COACH) — präzise statt Heuristik
 * über den Stop-Namen.
 *
 * Konfiguration über Env-Variablen:
 *   GTFS_DIR         — Verzeichnis mit den entpackten GTFS-Files (default: /tmp/gtfs)
 *   GTFS_COUNTRY     — Land-Name (z.B. "Austria")
 *   GTFS_CODE_PREFIX — Code-Prefix (z.B. "gtfs:at:", default: "gtfs:")
 */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { and, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db, pool } from "../src/db/client.js";
import { locationReplacements, locations } from "../src/db/schema.js";
import { resolveReplacements } from "../src/services/locationReplacements.js";
import { applyCountryNames } from "./lib/stopNames.js";
import {
  dominantSubtype,
  kindsForStop,
  subtypeToType,
  type Kind,
  type Subtype,
} from "./lib/gtfsModes.js";
import { countryFromCoord, countryFromZone } from "../src/lib/country-from-coord.js";
import {
  NearbyIndex,
  dedupFamily,
  exactStopName,
  haversineMeters,
  sameStopName,
} from "./lib/locationDedup.js";
import {
  STAND_MERGE_M,
  familyOfSubtype,
  physicalStands,
  planStands,
  sharesDistinctWord,
  stationKinds,
  type FeedChild,
  type FeedStand,
  type KnownStop,
  type PlannedStand,
} from "./lib/gtfsStands.js";

/** So weit darf sich ein Halt zwischen zwei Veröffentlichungen „bewegen" — mehr ist ein anderer Halt. */
const SAME_STOP_MAX_MOVE_M = 2_000;
/**
 * `GTFS_IDS=unstable`: So weit darf eine Station von ihrer Zeile entfernt liegen,
 * um über Name + Lage zugeordnet zu werden — Bahnhöfe sind groß, Haltestellen
 * gleichen Namens stehen im Ort oft nur ein paar Hundert Meter auseinander.
 */
const PLACE_MATCH_M = { RAIL: 500, LOCAL: 300, FERRY: 300 } as const;
/** So nah ist eine gleichnamige Zeile anderer Familie dieselbe Station (Bahnhof samt Bussteigen). */
const SAME_SPOT_ANY_FAMILY_M = 25;
/** So nah ist eine Zeile derselben Familie unter anderem Namen derselbe Halt (umbenannt). */
const SAME_SPOT_RENAMED_M = 15;

/**
 * `GTFS_MODE=refresh` — der monatliche Abgleich (scripts/refresh-stops.sh):
 *   • NEUE Haltestellen werden eingefügt, ohne Stadt (die setzt danach
 *     `enrich-stops-city.ts`);
 *   • bei VORHANDENEN nur, was die Quelle wirklich weiß: Lage, Verkehrsarten
 *     und ihren heutigen Namen (`source_name`, daraus der Anzeigename);
 *     NIE Label, Stadt, Bahn-ID, Land oder Art — die sind teils von Hand bzw.
 *     per Skript korrigiert (fix-stop-cities.ts, HAFAS-Zuordnungen);
 *   • nichts wird gelöscht, und die Prüfungen danach (fragen bei der Bahn
 *     nach und gehen damit aufs Kontingent der Suche) laufen nicht.
 * Ohne diesen Schalter: der volle Import wie bisher (überschreibt alles).
 */
const REFRESH = process.env.GTFS_MODE === "refresh";
/**
 * `GTFS_IDS=unstable` — der Feed vergibt seine Kennungen bei jeder
 * Veröffentlichung neu (gtfs.de). Der Abgleich ordnet dann über Name + Lage +
 * Art zu statt über die Kennung: Regel 1 unten ließ sonst jeden neuen Halt,
 * dessen Nummer schon eine ALTE Zeile trug, nie herein (Okt. 2026: 12 000
 * fehlende Steige in Deutschland), und die vorhandenen Zeilen blieben auf dem
 * Stand ihrer ersten Veröffentlichung.
 */
const UNSTABLE_IDS = process.env.GTFS_IDS === "unstable";
/**
 * Präfixe ANDERER Feeds, die mit dem eigenen beginnen („gtfs:de:vbb:" unter
 * „gtfs:de:") — deren Zeilen gehören nicht zu diesem Feed. Kommagetrennt, von
 * refresh-stops.sh aus stops-feeds.conf gesetzt.
 */
const OTHER_PREFIXES = (process.env.GTFS_OTHER_PREFIXES ?? "")
  .split(",")
  .map((p: string) => p.trim())
  .filter(Boolean);
/**
 * `GTFS_STANDS=0` — keine Steige anlegen, nur Stationen auffrischen. Für die
 * Verbund-Feeds (VBB, MVG, VRS): gtfs.de beschreibt dieselben Masten schon,
 * die Verbünde nur mit 5–25 m anderer Lage — jeder Steig käme doppelt.
 */
const WITH_STANDS = process.env.GTFS_STANDS !== "0";
/**
 * `GTFS_STANDS_FIRST=1` — der ERSTE Abgleich eines Landes, dessen Halte bisher aus anderen
 * Quellen kamen (Österreich, Okt. 2026: 55 000 OSM-Halte, dazu StaDa). Eine Station mit ≥ 2
 * Steigen kommt dann auch dazu, wenn in der Nähe eine gleichnamige Zeile steht — wie im
 * unstable-Zweig: Wo die vorhandene Zeile auf einem Steig steht, wird sie dessen Zeile
 * (gtfsStands.ts). Ohne das fiel fast jede Station als „gibt es schon" heraus („Wien
 * Hauptbahnhof" neben „Wien Hbf") und mit ihr alle ihre Steige. Danach findet der normale
 * Abgleich die Stationen an ihrer Kennung — der Schalter ist nur für diesen einen Lauf.
 */
const STANDS_FIRST = process.env.GTFS_STANDS_FIRST === "1";
/** `GTFS_REPORT=<verzeichnis>` — die geplanten Änderungen als CSV (stations.csv, stands.csv). */
const REPORT_DIR = process.env.GTFS_REPORT;
const GTFS_DIR = process.env.GTFS_DIR ?? "/tmp/gtfs";
const COUNTRY = process.env.GTFS_COUNTRY ?? "Germany";
const CODE_PREFIX = process.env.GTFS_CODE_PREFIX ?? "gtfs:";
const CHUNK = 500;

/** UIC-Country-Code (erste 2 Ziffern einer 7-stelligen Bahn-ID) pro Land.
 *  Quelle: UIC merkblatt. Wenn wir den hafas_id-Wert beim Import speichern,
 *  muss dessen Prefix zum Land passen — sonst kollidiert er mit der UIC
 *  eines anderen Landes und HAFAS resolvt die ID dort hin (typisch:
 *  BE-Feed-Lille-Stop 8728600 → HAFAS gibt NL/LU-Bus-Stop). */
const UIC_PREFIX_BY_COUNTRY: Record<string, string> = {
  Germany: "80",
  Austria: "81",
  Luxembourg: "82",
  Italy: "83",
  Netherlands: "84",
  Switzerland: "85",
  Denmark: "86",
  France: "87",
  Belgium: "88",
  Poland: "51",
  "Czech Republic": "54",
  Hungary: "55",
  Slovakia: "56",
  Slovenia: "79",
  Croatia: "78",
  Greece: "73",
  Spain: "71",
  Portugal: "94",
  Sweden: "74",
  Norway: "76",
  Finland: "10",
  "United Kingdom": "70",
  Ireland: "60",
};

/** Liefert UIC-Country-Code-Prefix für ein Land, oder null wenn unbekannt
 *  (in dem Fall: hafas_id ohne Prefix-Validation übernehmen — besser als
 *  alle Einträge ablehnen). */
function uicPrefixForCountry(country: string): string | null {
  return UIC_PREFIX_BY_COUNTRY[country] ?? null;
}

interface GtfsRow {
  code: string;
  label: string;
  city: string;
  country: string;
  type: "TRAIN" | "BUS";
  latitude: string;
  longitude: string;
  hafasId: string | null;
  subtype: Subtype;
  /** Alle Mode-Kategorien (Frontend-Sicht) die am Stop verkehren, sortiert
   *  nach Häufigkeit. Bei „Dortmund Barop Parkhaus" → ["subway", "bus"]. */
  kinds: Kind[];
  source: "gtfs";
}

/** Manche Feeds (z.B. MVG München) schreiben statt der numerischen route_types
 *  Klartext-Strings rein („Stadtbus", „Tram", „U-Bahn", „S-Bahn"). Wir mappen
 *  die manuell — sonst landen alle in der NaN-Falle und werden ignoriert. */
const TEXT_ROUTE_TYPE_MAP: Record<string, Subtype> = {
  "u-bahn": "SUBWAY",
  ubahn: "SUBWAY",
  metro: "SUBWAY",
  "s-bahn": "SUBURBAN",
  sbahn: "SUBURBAN",
  tram: "TRAM",
  straßenbahn: "TRAM",
  strassenbahn: "TRAM",
  stadtbus: "BUS",
  regionalbus: "BUS",
  bus: "BUS",
  expressbus: "BUS",
  nightbus: "BUS",
  nachtbus: "BUS",
  fernbus: "COACH",
  coach: "COACH",
  faehre: "FERRY",
  fähre: "FERRY",
  ferry: "FERRY",
};

/** GTFS route_type → unser Subtype. Numerisch wie spec, ODER bekannte Klartext-
 *  Strings (MVG-Sonderfall). Gibt null wenn unbekannt → die Route trägt nichts
 *  zur Stop-Klassifikation bei.
 *  Referenz: https://gtfs.org/schedule/reference/#routestxt */
function parseRouteType(raw: string): Subtype | null {
  const num = parseInt(raw, 10);
  if (Number.isFinite(num)) return routeTypeToSubtype(num);
  const key = raw.trim().toLowerCase();
  return TEXT_ROUTE_TYPE_MAP[key] ?? null;
}

/** Verfeinert den Subtype aus dem route_short_name. Hintergrund:
 *  - VBB Berlin kodiert U-Bahn (U1, U2, ..., U9) als route_type=400 →
 *    standardmäßig SUBURBAN. Per short_name lässt sich U-Bahn von S-Bahn
 *    unterscheiden („U1" → SUBWAY, „S1" → SUBURBAN).
 *  - DB Fernverkehr ist oft route_type=2 (Rail/REGIONAL) — short_names wie
 *    „ICE", „IC", „EC", „TGV" verraten den Long-Distance-Charakter.
 *  - Manche Feeds verwenden route_type=2 generisch — short_names mit „RE",
 *    „RB", „IRE" sind klar Regional. */
function refineSubtypeFromName(baseSubtype: Subtype, shortName: string): Subtype {
  const sn = shortName.trim().toUpperCase();
  if (!sn) return baseSubtype;
  /**
   * „U1"/„S1" verraten U- und S-Bahn nur, wenn die Linie ÜBERHAUPT auf Schienen
   * fährt. Ein Bus bleibt ein Bus, auch wenn er „S5" heißt: Im gtfs.de-Feed
   * tragen 146 Buslinien so einen Namen (Schnellbusse im Münsterland, der
   * Schienenersatzverkehr der S-Bahn Berlin) — ohne diese Prüfung wurden ihre
   * Halte zu S-Bahnhöfen („Everswinkel, Nebelung" als TRAIN).
   */
  const onRails = baseSubtype !== "BUS" && baseSubtype !== "COACH" && baseSubtype !== "FERRY";
  // U-Bahn: U + Zahl (U1..U99). VBB-typische Erkennung.
  if (onRails && /^U\s?\d{1,3}$/.test(sn)) return "SUBWAY";
  // S-Bahn: S + Zahl
  if (onRails && /^S\s?\d{1,3}$/.test(sn)) return "SUBURBAN";
  // Tram-Linien: M + Zahl (Berliner MetroTram M1..M17) — falls fälschlich
  // als 400/SUBURBAN markiert. VBB hat das aber bereits richtig (900).
  if (/^M\s?\d{1,3}$/.test(sn) && baseSubtype === "SUBURBAN") return "TRAM";
  // Fernverkehr-Marken
  if (/^(ICE|IC|EC|RJ|TGV|AVE|THA|EST|NJ|NIGHTJET|EUROCITY|INTERCITY)/.test(sn)) return "LONG_DISTANCE";
  // Regionalverkehr-Marken (nur wenn aktuell als REGIONAL/SUBURBAN klassifiziert)
  if (/^(RE|RB|IRE|TER)/.test(sn) && (baseSubtype === "REGIONAL" || baseSubtype === "SUBURBAN")) {
    return "REGIONAL";
  }
  return baseSubtype;
}

/**
 * Linien, die ein Feed nachweislich falsch einordnet — je Anbieter (Name, nicht
 * Kennung: gtfs.de nummeriert bei jeder Veröffentlichung neu).
 *
 * VMV (Sept. 2026): 40 Linien mit route_type 0 (Straßenbahn). Echt sind davon
 * nur die Rostocker Linien 1–6; die dreistelligen (222, 504, 800–859) sind
 * Überlandbusse. Ihre 495 Dorfhalte kamen als Straßenbahnhalte herein, neben
 * den schon vorhandenen Bushalten gleichen Namens.
 */
const ROUTE_TYPE_FIXES: Array<{ agency: RegExp; routeType: string; shortName: RegExp; subtype: Subtype }> = [
  { agency: /^Verkehrsgesellschaft Mecklenburg/i, routeType: "0", shortName: /^\d{3}$/, subtype: "BUS" },
];

function routeTypeToSubtype(rt: number): Subtype {
  // Basic types (0-7)
  if (rt === 0) return "TRAM";
  if (rt === 1) return "SUBWAY";
  if (rt === 2) return "REGIONAL"; // wird unten ggf. zu LONG_DISTANCE upgegradet
  if (rt === 3) return "BUS";
  if (rt === 4) return "FERRY";
  if (rt === 5) return "TRAM"; // Cable tram → wie Tram behandelt
  if (rt === 6) return "TRAM"; // Aerial lift → optisch wie Tram
  if (rt === 7) return "TRAM"; // Funicular
  if (rt === 11) return "BUS"; // Trolleybus
  if (rt === 12) return "SUBWAY"; // Monorail
  // Extended types (Google Transit Extended Route Types)
  if (rt >= 100 && rt <= 117) return "LONG_DISTANCE"; // Railway service (Hochgeschwindigkeit etc.)
  if (rt >= 200 && rt <= 209) return "COACH"; // Coach service
  if (rt >= 300 && rt <= 319) return "SUBURBAN"; // Commuter rail
  if (rt === 400) return "SUBURBAN"; // Urban Railway
  if (rt >= 401 && rt <= 405) return "SUBWAY"; // Metro/Underground
  if (rt >= 700 && rt <= 717) return "BUS"; // Bus service
  if (rt >= 800 && rt <= 819) return "BUS"; // Trolleybus
  if (rt >= 900 && rt <= 906) return "TRAM"; // Tram
  if (rt >= 1000 && rt <= 1021) return "FERRY"; // Water
  return "BUS"; // Default-Fallback
}

interface CsvRow {
  [k: string]: string;
}

function parseCSVSync(path: string): CsvRow[] {
  // Ohne BOM: Sonst heißt die erste Spalte „\uFEFFagency_id" und ist unauffindbar.
  const text = readFileSync(path, "utf-8").replace(/^\uFEFF/, "");
  const lines = text.split("\n");
  const headers = parseRow(lines[0]).map((h) => h.trim());
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseRow(lines[i]);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]!] = fields[j]?.trim() ?? "";
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
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

async function main() {
  const t0 = Date.now();
  const stopsPath = resolve(GTFS_DIR, "stops.txt");
  const routesPath = resolve(GTFS_DIR, "routes.txt");
  const tripsPath = resolve(GTFS_DIR, "trips.txt");
  const stopTimesPath = resolve(GTFS_DIR, "stop_times.txt");

  console.log(`[gtfs:${COUNTRY}] reading routes.txt…`);
  const routeRows = parseCSVSync(routesPath);
  // Anbieter-Namen für `ROUTE_TYPE_FIXES` (agency.txt ist optional).
  const agencyName = new Map<string, string>();
  try {
    for (const a of parseCSVSync(resolve(GTFS_DIR, "agency.txt"))) {
      const id = a["agency_id"]?.trim() ?? "";
      agencyName.set(id, a["agency_name"]?.trim() ?? "");
    }
  } catch {
    // ohne agency.txt keine Korrekturen je Anbieter
  }
  const routeSubtype = new Map<string, Subtype>();
  let fixedRoutes = 0;
  for (const r of routeRows) {
    const id = r["route_id"]?.trim();
    const baseSub = parseRouteType(r["route_type"] ?? "");
    if (!id || !baseSub) continue;
    const shortName = r["route_short_name"] ?? "";
    const agency = agencyName.get(r["agency_id"]?.trim() ?? "") ?? "";
    const fix = ROUTE_TYPE_FIXES.find(
      (f) => f.agency.test(agency) && (r["route_type"] ?? "").trim() === f.routeType && f.shortName.test(shortName.trim()),
    );
    if (fix) fixedRoutes++;
    routeSubtype.set(id, fix ? fix.subtype : refineSubtypeFromName(baseSub, shortName));
  }
  if (fixedRoutes > 0) console.log(`[gtfs:${COUNTRY}]   ${fixedRoutes} Linien per ROUTE_TYPE_FIXES korrigiert`);
  console.log(`[gtfs:${COUNTRY}]   ${routeSubtype.size} routes`);

  // stops.txt schon hier einlesen, damit wir die Child-→-Parent-Beziehung
  // kennen bevor wir stop_times streamen. Bei Hub-Stationen (z.B. Marienplatz
  // München) referenzieren stop_times die Plattform-IDs (Children), aber
  // importiert wird nur die Parent-Station. Ohne Aggregation auf den Parent
  // würde der parent-Stop keine Subtype-Counts bekommen und als BUS-Default
  // klassifiziert werden — obwohl er U-Bahn-Plattformen hat.
  console.log(`[gtfs:${COUNTRY}] reading stops.txt…`);
  const stopRows = parseCSVSync(stopsPath);
  const childToParent = new Map<string, string>();
  /** Summe der gültigen Kind-Lagen je Elternstation (für `placeOfParent`). */
  const childPlaces = new Map<string, { lat: number; lng: number; n: number }>();
  /** Die Kinder (Steige) je Elternstation — für ihre eigenen Zeilen (gtfsStands.ts). */
  const childrenOf = new Map<string, FeedChild[]>();
  for (const r of stopRows) {
    const id = r["stop_id"]?.trim();
    const parent = r["parent_station"]?.trim();
    if (id && parent) {
      childToParent.set(id, parent);
      const lat = parseFloat(r["stop_lat"] ?? "");
      const lng = parseFloat(r["stop_lon"] ?? "");
      if (Number.isFinite(lat) && Number.isFinite(lng) && !(Math.abs(lat) < 1 && Math.abs(lng) < 1)) {
        const acc = childPlaces.get(parent) ?? { lat: 0, lng: 0, n: 0 };
        acc.lat += lat;
        acc.lng += lng;
        acc.n++;
        childPlaces.set(parent, acc);
        const locType = (r["location_type"] ?? "0").trim() || "0";
        if (locType === "0") {
          const kids = childrenOf.get(parent) ?? [];
          kids.push({
            id,
            name: r["stop_name"]?.trim() ?? "",
            lat,
            lng,
            platformCode: r["platform_code"]?.trim() ?? "",
          });
          childrenOf.set(parent, kids);
        }
      }
    }
  }
  /**
   * Die Lage einer Elternstation — ihre eigene, außer sie liegt über 1 km neben
   * der Mitte ihrer gültigen Halte (oder fehlt).
   *
   * Der niederländische Feed mittelt die Lage seiner Haltezonen selbst, und
   * zwar MIT den Halten bei 0/0: Vlissingen landete auf halbem Weg nach 0/0,
   * in der Sahara, Vlieland und Schiermonnikoog ebenso.
   */
  const placeOfParent = (id: string, lat: number, lng: number): { lat: number; lng: number } => {
    const acc = childPlaces.get(id);
    if (!acc) return { lat, lng };
    const mean = { lat: acc.lat / acc.n, lng: acc.lng / acc.n };
    const own = Number.isFinite(lat) && Number.isFinite(lng) && !(Math.abs(lat) < 1 && Math.abs(lng) < 1);
    return own && haversineMeters(lat, lng, mean.lat, mean.lng) <= 1_000 ? { lat, lng } : mean;
  };

  console.log(`[gtfs:${COUNTRY}] reading trips.txt…`);
  const tripRows = parseCSVSync(tripsPath);
  const tripRoute = new Map<string, string>();
  for (const t of tripRows) {
    const tid = t["trip_id"]?.trim();
    const rid = t["route_id"]?.trim();
    if (tid && rid) tripRoute.set(tid, rid);
  }
  console.log(`[gtfs:${COUNTRY}]   ${tripRoute.size} trips`);

  // stop_times.txt kann GB-groß sein → streamen statt komplett laden.
  // Pro Stop zählen wir pro Subtype wie viele Trips dort halten — daraus wird
  // unten der dominante Subtype frequenz-gewichtet ermittelt.
  console.log(`[gtfs:${COUNTRY}] streaming stop_times.txt…`);
  const stopSubtypeCounts = new Map<string, Map<Subtype, number>>();
  let stopIdx = -1;
  let tripIdx = -1;
  let pickupIdx = -1;
  let dropOffIdx = -1;
  /** Halte-Einträge, an denen weder ein- noch ausgestiegen wird (Durchfahrt). */
  let passOnly = 0;
  let lineCount = 0;
  const rl = createInterface({
    input: createReadStream(stopTimesPath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (lineCount === 0) {
      const headers = parseRow(line).map((h) => h.trim());
      stopIdx = headers.indexOf("stop_id");
      tripIdx = headers.indexOf("trip_id");
      pickupIdx = headers.indexOf("pickup_type");
      dropOffIdx = headers.indexOf("drop_off_type");
      if (stopIdx < 0 || tripIdx < 0) throw new Error("stop_times.txt missing stop_id/trip_id");
    } else if (line.trim()) {
      const cols = parseRow(line);
      const stopId = cols[stopIdx]?.trim();
      const tripId = cols[tripIdx]?.trim();
      /**
       * DURCHFAHRTEN zählen nicht als Halt. Der tschechische Feed (PID) führt
       * Weichen, Abzweige, Kilometerpunkte und Bezirksgrenzen als Halte mit
       * `pickup_type = drop_off_type = 1` — der Zug fährt dort durch. Gezählt
       * wurden sie trotzdem, und so standen 191 Betriebspunkte als „Bahnhof"
       * in der Suche („Zbraň hr.VUSC 0200/0520 04", „Kolín výh.č.201-207",
       * „km 64,300 -0,017"). Ohne bedienten Halt gelten sie jetzt als „ohne
       * Fahrten" — der Abgleich fügt solche nicht neu ein.
       */
      const noBoarding =
        pickupIdx >= 0 &&
        dropOffIdx >= 0 &&
        cols[pickupIdx]?.trim() === "1" &&
        cols[dropOffIdx]?.trim() === "1";
      if (noBoarding) passOnly++;
      if (stopId && tripId && !noBoarding) {
        const routeId = tripRoute.get(tripId);
        if (routeId) {
          const sub = routeSubtype.get(routeId);
          if (sub) {
            // Auf BEIDE zählen: den eigentlichen Stop UND ggf. die Parent-
            // Station. So bekommt die Parent-Station von Hub-Hubs (Marienplatz,
            // Alexanderplatz) ihre korrekte SUBWAY/TRAM-Klassifikation, weil
            // die Plattform-Children alle ihre Counts hochreichen.
            const targets = new Set<string>([stopId]);
            const parent = childToParent.get(stopId);
            if (parent) targets.add(parent);
            for (const target of targets) {
              let counts = stopSubtypeCounts.get(target);
              if (!counts) {
                counts = new Map();
                stopSubtypeCounts.set(target, counts);
              }
              counts.set(sub, (counts.get(sub) ?? 0) + 1);
            }
          }
        }
      }
    }
    lineCount++;
    if (lineCount % 1_000_000 === 0) {
      console.log(`[gtfs:${COUNTRY}]   stop_times: ${lineCount.toLocaleString()} lines`);
    }
  }
  console.log(`[gtfs:${COUNTRY}]   ${stopSubtypeCounts.size} stops with subtype info (from ${lineCount.toLocaleString()} stop_times rows, ${passOnly.toLocaleString()} Durchfahrten ignoriert)`);

  const out: GtfsRow[] = [];
  const seenCode = new Set<string>();
  /**
   * Halte, an denen im Feed KEINE Fahrt hält. Ihre Verkehrsart ist geraten
   * (Rückfall BUS) — der Abgleich darf damit keine bekannte überschreiben und
   * fügt solche Halte auch nicht neu ein (siehe unten).
   */
  const noTripData = new Set<string>();
  /**
   * Halte außerhalb der Länder, die `countryFromCoord` kennt — sie bekämen das
   * Land des Feeds („Helsingborg" als Germany). Der Abgleich fügt solche nicht
   * NEU ein; der volle Import nimmt sie wie bisher mit.
   */
  const unplaced = new Set<string>();
  /** Feed-Code einer Station (vor der Zuordnung) → ihre physischen Steige, ab zwei. */
  const standsOfStation = new Map<string, FeedStand[]>();
  /** Alleinstehende Masten (location_type 0 ohne Station) — Prag, Wien, Warschau, Großbritannien. */
  const standalonePoles = new Set<string>();

  for (const r of stopRows) {
    // Leer heißt laut GTFS „0" (Haltestelle) — `??` greift bei "" nicht, und so
    // fehlten 1 544 deutsche Einzelhalte (gtfs.de lässt die Spalte leer).
    const locType = (r["location_type"] ?? "").trim() || "0";
    const parent = r["parent_station"] ?? "";
    if (locType !== "0" && locType !== "1") continue;
    if (locType === "0" && parent !== "") continue;
    const stopId = r["stop_id"]?.trim();
    const name = r["stop_name"]?.trim();
    if (!stopId || !name) continue;
    const rawLat = parseFloat(r["stop_lat"] ?? "");
    const rawLng = parseFloat(r["stop_lon"] ?? "");
    const { lat, lng } = locType === "1" ? placeOfParent(stopId, rawLat, rawLng) : { lat: rawLat, lng: rawLng };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // 0,0 heißt „Lage unbekannt" — der niederländische Feed führt so rund
    // hundert ausländische Ziele („Wien Hütteldorf", „Aschaffenburg"). Sie
    // landeten sonst als Haltestellen im Golf von Guinea.
    if (Math.abs(lat) < 1 && Math.abs(lng) < 1) continue;

    // Polygon-basierte Country-Zuweisung: ignoriert was das GTFS-Feed sagt
    // (manche Feeds enthalten Stops in Nachbar-Ländern). Wir vertrauen den
    // Koordinaten. Wenn der Stop laut Polygon-Lookup nicht in dem Land
    // liegt, das wir gerade importieren → skip. Liegt der Stop in einem
    // anderen unserer 8 Länder → skip (es kommt dann durch den anderen
    // Country-Import rein). Liegt er in keinem modellierten Land → trotzdem
    // mit dem Feed-COUNTRY taggen (z.B. SK/HU-Stops im AT-Feed).
    // Sagt die Zeitzone „dieses Land", gilt das — die groben Polygone schnitten
    // ganze Grenzregionen ab (Bayerischer Wald, Niederrhein, Eifel, Saarland).
    const detectedCountry = countryFromZone(lat, lng) === COUNTRY ? COUNTRY : countryFromCoord(lat, lng);
    if (detectedCountry !== null && detectedCountry !== COUNTRY) continue;
    const rowCountry = detectedCountry ?? COUNTRY;

    const code = `${CODE_PREFIX}${stopId}`;
    if (code.length > 64) continue;
    if (seenCode.has(code)) continue;
    seenCode.add(code);

    // Subtype primär aus route_type, frequenz-gewichtet. Fallback BUS wenn
    // keiner zugeordnet (Stop ohne Trips — wahrscheinlich nicht in Betrieb).
    const subtypeCounts = stopSubtypeCounts.get(stopId);
    const hasData = subtypeCounts && subtypeCounts.size > 0;
    if (!hasData) noTripData.add(code);
    if (detectedCountry === null) unplaced.add(code);
    const subtype = hasData ? dominantSubtype(subtypeCounts) : "BUS";
    /**
     * Station mit Steigen: ihre Arten sind die ihrer Steige, jeder für sich
     * bewertet — über die Station gezählt fiel in Hörde Bf die U-Bahn neben
     * den Bussen unter die Schwelle. Ab zwei physischen Steigen bekommt jeder
     * eine eigene Zeile (unten, `standsOfStation`).
     */
    const stands = locType === "1" && hasData ? physicalStands(childrenOf.get(stopId) ?? [], stopSubtypeCounts) : [];
    if (stands.length >= 2) standsOfStation.set(code, stands);
    if (locType === "0") standalonePoles.add(code);
    const kinds = hasData
      ? stands.length > 0
        ? stationKinds(stands, subtypeCounts)
        : kindsForStop(subtypeCounts)
      : ["bus" as Kind];
    const type = subtypeToType(subtype);
    // hafas_id nur setzen wenn (a) der Stop im HEIMATLAND des Feeds liegt und
    // (b) die 7-stellige ID das UIC-Prefix dieses Landes trägt. Beides nötig:
    //
    //  - (a) Feed-fremde Stops tragen NIE autoritative UICs, sondern interne
    //    Nummern des Feed-Betreibers. Praxis-Schaden: der CH-Feed führt seine
    //    Auslands-Stops mit DiDok-Nummern, die zufällig plausible Prefixe
    //    haben — „Bludenz" (AT) bekam so 8101230, das ist aber die echte UIC
    //    von MÖDLING BAHNHOF. Die Abfahrtstafel von Bludenz zeigte Mödlinger
    //    Züge. Der alte Prefix-Check allein ließ das durch, weil 81 zum
    //    (grenz-ungenau Polygon-erkannten) Land passte.
    //  - (b) Beispiel: BE-Feed enthält Lille-Stops mit IDs wie 8728600 —
    //    7-stellig, aber `87` ist Frankreich, nicht Belgien (88).
    //  - Kein bekanntes Prefix fürs Land → KEINE hafas_id (früher: ungeprüft
    //    übernehmen — daher 8k NL-Rows mit internen 27-39xxxxx-Codes als
    //    vermeintliche UICs). Ohne hafas_id resolven Boards sauber über die
    //    Koordinate.
    // detectedCountry (positiv erkannt) statt rowCountry: rowCountry fällt
    // bei Polygon-Miss aufs Feed-Land zurück — damit bekäme ein Auslands-Stop
    // in nicht-modellierten Ländern (z.B. dänischer Stop im DE-Feed) wieder
    // eine Feed-Land-hafasId untergeschoben.
    const expectedUicPrefix = uicPrefixForCountry(COUNTRY);
    const hafasId =
      /^\d{7}$/.test(stopId) &&
      detectedCountry === COUNTRY &&
      expectedUicPrefix !== null &&
      stopId.slice(0, 2) === expectedUicPrefix
        ? stopId
        : null;

    /**
     * Station mit genau EINEM physischen Steig: Die Zeile steht auf dem Mast. Der
     * Mittelpunkt, den der Fahrplan der Station gibt, lag oft 30–1 000 m daneben
     * („Lehe, Neuleher/Moorkante" 989 m) — der Marker stand im Nirgendwo, die Tafel
     * suchte dort. Ab zwei Steigen zeigt die Karte ohnehin die Steige.
     */
    const at = stands.length === 1 ? { lat: stands[0]!.lat, lng: stands[0]!.lng } : { lat, lng };
    out.push({
      code,
      label: name,
      city: name,
      country: rowCountry,
      type,
      latitude: at.lat.toFixed(6),
      longitude: at.lng.toFixed(6),
      hafasId,
      subtype,
      kinds,
      source: "gtfs",
    });
  }

  /**
   * `GTFS_DUMP=<datei>` — nur ausgeben, nichts schreiben: jede Haltestelle des
   * Feeds als JSON-Zeile (Kennung, Name, Lage, Art, Unterart, Verkehrsarten).
   * Für Abgleiche und Reparaturen (scripts/repair-stop-refresh.ts).
   */
  if (process.env.GTFS_DUMP) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.env.GTFS_DUMP,
      out
        .map((r) =>
          JSON.stringify({
            code: r.code,
            name: r.label,
            lat: Number(r.latitude),
            lng: Number(r.longitude),
            type: r.type,
            trips: !noTripData.has(r.code),
            subtype: r.subtype,
            kinds: r.kinds,
            country: r.country,
          }),
        )
        .join("\n"),
    );
    console.log(`[gtfs:${COUNTRY}] ${out.length} Halte nach ${process.env.GTFS_DUMP} geschrieben`);
    process.exit(0);
  }

  /**
   * AUFFRISCHEN — zwei Regeln, beide aus einem echten Schaden (30.09.2026):
   *
   * 1. Eine VORHANDENE Kennung wird nur aufgefrischt, wenn der Feed unter ihr
   *    denselben Halt führt: gleicher Name und höchstens `SAME_STOP_MAX_MOVE_M`
   *    von der gespeicherten Lage. gtfs.de vergibt seine Kennungen bei JEDER
   *    Veröffentlichung neu — der erste Abgleich schrieb deshalb die Lage des
   *    neuen Inhabers einer Kennung in die alte Zeile, und rund 84 000 Halte
   *    standen an fremden Orten („Berlin, Siriusstr." in Sankt Augustin).
   *    Passt es nicht, bleibt die alte Zeile unberührt.
   *
   * 2. Eine NEUE Kennung kommt nur hinein, wenn es den Halt nicht schon gibt:
   *    gleiche Bahn-Nummer, oder passender Name (auch mit vorangestellter
   *    Gemeinde, ohne Akzente — `sameStopName`) in der Nähe
   *    (`NearbyIndex.hasDuplicate`). Sonst kämen die umnummerierten Halte als
   *    Dubletten herein.
   *
   * Nachgeschärft nach dem Review vom 01.10.2026 (Einzelheiten an den Regeln
   * unten): Familie statt Kategorie, UIC-Nummer, Halte ohne Fahrten, Zeilen
   * ohne Lage.
   */
  let rowsToWrite = out;
  let skippedDup = 0;
  let skippedForeign = 0;
  let skippedNoTrips = 0;
  let acceptedNew = 0;
  let skippedUnplaced = 0;
  let matchedByPlace = 0;
  let skippedReplaced = 0;
  /** Feed-Code einer Station → ihr Code in der Tabelle (zugeordnet oder neu). */
  const stationCodeOf = new Map<string, string>();
  /** Name und Stadt der Station in der Tabelle — ihre Steige übernehmen beides. */
  const stationInfo = new Map<string, { label: string; city: string | null }>();
  /** Die Zeilen der Gegend, für die Steige (gtfsStands.ts). */
  let knownStops: KnownStop[] = [];
  /** Steht an dieser Stelle schon ein Steig derselben Familie (≤ `STAND_MERGE_M`)? */
  let standCovered: (s: FeedStand) => boolean = () => false;
  /** Alle vergebenen Codes dieses Präfixes — ein neuer darf keinen davon treffen. */
  const usedCodes = new Set<string>();
  /**
   * Ein freier Code für eine Feed-Kennung. Bei `GTFS_IDS=unstable` trägt die
   * Kennung oft schon eine ALTE Zeile (anderer Halt) — dann „n" davor.
   */
  const freeCode = (id: string): string => {
    const candidates = [`${CODE_PREFIX}${id}`, `${CODE_PREFIX}n${id}`];
    for (let n = 2; candidates.length < 12; n++) candidates.push(`${CODE_PREFIX}n${id}-${n}`);
    const code = candidates.find((c) => c.length <= 64 && !usedCodes.has(c)) ?? `${CODE_PREFIX}n${id}-${Date.now()}`;
    usedCodes.add(code);
    return code;
  };
  /** Report-Zeilen für `GTFS_REPORT` (Stationen). */
  const stationReport: string[][] = [];
  if (REFRESH) {
    const knownRows = await db
      .select({
        code: locations.code,
        label: locations.label,
        city: locations.city,
        type: locations.type,
        subtype: locations.subtype,
        kinds: locations.kinds,
        lat: locations.latitude,
        lng: locations.longitude,
        parentCode: locations.parentCode,
      })
      .from(locations)
      .where(like(locations.code, `${CODE_PREFIX}%`));
    for (const r of knownRows) usedCodes.add(r.code);
    /**
     * Entfernte Zeilen dieses Präfixes (`location_replacements`, veraltet oder
     * doppelt — scripts/apply-stop-replacements.ts). Ihre Codes bleiben
     * vergeben: Ein neuer Halt darunter bekäme sonst die gespeicherten
     * Stationen, die zum Ersatz gehören.
     */
    const replacedCodes = (
      await db
        .select({ oldCode: locationReplacements.oldCode })
        .from(locationReplacements)
        .where(like(locationReplacements.oldCode, `${CODE_PREFIX}%`))
    ).map((r) => r.oldCode);
    for (const c of replacedCodes) usedCodes.add(c);
    /** Entfernte Kennung → Lage ihres heutigen Ersatzes (Ketten aufgelöst). */
    const replacedAt = new Map<string, { lat: number; lng: number }>();
    if (replacedCodes.length > 0) {
      const target = await resolveReplacements(replacedCodes);
      const at = new Map(
        (
          await db
            .select({ code: locations.code, lat: locations.latitude, lng: locations.longitude })
            .from(locations)
            .where(and(inArray(locations.code, [...new Set(target.values())]), isNotNull(locations.latitude)))
        ).map((t) => [t.code, { lat: Number(t.lat), lng: Number(t.lng) }]),
      );
      for (const [from, to] of target) {
        const p = at.get(to);
        if (p) replacedAt.set(from, p);
      }
    }
    /** Gehört die Zeile zu DIESEM Feed (nicht zu einem mit längerem Präfix, „gtfs:de:vbb:")? */
    const ownFeed = (code: string) => !OTHER_PREFIXES.some((p: string) => code.startsWith(p));
    const known = new Map(knownRows.filter((r) => ownFeed(r.code)).map((r) => [r.code, r]));
    const countries = [...new Set(out.map((r) => r.country).filter((c): c is string => !!c))];
    const nearby = await db
      .select({
        code: locations.code,
        label: locations.label,
        type: locations.type,
        subtype: locations.subtype,
        lat: locations.latitude,
        lng: locations.longitude,
        source: locations.source,
        parentCode: locations.parentCode,
        hafasId: locations.hafasId,
        displayName: locations.displayName,
      })
      .from(locations)
      .where(
        and(
          isNotNull(locations.latitude),
          inArray(locations.type, ["TRAIN", "BUS"]),
          inArray(locations.country, countries.length > 0 ? countries : [COUNTRY]),
        ),
      );
    const index = new NearbyIndex();
    /**
     * `GTFS_IDS=unstable`: Dubletten-Prüfung nur gegen FREMDE Zeilen (OSM,
     * StaDa, andere Feeds). Die eigenen ordnet schon die Zuordnung über Name +
     * Lage zu — bleibt eine eigene gleichnamige Zeile übrig, gehört sie einer
     * anderen Feed-Station (die Gegenrichtung als eigene Station), und die
     * hier ist ein eigener Halt.
     */
    const foreignIndex = new NearbyIndex();
    for (const e of nearby) {
      index.add(e.label, e.subtype, e.type, Number(e.lat), Number(e.lng));
      const own = e.code.startsWith(CODE_PREFIX) && ownFeed(e.code);
      if (!own && !e.parentCode) foreignIndex.add(e.label, e.subtype, e.type, Number(e.lat), Number(e.lng));
    }
    knownStops = nearby.map((e) => ({
      code: e.code,
      label: e.label,
      type: e.type,
      subtype: e.subtype,
      lat: Number(e.lat),
      lng: Number(e.lng),
      source: e.source,
      parentCode: e.parentCode,
      hafasId: e.hafasId,
      displayName: e.displayName,
    }));
    /** Steige, die schon in der Tabelle stehen (jede Station, jeder Feed) — für den Feed-Zwilling unten. */
    const standGrid = new Map<string, KnownStop[]>();
    for (const k of knownStops) {
      if (!k.parentCode) continue;
      const key = `${Math.floor(k.lat * 1000)},${Math.floor(k.lng * 1000)}`;
      const cell = standGrid.get(key);
      if (cell) cell.push(k);
      else standGrid.set(key, [k]);
    }
    standCovered = (s: FeedStand): boolean => {
      const subtype = dominantSubtype(s.counts);
      const family = familyOfSubtype(subtype, subtypeToType(subtype));
      const cy = Math.floor(s.lat * 1000);
      const cx = Math.floor(s.lng * 1000);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const k of standGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
            if (familyOfSubtype(k.subtype, k.type) === family && haversineMeters(s.lat, s.lng, k.lat, k.lng) <= STAND_MERGE_M) {
              return true;
            }
          }
        }
      }
      return false;
    };
    /**
     * Steht DERSELBE Mast schon in der Tabelle? Für alleinstehende Masten
     * eines Feeds mit festen Kennungen (Prag, Wien, Warschau): Jeder Mast hat
     * dort seine eigene Kennung — die Gegenrichtung 20–40 m weiter ist ein
     * anderer Halt mit eigener Tafel. Die Prüfung „gleicher Name im Umkreis
     * von 500 m" (`hasDuplicate`) hielt sie für eine Dublette: In Prag fehlten
     * so 4 400 Masten (Vollprüfung 22.10.2026, „Břetislavka" A/B 36 m).
     * Derselbe Mast ist es nur, wenn er wirklich dasteht (immer dieselbe Familie):
     *  - irgendein Halt ≤ 6 m, wie auch immer er heißt;
     *  - gleicher Name aus DIESEM Feed ≤ 5 m (Prag führt jeden Mast für Stadt-
     *    und Regionalverkehr doppelt, U3Z1P/U3Z1, 0 m) — ein anderer Mast
     *    desselben Feeds weiter weg ist die Gegenrichtung;
     *  - aus einer anderen Quelle (OSM) ≤ 15 m mit gleichem Namen oder einem
     *    gemeinsamen markanten Wort — jede Quelle schreibt anders: „Pośrednia
     *    01" (OSM) / „Pośrednia", „Doksy, železniční stanice" / „Doksy,žel.st.".
     */
    const poleGrid = new Map<string, KnownStop[]>();
    for (const k of knownStops) {
      const key = `${Math.floor(k.lat * 1000)},${Math.floor(k.lng * 1000)}`;
      const cell = poleGrid.get(key);
      if (cell) cell.push(k);
      else poleGrid.set(key, [k]);
    }
    const samePoleExists = (r: GtfsRow, lat: number, lng: number): boolean => {
      const family = dedupFamily(r.subtype, r.type);
      const cy = Math.floor(lat * 1000);
      const cx = Math.floor(lng * 1000);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const k of poleGrid.get(`${cy + dy},${cx + dx}`) ?? []) {
            if (dedupFamily(k.subtype, k.type) !== family) continue;
            const d = haversineMeters(lat, lng, k.lat, k.lng);
            if (d <= 6) return true;
            const own = k.code.startsWith(CODE_PREFIX) && ownFeed(k.code);
            const names = k.displayName ? [k.label, k.displayName] : [k.label];
            if (own) {
              if (d <= 5 && names.some((n) => sameStopName(n, r.label, { veryClose: true }))) return true;
              continue;
            }
            if (d <= 15 && names.some((n) => sameStopName(n, r.label, { veryClose: true }) || sharesDistinctWord(n, r.label))) {
              return true;
            }
          }
        }
      }
      return false;
    };
    const addPole = (r: GtfsRow, lat: number, lng: number) => {
      const key = `${Math.floor(lat * 1000)},${Math.floor(lng * 1000)}`;
      const k: KnownStop = {
        code: r.code,
        label: r.label,
        type: r.type,
        subtype: r.subtype,
        lat,
        lng,
        source: "gtfs",
        parentCode: null,
        hafasId: r.hafasId,
      };
      const cell = poleGrid.get(key);
      if (cell) cell.push(k);
      else poleGrid.set(key, [k]);
    };
    // Bahn-Nummern, die schon vergeben sind — ein neuer Halt mit derselben
    // Nummer ist derselbe Bahnhof unter anderem Namen („Brugg AG" ↔ „Brugg",
    // „Vilvorde" ↔ „Vilvoorde").
    //
    // Die Nummer steht nicht immer in `hafas_id`: Belgische Bahnhöfe tragen
    // dort DBs eigene Nummer (Vilvoorde 8800090), die UIC 8811189 steckt in der
    // Kennung (`sta:8811189`, `gtfs:be:S8811189`). Beides zählt.
    const UIC_IN_CODE = /(?:^|[^0-9])S?(8[0-9]\d{5})$/i;
    const hafasRows = await db
      .select({ hafasId: locations.hafasId, code: locations.code })
      .from(locations)
      .where(sql`${locations.hafasId} IS NOT NULL OR ${locations.code} ~* ${"S?8[0-9]{6}$"}`);
    const knownHafas = new Set<string>();
    for (const h of hafasRows) {
      if (h.hafasId) knownHafas.add(h.hafasId);
      const m = UIC_IN_CODE.exec(h.code);
      if (m) knownHafas.add(m[1]!);
    }
    /** Die UIC-Nummer eines Halts — gespeichert oder aus der Kennung (NMBS: `…S8811189`). */
    const uicOf = (r: GtfsRow): string | null => {
      if (r.hafasId) return r.hafasId;
      const m = UIC_IN_CODE.exec(r.code);
      return m ? m[1]! : null;
    };

    /**
     * `GTFS_IDS=unstable`: Feed-Station ↔ Zeile über Name + Lage + Familie,
     * höchstens `PLACE_MATCH_M` auseinander — die nächsten Paare zuerst, jede
     * Zeile und jede Feed-Station höchstens einmal. Steige (`parent_code`)
     * und Zeilen anderer Feeds sind keine Kandidaten.
     */
    const placeMatch = new Map<number, string>();
    if (UNSTABLE_IDS) {
      const grid = new Map<string, typeof knownRows>();
      for (const k of knownRows) {
        if (k.parentCode || !ownFeed(k.code) || k.lat == null || k.lng == null) continue;
        const key = `${Math.floor(Number(k.lat) * 100)},${Math.floor(Number(k.lng) * 100)}`;
        const cell = grid.get(key);
        if (cell) cell.push(k);
        else grid.set(key, [k]);
      }
      /**
       * Paare mit Rang: gleicher Name und gleiche Familie zuerst (Rang =
       * Abstand), dann — nur fast auf demselben Punkt — der gleiche Name bei
       * anderer Familie (die Bushaltestelle „Laudenbach, Bahnhof", die der Feed
       * jetzt mit den Gleisen zu EINER Station zusammenführt) und die gleiche
       * Familie unter neuem Namen („Niedererbach Brückenstr." heißt jetzt
       * „…Brückenstraße", 0 m daneben). Ohne die beiden kämen solche Halte
       * als neue Zeile neben die alte — doppelt auf der Karte.
       */
      /**
       * Zeilen, an denen schon Steige hängen. Stehen zwei Zeilen gleich gut da
       * (Zwillinge auf demselben Punkt, etwa „Hbf Nord" und „Hauptbahnhof
       * Nord"), entschied bisher die zufällige Reihenfolge aus der Datenbank:
       * Heute die eine, nächsten Monat die andere — und jedes Mal bekam die
       * gerade gewählte eigene Steige. So entstanden am 22.10.2026 in 25
       * Stationen doppelte Steige. Jetzt gewinnt die Zeile mit Steigen, dann
       * der kleinere Code.
       */
      const holdsStands = new Set(knownRows.map((k) => k.parentCode).filter((c): c is string => !!c));
      const pairs: Array<{ i: number; code: string; rank: number; holds: boolean }> = [];
      out.forEach((r, i) => {
        const lat = Number(r.latitude);
        const lng = Number(r.longitude);
        const hasTrips = !noTripData.has(r.code);
        const family = dedupFamily(r.subtype, r.type);
        const cy = Math.floor(lat * 100);
        const cx = Math.floor(lng * 100);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const k of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
              const d = haversineMeters(lat, lng, Number(k.lat), Number(k.lng));
              if (d > PLACE_MATCH_M[family]) continue;
              const sameFamily = !hasTrips || dedupFamily(k.subtype, k.type) === family;
              const named = sameStopName(k.label, r.label, { veryClose: d <= 150 });
              const holds = holdsStands.has(k.code);
              if (sameFamily && named) pairs.push({ i, code: k.code, rank: d, holds });
              else if (named && d <= SAME_SPOT_ANY_FAMILY_M) pairs.push({ i, code: k.code, rank: d + 1_000, holds });
              else if (sameFamily && d <= SAME_SPOT_RENAMED_M) pairs.push({ i, code: k.code, rank: d + 2_000, holds });
            }
          }
        }
      });
      // Auf den Meter genau gleich weit → Zeile mit Steigen zuerst, dann fest nach Code.
      pairs.sort(
        (a, b) =>
          Math.floor(a.rank) - Math.floor(b.rank) ||
          Number(b.holds) - Number(a.holds) ||
          a.rank - b.rank ||
          (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
      );
      const claimed = new Set<string>();
      for (const p of pairs) {
        if (placeMatch.has(p.i) || claimed.has(p.code)) continue;
        placeMatch.set(p.i, p.code);
        claimed.add(p.code);
      }
    }

    rowsToWrite = [];
    for (let i = 0; i < out.length; i++) {
      const r = out[i]!;
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      const hasTrips = !noTripData.has(r.code);
      const matchedCode = UNSTABLE_IDS ? placeMatch.get(i) : r.code;
      const k = matchedCode ? known.get(matchedCode) : undefined;
      if (k) {
        if (!UNSTABLE_IDS) {
          /**
           * Regel 1 — dieselbe Kennung ist nur dann derselbe Halt, wenn …
           *  - der Name passt, und
           *  - die Lage höchstens `SAME_STOP_MAX_MOVE_M` wandert — hat die Zeile
           *    KEINE Lage mehr (Reparatur vom 30.09.2026), muss der Name
           *    wörtlich gleich sein;
           *  - und die Familie gleich bleibt, sofern der Feed überhaupt Fahrten
           *    kennt: Unter einer neu vergebenen Kennung stand sonst die
           *    Bushaltestelle „München Ostbahnhof" für den Bahnhof daneben.
           * (Bei `GTFS_IDS=unstable` ist das schon die Zuordnung oben.)
           */
          const place =
            k.lat == null || k.lng == null
              ? exactStopName(k.label, r.label)
              : sameStopName(k.label, r.label) &&
                haversineMeters(lat, lng, Number(k.lat), Number(k.lng)) <= SAME_STOP_MAX_MOVE_M;
          const family =
            !hasTrips || dedupFamily(k.subtype, k.type) === dedupFamily(r.subtype, r.type);
          if (!place || !family) {
            skippedForeign++;
            stationReport.push([r.code, "", "fremd", r.label, r.latitude, r.longitude, r.kinds.join(" ")]);
            continue;
          }
        } else {
          matchedByPlace++;
        }
        // Ohne Fahrten ist die Verkehrsart nur geraten — die bekannte bleibt.
        rowsToWrite.push(
          hasTrips
            ? { ...r, code: k.code }
            : { ...r, code: k.code, subtype: (k.subtype ?? r.subtype) as Subtype, kinds: (k.kinds ?? r.kinds) as Kind[] },
        );
        stationCodeOf.set(r.code, k.code);
        stationInfo.set(r.code, { label: k.label, city: k.city });
        stationReport.push([
          r.code,
          k.code,
          (k.kinds ?? []).join(" ") === r.kinds.join(" ") ? "zugeordnet" : "zugeordnet, Arten neu",
          r.label,
          r.latitude,
          r.longitude,
          `${(k.kinds ?? []).join(" ")} → ${r.kinds.join(" ")}`,
        ]);
        continue;
      }
      /**
       * Regel 2 — eine neue Kennung kommt nur hinein, wenn …
       *  - dort überhaupt etwas fährt (sonst ist der Halt außer Betrieb, und
       *    seine Art wäre geraten);
       *  - ihre Bahn-Nummer noch nirgends steht;
       *  - es keinen Halt passenden Namens in der Nähe gibt — gleiche
       *    Kategorie im Umkreis von 500 m, oder Bus/Tram/U-Bahn untereinander
       *    im Umkreis von 150 m (`NearbyIndex.hasDuplicate`).
       */
      if (!hasTrips) {
        skippedNoTrips++;
        continue;
      }
      if (unplaced.has(r.code)) {
        skippedUnplaced++;
        continue;
      }
      // Bahnsteige und betriebsinterne Kennungen sind keine Halte für die
      // Suche („Schierke Eckerloch Gleis 1", HSB: „Wernigerode Sr_Drt 001 P1").
      if (/\bGleis\s*\d/i.test(r.label) || /[A-Za-z]+_[A-Za-z]+\s+\d{3}\b/.test(r.label)) {
        skippedUnplaced++;
        continue;
      }
      /**
       * Bewusst entfernt (veraltet bzw. Kopie eines gtfs.de-Halts) — sein
       * Ersatz steht noch daneben, also nicht wieder anlegen. Nur bei festen
       * Kennungen: Unter `GTFS_IDS=unstable` steht die Kennung nächsten Monat
       * für einen anderen Halt.
       */
      const replacement = UNSTABLE_IDS ? undefined : replacedAt.get(r.code);
      if (
        replacement &&
        haversineMeters(lat, lng, replacement.lat, replacement.lng) <= PLACE_MATCH_M[dedupFamily(r.subtype, r.type)]
      ) {
        skippedReplaced++;
        continue;
      }
      const uic = uicOf(r);
      /**
       * Gibt es den Halt unter einer anderen Quelle schon, bleibt es bei der —
       * außer die Feed-Station hat mehrere Steige: Dann kommt sie als Station
       * dazu, und ihre Steige stellen die Karte (die fremde Zeile wird, wo sie
       * genau auf einem Steig steht, dessen Zeile — gtfsStands.ts). Sonst
       * fehlten in Berlin, Köln und München die Steige ganz, weil dort die
       * Verbund-Feeds die Halte zuerst geliefert haben.
       */
      const multiStand = (standsOfStation.get(r.code)?.length ?? 0) >= 2;
      /**
       * Die Mast-Regel (`samePoleExists`) nur für Feeds, die ihr Gebiet selbst
       * stellen. Ein Verbund-Feed unter gtfs.de (`GTFS_STANDS=0`) bringt keine
       * neuen Masten: gtfs.de hat sie schon, nur 15–60 m anders verortet — der
       * Nachlauf vom 22.10.2026 legte so 1 435 Doppelungen in Berlin und Köln an.
       */
      /**
       * Feed-Zwilling: gtfs.de führt manche Masten unter zwei Stationen
       * („Striesaer Weg" / „Oschatz Striesaer Weg", dieselben Koordinaten).
       * Stehen ALLE Steige dieser neuen Station schon als Steige einer anderen
       * da, ist sie nur deren Kopie — sonst käme sie jeden Monat als Marker
       * ohne Steige zurück (neue Steige dort sperrt gtfsStands.ts).
       */
      const feedTwin = WITH_STANDS && multiStand && standsOfStation.get(r.code)!.every(standCovered);
      const dup =
        feedTwin ||
        (UNSTABLE_IDS
          ? !multiStand && foreignIndex.hasDuplicate(r.label, r.subtype, r.type, lat, lng)
          : STANDS_FIRST && WITH_STANDS && multiStand
            ? false
            : WITH_STANDS && standalonePoles.has(r.code) && dedupFamily(r.subtype, r.type) !== "RAIL"
            ? samePoleExists(r, lat, lng)
            : index.hasDuplicate(r.label, r.subtype, r.type, lat, lng));
      if ((uic && knownHafas.has(uic)) || dup) {
        skippedDup++;
        continue;
      }
      if (!UNSTABLE_IDS) index.add(r.label, r.subtype, r.type, lat, lng);
      addPole(r, lat, lng);
      if (uic) knownHafas.add(uic);
      acceptedNew++;
      // Die Feed-Kennung trägt bei neu nummerierenden Feeds oft schon eine alte Zeile.
      const code = UNSTABLE_IDS || usedCodes.has(r.code) ? freeCode(r.code.slice(CODE_PREFIX.length)) : r.code;
      usedCodes.add(code);
      rowsToWrite.push({ ...r, code });
      stationCodeOf.set(r.code, code);
      stationInfo.set(r.code, { label: r.label, city: null });
      stationReport.push([r.code, code, "neu", r.label, r.latitude, r.longitude, r.kinds.join(" ")]);
    }
    console.log(
      `[gtfs:${COUNTRY}]   ${UNSTABLE_IDS ? `${matchedByPlace} über Name + Lage zugeordnet, ` : `${skippedForeign} Kennungen gehören im Feed einem anderen Halt (unberührt), `}` +
        `${skippedDup} neue Halte übersprungen (gibt es schon), ${skippedNoTrips} neue ohne Fahrten übersprungen, ` +
        `${skippedReplaced} entfernte nicht wieder angelegt, ` +
        `${skippedUnplaced} neue außerhalb bekannter Länder oder Bahnsteige übersprungen, ` +
        `${acceptedNew} wirklich neu`,
    );
  }

  /**
   * Die STEIGE der Stationen mit mindestens zwei (lib/gtfsStands.ts) — nur im
   * Abgleich; der volle Import schreibt weiter nur Stationen.
   */
  let plannedStands: PlannedStand[] = [];
  let staleStands = 0;
  if (REFRESH && WITH_STANDS) {
    const stations = [];
    const outByCode = new Map(out.map((r) => [r.code, r]));
    for (const [feedCode, stands] of standsOfStation) {
      const code = stationCodeOf.get(feedCode);
      const info = stationInfo.get(feedCode);
      const row = outByCode.get(feedCode);
      if (!code || !info || !row) continue;
      stations.push({ code, label: info.label, country: row.country, city: info.city, stands });
    }
    const planned = planStands({
      stations,
      known: knownStops,
      stationCodes: new Set(stationCodeOf.values()),
      // „gtfs:de:" — der Präfix des Landes, samt der Verbund-Feeds darunter.
      linkPrefix: CODE_PREFIX.split(":").slice(0, 2).join(":") + ":",
      newCode: freeCode,
    });
    plannedStands = planned.stands;
    staleStands = planned.stale;
    const by = (a: PlannedStand["action"]) => plannedStands.filter((s) => s.action === a).length;
    console.log(
      `[gtfs:${COUNTRY}]   Steige: ${stations.length} Stationen mit ≥ 2 Steigen → ${by("new")} neu, ` +
        `${by("update")} aufgefrischt, ${by("link")} vorhandene Zeilen als Steig übernommen, ` +
        `${planned.covered} schon durch einen Steig an derselben Stelle vertreten; ` +
        `${staleStands} Steige kennt der Feed nicht mehr (bleiben stehen)`,
    );
  }

  if (REPORT_DIR) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(REPORT_DIR, { recursive: true });
    const csv = (rows: string[][]) =>
      rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";
    writeFileSync(
      `${REPORT_DIR}/stations.csv`,
      csv([["feed_code", "code", "aktion", "name", "lat", "lng", "arten"], ...stationReport]),
    );
    writeFileSync(
      `${REPORT_DIR}/stands.csv`,
      csv([
        ["station", "code", "aktion", "name", "steig", "unterart", "arten", "lat", "lng", "feed_ids"],
        ...plannedStands.map((s) => [
          s.parentCode,
          s.code,
          s.action,
          s.label,
          s.platform ?? "",
          s.subtype,
          s.kinds.join(" "),
          s.latitude,
          s.longitude,
          s.feedIds.join(" "),
        ]),
      ]),
    );
    console.log(`[gtfs:${COUNTRY}] Bericht: ${REPORT_DIR}/stations.csv, stands.csv`);
  }

  // `GTFS_DRY_RUN=1`: nur zählen, nichts schreiben — zum Prüfen eines Abgleichs.
  // Mit `GTFS_DRY_RUN=list` zusätzlich die wirklich neuen Halte (für Stichproben).
  if (process.env.GTFS_DRY_RUN === "list" && REFRESH) {
    for (const [, code, action, name, lat, lng, kinds] of stationReport) {
      if (action === "neu") console.log(`[gtfs:${COUNTRY}]   neu: ${code} «${name}» ${kinds} ${lat},${lng}`);
    }
  }
  if (process.env.GTFS_DRY_RUN) {
    console.log(
      `[gtfs:${COUNTRY}] Trockenlauf: ${rowsToWrite.length} Stationen und ${plannedStands.length} Steige würden geschrieben — nichts geändert.`,
    );
    process.exit(0);
  }
  console.log(`[gtfs:${COUNTRY}] inserting ${rowsToWrite.length} stops…${REFRESH ? " (Auffrischen)" : ""}`);
  let inserted = 0;
  let standsInserted = 0;
  /**
   * Stationen und Steige in EINER Transaktion: Bricht der Lauf ab, bleibt der
   * alte Stand — nie Steige ohne Station oder eine Station, die die Karte
   * schon über Steige zeigt, die es noch nicht gibt.
   */
  await db.transaction(async (tx) => {
    for (let i = 0; i < rowsToWrite.length; i += CHUNK) {
      // `sourceName`: der Name im Fahrplan — auch dort, wo `label` bleibt (siehe schema.ts).
      const batch = rowsToWrite
        .slice(i, i + CHUNK)
        .map((r) => (REFRESH ? { ...r, city: null, sourceName: r.label } : { ...r, sourceName: r.label }));
      const rows = await tx
        .insert(locations)
        .values(batch)
        .onConflictDoUpdate({
          target: locations.code,
          set: REFRESH
            ? {
                // Korrigierte Lage (`position_fixed_at`, fix-stop-positions.ts) bleibt.
                latitude: sql`CASE WHEN ${locations.positionFixedAt} IS NULL THEN excluded.latitude ELSE ${locations.latitude} END`,
                longitude: sql`CASE WHEN ${locations.positionFixedAt} IS NULL THEN excluded.longitude ELSE ${locations.longitude} END`,
                /**
                 * Die Art (`type`) schreibt der Abgleich nie — also auch keine
                 * Verkehrsart, die nicht zu ihr passt. Sonst entstanden
                 * Bahnhöfe mit Verkehrsart „Bus" (101 Zeilen, 30.09.2026).
                 */
                subtype: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.subtype ELSE ${locations.subtype} END`,
                kinds: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.kinds ELSE ${locations.kinds} END`,
                sourceName: sql`excluded.source_name`,
              }
            : {
                label: sql`excluded.label`,
                sourceName: sql`excluded.source_name`,
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
        })
        // `xmax = 0` heißt: die Zeile ist neu (eingefügt, nicht aktualisiert).
        .returning({ isNew: sql<boolean>`(xmax = 0)` });
      inserted += rows.filter((r) => r.isNew).length;
      if ((i / CHUNK) % 20 === 0) {
        console.log(`[gtfs:${COUNTRY}]   ${Math.min(i + CHUNK, rowsToWrite.length)} / ${rowsToWrite.length}`);
      }
    }
    for (let i = 0; i < plannedStands.length; i += CHUNK) {
      const batch = plannedStands.slice(i, i + CHUNK).map((s) => ({
        code: s.code,
        label: s.label,
        city: s.city,
        country: s.country,
        type: s.type,
        latitude: s.latitude,
        longitude: s.longitude,
        hafasId: null,
        subtype: s.subtype,
        kinds: s.kinds,
        source: "gtfs",
        parentCode: s.parentCode,
        platform: s.platform,
      }));
      const rows = await tx
        .insert(locations)
        .values(batch)
        .onConflictDoUpdate({
          target: locations.code,
          /**
           * Vorhandener Steig oder übernommene Zeile (OSM-Mast): Station,
           * Steig und Lage aus dem Fahrplan — an dieser Lage findet die Tafel
           * den Steig bei MOTIS. Name und Art bleiben, wie oben.
           */
          set: {
            latitude: sql`CASE WHEN ${locations.positionFixedAt} IS NULL THEN excluded.latitude ELSE ${locations.latitude} END`,
            longitude: sql`CASE WHEN ${locations.positionFixedAt} IS NULL THEN excluded.longitude ELSE ${locations.longitude} END`,
            subtype: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.subtype ELSE ${locations.subtype} END`,
            kinds: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.kinds ELSE ${locations.kinds} END`,
            parentCode: sql`excluded.parent_code`,
            platform: sql`excluded.platform`,
          },
        })
        .returning({ isNew: sql<boolean>`(xmax = 0)` });
      standsInserted += rows.filter((r) => r.isNew).length;
      if ((i / CHUNK) % 40 === 0) {
        console.log(`[gtfs:${COUNTRY}]   Steige ${Math.min(i + CHUNK, plannedStands.length)} / ${plannedStands.length}`);
      }
    }
  });

  console.log(
    `[gtfs:${COUNTRY}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${inserted} neu, ${rowsToWrite.length - inserted} aufgefrischt${REFRESH ? `, ${skippedForeign} fremd, ${skippedDup} Dubletten übersprungen; Steige ${standsInserted} neu, ${plannedStands.length - standsInserted} aufgefrischt/übernommen` : ""}.`,
  );
  /**
   * Offizielle Anzeigenamen gleich mitsetzen (`display_name`/`display_detail`,
   * Regeln in lib/stopNames.ts) — für das ganze Land, weil der Zusatz von den
   * Nachbarn abhängt. Neue Halte bekommen so sofort den Namen ohne
   * „, Richtung …" bzw. Steig; vorhandene ändern sich nur, wenn ihr Label es tut.
   */
  const named = await applyCountryNames(pool, COUNTRY);
  console.log(`[gtfs:${COUNTRY}] Anzeigenamen: ${named} geändert.`);
  if (REFRESH) process.exit(0);

  // Post-Import-Audit: prüft Stops mit verdächtigen hafas_id-Präfixen gegen
  // HAFAS und löscht klare LU/NL-Kollisionen automatisch. Nur für das gerade
  // importierte Land, damit der Audit-Scope klein bleibt. AUTO_CLEAN=1 sorgt
  // für stille Reparatur ohne User-Eingriff. Bei DE zusätzlich noch der
  // Hbf-Audit (StaDa-Sub-Code-Kollisionen).
  console.log(`[gtfs:${COUNTRY}] running post-import audit…`);
  const { spawnSync } = await import("node:child_process");
  const scriptDir = new URL("./", import.meta.url).pathname;
  const suspectAudit = spawnSync(
    "npx",
    [
      "tsx",
      `${scriptDir}audit-suspect-hafas-ids.ts`,
      `--country=${COUNTRY}`,
      "--auto-clean",
    ],
    { stdio: "inherit" },
  );
  if (suspectAudit.status !== 0) {
    console.warn(`[gtfs:${COUNTRY}] post-import suspect-audit failed (status=${suspectAudit.status})`);
  }
  if (COUNTRY === "Germany") {
    const hbfAudit = spawnSync(
      "npx",
      ["tsx", `${scriptDir}audit-hbf-hafas-ids.ts`, "--auto-clean"],
      { stdio: "inherit" },
    );
    if (hbfAudit.status !== 0) {
      console.warn(`[gtfs:${COUNTRY}] post-import hbf-audit failed (status=${hbfAudit.status})`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(`[gtfs:${COUNTRY}] failed:`, err);
  process.exit(1);
});
