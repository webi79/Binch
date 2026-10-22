import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { ipLimiter } from "../util/rateLimit.js";
import { BoundedTtlCache } from "../util/boundedCache.js";

/**
 * Liefert Haltestellen/Bahnhöfe in der Nähe einer Koordinate. Quelle ist die
 * lokale `locations`-Tabelle (nach StaDa + GTFS-Imports → Europa-weite
 * Coverage). Kein Live-Call zu db-rest oder anderen externen APIs — alle
 * Daten kommen aus der eigenen Postgres.
 */

const querySchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  distance: z.coerce.number().int().min(50).max(2_000_000).default(1500),
  mode: z.enum(["transit", "airport", "cruise"]).default("transit"),
  /** Client-Wunsch-Limit. Bei niedrigem Zoom skaliert das Backend nach oben
   *  (siehe limitForZoom), damit das Clustering im Frontend Material hat. */
  limit: z.coerce.number().int().min(1).max(2000).default(60),
  /** Aktuelles Zoom-Level der Karte. Steuert welche Stop-Kategorien wir zeigen. */
  zoom: z.coerce.number().min(0).max(22).default(14),
});

type MarkerKind = "train" | "subway" | "bus" | "tram" | "airport";

/**
 * Art eines Halts für die Frage „derselbe Halt?" auf der Karte (siehe `MERGE_M`).
 * U-Bahn und Tram getrennt: Die U-Bahn zeigt die Karte je Station als EINEN
 * Marker, Tram-Steige dagegen einzeln wie Bus-Steige (Nutzer, 22.10.2026).
 */
type StopFamily = "rail" | "subway" | "tram" | "bus" | "ferry";

function familyOf(subtype: string | null, type: string): StopFamily {
  switch (subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "rail";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "FERRY":
      return "ferry";
    case "BUS":
    case "COACH":
      return "bus";
    default:
      return type === "TRAIN" ? "rail" : "bus";
  }
}

/** Subtype → Marker-Kind:
 *    LONG_DISTANCE / REGIONAL / SUBURBAN → train (gelb)
 *    SUBWAY                              → subway (dunkelblau, eigene Farbe)
 *    TRAM                                → tram (dunkelgrau)
 *    BUS / COACH / FERRY                 → bus (lila)
 *  Damit ist im Frontend klar visuell unterscheidbar. */
function subtypeToKind(subtype: string | null, fallbackType: string): MarkerKind {
  switch (subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "train";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "BUS":
    case "COACH":
    case "FERRY":
      return "bus";
    default:
      // Kein Subtype gesetzt (z.B. Legacy-Daten ohne GTFS-Re-Import) → grob
      // über den type-Fallback unterscheiden.
      return fallbackType === "TRAIN" ? "train" : "bus";
  }
}

interface SurroundingsMarker {
  id: string;
  /** Dominante Mode-Kategorie — wird als Primär-Icon im Marker genutzt
   *  (z.B. zur Sortierung, BG-Farbe). Für die volle Darstellung kommt das
   *  `kinds`-Array hinzu: alle Modi die an dem Stop verkehren, in einer
   *  abgerundeten Pille horizontal nebeneinander. */
  type: MarkerKind;
  kinds: MarkerKind[];
  latitude: number;
  longitude: number;
  selected?: boolean;
  /** Angezeigter Name — der offizielle (`display_name`), sonst die Quelle. */
  label?: string;
  /** Unterscheidungs-Zusatz, nur bei gleichnamigem Nachbarn (`display_detail`). */
  detail?: string;
  /**
   * Steig-Bezeichnung („3", „A") — nur bei einem einzelnen Bus- oder Tram-Steig einer
   * Station. Die App setzt ihr Wort davor („Steig 3", „Stand 3", „Quai 3").
   */
  platform?: string;
}

interface LineBadge {
  id: string;
  color: string;
}

interface SurroundingsListItem {
  id: string;
  name: string;
  detail?: string;
  /** Wie beim Marker: Steig-Bezeichnung eines einzelnen Bus- oder Tram-Steigs. */
  platform?: string;
  kinds: MarkerKind[];
  distance: string;
  lines?: LineBadge[];
  selected?: boolean;
}

interface SurroundingsResponse {
  markers: SurroundingsMarker[];
  list: SurroundingsListItem[];
}

