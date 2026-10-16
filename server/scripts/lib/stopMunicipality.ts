/**
 * Zu welcher GEMEINDE gehört eine Haltestelle — gemeinsam für
 * `enrich-stops-city.ts` (setzt `locations.city`) und `fix-stop-cities.ts`
 * (die einmalige Korrektur vom Sept. 2026).
 *
 * WARUM NEU: Die alte Ermittlung kannte nur eine Regel für alle Länder (erst
 * admin4, dann admin3) und ließ `PPLA5` und jeden `PPL` als Gemeindesitz
 * gelten. Heraus kamen Stadtteile als Stadt: Wien Hbf lag in „Matzleinsdorf",
 * Praha hl.n. in „Žižkov", Den Haag HS in „Stationsbuurt", Torino Porta Nuova
 * in „Pian del Lot". Das Präfix-Skript klebte diese Namen danach vorn an die
 * Stationsnamen („Neubau Wien Westbahnhof").
 *
 * DIE GEMEINDE-EBENE IST JE LAND EINE ANDERE (GeoNames-Verwaltungscodes):
 *   admin4  Deutschland, Belgien, Frankreich
 *   admin3  Österreich, Schweiz, Italien, Spanien, Polen, Tschechien,
 *           Slowakei, Luxemburg
 *   admin2  Niederlande, Dänemark
 *   —       Großbritannien, Ungarn, Portugal (keine brauchbare Ebene): nur
 *           Sitz, Stadtteil-Regel und eigener Name
 *
 * Reihenfolge:
 *   1. Der Ort ist selbst ein Verwaltungssitz (PPLA…/PPLC/PPLG, nicht PPLA5)
 *      → sein Name. Liegt er in einer Stadt-Region (Wien, Prag, Budapest,
 *      Berlin, Hamburg — siehe `CITY_REGIONS`) → diese Stadt.
 *   2. Gemeinde über die Ebene des Landes: derselbe Code bis zu dieser Ebene;
 *      Sitze vor allen anderen, sonst der einwohnerstärkste Ort (nie ein
 *      Stadtteil).
 *   3. Stadtteil einer großen Stadt (PPLX, PPLA5, oder ein winziger Ort direkt
 *      an einer Großstadt) → die große Stadt daneben. Das fängt die
 *      Hauptstädte ohne feinere Codes (Wien, Prag, Brüssel, Kopenhagen).
 *   4. Sonst der eigene Name.
 *
 * GeoNames führt Hauptstädte englisch („Vienna", „Prague", „Brussels") — für
 * die Suche egal, die findet über Label und Übersetzungen (cityExonyms.ts).
 */

export interface PlacePoint {
  geonameId: number;
  name: string;
  lat: number;
  lng: number;
  population: number;
  featureCode: string | null;
  country: string | null;
  admin1: string | null;
  admin2: string | null;
  admin3: string | null;
  admin4: string | null;
}

const MUNICIPALITY_LEVEL: Record<string, 2 | 3 | 4> = {
  Germany: 4,
  Belgium: 4,
  France: 4,
  Austria: 3,
  Switzerland: 3,
  Italy: 3,
  Spain: 3,
  Poland: 3,
  "Czech Republic": 3,
  Slovakia: 3,
  Luxembourg: 3,
  Netherlands: 2,
  Denmark: 2,
  // Portugal NICHT: Die Gemeinde-Ebene (Concelho) ist so groß, dass „Queluz"
  // zu „Sintra" würde — wer Queluz sucht, fände die Halte nicht mehr.
};

/**
 * Regionen, die EINE Stadt sind (Stadtstaaten, Hauptstadt-Regionen): Alles
 * darin gehört zu ihr. Nötig, weil GeoNames die Bezirke dort als eigene Orte
 * mit eigenen Codes führt — Prags Bezirke etwa als `PPL` mit eigener
 * Gemeinde-Kennung, und so blieben „Jinonice" und „Čimice" als Stadt stehen.
 * Nicht Bremen (Region mit Bremerhaven) und nicht Bratislava (Kreis mit
 * weiteren Orten).
 */
const CITY_REGIONS: Record<string, string> = {
  "Austria|09": "Vienna",
  "Czech Republic|52": "Prague",
  "Hungary|05": "Budapest",
  "Germany|16": "Berlin",
  "Germany|04": "Hamburg",
};

