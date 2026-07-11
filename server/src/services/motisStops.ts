import { motisFetch, motisGeocode } from "./motisClient.js";
import type { StopBoard, StopBoardItem, StopBoardResponse } from "./stopInfoService.js";

/**
 * Abfahrts-/Ankunftstafel aus MOTIS `/v6/stoptimes` (offene GTFS-Daten + GTFS-
 * RT-Echtzeit). Fallback für Stop-Boards, wenn der reguläre Weg (dbrest/HAFAS)
 * nichts liefert — z.B. während DB db-vendo-client extern blockt.
 *
 * Auflösung über das Label (MOTIS kennt Binchs Station-Codes nicht). Der
 * Geocode-Cache (motisClient) macht das nach dem ersten Treffer gratis.
 */

/** MOTIS-`mode` → das HAFAS-Product-Vokabular, das productToKind/das Frontend
 *  zum Farbcodieren erwartet. */
function modeToProduct(mode: string): string {
  switch (mode) {
    case "HIGHSPEED_RAIL":
      return "nationalExpress";
    case "LONG_DISTANCE":
    case "NIGHT_RAIL":
      return "national";
    case "REGIONAL_RAIL":
    case "REGIONAL_FAST_RAIL":
      return "regional";
    case "SUBURBAN":
      return "suburban";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "BUS":
    case "COACH":
      return "bus";
    case "FERRY":
      return "ferry";
    default:
      return mode.toLowerCase();
  }
}

interface MotisStopTimePlace {
  arrival?: string;
  departure?: string;
  scheduledArrival?: string;
  scheduledDeparture?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
}
interface MotisStopTime {
  place: MotisStopTimePlace;
  mode: string;
  realTime?: boolean;
  headsign?: string;
  tripId?: string;
  routeShortName?: string;
  routeLongName?: string;
  tripShortName?: string;
  displayName?: string;
  cancelled?: boolean;
  tripCancelled?: boolean;
}

function toItem(st: MotisStopTime, board: StopBoard, idx: number): StopBoardItem | null {
  const p = st.place;
  const planned = board === "departures" ? p.scheduledDeparture : p.scheduledArrival;
  const actual = board === "departures" ? p.departure : p.arrival;
  // Ohne Soll-Zeit ist der Eintrag unbrauchbar (kein Board-Row).
  if (!planned && !actual) return null;
  const plannedTime = planned ?? actual!;
  const actualTime = st.realTime && actual ? actual : null;
  const delayMinutes =
    actualTime && planned
      ? Math.round((Date.parse(actualTime) - Date.parse(planned)) / 60_000)
      : null;

  // displayName ist MOTIS' fertiges Anzeige-Label und trägt die echte LINIE
  // (S7, M8, U5, "FEX (21941)") — NICHT tripShortName, das ist die nackte
  // Fahrtnummer (7141) und für ein Abfahrts-Board falsch.
  const line =
    st.displayName || st.routeShortName || st.tripShortName || st.routeLongName || st.mode;

  return {
    id: st.tripId || `${line}:${plannedTime}:${idx}`,
    plannedTime,
    actualTime,
    delayMinutes,
    line,
    product: modeToProduct(st.mode),
    direction: st.headsign ?? "",
    platform: p.track ?? p.scheduledTrack ?? null,
    cancelled: !!(p.cancelled || st.cancelled || st.tripCancelled),
  };
}

/**
 * @param label  Anzeigename des Stops (für den MOTIS-Geocode).
 * @returns StopBoardResponse oder null, wenn der Stop bei MOTIS nicht auflösbar
 *          ist (dann soll der Aufrufer sein eigenes Empty-Result liefern).
 */
export async function getMotisStopBoard(
  label: string,
  board: StopBoard,
  limit = 25,
): Promise<StopBoardResponse | null> {
  const stop = await motisGeocode(label);
  if (!stop) return null;

  const url =
    `/v6/stoptimes?stopId=${encodeURIComponent(stop.id)}` +
    `&n=${limit}${board === "arrivals" ? "&arriveBy=true" : ""}`;
  let raw: { stopTimes?: MotisStopTime[] };
  try {
    raw = (await motisFetch(url)) as { stopTimes?: MotisStopTime[] };
  } catch {
    return null;
  }

  const results = (raw.stopTimes ?? [])
    .map((st, i) => toItem(st, board, i))
    .filter((r): r is StopBoardItem => r !== null);

  const now = Date.now();
  return {
    results,
    fetchedAt: new Date(now).toISOString(),
    // Kurz gültig — Echtzeit-Board, aber Cache schont Transitous.
    validUntil: new Date(now + 60_000).toISOString(),
  };
}
