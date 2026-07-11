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
  }>;
  price?: { amount?: number; currency?: string } | null;
  refreshToken?: string;
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

/** Linien-Kürzel normalisieren fürs Matching ("ICE 1007" ↔ "ICE1007"). */
function normLine(s: string | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, "");
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

  // Match-Map: normLine(erste Linie) + Abfahrts-HH:MM → {price, recon}.
  const byKey = new Map<string, { amount: number; currency: string; recon?: string }>();
  for (const j of journeys) {
    const leg = j.legs?.find((l) => l.line?.name);
    // Planmäßige Abfahrt zum Matchen (MOTIS-Seite nutzt jetzt auch scheduled).
    const dep = leg?.plannedDeparture ?? leg?.departure;
    if (!leg || !dep || j.price?.amount == null) continue;
    const key = `${normLine(leg.line?.name)}|${hhmm(dep)}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        amount: j.price.amount,
        currency: j.price.currency ?? "EUR",
        recon: j.refreshToken,
      });
    }
  }
  if (byKey.size === 0) return;

  for (const r of results) {
    const key = `${normLine(r.flightNumber)}|${hhmm(r.departTime, r.originTz)}`;
    const match = byKey.get(key);
    if (match) {
      r.price = match.amount;
      r.currency = match.currency;
      if (match.recon) r.bookingToken = match.recon;
    }
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
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { vbid?: string };
    if (!data.vbid) return null;
    return `https://www.bahn.de/buchung/start?vbid=${encodeURIComponent(data.vbid)}`;
  } catch {
    return null;
  }
}
