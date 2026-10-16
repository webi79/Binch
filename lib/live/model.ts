/**
 * EIN Modell für alles, was live gezeigt wird — Zug, Bus, Tram, U-Bahn, Fähre
 * und Flugzeug. Die Karte und das Blatt fragen nur: „Wo ist es zur Zeit t, in
 * welche Richtung, wie schnell, wie hoch, an welchem Halt?" Wie das gerechnet
 * wird (Fahrplan-Bewegung oder Flugprofil), steht in `motion.ts` und
 * `flight.ts`.
 */
import { AIRPORT_PINS, type AirportPin } from "@/lib/surroundings/airportCoords";
import { buildFlightPlan, flightStateAt, flightTrack, type FlightPhase } from "./flight";
import { bearingAt, distanceM, pointAt } from "./geo";
import { buildMotionPlan, vehicleStateAt } from "./motion";
import { lookFor, lookLength } from "./shapes";
import type { LiveFlightInfo, LiveTrip, LiveVehicleKind, LngLat } from "./types";

export type LiveKind = LiveVehicleKind | "plane";

export type LivePhase = "waiting" | "moving" | "dwelling" | "arrived" | FlightPhase;

export interface LiveStop {
  name: string;
  /** Zusatz unter dem Namen — bei Flughäfen der IATA-Code. */
  code?: string;
  lat: number;
  lon: number;
  /** Meter entlang der Linie. */
  d: number;
  /**
   * Ankunft und Abfahrt laut Fahrplan (ms) — erwartet vor Plan, also dieselben
   * Zeiten wie auf der Tafel. NICHT die der Bewegungsrechnung: Die weicht um
   * Sekunden ab (Mindest-Haltezeit, Puffer), und das Blatt soll nennen, was
   * der Fahrplan sagt.
   */
  arr: number | null;
  dep: number | null;
  /** Verspätung laut Echtzeit in Minuten (nur wenn bekannt). */
  delayMin: number | null;
}

export interface LiveFrame {
  phase: LivePhase;
  /** Meter entlang der Linie — die MITTE des Fahrzeugs (am Halt steht es mittig). */
  d: number;
  position: LngLat;
  /** Grad ab Norden. */
  heading: number;
  /** m/s */
  speed: number;
  /** m über Grund (nur Flugzeug) — die gerechnete Flughöhe, fürs Blatt. */
  altitude: number;
  /**
   * In welcher Höhe das Flugzeug GEZEICHNET wird: auf seinem Bogen in der Luft
   * (`arc`), damit es auf der Linie sitzt. Der Bogen folgt Höhe · sin(π · t)
   * wie die Flugbögen der Routen — das echte Profil (schnell hoch, lange oben)
   * kann der Shader nicht.
   */
  drawAltitude: number;
  /** Halt, an dem es steht — bzw. der zuletzt verlassene. */
  stopIndex: number;
  nextIndex: number | null;
  /** 0…1 der ganzen Strecke. */
  progress: number;
}

export interface LiveModel {
  kind: LiveKind;
  product: string | null;
  line: string | null;
  direction: string | null;
  /** Zeiten mit Echtzeit (Verspätungen) — sonst reiner Fahrplan. */
  realtime: boolean;
  coords: LngLat[];
  cum: number[];
  total: number;
  stops: LiveStop[];
  /** Halt der Tafel, von der aus geöffnet wurde — „dein" Halt; null = unbekannt. */
  boardIndex: number | null;
  /** Länge des Fahrzeugs in Metern (Flugzeug: echte Länge). */
  length: number;
  /** Erste Abfahrt und letzte Ankunft (ms). */
  start: number;
  end: number;
  /** Nur Flug: der Bogen in der Luft (siehe `lib/routing/flightArcs3d.ts`). */
  arc?: { apexKm: number; mercatorLength: number };
  frameAt(t: number): LiveFrame;
}

const parse = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

function delayOf(expected: string | null, planned: string | null): number | null {
  const e = parse(expected);
  const p = parse(planned);
  if (!Number.isFinite(e) || !Number.isFinite(p)) return null;
  return Math.round((e - p) / 60_000);
}

/** Eine Fahrt am Boden: Bewegung aus dem Fahrplan, Lage aus der Linie. */
export function groundModel(trip: LiveTrip): LiveModel | null {
  if (trip.stops.length < 2 || trip.coords.length < 2) return null;
  const plan = buildMotionPlan(trip);
  const look = lookFor(trip.vehicle, trip.product);
  const length = lookLength(look);
  const { coords, cum } = trip;
  const total = cum[cum.length - 1] ?? 0;
  const stops: LiveStop[] = trip.stops.map((s, i) => ({
    name: s.name,
    lat: s.lat,
    lon: s.lon,
    d: s.d,
    arr: i === 0 ? null : finite(parse(s.arrE ?? s.arrP)),
    dep: i === trip.stops.length - 1 ? null : finite(parse(s.depE ?? s.depP)),
    delayMin: trip.realtime
      ? i === 0
        ? delayOf(s.depE, s.depP)
        : delayOf(s.arrE ?? s.depE, s.arrP ?? s.depP)
      : null,
  }));
  return {
    kind: trip.vehicle,
    product: trip.product,
    line: trip.line,
    direction: trip.direction,
    realtime: trip.realtime,
    coords,
    cum,
    total,
    stops,
    boardIndex: trip.boardIndex != null && trip.boardIndex >= 0 && trip.boardIndex < stops.length ? trip.boardIndex : null,
    length,
    start: plan.start,
    end: plan.end,
    frameAt(t) {
      const s = vehicleStateAt(plan, t);
      // Richtung über ein Stück, das zur Fahrzeuglänge passt — kurze Knicke der
      // Linie sollen das Fahrzeug nicht zucken lassen.
      const look = Math.max(15, Math.min(60, length / 3));
      return {
        phase: s.phase,
        d: s.d,
        position: pointAt(coords, cum, s.d),
        heading: bearingAt(coords, cum, s.d, look),
        speed: s.speed,
        altitude: 0,
        drawAltitude: 0,
        stopIndex: s.stopIndex,
        nextIndex: s.nextIndex,
        progress: s.progress,
      };
    },
  };
}

