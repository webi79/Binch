import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { getStopBoard, resolveHafasByCoord, type StopBoardResponse, type StopBoard } from "../services/stopInfoService.js";
import { profileForStop, isAtRegionalProfile, type HafasProfileKey } from "../services/countryProfile.js";
import { getFlightBoard } from "../services/flightInfoService.js";
import { getScheduledStopBoard } from "../services/gtfsSchedule.js";
import { getMotisStopBoard } from "../services/motisStops.js";
import { ipLimiter } from "../util/rateLimit.js";
import { AIRPORTS } from "../data/airports.js";
import tzLookup from "tz-lookup";
import { sameStopByName } from "../util/tripStopMatch.js";

/**
 * Liefert die nächsten Abfahrten/Ankünfte einer Haltestelle. Wird vom
 * Surroundings-Tab aufgerufen wenn der User auf einen Marker tippt.
 *
 * Datenquelle: self-hosted db-rest (HAFAS-Wrapper) — Echtzeit-Live-Daten mit
 * Verspätungen. Funktioniert nur für Stops mit gesetztem `hafasId` (StaDa-
 * Stationen, manche GTFS-Stops mit 7-stelliger UIC-ID).
 *
 * Für Stops ohne hafasId (typisch: lokale Bushaltestellen) liefern wir leere
 * Ergebnis-Listen → Frontend zeigt „Currently no departures".
 */

const paramsSchema = z.object({ code: z.string().min(1).max(96) });

interface StopBoardApiResponse extends StopBoardResponse {
  /**
   * Der Halt, wie die App ihn zeigt:
   *   `label`  — der offizielle Name (`display_name`, sonst die Quelle) —
   *              derselbe, den die Zeitleiste der Fahrt zeigt;
   *   `detail` — Zusatz, nur bei gleichnamigem Nachbarn („Stop RA");
   *   `tz`     — Ortszeit-Zone des Halts (IANA, aus seiner Lage). Die Zeiten
   *              der Tafel sind UTC; angezeigt werden sie in DIESER Zone,
   *              wie überall in der App — sonst stand in Oldham „16:33" auf
   *              der Tafel und „15:33" in der Zeitleiste derselben Fahrt.
   *   `servedBy` — die Zeiten stammen von einem ANDEREN, nahen Halt (siehe
   *              `servedByOther`); die App sagt das über der Liste.
   */
  stop: {
    code: string;
    label: string;
    hafasId: string | null;
    detail?: string;
    tz?: string;
    servedBy?: { name: string; distanceM: number };
  };
}

/** Zone aus der Lage — offline, ohne Abfrage. `undefined` ohne Lage. */
function zoneAt(lat: number | null | undefined, lon: number | null | undefined): string | undefined {
  if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  try {
    return tzLookup(lat, lon);
  } catch {
    return undefined;
  }
}

/** Bis hierhin ist der Halt der Quelle derselbe wie unserer, egal wie er heißt. */
const SAME_SPOT_M = 30;

/**
 * Zeigt die Tafel die Zeiten eines ANDEREN Halts? Fahrplan und MOTIS nehmen
 * ohne Namenstreffer den nächsten bedienten Halt in der Nähe. Die Vollprüfung
 * aller Tafeln (scripts/audit-boards.ts, Okt. 2026) fand so 9 912 Haltestellen,
 * deren Tafel 30–150 m entfernt einen Halt mit ganz anderem Namen zeigte —
 * „Annesley Road" mit den Bussen von „Newstead Turn". Die Zeiten bleiben
 * sichtbar (der Halt ist ja ganz nah), aber die App sagt, woher sie stammen.
 */
function servedByOther(
  stop: { label: string; latitude: unknown; longitude: unknown },
  source: StopBoardResponse["source"],
): { name: string; distanceM: number } | undefined {
  const lat = stop.latitude != null ? Number(stop.latitude) : NaN;
  const lon = stop.longitude != null ? Number(stop.longitude) : NaN;
  if (!source?.name || source.latitude == null || source.longitude == null) return undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  const rad = Math.PI / 180;
  const h = Math.sin(((source.latitude - lat) * rad) / 2) ** 2
    + Math.cos(lat * rad) * Math.cos(source.latitude * rad) * Math.sin(((source.longitude - lon) * rad) / 2) ** 2;
  const distanceM = Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(h)));
  if (distanceM <= SAME_SPOT_M || sameStopByName(stop.label, source.name)) return undefined;
  return { name: source.name, distanceM };
}

