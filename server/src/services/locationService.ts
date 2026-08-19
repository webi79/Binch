import { ilike, or, and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import type { LocationType } from "../db/schema.js";
import { flixbusLiveLocations, dbRestLiveLocations } from "./liveLocations.js";
import { exonymQueryVariants } from "../util/cityExonyms.js";

export interface ClientLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: LocationType;
  /** GPS-Koordinaten. Nach StaDa- und GTFS-Import in der DB hinterlegt → kein
   *  Live-Call mehr nötig. Frontend nutzt das für Map-Fly-To im Surroundings-Tab. */
  latitude?: number;
  longitude?: number;
  /** HAFAS-Station-ID (UIC 7-stellig). Wenn gesetzt → Trip-Search kann die
   *  Station direkt verwenden, ohne db-rest-Live-Lookup für die ID-Auflösung. */
  hafasId?: string;
}

/**
 * Sucht Locations für die Autocomplete.
 *
 * Strategie nach StaDa+GTFS-Import (alle relevanten Stations + Stops liegen
 * lokal mit Coords + HAFAS-IDs vor):
 *   - FLIGHT/CRUISE: ausschließlich lokale DB (wie immer)
 *   - ALL:           ausschließlich lokale DB → KEINE Live-Calls mehr! Spart
 *                    pro Surroundings-Search alle db-rest/FlixBus-Calls.
 *   - TRAIN/BUS:     lokale DB zuerst. Live-Fallback NUR wenn die lokale Suche
 *                    wenige Treffer liefert (Tippfehler, neue Stationen).
 *                    Reduziert Live-Calls drastisch — typische User-Queries
 *                    werden komplett offline beantwortet.
 *
 * Live-Quellen werden parallel gefetcht und mit lokalen Treffern gemerged.
 * Dedup: über `code`. Bei externen Treffern hat der `code`-Prefix das Format
 * `flix:<uuid>` bzw. `dbrest:<id>`, lokale Einträge haben `sta:<uic>` oder `gtfs:<id>`.
 */
/** Wenn lokal weniger als so viele Treffer kommen, fragen wir Live nach. */
const LIVE_FALLBACK_THRESHOLD = 3;

export async function searchLocations(
  query: string,
  type: LocationType | "ALL",
  limit = 20,
): Promise<ClientLocation[]> {
  const q = query.trim();
  if (q.length < 1) return [];

  // searchLocalDb braucht ein höheres Limit als das finale Output-Limit, weil
  // mergeAndCap räumlich dedupt — wenn 2 von 20 Rows dupes sind, würden wir
  // nach Dedup nur 18 ausspucken statt 20. Mit 2× Limit ist Puffer da.
  const fetchLimit = limit * 2;

  // Sprach-Fallback via Exonyme: Die Datenquellen sind sprachlich gemischt
  // (Airports englisch „Vienna", StaDa deutsch „Wien Hbf"). Tippt der User
  // (oder übergibt Bo) „Wien" im Flug-Modus, findet ILIKE nichts — obwohl
  // VIE gemeint ist. Bei 0 lokalen Treffern probieren wir die übersetzten
  // Varianten; die Originalschreibweise gewinnt immer, wenn sie selbst trifft.
  const searchWithExonyms = async (): Promise<ClientLocation[]> => {
    const direct = await searchLocalDb(q, type, fetchLimit);
    if (direct.length > 0) return direct;
    for (const variant of exonymQueryVariants(q)) {
      const alt = await searchLocalDb(variant, type, fetchLimit);
      if (alt.length > 0) return alt;
    }
    return direct;
  };

  if (type === "ALL") {
    const dbResults = await searchWithExonyms();
    return mergeAndCap(dbResults, limit);
  }

  const dbResults = await searchWithExonyms();

  if ((type === "BUS" || type === "TRAIN") && dbResults.length < LIVE_FALLBACK_THRESHOLD) {
    // Lokal zu wenig — Live als Fallback befragen.
    const live = type === "BUS" ? flixbusLiveLocations(q) : dbRestLiveLocations(q);
    const liveResults = await live.catch(() => []);
    return mergeAndCap([...dbResults, ...liveResults], limit);
  }

  return mergeAndCap(dbResults, limit);
}

