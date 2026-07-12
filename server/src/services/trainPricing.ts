import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import type { NormalizedResult } from "../providers/types.js";

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

interface DbwebJourney {
  legs?: Array<{
    line?: { name?: string };
    departure?: string;
    plannedDeparture?: string;
    arrival?: string;
    plannedArrival?: string;
    departurePlatform?: string;
    plannedDeparturePlatform?: string;
    arrivalPlatform?: string;
    plannedArrivalPlatform?: string;
  }>;
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
  const url =
    `${config.DBWEB_BASE_URL}/journeys?from=${encodeURIComponent(fromEva)}` +
    `&to=${encodeURIComponent(toEva)}&departure=${encodeURIComponent(dep)}&results=6`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dbweb ${res.status}`);
  const data = (await res.json()) as { journeys?: DbwebJourney[] };
  const journeys = data.journeys ?? [];
  journeyCache.set(key, journeys);
  return journeys;
}

/**
 * Setzt `price` + `bookingToken` (Recon) auf die passenden Zug-Ergebnisse.
 * Mutiert die übergebenen NormalizedResults. Best-effort: bei fehlender EVA /
 * dbweb-Fehler bleibt alles wie es war (price=0).
 */
export async function enrichTrainPrices(
  results: NormalizedResult[],
  input: { origin: string; destination: string; departDate: string },
): Promise<void> {
  if (results.length === 0) return;
  const [fromEva, toEva] = await Promise.all([evaFor(input.origin), evaFor(input.destination)]);
  if (!fromEva || !toEva) return; // z.B. non-DE Stop ohne EVA → kein Preis

  let journeys: DbwebJourney[];
  try {
    journeys = await fetchDbwebJourneys(fromEva, toEva, input.departDate);
  } catch {
    return; // int.bahn.de gedrosselt/aus → kein Preis, Verbindungen bleiben
  }

  // Match-Map: NUR Abfahrts-HH:MM → bahn.de-Wahrheit. NICHT über den Linien-
  // Namen matchen — MOTIS/DELFI und bahn.de benennen denselben Zug oft anders
  // (DELFI "IC 190" ↔ bahn.de "ECE 190"), was den Match sonst zerstört (kein
  // Preis, kein Label/Gleis-Fix). Die Abfahrtsminute ist pro Strecke eindeutig.
  interface DbwebMatch {
    amount?: number;
    currency: string;
    recon?: string;
    lineName?: string;
    depPlatform?: string;
    arrPlatform?: string;
    arrHHmm: string;
  }
  const byDep = new Map<string, DbwebMatch>();
  for (const j of journeys) {
    const first = j.legs?.find((l) => l.line?.name) ?? j.legs?.[0];
    const dep = first?.plannedDeparture ?? first?.departure;
    if (!first || !dep) continue;
    const last = j.legs?.[j.legs.length - 1];
    const arr = last?.plannedArrival ?? last?.arrival;
    const k = hhmm(dep);
    if (byDep.has(k)) continue;
    byDep.set(k, {
      amount: j.price?.amount ?? undefined,
      currency: j.price?.currency ?? "EUR",
      recon: j.refreshToken,
      lineName: first.line?.name,
      depPlatform: first.departurePlatform ?? first.plannedDeparturePlatform,
      arrPlatform: last?.arrivalPlatform ?? last?.plannedArrivalPlatform,
      arrHHmm: arr ? hhmm(arr) : "",
    });
  }
  if (byDep.size === 0) return;

  for (const r of results) {
    const m = byDep.get(hhmm(r.departTime, r.originTz));
    if (!m) continue;
    // Sicherheits-Check: Ankunft grob gleich → wirklich derselbe Zug (schützt
    // vor dem theoretischen Fall zweier Züge mit identischer Abfahrtsminute).
    if (m.arrHHmm) {
      const d = Math.abs(hhmmToMin(m.arrHHmm) - hhmmToMin(hhmm(r.arriveTime, r.destinationTz)));
      if (Math.min(d, 1440 - d) > 20) continue;
    }
    // bahn.de ist authoritative für Buchung/Label/Gleis — DELFI überschreiben.
    if (m.amount != null) {
      r.price = m.amount;
      r.currency = m.currency;
    }
    if (m.recon) r.bookingToken = m.recon;
    if (m.lineName) {
      r.flightNumber = m.lineName;
      if (r.legs?.[0]) r.legs[0].line = m.lineName;
    }
    if (m.depPlatform && r.legs?.[0]) r.legs[0].departPlatform = m.depPlatform;
    if (m.arrPlatform && r.legs?.length) r.legs[r.legs.length - 1]!.arrivePlatform = m.arrPlatform;
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
