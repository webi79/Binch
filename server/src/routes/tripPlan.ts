import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { AIRPORTS, type AirportSeed } from "../data/airports.js";
import { EXPENSIVE_IP_CEILING_FACTOR, ipLimiter } from "../util/rateLimit.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { sameCityAnyLanguage as sameCity } from "../util/stationName.js";
import { landRegion, sameLandmass } from "../util/landRegion.js";

/**
 * „Von hier in diese Stadt" — der Vorlauf fürs Stadt-Blatt auf der Karte.
 *
 * Tippt man auf der Karte eine Stadt an, will die App Zug, Bus und Flug dorthin
 * anbieten — von der AKTUELLEN Position aus, nie umgekehrt. Dieser Endpunkt
 * beantwortet vorab, ohne einen einzigen Anbieter zu fragen:
 *
 *   1. Ist das Verkehrsmittel für diese Strecke überhaupt sinnvoll? Kein Zug von
 *      Europa nach Australien, kein Flug in die Nachbarstadt.
 *   2. Wenn ja: von welcher Station nach welcher? Die Suche selbst braucht
 *      Stationen, keine Koordinaten.
 *
 * Gesucht wird danach über die bestehenden Such-Endpunkte — und nur für das
 * gewählte Verkehrsmittel. Das DB-Kontingent (~60 Anfragen/min) gehört der
 * Suche; ein Vorab-Durchlauf über alle drei Arten würde es verdreifachen.
 *
 * DIE STATIONEN KOMMEN ÜBER DIE KOORDINATE, nicht über den Namen. Ein Stadtname
 * blind in eine Ortssuche gesteckt ist die gefährlichste Fehlerklasse, die wir
 * haben (siehe util/stationName.ts: „Berlin ZOB" → Mannheim). Hier liegt die
 * Koordinate der angetippten Beschriftung vor — gewählt wird in ihrem Umkreis,
 * der Name gibt nur den Ausschlag zwischen nahen Kandidaten.
 */

/**
 * Start und Ziel — je als Lage (Standort, angetippte Stadt) ODER als Kennung
 * eines Ortes, den man in der Such-Slide über dem Stadt-Blatt gewählt hat
 * (`fromCode`/`toCode`). Eine Kennung gewinnt: Wer dort ein neues Ziel wählt,
 * meint es für ALLE Verkehrsmittel, und jedes wird dafür neu geprüft
 * (Bahnhof in der Nähe, Flughafen, zu nah zum Fliegen …).
 */
const querySchema = z
  .object({
    fromLat: z.coerce.number().min(-90).max(90).optional(),
    fromLng: z.coerce.number().min(-180).max(180).optional(),
    fromCode: z.string().min(1).max(80).optional(),
    /** Beschriftung zur Kennung — Rückfall, wenn die Kennung nicht in der Tabelle steht. */
    fromLabel: z.string().min(1).max(120).optional(),
    toLat: z.coerce.number().min(-90).max(90).optional(),
    toLng: z.coerce.number().min(-180).max(180).optional(),
    toName: z.string().min(1).max(120).optional(),
    toCode: z.string().min(1).max(80).optional(),
    toLabel: z.string().min(1).max(120).optional(),
  })
  .refine((q) => q.fromCode != null || (q.fromLat != null && q.fromLng != null), {
    message: "from",
  })
  .refine(
    (q) => q.toCode != null || (q.toLat != null && q.toLng != null && q.toName != null),
    { message: "to" },
  );

/** Aufgelöster Start bzw. Ziel — Lage und der Name, nach dem Stationen gesucht werden. */
interface PlanPoint {
  latitude: number;
  longitude: number;
  name: string;
}

/** Gleiche Grenzen wie die Suche — der Endpunkt steht vor jeder Stadt-Suche. */
const LIMITS = [
  { limit: 30, windowMs: 60 * 1000 },
  { limit: 300, windowMs: 60 * 60 * 1000 },
];

