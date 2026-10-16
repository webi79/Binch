/**
 * Live-Ansicht — die Daten einer Fahrt, wie sie der Server liefert
 * (`GET /api/live/trip`, server/src/routes/trips.ts). Wo das Fahrzeug gerade ist,
 * rechnet die App daraus selbst aus (motion.ts) — echte Positionsdaten gibt es
 * nicht.
 */

export type LngLat = [number, number];

/** Wie das Fahrzeug gezeichnet wird. */
export type LiveVehicleKind = "train" | "subway" | "tram" | "bus" | "ferry";

export interface LiveTripStop {
  name: string;
  lat: number;
  lon: number;
  /** Ankunft/Abfahrt laut Plan (…P) und wie erwartet (…E), ISO-UTC. */
  arrP: string | null;
  arrE: string | null;
  depP: string | null;
  depE: string | null;
  /** Stelle auf der Linie, Meter ab ihrem Anfang. */
  d: number;
}

export interface LiveTrip {
  tripId: string;
  vehicle: LiveVehicleKind;
  product: string | null;
  line: string | null;
  direction: string | null;
  realtime: boolean;
  shape: "geometry" | "straight";
  coords: LngLat[];
  cum: number[];
  stops: LiveTripStop[];
  /** Halt der Tafel, von der aus geöffnet wurde (Index in `stops`) — oder null. */
  boardIndex?: number | null;
  fetchedAt: string;
}

/** Ein Flug, wie ihn die Flugtafel mitliefert (StopBoardItem.flight). */
export interface LiveFlightInfo {
  from: string;
  to: string;
  depP: string | null;
  depE: string | null;
  arrP: string | null;
  arrE: string | null;
  aircraft: string | null;
}

/**
 * Was live gezeigt werden soll — gesetzt vom Live-Knopf an der Tafel-Zeile.
 * `line`/`direction`/`product` stammen aus der Zeile: Das Banner steht damit
 * sofort, bevor die Fahrt geladen ist.
 */
export type LiveSession =
  | {
      kind: "trip";
      tripId: string;
      /** Halt der Tafel — bestimmt beim Server Quelle und Land (wie beim Fahrt-Detail). */
      stopCode?: string;
      /** Zeit der Tafel-Zeile (ISO) — Betriebstag bei Länder-Fahrplänen. */
      atTime?: string;
      line: string;
      product: string | null;
      direction: string;
      /** Ortszeit-Zone der Tafel (IANA) — die Zeiten im Blatt stehen in ihr. */
      tz?: string;
    }
  | {
      kind: "flight";
      flight: LiveFlightInfo;
      /** Welcher Flughafen der der Tafel ist: 0 = Abflug, 1 = Ankunft. */
      boardIndex: 0 | 1 | null;
      /** Flugnummer, z. B. „LH 400". */
      line: string;
      direction: string;
    };
