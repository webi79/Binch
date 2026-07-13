import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import type { LegInfo, NormalizedResult, StopoverInfo } from "../providers/types.js";

/**
 * Zug-Preis-Enrichment + Direkt-Buchungslink über int.bahn.de (dbweb-Profil,
 * NICHT geblockt — anderer Host als das gesperrte app.services-bahn.de).
 *
 * - `enrichTrainPrices`: ein dbweb-`/journeys`-Call pro Suche liefert ~6
 *   Verbindungen mit PREIS + Recon-Token; wir matchen sie an die MOTIS-
 *   Ergebnisse (Linie + Abfahrtsminute) und setzen `price` + `bookingToken`
 *   (= Recon). Best-effort + gecacht (int.bahn.de ist ~60 req/min limitiert;
 *   Fehler/Drosselung → einfach kein Preis, Verbindungen bleiben da).
 * - `resolveBahnBookingUrl`: Recon → bahn.de „Reise teilen" → `vbid` →
 *   `bahn.de/buchung/start?vbid=…` (echter Direkt-Buchungslink).
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

// code → EVA (hafas_id). Stabil → 24h.
const evaCache = new BoundedTtlCache<string | null>(2000, 24 * 60 * 60 * 1000);
// (fromEva|toEva|departISO-Bucket) → dbweb-Journeys. 5 min (schont int.bahn.de).
const journeyCache = new BoundedTtlCache<DbwebJourney[]>(500, 5 * 60 * 1000);

interface DbwebLine {
  name?: string;
  fahrtNr?: string;
  product?: string;
  productName?: string;
  id?: string;
  operator?: { name?: string } | null;
}
interface DbwebStop {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number };
}
interface DbwebStopover {
  stop?: DbwebStop;
  arrival?: string;
  plannedArrival?: string;
  departure?: string;
  plannedDeparture?: string;
  arrivalPlatform?: string;
  plannedArrivalPlatform?: string;
  departurePlatform?: string;
  plannedDeparturePlatform?: string;
}
interface DbwebLeg {
  line?: DbwebLine;
  origin?: DbwebStop;
  destination?: DbwebStop;
  departure?: string;
  plannedDeparture?: string;
  arrival?: string;
  plannedArrival?: string;
  departurePlatform?: string;
  plannedDeparturePlatform?: string;
  arrivalPlatform?: string;
  plannedArrivalPlatform?: string;
  direction?: string;
  tripId?: string;
  walking?: boolean;
  stopovers?: DbwebStopover[];
}
interface DbwebJourney {
  legs?: DbwebLeg[];
  price?: { amount?: number; currency?: string } | null;
  refreshToken?: string;
}

/** Minuten-im-Tag aus "HH:MM" (mit Mitternachts-Wrap fürs Diff). */
function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

async function evaFor(code: string): Promise<string | null> {
  const cached = evaCache.get(code);
  if (cached !== undefined) return cached;
  let eva: string | null = null;
  try {
    const hit = await db
      .select({ hafasId: locations.hafasId })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    const raw = hit[0]?.hafasId ?? null;
    // dbweb versteht 6–9-stellige EVA-Nummern.
    eva = raw && /^\d{6,9}$/.test(raw) ? raw : null;
  } catch {
    eva = null;
  }
  evaCache.set(code, eva);
  return eva;
}

/** Lokale HH:MM aus ISO (Matching-Schlüssel-Teil). */
function hhmm(iso: string | undefined, tz?: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz || "Europe/Berlin",
    });
  } catch {
    return "";
  }
}

