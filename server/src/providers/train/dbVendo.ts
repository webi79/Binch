import { eq, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { locations } from "../../db/schema.js";
import { BoundedTtlCache } from "../../util/boundedCache.js";
import { cleanPlatform } from "../../util/platform.js";
import { dbStopTz, dbTimeToUtc } from "../../util/dbTime.js";
import { lineLabel } from "../../util/line.js";
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
  location?: { latitude?: number; longitude?: number };
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

// Bounded + TTL: Keys sind User-Suchbegriffe (unbegrenzter Keyspace), und
// HAFAS-Station-IDs können sich ändern — 24h-TTL statt „für immer cachen".
const stationCache = new BoundedTtlCache<string>(500, 24 * 60 * 60 * 1000);

/** Rückfall, wenn die Orts-Auflösung keine IANA-Zone hergibt. DBs Netz ist
 *  überwiegend CET — der am wenigsten falsche Default. */
const DEFAULT_TZ = "Europe/Berlin";

export const dbVendoProvider: SearchProvider = {
  name: "db-vendo",
  mode: "TRAIN",

  isConfigured() {
    // Läuft über den DBWEB-Sidecar (int.bahn.de), NICHT über dbrest
    // (app.services-bahn.de — antwortet weiter mit „Unknown").
    //
    // Der frühere Block (403 OPS_BLOCKED, 0 Treffer bei 72 Aufrufen) war KEINE
    // IP-Sperre, sondern Akamais TLS-Fingerprinting: Nodes Cipher-Liste ≠ die
    // eines Browsers. Seit die Sidecars mit `NODE_OPTIONS=--tls-cipher-list=…`
    // laufen (siehe docker-compose.yml), antwortet int.bahn.de wieder — und
    // zwar mit dem, was MOTIS prinzipbedingt nicht kann: DB-eigenem Routing,
    // DB-Gleisen, DB-Zugnamen und PREISEN.
    return config.DBVENDO_SEARCH_ENABLED && Boolean(config.DBWEB_BASE_URL);
  },

  async search(input: ProviderSearchInput, signal?: AbortSignal): Promise<ProviderResult> {
    const start = Date.now();

    let fromId: string | null;
    let toId: string | null;
    try {
      // PARALLEL: Beide Auflösungen sind unabhängig, und jede kann einen
      // HAFAS-/locations-Call enthalten (0,5-2 s bei Cache-Miss). Sequenziell
      // addierte sich das auf jede Suche, bevor überhaupt eine Journey
      // angefragt war.
      [fromId, toId] = await Promise.all([
        resolveStationId(input.origin, input.originLabel, signal),
        resolveStationId(input.destination, input.destLabel, signal),
      ]);
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

    // Hin- und (falls returnDate gesetzt) Rückfahrt parallel suchen.
    // db-rest hat keinen Round-Trip-Endpoint — wir machen zwei /journeys-
    // Calls und liefern beide Listen mit `direction`-Marker an den Client
    // zurück. Pairing-Logik (cheapest/fastest/direct) macht der Client je
    // nach aktivem Sort-Tab — nicht der Server, der das Sort-Kriterium nicht
    // kennt.
    // Pagination („Später"): wenn ein Token vom Client mitkommt, geht's an
    // den Provider statt der Standard-Initial-Zeit. Hin-Pagination ONLY —
    // Rückfahrt bleibt der gleiche initial Call (kein Pagination-State
    // dafür gerechtfertigt, Rückfahrten zeigt der Client meist nur 1-2x).
    // `departTime` (vom Surroundings-Departure-Tap) verschiebt das Suchfenster
    // auf den konkreten Ziel-Zeitpunkt — ohne das würde HAFAS bei einem Klick
    // auf einen Zug 4h in der Zukunft womöglich nur Verbindungen ab "jetzt"
    // liefern (10er-Limit), und der Ziel-Zug wäre nicht in den Results.
    const outboundPromise = fetchJourneys(
      fromId,
      toId,
      input.departDate,
      signal,
      input.paginationToken,
      input.departTime,
    );
    const returnPromise = input.returnDate
      ? fetchJourneys(toId, fromId, input.returnDate, signal)
      : Promise.resolve(null);

    const [outbound, returnLeg] = await Promise.all([outboundPromise, returnPromise]);

    // ZWEITE SEITE bei der Erstsuche.
    //
    // DB liefert pro Anfrage nur 5 Verbindungen — der `results`-Parameter wird
    // schlicht ignoriert (5, 10, 20 → immer 5, gemessen). Solange MOTIS parallel
    // lief, fiel das nicht auf; als alleinige Quelle wäre die Liste zu dünn.
    // Also blättern wir einmal nach (HAFAS-`laterThan`) und kommen auf ~10.
    //
    // Nur bei der ERSTSUCHE: Beim „Später"-Blättern schickt der Client bereits
    // einen paginationToken mit, dann wäre eine zweite Seite doppelt.
    let outbound2: JourneyFetch | null = null;
    const firstLaterRef = (outbound.raw as { laterRef?: string } | null)?.laterRef;
    if (outbound.ok && !input.paginationToken && firstLaterRef) {
      outbound2 = await fetchJourneys(fromId, toId, input.departDate, signal, firstLaterRef).catch(
        () => null,
      );
    }

    const durationMs = Date.now() - start;

    if (!outbound.ok) {
      return {
        results: [],
        raw: outbound.raw,
        statusCode: outbound.statusCode,
        durationMs,
      };
    }

    // Zeitzonen-RÜCKFALL. Die echten Zonen zieht parseJourneys aus den
    // Koordinaten der Halte, die DB mitliefert (dbStopTz/tz-lookup, offline).
    //
    // Hier stand ein Aufruf von resolveMotisPlace — also ein MOTIS-Geocode mitten
    // im DB-Pfad, nur um an eine Zone zu kommen, die wir längst selbst haben.
    // Das kostete 1-2 s pro Suche und hängte den primären Provider ausgerechnet
    // an die Quelle, die wir in die Reserve geschoben haben.
    //
    // Bleibt Europe/Berlin als Rückfall, falls ein Halt keine Koordinate trägt:
    // DBs Netz ist überwiegend CET, das ist der am wenigsten falsche Default.
    const tz = { origin: DEFAULT_TZ, destination: DEFAULT_TZ };

    const outboundResults: NormalizedResult[] = [
      ...parseJourneys(outbound.raw, input, tz),
      ...(outbound2?.ok ? parseJourneys(outbound2.raw, input, tz) : []),
    ].map((r) => ({ ...r, direction: "OUTBOUND" as const }));

    let returnResults: NormalizedResult[] = [];
    if (returnLeg?.ok) {
      returnResults = parseJourneys(
        returnLeg.raw,
        {
          ...input,
          origin: input.destination,
          destination: input.origin,
          originLabel: input.destLabel,
          destLabel: input.originLabel,
        },
        // Rückfahrt → Zonen tauschen, sonst zeigt die Rückreise die Abfahrt in
        // der Zeitzone des Hinreise-Starts.
        { origin: tz.destination, destination: tz.origin },
      ).map((r) => ({ ...r, direction: "RETURN" as const }));
    }

    // HAFAS-laterRef aus der OUTBOUND-Antwort rausziehen — den brauchen wir
    // für den „Später"-Knopf im Result-Screen. Bei Round-Trips nutzen wir
    // weiterhin den Outbound-laterRef (Pagination immer auf Hinrichtung).
    // „Später" muss hinter der ZWEITEN Seite weitermachen — sonst lieferte es
    // genau die Verbindungen, die schon in der Liste stehen.
    const lastRaw = (outbound2?.ok ? outbound2.raw : outbound.raw) as { laterRef?: string } | null;
    const paginationToken = lastRaw?.laterRef;

    return {
      results: [...outboundResults, ...returnResults],
      raw: returnLeg
        ? { outbound: outbound.raw, return: returnLeg.raw }
        : outbound.raw,
      statusCode: outbound.statusCode,
      durationMs,
      paginationToken,
    };
  },
};

interface JourneyFetch {
  ok: boolean;
  raw: unknown;
  statusCode: number;
}

/** Heutiges Datum (Europe/Berlin) im ISO-Format `YYYY-MM-DD`. */
function todayInBerlin(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());
}

/** Aktuelle Berlin-Zeit auf die nächst-untere 5-Min-Marke abgerundet (z.B.
 *  15:36 → "15:35", 15:34 → "15:30"). Damit kriegt der User auf seine „jetzt
 *  los"-Such auch Verbindungen die wenige Minuten in der Vergangenheit
 *  losgefahren sind (nützlich am Bahnsteig). */
function nowFloor5MinBerlin(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")?.value ?? "08";
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const floored = Math.floor(m / 5) * 5;
  return `${h}:${String(floored).padStart(2, "0")}`;
}

/** Wählt die Start-Uhrzeit für die initiale Such-Anfrage. Bei „heute" snappen
 *  wir auf den aktuellen 5-Min-Floor — damit fängt der User auf eine ad-hoc-
 *  Anfrage die nächsten echten Verbindungen ab. An zukünftigen Tagen starten
 *  wir bei 05:00, was die frühen Pendlerzüge mitnimmt. */
function initialDepartureTime(date: string): string {
  return date === todayInBerlin() ? nowFloor5MinBerlin() : "05:00";
}

async function fetchJourneys(
  fromId: string,
  toId: string,
  date: string,
  signal?: AbortSignal,
  laterRef?: string,
  targetDepartTime?: string,
): Promise<JourneyFetch> {
  // EIN Call — entweder neue Suche ab Zeit-Floor, oder Folge-Seite per
  // HAFAS-`laterThan`. Pagination („gesamter Tag") explizit user-getriggered
  // via separatem Endpoint (search.ts route) — kein eager loop hier, sonst
  // würde ein einzelner Such-Klick 5 User-Slots verbrennen.
  const url = new URL(`${config.DBWEB_BASE_URL}/journeys`);
  url.searchParams.set("from", fromId);
  url.searchParams.set("to", toId);
  if (laterRef) {
    url.searchParams.set("laterThan", laterRef);
  } else if (targetDepartTime) {
    // Ziel-Zeit-Targeting: HAFAS wünscht das `departure`-Feld als ISO. Wir
    // setzen es leicht VOR die Ziel-Zeit (-5 Min Floor), damit der Ziel-Zug
    // mit höherer Wahrscheinlichkeit IN den 10 Result-Slots landet. Ohne
    // diesen Offset hätten wir bei punktgenauer Zeit das Risiko, dass HAFAS
    // den Zug knapp davor noch reinpackt und unseren rauskickt.
    const targetMs = Date.parse(targetDepartTime);
    if (Number.isFinite(targetMs)) {
      url.searchParams.set("departure", new Date(targetMs - 5 * 60_000).toISOString());
    } else {
      const d = date.slice(0, 10);
      url.searchParams.set("departure", `${d}T${initialDepartureTime(d)}`);
    }
  } else {
    // `date` kommt als volle ISO (input.departDate, z.B. 2026-07-08T08:00:00.000Z)
    // rein — hier brauchen wir aber NUR den Datumsteil, sonst entsteht
    // `2026-07-08T08:00:00.000ZT05:00` → db-vendo-client wirft SyntaxError.
    const d = date.slice(0, 10);
    url.searchParams.set("departure", `${d}T${initialDepartureTime(d)}`);
  }
  url.searchParams.set("results", "10");
  url.searchParams.set("language", "de");
  url.searchParams.set("stopovers", "true");

  const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
  const raw = (await res.json().catch(() => null)) as unknown;
  return { ok: res.ok && raw !== null, raw, statusCode: res.status };
}

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

  // StaDa-Import: bei DE-Stationen sind code-Suffix und hafasId identisch und
  // werden von DB-HAFAS direkt verstanden. Bei AT/CH/BE/NL etc. ist die
  // gespeicherte hafasId NICHT zwingend die DB-HAFAS-kompatible ID:
  //   - AT: obb_id ist ÖBB-internal (z.B. Wien Hbf = 8103000), DB-HAFAS
  //     interpretiert das aber als andere Station (Wien Blumental o.ä.)
  //   - CH: cff_id ist SBB-internal, gleiches Problem
  //   - BE: UIC 88xxxxx vs DB-internal 88xxx (siehe Bruxelles-Midi)
  // Für non-DE: stored hafasId nur als Hint nehmen, aber via Label-Lookup
  // (mit allWordsMatch-Filter) gegen DB-HAFAS verifizieren/auflösen. Für DE
  // kürzen wir ab und nehmen die stored ID direkt.
  //
  // Findet der Label-Lookup nichts, greifen wir am Ende doch auf die gespeicherte
  // ID zurück — besser ein unsicherer Treffer als gar keiner.
  let storedFallback: string | null = null;

  const stadaMatch = code.match(/^sta:(\d{7})$/);
  if (stadaMatch && stadaMatch[1]) {
    const dbHit = await db
      .select({ hafasId: locations.hafasId, country: locations.country })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    const storedHafasId = dbHit[0]?.hafasId ?? null;
    const country = dbHit[0]?.country ?? null;
    // DE-Stationen: direkt nutzen (UIC = DB-HAFAS-ID).
    if (country === "Germany" && storedHafasId) {
      return storedHafasId;
    }
    storedFallback = storedHafasId;
    // Non-DE: Label-Lookup fallthrough unten ist robuster. Wir hängen aber
    // die stored ID als zusätzlichen Candidate dran (falls Label nicht in
    // HAFAS findbar ist).
    // Continue past this block → label-based lookup mit candidates [label,
    // ...] greift.
  }

  // Steuert, ob beim Label-Lookup unten auch 6-stellige HAFAS-IDs (= Bus-/
  // Tram-Haltestellen) als Treffer zählen. Standard: NEIN (nur 7-stellige
  // Bahnhöfe), sonst würde eine Zug-Suche auf eine Bushaltestelle rutschen.
  // Für BUS-Stops MUSS es aber AN sein — sonst hat „Werl, Markt" (gtfs, type=BUS)
  // keinen 7-stelligen Treffer und landet beim Bahnhof „Werl" (HAFAS kennt die
  // Bushaltestelle nur als 6-stellige id 414408 „Markt, Werl").
  let allowBusStops = false;

  // GTFS-Import: einige Stop-IDs sind direkt UIC-konform (7-stellig).
  // Manche haben aber Hyphen-Format wie "de:01:5100:1:1" — in dem Fall haben
  // wir hafas_id beim Import in der DB gespeichert. DB-Lookup statt Live-Call.
  if (code.startsWith("gtfs:")) {
    const dbHit = await db
      .select({
        hafasId: locations.hafasId,
        type: locations.type,
        country: locations.country,
      })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    const stored = dbHit[0]?.hafasId ?? null;

    // NUR für deutsche Stops die gespeicherte ID blind übernehmen. Im Ausland
    // stammt sie aus dem dortigen Feed und ist NICHT DBs Nummer — DB kennt sie
    // dann nicht und liefert null Verbindungen.
    //
    // Gemessen an Basel Bad Bf: ein DEUTSCHER Bahnhof auf Schweizer Boden, mit
    // zwei Identitäten. Unser Eintrag stammt aus dem CH-Feed und trägt 8500090
    // (die SBB-Nummer); DB kennt ihn als 8000026. Ergebnis: db-vendo lieferte 0,
    // die Suche fiel auf MOTIS zurück — ohne Preise und deutlich langsamer.
    //
    // Für Auslands-Stops also denselben Weg wie bei sta:-Codes gehen: über den
    // NAMEN gegen DBs eigene Ortssuche auflösen (die liefert 8000026), und die
    // gespeicherte ID nur als letzten Rückfall behalten.
    if (dbHit[0]?.country === "Germany" && stored) return stored;
    storedFallback = stored;

    if (dbHit[0]?.type === "BUS") allowBusStops = true;
    // Kein hafas_id beim Import → fällt durch zum Live-Lookup via Name.
  }

  // OSM-Stop: hat selber keine hafas_id, aber wir finden eine via Coord-Match
  // auf einen nahgelegenen StaDa-Stop. Damit kennt HAFAS den Ort und Routing
  // klappt. Verhindert dass „Wien Hauptbahnhof (OSM)" auf einen entfernten
  // Stop wie „Inzersdorf Wien Blumental" gemapped wird via Label-Lookup.
  if (code.startsWith("osm:")) {
    const dbHit = await db
      .select({
        latitude: locations.latitude,
        longitude: locations.longitude,
      })
      .from(locations)
      .where(eq(locations.code, code))
      .limit(1);
    const row = dbHit[0];
    if (row?.latitude && row?.longitude) {
      const lat = Number(row.latitude);
      const lon = Number(row.longitude);
      // Bbox-Filter ~200m, dann sortieren nach Distanz und nächsten StaDa-Stop
      // mit hafas_id nehmen.
      const dLat = 0.0018;
      const dLon = 0.0018 / Math.cos((lat * Math.PI) / 180);
      const nearest = await db.execute(sql`
        SELECT hafas_id FROM locations
        WHERE hafas_id IS NOT NULL
          AND latitude::float BETWEEN ${lat - dLat} AND ${lat + dLat}
          AND longitude::float BETWEEN ${lon - dLon} AND ${lon + dLon}
        ORDER BY (latitude::float - ${lat}) * (latitude::float - ${lat})
               + (longitude::float - ${lon}) * (longitude::float - ${lon})
        LIMIT 1
      `);
      const rows = (nearest as unknown as { rows: Array<{ hafas_id: string }> }).rows ?? [];
      if (rows[0]?.hafas_id) return rows[0].hafas_id;
    }
  }

  // Candidate-Reihenfolge ist relevant: zuerst probieren wir die deutsche
  // Variante des Labels (mit Stadt-Aliasen), dann das Original, dann den Code.
  // Hintergrund: HAFAS DB ist auf deutsche Bezeichnungen optimiert. Wenn
  // unsere App das englische Label „Munich Odeonsplatz" schickt, liefert
  // HAFAS zwar „München Odeonsplatz" mit zurück — aber unser 4-Char-Prefix-
  // Match („muni" vs „munc") schmeißt das raus. Der Aliasing-Pass davor
  // baut die Anfrage zu „München Odeonsplatz" um und der Prefix matcht.
  const localized = label ? applyCityAlias(label) : undefined;
  const candidates = [localized, label, code]
    .filter((x, i, arr): x is string => typeof x === "string" && x.length > 0 && arr.indexOf(x) === i);
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    const cached = stationCache.get(key);
    if (cached) return cached;

    // /locations (HAFAS) statt /stations (nur DE-Stationsdaten) — auf diese Art
    // werden auch internationale Bahnhöfe wie Amsterdam Centraal, Paris Gare
    // du Nord, Wien Hbf etc. gefunden.
    const url = new URL(`${config.DBWEB_BASE_URL}/locations`);
    url.searchParams.set("query", candidate);
    url.searchParams.set("results", "5");
    url.searchParams.set("stops", "true");
    url.searchParams.set("addresses", "false");
    url.searchParams.set("poi", "false");

    const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
    if (!res.ok) continue;
    const data = (await res.json().catch(() => null)) as Record<string, DbStation> | DbStation[] | null;
    if (!data) continue;
    const list: DbStation[] = Array.isArray(data) ? data : Object.values(data);
    // Standard: nur echte Bahnhöfe — 7-stellige UIC-ID (z.B. 8000584). HAFAS
    // liefert sonst auch Bushaltestellen (6-stellig, z.B. 414408 „Markt, Werl").
    // AUSNAHME: wenn wir gerade einen BUS-Stop auflösen (allowBusStops), zählen
    // 6-stellige Treffer mit — sonst kann eine echte Bushaltestelle gar nicht
    // aufgelöst werden.
    //
    // Matching: ALLE Wörter aus der Query müssen im HAFAS-Namen vorkommen,
    // mit Hbf/Hauptbahnhof als Synonyme (sonst matched „Wien Hbf" auf
    // „Wien Blumental" — beide starten mit „wien", aber Blumental landet
    // im Result-Set zuerst). Plus: bevorzugt Treffer wo „hbf"/„hauptbahnhof"
    // vorkommt wenn die Query danach fragt — sonst greift HAFAS bei breiten
    // Queries („wien") gerne den nächstbesten kleineren Stop ab.
    const matchAll = (name: string) => allWordsMatch(name, candidate);
    const idPattern = allowBusStops ? /^\d{6,7}$/ : /^\d{7}$/;
    const matches = list.filter(
      (s) =>
        typeof s?.id === "string" &&
        idPattern.test(s.id) &&
        typeof s.name === "string" &&
        matchAll(s.name),
    );
    if (matches.length === 0) continue;

    // Reihenfolge: erst wie GUT der Name passt, dann wie kurz er ist.
    //
    // „Kürzester Name gewinnt" allein war ein Reinfall. `allWordsMatch` prüft
    // TEILSTRINGS, nicht Wörter — „Rom" steckt also auch in „Romanita" (einem
    // italienischen Dorf). Und „Romanita" (8 Zeichen) ist kürzer als
    // „ROM (Italien)" (12). Dortmund → Rom endete damit nach 23 Stunden in
    // Romanita, obwohl DBs Suche „ROM (Italien)" korrekt an erster Stelle hatte.
    //
    // Jetzt: Exakter Name schlägt Wort-Treffer schlägt bloßen Teilstring. Die
    // Kürze entscheidet erst innerhalb derselben Güteklasse — dort tut sie, wozu
    // sie gedacht war (Hauptbahnhof vor „Wien Hbf Bahnsteig 7").
    const wantedNorm = normalizeForMatch(candidate);
    const wantedWords = wantedNorm.split(/\s+/).filter(Boolean);
    const matchScore = (name: string): number => {
      const norm = normalizeForMatch(name);
      if (norm === wantedNorm) return 3;
      const nameWords = new Set(norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
      const allWhole = wantedWords.every((w) => {
        const variants = STATION_SYNONYMS[w] ?? [w];
        return variants.some((v) => nameWords.has(v));
      });
      return allWhole ? 2 : 1;
    };
    matches.sort(
      (a, b) =>
        matchScore(b.name ?? "") - matchScore(a.name ?? "") ||
        (a.name?.length ?? 999) - (b.name?.length ?? 999),
    );
    const first = matches[0];
    if (first?.id) {
      stationCache.set(key, first.id);
      return first.id;
    }
  }
  return storedFallback;
}