async function loadStopRow(code: string) {
  const rows = await db
    .select({
      hafasId: locations.hafasId,
      // `label` ist der volle Quellname — mit ihm gleichen Tafel, MOTIS und
      // HAFAS ab. Angezeigt wird `displayName` (siehe `loadStopBoard`).
      label: locations.label,
      displayName: locations.displayName,
      displayDetail: locations.displayDetail,
      type: locations.type,
      // kinds = welche Verkehrsmittel an diesem Stop wirklich halten
      // (Frontend-Kategorien wie "tram"/"bus"/"subway"/"train"/"ferry").
      // Wird genutzt um Departures strikt nach Stop-Profile zu filtern.
      kinds: locations.kinds,
      latitude: locations.latitude,
      longitude: locations.longitude,
      country: locations.country,
    })
    .from(locations)
    .where(eq(locations.code, code))
    .limit(1);
  return rows[0] ?? null;
}

/** Mappt ein HAFAS-Product (z.B. „regional", „tram", „bus", „suburban") auf
 *  unsere Frontend-Kind-Kategorie. Wenn das Product nicht erkannt wird (z.B.
 *  ""/null/unbekannter String): null → wir lassen's durch, lieber zu inklusiv
 *  als verloren. */
function productToKind(product: string): string | null {
  const p = product.toLowerCase();
  if (p === "tram") return "tram";
  if (p === "subway" || p === "metro" || p === "underground") return "subway";
  if (p === "bus") return "bus";
  if (p === "ferry") return "ferry";
  if (
    p === "nationalexpress" ||
    p === "national" ||
    p === "regionalexpress" ||
    p === "regional" ||
    p === "regionalbahn" ||
    p === "suburban" ||
    p === "express"
  )
    return "train";
  return null;
}

/**
 * Nur Abfahrten der Verkehrsarten, die an DIESEM Halt verkehren (`kinds`).
 *
 * HAFAS-IDs und MOTIS-Halte bündeln oft mehrere benachbarte Halte — der
 * Bus-Halt „Westtünnen Bahnhof" bekam die RB89 vom Bahnhof daneben, der
 * Bahnhof Köln Hbf die Busse vom Breslauer Platz. Unbekanntes Produkt
 * (taxi, leer, exotisches Produkt) bleibt drin — lieber zu inklusiv als
 * sichtbare Lücken. Ohne `kinds` (Altbestand/StaDa): am Bahnhof keine Busse.
 *
 * Galt bisher nur für den HAFAS-Zweig. Seit deutsche Tafeln zuerst über MOTIS
 * laufen (Kontingent, siehe unten), griff er dort praktisch nie mehr.
 */
function filterToStopKinds(
  results: StopBoardResponse["results"],
  stop: { kinds: unknown; type: string | null },
): StopBoardResponse["results"] {
  const stopKinds = (stop.kinds ?? []) as string[];
  if (stopKinds.length > 0) {
    return results.filter((r) => {
      const k = productToKind(r.product ?? "");
      if (k === null) return true;
      return stopKinds.includes(k);
    });
  }
  if (stop.type === "TRAIN") {
    return results.filter((r) => {
      const p = (r.product ?? "").toLowerCase();
      return p !== "bus" && p !== "taxi";
    });
  }
  return results;
}

/** Liefert die HAFAS-ID für einen Stop. Wenn unser DB-Eintrag schon eine hat
 *  (StaDa-Stationen, 7-stellige GTFS-IDs), direkt benutzen. Sonst: Coord +
 *  Name per Profile-spezifischer Nearby-Suche auflösen.
 *  Profile: DE → dbrest, AT/PL/LU/DK → hafas-client npm.
 *
 *  WICHTIG für AT-Verbund-Profile (vor/vvt/svv/etc.): die haben EIGENE
 *  ID-Räume, kompatibel weder mit oebb-UICs (81xxxxx aus unserem StaDa-Import)
 *  noch mit den GTFS-Codes der Stops. Für diese Profile IGNORIEREN wir die
 *  gespeicherte hafasId und resolven IMMER per coord/name auf die Profile-
 *  interne ID — sonst kriegen wir "LOCATION: location/stop not found". */
