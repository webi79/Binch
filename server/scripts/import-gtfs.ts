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
import { locations } from "../src/db/schema.js";
import { applyCountryNames } from "./lib/stopNames.js";
import { countryFromCoord } from "../src/lib/country-from-coord.js";
import {
  NearbyIndex,
  dedupFamily,
  exactStopName,
  haversineMeters,
  sameStopName,
} from "./lib/locationDedup.js";

/** So weit darf sich ein Halt zwischen zwei Veröffentlichungen „bewegen" — mehr ist ein anderer Halt. */
const SAME_STOP_MAX_MOVE_M = 2_000;

/**
 * `GTFS_MODE=refresh` — der monatliche Abgleich (scripts/refresh-stops.sh):
 *   • NEUE Haltestellen werden eingefügt, ohne Stadt (die setzt danach
 *     `enrich-stops-city.ts`);
 *   • bei VORHANDENEN nur, was die Quelle wirklich weiß: Lage, Verkehrsarten;
 *     NIE Label, Stadt, Bahn-ID, Land oder Art — die sind teils von Hand bzw.
 *     per Skript korrigiert (fix-stop-cities.ts, HAFAS-Zuordnungen);
 *   • nichts wird gelöscht, und die Prüfungen danach (fragen bei der Bahn
 *     nach und gehen damit aufs Kontingent der Suche) laufen nicht.
 * Ohne diesen Schalter: der volle Import wie bisher (überschreibt alles).
 */
const REFRESH = process.env.GTFS_MODE === "refresh";
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

type Subtype =
  | "LONG_DISTANCE"
  | "REGIONAL"
  | "SUBURBAN"
  | "SUBWAY"
  | "TRAM"
  | "BUS"
  | "COACH"
  | "FERRY";

/** Frontend-Kategorie zu der ein Subtype gehört — wird im `kinds` Array
 *  gespeichert und steuert welche Icons im Multi-Mode-Marker erscheinen.
 *  Mehrere Subtypes können zur selben Kategorie gehören (RAIL bündelt
 *  Long-Distance + Regional + Suburban). */
type Kind = "train" | "subway" | "tram" | "bus" | "ferry";

function subtypeToKind(s: Subtype): Kind {
  switch (s) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "train";
    case "SUBWAY": return "subway";
    case "TRAM": return "tram";
    case "BUS":
    case "COACH":
      return "bus";
    case "FERRY": return "ferry";
  }
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

/** Liefert alle Kinds die am Stop signifikant verkehren. Sortiert nach
 *  Häufigkeit absteigend. Frontend rendert die als nebeneinander-Icons in
 *  einer Pille.
 *
 *  Beispiel „Dortmund Barop Parkhaus": SUBWAY 80%, BUS 20% → ["subway","bus"].
 *  Beispiel reine Bushaltestelle: BUS 100% → ["bus"].
 *
 *  Schwelle: Sekundäre Kinds müssen ≥30% Anteil UND ≥100 Trip-Erwähnungen
 *  haben. Vermeidet dass Schienenersatzverkehr / Aggregations-Artefakte aus
 *  Quell-Feeds (z.B. gtfs.de „free") fälschlich „train" an Bushaltestellen
 *  setzen. User-Bug-Report: Hamm Münsterische Schiff.-AG hatte 20-29% rail-
 *  getaggte Trips trotz reiner Buskategorie. */
function kindsForStop(types: Map<Subtype, number>): Kind[] {
  const total = Array.from(types.values()).reduce((s, n) => s + n, 0);
  if (total === 0) return ["bus"];

  // Pro Frontend-Kind die Frequenz aufsummieren (RAIL bündelt mehrere Subtypes).
  const kindCounts = new Map<Kind, number>();
  for (const [t, c] of types) {
    const k = subtypeToKind(t);
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + c);
  }

  // Sortieren absteigend nach Frequenz. Mindestens den Top-Kind nehmen.
  const sorted = Array.from(kindCounts.entries()).sort((a, b) => b[1] - a[1]);
  const out: Kind[] = [sorted[0]![0]];
  for (let i = 1; i < sorted.length; i++) {
    const [k, c] = sorted[i]!;
    if (c / total >= 0.3 && c >= 100) out.push(k);
  }
  return out;
}