/**
 * Die Schwellen. Absichtlich wenige und runde Zahlen — sie sollen nur das
 * Unsinnige aussortieren; alles Grenzwertige entscheiden die Anbieter.
 */
/** Darunter ist man schon da — keine Reise. */
const SAME_PLACE_KM = 3;
/** Darunter fliegt niemand: Kurzstrecken wie Hamburg–Berlin (255 km) haben
 *  keinen Linienflug mehr, gesucht würden nur Umsteigeflüge über ein Drehkreuz. */
const FLIGHT_MIN_KM = 200;
/** Darüber ist es keine Zug- oder Busreise mehr, auch auf demselben Kontinent. */
const GROUND_MAX_KM = 3000;
/** Umkreis für den Start-Bahnhof bzw. die Start-Haltestelle. */
const ORIGIN_RADIUS_KM = 25;
/** Umkreis um die angetippte Stadt für die Ziel-Station. */
const DEST_RADIUS_KM = 15;
/**
 * Wie nah eine kuratierte Stadt sein muss, um als BUS-START zu gelten: Man muss
 * in ihr sein. Die nächste kuratierte Stadt liegt sonst leicht 20 km weg (von
 * Werl aus Iserlohn) — „ab meinem Standort" wäre dann gelogen.
 */
const BUS_CITY_ORIGIN_KM = 8;
/** Umkreis für Flughäfen — `nearby` lässt die Flugsuche ohnehin benachbarte zu. */
const AIRPORT_RADIUS_KM = 150;

export type ModeReason =
  | "same_place"
  | "too_close"
  | "too_far"
  | "no_land_link"
  | "no_airport"
  | "no_station";

interface PlanLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: string;
  latitude: number;
  longitude: number;
}

type ModePlan =
  | { available: true; origin: PlanLocation; destination: PlanLocation }
  | { available: false; reason: ModeReason };