async function resolveStopHafasId(
  stop: { hafasId: string | null; label: string; type?: string | null; latitude: string | null; longitude: string | null },
  profile: HafasProfileKey,
): Promise<string | null> {
  const skipCachedId = isAtRegionalProfile(profile);
  if (!skipCachedId && stop.hafasId) return stop.hafasId;
  if (!stop.latitude || !stop.longitude) return stop.hafasId; // wenigstens das probieren wenn keine coords da sind
  // expectedType durchreichen damit der Resolver Bus-Stops nicht an
  // benachbarte Bahnhöfe mappt (Westtünnen-Bug: Bus-Stop 30m vom Bahnhof
  // hatte Zug-Departures im Stop-Board, weil Coord-Resolver die Train-Station
  // gefunden hatte).
  const expectedType = stop.type === "BUS" || stop.type === "TRAIN" || stop.type === "ALL"
    ? stop.type
    : null;
  return resolveHafasByCoord(Number(stop.latitude), Number(stop.longitude), stop.label, profile, expectedType);
}

function emptyResponse(label: string, code: string): StopBoardApiResponse {
  const now = new Date();
  return {
    results: [],
    fetchedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 60_000).toISOString(),
    stop: { code, label, hafasId: null },
  };
}

/**
 * Fallback-Board aus MOTIS (offene GTFS-Daten + Echtzeit, kein DB-Kontakt).
 * Greift, wenn der reguläre HAFAS/dbrest-Weg nichts liefert — insb. während DB
 * db-vendo-client extern blockt. Liefert bei MOTIS-Fehltreffer das leere Result.
 */
async function motisFallback(
  label: string,
  code: string,
  hafasId: string | null,
  board: StopBoard,
  stop: { kinds: unknown; type: string | null },
): Promise<StopBoardApiResponse> {
  try {
    const motis = await getMotisStopBoard(code, label, board);
    if (motis && motis.results.length > 0) {
      return { ...motis, results: filterToStopKinds(motis.results, stop), stop: { code, label, hafasId } };
    }
  } catch {
    /* fällt unten auf empty */
  }
  return emptyResponse(label, code);
}

/** Verarbeitet `airport:IATA`-Codes: holt Flugdaten via AeroDataBox. Liefert
 *  null wenn der Code kein Airport-Code ist (Fallback auf Train-Logik). */
async function tryFlightBoard(code: string, board: StopBoard): Promise<StopBoardApiResponse | null> {
  const match = /^airport:([A-Z0-9]{3,4})$/i.exec(code);
  if (!match) return null;
  const iata = match[1]!.toUpperCase();
  const airport = AIRPORTS.find((a) => a.iata === iata);
  const tz = zoneAt(airport?.latitude, airport?.longitude);
  try {
    const data = await getFlightBoard(iata, board);
    return {
      ...data,
      stop: { code, label: `IATA ${iata}`, hafasId: null, ...(tz ? { tz } : {}) },
    } satisfies StopBoardApiResponse;
  } catch (err) {
    // Bei Provider-Fehler/Quota → leere Liste, kein 500.
    const empty = emptyResponse(`IATA ${iata}`, code);
    return { ...empty, stop: { ...empty.stop, ...(tz ? { tz } : {}) } };
  }
}

/**
 * Eine Abfahrts-/Ankunftstafel laden — die EINE Stelle dafür.
 *
 * Stand bisher als Rückruf in der Route und war damit nur über HTTP
 * erreichbar. Der Chat-Agent brauchte sie aber ebenfalls: Ohne die echten
 * Daten kann Bo „wann fährt der nächste Zug" nicht beantworten, er konnte nur
 * eine Karte einblenden und den Nutzer selbst lesen lassen.
 *
 * Wichtig fürs Kontingent: Wer hier lädt, reicht das Ergebnis an den Client
 * durch, statt ihn ein zweites Mal holen zu lassen. Unterm Strich bleibt es
 * bei EINER Abfrage nach oben — und das DB-Kontingent von 60/min gehört
 * weiterhin der Suche, nicht den Tafeln.
 *
 * @returns null, wenn es den Halt nicht gibt.
 */
