import { ilike, or, and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { locations } from "../db/schema.js";
import type { LocationType } from "../db/schema.js";
import { flixbusLiveLocations, dbRestLiveLocations } from "./liveLocations.js";
import { exonymQueryVariants, isExonymCityName } from "../util/cityExonyms.js";
import { BoundedTtlCache } from "../util/boundedCache.js";
import { PRIMARY_AIRPORTS, SECONDARY_AIRPORTS } from "../data/hubAirports.js";
import { liveSearchesInFlight } from "./searchService.js";
import { tryAcquireDb, type DbLane } from "./dbQuota.js";

export interface ClientLocation {
  code: string;
  /** Der ANGEZEIGTE Name — der offizielle (`display_name`), sonst `label`. */
  label: string;
  /**
   * Unterscheidungs-Zusatz („Rochdale Road · Stop RA"), nur wenn ein
   * gleichnamiger Halt derselben Art daneben steht (`display_detail`).
   */
  detail?: string;
  /**
   * Der volle Quellname (`locations.label`), falls er vom angezeigten
   * abweicht — NUR serverintern: Die Namensprüfung im Chat muss „Rochdale
   * Road" auch dann wiedererkennen, wenn der Halt „Oldham College" heißt. Die
   * Route nimmt ihn vor der Antwort heraus.
   */
  matchLabel?: string;
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
  /**
   * Genaue Verkehrsart eines Halts (aus `subtype`) — für das Symbol in der
   * Trefferliste: Eine U-Bahn-Station steht in den Daten oft als `BUS`, wenn
   * an ihr auch Busse fahren, und zwei gleichnamige Treffer (S-Bahnhof und
   * Bushaltestelle „Dortmund Universität") müssen sich unterscheiden lassen.
   */
  kind?: StopKind;
}

export type StopKind = "train" | "subway" | "tram" | "bus" | "ferry";

function stopKindOf(subtype: string | null, type: LocationType): StopKind | undefined {
  switch (subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "train";
    case "SUBWAY":
      return "subway";
    case "TRAM":
      return "tram";
    case "FERRY":
      return "ferry";
    case "BUS":
    case "COACH":
      return "bus";
    default:
      return type === "TRAIN" ? "train" : type === "BUS" ? "bus" : undefined;
  }
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

/**
 * Der Live-Nachschlag im Zug-Modus geht an die Bahn (dbrest) — und deren
 * Kontingent gehört der SUCHE. Die Ortssuche läuft pro Tastendruck; ohne
 * Grenze konnte ein einziger Nutzer mit einem seltenen Ortsnamen einen guten
 * Teil davon verbrauchen.
 *
 * Deshalb die niedrigste Stufe im gemeinsamen Kontingent (`background`,
 * services/dbQuota.ts), und keiner, solange eine Suche läuft. Fällt er aus,
 * gibt es die lokale Liste — nur kurz gemerkt (siehe `finish`), damit der
 * nächste Tastendruck es wieder versucht.
 */
function takeDbrestLookup(): DbLane | null {
  if (liveSearchesInFlight() > 0) return null;
  return tryAcquireDb("background");
}

/**
 * Fertige Trefferlisten kurz aufheben — vor allem für KURZE Eingaben.
 *
 * WARUM GERADE HIER: Die Ortssuche ist der einzige Endpunkt, den jemand
 * buchstabenweise auslöst. Beim Tippen von „berlin" laufen „be", „ber", „berl"
 * … nacheinander durch — und genau die kurzen sind die teuersten, weil sie auf
 * die meisten Zeilen passen. Nach dem Trigramm-Index kostet „berl" 41 ms,
 * „be" aber weiterhin rund 700: Zwei Buchstaben passen auf zehntausende
 * Einträge, und daran kann kein Index etwas ändern.
 *
 * Kurze Eingaben sind aber auch die, die sich am häufigsten WIEDERHOLEN — über
 * Sitzungen und über Nutzer hinweg. Einmal bezahlt, danach frei.
 *
 * Eine halbe Stunde: Der Bestand ändert sich nur bei einem Datenimport. Die
 * Frist ist nicht wegen der Aktualität kurz, sondern damit der Speicher nicht
 * an alten Eingaben festhält. 500 Einträge à höchstens 20 Treffer sind wenige
 * Megabyte, verdrängt wird nach Alter.
 *
 * Der Schlüssel enthält Suchbegriff, Art UND Limit — zwei Aufrufer mit
 * verschiedenem Limit bekommen sonst gegenseitig zu kurze Listen.
 */
const searchCache = new BoundedTtlCache<ClientLocation[]>(500, 30 * 60 * 1000);

export async function searchLocations(
  query: string,
  type: LocationType | "ALL",
  limit = 20,
): Promise<ClientLocation[]> {
  /**
   * `%`, `_` und `\` sind in ILIKE Platzhalter bzw. Maskierung — und kommen in
   * keinem Ortsnamen vor. Unentfernt machten sie aus „%%" eine Suche über alle
   * 1,7 Mio. Zeilen (1,3 s), beliebig oft wiederholbar. Ohne Buchstabe oder
   * Ziffer gibt es nichts zu finden.
   */
  const q = query.replace(/[%_\\]/g, " ").trim();
  if (q.length < 1 || !/[\p{L}\p{N}]/u.test(q)) return [];

  // Kleingeschrieben in den Schlüssel: „Berlin" und „berlin" liefern dieselbe
  // Liste (die Abfrage vergleicht ohne Rücksicht auf Groß- und Kleinschreibung),
  // wären sonst aber zwei Einträge.
  const cacheKey = `${type}|${limit}|${q.toLowerCase()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  // searchLocalDb braucht ein höheres Limit als das finale Output-Limit, weil
  // mergeAndCap räumlich dedupt — wenn 2 von 20 Rows dupes sind, würden wir
  // nach Dedup nur 18 ausspucken statt 20. Mit 2× Limit ist Puffer da.
  const fetchLimit = limit * 2;

  // Sprach-Fallback via Exonyme: Die Datenquellen sind sprachlich gemischt
  // (Airports englisch „Vienna", StaDa deutsch „Wien Hbf"). Tippt der User
  // (oder übergibt Bo) „Wien" im Flug-Modus, ist VIE gemeint — gefunden wird
  // er nur über „Vienna". Dann probieren wir die übersetzten Varianten; die
  // Originalschreibweise gewinnt immer, wenn sie EINDEUTIG trifft (siehe
  // `isStrongHit`).
  //
  // Nicht erst bei 0 Treffern: ILIKE findet den Namen auch mitten in einem
  // Wort oder in einem Personennamen. Auf „Genf" kam so nur Klagenfurt, auf
  // „Napoli" nur Indianapolis, auf „Wien" nur „Ralph Wien Memorial" in Alaska
  // — die übersetzte Suche lief nie, weil die Liste nicht leer war. Die
  // Varianten laufen so nur, wenn die Eingabe GENAU ein bekannter Städtename
  // ist — nicht beim Tippen von „Gen" oder „Nap", und nicht bei mehreren
  // Wörtern: Auf „Berlin Ost" zog die Variante „berlin east" sonst die „East
  // Side Gallery" vor alle Bahnhöfe. Dort bleibt es beim alten Weg: Varianten
  // nur, wenn die Originalschreibweise gar nichts findet.
  //
  // Reihenfolge danach: eindeutige Treffer der Übersetzungen, dann ALLE
  // Treffer der Originalschreibweise in ihrer Reihenfolge, zuletzt die
  // übrigen der Übersetzungen.
  const searchWithExonyms = async (): Promise<ClientLocation[]> => {
    const direct = await searchLocalDb(q, type, fetchLimit);
    const variants = exonymQueryVariants(q);
    if (!isExonymCityName(q)) {
      if (direct.length > 0) return direct;
      for (const variant of variants) {
        const alt = await searchLocalDb(variant, type, fetchLimit);
        if (alt.length > 0) return alt;
      }
      return direct;
    }
    /**
     * Die kuratierte STADT (`type = ALL`) zählt dabei nicht: Sie trägt den
     * deutschen Namen und trifft „Prag" damit immer eindeutig — die
     * Übersetzungen liefen nie, und im Zug-Modus standen unter der Stadt nur
     * „Hutthurm Prag" und Co. statt Praha hl.n. Sie bleibt trotzdem ganz oben.
     */
    const cities = direct.filter((l) => l.type === "ALL" && isStrongHit(l, q));
    /**
     * Gibt es die Stadt (kuratiert, mit Lage), entscheidet die LAGE, nicht der
     * Name: eindeutig ist, was in ihrer Nähe liegt. Die Namen der Haltestellen
     * taugen dafür nicht — Praha hl.n. heißt in den Daten „Žižkov Praha hl.n.",
     * und auf „geneva" stand eine britische „Geneva Road" vor Genf.
     */
    const near = (l: ClientLocation) =>
      l.latitude != null &&
      l.longitude != null &&
      cities.some(
        (c) =>
          c.latitude != null &&
          c.longitude != null &&
          approxKm(c.latitude, c.longitude, l.latitude!, l.longitude!) <= CITY_NEAR_KM,
      );
    const hasCityCoords = cities.some((c) => c.latitude != null && c.longitude != null);
    /**
     * Reicht die Originalschreibweise? Mit bekannter Stadt nur, wenn ein
     * eindeutiger Treffer auch IN ihr liegt — „Köln Hbf" auf „Köln" ja, eine
     * britische „Mailand Rd End" auf „Mailand" nein. Kuratierte Einträge (die
     * Stadt selbst, ihr Busbahnhof „Prag UAN Florenc") zählen dafür nicht: Sie
     * tragen den deutschen Namen und träfen immer.
     */
    const directOk = hasCityCoords
      ? direct.some((l) => !isCurated(l) && near(l) && isStrongHit(l, q))
      : direct.some((l) => l.type !== "ALL" && isStrongHit(l, q));
    if (directOk) return direct;
    const strong: ClientLocation[] = [];
    const weak: ClientLocation[] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
      for (const l of await searchLocalDb(variant, type, fetchLimit)) {
        if (seen.has(l.code)) continue;
        seen.add(l.code);
        (hasCityCoords ? near(l) : isStrongHit(l, variant)) ? strong.push(l) : weak.push(l);
      }
    }
    if (hasCityCoords) {
      /**
       * In der Stadt: zuerst, was die Bahn kennt (HAFAS-Kennung), dann nach
       * Nähe zur Mitte — sonst stand der Flughafen Zaventem vor Bruxelles-Midi,
       * nur weil „brussels" als erste Übersetzung gefragt wurde.
       */
      const c = cities.find((x) => x.latitude != null && x.longitude != null)!;
      const d = (l: ClientLocation) => approxKm(c.latitude!, c.longitude!, l.latitude!, l.longitude!);
      strong.sort((a, b) => (a.hafasId ? 0 : 1) - (b.hafasId ? 0 : 1) || d(a) - d(b));
    }
    /**
     * Die Bahnhöfe der Stadt direkt dahinter — im Zug- und Gesamt-Modus.
     * Über die Namen kommen sie nicht zuverlässig nach vorn: Auf „prague"
     * passen über 5 000 Prager Halte, und die mit „Prague" im Namen standen
     * vor „Praha hl.n.". Siehe `mainStationsNear`.
     */
    const stations =
      hasCityCoords && (type === "TRAIN" || type === "ALL")
        ? await mainStationsNear(cities.find((c) => c.latitude != null && c.longitude != null)!, [
            q,
            ...variants,
          ])
        : [];
    const merged = [...cities];
    for (const l of [...stations, ...strong]) {
      if (!merged.some((x) => x.code === l.code)) merged.push(l);
    }
    // Aus der Originalschreibweise zuerst, was bei der Stadt liegt.
    if (hasCityCoords) {
      for (const l of direct) {
        if (!near(l) || merged.some((x) => x.code === l.code)) continue;
        merged.push(l);
      }
    }
    for (const l of direct) {
      if (merged.some((x) => x.code === l.code)) continue;
      merged.push(l);
    }
    const inMerged = new Set(merged.map((l) => l.code));
    for (const l of weak) if (!inMerged.has(l.code)) merged.push(l);
    return merged;
  };

  /**
   * Ergebnis ablegen und zurückgeben — an JEDEM Ausgang derselbe Weg.
   *
   * `ttlMs` überschreibt die Vorgabe für Listen, die man nicht lange halten
   * will: Wenn der Live-Nachschlag gescheitert ist, steht hier ein UNVOLLSTÄNDIGES
   * Ergebnis. Es eine halbe Stunde festzuhalten hieße, einen kurzen Ausfall der
   * Gegenstelle in eine halbe Stunde schlechter Trefferlisten zu verlängern.
   */
  const finish = (list: ClientLocation[], ttlMs?: number): ClientLocation[] => {
    searchCache.set(cacheKey, list, ttlMs);
    return list;
  };

  if (type === "ALL") {
    const dbResults = await searchWithExonyms();
    return finish(mergeAndCap(dbResults, limit));
  }

  const dbResults = await searchWithExonyms();

  if ((type === "BUS" || type === "TRAIN") && dbResults.length < LIVE_FALLBACK_THRESHOLD) {
    // Lokal zu wenig — Live als Fallback befragen.
    const lane = type === "BUS" ? null : takeDbrestLookup();
    const live =
      type === "BUS"
        ? flixbusLiveLocations(q)
        : lane
          ? dbRestLiveLocations(q, undefined, lane)
          : Promise.reject(new Error("dbrest: kein Platz im Bahn-Kontingent"));
    let liveFailed = false;
    const liveResults = await live.catch(() => {
      liveFailed = true;
      return [];
    });
    return finish(
      mergeAndCap([...dbResults, ...liveResults], limit),
      // Eine Minute statt einer halben Stunde, wenn der Nachschlag nicht kam.
      liveFailed ? 60_000 : undefined,
    );
  }

  return finish(mergeAndCap(dbResults, limit));
}

/**
 * Stations-Zusätze, die in den Labels oft fehlen oder anders geschrieben
 * stehen (kleine Bahnhöfe heißen schlicht „Werl", nicht „Werl Hauptbahnhof").
 */
const STATION_SUFFIXES = new Set([
  "hbf",
  "hauptbahnhof",
  "bahnhof",
  "bf",
  "station",
  "airport",
  "flughafen",
]);

/** Wie viele Bahnhöfe einer Stadt die Ortssuche vorzieht. */
const CITY_STATIONS_MAX = 4;
/** So viel Rechteck um die Stadtmitte (Grad Breite; Länge nach Breite gestreckt). */
const CITY_STATIONS_SPAN_DEG = 0.12;
/**
 * Namen, die einen Hauptbahnhof ausmachen — sie kommen vor allen anderen.
 * Die Unterart (Fern-/Regionalverkehr) hilft hier nicht: Aus StaDa trägt
 * jeder Bahnhof „REGIONAL".
 */
const MAIN_STATION_RE =
  "\\m(hbf|hauptbahnhof|hl\\.? ?n\\.?|centrale|centraal|central|centralna|centrum|główny|glowny|keleti|midi|zuid|termini|cornavin|gare du nord)\\M|( |^)h$";

/**
 * Die Bahnhöfe (Fern-, Regional-, S-Bahn) um eine kuratierte Stadt:
 * Hauptbahnhöfe zuerst, dann die mit Bahn-Kennung, dann nach Nähe zur Mitte.
 * Getragen vom Teil-Index `idx_locations_rail_geo` (Migration 0029).
 */
async function mainStationsNear(city: ClientLocation, names: string[]): Promise<ClientLocation[]> {
  const lat = city.latitude!;
  const lng = city.longitude!;
  // Ein Bahnhof, der genau wie die Stadt heißt („Genève", „Venezia"), ist
  // ebenfalls der Hauptbahnhof — in jeder Sprache der Stadt.
  const cityNames = [...new Set([city.label, ...names].map((n) => foldName(n)))];
  const dLng = CITY_STATIONS_SPAN_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  // Sortiert in der Datenbank — ein Abschneiden VOR dem Sortieren warf in
  // dichten Netzen (Genf) den Hauptbahnhof heraus.
  const dist = sql`((${locations.latitude} - ${lat}) * (${locations.latitude} - ${lat}) + (${locations.longitude} - ${lng}) * (${locations.longitude} - ${lng}) * ${Math.cos((lat * Math.PI) / 180) ** 2})`;
  const rows = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.type, "TRAIN"),
        sql`${locations.subtype} IN ('LONG_DISTANCE', 'REGIONAL', 'SUBURBAN')`,
        sql`${locations.latitude} BETWEEN ${lat - CITY_STATIONS_SPAN_DEG} AND ${lat + CITY_STATIONS_SPAN_DEG}`,
        sql`${locations.longitude} BETWEEN ${lng - dLng} AND ${lng + dLng}`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${locations.labelFold} ~* ${MAIN_STATION_RE}
               OR LOWER(${locations.labelFold}) IN (${sql.join(
                 cityNames.map((n) => sql`${n}`),
                 sql`, `,
               )}) THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${locations.hafasId} IS NOT NULL THEN 0 ELSE 1 END`,
      dist,
    )
    .limit(CITY_STATIONS_MAX);
  return rows.map(toClientLocation);
}

/** Kuratiert (Seed): Städte wie `CZ-PRG`, Busbahnhöfe wie `CZ-PRG-B`. */
function isCurated(l: ClientLocation): boolean {
  return /^[A-Z]{2}-[A-Z0-9]{2,4}(-B)?$/.test(l.code);
}

/** So nah an der kuratierten Stadt gilt ein Treffer als „in der Stadt" (siehe `searchWithExonyms`). */
const CITY_NEAR_KM = 20;

/** Abstand in km — gleichrechteckig genähert, für Umkreise bis ein paar Dutzend km genau genug. */
function approxKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const x = ((bLng - aLng) * Math.PI) / 180 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  const y = ((bLat - aLat) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6371;
}

/** Kleinbuchstaben, ohne Akzente, Satzzeichen als Leerzeichen — „Zürich" = „zurich". */
function foldName(v: string): string {
  return v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Trifft `l` die Eingabe EINDEUTIG — beginnt das Label mit ihr (als ganzes
 * Wort) oder heißt die Stadt genau so? „Köln Hbf" auf „Köln" ja, „Rome–Fiumicino"
 * auf „Rome" ja; „Ralph Wien Memorial" auf „Wien" nein, „Klagenfurt" auf
 * „Genf" nein. Zusätze wie „Hbf" zählen nicht mit: „Wien Hbf" trifft
 * „Wien Hauptbahnhof".
 */
function isStrongHit(l: ClientLocation, q: string): boolean {
  const w = foldName(q)
    .split(" ")
    .filter((x) => x && !STATION_SUFFIXES.has(x))
    .join(" ");
  if (!w) return true;
  return ` ${foldName(l.label)} `.startsWith(` ${w} `) || foldName(l.city ?? "") === w;
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
  const nonSuffixWords = words.filter((w) => !STATION_SUFFIXES.has(w));
  const filterWords = nonSuffixWords.length > 0 ? nonSuffixWords : words;
  const wordFilters = filterWords.map((word) => {
    const variants = SYNONYMS[word] ?? [word];
    const conditions = variants.flatMap((v) => {
      const like = `%${v}%`;
      return [
        // Label und Stadt OHNE Akzente verglichen — „Munchen" findet München.
        // Auf den gespeicherten Spalten (Migration 0027); nur die Eingabe wird
        // hier noch umgerechnet, einmal pro Abfrage.
        sql`${locations.labelFold} ILIKE f_unaccent(${like})`,
        sql`${locations.cityFold} ILIKE f_unaccent(${like})`,
        ilike(locations.country, like),
        ilike(locations.code, like),
        // Auch über den offiziellen Anzeigenamen (Migration 0034) — wer
        // „Riverside Close" tippt, findet den OSM-Halt „Glovers Close". Erst ab
        // drei Zeichen: Darunter greift kein Trigramm-Index, und die Funktion
        // liefe über jede Zeile mit eigenem Anzeigenamen.
        ...(v.length >= 3 ? [sql`f_unaccent(${locations.displayName}) ILIKE f_unaccent(${like})`] : []),
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

  /**
   * Halte OHNE Lage nicht vorschlagen. Es gibt sie seit der Reparatur des
   * verunglückten Abgleichs (30.09.2026): rund 2 600 gtfs.de-Halte, deren alte
   * Lage sich nicht zurückholen ließ. Auf der Karte sind sie unsichtbar, und
   * in der Liste schlug so ein Eintrag den gleichnamigen MIT Lage
   * (`isSameStop` hält Einträge ohne Lage für denselben Halt). Städte und
   * Flughäfen betrifft das nicht — dort bleibt es, wie es war.
   */
  const hasPlace = sql`(${locations.type} NOT IN ('TRAIN', 'BUS') OR ${locations.latitude} IS NOT NULL)`;
  /**
   * Steige nicht vorschlagen — die Suche zeigt ihre STATION („Dortmund Hörde
   * Bf"), deren Tafel alle Steige umfasst. Die Steige selbst gibt es auf der
   * Karte, jeder mit eigener Tafel (scripts/lib/gtfsStands.ts).
   */
  const notStand = sql`${locations.parentCode} IS NULL`;
  /** Halte ohne Bedienung laut Fahrplan (scripts/mark-unserved-stops.ts) — ihre Tafel bliebe leer. */
  const served = sql`${locations.unservedAt} IS NULL`;
  const where = and(textFilter, hasPlace, notStand, served, typeFilter);

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
      return [
        sql`${locations.labelFold} ~* f_unaccent(${re})`,
        sql`${locations.cityFold} ~* f_unaccent(${re})`,
        // Anzeigename erst ab drei Zeichen — wie im Filter oben; kürzere
        // Eingaben treffen Hunderttausende Zeilen, und die Rangfolge bliebe
        // für sie ohnehin dieselbe.
        ...(v.length >= 3 ? [sql`f_unaccent(${locations.displayName}) ~* f_unaccent(${re})`] : []),
      ];
    });
    return sql`(CASE WHEN ${sql.join(ors, sql` OR `)} THEN 1 ELSE 0 END)`;
  });
  const wholeWordScore =
    wholeWordParts.length > 0 ? sql.join(wholeWordParts, sql` + `) : sql`0`;

  const labelWordScoreParts = words.map((word) => {
    const variants = SYNONYMS[word] ?? [word];
    const ors = variants.flatMap((v) => [
      sql`${locations.labelFold} ILIKE f_unaccent(${`%${v}%`})`,
      ...(v.length >= 3 ? [sql`f_unaccent(${locations.displayName}) ILIKE f_unaccent(${`%${v}%`})`] : []),
    ]);
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

  /**
   * Hauptflughafen vor Nebenflughafen — nur im Flug-Modus, nach der
   * Ganzwort-Stufe und vor der Größe. Warum eine Liste: siehe
   * data/hubAirports.ts (OurAirports kennt keine Passagierzahlen; auf „London"
   * stand Heathrow an dritter Stelle).
   */
  const codeList = (codes: readonly string[]) =>
    sql.join(
      codes.map((c) => sql`${c}`),
      sql`, `,
    );
  const hubRank = sql`CASE
        WHEN ${locations.code} IN (${codeList(PRIMARY_AIRPORTS)}) THEN 0
        WHEN ${locations.code} IN (${codeList(SECONDARY_AIRPORTS)}) THEN 1
        ELSE 2
      END`;

  const rows = await db
    .select()
    .from(locations)
    .where(where)
    .orderBy(
      // 1. Type=ALL mit exaktem Label-Match: das ist DIE Stadt selbst — IMMER
      //    ganz oben.
      sql`CASE WHEN ${locations.type} = 'ALL' AND LOWER(${locations.labelFold}) = LOWER(f_unaccent(${fullQuery})) THEN 0 ELSE 1 END`,
      // 1.5 GANZE Wörter in Label oder Stadt — siehe `wholeWordScore`.
      sql`(${wholeWordScore}) DESC`,
      // 1.6 Nur im Flug-Modus: Hauptflughafen, dann Größe — beides schlägt
      //     Namensähnlichkeit (siehe `hubRank`, `sizeRank`).
      ...(type === "FLIGHT" ? [hubRank, sizeRank] : []),
      // 2. ALLE Query-Wörter im LABEL — verhindert dass „Wien Blumental" über
      //    „Wien Hauptbahnhof" gerankt wird (beide haben „wien", aber nur
      //    Hauptbahnhof matched auch „hbf"/„hauptbahnhof"). DESC: mehr Wörter
      //    im Label = besser. ZUERST hier rein (vor City-Match) — sonst kann
      //    ein zufälliger Stop mit city=Wien den Hauptbahnhof noch immer
      //    überholen.
      sql`(${labelMatchScore}) DESC`,
      // 3. CITY-Match: Stops IN der gesuchten Stadt (auch wenn ihr Label
      //    nicht exakt der Stadtname ist).
      sql`CASE WHEN LOWER(${locations.cityFold}) = LOWER(f_unaccent(${fullQuery})) THEN 0 ELSE 1 END`,
      // 4. Exakter Label-Match — auf den Quell- ODER den Anzeigenamen.
      fullQuery.length >= 3
        ? sql`CASE WHEN LOWER(${locations.labelFold}) = LOWER(f_unaccent(${fullQuery}))
                   OR LOWER(f_unaccent(${locations.displayName})) = LOWER(f_unaccent(${fullQuery})) THEN 0 ELSE 1 END`
        : sql`CASE WHEN LOWER(${locations.labelFold}) = LOWER(f_unaccent(${fullQuery})) THEN 0 ELSE 1 END`,
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
      firstWord.length >= 3
        ? sql`CASE WHEN ${locations.labelFold} ILIKE f_unaccent(${prefixLabelLike})
                   OR f_unaccent(${locations.displayName}) ILIKE f_unaccent(${prefixLabelLike}) THEN 0
                 WHEN ${locations.cityFold} ILIKE f_unaccent(${prefixCityLike}) THEN 1
                 ELSE 2 END`
        : sql`CASE WHEN ${locations.labelFold} ILIKE f_unaccent(${prefixLabelLike}) THEN 0
                 WHEN ${locations.cityFold} ILIKE f_unaccent(${prefixCityLike}) THEN 1
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
      // 9. Tiebreaker: kürzerer (angezeigter) Name
      fullQuery.length >= 3
        ? sql`length(coalesce(${locations.displayName}, ${locations.label})) asc`
        : sql`length(${locations.label}) asc`,
    )
    .limit(limit);

  return rows.map(toClientLocation);
}

/** Zeile → Treffer: angezeigt wird der offizielle Name, der Zusatz nur wo nötig. */
function toClientLocation(r: typeof locations.$inferSelect): ClientLocation {
  return {
    code: r.code,
    label: r.displayName ?? r.label,
    ...(r.displayDetail ? { detail: r.displayDetail } : {}),
    ...(r.displayName && r.displayName !== r.label ? { matchLabel: r.label } : {}),
    city: r.city,
    country: r.country,
    type: r.type,
    latitude: r.latitude !== null ? Number(r.latitude) : undefined,
    longitude: r.longitude !== null ? Number(r.longitude) : undefined,
    hafasId: r.hafasId ?? undefined,
    ...(stopKindOf(r.subtype, r.type) ? { kind: stopKindOf(r.subtype, r.type) } : {}),
  };
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
 *    - Dieselbe ART (`familyOf`): Bahn, Stadtbahn (U-Bahn/Tram), Bus, Fähre
 *    - Coords innerhalb ~1km (oder Coords fehlen)
 *  Großzügiger Radius weil große Bahnhof-Plätze (Wien Hbf, Köln Hbf) mehrere
 *  hundert m messen — Plattform-OSM-Nodes und das StaDa-Zentrum müssen alle
 *  in den selben Bucket. city-Feld wird IGNORIERT (StaDa hat oft Stadtteil-
 *  Prefixes wie „Matzleinsdorf" für Wien Hbf, OSM hat city=null). */
/**
 * Britische Richtungs-Zusätze (NaPTAN-„Indicator") — „Priory Road (o/s)" und
 * „Priory Road (opp)" sind die beiden Straßenseiten DESSELBEN Halts. In der
 * Liste standen sie als zwei Treffer (11 000 solcher Paare im Bestand); die
 * Karte zeigt weiterhin beide, mit eigener Tafel.
 */
const GB_INDICATOR =
  /\((?:stop|stand|stance|bay)\s*[a-z0-9]{1,3}\)|\b(?:opp|adj|o\/s|nr|outside|opposite|near)\b\.?|\b(?:n|s|e|w|ne|nw|se|sw)\/?b\b|\b(?:n|s|e|w|ne|nw|se|sw|north|south|east|west)[ -]?bound\b|\((?:n|s|e|w|ne|nw|se|sw)\)/gi;

function sameStopLabel(a: ClientLocation, b: ClientLocation): boolean {
  const plain = (l: ClientLocation) => (l.label ?? "").toLowerCase().trim();
  if (plain(a) === plain(b)) return true;
  if (a.country !== "United Kingdom" || b.country !== "United Kingdom") return false;
  const core = (l: ClientLocation) =>
    plain(l).replace(GB_INDICATOR, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const x = core(a);
  return x.length > 0 && x === core(b);
}

/**
 * Art eines Treffers für die Frage „derselbe Halt?" — wie `familyOf` in
 * routes/surroundings.ts (U-Bahn und Tram eine Art: Quellen stufen dieselbe
 * Stadtbahn verschieden ein). Ohne Unterart (Live-Treffer) entscheidet der Typ.
 */
function familyOf(l: ClientLocation): string {
  switch (l.kind ?? stopKindOf(null, l.type)) {
    case "train":
      return "rail";
    case "subway":
    case "tram":
      return "metro";
    case "ferry":
      return "ferry";
    case "bus":
      return "bus";
    default:
      return String(l.type);
  }
}

/**
 * VERSCHIEDENE Verkehrsarten sind nie derselbe Halt, auch bei gleichem Namen:
 * Der S-Bahnhof „Dortmund Universität" und die gleichnamige Bushaltestelle
 * daneben haben je eine eigene Tafel. Vorher zählte nur der Name — der
 * Bushalt verschwand aus der Suche (und damit auch für Bo und den
 * Routenplaner), europaweit rund elftausend Namen. Gleichnamige Halte
 * DERSELBEN Art (zwei Bussteige „Dortmund Hörde") bleiben ein Treffer; auf der
 * Karte stehen sie weiterhin einzeln (routes/surroundings.ts).
 */
function isSameStop(a: ClientLocation, b: ClientLocation): boolean {
  if (!sameStopLabel(a, b)) return false;
  if (a.country !== b.country) return false;
  if (familyOf(a) !== familyOf(b)) return false;
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