function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Haversine in Metern. Klein/schnell genug für ~60 Treffer in JS, nachdem
 *  die SQL-Bounding-Box vorgefiltert hat. */
function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Zoom-abhängiger Filter — bei sehr niedrigem Zoom blenden wir Bus-Stops
 *  aus damit die Karte nicht von Tausenden Markern erschlagen wird. Schwelle
 *  ist großzügig (ab Zoom 12 sieht man Busse), damit normale Stadt-Zoom-Levels
 *  schon die Bushaltestellen mitliefern. Clustering im Frontend kümmert sich
 *  um die Menge. */
function typesForZoom(zoom: number): ("TRAIN" | "BUS")[] {
  if (zoom >= 13) return ["TRAIN", "BUS"];
  if (zoom >= 9) return ["TRAIN"];
  // Schon ab Regional-Sicht (zoom<9) keine Marker mehr — Cluster sollen schnell
  // verschwinden, nicht das gesamte Land überdecken.
  return [];
}

/** Zoom-abhängiges Limit fürs Backend. Im Train-only-Bereich (zoom 9-12) wollen
 *  wir genug Stationen für Clustering — aber kein Übermaß, das die Karte
 *  zubetoniert. */
function limitForZoom(zoom: number, clientLimit: number): number {
  if (zoom >= 13) return clientLimit; // Stadt-Zoom: was der Client wünscht (default 60)
  if (zoom >= 11) return Math.max(clientLimit, 120); // Stadtregion
  return Math.max(clientLimit, 250); // zoom 9-10: regional, fürs Clustering
}