async function searchLocalDb(
  q: string,
  type: LocationType | "ALL",
  limit: number,
): Promise<ClientLocation[]> {
  // Multi-Wort-Suche: jedes Wort muss IRGENDWO in (label, city, country, code)
  // vorkommen. Beispiel: „Willich Anrath" splittet zu ["willich", "anrath"]
  //   → Treffer wenn city="Willich" UND label enthält "anrath"
  //   → Anrath Bahnhof (city=Willich) wird gefunden
  // Wenn die Suche einzeln gelassen würde („%willich anrath%"), würde nichts
  // matchen weil kein einziges Feld die exakte Sequenz enthält.
  // Bidirektionale Synonym-Expansion: DB-Labels sind inkonsistent — manche
  // StaDa-Einträge labeln „Hbf", andere „Hauptbahnhof"; manche OSM-Stops
  // labeln „Bahnhof", manche „Station". Wir müssen pro Wort ALLE bekannten
  // Varianten in die OR-Klausel packen, sonst matched „Wien Hbf" nicht gegen
  // DB-Label „Wien Hauptbahnhof" (und Top-Match wäre dann ein zufälliger
  // kleinerer Stop wie „Wien Blumental").
  const SYNONYMS: Record<string, string[]> = {
    hbf: ["hbf", "hauptbahnhof"],
    hauptbahnhof: ["hbf", "hauptbahnhof"],
    bf: ["bf", "bahnhof"],
    bahnhof: ["bahnhof", "bf"],
  };
  // Split nicht nur an Whitespace sondern auch an Bindestrich/Slash/Komma —
  // sonst matched „Bruxelles-Midi" nur exakt gegen Labels mit Bindestrich.
  // Wenn die DB „Bruxelles Midi" (ohne Strich) oder „Bruxelles, Midi" hat,
  // greift das Wort-Filter sonst nicht. Diese Trenner sind in Station-Namen
  // immer optional.
  const words = q.toLowerCase().split(/[\s\-/,]+/).filter(Boolean);
  // Station-Suffix-Wörter sind in DB-Labels oft NICHT enthalten — kleinere
  // Stationen heißen einfach „Werl" / „Lippstadt" / „Hamm", ohne „Hauptbahnhof".
  // Wenn der User „Werl Hauptbahnhof" tippt würde der strikte AND-Filter
  // beide Wörter verlangen → 0 Treffer obwohl Werl in der DB ist.
  // Deshalb: Suffix-Wörter NICHT als Required-Filter, nur in Ranking-Score.
  // (Wenn der User NUR „Hbf" tippt, fällt's auf alle Wörter zurück damit
  // wenigstens Großstadt-Hbf's matchen.)
  const STATION_SUFFIXES = new Set([
    "hbf",
    "hauptbahnhof",
    "bahnhof",
    "bf",
    "station",
    "airport",
    "flughafen",
  ]);
  const nonSuffixWords = words.filter((w) => !STATION_SUFFIXES.has(w));
  const filterWords = nonSuffixWords.length > 0 ? nonSuffixWords : words;
  const wordFilters = filterWords.map((word) => {
    const variants = SYNONYMS[word] ?? [word];
    const conditions = variants.flatMap((v) => {
      const like = `%${v}%`;
      return [
        ilike(locations.label, like),
        ilike(locations.city, like),
        ilike(locations.country, like),
        ilike(locations.code, like),
      ];
    });
    return or(...conditions);
  });
  const textFilter = wordFilters.length > 1 ? and(...wordFilters) : wordFilters[0];

  // Mode-spezifische Filter:
  //   - FLIGHT/CRUISE: nur exakter Type
  //   - TRAIN: TRAIN + BUS + ALL — der User soll im Zug-Modus AUCH Bus-Stationen
  //     finden (Bahn + Bus in einem Rutsch suchen). dbVendo (HAFAS) ist
  //     intermodal und routet von/zu Bus-Stops genauso; FlixBus läuft im
  //     TRAIN-Modus NICHT mit (siehe Registry). Tram/U-Bahn-Stops bleiben
  //     ebenfalls drin (schedule-only Departures via transitScheduleProvider).
  //   - BUS: BUS + ALL — nur Bus-Stationen (+ Cities), KEINE Bahnhöfe.
  //   - ALL: kein Filter, alles erlaubt
  let typeFilter;
  if (type === "FLIGHT" || type === "CRUISE") {
    typeFilter = eq(locations.type, type);
  } else if (type === "TRAIN") {
    typeFilter = or(
      eq(locations.type, "TRAIN"),
      eq(locations.type, "BUS"),
      eq(locations.type, "ALL"),
    );
  } else if (type === "BUS") {
    typeFilter = or(eq(locations.type, "BUS"), eq(locations.type, "ALL"));
  } else {
    typeFilter = undefined;
  }

  const where = typeFilter ? and(textFilter, typeFilter) : textFilter;

  // Ranking-Logik (von oben nach unten priorisiert):
  //   1. EXAKTER Label-Match (Query = Label, case-insensitive) — Stadt
  //      „Amsterdam" matched vor Bus-Stop „Amsterdam" in Lyon
  //   2. TYPE-Priorität: Cities (type=ALL) vor Major-Stations vor Bus-Stops
  //      Das sortiert „NL-AMS Amsterdam (ALL)" vor osm-Bus-Stops „Amsterdam"
  //   3. Prefix-Match: Label fängt mit Query an > City fängt mit Query an >
  //      sonstwo enthalten
  //   4. Kürzeres Label first (typisch der prominentere Stop)
  const firstWord = words[0] ?? "";
  const prefixLabelLike = `${firstWord}%`;
  const prefixCityLike = `${firstWord}%`;
  const fullQuery = q.trim().toLowerCase();

  // ALLE-Query-Wörter-im-LABEL Score: zählt wie viele der User-Wörter im
  // Label vorkommen (mit Synonym-Erweiterung für hbf/hauptbahnhof). Höher =
  // bessere Übereinstimmung. Sortiert DESC. Beispiel:
  //   Query „Wien Hbf" → Wörter: wien, hbf (+ hauptbahnhof als Synonym)
  //   - Label „Wien Hauptbahnhof" → Score 2 (beide gefunden)
  //   - Label „Wien Blumental"    → Score 1 (nur „wien")
  // Damit kann der prominente Hauptbahnhof nicht durch kürzeren Tiebreaker
  // von z.B. „Wien Blumental" überholt werden.
  /**
   * GANZE Wörter, in Label ODER Stadt. Läuft VOR der Teilstring-Wertung.
   *
   * Die Wertung darunter sucht mit `%wort%`, also mitten im Wort. Bei einer
   * kuratierten Liste ging das durch; mit allen Flughäfen weltweit nicht mehr:
   * Auf „Rome" zählten „Romeu Zema" (Brasilien), „Split Saint Jerome" und
   * „…Óscar Arnulfo Romero…" als Treffer und standen damit vor Rom Ciampino —
   * das aus der Liste komplett verschwand, obwohl sein Stadtfeld exakt „Rome"
   * lautet. Es stand nur nicht im NAMEN, und die Stadt kam in der Wertung gar
   * nicht vor.
   *
   * `\m` und `\M` sind Postgres' Wortgrenzen. Wichtig ist die Grenze auf
   * BEIDEN Seiten: Nur links gesetzt, wäre „Romeu" weiterhin ein Treffer.
   *
   * Diese Stufe kann die vorhandene Reihenfolge nicht durcheinanderbringen,
   * denn sie ist ein reiner Zugewinn: Tippt jemand noch („Frankf"), trifft sie
   * nirgends, alle Zeilen stehen gleich, und es entscheidet die Kette darunter
   * genau wie vorher. Sie schlägt nur an, wenn ein Wort wirklich fertig
   * getippt ist — und dann ist Vorziehen immer richtig.
   */
  const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wholeWordParts = words.map((word) => {
    const variants = SYNONYMS[word] ?? [word];
    const ors = variants.flatMap((v) => {
      const re = `\\m${escapeRe(v)}\\M`;
      return [sql`${locations.label} ~* ${re}`, sql`${locations.city} ~* ${re}`];
    });
    return sql`(CASE WHEN ${sql.join(ors, sql` OR `)} THEN 1 ELSE 0 END)`;
  });
  const wholeWordScore =
    wholeWordParts.length > 0 ? sql.join(wholeWordParts, sql` + `) : sql`0`;

  const labelWordScoreParts = words.map((word) => {
    const variants = SYNONYMS[word] ?? [word];
    const ors = variants.map((v) => sql`${locations.label} ILIKE ${`%${v}%`}`);
    // Drizzle's sql template OR-Verknüpfung via raw expansion
    const orJoined = sql.join(ors, sql` OR `);
    return sql`(CASE WHEN ${orJoined} THEN 1 ELSE 0 END)`;
  });
  const labelMatchScore =
    labelWordScoreParts.length > 0
      ? sql.join(labelWordScoreParts, sql` + `)
      : sql`0`;

  /**
   * Größenklasse der Flughäfen (LARGE/MEDIUM/SMALL, aus OurAirports).
   *
   * Steht zweimal in der Sortierung, und das ist Absicht:
   *
   * Im FLUG-Modus früh, direkt nach der Ganzwort-Stufe. Dort besteht die
   * Trefferliste ausschließlich aus Flughäfen, also kann die Größe gefahrlos
   * vor der Namens-Wertung entscheiden — und sie MUSS es, sonst gewinnt der
   * Name über die Bedeutung: „Paris-Le Bourget" (Geschäftsflieger) stand vor
   * Charles de Gaulle und „New York Stewart" vor JFK, jeweils nur, weil der
   * gesuchte Ortsname zufällig im Flughafennamen steht und bei den großen
   * nicht.
   *
   * In allen anderen Modi spät. Früh wäre dort schädlich: Zeilen ohne
   * Größenangabe — also jeder Bahnhof und jede Haltestelle — fallen in die
   * Klasse 0, ein mittelgroßer Flughafen läge damit hinter sämtlichen
   * Bushaltestellen der Stadt.
   */
  const sizeRank = sql`CASE ${locations.subtype}
        WHEN 'LARGE' THEN 0
        WHEN 'MEDIUM' THEN 1
        WHEN 'SMALL' THEN 2
        ELSE 0
      END`;

  const rows = await db
    .select()
    .from(locations)
    .where(where)
    .orderBy(
      // 1. Type=ALL mit exaktem Label-Match: das ist DIE Stadt selbst — IMMER
      //    ganz oben.
      sql`CASE WHEN ${locations.type} = 'ALL' AND LOWER(${locations.label}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 1.5 GANZE Wörter in Label oder Stadt — siehe `wholeWordScore`.
      sql`(${wholeWordScore}) DESC`,
      // 1.6 Nur im Flug-Modus: Größe schlägt Namensähnlichkeit — siehe `sizeRank`.
      ...(type === "FLIGHT" ? [sizeRank] : []),
      // 2. ALLE Query-Wörter im LABEL — verhindert dass „Wien Blumental" über
      //    „Wien Hauptbahnhof" gerankt wird (beide haben „wien", aber nur
      //    Hauptbahnhof matched auch „hbf"/„hauptbahnhof"). DESC: mehr Wörter
      //    im Label = besser. ZUERST hier rein (vor City-Match) — sonst kann
      //    ein zufälliger Stop mit city=Wien den Hauptbahnhof noch immer
      //    überholen.
      sql`(${labelMatchScore}) DESC`,
      // 3. CITY-Match: Stops IN der gesuchten Stadt (auch wenn ihr Label
      //    nicht exakt der Stadtname ist).
      sql`CASE WHEN LOWER(${locations.city}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 4. Exakter Label-Match.
      sql`CASE WHEN LOWER(${locations.label}) = ${fullQuery} THEN 0 ELSE 1 END`,
      // 5. HAFAS-ID vorhanden = direkt nutzbar für Provider (dbVendo, oebb
      //    etc.) ohne Fuzzy-Lookup. Stationen mit hafasId IMMER vor
      //    Stationen ohne — sonst landet ein osm:/gtfs:-Stop ohne ID oben
      //    und dbVendo muss per Label suchen → falsche Treffer wie
      //    „Wien Hbf" → „Wien Blumental".
      sql`CASE WHEN ${locations.hafasId} IS NOT NULL THEN 0 ELSE 1 END`,
      // 6. Type-Priorität: Flughäfen > Major-Stations > regional > Bus
      sql`CASE
            WHEN ${locations.type} = 'ALL' THEN 0
            WHEN ${locations.type} = 'FLIGHT' THEN 1
            WHEN ${locations.type} = 'TRAIN' AND ${locations.subtype} IN ('LONG_DISTANCE','REGIONAL') THEN 2
            WHEN ${locations.type} = 'TRAIN' THEN 3
            WHEN ${locations.type} = 'CRUISE' THEN 4
            WHEN ${locations.type} = 'BUS' AND ${locations.subtype} = 'COACH' THEN 5
            WHEN ${locations.type} = 'BUS' THEN 6
            ELSE 7
          END`,
      // 7. Prefix-Match
      sql`CASE WHEN ${locations.label} ILIKE ${prefixLabelLike} THEN 0
               WHEN ${locations.city} ILIKE ${prefixCityLike} THEN 1
               ELSE 2 END`,
      // 8. Unter Flughäfen: Größe vor Namenslänge.
      //
      // Ohne diese Stufe entschied direkt darunter „kürzeres Label gewinnt",
      // und das ist bei Flughäfen schlicht das falsche Kriterium: Auf „London"
      // stand damit „London City Airport (LCY)" vor „London Heathrow Airport
      // (LHR)" — der kleinere Flughafen zuerst, nur weil sein Name kürzer ist.
      // Aufgefallen ist es erst, als die Liste von 391 kuratierten auf alle
      // 4163 Flughäfen mit Linienverkehr wuchs; vorher war das Feld zu dünn
      // besetzt, um sich zu widersprechen. Zeilen ohne Größenangabe (alles
      // außer FLIGHT) landen einheitlich in derselben Klasse und werden von
      // dieser Stufe damit nicht umsortiert.
      sizeRank,
      // 9. Tiebreaker: kürzeres Label
      sql`length(${locations.label}) asc`,
    )
    .limit(limit);

  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    city: r.city,
    country: r.country,
    type: r.type,
    latitude: r.latitude !== null ? Number(r.latitude) : undefined,
    longitude: r.longitude !== null ? Number(r.longitude) : undefined,
    hafasId: r.hafasId ?? undefined,
  }));
}

