import { config } from "../../config.js";
import type {
  SearchProvider,
  ProviderSearchInput,
  ProviderResult,
  NormalizedResult,
  LegInfo,
} from "../types.js";

/**
 * Deutsche-Bahn Train-Provider via self-hosted db-rest (HAFAS-Wrapper).
 * Source: https://github.com/derhuerst/db-rest
 *
 * Container läuft via docker-compose unter `${DBREST_BASE_URL}` (default
 * http://localhost:3001). Kein API-Key, kein Auth, kein Quota.
 *
 * Endpoints:
 *   - /stations?query=...           → Station-Suche (für Code-Auflösung)
 *   - /journeys?from=X&to=Y&...     → Trip-Suche mit Preisen
 */

interface DbStation {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number };
}

interface DbStop {
  id?: string;
  name?: string;
}

interface DbLine {
  name?: string;
  product?: string;
  productName?: string;
  fahrtNr?: string;
  operator?: { name?: string };
}

interface DbStopover {
  stop?: DbStop;
  arrival?: string;
  departure?: string;
  plannedArrival?: string;
  plannedDeparture?: string;
  arrivalPlatform?: string;
  plannedArrivalPlatform?: string;
  departurePlatform?: string;
  plannedDeparturePlatform?: string;
}

interface DbLeg {
  origin?: DbStop;
  destination?: DbStop;
  departure?: string;
  arrival?: string;
  plannedDeparture?: string;
  plannedArrival?: string;
  departurePlatform?: string;
  plannedDeparturePlatform?: string;
  arrivalPlatform?: string;
  plannedArrivalPlatform?: string;
  direction?: string;
  tripId?: string;
  line?: DbLine;
  walking?: boolean;
  stopovers?: DbStopover[];
}

interface DbJourney {
  type?: string;
  legs?: DbLeg[];
  refreshToken?: string;
  price?: { amount?: number; currency?: string; hint?: string | null };
}

interface DbJourneysResponse {
  journeys?: DbJourney[];
}

const stationCache = new Map<string, string>();

export const dbVendoProvider: SearchProvider = {
  name: "db-vendo",
  mode: "TRAIN",

  isConfigured() {
    return Boolean(config.DBREST_BASE_URL);
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();

    let fromId: string | null;
    let toId: string | null;
    try {
      fromId = await resolveStationId(input.origin, input.originLabel, signal);
      toId = await resolveStationId(input.destination, input.destLabel, signal);
    } catch (e) {
      return {
        results: [],
        raw: { error: "station_resolve_failed", message: e instanceof Error ? e.message : String(e) },
        statusCode: 0,
        durationMs: Date.now() - start,
      };
    }
    if (!fromId || !toId) {
      return {
        results: [],
        raw: {
          skipped: "could not resolve db station id",
          origin: input.origin,
          destination: input.destination,
        },
        statusCode: 0,
        durationMs: Date.now() - start,
      };
    }

    const url = new URL(`${config.DBREST_BASE_URL}/journeys`);
    url.searchParams.set("from", fromId);
    url.searchParams.set("to", toId);
    url.searchParams.set("departure", `${input.departDate}T08:00`);
    url.searchParams.set("results", "8");
    url.searchParams.set("language", "de");
    url.searchParams.set("stopovers", "true");

    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    const statusCode = res.status;
    const raw = (await res.json().catch(() => null)) as unknown;
    const durationMs = Date.now() - start;

    if (!res.ok || !raw) {
      return { results: [], raw, statusCode, durationMs };
    }

    return {
      results: parseJourneys(raw, input),
      raw,
      statusCode,
      durationMs,
    };
  },
};

async function resolveStationId(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  // db-rest IDs sind 7-9stellige numerische EVA-Nummern (z.B. 8011160 = Berlin Hbf).
  if (/^\d{6,9}$/.test(code)) return code;

  // Code-Prefix vom liveLocations-Service: "dbrest:8011160"
  const dbrestMatch = code.match(/^dbrest:(\d+)$/);
  if (dbrestMatch && dbrestMatch[1]) return dbrestMatch[1];

  const candidates = [label, code].filter((x): x is string => typeof x === "string" && x.length > 0);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    const cached = stationCache.get(key);
    if (cached) return cached;

    const url = new URL(`${config.DBREST_BASE_URL}/stations`);
    url.searchParams.set("query", candidate);
    url.searchParams.set("limit", "5");

    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as Record<string, DbStation> | DbStation[] | null;
    if (!data) continue;
    const list: DbStation[] = Array.isArray(data) ? data : Object.values(data);
    const first = list[0];
    if (first?.id) {
      stationCache.set(key, first.id);
      return first.id;
    }
  }
  return null;
}