async function fetchTransitNearby(
  latitude: number,
  longitude: number,
  distanceMeters: number,
  limit: number,
  zoom: number,
): Promise<SurroundingsResponse> {
  // Bounding-Box-Pre-Filter über die geographischen Spalten — vermeidet einen
  // Full-Table-Scan. Lat-Konversion: 1° ≈ 111km. Lng-Konversion hängt vom
  // Breitengrad ab (am Äquator 111km, am Pol → 0).
  const latDelta = distanceMeters / 111_000;
  const lngDelta =
    distanceMeters / (111_000 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));

  const allowedTypes = typesForZoom(zoom);
  // Bei sehr niedrigem Zoom (z.B. < 6) gibt typesForZoom eine leere Liste
  // zurück → wir wollen gar keine Marker zeigen.
  if (allowedTypes.length === 0) {
    return { markers: [], list: [] };
  }
  const typeFilter = allowedTypes.length === 2
    ? or(eq(locations.type, "TRAIN"), eq(locations.type, "BUS"))
    : eq(locations.type, allowedTypes[0]!);

  // Zoom-skaliertes Limit: bei rausgezoomter Karte (zoom<13) zeigen wir nur
  // Trains, wollen aber viele davon, damit das Frontend cluster kann.
  const effectiveLimit = limitForZoom(zoom, limit);

  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      displayName: locations.displayName,
      displayDetail: locations.displayDetail,
      type: locations.type,
      subtype: locations.subtype,
      kinds: locations.kinds,
      hafasId: locations.hafasId,
      source: locations.source,
      latitude: locations.latitude,
      longitude: locations.longitude,
      parentCode: locations.parentCode,
      platform: locations.platform,
      /** Angezeigter Name der Station eines Steigs — gruppiert wird nach ihm (siehe unten). */
      parentName: sql<string | null>`(SELECT coalesce(p.display_name, p.label) FROM locations p WHERE p.code = ${locations.parentCode})`,
    })
    .from(locations)
    .where(
      and(
        isNotNull(locations.latitude),
        isNotNull(locations.longitude),
        gte(locations.latitude, String(latitude - latDelta)),
        lte(locations.latitude, String(latitude + latDelta)),
        gte(locations.longitude, String(longitude - lngDelta)),
        lte(locations.longitude, String(longitude + lngDelta)),
        typeFilter,
        /**
         * Eine Station mit Steigen zeigt die Karte über ihre Steige, nicht
         * selbst: In Hörde fünf Bus-Steige (je eigene Tafel) und ein „U" aus
         * den beiden Gleisen — statt eines Bus-Markers für alles. Die Station
         * bleibt für die Suche (Tafel über alle Steige).
         */
        sql`NOT EXISTS (SELECT 1 FROM locations s WHERE s.parent_code = ${locations.code})`,
        // Halte, an denen laut Fahrplan nichts mehr hält (scripts/mark-unserved-stops.ts).
        isNull(locations.unservedAt),
      ),
    )
    // Pre-Sortierung über euklidischen Quadratabstand (kein sqrt, schnell) —
    // exakte Haversine-Distanz wird unten in JS für die finalen Treffer berechnet.
    .orderBy(
      sql`(${locations.latitude} - ${latitude})*(${locations.latitude} - ${latitude}) + (${locations.longitude} - ${longitude})*(${locations.longitude} - ${longitude}) ASC`,
    )
    .limit(effectiveLimit * 3);

  // Name-basierter Dedup mit Normalisierung: „Werl" und „Werl Bahnhof" werden
  // auf denselben Schlüssel „werl" reduziert, sodass nur eine Variante übrig
  // bleibt. Reine Koordinaten-Dedup reicht nicht, weil verschiedene Quellen
  // (StaDa vs GTFS-DE) für dieselbe Station leicht abweichende Coords haben
  // (30-100m Versatz ist normal).
  type Item = {
    row: (typeof rows)[number];
    lat: number;
    lng: number;
    dist: number;
  };
  const SUBTYPE_PRIO: Record<string, number> = {
    LONG_DISTANCE: 100,
    REGIONAL: 90,
    SUBURBAN: 80,
    SUBWAY: 70,
    TRAM: 60,
    COACH: 50,
    FERRY: 40,
    BUS: 30,
  };
  /** True wenn `a` gegenüber `b` bevorzugt werden soll. Reihenfolge:
   *   1. Vorhandene HAFAS-ID (kann direkt für Trip-Search → wichtiger)
   *   2. Höhere Subtype-Priorität (Hbf > Regional > S-Bahn > U-Bahn > Tram > Bus)
   *   3. Quelle StaDa (kuratierter Datensatz) vor GTFS (rohe Stop-Daten)
   *   4. Kürzeres Label (konkrete Stations-Namen wie „Werl" statt „Werl Bahnhof")
   *   5. Näher am Suchpunkt */
  function prefer(a: Item, b: Item): boolean {
    const aH = a.row.hafasId ? 1 : 0;
    const bH = b.row.hafasId ? 1 : 0;
    if (aH !== bH) return aH > bH;

    const aSub = SUBTYPE_PRIO[a.row.subtype ?? ""] ?? 0;
    const bSub = SUBTYPE_PRIO[b.row.subtype ?? ""] ?? 0;
    if (aSub !== bSub) return aSub > bSub;

    const aStada = a.row.source === "stada" ? 1 : 0;
    const bStada = b.row.source === "stada" ? 1 : 0;
    if (aStada !== bStada) return aStada > bStada;

    if (a.row.label.length !== b.row.label.length) {
      return a.row.label.length < b.row.label.length;
    }
    return a.dist < b.dist;
  }

  /** Entfernt Suffixe wie „Bahnhof", „Hbf", „S+U", „Gare" usw. plus alle
   *  Sonderzeichen → vergleichbarer Schlüssel über Datenquellen hinweg. */
  function normalizeName(label: string): string {
    return label
      .toLowerCase()
      // Reihenfolge wichtig: spezifische Zusammensetzungen ZUERST entfernen,
      // sonst bleibt nach Entfernen von „Bahnhof" ein dangling „s" / „u"
      // stehen das den Schlüssel zersägt („Unna West S-Bahnhof" → „unna west s"
      // wäre ≠ „Unna West" → „unna west").
      .replace(/\b[su][\s\-]?bahnhof\b/g, " ")
      .replace(/\bhauptbahnhof\b/g, " ")
      .replace(/\bbahnhof\b/g, " ")
      .replace(/\bhbf\.?\b/g, " ")
      .replace(/\bbf\.?\b/g, " ")
      .replace(/\bs[+\- ]?u\b/g, " ")
      .replace(/\bs[\s\-]?bahn\b/g, " ")
      .replace(/\bu[\s\-]?bahn\b/g, " ")
      .replace(/\bzob\b/g, " ")
      .replace(/\bgare\b/g, " ")
      .replace(/\bstation\b/g, " ")
      .replace(/\bstazione\b/g, " ")
      .replace(/\bestaci[óo]n\b/g, " ")
      .replace(/\bstacja\b/g, " ")
      .replace(/\bn[aá]draž[íi]\b/g, " ")
      // Trenner zu Space — inkl. Bindestrich, sonst normalisiert „Unna-
      // Königsborn" ≠ „Unna Königsborn" und die Rows mergen nicht.
      .replace(/[(),.;:/\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Kandidaten sammeln (sortiert nach Distanz für stabilen Dedup-Output).
  const candidates: Item[] = [];
  for (const r of rows) {
    if (r.latitude === null || r.longitude === null) continue;
    const lat = Number(r.latitude);
    const lng = Number(r.longitude);
    const d = haversineMeters(latitude, longitude, lat, lng);
    if (d > distanceMeters) continue;
    candidates.push({ row: r, lat, lng, dist: d });
  }
  candidates.sort((a, b) => a.dist - b.dist);

  /**
   * Zusammengefasst wird nur, was DERSELBE Halt ist — nicht alles, was gleich
   * heißt. Vorher wurde jeder Halt im Umkreis mit gleichem (normalisiertem)
   * Namen ein Marker: beide Straßenseiten einer Bushaltestelle (je mit eigener
   * Tafel) und der Bahnhof „Werl" samt der Bushaltestelle „Werl, Bahnhof" davor
   * — eine Zug-Bus-Pille, deren Tipp nur die Zugtafel zeigte; die Busse am
   * Bahnhof waren auf der Karte nicht zu erreichen.
   *
   * Jetzt nur noch innerhalb derselben ART (`familyOf`) und nah beieinander:
   *   • Bahnhof, U-Bahn, Fähre: gleicher Name bis `MERGE_M` — derselbe
   *     Bahnhof aus mehreren Quellen (StaDa, Fahrplan, OSM), 30–100 m versetzt,
   *     bzw. die Gleise einer Station (scripts/lib/gtfsStands.ts).
   *   • Bus und Tram: gleichnamige Halte sind die Steige bzw. beiden
   *     Fahrtrichtungen, jeder mit eigener Tafel — eigene Marker. Nur exakt
   *     deckungsgleiche Zeilen (≤ 2 m) gelten als doppelt eingelesen. Tram
   *     einzeln seit 22.10.2026 (Nutzer: „Bussteige einzeln, Tram einzeln,
   *     U-Bahn und Zug können so bleiben").
   */
  const MERGE_M: Record<StopFamily, number> = { rail: 400, subway: 200, tram: 2, ferry: 200, bus: 2 };
  const groups: Item[][] = [];
  const groupsByKey = new Map<string, number[]>();
  for (const item of candidates) {
    /**
     * Verglichen wird der ANGEZEIGTE Name, nicht der Quellname: In München
     * heißen die Fahrplan-Zeilen noch „Munich München Hbf" (alter Orts-Vorsatz),
     * StaDa „München Hbf" — zwei Bahn-Marker auf demselben Bahnhof.
     *
     * Und ein Steig zählt mit dem Namen SEINER STATION: Übernommene Zeilen (MVG
     * „Hbf" unter „Hbf (U, Tram)", OSM-Masten) behalten ihren eigenen Namen —
     * die Gleise einer U-Bahn-Station wurden sonst zwei Marker. Bleibt vom
     * Namen nichts übrig („Hbf"), zählt der Quellname.
     */
    const norm =
      normalizeName(item.row.parentName ?? item.row.displayName ?? item.row.label) || normalizeName(item.row.label);
    if (!norm) {
      groups.push([item]);
      continue;
    }
    const family = familyOf(item.row.subtype, item.row.type);
    const key = `${family}|${norm}`;
    const radius = MERGE_M[family];
    const same = (groupsByKey.get(key) ?? []).find((gi) => {
      const anchor = groups[gi]![0]!;
      return haversineMeters(anchor.lat, anchor.lng, item.lat, item.lng) <= radius;
    });
    if (same !== undefined) {
      groups[same]!.push(item);
    } else {
      groupsByKey.set(key, [...(groupsByKey.get(key) ?? []), groups.length]);
      groups.push([item]);
    }
  }

  type MergedMarker = { canonical: Item; kinds: MarkerKind[] };

  /** Vereinigt die `kinds`-Arrays aller Items einer Gruppe in eine sortierte,
   *  doppelfreie Liste. Reihenfolge: erst Frequenz-Reihenfolge des kanonischen
   *  Items, dann Sekundär-Kinds aus den anderen Items. Fallback wenn ein Item
   *  noch kein `kinds`-Feld hat (alte Rows ohne neue Import-Spalte): vom
   *  subtype/type ableiten. */
  function unionKinds(group: Item[], canonical: Item): MarkerKind[] {
    const seen = new Set<MarkerKind>();
    const result: MarkerKind[] = [];
    function add(k: MarkerKind) {
      if (!seen.has(k)) {
        seen.add(k);
        result.push(k);
      }
    }
    function fromRow(row: Item["row"]): MarkerKind[] {
      if (row.kinds && row.kinds.length > 0) return row.kinds as MarkerKind[];
      return [subtypeToKind(row.subtype, row.type)];
    }
    // Kanonisch zuerst — die dominante Mode soll auch im Pillen-Layout
    // ganz links stehen.
    for (const k of fromRow(canonical.row)) add(k);
    for (const item of group) {
      if (item === canonical) continue;
      for (const k of fromRow(item.row)) add(k);
    }
    return result;
  }

  const merged: MergedMarker[] = [];
  for (const group of groups) {
    // Kanonische Variante per `prefer` (HAFAS-ID + Subtype-Prio + StaDa-Quelle).
    let canonical = group[0]!;
    for (let i = 1; i < group.length; i++) {
      if (prefer(group[i]!, canonical)) canonical = group[i]!;
    }
    merged.push({ canonical, kinds: unionKinds(group, canonical) });
  }

  const sorted = merged
    .sort((a, b) => a.canonical.dist - b.canonical.dist)
    .slice(0, effectiveLimit);

  /**
   * Die Steig-Bezeichnung nur dort, wo der Marker GENAU EIN Bus- oder Tram-Steig
   * ist — ein U-Bahn-Marker steht für alle Gleise seiner Station, sein
   * „Gleis 21" wäre nur das zufällig gewählte.
   */
  const platformOf = (s: MergedMarker): string | undefined => {
    const row = s.canonical.row;
    const family = familyOf(row.subtype, row.type);
    return row.parentCode && row.platform && (family === "bus" || family === "tram") ? row.platform : undefined;
  };

  const markers: SurroundingsMarker[] = sorted.map((s, i) => {
    const primaryKind = s.kinds[0] ?? subtypeToKind(s.canonical.row.subtype, s.canonical.row.type);
    const platform = platformOf(s);
    return {
      id: s.canonical.row.code,
      type: primaryKind,
      kinds: s.kinds,
      latitude: s.canonical.lat,
      longitude: s.canonical.lng,
      // Label mitgeben damit das Frontend beim Marker-Tap sofort den
      // Stationsnamen im Detail-Sheet zeigen kann (ohne extra Roundtrip).
      label: s.canonical.row.displayName ?? s.canonical.row.label,
      ...(s.canonical.row.displayDetail ? { detail: s.canonical.row.displayDetail } : {}),
      ...(platform ? { platform } : {}),
      selected: i === 0,
    };
  });

  const listItems: SurroundingsListItem[] = sorted.map((s, i) => ({
    id: s.canonical.row.code,
    name: s.canonical.row.displayName ?? s.canonical.row.label,
    ...(s.canonical.row.displayDetail ? { detail: s.canonical.row.displayDetail } : {}),
    ...(platformOf(s) ? { platform: platformOf(s) } : {}),
    kinds: s.kinds,
    distance: formatDistance(s.canonical.dist),
    selected: i === 0,
  }));

  return { markers, list: listItems };
}

/**
 * Fertige Antworten kurz aufheben — dieselbe Ecke kostet dann gar nichts mehr.
 *
 * WAS SICH DAMIT ÄNDERT: Die Karte fragt in einem ~500m-Raster, und dieselben
 * Rasterfelder werden ständig erneut besucht — beim Zurückwischen, beim
 * Wegzoomen und Wiederkommen, beim nächsten App-Start, und von jedem weiteren
 * Gerät in derselben Stadt. Bisher lief dafür jedes Mal die volle Abfrage samt
 * Zusammenlegen gleichnamiger Haltestellen.
 *
 * Der Schlüssel sind die Parameter, wie sie HEREINKOMMEN — ungerundet. Auf ein
 * Raster zu runden hätte die Trefferquote erhöht, aber den angefragten
 * Mittelpunkt verschoben: Entfernungen und die Reihenfolge „nächstgelegene
 * zuerst" bezögen sich dann auf einen anderen Punkt als den gefragten. Die App
 * schickt ohnehin gerundete Werte, der Gewinn wäre also klein und der Preis
 * eine stille Ungenauigkeit.
 *
 * Zehn Minuten: Die Tabelle ändert sich nur bei einem Datenimport, also
 * höchstens wöchentlich. Die kurze Frist ist nicht wegen der Aktualität da,
 * sondern damit der Speicher nicht an alten Ecken festhält.
 *
 * 400 Einträge: Ein Stadt-Ausschnitt wiegt rund 11 KB, ein weit
 * herausgezoomter mit 400 Markierungen ein Vielfaches — der Deckel hält das
 * im niedrigen zweistelligen Megabyte-Bereich, und der Cache verdrängt nach
 * Alter (LRU).
 */
const nearbyCache = new BoundedTtlCache<SurroundingsResponse>(400, 10 * 60 * 1000);

export async function surroundingsRoutes(app: FastifyInstance) {
  /**
   * Das Budget der KARTE — und es war um Größenordnungen zu knapp.
   *
   * Hier standen 40 Anfragen pro Minute mit der Begründung, der Endpunkt
   * verbrauche „DB-/MOTIS-Kontingent". Das stimmt nicht (mehr): Er fragt
   * ausschließlich die eigene `locations`-Tabelle, kein einziger fremder
   * Dienst wird angefasst — siehe den Kopf dieser Datei. Die Begründung stammt
   * aus einer Fassung, die es nicht mehr gibt.
   *
   * Die Wirkung war dagegen sehr real. Die App fragt pro Kartenausschnitt
   * (~500m-Raster), also einmal pro Wischgeste, die das Raster verlässt.
   * Nachgemessen: Ab Anfrage 41 antwortet die Route mit `429` und
   * `Retry-After: 60` — danach kommt eine GANZE MINUTE lang kein Pin mehr. In
   * der App sieht das aus, als brauche der Server ewig; tatsächlich antwortet
   * er in Millisekunden und weigert sich nur.
   *
   * Zwei Fenster statt einem: Das Minutenfenster deckt normales Erkunden ab
   * (vier Ausschnitte pro Sekunde sind mehr, als eine Hand schafft), das
   * Stundenfenster fängt trotzdem jemanden ab, der die Tabelle systematisch
   * abgrast. Teuer ist der Aufruf nicht — die Abfrage läuft über den
   * Geo-Index und kostet einstellige Millisekunden.
   */
  const preHandler = ipLimiter("surroundings", [
    { limit: 240, windowMs: 60 * 1000 },
    { limit: 3000, windowMs: 60 * 60 * 1000 },
  ]);
  app.get("/api/surroundings", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const { latitude, longitude, distance, mode, limit, zoom } = parsed.data;

    if (mode === "transit") {
      const key = `${latitude}|${longitude}|${distance}|${limit}|${zoom}`;
      const hit = nearbyCache.get(key);
      /**
       * Und die Antwort darf auch AUF DEM GERÄT liegen bleiben.
       *
       * Androids HTTP-Schicht (OkHttp, unter `fetch`) hält GET-Antworten mit
       * dieser Kopfzeile selbst vor — und zwar auf der Platte, also über den
       * App-Start hinaus. Der Zwischenspeicher der Abfrage-Schicht in der App
       * lebt dagegen nur in dieser Sitzung und wird nach fünf Minuten
       * aufgeräumt. Zusammen heißt das: Wer eine Ecke schon einmal gesehen hat,
       * bekommt ihre Nadeln ohne einen einzigen Netzaufruf wieder.
       *
       * Fünf Minuten, also kürzer als der Cache hier: Die Frist auf dem Gerät
       * lässt sich nicht widerrufen, die hier schon (Neustart des Servers).
       */
      reply.header("Cache-Control", "public, max-age=300");
      if (hit) return hit;
      const data = await fetchTransitNearby(latitude, longitude, distance, limit, zoom);
      nearbyCache.set(key, data);
      return data;
    }

    // AIRPORT/CRUISE werden client-seitig aus statischen Coord-Listen befüllt.
    return { markers: [], list: [] } satisfies SurroundingsResponse;
  });
}