/** Dedup + Cap. Lokale Treffer (haben hafasId + city + country) gewinnen gegen
 *  Live-Fallback-Treffer mit identischer HAFAS-ID — sonst doppelt sichtbar im
 *  Autocomplete ("Dortmund Hbf | Germany" + "Dortmund Hbf | Dortmund Hbf").
 *
 *  Reihenfolge: zuerst alle Lokal-Treffer einsortieren (sie sind im ersten Teil
 *  der Liste), DANN Live-Treffer nur wenn HAFAS-ID noch nicht abgedeckt.
 *  Da Caller `[...dbResults, ...liveResults]` reinpackt, ist die Iteration
 *  über das Array genau diese Reihenfolge — Lokal-First gewinnt automatisch. */
/** Länder für die wir GTFS-Feeds haben (keine HAFAS-Coverage). Für Stops in
 *  diesen Ländern ist der `gtfs:<cc>:...`-Code direkt nutzbar — der
 *  Stop-Board-Endpoint findet den Stop sofort, ohne fragilen Coord-Lookup.
 *  Muss mit FEED_ID_BY_COUNTRY in gtfsSchedule.ts synchron bleiben. */
const GTFS_PRIMARY_COUNTRIES = new Set([
  "Netherlands",
  "France",
  "Italy",
  "Spain",
  "Czech Republic",
  "Belgium",
  "Hungary",
  "Slovakia",
  "United Kingdom",
  "Portugal",
]);

