import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { runSearch, type ClientResult } from "./searchService.js";
import type { TravelMode } from "../db/schema.js";
import { searchLocations } from "./locationService.js";
import { stationNameCompatible } from "../util/stationName.js";

/**
 * Ketten aus mehreren Verkehrsmitteln planen — „Werl nach Mallorca" ist eben
 * Zug, dann Bus, dann Flug.
 *
 * Die vorhandene Suche kann genau EINEN Modus zwischen ZWEI Orten. Für einen
 * Ort ohne Flughafen endet sie damit im Nichts, obwohl die Reise selbst völlig
 * gewöhnlich ist. Dieser Planer setzt die Kette aus den vorhandenen Teilen
 * zusammen, statt eine zweite Suchmaschine daneben zu stellen.
 *
 * # Sparsamkeit ist hier keine Feinheit, sondern die Vorgabe
 *
 * Jede Teilsuche geht an echte Anbieter, und db-vendo verträgt rund 60
 * Anfragen pro Minute und IP — ein Kontingent, das sich der Planer mit der
 * normalen Suche und den Abfahrtstafeln teilt. Ein naiver Ansatz („alle
 * Flughafen-Paare durchprobieren") wäre bei je drei Kandidaten schon neun
 * Flugsuchen für EINE Frage.
 *
 * Der Ablauf ist deshalb bewusst seriell und bricht früh ab:
 *
 *  1. Beide Enden EINMAL auflösen (nur Datenbank, kostet nichts).
 *  2. Luftlinie messen. Unter {@link GROUND_ONLY_KM} gibt es gar keinen Flug —
 *     eine einzige Bodensuche, fertig.
 *  3. Sonst: Flug ZUERST. Findet sich keiner, sind die Zubringer ohnehin
 *     wertlos und werden nie gesucht.
 *  4. Erst danach die beiden Zubringer, und nur wenn der Ort nicht selbst schon
 *     der Flughafen ist.
 *
 * Das sind im Regelfall drei Anfragen für eine vollständige Kette; im
 * schlechtesten Fall fünf.
 */

/** Unterhalb dieser Luftlinie lohnt kein Flug — Boden ist Tür-zu-Tür schneller. */
const GROUND_ONLY_KM = 700;

/** Ab hier braucht es einen Zubringer; darunter ist der Flughafen „vor Ort". */
const ACCESS_NEEDED_KM = 12;

/**
 * Mindest-Umsteigezeit am Abflughafen.
 *
 * Nicht geraten: Das ist die übliche Empfehlung für innereuropäische Flüge
 * (zwei Stunden vor Abflug am Schalter). Wer knapper plant, verpasst bei einer
 * einzigen Zugverspätung den Flug — und anders als beim Umstieg innerhalb einer
 * Bahnfahrt gibt es dafür keine Ersatzbeförderung.
 */
const CONNECT_BEFORE_FLIGHT_MIN = 120;

/** Nach der Landung: Aussteigen, Gepäck, Weg zum Bahnsteig. */
const CONNECT_AFTER_FLIGHT_MIN = 60;

/** Wie viele Flughäfen je Ende überhaupt in Frage kommen. */
const AIRPORT_CANDIDATES = 3;

/** Wie weit vor der nötigen Ankunft das Suchfenster des Zubringers beginnt. */
const ACCESS_WINDOW_MIN = 260;

/**
 * Obergrenze für den Hauptlauf.
 *
 * Nicht willkürlich: Ohne sie stand für „Werl nach Toledo" eine Kette im Plan,
 * deren Flug am 12. um 14 Uhr abflog und am 14. um 18:45 landete — 52 Stunden
 * mit zwei Umstiegen, der EINZIGE Treffer, den der Anbieter für die Strecke
 * hatte. Als Suchergebnis mag das durchgehen, als vorgeschlagene Reise nicht:
 * Der Plan sah vollständig aus und die Gesamtdauer las sich als „59 Stunden",
 * ohne dass irgendwo stand, dass das keine sinnvolle Verbindung ist.
 *
 * Wird die Grenze gerissen, gilt das Paar als erfolglos und der Planer geht zum
 * nächsten Flughafen weiter. Bleibt gar nichts übrig, sagt er das — und Bo kann
 * einen anderen Tag oder einen größeren Startflughafen vorschlagen.
 */