/** Lowercase + Diakritika-Entfernung für robusten Name-Vergleich.
 *  z.B. "Köln Hbf" → "koln hbf", "Höfingen" → "hofingen", "Hoefkade" → "hoefkade".
 *  Diakritika werden via NFD-Zerlegung + Combining-Marks-Strip entfernt. */
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Synonyme für Bahnhof-Bezeichnungen — manche HAFAS-Stationen labeln „Hbf",
 *  andere „Hauptbahnhof"; manche „Westbf", andere „Westbahnhof". Compound-
 *  Patterns abdecken damit „Wien Westbahnhof" auch „Wien Westbf" findet. */
const STATION_SYNONYMS: Record<string, string[]> = {
  hbf: ["hbf", "hauptbahnhof"],
  hauptbahnhof: ["hbf", "hauptbahnhof"],
  bf: ["bf", "bahnhof"],
  bahnhof: ["bf", "bahnhof"],
  westbahnhof: ["westbahnhof", "westbf"],
  westbf: ["westbahnhof", "westbf"],
  ostbahnhof: ["ostbahnhof", "ostbf"],
  ostbf: ["ostbahnhof", "ostbf"],
  nordbahnhof: ["nordbahnhof", "nordbf"],
  nordbf: ["nordbahnhof", "nordbf"],
  südbahnhof: ["südbahnhof", "südbf"],
  südbf: ["südbahnhof", "südbf"],
  sudbahnhof: ["sudbahnhof", "sudbf"],
  sudbf: ["sudbahnhof", "sudbf"],
};