async function fetchDbwebJourneys(
  fromEva: string,
  toEva: string,
  departure: string,
): Promise<DbwebJourney[]> {
  const bucket = Math.floor(Date.parse(departure) / (10 * 60_000));
  const key = `${fromEva}|${toEva}|${bucket}`;
  const cached = journeyCache.get(key);
  if (cached) return cached;

  // dbweb will Lokalzeit-ISO ohne Offset.
  const dep = new Date(departure).toISOString().slice(0, 16);
  // results=10 statt 6: unsere MOTIS-Treffer spannen ein Zeitfenster auf (mehrere
  // Abfahrten). Liefert dbweb weniger Verbindungen als das Fenster breit ist,
  // bleiben die späteren Treffer ohne Preis/Route. Kostet trotzdem nur EINEN Call.
  const url =
    `${config.DBWEB_BASE_URL}/journeys?from=${encodeURIComponent(fromEva)}` +
    `&to=${encodeURIComponent(toEva)}&departure=${encodeURIComponent(dep)}&results=10` +
    // stopovers=true: wir zeigen die dbweb-Route inkl. Zwischenhalten in der
    // Timeline an (nicht mehr nur Preis-Enrichment).
    `&stopovers=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dbweb ${res.status}`);
  const data = (await res.json()) as { journeys?: DbwebJourney[] };
  const journeys = data.journeys ?? [];
  journeyCache.set(key, journeys);
  return journeys;
}

/** Sauberes Linien-Label aus dem dbweb-line-Objekt: bevorzugt `name` (ICE 513,
 *  Bus X61, FLX 1238), aber wenn `name` eine nackte Zug-Nummer ist (Regional,
 *  z.B. "81077"), zieh die Linie aus der `id` ("re45-81077" → "RE45"). */
function cleanLineLabel(line?: DbwebLine): string | undefined {
  const name = line?.name?.trim();
  if (name && /[a-zA-Z]/.test(name)) return name;
  const idPart = (line?.id ?? "").split("-")[0] ?? "";
  if (/^[a-z]{1,4}\d+$/i.test(idPart)) return idPart.toUpperCase();
  if (name && line?.productName) return `${line.productName} ${name}`;
  return name || undefined;
}

/** dbweb-Produkt → MOTIS-Mode-Vokabular, damit der Client die Linien-Farbe
 *  konsistent zu MOTIS-Routen rendert. */
function dbwebProductToMode(p?: string): string {
  switch (p) {
    case "nationalExpress": return "HIGHSPEED_RAIL";
    case "national": return "LONG_DISTANCE";
    case "regionalExpress": return "REGIONAL_RAIL";
    case "regional": return "REGIONAL_RAIL";
    case "suburban": return "SUBURBAN";
    case "bus": return "BUS";
    case "tram": return "TRAM";
    case "subway": return "SUBWAY";
    case "ferry": return "FERRY";
    default: return p ?? "REGIONAL_RAIL";
  }
}

function iso(s?: string): string | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}
/** Verspätung in Minuten (Ist − Soll), nur wenn echte Verspätung. */
function legDelay(planned?: string, actual?: string): number | undefined {
  if (!planned || !actual) return undefined;
  const d = Math.round((Date.parse(actual) - Date.parse(planned)) / 60_000);
  return d > 0 ? d : undefined;
}

interface DbwebRoute {
  legs: LegInfo[];
  stops: number;
  stopLabels: string[];
  departTime: string;
  arriveTime: string;
  /** Abfahrt des ERSTEN ZUGES (ohne Zugangs-Fußweg) — nur zum Matchen. */
  trainDepartTime: string;
  /** Ankunft des LETZTEN ZUGES (ohne Abgangs-Fußweg) — nur zum Matchen. */
  trainArriveTime: string;
  durationMinutes: number;
  flightNumber?: string;
  operatedBy?: string;
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
}

/** Baut aus einer dbweb-Journey die vollständige Anzeige-Route. Fußwege gehören
 *  DAZU (wie in motis.ts): ließe man sie weg, endete die Route sichtbar am
 *  letzten Fahrzeug-Halt statt am Ziel und die Dauer wäre gelogen. null wenn
 *  unbrauchbar. */