/** Wenn an einem Stop mehrere Subtypes auftreten, wählen wir den
 *  „prominentesten" (Fern > Regional > S-Bahn > U-Bahn > Tram > Bus > …).
 *  So zeigt z.B. „Berlin Hbf" mit U-Bahn-Eingang trotzdem als TRAIN. */
const SUBTYPE_PRIORITY: Record<Subtype, number> = {
  LONG_DISTANCE: 100,
  REGIONAL: 90,
  SUBURBAN: 80,
  SUBWAY: 70,
  TRAM: 60,
  COACH: 50,
  FERRY: 40,
  BUS: 30,
};

/** Wählt aus den Subtypes eines Stops den dominanten — gewichtet nach
 *  Frequenz, nicht reiner Priorität. Subtypes mit <20% Anteil werden
 *  ignoriert. So gewinnt an einem Bus-Hub mit 100 Bus-Routen + 1 S-Bahn-Route
 *  nicht mehr S-Bahn → BUS bleibt korrekt klassifiziert. */
function dominantSubtype(types: Map<Subtype, number>): Subtype {
  const total = Array.from(types.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "BUS";

  // Subtypes mit signifikantem Anteil sammeln (≥30%). Falls keiner so hoch
  // kommt → den absolut häufigsten nehmen. Hohe Schwelle weil sonst
  // Schienenersatzverkehr (~20% rail-Anteil) Buspendel-Stops als TRAIN
  // klassifiziert (User-Bug: Hamm Münsterische Schiff.-AG).
  const significant = new Set<Subtype>();
  for (const [t, c] of types) {
    if (c / total >= 0.3) significant.add(t);
  }

  if (significant.size === 0) {
    let best: Subtype = "BUS";
    let bestCount = -1;
    for (const [t, c] of types) {
      if (c > bestCount) {
        best = t;
        bestCount = c;
      }
    }
    return best;
  }

  // Aus den signifikanten Subtypes: höchste Priorität gewinnt.
  let best: Subtype = "BUS";
  let bestPrio = -1;
  for (const t of significant) {
    const p = SUBTYPE_PRIORITY[t];
    if (p > bestPrio) {
      best = t;
      bestPrio = p;
    }
  }
  return best;
}

/** Hauptkategorie für die DB — TRAIN umfasst alles auf Schienen ohne U-Bahn/Tram. */
function subtypeToType(s: Subtype): "TRAIN" | "BUS" {
  if (s === "LONG_DISTANCE" || s === "REGIONAL" || s === "SUBURBAN") return "TRAIN";
  return "BUS"; // SUBWAY/TRAM/BUS/COACH/FERRY fallen optisch in BUS-Kategorie,
  // werden aber im Marker über `subtype` weiter unterschieden (im surroundings-Endpoint).
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

  for (const r of stopRows) {
    const locType = r["location_type"] ?? "0";
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
    const detectedCountry = countryFromCoord(lat, lng);
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
    const kinds = hasData ? kindsForStop(subtypeCounts) : ["bus" as Kind];
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

    out.push({
      code,
      label: name,
      city: name,
      country: rowCountry,
      type,
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
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
  if (REFRESH) {
    const knownRows = await db
      .select({
        code: locations.code,
        label: locations.label,
        type: locations.type,
        subtype: locations.subtype,
        kinds: locations.kinds,
        lat: locations.latitude,
        lng: locations.longitude,
      })
      .from(locations)
      .where(like(locations.code, `${CODE_PREFIX}%`));
    const known = new Map(knownRows.map((r) => [r.code, r]));
    const countries = [...new Set(out.map((r) => r.country).filter((c): c is string => !!c))];
    const nearby = await db
      .select({
        label: locations.label,
        type: locations.type,
        subtype: locations.subtype,
        lat: locations.latitude,
        lng: locations.longitude,
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
    for (const e of nearby) {
      index.add(e.label, e.subtype, e.type, Number(e.lat), Number(e.lng));
    }
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

    rowsToWrite = [];
    for (const r of out) {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      const hasTrips = !noTripData.has(r.code);
      const k = known.get(r.code);
      if (k) {
        /**
         * Regel 1 — dieselbe Kennung ist nur dann derselbe Halt, wenn …
         *  - der Name passt, und
         *  - die Lage höchstens `SAME_STOP_MAX_MOVE_M` wandert — hat die Zeile
         *    KEINE Lage mehr (Reparatur vom 30.09.2026), muss der Name
         *    wörtlich gleich sein;
         *  - und die Familie gleich bleibt, sofern der Feed überhaupt Fahrten
         *    kennt: Unter einer neu vergebenen Kennung stand sonst die
         *    Bushaltestelle „München Ostbahnhof" für den Bahnhof daneben.
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
          continue;
        }
        // Ohne Fahrten ist die Verkehrsart nur geraten — die bekannte bleibt.
        rowsToWrite.push(
          hasTrips
            ? r
            : { ...r, subtype: (k.subtype ?? r.subtype) as Subtype, kinds: (k.kinds ?? r.kinds) as Kind[] },
        );
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
      const uic = uicOf(r);
      if ((uic && knownHafas.has(uic)) || index.hasDuplicate(r.label, r.subtype, r.type, lat, lng)) {
        skippedDup++;
        continue;
      }
      index.add(r.label, r.subtype, r.type, lat, lng);
      if (uic) knownHafas.add(uic);
      acceptedNew++;
      rowsToWrite.push(r);
    }
    console.log(
      `[gtfs:${COUNTRY}]   ${skippedForeign} Kennungen gehören im Feed einem anderen Halt (unberührt), ` +
        `${skippedDup} neue Halte übersprungen (gibt es schon), ${skippedNoTrips} neue ohne Fahrten übersprungen, ` +
        `${skippedUnplaced} neue außerhalb bekannter Länder oder Bahnsteige übersprungen, ` +
        `${acceptedNew} wirklich neu`,
    );
  }

  // `GTFS_DRY_RUN=1`: nur zählen, nichts schreiben — zum Prüfen eines Abgleichs.
  // Mit `GTFS_DRY_RUN=list` zusätzlich die wirklich neuen Halte (für Stichproben).
  if (process.env.GTFS_DRY_RUN === "list" && REFRESH) {
    const knownCodes = new Set(
      (await db.select({ code: locations.code }).from(locations).where(like(locations.code, `${CODE_PREFIX}%`))).map((r) => r.code),
    );
    for (const r of rowsToWrite) {
      if (!knownCodes.has(r.code)) console.log(`[gtfs:${COUNTRY}]   neu: ${r.code} «${r.label}» ${r.subtype} ${r.latitude},${r.longitude}`);
    }
  }
  if (process.env.GTFS_DRY_RUN) {
    console.log(`[gtfs:${COUNTRY}] Trockenlauf: ${rowsToWrite.length} würden geschrieben — nichts geändert.`);
    process.exit(0);
  }
  console.log(`[gtfs:${COUNTRY}] inserting ${rowsToWrite.length} stops…${REFRESH ? " (Auffrischen)" : ""}`);
  let inserted = 0;
  for (let i = 0; i < rowsToWrite.length; i += CHUNK) {
    const batch = REFRESH
      ? rowsToWrite.slice(i, i + CHUNK).map((r) => ({ ...r, city: null }))
      : rowsToWrite.slice(i, i + CHUNK);
    const rows = await db
      .insert(locations)
      .values(batch)
      .onConflictDoUpdate({
        target: locations.code,
        set: REFRESH
          ? {
              latitude: sql`excluded.latitude`,
              longitude: sql`excluded.longitude`,
              /**
               * Die Art (`type`) schreibt der Abgleich nie — also auch keine
               * Verkehrsart, die nicht zu ihr passt. Sonst entstanden
               * Bahnhöfe mit Verkehrsart „Bus" (101 Zeilen, 30.09.2026).
               */
              subtype: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.subtype ELSE ${locations.subtype} END`,
              kinds: sql`CASE WHEN excluded.type = ${locations.type} THEN excluded.kinds ELSE ${locations.kinds} END`,
            }
          : {
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
      })
      // `xmax = 0` heißt: die Zeile ist neu (eingefügt, nicht aktualisiert).
      .returning({ isNew: sql<boolean>`(xmax = 0)` });
    inserted += rows.filter((r) => r.isNew).length;
    if ((i / CHUNK) % 20 === 0) {
      console.log(`[gtfs:${COUNTRY}]   ${Math.min(i + CHUNK, rowsToWrite.length)} / ${rowsToWrite.length}`);
    }
  }

  console.log(
    `[gtfs:${COUNTRY}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${inserted} neu, ${rowsToWrite.length - inserted} aufgefrischt${REFRESH ? `, ${skippedForeign} fremd, ${skippedDup} Dubletten übersprungen` : ""}.`,
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