function parseJourneys(raw: unknown, input: ProviderSearchInput): NormalizedResult[] {
  const r = raw as DbJourneysResponse;
  const journeys = r.journeys ?? [];
  const out: NormalizedResult[] = [];

  for (let i = 0; i < journeys.length; i++) {
    const journey = journeys[i];
    if (!journey) continue;

    // Nur echte Train-Legs (keine Walking-Strecken am Anfang/Ende rausrechnen wir nicht — die landen zwischen Origin und Destination)
    const trainLegs = (journey.legs ?? []).filter((l) => !l.walking);
    if (trainLegs.length === 0) continue;

    const first = trainLegs[0];
    const last = trainLegs[trainLegs.length - 1];
    if (!first || !last) continue;

    const departIso = toIso(first.plannedDeparture ?? first.departure);
    const arriveIso = toIso(last.plannedArrival ?? last.arrival);
    if (!departIso || !arriveIso) continue;

    const durationMinutes = Math.max(
      1,
      Math.round((Date.parse(arriveIso) - Date.parse(departIso)) / 60000),
    );

    const stops = Math.max(0, trainLegs.length - 1);
    const stopLabels: string[] = [];
    if (trainLegs.length > 1) {
      for (let s = 0; s < trainLegs.length - 1; s++) {
        const seg = trainLegs[s];
        if (seg?.destination?.name) stopLabels.push(seg.destination.name);
      }
    }

    const legs: LegInfo[] = [];
    for (const seg of trainLegs) {
      const segDep = toIso(seg.plannedDeparture ?? seg.departure);
      const segArr = toIso(seg.plannedArrival ?? seg.arrival);
      if (!segDep || !segArr) continue;
      const segDuration = Math.max(
        1,
        Math.round((Date.parse(segArr) - Date.parse(segDep)) / 60000),
      );
      // db-rest liefert in `stopovers` ALLE Halte inkl. origin/destination — wir brauchen nur die Zwischenhalte.
      const middle = (seg.stopovers ?? []).slice(1, -1);
      const stopovers = middle
        .map((s) => ({
          name: s.stop?.name,
          arrival: toIso(s.plannedArrival ?? s.arrival) ?? undefined,
          departure: toIso(s.plannedDeparture ?? s.departure) ?? undefined,
          platform: s.plannedArrivalPlatform ?? s.arrivalPlatform ?? s.plannedDeparturePlatform ?? s.departurePlatform,
        }))
        .filter((s) => s.name);
      legs.push({
        origin: seg.origin?.id ?? "",
        destination: seg.destination?.id ?? "",
        originLabel: seg.origin?.name,
        destLabel: seg.destination?.name,
        departTime: segDep,
        arriveTime: segArr,
        durationMinutes: segDuration,
        departPlatform: seg.plannedDeparturePlatform ?? seg.departurePlatform,
        arrivePlatform: seg.plannedArrivalPlatform ?? seg.arrivalPlatform,
        line: seg.line?.name,
        product: seg.line?.product,
        fahrtNr: seg.line?.fahrtNr,
        direction: seg.direction,
        stops: stopovers.length,
        stopovers: stopovers.length > 0 ? stopovers : undefined,
      });
    }

    // db-rest liefert für Regional-/Verbund-Verbindungen oft keinen Preis
    // (VRR/VRS/MVV usw. werden nicht über DB-Tarif gebucht). Wir zeigen sie
    // trotzdem mit price=0 — UI rendert dann "Tarif beim Anbieter".
    const rawPrice = journey.price?.amount;
    const priceNum = typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : 0;

    const operatedBy =
      first.line?.operator?.name ??
      (first.line?.product === "national" ? "DB Fernverkehr" : first.line?.productName);

    const refresh = journey.refreshToken ?? "";
    const externalId = `dbrest:${refresh.slice(0, 64) || i}`;

    out.push({
      externalId,
      origin: first.origin?.id ?? input.origin,
      destination: last.destination?.id ?? input.destination,
      originLabel: first.origin?.name ?? input.originLabel,
      destLabel: last.destination?.name ?? input.destLabel,
      departTime: departIso,
      arriveTime: arriveIso,
      originTz: "Europe/Berlin",
      destinationTz: "Europe/Berlin",
      durationMinutes,
      stops,
      stopLabels,
      legs: legs.length > 0 ? legs : undefined,
      price: priceNum,
      currency: journey.price?.currency ?? input.currency,
      deepLink: buildBahnDeeplink(
        first.origin?.id,
        first.origin?.name,
        last.destination?.id,
        last.destination?.name,
        // Berlin-Lokalzeit-String (mit Offset, z.B. "...+02:00") an die URL
        // weitergeben — UTC-ISO würde die Stunden um den DST-Offset
        // verschieben und bahn.de auf die falsche Zeit scrollen lassen.
        first.plannedDeparture ?? first.departure ?? departIso,
      ),
      flightNumber: first.line?.fahrtNr ?? first.line?.name,
      operatedBy,
      providerLogo: "https://www.bahn.de/web-app/favicons/bahn-favicon.svg",
    });
  }
  return out;
}

