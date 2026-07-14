import { fromZonedTime } from "date-fns-tz";
import { config } from "../../config.js";
import { normStationName, sameCity } from "../../util/stationName.js";
import { BoundedTtlCache } from "../../util/boundedCache.js";
import { buildShopLink, isoToDmy } from "./flixbusLink.js";
import type { ProviderSearchInput, NormalizedResult, LegInfo } from "../types.js";

/**
 * NOTFALL-PFAD für FlixBus über den RapidAPI-Wrapper (flixbus2).
 *
 * Der reguläre Weg ist FlixBus' eigene öffentliche API (siehe flixbus.ts). Die
 * ist unlimitiert und liefert exakte Daten — aber sie ist undokumentiert und
 * könnte uns jederzeit still aussperren. Dann übernimmt hier der bezahlte
 * RapidAPI-Zugang: bekanntes Kontingent, vertraglich zugesichert.
 *
 * WARUM DAS NICHT EINFACH DER ALTE CODE IST:
 * Der Wrapper schneidet den Zeitzonen-Offset ab —
 *     FlixBus:  "2026-07-15T13:50:00+02:00"
 *     Wrapper:  "2026-07-15T13:50:00.000"
 * — und der alte Provider hängte einfach ein „Z" an, behandelte die ORTSZEIT
 * also als UTC. Zusammen mit dem nie gesetzten originTz rechnete der Client die
 * Gerätezeit ein zweites Mal drauf: Ein Bus um 13:50 stand als 15:50 in der App.
 *
 * Ein Fallback, der falsche Abfahrtszeiten liefert, ist schlimmer als gar keiner
 * — man verpasst den Bus und vertraut der App nicht mehr. Darum interpretieren
 * wir die Ortszeit hier explizit IN der Zeitzone des jeweiligen Endpunkts
 * (`fromZonedTime`), die der Aufrufer mitgibt.
 *
 * BEKANNTE UNSCHÄRFE: Für Zwischenhalte nehmen wir die Zone des Start- bzw.
 * Zielorts. Bei einer Fahrt über eine Zeitzonengrenze (selten im Fernbus) können
 * die Zeiten der MITTLEREN Legs um eine Stunde danebenliegen. Ab- und Ankunft der
 * Gesamtreise — das, wonach man plant — stimmen. Für einen Notfallpfad ist das
 * vertretbar; der Hauptpfad hat das Problem gar nicht (echte Offsets pro Halt).
 */

const cityIdCache = new BoundedTtlCache<string | null>(500, 24 * 60 * 60 * 1000);

interface RapidItem {
  id?: string;
  name?: string;
  is_train?: boolean;
  city?: { id?: string; name?: string };
}

interface RapidSegment {
  dep_offset?: string;
  arr_offset?: string;
  dep_name?: string;
  arr_name?: string;
  dep_id?: string;
  arr_id?: string;
  line_code?: string;
  line?: string;
}

interface RapidJourney {
  dep_offset?: string;
  arr_offset?: string;
  dep_name?: string;
  arr_name?: string;
  changeovers?: number;
  segments?: RapidSegment[];
  deeplink?: string;
  fares?: Array<{ price?: number; currency?: string }>;
}

function headers(): Record<string, string> {
  return {
    "x-rapidapi-key": config.RAPIDAPI_KEY ?? "",
    "x-rapidapi-host": config.FLIXBUS_RAPIDAPI_HOST,
  };
}

async function autocomplete(query: string, signal?: AbortSignal): Promise<RapidItem[]> {
  const url = new URL(`https://${config.FLIXBUS_RAPIDAPI_HOST}/autocomplete`);
  url.searchParams.set("query", query);
  const res = await fetch(url, { headers: headers(), signal });
  if (!res.ok) throw new Error(`flixbus-rapid autocomplete ${res.status}`);
  const raw = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(raw) ? (raw as RapidItem[]) : [];
  // Nur Bus-Stationen bevorzugen; die API-Reihenfolge sonst NICHT antasten
  // (das alte `sort(desc importance_order)` machte aus „Berlin ZOB" Mannheim).
  return [...list].sort((a, b) => (a.is_train === b.is_train ? 0 : a.is_train ? 1 : -1));
}