/** True wenn JEDES Wort aus der Query im Namen vorkommt. Mit Synonym-
 *  Erweiterung für Hbf/Bahnhof-Compounds. Wenn ein Wort >= 5 Zeichen hat
 *  und kein direkter Match: fall back auf 4-Char-Prefix-Match (deckt
 *  Spelling-Varianten und ungewöhnliche Compound-Formen ab). */
function allWordsMatch(name: string, query: string): boolean {
  const nameNorm = normalizeForMatch(name);
  const queryWords = normalizeForMatch(query).split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return false;
  return queryWords.every((w) => {
    const variants = STATION_SYNONYMS[w] ?? [w];
    if (variants.some((v) => nameNorm.includes(v))) return true;
    // Lenient-Fallback: für Wörter ≥ 5 Zeichen reicht der 4-Char-Prefix
    // im Namen. So matched „Westbahnhof" (12 chars) gegen „westbf" via
    // Prefix „west", und unbekannte Compound-Formen werden mitgenommen.
    if (w.length >= 5) {
      return nameNorm.includes(w.slice(0, 4));
    }
    return false;
  });
}

/** Englische Stadt-Namen → deutsche Schreibweise für HAFAS-Lookup. HAFAS DB
 *  versteht die englischen Varianten oft (HAFAS returnt sie sogar), aber
 *  unser strikter 4-Char-Prefix-Match (gegen die HAFAS-Resultate, die
 *  meist im deutschen Namensraum liegen) braucht den DE-Namen schon in
 *  der Anfrage. */
