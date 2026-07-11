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
  /** Wahrer Stationsname aus der DB — falls anders als der Code-suffix. */
  stop: { code: string; label: string; hafasId: string | null };
}

async function loadStopRow(code: string) {
  const rows = await db
    .select({
      hafasId: locations.hafasId,
      label: locations.label,
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
): Promise<StopBoardApiResponse> {
  try {
    const motis = await getMotisStopBoard(label, board);
    if (motis && motis.results.length > 0) {
      return { ...motis, stop: { code, label, hafasId } };
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
  try {
    const data = await getFlightBoard(iata, board);
    return { ...data, stop: { code, label: `IATA ${iata}`, hafasId: null } } satisfies StopBoardApiResponse;
  } catch (err) {
    // Bei Provider-Fehler/Quota → leere Liste, kein 500.
    return emptyResponse(`IATA ${iata}`, code);
  }
}

export async function stopsRoutes(app: FastifyInstance) {
  async function handle(req: FastifyRequest, reply: FastifyReply, board: StopBoard) {
    const parsed = paramsSchema.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });

    // Airport-Codes: direkter AeroDataBox-Lookup, kein DB-Row nötig.
    // (Pattern: `airport:IATA` — Legacy-Format aus dem alten Airport-Suchindex.)
    const flight = await tryFlightBoard(parsed.data.code, board);
    if (flight) return flight;

    const stop = await loadStopRow(parsed.data.code);
    if (!stop) return reply.code(404).send({ error: "Stop not found" });

    // FLIGHT-Typ-Locations sind Airports in der DB mit reinem IATA-Code
    // (z.B. „AMS", „BER", „CDG") — kein `airport:`-Prefix. tryFlightBoard
    // hat den nicht erkannt, jetzt wo wir den Stop-Typ kennen können wir
    // direkt die Flight-API aufrufen. Code IST der IATA.
    if (stop.type === "FLIGHT") {
      try {
        const data = await getFlightBoard(parsed.data.code, board);
        return {
          ...data,
          stop: { code: parsed.data.code, label: stop.label, hafasId: null },
        } satisfies StopBoardApiResponse;
      } catch (err) {
        req.log.warn({ err, code: parsed.data.code }, `flight ${board} upstream failed`);
        return emptyResponse(stop.label, parsed.data.code);
      }
    }

    // GTFS-Schedule-Fallback ZUERST: für Länder ohne HAFAS-Profile (NL/FR/IT/
    // ES/CZ/BE/HU/SK/UK/PT) haben wir den offiziellen GTFS-Feed lokal in der
    // Datenbank und können daraus planmäßige Departures liefern. Wenn der
    // Feed für das Land nicht importiert ist, returnt das `null` und wir
    // fallen auf den HAFAS-Pfad zurück.
    const scheduled = await getScheduledStopBoard({
      stopCode: parsed.data.code,
      country: stop.country,
      board,
      latitude: stop.latitude != null ? Number(stop.latitude) : null,
      longitude: stop.longitude != null ? Number(stop.longitude) : null,
    });
    if (scheduled) {
      return {
        ...scheduled,
        stop: { code: parsed.data.code, label: stop.label, hafasId: stop.hafasId },
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
      code: parsed.data.code,
      country: stop.country,
      latitude: stop.latitude != null ? Number(stop.latitude) : null,
      longitude: stop.longitude != null ? Number(stop.longitude) : null,
    });
    if (!profile) {
      // Kein HAFAS-Profil (CH/NL/FR/…) → MOTIS deckt diese Länder via GTFS ab.
      return motisFallback(stop.label, parsed.data.code, stop.hafasId, board);
    }

    const resolvedId = await resolveStopHafasId(stop, profile);
    if (!resolvedId) {
      return motisFallback(stop.label, parsed.data.code, stop.hafasId, board);
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
      let results = data.results;
      const stopKinds = (stop.kinds ?? []) as string[];
      if (stopKinds.length > 0) {
        results = results.filter((r) => {
          const k = productToKind(r.product ?? "");
          // Unbekanntes Product (taxi, leer, exotisches HAFAS-Produkt):
          // durchlassen — lieber zu inklusiv als sichtbare Lücken.
          if (k === null) return true;
          return stopKinds.includes(k);
        });
      } else if (stop.type === "TRAIN") {
        // Fallback für DB-Rows ohne kinds-Info (Legacy/StaDa-only): TRAIN-
        // Stops haben sicher keine Bus/Taxi-Lines.
        results = results.filter((r) => {
          const p = (r.product ?? "").toLowerCase();
          return p !== "bus" && p !== "taxi";
        });
      }
      // dbrest/HAFAS lieferte nichts (z.B. DB-OPS_BLOCK) → MOTIS-Fallback.
      if (results.length === 0) {
        return motisFallback(stop.label, parsed.data.code, stop.hafasId, board);
      }
      return {
        ...data,
        results,
        stop: { code: parsed.data.code, label: stop.label, hafasId: resolvedId },
      } satisfies StopBoardApiResponse;
    } catch (err) {
      req.log.warn({ err, code: parsed.data.code }, `${board} upstream failed → MOTIS-Fallback`);
      return motisFallback(stop.label, parsed.data.code, stop.hafasId, board);
    }
  }

  app.get("/api/stops/:code/departures", (req, reply) => handle(req, reply, "departures"));
  app.get("/api/stops/:code/arrivals", (req, reply) => handle(req, reply, "arrivals"));
}