async function resolveCityId(
  code: string,
  label: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(code)) return code;

  for (const candidate of [label, code].filter((x): x is string => !!x)) {
    const key = candidate.toLowerCase();
    const cached = cityIdCache.get(key);
    if (cached !== undefined) {
      if (cached) return cached;
      continue;
    }
    const hits = await autocomplete(candidate, signal);
    if (hits.length === 0) {
      cityIdCache.set(key, null);
      continue;
    }
    // Dieselbe Auswahl in Stufen wie im Hauptpfad (flixbus.ts): exakter Stadtname
    // vor irgendeinem Treffer derselben Stadt vor dem relevantesten Treffer.
    // Vorher fiel dieser Pfad direkt auf hits[0] zurück — genau der Griff, der uns
    // aus „Berlin ZOB" MANNHEIM gemacht hat. Im Notfallpfad ist das nicht weniger
    // gefährlich, nur seltener.
    const wanted = normStationName(candidate);
    const hit =
      hits.find((h) => h.city?.name && normStationName(h.city.name) === wanted) ??
      hits.find((h) => sameCity(candidate, h.name) || sameCity(candidate, h.city?.name)) ??
      hits[0];
    const id = hit?.city?.id ?? hit?.id ?? null;
    cityIdCache.set(key, id);
    if (id) return id;
  }
  return null;
}


/**
 * Ortszeit ohne Offset („2026-07-15T13:50:00.000") + IANA-Zone → korrektes UTC.
 * Ohne Zone bleibt nur die alte, falsche Annahme „ist schon UTC" — die geben wir
 * dann unverändert zurück, damit der Fallback nicht ganz ausfällt.
 */
function localToUtc(value: string | undefined, tz: string | undefined): string | null {
  if (!value) return null;
  const naive = value.replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  try {
    const d = tz ? fromZonedTime(naive, tz) : new Date(`${naive}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}

export interface RapidTz {
  origin?: string;
  destination?: string;
}

/**
 * @returns Treffer, oder `null` wenn der Notfallpfad nicht verfügbar ist
 *          (kein RapidAPI-Key / API-Fehler) — dann bleibt es beim leeren Ergebnis
 *          des Hauptpfads, und motis-bus trägt die Bus-Suche.
 */
export async function searchFlixbusViaRapid(
  input: ProviderSearchInput,
  tz: RapidTz,
  signal?: AbortSignal,
): Promise<NormalizedResult[] | null> {
  if (!config.RAPIDAPI_KEY) return null;

  try {
    const fromId = await resolveCityId(input.origin, input.originLabel, signal);
    const toId = await resolveCityId(input.destination, input.destLabel, signal);
    if (!fromId || !toId) return null;

    const fetchTrips = async (a: string, b: string, date: string): Promise<RapidJourney[]> => {
      const url = new URL(`https://${config.FLIXBUS_RAPIDAPI_HOST}/trips`);
      url.searchParams.set("from_id", a);
      url.searchParams.set("to_id", b);
      url.searchParams.set("date", isoToDmy(date));
      url.searchParams.set("time", "00:00");
      url.searchParams.set("adult", String(input.passengers));
      url.searchParams.set("search_by", "cities");
      url.searchParams.set("currency", input.currency);
      const res = await fetch(url, { headers: headers(), signal });
      if (!res.ok) throw new Error(`flixbus-rapid trips ${res.status}`);
      const raw = (await res.json().catch(() => null)) as { journeys?: RapidJourney[] } | null;
      return raw?.journeys ?? [];
    };

    const outbound = await fetchTrips(fromId, toId, input.departDate);
    const outLink = buildShopLink({
      fromCityId: fromId,
      toCityId: toId,
      rideDate: input.departDate,
      passengers: input.passengers,
      currency: input.currency,
    });
    const results: NormalizedResult[] = parse(outbound, input, tz, outLink).map((r) => ({
      ...r,
      direction: "OUTBOUND" as const,
    }));

    if (input.returnDate) {
      const back = await fetchTrips(toId, fromId, input.returnDate);
      results.push(
        ...parse(
          back,
          {
            ...input,
            origin: input.destination,
            destination: input.origin,
            originLabel: input.destLabel,
            destLabel: input.originLabel,
          },
          { origin: tz.destination, destination: tz.origin },
          buildShopLink({
            fromCityId: toId,
            toCityId: fromId,
            rideDate: input.returnDate,
            passengers: input.passengers,
            currency: input.currency,
          }),
        ).map((r) => ({ ...r, direction: "RETURN" as const })),
      );
    }
    return results;
  } catch {
    return null;
  }
}

