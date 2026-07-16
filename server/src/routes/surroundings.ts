import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, isNotNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { ipLimiter } from "../util/rateLimit.js";

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
  label?: string;
}

interface LineBadge {
  id: string;
  color: string;
}

interface SurroundingsListItem {
  id: string;
  name: string;
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
      type: locations.type,
      subtype: locations.subtype,
      kinds: locations.kinds,
      hafasId: locations.hafasId,
      source: locations.source,
      latitude: locations.latitude,
      longitude: locations.longitude,
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

  // Dedup über exakt gleichen normalisierten Namen — alle Stops mit demselben
  // Namen werden zu EINEM Marker zusammengefasst. Die `kinds`-Arrays aller
  // gemergten Rows werden weiter unten vereinigt, sodass z.B. „Dortmund Barop
  // Parkhaus" am Ende kinds=["subway","bus"] hat und das Frontend beide Icons
  // in einer Multi-Mode-Pille rendert.
  const groups: Item[][] = [];
  const groupByKey = new Map<string, number>();
  for (const item of candidates) {
    const norm = normalizeName(item.row.label);
    if (!norm) {
      groups.push([item]);
      continue;
    }
    const existing = groupByKey.get(norm);
    if (existing !== undefined) {
      groups[existing]!.push(item);
    } else {
      groupByKey.set(norm, groups.length);
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

  const markers: SurroundingsMarker[] = sorted.map((s, i) => {
    const primaryKind = s.kinds[0] ?? subtypeToKind(s.canonical.row.subtype, s.canonical.row.type);
    return {
      id: s.canonical.row.code,
      type: primaryKind,
      kinds: s.kinds,
      latitude: s.canonical.lat,
      longitude: s.canonical.lng,
      // Label mitgeben damit das Frontend beim Marker-Tap sofort den
      // Stationsnamen im Detail-Sheet zeigen kann (ohne extra Roundtrip).
      label: s.canonical.row.label,
      selected: i === 0,
    };
  });

  const listItems: SurroundingsListItem[] = sorted.map((s, i) => ({
    id: s.canonical.row.code,
    name: s.canonical.row.label,
    kinds: s.kinds,
    distance: formatDistance(s.canonical.dist),
    selected: i === 0,
  }));

  return { markers, list: listItems };
}

export async function surroundingsRoutes(app: FastifyInstance) {
  // Surroundings: MOTIS/Transit-nearby — verbraucht DB-/MOTIS-Kontingent.
  const preHandler = ipLimiter("surroundings", [{ limit: 40, windowMs: 60 * 1000 }]);
  app.get("/api/surroundings", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", issues: parsed.error.flatten() });
    }
    const { latitude, longitude, distance, mode, limit, zoom } = parsed.data;

    if (mode === "transit") {
      const data = await fetchTransitNearby(latitude, longitude, distance, limit, zoom);
      return data;
    }

    // AIRPORT/CRUISE werden client-seitig aus statischen Coord-Listen befüllt.
    return { markers: [], list: [] } satisfies SurroundingsResponse;
  });
}