function buildDbwebRoute(j: DbwebJourney): DbwebRoute | null {
  const all = (j.legs ?? []).filter((l) => l.line || l.walking);
  const transit = all.filter((l) => l.line && !l.walking);
  const first = transit[0];
  const last = transit[transit.length - 1];
  if (!first || !last) return null;

  // Fußwege mitnehmen, 0-Minuten-Stubs raus.
  const journey = all.filter((l) => {
    if (!l.walking) return true;
    const d = iso(l.plannedDeparture ?? l.departure);
    const a = iso(l.plannedArrival ?? l.arrival);
    if (!d || !a) return false;
    return Math.round((Date.parse(a) - Date.parse(d)) / 60_000) >= 1;
  });
  const jFirst = journey[0];
  const jLast = journey[journey.length - 1];

  // Anzeige-Zeiten = ganze Reise inkl. Fußwege.
  const departTime = iso(jFirst?.plannedDeparture ?? jFirst?.departure);
  const arriveTime = iso(jLast?.plannedArrival ?? jLast?.arrival);
  // Matching-Anker = erste Zugabfahrt / letzte Zugankunft. Der REISEBEGINN taugt
  // dafür nicht: MOTIS und bahn.de routen Fußwege unterschiedlich, der Reisebeginn
  // weicht dann um Minuten ab und das Matching (auf die Minute) liefe ins Leere.
  // Die Zugabfahrt dagegen ist auf beiden Seiten dieselbe Fahrplan-Tatsache.
  const trainDepartTime = iso(first.plannedDeparture ?? first.departure);
  const trainArriveTime = iso(last.plannedArrival ?? last.arrival);
  if (!departTime || !arriveTime || !trainDepartTime || !trainArriveTime) return null;

  const legs: LegInfo[] = [];
  for (const seg of journey) {
    const d = iso(seg.plannedDeparture ?? seg.departure);
    const a = iso(seg.plannedArrival ?? seg.arrival);
    if (!d || !a) continue;
    // dbweb-stopovers enthalten ALLE Halte inkl. Start/Ziel → nur die Mitte.
    const stopovers: StopoverInfo[] = (seg.stopovers ?? [])
      .slice(1, -1)
      .map((s) => ({
        name: s.stop?.name,
        arrival: iso(s.plannedArrival ?? s.arrival),
        departure: iso(s.plannedDeparture ?? s.departure),
        platform:
          s.plannedArrivalPlatform ?? s.arrivalPlatform ?? s.plannedDeparturePlatform ?? s.departurePlatform,
      }))
      .filter((s) => !!s.name);
    legs.push({
      origin: seg.origin?.id ?? seg.origin?.name ?? "",
      destination: seg.destination?.id ?? seg.destination?.name ?? "",
      originLabel: seg.origin?.name,
      destLabel: seg.destination?.name,
      originLat: seg.origin?.location?.latitude,
      originLng: seg.origin?.location?.longitude,
      destLat: seg.destination?.location?.latitude,
      destLng: seg.destination?.location?.longitude,
      departTime: d,
      arriveTime: a,
      departDelayMinutes: legDelay(seg.plannedDeparture, seg.departure),
      arriveDelayMinutes: legDelay(seg.plannedArrival, seg.arrival),
      durationMinutes: Math.max(1, Math.round((Date.parse(a) - Date.parse(d)) / 60_000)),
      departPlatform: seg.plannedDeparturePlatform ?? seg.departurePlatform,
      arrivePlatform: seg.plannedArrivalPlatform ?? seg.arrivalPlatform,
      line: cleanLineLabel(seg.line),
      product: dbwebProductToMode(seg.line?.product),
      fahrtNr: seg.line?.fahrtNr,
      direction: seg.direction,
      walking: !!seg.walking,
      stops: stopovers.length,
      stopovers: stopovers.length > 0 ? stopovers : undefined,
      tripId: seg.tripId,
    });
  }
  if (legs.length === 0) return null;

  const stopLabels = transit
    .slice(0, -1)
    .map((l) => l.destination?.name)
    .filter((x): x is string => !!x);
  const operatedBy =
    first.line?.operator?.name ??
    (first.line?.product === "national" || first.line?.product === "nationalExpress"
      ? "DB Fernverkehr"
      : first.line?.productName);

  return {
    legs,
    stops: Math.max(0, transit.length - 1),
    stopLabels,
    departTime,
    arriveTime,
    trainDepartTime,
    trainArriveTime,
    durationMinutes: Math.max(1, Math.round((Date.parse(arriveTime) - Date.parse(departTime)) / 60_000)),
    flightNumber: cleanLineLabel(first.line),
    operatedBy,
    // Startet die Reise mit einem Fußweg, ist die Abfahrt am Ursprung nicht
    // verspätet — die Zug-Verspätung steht am jeweiligen Leg (wie in motis.ts).
    departDelayMinutes: jFirst?.walking
      ? undefined
      : legDelay(first.plannedDeparture, first.departure),
    arriveDelayMinutes: legDelay(last.plannedArrival, last.arrival),
  };
}