const MAX_MAIN_LEG_HOURS = 24;

/** Obergrenze für Flugsuchen pro Anfrage — siehe Sparsamkeit oben. */
const MAX_FLIGHT_TRIES = 3;

export interface PlanEndpoint {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  latitude?: number;
  longitude?: number;
  type: string;
}

export interface PlanLeg {
  /** Zubringer zum Flughafen, Hauptlauf, Weiterfahrt vom Flughafen. */
  role: "ACCESS" | "MAIN" | "EGRESS";
  mode: TravelMode;
  result: ClientResult;
}

export type PlanOutcome =
  | {
      status: "ok";
      legs: PlanLeg[];
      totalDurationMinutes: number;
      /** Nur gesetzt, wenn JEDES Bein einen echten Preis hat — siehe unten. */
      totalPrice?: number;
      currency: string;
      /** Beine ohne Preisangabe, im Klartext. */
      unpricedLegs: string[];
      notes: string[];
    }
  | { status: "no_result"; reason: string; notes: string[] };

/** Luftlinie in Kilometern. */
function haversineKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Flughäfen in der Nähe einer Koordinate — nach Nutzen sortiert, nicht nach
 * Entfernung.
 *
 * Der reine Abstand ist das falsche Maß. Ein kleiner Regionalflughafen 30 km vor
 * der Tür hat womöglich drei Ziele in der Woche, der große 120 km weiter fliegt
 * überallhin. Wer nach Entfernung sortiert, bekommt für „Werl nach Mallorca"
 * Paderborn statt Düsseldorf und danach die Auskunft, es gebe keinen Flug.
 *
 * Die Größenklasse steht seit dem Ausbau der Flughafenliste in `subtype`. Der
 * Abschlag ist als Umweg-Bereitschaft in Kilometern zu lesen: Für einen großen
 * Flughafen nimmt man rund 150 km Anfahrt mehr in Kauf als für einen kleinen.
 */