/** Source-Priorität für Dedup. Niedriger = besser (gewinnt).
 *
 *  Für HAFAS-Länder (DE/AT/CH/PL/LU/DK/…): StaDa-Daten sind authoritative
 *  (klare HAFAS-IDs, passen direkt zu db-rest/oebb/…), dann GTFS, dann OSM.
 *
 *  Für GTFS-Länder (NL/FR/IT/ES/…): umgekehrt — gtfs:<cc>:... ist der
 *  direkte Schlüssel in die GTFS-Tabellen. Der StaDa-Eintrag würde im
 *  Stop-Board-Endpoint einen Coord-Lookup auf ~100m triggern und für
 *  Amsterdam Centraal & Co. leere Boards liefern weil StaDa-Coord und
 *  GTFS-stoparea-Coord um >100m abweichen können. */
function sourceRank(loc: ClientLocation): number {
  const code = loc.code;
  const isGtfsPrimary =
    loc.country != null && GTFS_PRIMARY_COUNTRIES.has(loc.country);
  if (code.startsWith("sta:")) return isGtfsPrimary ? 1 : 0;
  if (code.startsWith("gtfs:")) return isGtfsPrimary ? 0 : 1;
  if (code.startsWith("osm:")) return 2;
  return 3;
}

/** Erkennt ob zwei Locations praktisch derselbe physische Stop sind:
 *    - Gleicher Name (case-insensitive)
 *    - Selbes Land
 *    - Coords innerhalb ~1km (oder Coords fehlen)
 *  Großzügiger Radius weil große Bahnhof-Plätze (Wien Hbf, Köln Hbf) mehrere
 *  hundert m messen — Plattform-OSM-Nodes und das StaDa-Zentrum müssen alle
 *  in den selben Bucket. city-Feld wird IGNORIERT (StaDa hat oft Stadtteil-
 *  Prefixes wie „Matzleinsdorf" für Wien Hbf, OSM hat city=null). */