/** Abfahrt des ersten bzw. Ankunft des letzten FAHRZEUG-Legs eines Ergebnisses —
 *  der Matching-Anker gegen dbweb (Fußwege bleiben außen vor). */
function trainAnchors(r: NormalizedResult): { dep: string; arr: string } {
  const legs = r.legs ?? [];
  const firstTransit = legs.find((l) => !l.walking);
  const lastTransit = [...legs].reverse().find((l) => !l.walking);
  return {
    dep: firstTransit?.departTime ?? r.departTime,
    arr: lastTransit?.arriveTime ?? r.arriveTime,
  };
}

/**
 * Reichert MOTIS-Zug-Ergebnisse mit bahn.de-Daten (dbweb) an. Wo eine dbweb-
 * Verbindung nach Abfahrtszeit matcht, wird die Route KOMPLETT durch bahn.des
 * Route ersetzt (Legs, Zeiten, Gleise, Label, Preis, Recon) — so deckt sich die
 * Anzeige mit dem, was der Deeplink bucht. MOTIS bleibt Fallback für
 * Verbindungen, die dbweb nicht liefert (bzw. wenn int.bahn.de drosselt).
 * Mutiert die NormalizedResults in-place. Best-effort (Fehler → alles bleibt).
 */
export async function enrichTrainResults(
  results: NormalizedResult[],
  input: { origin: string; destination: string; departDate: string; passengers?: number },
): Promise<void> {
  if (results.length === 0) return;
  const [fromEva, toEva] = await Promise.all([evaFor(input.origin), evaFor(input.destination)]);
  if (!fromEva || !toEva) return; // non-DE Stop ohne EVA → keine dbweb-Daten

  // Die dbweb-Suche MUSS am selben Zeitfenster hängen wie die MOTIS-Ergebnisse,
  // die sie anreichern soll. Vorher stand hier `input.departDate` — ein reines
  // Datum, also Mitternacht: dbweb lieferte Nachtzüge, MOTIS die Verbindungen ab
  // der gewählten Uhrzeit. Die Fenster überlappten nicht, nichts matchte, und die
  // Anreicherung fiel still aus (keine Preise, keine bahn.de-Route).
  //
  // Anker ist die FRÜHESTE Zugabfahrt unter unseren Ergebnissen (minus eine
  // Minute, damit sie selbst noch im Fenster liegt). Damit kann das Fenster
  // gar nicht mehr auseinanderlaufen — egal woher der Suchzeitpunkt kam.
  const earliest = results
    .map((r) => Date.parse(trainAnchors(r).dep))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const anchor = earliest
    ? new Date(earliest - 60_000).toISOString()
    : input.departDate;

  let journeys: DbwebJourney[];
  try {
    journeys = await fetchDbwebJourneys(fromEva, toEva, anchor);
  } catch {
    return; // int.bahn.de gedrosselt/aus → MOTIS-Route/Kein-Preis bleiben
  }

  const pax = Math.max(1, input.passengers ?? 1);
  // dbweb-Route je ZUG-Abfahrts-HH:MM (NICHT über Label matchen — das weicht ab;
  // und NICHT über den Reisebeginn — der hängt am Fußweg-Routing, das bei MOTIS
  // und bahn.de auseinandergeht).
  const byDep = new Map<string, { route: DbwebRoute; price?: number; currency: string; recon?: string }>();
  for (const j of journeys) {
    const route = buildDbwebRoute(j);
    if (!route) continue;
    const k = hhmm(route.trainDepartTime);
    if (byDep.has(k)) continue;
    const amount = j.price?.amount;
    byDep.set(k, {
      route,
      price: typeof amount === "number" && amount > 0 ? Math.round(amount * pax * 100) / 100 : undefined,
      currency: j.price?.currency ?? "EUR",
      recon: j.refreshToken,
    });
  }
  if (byDep.size === 0) return;

  for (const r of results) {
    const anchors = trainAnchors(r);
    // BEIDE Seiten im selben Zeitzonen-Rahmen (dbwebs, also Europe/Berlin)
    // formatieren. Nähme man hier die originTz/destinationTz des Ergebnisses,
    // verglichen wir bei abweichendem Offset Äpfel mit Birnen und das Matching
    // liefe still ins Leere.
    const m = byDep.get(hhmm(anchors.dep));
    if (!m) continue;
    // Ankunfts-Gegencheck: gleicher Zug (schützt vor identischer Abfahrtsminute).
    const rd = Math.abs(
      hhmmToMin(hhmm(m.route.trainArriveTime)) - hhmmToMin(hhmm(anchors.arr)),
    );
    if (Math.min(rd, 1440 - rd) > 25) continue;

    // Route KOMPLETT durch bahn.de ersetzen — Identität (id/redirectToken) und
    // deepLink (bahn.de-Suche, gleiche Zeit) bleiben.
    r.legs = m.route.legs;
    r.stops = m.route.stops;
    r.stopLabels = m.route.stopLabels;
    r.departTime = m.route.departTime;
    r.arriveTime = m.route.arriveTime;
    r.durationMinutes = m.route.durationMinutes;
    r.flightNumber = m.route.flightNumber;
    if (m.route.operatedBy) r.operatedBy = m.route.operatedBy;
    r.departDelayMinutes = m.route.departDelayMinutes;
    r.arriveDelayMinutes = m.route.arriveDelayMinutes;
    if (m.price != null) {
      r.price = m.price;
      r.currency = m.currency;
    }
    if (m.recon) r.bookingToken = m.recon;
  }
}