async function nearbyAirportsByCoord(
  lat: number,
  lng: number,
  limit: number,
): Promise<PlanEndpoint[]> {
  const distExpr = sql`6371 * acos(least(1, cos(radians(${lat})) * cos(radians(l.latitude))
        * cos(radians(l.longitude) - radians(${lng}))
      + sin(radians(${lat})) * sin(radians(l.latitude))))`;
  const rows = await db.execute(sql`
    SELECT l.code, l.label, l.city, l.country, l.latitude, l.longitude,
           ${distExpr} AS dist_km
    FROM ${locations} l
    WHERE l.type = 'FLIGHT'
      AND l.latitude IS NOT NULL
      AND ${distExpr} <= 400
    ORDER BY ${distExpr} + CASE l.subtype
        WHEN 'LARGE' THEN -150
        WHEN 'MEDIUM' THEN -50
        ELSE 0
      END ASC
    LIMIT ${limit}
  `);
  const list =
    (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  return (list as Record<string, unknown>[])
    .filter((r) => typeof r?.code === "string" && typeof r?.label === "string")
    .map((r) => ({
      code: r.code as string,
      label: r.label as string,
      city: (r.city as string | null) ?? null,
      country: (r.country as string | null) ?? null,
      latitude: r.latitude == null ? undefined : Number(r.latitude),
      longitude: r.longitude == null ? undefined : Number(r.longitude),
      type: "FLIGHT",
    }));
}

/**
 * Reise-Enden auflösen — mit Vorrang nach Art des Ortes.
 *
 * Die allgemeine Ortssuche ist auf die Auswahlliste zugeschnitten, in der der
 * Nutzer selbst entscheidet. Hier entscheidet niemand, und genau daran ist der
 * erste Durchlauf gescheitert: „Mallorca" liefert drei BUSHALTESTELLEN dieses
 * Namens, bevor „Palma de Mallorca" kommt. Blind der erste Treffer genommen,
 * flog die geplante Reise nach Barcelona.
 *
 * Für ein Reise-Ende ist die Art des Ortes das entscheidende Merkmal: Gemeint
 * ist eine Stadt oder Region, notfalls ein Flughafen — eine Bushaltestelle
 * gleichen Namens ist praktisch nie gemeint. Deshalb wird unter den besten
 * Treffern nach Art umsortiert, aber NUR unter denen, deren Name überhaupt zur
 * Anfrage passt: Ohne diese Prüfung zöge der Vorrang irgendeine Stadt nach
 * vorn, nur weil sie vom richtigen Typ ist.
 */
const ENDPOINT_TYPE_RANK: Record<string, number> = {
  // Eine Stadt ist als Reise-Ende praktisch immer das Gemeinte.
  ALL: 0,
  TRAIN: 1,
  FLIGHT: 1,
  CRUISE: 1,
  // Eine Haltestelle dagegen praktisch nie — das war der Mallorca-Fehler.
  BUS: 2,
};

export async function resolvePlanEndpoint(q: string): Promise<PlanEndpoint | null> {
  const hits = await searchLocations(q, "ALL");
  if (hits.length === 0) return null;
  const compatible = hits.filter((h) => stationNameCompatible(q, h.label) || stationNameCompatible(q, h.city));
  const pool = compatible.length > 0 ? compatible : hits.slice(0, 1);
  /**
   * Nur zwei Stufen, und der Rest bleibt, wie die Suche ihn sortiert hat.
   *
   * Ein feineres Raster war schon einmal da (FLIGHT vor TRAIN) und hat den
   * Fehler VERGRÖSSERT statt ihn zu beheben: Auf „Toledo" hatte die Datenbank
   * korrekt den spanischen Bahnhof vorn, der Vorrang zog den gleichnamigen
   * Flughafen in BRASILIEN davor. Die Sortierung der Suche ist über viele
   * Fälle abgestimmt; hier werden ausschließlich die zwei Fehlerarten
   * korrigiert, die tatsächlich beobachtet wurden.
   *
   * Die Sortierung ist stabil, gleichrangige Treffer behalten also die
   * Reihenfolge der Suche.
   */
  const best = [...pool].sort(
    (a, b) => (ENDPOINT_TYPE_RANK[a.type] ?? 1) - (ENDPOINT_TYPE_RANK[b.type] ?? 1),
  )[0];
  if (!best) return null;
  return {
    code: best.code,
    label: best.label,
    city: best.city ?? null,
    country: best.country ?? null,
    latitude: best.latitude,
    longitude: best.longitude,
    type: best.type,
  };
}

/**
 * Der Boden-Halt AM Flughafen — Bahnhof oder Haltestelle, nicht der IATA-Code.
 *
 * Ein Zubringer darf nicht auf den Flughafen-Code geschickt werden. Im ersten
 * Durchlauf lief genau das schief: „DTM" an die Zugsuche gegeben trifft eine
 * Bushaltestelle in Meckenbeuren, deren Name zufällig die drei Buchstaben
 * enthält — die geplante Anreise endete in Bretten. Die Codes leben in
 * getrennten Namensräumen, IATA und HAFAS/GTFS haben nichts miteinander zu tun.
 *
 * Gesucht wird deshalb über die LAGE: der nächste Bahn- oder Bushalt im Umkreis
 * des Flughafens. Findet sich keiner, gibt es eben keinen Zubringer — dann sagt
 * der Plan das, statt irgendwohin zu fahren.
 */
async function groundStopAtAirport(
  lat: number,
  lng: number,
): Promise<PlanEndpoint | null> {
  const distExpr = sql`6371 * acos(least(1, cos(radians(${lat})) * cos(radians(l.latitude))
        * cos(radians(l.longitude) - radians(${lng}))
      + sin(radians(${lat})) * sin(radians(l.latitude))))`;
  const rows = await db.execute(sql`
    SELECT l.code, l.label, l.city, l.country, l.latitude, l.longitude, l.type
    FROM ${locations} l
    WHERE l.type IN ('TRAIN', 'BUS')
      AND l.latitude IS NOT NULL
      AND ${distExpr} <= 4
    ORDER BY
      -- Ein Halt, der den Flughafen im Namen trägt, ist der Terminal-Halt und
      -- nicht die Landstraße nebenan.
      CASE WHEN l.label ~* '(flughafen|airport|aeroport|aeropuerto)' THEN 0 ELSE 1 END,
      CASE WHEN l.type = 'TRAIN' THEN 0 ELSE 1 END,
      ${distExpr} ASC
    LIMIT 1
  `);
  const list =
    (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
  const r = (list as Record<string, unknown>[])[0];
  if (!r || typeof r.code !== "string") return null;
  return {
    code: r.code as string,
    label: r.label as string,
    city: (r.city as string | null) ?? null,
    country: (r.country as string | null) ?? null,
    latitude: r.latitude == null ? undefined : Number(r.latitude),
    longitude: r.longitude == null ? undefined : Number(r.longitude),
    type: r.type as string,
  };
}

/** Schnellste Verbindung; bei Gleichstand die billigere mit echtem Preis. */
function pickBest(results: ClientResult[]): ClientResult | undefined {
  return [...results].sort((a, b) => {
    if (a.durationMinutes !== b.durationMinutes) {
      return a.durationMinutes - b.durationMinutes;
    }
    const pa = a.price > 0 ? a.price : Number.POSITIVE_INFINITY;
    const pb = b.price > 0 ? b.price : Number.POSITIVE_INFINITY;
    return pa - pb;
  })[0];
}

/**
 * Das späteste Bein, das noch rechtzeitig ankommt.
 *
 * Bewusst das SPÄTESTE und nicht das schnellste: Wer um 6 Uhr losfährt, um 14
 * Uhr zu fliegen, sitzt acht Stunden am Flughafen. Passt keines, bleibt es beim
 * schnellsten — dann steht in den Hinweisen, dass die Umsteigezeit knapp ist,
 * statt dass die Kette stillschweigend unmöglich wird.
 */
function pickLatestArrivingBefore(
  results: ClientResult[],
  comfortable: Date,
  hardLimit: Date,
): { leg?: ClientResult; tight: boolean } {
  const byLatest = (a: ClientResult, b: ClientResult) =>
    new Date(b.arriveTime).getTime() - new Date(a.arriveTime).getTime();
  const comfy = results
    .filter((r) => new Date(r.arriveTime).getTime() <= comfortable.getTime())
    .sort(byLatest);
  if (comfy[0]) return { leg: comfy[0], tight: false };
  // Nichts mit voller Pufferzeit — dann wenigstens etwas, das VOR dem Abflug
  // ankommt, und das ausdrücklich als knapp markiert.
  const tight = results
    .filter((r) => new Date(r.arriveTime).getTime() <= hardLimit.getTime())
    .sort(byLatest);
  if (tight[0]) return { leg: tight[0], tight: true };
  /**
   * Und sonst gar nichts.
   *
   * Hier stand ein Rückfall auf die schnellste Verbindung. Der ist falsch: Sie
   * kommt dann NACH dem Abflug an. Im ersten Durchlauf stand deshalb eine
   * Weiterfahrt im Plan, die fünfzehn Stunden vor der Landung abfuhr — als
   * Reisekette gelesen ist das schlicht unmöglich, sah aber vollständig aus.
   * Ein fehlendes Bein mit Begründung ist ehrlicher als ein erfundenes.
   */
  return { leg: undefined, tight: false };
}

/** Das erste Bein, das nach der Landung überhaupt erreichbar ist. */
function pickFirstDepartingAfter(
  results: ClientResult[],
  comfortable: Date,
  hardLimit: Date,
): { leg?: ClientResult; tight: boolean } {
  const byEarliest = (a: ClientResult, b: ClientResult) =>
    new Date(a.departTime).getTime() - new Date(b.departTime).getTime();
  const comfy = results
    .filter((r) => new Date(r.departTime).getTime() >= comfortable.getTime())
    .sort(byEarliest);
  if (comfy[0]) return { leg: comfy[0], tight: false };
  const tight = results
    .filter((r) => new Date(r.departTime).getTime() >= hardLimit.getTime())
    .sort(byEarliest);
  if (tight[0]) return { leg: tight[0], tight: true };
  // Siehe oben — lieber kein Bein als ein unmögliches.
  return { leg: undefined, tight: false };
}

interface PlanArgs {
  origin: PlanEndpoint;
  destination: PlanEndpoint;
  departDate: string;
  passengers: number;
  currency: string;
  ip?: string;
  /** Flughäfen erzwingen, damit sich zwei Ketten vergleichen lassen. */
  viaOriginAirport?: string;
  viaDestAirport?: string;
}

const SEARCH_TIMEOUT_MS = 20_000;

async function searchLeg(args: {
  origin: PlanEndpoint;
  destination: PlanEndpoint;
  mode: TravelMode;
  departDate: string;
  passengers: number;
  currency: string;
  ip?: string;
  /**
   * Wunsch-Abfahrt als UTC-ISO — verschiebt das SUCHFENSTER der Anbieter.
   *
   * Ohne das setzen die Fahrplan-Anbieter ihr Fenster an den Tagesanfang und
   * liefern rund zehn Verbindungen ab Mitternacht. Für einen Zubringer zu einem
   * Abendflug ist damit die späteste gefundene Verbindung eine vom Vormittag —
   * im ersten Durchlauf stand deshalb eine Anreise im Plan, die zehn Stunden
   * vor Abflug am Flughafen ankam. Das war kein Auswahlfehler: Die passenden
   * Verbindungen waren schlicht nie in der Antwort.
   */
  departTime?: string;
}): Promise<ClientResult[]> {
  const search = runSearch({
    origin: args.origin.code,
    destination: args.destination.code,
    originLabel: args.origin.label,
    destLabel: args.destination.label,
    departDate: args.departDate,
    departTime: args.departTime,
    passengers: args.passengers,
    currency: args.currency,
    mode: args.mode,
    ip: args.ip,
  });
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), SEARCH_TIMEOUT_MS),
  );
  const out = await Promise.race([search, timeout]).catch(() => null);
  if (out === "timeout" || out == null) return [];
  return out.results ?? [];
}

