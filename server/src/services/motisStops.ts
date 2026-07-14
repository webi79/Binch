import { motisFetch } from "./motisClient.js";
import { cleanPlatform } from "../util/platform.js";
import { resolveMotisStopId } from "./motisPlaces.js";
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

  // Fernverkehr: die Zugnummer gehört dazu (ICE 1007) → tripShortName.
  // Nahverkehr: nur die Liniennummer (RB59/S7/U5) → routeShortName; NICHT
  // displayName, das die interne Fahrtnummer anhängt ("RB59 (90320)").
  //
  // "0" ist bei manchen Feeds ein Platzhalter-Linienname — und truthy, würde also
  // den echten Namen verdrängen und in der Abfahrtstafel als Linie „0" stehen.
  // (Echte numerische Linien wie Tram „7"/„13" bleiben gültig.) Denselben Bug
  // gab es im Such-Provider, siehe lineLabel() in providers/train/motis.ts.
  const clean = (s?: string) => {
    const v = s?.trim();
    return v && v !== "0" ? v : undefined;
  };
  const isLongDist =
    st.mode === "HIGHSPEED_RAIL" || st.mode === "LONG_DISTANCE" || st.mode === "NIGHT_RAIL";
  const line = isLongDist
    ? clean(st.tripShortName) ?? clean(st.displayName) ?? clean(st.routeShortName) ?? st.mode
    : clean(st.routeShortName) ?? clean(st.displayName) ?? clean(st.tripShortName) ?? st.mode;

  return {
    id: st.tripId || `${line}:${plannedTime}:${idx}`,
    plannedTime,
    actualTime,
    delayMinutes,
    line,
    product: modeToProduct(st.mode),
    direction: st.headsign ?? "",
    platform: cleanPlatform(p.track ?? p.scheduledTrack) ?? null,
    cancelled: !!(p.cancelled || st.cancelled || st.tripCancelled),
  };
}

/** Richtung normalisieren fürs Dedup-Matching über Feeds hinweg
 *  ("Soest, Bahnhof" ↔ "Soest Bahnhof", "Dortmund Hbf" ↔ "Dortmund Hauptbahnhof"). */
function normDir(s: string): string {
  return s.toLowerCase().replace(/hauptbahnhof/g, "hbf").replace(/[^a-z0-9]/g, "");
}

/**
 * MOTIS aggregiert mehrere GTFS-Feeds (z.B. Bundes-Feed de-DELFI + Verbund-Feed
 * de-VBN), die dieselbe Fahrt beide enthalten → jede Abfahrt doppelt (mit
 * abweichender Schreibweise + Fahrtnummer). Dedup über Linie + Abfahrtsminute +
 * normalisierte Richtung; bei Kollision gewinnt der Eintrag mit mehr Info
 * (Echtzeit > Gleis).
 */
function dedupeBoard(items: StopBoardItem[]): StopBoardItem[] {
  const info = (x: StopBoardItem) => (x.actualTime ? 2 : 0) + (x.platform ? 1 : 0);
  const byKey = new Map<string, StopBoardItem>();
  for (const it of items) {
    const line = it.line.toLowerCase().replace(/\s+/g, "");
    const key = `${line}|${it.plannedTime.slice(0, 16)}|${normDir(it.direction)}`;
    const prev = byKey.get(key);
    if (!prev || info(it) > info(prev)) byKey.set(key, it);
  }
  return [...byKey.values()].sort((a, b) => a.plannedTime.localeCompare(b.plannedTime));
}

/**
 * @param code   Binch-Location-Code — nötig für die geteilte Auflösung, die über
 *               unsere gespeicherte Koordinate disambiguiert.
 * @param label  Anzeigename des Stops (Fallback fürs Geocoding).
 * @returns StopBoardResponse oder null, wenn der Stop bei MOTIS nicht auflösbar
 *          ist (dann soll der Aufrufer sein eigenes Empty-Result liefern).
 */
export async function getMotisStopBoard(
  code: string,
  label: string,
  board: StopBoard,
  limit = 25,
): Promise<StopBoardResponse | null> {
  // Vorher stand hier `motisGeocode(label)` — das nimmt schlicht den ERSTEN
  // STOP-Treffer. Für „Köln Hbf" ist das ein Bahnsteig-Knoten aus dem
  // Referenzdaten-Feed, an dem Stadtbahn-Halte mit hängen: die Tafel zeigte
  // dann „Gleis 86" (eine Stadtbahn-Gleisnummer) und bei den echten Zügen gar
  // keins. Die geteilte Auflösung verwirft Referenz-Feeds und disambiguiert
  // über unsere gespeicherte Koordinate — dieselbe, die auch die Suche nutzt.
  const stop = await resolveMotisStopId(code, label);
  if (!stop) return null;

  // Doppelt so viele roh holen — der Feed-Dedup halbiert die Liste grob.
  const url =
    `/v6/stoptimes?stopId=${encodeURIComponent(stop.id)}` +
    `&n=${Math.min(limit * 2, 60)}${board === "arrivals" ? "&arriveBy=true" : ""}`;
  let raw: { stopTimes?: MotisStopTime[] };
  try {
    raw = (await motisFetch(url)) as { stopTimes?: MotisStopTime[] };
  } catch {
    return null;
  }

  const mapped = (raw.stopTimes ?? [])
    .map((st, i) => toItem(st, board, i))
    .filter((r): r is StopBoardItem => r !== null);
  const results = dedupeBoard(mapped).slice(0, limit);

  const now = Date.now();
  return {
    results,
    fetchedAt: new Date(now).toISOString(),
    // Kurz gültig — Echtzeit-Board, aber Cache schont Transitous.
    validUntil: new Date(now + 60_000).toISOString(),
  };
}