/**
 * Recon-Token → echter bahn.de-Direkt-Buchungslink via „Reise teilen".
 * @returns URL oder null (dann nutzt der Redirect den Such-Deeplink-Fallback).
 */
export async function resolveBahnBookingUrl(
  recon: string,
  ctx: { startOrt?: string; zielOrt?: string; hinfahrtDatum?: string },
): Promise<string | null> {
  try {
    const res = await fetch(config.BAHN_TEILEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "accept-language": "de",
        origin: "https://www.bahn.de",
        referer: "https://www.bahn.de/buchung/fahrplan/suche",
        "user-agent": UA,
      },
      body: JSON.stringify({
        startOrt: ctx.startOrt ?? "",
        zielOrt: ctx.zielOrt ?? "",
        hinfahrtDatum: ctx.hinfahrtDatum ?? "",
        hinfahrtRecon: recon,
      }),
      // KRITISCH: Timeout, sonst hängt der /redirect-Request (und damit der
      // In-App-Browser) unbegrenzt, wenn bahn.de langsam ist → „Deeplink geht
      // nicht auf". Bei Timeout → null → Redirect fällt auf den Such-Deeplink.
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vbid?: string };
    if (!data.vbid) return null;
    return `https://www.bahn.de/buchung/start?vbid=${encodeURIComponent(data.vbid)}`;
  } catch {
    return null;
  }
}