export async function planMultimodal(args: PlanArgs): Promise<PlanOutcome> {
  const notes: string[] = [];
  const { origin, destination, departDate, passengers, currency, ip } = args;

  const hasCoords =
    origin.latitude != null &&
    origin.longitude != null &&
    destination.latitude != null &&
    destination.longitude != null;

  const directKm = hasCoords
    ? haversineKm(
        origin.latitude as number,
        origin.longitude as number,
        destination.latitude as number,
        destination.longitude as number,
      )
    : Number.POSITIVE_INFINITY;

  // ── Kurze Strecke: gar kein Flug ────────────────────────────────────────
  //
  // Und das ist ausdrücklich Teil der Aufgabe. Wer „Dortmund nach Köln" fragt,
  // soll keine Kette mit Flughafen-Zubringer bekommen, nur weil der Planer
  // Ketten bauen kann.
  if (directKm <= GROUND_ONLY_KM) {
    const ground = await searchLeg({
      origin,
      destination,
      mode: "TRAIN",
      departDate,
      passengers,
      currency,
      ip,
    });
    const best = pickBest(ground);
    if (!best) {
      return {
        status: "no_result",
        reason: "no_ground_connection",
        notes: [
          `Luftlinie nur ${Math.round(directKm)} km — ein Flug lohnt hier nicht, aber es wurde auch keine Bodenverbindung gefunden.`,
        ],
      };
    }
    return {
      status: "ok",
      legs: [{ role: "MAIN", mode: "TRAIN", result: best }],
      totalDurationMinutes: best.durationMinutes,
      totalPrice: best.price > 0 ? best.price : undefined,
      currency,
      unpricedLegs: best.price > 0 ? [] : [`${origin.label} → ${destination.label}`],
      notes: [
        `Nur ${Math.round(directKm)} km Luftlinie — direkt am Boden schneller als mit Flug samt An- und Abreise.`,
      ],
    };
  }

  // ── Flughäfen wählen ────────────────────────────────────────────────────
  const originIsAirport = origin.type === "FLIGHT";
  const destIsAirport = destination.type === "FLIGHT";

  const originAirports: PlanEndpoint[] = originIsAirport
    ? [origin]
    : await nearbyAirportsByCoord(
        origin.latitude as number,
        origin.longitude as number,
        AIRPORT_CANDIDATES,
      );
  const destAirports: PlanEndpoint[] = destIsAirport
    ? [destination]
    : await nearbyAirportsByCoord(
        destination.latitude as number,
        destination.longitude as number,
        AIRPORT_CANDIDATES,
      );

  const pickForced = (list: PlanEndpoint[], forced?: string) =>
    forced ? list.filter((a) => a.code.toLowerCase() === forced.toLowerCase()) : list;
  const originPool = args.viaOriginAirport
    ? pickForced(originAirports, args.viaOriginAirport)
    : originAirports;
  const destPool = args.viaDestAirport
    ? pickForced(destAirports, args.viaDestAirport)
    : destAirports;

  const originHead = originPool[0];
  const destHead = destPool[0];
  if (!originHead || !destHead) {
    return {
      status: "no_result",
      reason: "no_airport_nearby",
      notes: ["Für mindestens eines der beiden Enden gibt es keinen Flughafen in Reichweite."],
    };
  }

  // ── Hauptlauf zuerst ────────────────────────────────────────────────────
  //
  // Ohne Flug sind die Zubringer wertlos — sie werden deshalb erst danach
  // gesucht. Die Paare werden NACHEINANDER probiert und beim ersten Treffer
  // abgebrochen; parallel wäre schneller, würde aber jedes Mal das volle
  // Kontingent verbrauchen.
  let flight: ClientResult | undefined;
  let originAirport: PlanEndpoint = originHead;
  let destAirport: PlanEndpoint = destHead;
  const pairs: [PlanEndpoint, PlanEndpoint][] = [];
  for (const o of originPool) {
    for (const d of destPool) pairs.push([o, d]);
  }
  // Beste Kombination zuerst: Die Pools sind bereits nach Nutzen sortiert.
  pairs.sort(
    (a, b) =>
      originPool.indexOf(a[0]) + destPool.indexOf(a[1]) -
      (originPool.indexOf(b[0]) + destPool.indexOf(b[1])),
  );

  for (const [o, d] of pairs.slice(0, MAX_FLIGHT_TRIES)) {
    if (o.code === d.code) continue;
    const res = await searchLeg({
      origin: o,
      destination: d,
      mode: "FLIGHT",
      departDate,
      passengers,
      currency,
      ip,
    });
    const sane = res.filter(
      (r) =>
        new Date(r.arriveTime).getTime() - new Date(r.departTime).getTime() <=
        MAX_MAIN_LEG_HOURS * 3_600_000,
    );
    if (sane.length < res.length && sane.length === 0) {
      notes.push(
        `Ab ${o.label} gibt es an dem Tag nur Verbindungen mit über ${MAX_MAIN_LEG_HOURS} Stunden Reisezeit — die habe ich übergangen.`,
      );
    }
    const best = pickBest(sane);
    if (best) {
      flight = best;
      originAirport = o;
      destAirport = d;
      break;
    }
  }

  if (!flight) {
    return {
      status: "no_result",
      reason: "no_flight",
      // Die bereits gesammelten Hinweise MIT zurückgeben: Dort steht der
      // Unterschied zwischen „es fliegt nichts" und „es fliegt etwas, aber
      // erst nach zwei Tagen" — und genau den braucht der Nutzer, um zu
      // entscheiden, ob ein anderer Tag hilft oder ein anderer Startflughafen.
      notes: [
        ...notes,
        `Kein brauchbarer Flug gefunden — geprüft wurden ${Math.min(pairs.length, MAX_FLIGHT_TRIES)} Flughafen-Kombinationen ab ${originHead.label}.`,
      ],
    };
  }

  const legs: PlanLeg[] = [];

  // ── Zubringer hin ───────────────────────────────────────────────────────
  const accessKm =
    origin.latitude != null && originAirport.latitude != null
      ? haversineKm(
          origin.latitude,
          origin.longitude as number,
          originAirport.latitude,
          originAirport.longitude as number,
        )
      : 0;

  if (!originIsAirport && accessKm > ACCESS_NEEDED_KM) {
    const stop =
      originAirport.latitude != null
        ? await groundStopAtAirport(originAirport.latitude, originAirport.longitude as number)
        : null;
    if (!stop) {
      notes.push(
        `Zum Flughafen ${originAirport.label} ist kein Bahn- oder Bushalt hinterlegt — die Anreise dorthin musst du selbst planen.`,
      );
    }
    const comfortable = new Date(
      new Date(flight.departTime).getTime() - CONNECT_BEFORE_FLIGHT_MIN * 60_000,
    );
    const hardLimit = new Date(flight.departTime);
    /**
     * Das Fenster liegt so, dass die spätesten brauchbaren Verbindungen drin
     * sind: gut vier Stunden vor dem Zeitpunkt, zu dem man am Flughafen sein
     * muss. Das deckt auch lange Anreisen ab, ohne den Anbieter zu zwingen,
     * den halben Tag auszuliefern.
     */
    const accessWindow = new Date(comfortable.getTime() - ACCESS_WINDOW_MIN * 60_000);
    const access = stop
      ? await searchLeg({
          origin,
          destination: stop,
          mode: "TRAIN",
          departDate: accessWindow.toISOString().slice(0, 10),
          departTime: accessWindow.toISOString(),
          passengers,
          currency,
          ip,
        })
      : [];
    const { leg, tight } = pickLatestArrivingBefore(access, comfortable, hardLimit);
    if (leg) {
      legs.push({ role: "ACCESS", mode: "TRAIN", result: leg });
      if (tight) {
        notes.push(
          `Die Anreise nach ${originAirport.label} kommt erst kurz vor Abflug an — hier lieber einen Tag früher anreisen oder eine frühere Verbindung nehmen.`,
        );
      }
    } else if (stop) {
      notes.push(
        `Von ${origin.label} nach ${originAirport.label} passt am Reisetag keine Verbindung, die den Flug noch erreicht — hier lohnt die Anreise am Vortag.`,
      );
    }
  }

  legs.push({ role: "MAIN", mode: "FLIGHT", result: flight });

  // ── Weiterfahrt ─────────────────────────────────────────────────────────
  const egressKm =
    destination.latitude != null && destAirport.latitude != null
      ? haversineKm(
          destination.latitude,
          destination.longitude as number,
          destAirport.latitude,
          destAirport.longitude as number,
        )
      : 0;

  if (!destIsAirport && egressKm > ACCESS_NEEDED_KM) {
    const stop =
      destAirport.latitude != null
        ? await groundStopAtAirport(destAirport.latitude, destAirport.longitude as number)
        : null;
    if (!stop) {
      notes.push(
        `Ab ${destAirport.label} ist kein Bahn- oder Bushalt hinterlegt — die Weiterfahrt musst du vor Ort klären.`,
      );
    }
    const comfortable = new Date(
      new Date(flight.arriveTime).getTime() + CONNECT_AFTER_FLIGHT_MIN * 60_000,
    );
    const hardLimit = new Date(flight.arriveTime);
    const egress = stop
      ? await searchLeg({
          origin: stop,
          destination,
          mode: "TRAIN",
          // Datum aus der ANKUNFT, nicht aus dem Abreisetag: Ein Abendflug
          // landet oft nach Mitternacht, die Weiterfahrt ist dann am Folgetag.
          departDate: comfortable.toISOString().slice(0, 10),
          departTime: comfortable.toISOString(),
          passengers,
          currency,
          ip,
        })
      : [];
    const { leg, tight } = pickFirstDepartingAfter(egress, comfortable, hardLimit);
    if (leg) {
      legs.push({ role: "EGRESS", mode: "TRAIN", result: leg });
      if (tight) {
        notes.push(
          `Für die Weiterfahrt ab ${destAirport.label} passt am Ankunftstag nichts mehr sauber — Anschluss prüfen.`,
        );
      }
    } else if (stop) {
      notes.push(
        `Ab ${destAirport.label} fährt am Ankunftstag nichts mehr nach ${destination.label} — plan hier eine Übernachtung oder einen früheren Flug ein.`,
      );
    }
  }

  // ── Summen ──────────────────────────────────────────────────────────────
  //
  // Der Preis wird NUR gebildet, wenn jedes Bein einen echten hat. Eine Summe,
  // in der ein Bein fehlt oder geschätzt ist, wäre schlimmer als gar keine:
  // Sie sieht vollständig aus. Fehlende Beine stehen deshalb einzeln benannt in
  // `unpricedLegs`, und Bo sagt sie an, statt sie aufzurunden.
  const unpricedLegs = legs
    .filter((l) => !(l.result.price > 0))
    .map((l) => `${l.result.originLabel ?? l.result.origin} → ${l.result.destLabel ?? l.result.destination}`);
  const totalPrice =
    unpricedLegs.length === 0
      ? legs.reduce((sum, l) => sum + l.result.price, 0)
      : undefined;

  // `legs` ist nie leer — der Hauptlauf wird oben bedingungslos angehängt.
  const first = legs[0] as PlanLeg;
  const last = legs[legs.length - 1] as PlanLeg;
  const totalDurationMinutes = Math.round(
    (new Date(last.result.arriveTime).getTime() -
      new Date(first.result.departTime).getTime()) /
      60_000,
  );

  return {
    status: "ok",
    legs,
    totalDurationMinutes,
    totalPrice,
    currency,
    unpricedLegs,
    notes,
  };
}