export interface CityTripPlan {
  distanceKm: number;
  destination: { name: string; country: string | null };
  modes: { TRAIN: ModePlan; BUS: ModePlan; FLIGHT: ModePlan };
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Plätze, die OurAirports als großen Flughafen mit Linienverkehr führt, an
 * denen aber keine Fluggesellschaft fliegt — reine Geschäftsluftfahrt. Paris-Le
 * Bourget lag der Pariser Beschriftung am nächsten und wurde so zum Flugziel
 * „Paris"; eine Suche dorthin findet nie etwas.
 */
const NO_AIRLINE_SERVICE = new Set(["LBG"]);

/** Nur Flughäfen mit echtem Linienverkehr in nennenswerter Größe. */
const AIRLINE_AIRPORTS = AIRPORTS.filter(
  (a) => (a.size === "LARGE" || a.size === "MEDIUM") && !NO_AIRLINE_SERVICE.has(a.iata),
);

/**
 * Das LAND eines Punktes — über den nächsten Flughafen.
 *
 * Die Datenbank kennt Länder nur in Europa lückenlos; die Flughafenliste deckt
 * die ganze Welt. Für die Frage „welcher Kontinent?" reicht der nächste
 * Flughafen allemal: Wo er im Nachbarland liegt (Basel → Mulhouse), liegt das
 * Nachbarland auf demselben Kontinent.
 */
function countryAt(lat: number, lng: number): string | null {
  let best: AirportSeed | null = null;
  let bestD = Infinity;
  for (const a of AIRPORTS) {
    const d = haversineKm(lat, lng, a.latitude, a.longitude);
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  // Mitten im Ozean oder in der Antarktis ist nichts zu sagen.
  return best && bestD < 800 ? best.country : null;
}

function airportToLocation(a: AirportSeed): PlanLocation {
  return {
    code: a.iata,
    label: a.name,
    city: a.city,
    country: a.country,
    type: "FLIGHT",
    latitude: a.latitude,
    longitude: a.longitude,
  };
}

/**
 * Flughafen am Start bzw. Ziel.
 *
 * Der nächste Flughafen zu einer Stadt ist oft ein Regionalplatz, während der
 * eigentliche Flughafen ein paar Kilometer weiter liegt. Große Flughäfen
 * bekommen deshalb 25 km Vorsprung, und am Ziel einer, der die Stadt im Namen
 * oder als Ort trägt, weitere 15 km. Die Größe wiegt schwerer als der Name:
 * Für Paris führen drei Plätze „Paris" — mit dem Namen vorn gewann Le Bourget,
 * ein Geschäftsflughafen.
 */
function pickAirport(lat: number, lng: number, cityName?: string): AirportSeed | null {
  let best: AirportSeed | null = null;
  let bestScore = Infinity;
  for (const a of AIRLINE_AIRPORTS) {
    const d = haversineKm(lat, lng, a.latitude, a.longitude);
    if (d > AIRPORT_RADIUS_KM) continue;
    let score = d;
    if (a.size === "LARGE") score -= 25;
    if (cityName && (sameCity(cityName, a.city) || sameCity(cityName, a.name))) score -= 15;
    if (score < bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

type Row = {
  code: string;
  /** Voller Quellname — für die Namensabgleiche unten. */
  label: string;
  /** Offizieller Anzeigename, falls abweichend (siehe `rowToLocation`). */
  displayName: string | null;
  city: string | null;
  country: string | null;
  type: string;
  subtype: string | null;
  hafasId: string | null;
  latitude: string | null;
  longitude: string | null;
};

/** Kandidaten im Umkreis — dasselbe Rechteck-Vorfilter wie routes/surroundings.ts. */
async function nearby(
  lat: number,
  lng: number,
  radiusKm: number,
  where: ReturnType<typeof and> | ReturnType<typeof eq>,
  limit: number,
): Promise<Array<Row & { d: number }>> {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      displayName: locations.displayName,
      city: locations.city,
      country: locations.country,
      type: locations.type,
      subtype: locations.subtype,
      hafasId: locations.hafasId,
      latitude: locations.latitude,
      longitude: locations.longitude,
    })
    .from(locations)
    .where(
      and(
        isNotNull(locations.latitude),
        isNotNull(locations.longitude),
        gte(locations.latitude, String(lat - latDelta)),
        lte(locations.latitude, String(lat + latDelta)),
        gte(locations.longitude, String(lng - lngDelta)),
        lte(locations.longitude, String(lng + lngDelta)),
        where,
      ),
    )
    .orderBy(
      sql`(${locations.latitude} - ${lat})*(${locations.latitude} - ${lat}) + (${locations.longitude} - ${lng})*(${locations.longitude} - ${lng}) ASC`,
    )
    .limit(limit);
  return rows
    .map((r) => ({
      ...r,
      d: haversineKm(lat, lng, Number(r.latitude), Number(r.longitude)),
    }))
    .filter((r) => r.d <= radiusKm);
}

function rowToLocation(r: Row): PlanLocation {
  return {
    code: r.code,
    label: r.displayName ?? r.label,
    city: r.city,
    country: r.country,
    type: r.type,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
  };
}

/**
 * Hauptbahnhof am Namen erkannt — in den Schreibweisen der Länder, die das Netz
 * abdeckt. Wortgrenzen, damit „Centralstraße" nicht zählt.
 */
const MAIN_STATION =
  /(\bhbf\b|hauptbahnhof|\bcentraal\b|\bcentrale\b|\bcentral\b|\bg[łl][oó]wny\b|hlavn[ií] n[aá]dra[zž][ií]|\btermini\b)/i;

/** Bahnhöfe — Straßenbahn und U-Bahn zählen nicht, dort fährt kein Zug ab. */
const RAIL = and(
  eq(locations.type, "TRAIN"),
  inArray(locations.subtype, ["LONG_DISTANCE", "REGIONAL", "SUBURBAN"]),
);

/**
 * Start-Bahnhof: der NÄCHSTE — so, wie man von hier aus losginge.
 *
 * Ein Bahnhof mit HAFAS-Kennung bekommt 500 m Vorsprung: Mit ihr kann die
 * DB-Suche direkt rechnen, ohne die Station erst nachzuschlagen. Derselbe
 * Bahnhof steht oft zweimal in der Tabelle (StaDa und GTFS, 30–100 m Versatz).
 */
async function originStation(lat: number, lng: number): Promise<PlanLocation | null> {
  const rows = await nearby(lat, lng, ORIGIN_RADIUS_KM, RAIL, 30);
  let best: (typeof rows)[number] | null = null;
  let bestScore = Infinity;
  for (const r of rows) {
    const score = r.d - (r.hafasId ? 0.5 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best ? rowToLocation(best) : null;
}

/**
 * Ziel-Bahnhof: der Bahnhof DER STADT, nicht irgendeiner in ihrer Nähe.
 *
 * Um die Beschriftung einer Großstadt liegen Dutzende Halte; der nächste zur
 * Beschriftung ist selten der, an dem man ankommen will. Nachgesehen in
 * Lissabon: Die OSM-Daten führen dort die Standseilbahnen („Lavra", „Bica",
 * „Glória") als Regionalbahn, und die nächste zur Beschriftung war genau so eine.
 *
 * Deshalb zuerst der NAME: Tragen Stationen im Umkreis den Stadtnamen („Lisboa
 * Santa Apolónia", „Hamburg Hbf"), kommen nur sie in Frage. Unter ihnen
 * entscheidet die Entfernung, mit Vorsprung für einen HAUPTBAHNHOF (3 km, am
 * Namen erkannt — das Fernverkehrs-Merkmal der Tabelle ist selten gesetzt, in
 * München gewann ohne das der Marienplatz), für Fernverkehr (4 km) und für
 * Stationen mit HAFAS-Kennung (2 km) — die kennt das DB-Netz, und über sie
 * rechnet die Suche ohne Umweg. Trägt keine den Namen (kleine Orte heißen
 * anders als ihr Bahnhof), gilt dieselbe Wertung über alle.
 */
async function destinationStation(
  lat: number,
  lng: number,
  cityName: string,
): Promise<PlanLocation | null> {
  const rows = await nearby(lat, lng, DEST_RADIUS_KM, RAIL, 80);
  const named = rows.filter((r) => sameCity(cityName, r.label) || sameCity(cityName, r.city));
  /**
   * KEIN BAHNHOF MIT DEM NAMEN DER STADT → ihre zentrale Haltestelle.
   *
   * Hier wurde bisher über ALLE Bahnhöfe im Umkreis gewertet. Hat eine Stadt
   * gar keinen (Laubach in Hessen — die Strecke ist seit Jahrzehnten still),
   * gewann der beste in 15 km, und die Suche führte nach Grünberg (Oberhess).
   * Gemeldet als „ich tippe auf Laubach, gesucht wird nach Grünberg".
   *
   * Die Stadt hat aber Haltestellen, und die DB-Suche rechnet auch dorthin —
   * den Bus vom Bahnhof ins Zentrum hängt sie selbst an, so wie bahn.de bei
   * der Eingabe „Laubach". Erst wenn es auch keine gibt, bleibt der nächste
   * Bahnhof.
   */
  /**
   * NUR, wenn in der Nähe auch kein brauchbarer Bahnhof liegt (5 km, mit
   * DB-Kennung oder Fernverkehr). Sonst hieße eine Stadt, deren Bahnhof
   * anders heißt als sie, plötzlich „Bushaltestelle am Markt" — bei Prag
   * über den englischen Namen „Prague" genau so passiert.
   */
  const usableRailNearby = rows.some(
    (r) => r.d <= CENTRAL_STOP_RAIL_KM && (r.hafasId != null || r.subtype === "LONG_DISTANCE"),
  );
  if (named.length === 0 && !usableRailNearby) {
    const stop = await centralStop(lat, lng, cityName);
    if (stop) return stop;
  }
  const pool = named.length > 0 ? named : rows;
  let best: (typeof rows)[number] | null = null;
  let bestScore = Infinity;
  for (const r of pool) {
    let score = r.d;
    if (r.subtype === "LONG_DISTANCE") score -= 4;
    if (MAIN_STATION.test(r.label)) score -= 3;
    if (r.hafasId) score -= 2;
    /**
     * Die offiziellen DB-Stammdaten (StaDa, `sta:`) vor den Fahrplan-Feeds:
     * Dort ist die Gattung teils falsch gesetzt — in Frankfurt (Oder) trug ein
     * Nahverkehrshalt „Fernverkehr" und schlug den Bahnhof der Stadt.
     */
    if (r.code.startsWith("sta:")) score -= 1;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best ? rowToLocation(best) : null;
}

/** Wie weit vom Namen der Stadt ihre zentrale Haltestelle höchstens liegt. */
const CENTRAL_STOP_KM = 3;
/** Liegt ein brauchbarer Bahnhof so nah, ist er das Ziel — keine Haltestelle. */
const CENTRAL_STOP_RAIL_KM = 5;

/**
 * Knoten im Namen einer Haltestelle — Busbahnhof, ZOB, Bahnhof(-platz),
 * Markt(-platz), Rathaus, Mitte/Zentrum. Dort halten die meisten Linien.
 */
const HUB_STOP = /(busbahnhof|\bzob\b|bahnhof|\bbf\b|markt|rathaus|\bmitte\b|zentrum|centrum)/i;

/**
 * Die zentrale Haltestelle einer Stadt OHNE Bahnhof.
 *
 * Nur Halte, die den Namen der Stadt tragen (dieselbe Namensprüfung wie oben —
 * blind die nächste nehmen führte schon nach Mannheim statt Berlin ZOB), und
 * nur nah an ihrer Beschriftung: Ortsteile („Laubach-Wetterfeld") liegen
 * weiter draußen. Unter ihnen gewinnt ein Knoten (Busbahnhof, Markt, Rathaus)
 * mit gut einem halben Kilometer Vorsprung, dann die Entfernung; eine
 * HAFAS-Kennung spart der DB-Suche das Nachschlagen.
 */
async function centralStop(
  lat: number,
  lng: number,
  cityName: string,
): Promise<PlanLocation | null> {
  const rows = await nearby(
    lat,
    lng,
    CENTRAL_STOP_KM,
    inArray(locations.type, ["TRAIN", "BUS"]),
    60,
  );
  let best: (typeof rows)[number] | null = null;
  let bestScore = Infinity;
  for (const r of rows) {
    if (!sameCity(cityName, r.label) && !sameCity(cityName, r.city)) continue;
    let score = r.d;
    if (HUB_STOP.test(r.label)) score -= 0.6;
    if (r.hafasId) score -= 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best ? rowToLocation(best) : null;
}

/**
 * Bus: eine kuratierte STADT, wo es eine gibt — sonst die nächste Station.
 *
 * Die Fernbus-Anbieter (FlixBus, Busbud) kennen Städte, keine Haltestellen: Mit
 * einer Haltestellen-Kennung überspringt FlixBus die Suche ganz. Die kuratierten
 * Städte (Typ `ALL`, `DE-MUC` …) versteht jeder Bus-Anbieter. Gibt es keine in
 * der Nähe, bleibt die nächste Station — damit findet die DB-Suche immer noch
 * Regional- und Stadtbusse.
 *
 * Am Ziel muss die Stadt auch dem NAMEN nach passen: Die Kuratierte in 15 km
 * Umkreis ist sonst womöglich die Nachbarstadt.
 */
async function busPlace(
  lat: number,
  lng: number,
  radiusKm: number,
  cityName?: string,
): Promise<PlanLocation | null> {
  const cities = await nearby(lat, lng, radiusKm, eq(locations.type, "ALL"), 10);
  /**
   * Nur gegen das LABEL (sprachfest, siehe `sameCityAnyLanguage`) — nicht
   * gegen `city`: Das stammt bei kuratierten Städten aus einer
   * Rück-Geokodierung und war teils eine andere Stadt („San Sebastián" mit
   * city „Sevilla" — ein Tipp auf Sevilla fuhr mit dem Bus nach San
   * Sebastián).
   */
  const city = cityName ? cities.find((c) => sameCity(cityName, c.label)) : cities[0];
  if (city) return rowToLocation(city);
  return cityName ? destinationStation(lat, lng, cityName) : originStation(lat, lng);
}

const planCache = new BoundedTtlCache<CityTripPlan>(500, 10 * 60 * 1000);

/**
 * Ein gewählter Ort → Lage und Stadtname.
 *
 * Aus der Orts-Tabelle (Bahnhöfe, Haltestellen, kuratierte Städte), sonst aus
 * den Flughäfen (IATA-Kennung). Der NAME ist die Stadt, nicht die Station:
 * Nach ihm suchen die anderen Verkehrsmittel ihre Station (wer „Münster (Westf)
 * Hbf" wählt, meint für den Bus „Münster", für den Flug FMO).
 */
async function resolvePoint(code: string, label?: string): Promise<PlanPoint | null> {
  const cols = {
    label: locations.label,
    city: locations.city,
    type: locations.type,
    latitude: locations.latitude,
    longitude: locations.longitude,
  };
  const toPoint = (row: {
    label: string;
    city: string | null;
    type: string;
    latitude: string | null;
    longitude: string | null;
  }): PlanPoint | null =>
    row.latitude != null && row.longitude != null
      ? {
          latitude: Number(row.latitude),
          longitude: Number(row.longitude),
          /**
           * Kuratierte Städte (`ALL`): ihr NAME ist das Label („Prag").
           * `city` stammt dort aus einer Rück-Geokodierung und ist teils ein
           * Stadtteil („Nørrebro" für Kopenhagen) oder schlicht falsch. Bei
           * Bahnhöfen und Haltestellen ist `city` die Stadt aus der Quelle.
           */
          name: row.type === "ALL" ? row.label : row.city || row.label,
        }
      : null;

  const [row] = await db.select(cols).from(locations).where(eq(locations.code, code)).limit(1);
  if (row) return toPoint(row);

  /**
   * Nicht in der Tabelle — Treffer aus der Live-Ortssuche („dbrest:8000105",
   * „flix:…"). Eine DB-Nummer finden wir über die HAFAS-Kennung; sonst über
   * die BESCHRIFTUNG, aber nur bei genau einem Treffer: bei zweien („Neustadt")
   * wäre es geraten, und dann lieber ehrlich „unbekannt".
   */
  const eva = /^(?:dbrest:)?(\d{6,9})$/.exec(code)?.[1];
  if (eva) {
    const [byEva] = await db.select(cols).from(locations).where(eq(locations.hafasId, eva)).limit(1);
    if (byEva) return toPoint(byEva);
  }
  if (label) {
    const byLabel = await db.select(cols).from(locations).where(eq(locations.label, label)).limit(2);
    if (byLabel.length === 1) return toPoint(byLabel[0]!);
  }
  const iata = code.trim().toUpperCase();
  const airport = /^[A-Z]{3}$/.test(iata) ? AIRPORTS.find((a) => a.iata === iata) : undefined;
  if (airport) {
    return { latitude: airport.latitude, longitude: airport.longitude, name: airport.city };
  }
  return null;
}

async function buildPlan(
  from: PlanPoint,
  to: PlanPoint,
): Promise<CityTripPlan> {
  const { latitude: fromLat, longitude: fromLng } = from;
  const { latitude: toLat, longitude: toLng, name: toName } = to;
  const distanceKm = haversineKm(fromLat, fromLng, toLat, toLng);
  const fromCountry = countryAt(fromLat, fromLng);
  const toCountry = countryAt(toLat, toLng);
  const destination = { name: toName, country: toCountry };

  if (distanceKm < SAME_PLACE_KM) {
    const no: ModePlan = { available: false, reason: "same_place" };
    return { distanceKm, destination, modes: { TRAIN: no, BUS: no, FLIGHT: no } };
  }

  const fromRegion = landRegion(fromLat, fromLng, fromCountry);
  const toRegion = landRegion(toLat, toLng, toCountry);

  // --- Zug -----------------------------------------------------------------
  let train: ModePlan;
  if (!sameLandmass(fromRegion, toRegion)) train = { available: false, reason: "no_land_link" };
  else if (distanceKm > GROUND_MAX_KM) train = { available: false, reason: "too_far" };
  else {
    const [o, d] = await Promise.all([
      originStation(fromLat, fromLng),
      destinationStation(toLat, toLng, toName),
    ]);
    train =
      o && d && o.code !== d.code
        ? { available: true, origin: o, destination: d }
        : { available: false, reason: "no_station" };
  }

  // --- Bus -----------------------------------------------------------------
  let bus: ModePlan;
  if (!sameLandmass(fromRegion, toRegion, true)) bus = { available: false, reason: "no_land_link" };
  else if (distanceKm > GROUND_MAX_KM) bus = { available: false, reason: "too_far" };
  else {
    const [o, d] = await Promise.all([
      busPlace(fromLat, fromLng, BUS_CITY_ORIGIN_KM),
      busPlace(toLat, toLng, DEST_RADIUS_KM, toName),
    ]);
    bus =
      o && d && o.code !== d.code
        ? { available: true, origin: o, destination: d }
        : { available: false, reason: "no_station" };
  }

  // --- Flug ----------------------------------------------------------------
  let flight: ModePlan;
  if (distanceKm < FLIGHT_MIN_KM) flight = { available: false, reason: "too_close" };
  else {
    const o = pickAirport(fromLat, fromLng);
    const d = pickAirport(toLat, toLng, toName);
    flight =
      o && d && o.iata !== d.iata
        ? { available: true, origin: airportToLocation(o), destination: airportToLocation(d) }
        : { available: false, reason: "no_airport" };
  }

  return { distanceKm, destination, modes: { TRAIN: train, BUS: bus, FLIGHT: flight } };
}

export async function tripPlanRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("trip-plan", LIMITS, { ipCeilingFactor: EXPENSIVE_IP_CEILING_FACTOR });
  app.get("/api/trip-plan/city", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const q = parsed.data;
    // Auf ~100 m gerundet: Wer sich ein paar Schritte bewegt, bekommt denselben
    // Plan aus dem Zwischenspeicher — die Stationen ändern sich dabei nicht.
    // Eine gewählte Kennung ersetzt die Lage (siehe `querySchema`).
    const key = [
      q.fromCode ?? `${q.fromLat!.toFixed(3)},${q.fromLng!.toFixed(3)}`,
      q.toCode ?? `${q.toLat!.toFixed(3)},${q.toLng!.toFixed(3)},${q.toName!.toLowerCase()}`,
    ].join("|");
    const hit = planCache.get(key);
    if (hit) return hit;
    const from = q.fromCode
      ? await resolvePoint(q.fromCode, q.fromLabel)
      : { latitude: q.fromLat!, longitude: q.fromLng!, name: "" };
    const to = q.toCode
      ? await resolvePoint(q.toCode, q.toLabel)
      : { latitude: q.toLat!, longitude: q.toLng!, name: q.toName! };
    // Unbekannte Kennung: lieber ehrlich ablehnen als irgendwo planen.
    if (!from || !to) return reply.code(404).send({ error: "Unknown location" });
    const plan = await buildPlan(from, to);
    planCache.set(key, plan);
    return plan;
  });
}
