import { motisFetch } from "./motisClient.js";
import { cleanPlatform } from "../util/platform.js";
import { resolveMotisStopId } from "./motisPlaces.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { sameStopByName } from "../util/tripStopMatch.js";
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
/** Start und Ziel der FAHRT — nicht des Halts. Siehe `direction` in `toItem`. */
interface MotisTripEnd {
  name?: string;
}
interface MotisStopTime {
  place: MotisStopTimePlace;
  /** Wo die Fahrt HERKOMMT — die Richtungsangabe einer Ankunftstafel. */
  tripFrom?: MotisTripEnd;
  /** Wohin sie fährt. Deckt sich meist mit `headsign`, ist aber gepflegter. */
  tripTo?: MotisTripEnd;
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
    /**
     * Bei ANKÜNFTEN die HERKUNFT, nicht das Ziel.
     *
     * Hier stand für beide Tafeln `headsign` — also immer das Fahrtziel. Unter
     * „Ankünfte" ist das die falsche Auskunft: Wer dort steht, wartet auf
     * jemanden und will wissen, WOHER der Zug kommt. Im gemeldeten Fall stand
     * an einer Ankunft in Werl „Soest, Bahnhof", obwohl der Zug aus Dortmund
     * kam und nach Soest weiterfuhr.
     *
     * Schlimmer noch: Die zweite Quelle derselben Tafel (db-rest) nimmt dafür
     * `provenance`, also die Herkunft. Dieselbe Zeile bedeutete damit je nach
     * antwortendem Anbieter etwas anderes — ein Unterschied, den niemand sehen
     * kann. MOTIS liefert beides mit (`tripFrom`/`tripTo`), es war nur das
     * falsche Feld gegriffen.
     */
    /**
     * `|| undefined` und nicht `??`: Ein Feld, das da ist, aber LEER, ist
     * hier kein Wert, sondern eine fehlende Angabe. `??` greift nur bei
     * `null`/`undefined` — eine leere Zeichenkette hätte die Ausweichwege
     * unten übersprungen, und in der Tafel stünde eine Zeile ohne Richtung.
     */
    direction:
      (board === "arrivals" ? st.tripFrom?.name?.trim() || undefined : undefined) ??
      (st.headsign?.trim() || undefined) ??
      (st.tripTo?.name?.trim() || undefined) ??
      "",
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
/**
 * Unsere Verkehrsarten → MOTIS-`mode` für `/v6/stoptimes`. Die Bahn einzeln:
 * „RAIL" fasst bei MOTIS die U-Bahn mit ein (München Hbf: 18 von 31).
 */
const MOTIS_MODES: Record<string, string[]> = {
  train: ["HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"],
  subway: ["SUBWAY"],
  tram: ["TRAM", "FUNICULAR", "CABLE_CAR", "AREAL_LIFT"],
  bus: ["BUS", "COACH"],
  ferry: ["FERRY"],
};

/** `mode`-Liste zu den Verkehrsarten eines Halts — null, wenn keine bekannt ist (dann alle). */
export function motisModesFor(kinds: readonly string[] | null | undefined): string | null {
  const modes = new Set<string>();
  for (const k of kinds ?? []) for (const m of MOTIS_MODES[k] ?? []) modes.add(m);
  return modes.size > 0 ? [...modes].join(",") : null;
}

/**
 * @param kinds  Verkehrsarten des Halts — MOTIS liefert dann nur diese. Ohne
 *               den Filter an der Quelle blieben an gemischten Stationen von
 *               25 Abfahrten oft eine Handvoll übrig: am U-Bahnhof München Hbf
 *               7 (U2/U4/U5/U7), weil Tram, S-Bahn und Bus den Rest füllten —
 *               U1 und U8 fehlten (Prüfung 22.10.2026).
 */
export async function getMotisStopBoard(
  code: string,
  label: string,
  board: StopBoard,
  limit = 25,
  kinds?: readonly string[] | null,
): Promise<(StopBoardResponse & { modeFiltered: boolean }) | null> {
  // Vorher stand hier `motisGeocode(label)` — das nimmt schlicht den ERSTEN
  // STOP-Treffer. Für „Köln Hbf" ist das ein Bahnsteig-Knoten aus dem
  // Referenzdaten-Feed, an dem Stadtbahn-Halte mit hängen: die Tafel zeigte
  // dann „Gleis 86" (eine Stadtbahn-Gleisnummer) und bei den echten Zügen gar
  // keins. Die geteilte Auflösung verwirft Referenz-Feeds und disambiguiert
  // über unsere gespeicherte Koordinate — dieselbe, die auch die Suche nutzt.
  const stop = await resolveMotisStopId(code, label);
  if (!stop) return null;

  /**
   * `direction=LATER` MUSS mit — sonst blättert MOTIS bei Ankünften RÜCKWÄRTS.
   *
   * DAS WAR DER FEHLER, und er sah harmlos aus: `arriveBy=true` liest sich wie
   * „gib mir Ankünfte statt Abfahrten". Es bestimmt bei `/stoptimes` aber AUCH
   * die Blätterrichtung — und die kippt damit auf „die letzten n Ereignisse VOR
   * dem Zeitpunkt". Nachgemessen an Werl, Bahnhof (15.09., 02:33 UTC):
   *
   *   n=10                      → erster Eintrag 03:15Z  (Zukunft, richtig)
   *   n=10&arriveBy=true        → erster Eintrag 14.09. 18:52Z  (VERGANGENHEIT)
   *   n=10&arriveBy=true&direction=LATER → erster Eintrag 03:15Z  (Zukunft)
   *
   * An einer kleinen Station reichen zwanzig Ereignisse rückwärts locker bis
   * zum Vortag — genau deshalb stand unter „Ankünfte" um halb fünf morgens eine
   * Ankunft um 16:11 vom Vortag, mit „0 Min" davor (der Countdown klemmt
   * negative Werte auf null).
   *
   * Ausdrücklich für BEIDE Tafeln gesetzt, obwohl Abfahrten es nicht bräuchten
   * (nachgemessen: mit und ohne identisch): Die Kopplung an `arriveBy` ist die
   * Falle. Wer sie einmal übersieht, baut sie wieder ein.
   */
  const modes = motisModesFor(kinds);
  const results = await fetchStopTimes(stop.id, modes ? `&mode=${modes}` : "", board, limit);
  if (!results) return null;
  const now = Date.now();
  return {
    results,
    fetchedAt: new Date(now).toISOString(),
    // Kurz gültig — Echtzeit-Board, aber Cache schont Transitous.
    validUntil: new Date(now + 60_000).toISOString(),
    // Der Halt, den MOTIS gewählt hat — ohne Namenstreffer der nächste.
    source: { name: stop.name, latitude: stop.lat ?? null, longitude: stop.lon ?? null },
    modeFiltered: modes != null,
  };
}

/** `/v6/stoptimes` eines Halts → Tafelzeilen; null bei MOTIS-Fehler. */
async function fetchStopTimes(
  stopId: string,
  extra: string,
  board: StopBoard,
  limit: number,
): Promise<StopBoardItem[] | null> {
  // Doppelt so viele roh holen — der Feed-Dedup halbiert die Liste grob.
  const url =
    `/v6/stoptimes?stopId=${encodeURIComponent(stopId)}` +
    `&n=${Math.min(limit * 2, 60)}&direction=LATER${extra}` +
    `${board === "arrivals" ? "&arriveBy=true" : ""}`;
  let raw: { stopTimes?: MotisStopTime[] };
  try {
    raw = (await motisFetch(url)) as { stopTimes?: MotisStopTime[] };
  } catch {
    return null;
  }
  const mapped = (raw.stopTimes ?? [])
    .map((st, i) => toItem(st, board, i))
    .filter((r): r is StopBoardItem => r !== null);
  return dedupeBoard(mapped).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tafel EINES Steigs
// ---------------------------------------------------------------------------

/**
 * So weit um den Steig zählen Abfahrten noch zu ihm. Derselbe Wert, mit dem
 * der Import gleichnamige Steige zu einem zusammenfasst (scripts/lib/
 * gtfsStands.ts): DELFI führt manche Bucht doppelt, 2–4 m nebeneinander
 * („Hörde Bf" 1:01 und 1:11).
 */
const STAND_RADIUS_M = 5;

interface MotisMapStop {
  stopId?: string;
  name?: string;
  lat?: number;
  lon?: number;
  track?: string;
}

/** Der Steig bei MOTIS: Kennung und Steig-Bezeichnung („03" → „3"). */
interface MotisStand {
  id: string;
  platform: string | null;
}

/** Steig-Code → der Steig bei MOTIS (auch „nicht gefunden"). Stabil → 24 h. */
const standIdCache = new BoundedTtlCache<MotisStand | null>(4000, 24 * 60 * 60 * 1000);

function metersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const x = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * 111_320;
  const y = (lat2 - lat1) * 110_574;
  return Math.hypot(x, y);
}

/**
 * Die MOTIS-Kennung eines Steigs — über seine LAGE. Der Fahrplan unserer
 * Steige (gtfs.de) und der von Transitous (DELFI) beschreiben dieselben
 * Masten mit denselben Koordinaten, aber anderen Nummern; `/v1/map/stops`
 * liefert alle Halte eines kleinen Ausschnitts samt Steigen
 * (`de-DELFI_de:05913:228:3:03` für Hörde Bf, Steig 03).
 *
 * Genommen wird der nächste Halt bis `STAND_RADIUS_M` mit passendem Namen —
 * ohne Namenstreffer nur, was praktisch auf dem Punkt steht (≤ 2 m).
 */
async function resolveMotisStand(code: string, label: string, lat: number, lon: number): Promise<MotisStand | null> {
  const cached = standIdCache.get(code);
  if (cached !== undefined) return cached;
  const dLat = 0.0002;
  const dLon = 0.0002 / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  let stops: MotisMapStop[];
  try {
    const raw = await motisFetch(
      `/v1/map/stops?min=${(lat - dLat).toFixed(6)},${(lon - dLon).toFixed(6)}` +
        `&max=${(lat + dLat).toFixed(6)},${(lon + dLon).toFixed(6)}`,
    );
    stops = Array.isArray(raw) ? (raw as MotisMapStop[]) : [];
  } catch {
    // Vorübergehender Fehler: nicht als „gibt es nicht" merken.
    return null;
  }
  let best: { stand: MotisStand; d: number } | null = null;
  for (const s of stops) {
    if (!s.stopId || s.lat == null || s.lon == null) continue;
    const d = metersBetween(lat, lon, s.lat, s.lon);
    const ok = d <= 2 || (d <= STAND_RADIUS_M && !!s.name && sameStopByName(label, s.name));
    if (ok && (!best || d < best.d)) best = { stand: { id: s.stopId, platform: cleanPlatform(s.track) ?? null }, d };
  }
  const stand = best?.stand ?? null;
  standIdCache.set(code, stand);
  return stand;
}

/**
 * Tafel EINES Steigs einer Station — nur die Abfahrten, die an diesem Mast
 * halten (Hörde Bf, Steig 03: 400/430/439/451), nicht die der Nachbarsteige.
 * `radius` + `exactRadius=true` beschränken `/v6/stoptimes` auf Halte, die
 * physisch im Umkreis des Steigs stehen; ohne sie liefert MOTIS die ganze
 * Station.
 *
 * @returns null, wenn MOTIS den Steig nicht kennt — der Aufrufer zeigt dann
 *          die Tafel der Station (jede Zeile mit ihrem Steig). Sonst die Tafel
 *          samt Steig-Bezeichnung von MOTIS (`platform`) — gtfs.de führt sie
 *          bei vielen Steigen nicht (Hörde Bf), DELFI bei Transitous schon.
 */
export async function getMotisStandBoard(
  code: string,
  label: string,
  lat: number,
  lon: number,
  board: StopBoard,
  limit = 25,
): Promise<(StopBoardResponse & { platform: string | null }) | null> {
  const stand = await resolveMotisStand(code, label, lat, lon);
  if (!stand) return null;
  const results = await fetchStopTimes(stand.id, `&radius=${STAND_RADIUS_M}&exactRadius=true`, board, limit);
  if (!results) return null;
  const now = Date.now();
  return {
    results,
    fetchedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 60_000).toISOString(),
    // Der Steig selbst — liegt per Definition auf unserem Punkt.
    source: { name: label, latitude: lat, longitude: lon },
    platform: stand.platform,
  };
}