function parse(
  journeys: RapidJourney[],
  input: ProviderSearchInput,
  tz: RapidTz,
  deepLink: string,
): NormalizedResult[] {
  const out: NormalizedResult[] = [];

  for (let i = 0; i < journeys.length; i++) {
    const j = journeys[i]!;
    const depart = localToUtc(j.dep_offset, tz.origin);
    const arrive = localToUtc(j.arr_offset, tz.destination);
    if (!depart || !arrive) continue;

    const price = j.fares?.[0]?.price;
    if (typeof price !== "number" || price <= 0) continue;

    const legs: LegInfo[] = [];
    const segs = j.segments ?? [];
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s]!;
      const isLast = s === segs.length - 1;
      // Näherung: Alles in der Zone des STARTORTS, nur die Endankunft in der des
      // ZIELORTS. Der Wrapper liefert pro Halt keine Zone, und die Zwischenhalte
      // eines Fernbusses liegen fast immer in einem der beiden Länder. Über eine
      // Zeitzonengrenze hinweg können die MITTLEREN Zeiten um eine Stunde
      // danebenliegen — Ab- und Ankunft der Gesamtreise, nach denen man plant,
      // stimmen. Der Hauptpfad hat das Problem nicht (echte Offsets pro Halt).
      const segDep = localToUtc(seg.dep_offset, tz.origin);
      const segArr = localToUtc(seg.arr_offset, isLast ? tz.destination : tz.origin);
      if (!segDep || !segArr) continue;
      legs.push({
        origin: seg.dep_id ?? "",
        destination: seg.arr_id ?? "",
        originLabel: seg.dep_name,
        destLabel: seg.arr_name,
        departTime: segDep,
        arriveTime: segArr,
        // Näherung wie bei der Zeitberechnung oben: Der Wrapper liefert pro Halt
        // keine Zone, also Startzone für alles außer der Endankunft.
        originTz: tz.origin,
        destTz: isLast ? tz.destination : tz.origin,
        durationMinutes: Math.max(1, Math.round((Date.parse(segArr) - Date.parse(segDep)) / 60_000)),
        line: seg.line_code ?? seg.line ?? "FlixBus",
        product: "bus",
        stops: 0,
      });
    }

    out.push({
      externalId: `flixbus:rapid:${depart}:${i}`,
      origin: input.origin,
      destination: input.destination,
      originLabel: j.dep_name ?? input.originLabel ?? input.origin,
      destLabel: j.arr_name ?? input.destLabel ?? input.destination,
      departTime: depart,
      arriveTime: arrive,
      originTz: tz.origin,
      destinationTz: tz.destination,
      durationMinutes: Math.max(1, Math.round((Date.parse(arrive) - Date.parse(depart)) / 60_000)),
      stops: typeof j.changeovers === "number" ? j.changeovers : Math.max(0, legs.length - 1),
      stopLabels: legs.slice(0, -1).map((l) => l.destLabel ?? "").filter(Boolean),
      legs: legs.length > 0 ? legs : undefined,
      price,
      currency: j.fares?.[0]?.currency ?? input.currency,
      // Derselbe Link wie im Hauptpfad (flixbusLink.ts) — mit der Währung und
      // der Personenzahl der APP, nicht den Vorgaben der API.
      deepLink,
      operatedBy: "FlixBus",
      providerLogo: "https://logos.flixbus.com/flixbus.png",
    });
  }
  return out;
}