function applyCityAlias(label: string): string {
  const aliases: Record<string, string> = {
    munich: "München",
    cologne: "Köln",
    vienna: "Wien",
    nuremberg: "Nürnberg",
    geneva: "Genf",
    zurich: "Zürich",
    prague: "Prag",
    warsaw: "Warschau",
  };
  let result = label;
  for (const [en, de] of Object.entries(aliases)) {
    // Word-Boundary (\b) damit "Munich" matched, "communicate" aber nicht.
    result = result.replace(new RegExp(`\\b${en}\\b`, "gi"), de);
  }
  return result;
}

/**
 * Im BUS-Modus nur Verbindungen, die WIRKLICH aus Bussen bestehen.
 *
 * db-vendo hängt in zwei Registries (Zug UND Bus) und filterte nicht — er
 * lieferte in die Bus-Suche Dortmund → Frankfurt schlicht ICEs („ICE 529, 0
 * Umstiege"). Ich hatte ihn deshalb aus dem Bus-Modus geworfen. Das war zu grob:
 * Damit fiel auch der LOKALE Busverkehr weg, den nur er findet — für
 * „Werl, Petrischule → Werl, Bahnhof" ist er die einzige Quelle, die den Bus 522
 * kennt (MOTIS prunt ihn weg, weil das Ziel in Gehweite liegt).
 *
 * Also: drin lassen, aber filtern. Ein Treffer zählt nur, wenn JEDE Fahrt darin
 * ein Bus ist. Anruf-Sammeltaxis (product „taxi", z.B. „RUF Helmo") fliegen mit
 * raus — die muss man telefonisch vorbestellen, in einer Bus-Trefferliste sind
 * sie irreführend (die Abfahrtstafeln blenden sie aus demselben Grund aus).
 */