function toIso(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Baut die Bahn.de-Suchen-URL mit dem `soid`/`zoid` Format, das die EVA-Nummer
 * enthält und dadurch eindeutig die Station identifiziert.
 *
 * Beispiel: `soid=A=1@O=Werl@L=8006342&zoid=A=1@O=Dortmund Universität@L=8004419`
 *
 * Damit findet bahn.de auch S-Bahn-Halte und kleine Bahnhöfe — der reine Name
 * (z.B. "Dortmund Universität") wird sonst manchmal nicht aufgelöst.
 *
 * WICHTIG: `@` und `=` müssen literal bleiben (sind Trennzeichen im HAFAS-LID),
 * nur die NAMEN selbst werden encoded (Leerzeichen, Umlaute). URLSearchParams
 * würde alles encoden und das funktioniert nicht.
 */
/**
 * Baut die bahn.de-Suchen-URL für eine konkrete Verbindung:
 *   - `soid`/`zoid` mit EVA-Nummer (eindeutige Station)
 *   - `hd` = exakte Abfahrtszeit in **Berlin-Lokalzeit** — bahn.de erwartet
 *     `YYYY-MM-DDThh:mm:00` ohne Offset, interpretiert als Berlin local. Wenn
 *     wir versehentlich UTC-Stunden senden, scrollt bahn.de bei DST um 1-2h
 *     daneben und die gewünschte Verbindung steht nicht oben in der Liste.
 *
 * `departureLocal` ist erwartet im ISO-mit-Offset-Format das db-rest liefert
 * (`2026-05-08T08:05:00+02:00`). Wir extrahieren Datum + hh:mm direkt aus dem
 * String — die Stunden sind dort bereits Berlin-lokal, der Offset wird
 * verworfen.
 *
 * Direkt-Linking auf den Kauf-Flow ist ohne DB-Vertriebspartner-Account nicht
 * möglich — bahn.de bringt uns nur auf die Liste, in der unsere Verbindung
 * dann ganz oben sitzt.
 */
function buildBahnDeeplink(
  fromId: string | undefined,
  fromName: string | undefined,
  toId: string | undefined,
  toName: string | undefined,
  departureLocal: string,
): string {
  const soid =
    fromId && fromName
      ? `A=1@O=${encodeURIComponent(fromName)}@L=${fromId}`
      : encodeURIComponent(fromName ?? "");
  const zoid =
    toId && toName
      ? `A=1@O=${encodeURIComponent(toName)}@L=${toId}`
      : encodeURIComponent(toName ?? "");
  const m = departureLocal.match(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  const hd = m ? `${m[1]}T${m[2]}:${m[3]}:00` : `${departureLocal.slice(0, 10)}T08:00:00`;
  const fragment = `soid=${soid}&zoid=${zoid}&hd=${hd}&kl=2`;
  return `https://www.bahn.de/buchung/fahrplan/suche#${fragment}`;
}