function isSameStop(a: ClientLocation, b: ClientLocation): boolean {
  if ((a.label ?? "").toLowerCase().trim() !== (b.label ?? "").toLowerCase().trim()) return false;
  if (a.country !== b.country) return false;
  if (a.latitude == null || b.latitude == null || a.longitude == null || b.longitude == null) {
    // Ohne Coords: gleicher Label+Country reicht (passiert selten, vor allem
    // bei Cities und Airports mit unklarem Hauptzentrum).
    return true;
  }
  const dLat = a.latitude - b.latitude;
  const dLon = a.longitude - b.longitude;
  // ~1km² Bbox-Check (0.01° ≈ 1100m bei mid-Europa). Sub-Frage „Hauptbahnhof"
  // bei großen Städten kann Plätze >500m sein, daher großzügig.
  return Math.abs(dLat) < 0.01 && Math.abs(dLon) < 0.015;
}

function mergeAndCap(list: ClientLocation[], limit: number): ClientLocation[] {
  const seenCodes = new Set<string>();
  const seenHafas = new Set<string>();
  const out: ClientLocation[] = [];
  for (const l of list) {
    if (seenCodes.has(l.code)) continue;
    if (l.hafasId && seenHafas.has(l.hafasId)) continue;

    // Räumliche Dedup: linear-scan über `out` und prüfen ob's schon einen
    // physisch-gleichen Stop gibt. O(n × limit) mit limit ≈ 20, also vertretbar.
    // Linear-Scan statt Bucket-Map weil isSameStop einen Radius-Check macht
    // (Grid-Buckets würden Edge-Cases an Grid-Grenzen verpassen).
    let existingIdx = -1;
    for (let i = 0; i < out.length; i++) {
      if (isSameStop(out[i]!, l)) {
        existingIdx = i;
        break;
      }
    }
    if (existingIdx >= 0) {
      const existing = out[existingIdx]!;
      // 1. hafasId-Präsenz trumpft Source-Prefix — eine Row MIT hafasId
      //    ist für Provider direkt nutzbar (dbVendo, oebb, etc.) ohne
      //    Fuzzy-Label-Lookup. Ohne diese Regel würde z.B. „Bruxelles-Midi"
      //    als gtfs:be:... (kein hafasId) den sta:8814001-Eintrag (mit
      //    hafasId) überholen → dbVendo macht Label-Lookup → falsche oder
      //    keine Treffer.
      const existingHasId = Boolean(existing.hafasId);
      const candidateHasId = Boolean(l.hafasId);
      if (candidateHasId !== existingHasId) {
        if (candidateHasId) out[existingIdx] = l;
        continue;
      }
      // 2. Bei gleichem hafasId-Status: Source-Prefix (sta vs gtfs vs osm)
      if (sourceRank(l) < sourceRank(existing)) {
        out[existingIdx] = l;
      }
      continue;
    }

    seenCodes.add(l.code);
    if (l.hafasId) seenHafas.add(l.hafasId);
    out.push(l);
    if (out.length >= limit) break;
  }
  return out;
}