export async function loadStopBoard(
  code: string,
  board: StopBoard,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<StopBoardApiResponse | null> {
  // Airport-Codes: direkter AeroDataBox-Lookup, kein DB-Row nötig.
  // (Pattern: `airport:IATA` — Legacy-Format aus dem alten Airport-Suchindex.)
  const flight = await tryFlightBoard(code, board);
  if (flight) return flight;

  const stop = await loadStopRow(code);
  if (!stop) return null;
  const { source, ...data } = await boardForStop(code, stop, board, log);
  const tz = zoneAt(
    stop.latitude != null ? Number(stop.latitude) : null,
    stop.longitude != null ? Number(stop.longitude) : null,
  );
  const servedBy = servedByOther(stop, source);
  return {
    ...data,
    stop: {
      ...data.stop,
      label: stop.displayName ?? stop.label,
      ...(stop.displayDetail ? { detail: stop.displayDetail } : {}),
      ...(tz ? { tz } : {}),
      ...(servedBy ? { servedBy } : {}),
    },
  };
}

/**
 * Die Tafel eines Halts aus der Tabelle — alle Abgleiche über den VOLLEN
 * Quellnamen (`stop.label`); Anzeigename, Zusatz und Zone setzt der Aufrufer.
 */
async function boardForStop(
  code: string,
  stop: NonNullable<Awaited<ReturnType<typeof loadStopRow>>>,
  board: StopBoard,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<StopBoardApiResponse> {
  // FLIGHT-Typ-Locations sind Airports in der DB mit reinem IATA-Code
  // (z.B. „AMS", „BER", „CDG") — kein `airport:`-Prefix. tryFlightBoard
  // hat den nicht erkannt, jetzt wo wir den Stop-Typ kennen können wir
  // direkt die Flight-API aufrufen. Code IST der IATA.
  if (stop.type === "FLIGHT") {
    try {
      const data = await getFlightBoard(code, board);
      return {
        ...data,
        stop: { code: code, label: stop.label, hafasId: null },
      } satisfies StopBoardApiResponse;
    } catch (err) {
      log?.warn({ err, code: code }, `flight ${board} upstream failed`);
      return emptyResponse(stop.label, code);
    }
  }

  // GTFS-Schedule-Fallback ZUERST: für Länder ohne HAFAS-Profile (NL/FR/IT/
  // ES/CZ/BE/HU/SK/UK/PT) haben wir den offiziellen GTFS-Feed lokal in der
  // Datenbank und können daraus planmäßige Departures liefern. Wenn der
  // Feed für das Land nicht importiert ist, returnt das `null` und wir
  // fallen auf den HAFAS-Pfad zurück.
  const scheduled = await getScheduledStopBoard({
    stopCode: code,
    country: stop.country,
    board,
    latitude: stop.latitude != null ? Number(stop.latitude) : null,
    longitude: stop.longitude != null ? Number(stop.longitude) : null,
    // Name und Verkehrsarten: Ohne sie nahm der Koordinaten-Abgleich den
    // nächsten GTFS-Halt egal welcher Art — Bushaltestellen bekamen U-Bahn-,
    // Bahnhöfe Bus-Tafeln (siehe gtfsSchedule.ts, `coordLookup`).
    label: stop.label,
    type: stop.type,
    kinds: (stop.kinds ?? null) as string[] | null,
  });
  if (scheduled) {
    return {
      ...scheduled,
      stop: { code: code, label: stop.label, hafasId: stop.hafasId },
    } satisfies StopBoardApiResponse;
  }

  // Country-Routing: ÖPNV-Coverage hängt am richtigen HAFAS-Profile.
  // DE → dbrest (Live-Daten, bewährt). AT/PL/LU/DK → hafas-client npm
  // in-process. Stops aus nicht-unterstützten Ländern (CH/NL/FR/CZ/...)
  // bekommen ein leeres Result statt eines 500 — der User sieht
  // „Keine Abfahrten" statt einer Fehlermeldung.
  // Lat/Lon mit reichen: brauchen wir für AT-Bundesland-Routing (Verbund-
  // Profile vor/vvt/svv/stv/etc.) — sonst landet alles auf oebb das nur in
  // Wien Bus/Tram-Daten hat.
  const profile = profileForStop({
    code: code,
    country: stop.country,
    latitude: stop.latitude != null ? Number(stop.latitude) : null,
    longitude: stop.longitude != null ? Number(stop.longitude) : null,
  });
  if (!profile) {
    // Kein HAFAS-Profil (CH/NL/FR/…) → MOTIS deckt diese Länder via GTFS ab.
    return motisFallback(stop.label, code, stop.hafasId, board, stop);
  }

  // Deutsche Stops: MOTIS ZUERST, DB nur als Rückfall.
  //
  // DB lässt uns pro IP nur ~60 req/min. Die Tafeln sind der Volumentreiber
  // (die Umgebungs-/Kartenansicht fragt viele Stops auf einmal), die SUCHE ist
  // der wertvolle Verbraucher — dort liefert DB Preise, echte Gleise und echte
  // Zugnamen, die MOTIS prinzipbedingt nicht hat. Also gehört das Kontingent
  // der Suche, nicht den Tafeln.
  //
  // Bis heute landeten die Tafeln nur DESHALB auf MOTIS, weil dbrest geblockt
  // war und der DB-Versuch immer ins Leere lief. Seit der Sidecar wieder
  // antwortet (TLS-Cipher-Fix, siehe docker-compose.yml) würde die alte
  // Reihenfolge „DB zuerst" das Kontingent sofort leer fahren. Darum hier
  // explizit gedreht — MOTIS ist unlimitiert und self-hostbar.
  //
  // Preis dafür: In DE fehlen auf den Tafeln öfter Gleise (DELFI meldet für
  // Köln Hbf „Gleis 85-91" statt 1-11 → wir verwerfen solche Werte lieber,
  // siehe util/platform.ts). DB bleibt der Rückfall, wenn MOTIS nichts hat.
  if (profile === "db") {
    const motis = await getMotisStopBoard(code, stop.label, board).catch(() => null);
    if (motis && motis.results.length > 0) {
      // Gefiltert wie der HAFAS-Zweig. Bleibt danach NICHTS übrig, trotzdem
      // hier enden (leere Tafel) und nicht zur DB weiterreichen: MOTIS hat den
      // Halt gefunden, er hat nur gerade keine Abfahrt dieser Verkehrsart —
      // eine DB-Anfrage ginge nur aufs Kontingent der Suche.
      return {
        ...motis,
        results: filterToStopKinds(motis.results, stop),
        stop: { code: code, label: stop.label, hafasId: stop.hafasId },
      };
    }
  }

  const resolvedId = await resolveStopHafasId(stop, profile);
  if (!resolvedId) {
    return motisFallback(stop.label, code, stop.hafasId, board, stop);
  }
  try {
    const data = await getStopBoard(resolvedId, board, profile);
    // Product-Filter passend zum Stop-Typ.
    // HAFAS-Stops aggregieren oft mehrere Verkehrsmittel pro ID — z.B. der
    // Bus-Stop „Westtünnen Bahnhof" liefert RB89-Train-Departures vom
    // benachbarten Bahnhof mit. Bus-Stop → nur Bus/Taxi/Ferry zeigen.
    // Train-Stop → keine reinen Bus-Lines (die kommen vom Bus-Stop nebenan).
    // ALL/Unbekannt → unverändert.
    // Filter auf Basis von stop.kinds. HAFAS-IDs aggregieren oft mehrere
    // nahegelegene Stops (Tram-Haltestelle + 50m daneben Bus-Stop bekommen
    // manchmal dieselbe Stop-ID). Wir wollen aber NUR die Departures
    // zeigen die zu DIESEM Stop-Eintrag passen — bei einer reinen Tram-
    // Station (kinds=["tram"]) keine Busse.
    const results = filterToStopKinds(data.results, stop);
    // dbrest/HAFAS lieferte nichts (z.B. DB-OPS_BLOCK) → MOTIS-Fallback.
    if (results.length === 0) {
      return motisFallback(stop.label, code, stop.hafasId, board, stop);
    }
    return {
      ...data,
      results,
      stop: { code: code, label: stop.label, hafasId: resolvedId },
    } satisfies StopBoardApiResponse;
  } catch (err) {
    log?.warn({ err, code: code }, `${board} upstream failed → MOTIS-Fallback`);
    return motisFallback(stop.label, code, stop.hafasId, board, stop);
  }
  }

export async function stopsRoutes(app: FastifyInstance) {
  // Abfahrtstafeln: db-vendo/MOTIS — das DB-60/min-Kontingent hängt hier dran.
  const preHandler = ipLimiter("stops", [{ limit: 60, windowMs: 60 * 1000 }]);
  async function handle(req: FastifyRequest, reply: FastifyReply, board: StopBoard) {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const data = await loadStopBoard(parsed.data.code, board, req.log);
    if (!data) return reply.code(404).send({ error: "Stop not found" });
    return data;
  }

  app.get("/api/stops/:code/departures", { preHandler }, (req, reply) => handle(req, reply, "departures"));
  app.get("/api/stops/:code/arrivals", { preHandler }, (req, reply) => handle(req, reply, "arrivals"));
}