const SEAT_CODES = new Set(["PPLC", "PPLG", "PPLA", "PPLA2", "PPLA3", "PPLA4"]);
/** Teile einer Stadt — nie selbst eine Gemeinde. */
const SECTION_CODES = new Set(["PPLX", "PPLA5"]);

/** Stadtteil-Regel: so nah muss die große Stadt liegen … */
const PARENT_RADIUS_SECTION_M = 10_000;
/** … bzw. für einen winzigen gewöhnlichen Ort (dort strenger). */
const PARENT_RADIUS_SMALL_PPL_M = 3_000;
/** Ab so vielen Einwohnern gilt ein Ort als „große Stadt". */
const PARENT_MIN_POPULATION = 20_000;
/** Ein gewöhnlicher Ort darunter gilt als „winzig". */
const SMALL_PPL_POPULATION = 2_000;
/**
 * Ohne Einwohnerzahl (GeoNames: 0) ist „winzig" nicht belegt — so ein Ort gilt
 * nur neben einer echten Großstadt als deren Teil (Cureghem an Brüssel), nicht
 * neben irgendeiner Stadt (sonst lag Gravesend in Grays, jenseits der Themse).
 */
const PARENT_MIN_POPULATION_UNKNOWN = 100_000;

export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat * 10)},${Math.floor(lng * 10)}`;
}

function levelKey(p: PlacePoint, level: 2 | 3 | 4): string | null {
  const codes = [p.admin1, p.admin2, p.admin3, p.admin4].slice(0, level);
  if (codes.some((c) => !c)) return null;
  return `${p.country}|${level}|${codes.join("|")}`;
}

export function buildMunicipalityResolver(points: PlacePoint[]) {
  /** Die Stadt je Stadt-Region (siehe `CITY_REGIONS`) — ihr Sitz-Eintrag. */
  const regionCity = new Map<string, PlacePoint>();
  for (const p of points) {
    const key = `${p.country}|${p.admin1}`;
    if (CITY_REGIONS[key] === p.name && SEAT_CODES.has(p.featureCode ?? "")) regionCity.set(key, p);
  }
  /** Die Stadt, deren Region `p` ist — oder null. */
  function cityRegionOf(p: PlacePoint): PlacePoint | null {
    return regionCity.get(`${p.country}|${p.admin1}`) ?? null;
  }
  const grid = new Map<string, PlacePoint[]>();
  const municipalityByKey = new Map<string, PlacePoint>();
  const isBetterMunicipality = (a: PlacePoint, b: PlacePoint) => {
    const sa = SEAT_CODES.has(a.featureCode ?? "") ? 1 : 0;
    const sb = SEAT_CODES.has(b.featureCode ?? "") ? 1 : 0;
    return sa !== sb ? sa > sb : a.population > b.population;
  };
  for (const p of points) {
    const k = cellKey(p.lat, p.lng);
    const bucket = grid.get(k);
    if (bucket) bucket.push(p);
    else grid.set(k, [p]);
    if (SECTION_CODES.has(p.featureCode ?? "")) continue;
    const level = MUNICIPALITY_LEVEL[p.country ?? ""];
    if (!level) continue;
    const key = levelKey(p, level);
    if (!key) continue;
    const prev = municipalityByKey.get(key);
    if (!prev || isBetterMunicipality(p, prev)) municipalityByKey.set(key, p);
  }

  /** Alle Orte im Umkreis (3×3-Raster, 0,1°), mit Abstand. */
  function placesNear(lat: number, lng: number, maxM: number): Array<{ place: PlacePoint; dist: number }> {
    const cy = Math.floor(lat * 10);
    const cx = Math.floor(lng * 10);
    /**
     * So viele Rasterzellen (0,1°) in jede Richtung, wie der Umkreis braucht.
     * Fest 3×3 deckte nur gut 5 km ab (in Ost-West-Richtung bei 50° Breite
     * rund 7 km) — ein „≤ 20 km" fand damit oft gar nichts.
     */
    const ry = Math.ceil(maxM / 11_100);
    const rx = Math.ceil(maxM / Math.max(1_000, 11_100 * Math.cos((lat * Math.PI) / 180)));
    const out: Array<{ place: PlacePoint; dist: number }> = [];
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        for (const p of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const d = haversineM(lat, lng, p.lat, p.lng);
          if (d <= maxM) out.push({ place: p, dist: d });
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  function nearestPlace(lat: number, lng: number, maxM: number): { place: PlacePoint; dist: number } | null {
    return placesNear(lat, lng, maxM)[0] ?? null;
  }

  /** Die große Stadt, zu der ein Stadtteil gehört — oder null. */
  function parentCity(p: PlacePoint): PlacePoint | null {
    const fc = p.featureCode ?? "";
    const section = SECTION_CODES.has(fc);
    const smallPpl = fc === "PPL" && p.population < SMALL_PPL_POPULATION;
    if (!section && !smallPpl) return null;
    const radius = section ? PARENT_RADIUS_SECTION_M : PARENT_RADIUS_SMALL_PPL_M;
    const minPop = !section && p.population === 0 ? PARENT_MIN_POPULATION_UNKNOWN : PARENT_MIN_POPULATION;
    let best: PlacePoint | null = null;
    for (const { place } of placesNear(p.lat, p.lng, radius)) {
      if (place.geonameId === p.geonameId) continue;
      if (SECTION_CODES.has(place.featureCode ?? "")) continue;
      if (place.country !== p.country) continue;
      if (place.population < minPop) continue;
      if (place.population < p.population * 10) continue;
      if (!best || place.population > best.population) best = place;
    }
    return best;
  }

  /**
   * Name der Gemeinde, zu der der Ort `p` gehört (Regeln: siehe Kopf der Datei).
   *
   * Die Verwaltungsebene hat Vorrang vor der Nachbarstadt: Anrath ist ein
   * Ortsteil von Willich, liegt aber zehn Kilometer neben Krefeld — mit „große
   * Stadt daneben" zuerst landete es in Krefeld. Nur wenn die Ebene für einen
   * Stadtteil nichts Belastbares liefert (keinen Sitz, nur einen winzigen Ort —
   * so bei den Wiener Bezirken), gilt die Stadt daneben. Winzige gewöhnliche
   * Orte kommen nur dann zur Nachbarstadt, wenn die Ebene gar nichts kennt.
   */
  function municipalityFor(p: PlacePoint): string {
    return municipalityPlace(p).name;
  }

  /** Wie `municipalityFor`, aber der Ort selbst (mit Einwohnerzahl). */
  function municipalityPlace(p: PlacePoint): PlacePoint {
    const fc = p.featureCode ?? "";
    if (SEAT_CODES.has(fc)) return p;
    // In einer Stadt-Region gehört alles zur Stadt (Jinonice → Prague).
    const region = cityRegionOf(p);
    if (region) return region;
    const level = MUNICIPALITY_LEVEL[p.country ?? ""];
    const key = level ? levelKey(p, level) : null;
    const muni = key ? municipalityByKey.get(key) : undefined;
    const solid =
      muni != null &&
      (SEAT_CODES.has(muni.featureCode ?? "") ||
        muni.population >= SMALL_PPL_POPULATION ||
        !SECTION_CODES.has(fc));
    if (muni && solid) return muni;
    if (!muni || SECTION_CODES.has(fc)) {
      const parent = parentCity(p);
      if (parent) return parent;
    }
    if (muni) return muni;
    return p;
  }

  /** Ist dieser Ort selbst eine Gemeinde (und nicht Teil einer anderen)? */
  function isOwnMunicipality(p: PlacePoint): boolean {
    return municipalityFor(p) === p.name && !SECTION_CODES.has(p.featureCode ?? "");
  }

  /**
   * Ein Verwaltungssitz, dessen Name im Label steht („Köln Messe/Deutz" →
   * Köln) — der nächste zum Halt, höchstens 30 km entfernt. Nur Sitze: Mit
   * gewöhnlichen Orten und Stadtteilen würde „Kapelle" jeden Halt mit
   * „Kapelle" im Namen irgendwohin ziehen.
   */
  /** Name als Wortfolge — Satzzeichen und Klammern weg („Lambrecht (Pfalz)" → „lambrecht pfalz"). */
  const words = (v: string) => v.toLowerCase().split(/[\s,.;:/()\-]+/).filter(Boolean);
  /** Wörter, die einen Ortsnamen zum Straßennamen machen — dahinter … */
  const STREET_AFTER = new Set([
    "road", "rd", "street", "lane", "ln", "avenue", "ave", "way", "drive", "dr", "terrace", "crescent", "close",
    "straße", "strasse", "str", "weg", "allee", "chaussee", "damm", "landstraße", "landstrasse",
    "straat", "weg", "laan", "steenweg", "baan",
  ]);
  /** … und davor (romanische/slawische Sprachen: „Route de Virton", „Via Locarno", „ul. Warszawska"). */
  const STREET_BEFORE = new Set([
    "rue", "route", "avenue", "av", "chemin", "boulevard", "bd", "chaussée", "chaussee",
    "via", "viale", "corso", "calle", "avenida", "avda", "carrer", "avinguda", "carretera", "rua", "estrada",
    "ulica", "ul", "aleja", "al",
  ]);
  const LINKERS = new Set(["de", "du", "des", "d'", "di", "del", "della", "da", "do", "dos"]);
  const seatsByName = new Map<string, PlacePoint[]>();
  for (const p of points) {
    if (!SEAT_CODES.has(p.featureCode ?? "")) continue;
    const k = words(p.name).join(" ");
    const bucket = seatsByName.get(k);
    if (bucket) bucket.push(p);
    else seatsByName.set(k, [p]);
  }
  /**
   * Wie weit ein im Label genannter Sitz entfernt sein darf. Kurze Namen sind
   * oft Allerweltswörter („Berg", „Hof", „Au", „Wald") — mit 30 km zog „Berg"
   * jeden Halt mit „Berg" im Namen an sich. Längere Namen sind eindeutiger.
   */
  const seatMaxM = (name: string) => (name.length <= 4 ? 3_000 : 15_000);
  function seatInLabel(label: string, lat: number, lng: number): PlacePoint | null {
    const w = words(label);
    const found: PlacePoint[] = [];
    const add = (b: PlacePoint[] | undefined) => {
      for (const c of b ?? []) if (!found.includes(c)) found.push(c);
    };
    // Ein bis drei Wörter am Stück („Frankfurt am Main", „Lambrecht Pfalz").
    for (let n = 1; n <= 3; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        // Teil eines STRASSENNAMENS? Dann nennt er das Ziel der Straße, nicht
        // den Ort des Halts: „Slaithwaite, Manchester Road" lag in „Manchester"
        // (29 km), „Arlon Route de Virton" in Virton. Nachgezählt: 8 000 Halte
        // in Großbritannien, gut 1 700 in IT/ES/FR/BE.
        if (STREET_AFTER.has(w[i + n] ?? "")) continue;
        if (STREET_BEFORE.has(w[i - 1] ?? "") || (LINKERS.has(w[i - 1] ?? "") && STREET_BEFORE.has(w[i - 2] ?? ""))) continue;
        add(seatsByName.get(w.slice(i, i + n).join(" ")));
      }
    }
    let best: PlacePoint | null = null;
    let bestD = Infinity;
    for (const c of found) {
      const d = haversineM(lat, lng, c.lat, c.lng);
      if (d <= seatMaxM(c.name) && d < bestD) {
        best = c;
        bestD = d;
      }
    }
    return best;
  }

  /** Die Gemeinde eines Halts: Sitz im Label, sonst der nächste Ort (≤ 20 km). */
  function municipalityForStop(label: string, lat: number, lng: number): PlacePoint | null {
    const inLabel = seatInLabel(label, lat, lng);
    if (inLabel) return municipalityPlace(inLabel);
    const near = nearestPlace(lat, lng, 20_000);
    return near ? municipalityPlace(near.place) : null;
  }

  /** Hat dieses Land eine Gemeinde-Ebene in den GeoNames-Codes? */
  function hasMunicipalityLevel(country: string | null): boolean {
    return MUNICIPALITY_LEVEL[country ?? ""] != null;
  }

  /** Ist der Ort ein Stadtteil (PPLX/PPLA5)? */
  function isSection(p: PlacePoint): boolean {
    return SECTION_CODES.has(p.featureCode ?? "");
  }

  return {
    placesNear,
    nearestPlace,
    municipalityFor,
    municipalityPlace,
    isOwnMunicipality,
    municipalityForStop,
    hasMunicipalityLevel,
    isSection,
    isSeat: (p: PlacePoint) => SEAT_CODES.has(p.featureCode ?? ""),
    cityRegionOf,
  };
}