let airportIndex: Map<string, AirportPin> | null = null;
export function airportByIata(iata: string): AirportPin | undefined {
  if (!airportIndex) airportIndex = new Map(AIRPORT_PINS.map((p) => [p.iata, p]));
  return airportIndex.get(iata.toUpperCase());
}

/** Ein Flug: Großkreis, Höhenprofil und Rollzeiten aus Ab- und Ankunft. */
export function flightModel(
  flight: LiveFlightInfo,
  meta: { line: string | null; direction: string | null; boardIndex?: 0 | 1 | null },
): LiveModel | null {
  const from = airportByIata(flight.from);
  const to = airportByIata(flight.to);
  if (!from || !to) return null;
  const a: LngLat = [from.coord.longitude, from.coord.latitude];
  const b: LngLat = [to.coord.longitude, to.coord.latitude];
  const plan = buildFlightPlan(a, b, flight);
  if (!plan) return null;
  // Etwa alle 20 km ein Punkt — auf der Karte eine glatte Kurve.
  const coords = flightTrack(plan, Math.max(64, Math.min(512, Math.round(plan.dist / 20_000))));
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1]! + distanceM(coords[i - 1]!, coords[i]!));
  const total = cum[cum.length - 1]!;
  const toTrack = total / plan.dist;
  /**
   * Fortschritt entlang der Linie so, wie MapLibre ihn misst (`lineMetrics`):
   * in Web-Mercator. Mit ihm hebt der Shader den Bogen — das Flugzeug muss mit
   * demselben Maß auf ihm sitzen, nicht mit Metern (der Unterschied wächst mit
   * der Breite).
   */
  const mercY = (lat: number) => {
    const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  };
  const mcum = [0];
  for (let i = 1; i < coords.length; i++) {
    const [x0, y0] = coords[i - 1]!;
    const [x1, y1] = coords[i]!;
    mcum.push(mcum[i - 1]! + Math.hypot((x1 - x0) / 360, mercY(y1) - mercY(y0)));
  }
  const mtotal = mcum[mcum.length - 1]!;
  const apexM = plan.cruiseAlt;
  /** Höhe des Bogens bei `d` Metern entlang der Spur. */
  const arcAltitude = (d: number): number => {
    if (mtotal <= 0 || d <= 0 || d >= total) return 0;
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= d) lo = mid;
      else hi = mid;
    }
    const span = cum[hi]! - cum[lo]!;
    const f = span > 0 ? (d - cum[lo]!) / span : 0;
    const tm = (mcum[lo]! + (mcum[hi]! - mcum[lo]!) * f) / mtotal;
    return apexM * Math.sin(Math.PI * tm);
  };
  const stops: LiveStop[] = [
    {
      name: from.city || from.name,
      code: from.iata,
      lat: a[1],
      lon: a[0],
      d: 0,
      arr: null,
      dep: plan.offBlock,
      delayMin: delayOf(flight.depE, flight.depP),
    },
    {
      name: to.city || to.name,
      code: to.iata,
      lat: b[1],
      lon: b[0],
      d: total,
      arr: plan.onBlock,
      dep: null,
      delayMin: delayOf(flight.arrE, flight.arrP),
    },
  ];
  return {
    kind: "plane",
    product: "flight",
    line: meta.line,
    direction: meta.direction || to.city || to.name,
    realtime: flight.depE != null || flight.arrE != null,
    coords,
    cum,
    total,
    stops,
    boardIndex: meta.boardIndex ?? null,
    length: 38,
    start: plan.offBlock,
    end: plan.onBlock,
    arc: { apexKm: apexM / 1000, mercatorLength: mtotal },
    frameAt(t) {
      const s = flightStateAt(plan, t);
      const d = s.x * toTrack;
      const onGround = s.phase === "gate" || s.phase === "taxiOut" || s.phase === "taxiIn" || s.phase === "arrived";
      return {
        phase: s.phase,
        d,
        // Auf der gezeichneten Spur, nicht auf dem exakten Großkreis — beide
        // liegen höchstens ein paar hundert Meter auseinander, aber das
        // Flugzeug soll genau AUF seiner Linie sitzen.
        position: onGround ? s.position : pointAt(coords, cum, d),
        heading: s.heading,
        speed: s.speed,
        altitude: s.altitude,
        drawAltitude: onGround ? 0 : arcAltitude(d),
        stopIndex: s.phase === "taxiIn" || s.phase === "arrived" ? 1 : 0,
        nextIndex: s.phase === "taxiIn" || s.phase === "arrived" ? null : 1,
        progress: s.progress,
      };
    },
  };
}