function isBusOnly(r: NormalizedResult): boolean {
  const transit = (r.legs ?? []).filter((l) => !l.walking);
  return transit.length > 0 && transit.every((l) => l.product === "bus");
}

function parseJourneys(
  raw: unknown,
  input: ProviderSearchInput,
  tz: { origin: string; destination: string },
): NormalizedResult[] {
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

    // Zonen der Endpunkte aus den Koordinaten der Halte (DB liefert sie mit).
    const tripOriginTz = dbStopTz(first.origin);
    const tripDestTz = dbStopTz(last.destination);

    // ACHTUNG, DB-Eigenheit: Die Zeitstempel tragen den Offset des STARTORTS an
    // JEDEM Halt — auch an solchen in einer anderen Zeitzone. Für Köln → London
    // steht dort "13:57+02:00", gemeint ist aber 13:57 LONDONER Zeit (der
    // Eurostar Brüssel→London braucht 2 h; mit +02:00 gelesen wären es 1 h —
    // unmöglich). Der Offset ist also gelogen; die Uhrzeit selbst ist die
    // ORTSZEIT des jeweiligen Halts.
    //
    // Darum: Offset wegwerfen, Uhrzeit in der ECHTEN Zone des Halts als Ortszeit
    // lesen. Sonst wären UTC-Zeitpunkt UND Reisedauer bei jeder Fahrt über eine
    // Zeitzonengrenze um Stunden falsch.
    const departIso = dbTimeToUtc(first.plannedDeparture ?? first.departure, tripOriginTz);
    const arriveIso = dbTimeToUtc(last.plannedArrival ?? last.arrival, tripDestTz);
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
      const segOriginTz = dbStopTz(seg.origin);
      const segDestTz = dbStopTz(seg.destination);
      const segDep = dbTimeToUtc(seg.plannedDeparture ?? seg.departure, segOriginTz);
      const segArr = dbTimeToUtc(seg.plannedArrival ?? seg.arrival, segDestTz);
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
          arrival: dbTimeToUtc(s.plannedArrival ?? s.arrival, dbStopTz(s.stop)) ?? undefined,
          departure: dbTimeToUtc(s.plannedDeparture ?? s.departure, dbStopTz(s.stop)) ?? undefined,
          platform: s.plannedArrivalPlatform ?? s.arrivalPlatform ?? s.plannedDeparturePlatform ?? s.departurePlatform,
        }))
        .filter((s) => s.name);
      legs.push({
        origin: seg.origin?.id ?? "",
        destination: seg.destination?.id ?? "",
        originLabel: seg.origin?.name,
        destLabel: seg.destination?.name,
        originLat: seg.origin?.location?.latitude,
        originLng: seg.origin?.location?.longitude,
        destLat: seg.destination?.location?.latitude,
        destLng: seg.destination?.location?.longitude,
        departTime: segDep,
        arriveTime: segArr,
        durationMinutes: segDuration,
        departPlatform: cleanPlatform(seg.plannedDeparturePlatform ?? seg.departurePlatform),
        arrivePlatform: cleanPlatform(seg.plannedArrivalPlatform ?? seg.arrivalPlatform),
        // Zone DIESES Halts aus dem Offset des Zeitstempels ("…+02:00"). DB
        // liefert keine IANA-Namen, aber der Offset reicht zum Anzeigen — sonst
        // stünde ein Umstieg in London in Berliner Zeit.
        originTz: segOriginTz,
        destTz: segDestTz,
        line: lineLabel(seg.line),
        product: seg.line?.product,
        fahrtNr: seg.line?.fahrtNr,
        direction: seg.direction,
        stops: stopovers.length,
        stopovers: stopovers.length > 0 ? stopovers : undefined,
        tripId: seg.tripId,
      });
    }

    // db-rest liefert für Regional-/Verbund-Verbindungen oft keinen Preis
    // (VRR/VRS/MVV usw. werden nicht über DB-Tarif gebucht). Wir zeigen sie
    // trotzdem mit price=0 — UI rendert dann "Tarif beim Anbieter".
    const rawPrice = journey.price?.amount;
    const perPaxPrice = typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : 0;
    // db-rest /journeys liefert den Preis pro Person — HAFAS hat keinen
    // passengers-Param, der die Suche selbst beeinflusst. Damit `passengers`
    // im UI nicht ignoriert wirkt, skalieren wir den Gesamtpreis hier.
    const pax = Math.max(1, input.passengers ?? 1);
    const priceNum = perPaxPrice > 0 ? Math.round(perPaxPrice * pax * 100) / 100 : 0;

    const operatedBy =
      first.line?.operator?.name ??
      (first.line?.product === "national" ? "DB Fernverkehr" : first.line?.productName);

    const refresh = journey.refreshToken ?? "";
    const externalId = `dbrest:${refresh.slice(0, 64) || i}`;

    out.push({
      externalId,
      // Der GESUCHTE Binch-Code, nicht die intern aufgelöste HAFAS-Station-ID.
      // `origin`/`destination` sind laut API-Vertrag Binch-Codes; hier stand
      // vorher `first.origin.id` (= "8000080"), während MOTIS für dieselbe Suche
      // "sta:8000080" liefert. Der Dedupe-Fingerprint enthält origin->destination
      // — dieselbe Fahrt kam dadurch DOPPELT in die Liste, einmal je Provider
      // (verifiziert: ICE 915, gleiche Minute, gleiche Labels, zwei Einträge).
      origin: input.origin,
      destination: input.destination,
      originLabel: first.origin?.name ?? input.originLabel,
      destLabel: last.destination?.name ?? input.destLabel,
      departTime: departIso,
      arriveTime: arriveIso,
      // Zonen aus den Koordinaten der ECHTEN Endhalte dieser Verbindung — genauer
      // als die Auflösung über den gesuchten Ort (der User sucht „Köln", der Zug
      // fährt ab „Köln Messe/Deutz"). Fällt die Koordinate aus, greift die
      // geteilte Orts-Auflösung als Rückfall.
      originTz: tripOriginTz ?? tz.origin,
      destinationTz: tripDestTz ?? tz.destination,
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
        input.passengers,
      ),
      // Kopfzeile des Treffers: „ICE 915", „RE 10025" — nie eine nackte
      // Zugnummer (DB liefert für viele Regionalzüge nur fahrtNr, die Gattung
      // steckt separat in productName; siehe util/line.ts).
      flightNumber: lineLabel(first.line),
      operatedBy,
      providerLogo: "https://www.bahn.de/web-app/favicons/bahn-favicon.svg",
    });
  }
  return input.mode === "BUS" ? out.filter(isBusOnly) : out;
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
  passengers: number,
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
  // bahn.de Reisende-Format: `r=<ageFrom>:<ageTo>:KLASSENLOS:<count>` für N
  // Erwachsene ohne Bahncard. Mehrere Reisende werden über mehrere `r=`-
  // Parameter ausgedrückt — eines pro Person (so verhält sich bahn.de selbst).
  const pax = Math.max(1, Math.min(9, passengers));
  const r = Array.from({ length: pax }, () => `r=13:16:KLASSENLOS:1`).join("&");
  const fragment = `soid=${soid}&zoid=${zoid}&hd=${hd}&kl=2&${r}`;
  return `https://www.bahn.de/buchung/fahrplan/suche#${fragment}`;
}
