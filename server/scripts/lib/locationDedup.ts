/**
 * Wann zwei Einträge in `locations` DERSELBE Halt sind — gemeinsam für den
 * Aufräumer (`dedup-locations.ts`) und den monatlichen Abgleich
 * (`import-gtfs.ts` mit `GTFS_MODE=refresh`): gleiches Land, gleiche
 * Verkehrsart-Kategorie, gleicher normalisierter Name, höchstens
 * `DEDUP_RADIUS_M` auseinander.
 *
 * Der Abgleich fügt einen neuen Halt nur ein, wenn es ihn nach dieser Regel
 * noch nicht gibt. Ohne die Prüfung kamen jeden Monat die Dubletten zurück,
 * die der Aufräumer nach dem ersten Import entfernt hatte (Probelauf Prag:
 * 9 504 „neue" Halte).
 */

export const DEDUP_RADIUS_M = 500;

export function normalizeName(label: string): string {
  return label
    // Ohne Akzente: „Nejdek-Suchá" und „Nejdek-Sucha" sind derselbe Halt.
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    // Spezifische Zusammensetzungen ZUERST — sonst bleibt nach „Bahnhof"-
    // Entfernen ein dangling „s"/„u" stehen das den Schlüssel zersägt
    // („Unna West S-Bahnhof" → „unna west s" ≠ „Unna West" → „unna west").
    .replace(/\b[su][\s\-]?bahnhof\b/g, " ")
    .replace(/\bhauptbahnhof\b/g, " ")
    .replace(/\bbahnhof\b/g, " ")
    .replace(/\bhbf\.?\b/g, " ")
    .replace(/\bbf\.?\b/g, " ")
    .replace(/\bs[+\- ]?u\b/g, " ")
    .replace(/\bs[\s\-]?bahn\b/g, " ")
    .replace(/\bu[\s\-]?bahn\b/g, " ")
    .replace(/\bzob\b/g, " ")
    .replace(/\bgare\b/g, " ")
    .replace(/\bstation\b/g, " ")
    .replace(/\bstazione\b/g, " ")
    .replace(/\bestaci[óo]n\b/g, " ")
    .replace(/\bstacja\b/g, " ")
    // Akzente sind oben schon weg — „nádraží" steht hier als „nadrazi".
    .replace(/\bnadrazi\b/g, " ")
    .replace(/[(),.;:/\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Verkehrsart-Kategorie — ein Bahnhof und die Bushaltestelle davor bleiben zwei Halte. */
export function dedupCategory(subtype: string | null, type: string): string {
  switch (subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "RAIL";
    case "SUBWAY": return "SUBWAY";
    case "TRAM": return "TRAM";
    case "BUS":
    case "COACH":
      return "BUS";
    case "FERRY": return "FERRY";
    default:
      return type === "TRAIN" ? "RAIL" : "BUS";
  }
}

function foldStopName(v: string): string {
  return v
    .replace(/\[[^\]]*\]/g, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Namen, die für sich allein keinen Halt benennen — es gibt sie in jedem Ort.
 * „Musterdorf Rathaus" und „Rathaus" sind deshalb NICHT derselbe Halt, nur weil
 * das eine auf das andere endet (siehe `sameStopName`).
 */
export const GENERIC_STOP_NAMES = new Set([
  "rathaus", "kirche", "schule", "post", "markt", "marktplatz", "friedhof",
  "ortsmitte", "mitte", "zentrum", "dorfplatz", "dorf", "kirchplatz",
  "schulzentrum", "sportplatz", "siedlung", "abzweig", "kreuzung", "ort",
  "ortseingang", "ortsausgang", "wendeplatz", "hauptstrasse", "bahnhofstrasse",
  "dorfstrasse", "schulstrasse", "kirchstrasse", "gasthaus", "feuerwehr",
  "feuerwehrhaus", "gemeindeamt", "bahnhof", "hbf", "bf", "station", "gare",
  "zob", "busbahnhof", "mairie", "eglise", "centre", "centre ville", "place",
  "church", "school", "square", "market", "town hall", "high street",
  "obecni urad", "kostel", "namesti", "skola", "chiesa", "municipio",
  "piazza", "stazione", "kerk", "dorpsplein", "kosciol", "rynek", "szkola",
]);

/**
 * Derselbe Halt dem NAMEN nach — auch wenn einer davon eine Gemeinde
 * vorangestellt hat („Meinerzhagen Mittelhagen" ↔ „Mittelhagen", ein Überbleibsel
 * des alten Präfix-Skripts) oder Akzente fehlen. Für sich allein kein Beweis:
 * Wer es benutzt, prüft zusätzlich die Lage.
 *
 * Zwei Fallen, beide nachgestellt:
 *  - Ein Name, der nach dem Normalisieren LEER ist („Bahnhof", „ZOB", „Hbf"),
 *    passte auf jeden anderen leeren — „Bahnhof" war derselbe Halt wie „ZOB".
 *    Leer heißt jetzt: nur der wörtlich gleiche Name zählt.
 *  - Das Anhängsel-Kriterium (endet auf) gilt nicht für Allerweltsnamen:
 *    „Musterdorf Rathaus" ist nicht das „Rathaus" im Nachbarort.
 */
export function sameStopName(
  a: string,
  b: string,
  /**
   * Liegen beide nur wenige Meter auseinander (`CROSS_CATEGORY_RADIUS_M`),
   * darf auch ein Allerweltsname das Ende des anderen sein: „Schule" 78 m
   * neben „Goldbach Schule" ist dieselbe Haltestelle — die im Nachbarort liegt
   * nicht 150 m entfernt.
   */
  opts: { veryClose?: boolean } = {},
): boolean {
  const x = foldStopName(a);
  const y = foldStopName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const endsWithName = (long: string, short: string) =>
    short !== "" && (opts.veryClose || !GENERIC_STOP_NAMES.has(short)) && long.endsWith(` ${short}`);
  if (endsWithName(x, y) || endsWithName(y, x)) return true;
  const nx = normalizeName(a);
  const ny = normalizeName(b);
  if (nx === "" || ny === "") return false;
  // Auch nach dem Normalisieren: „Mellendorf Bahnhof" (Feed) ist „Elze
  // Mellendorf" (unser Bahnhof mit Gemeinde davor) — Anhängsel UND Vorsatz.
  return nx === ny || endsWithName(nx, ny) || endsWithName(ny, nx);
}

/** Wörtlich derselbe Name (ohne Akzente, Satzzeichen, Groß/klein). */
export function exactStopName(a: string, b: string): boolean {
  const x = foldStopName(a);
  return x !== "" && x === foldStopName(b);
}

/**
 * Familie für „gibt es diesen Halt schon?" beim Abgleich — gröber als
 * `dedupCategory`: Bus, Straßenbahn und U-Bahn gleichen Namens auf wenigen
 * Metern sind derselbe Ort. Ein Feed, der eine Buslinie als Straßenbahn führt
 * (VMV, Sept. 2026: 495 Dorfhalte als „Tram"), brachte sonst jeden Halt
 * doppelt herein. Die Bahn bleibt für sich — der Bahnhof und die Bushaltestelle
 * davor sind zwei Halte.
 */
export function dedupFamily(subtype: string | null, type: string): "RAIL" | "LOCAL" | "FERRY" {
  const cat = dedupCategory(subtype, type);
  if (cat === "RAIL") return "RAIL";
  if (cat === "FERRY") return "FERRY";
  return "LOCAL";
}

/**
 * Umkreis für „anderer Kategorie, aber derselben Familie" (Bus ↔ Tram ↔ U-Bahn):
 * eng, ein gemeinsamer Mast oder Bahnsteig. Innerhalb DERSELBEN Kategorie
 * bleibt es bei `DEDUP_RADIUS_M` — sonst kämen gleichnamige Masten auf der
 * anderen Straßenseite (Warschau: je Richtung ein eigener Halt) als neue
 * Halte herein.
 */
export const CROSS_CATEGORY_RADIUS_M = 150;

/**
 * Räumliches Verzeichnis für „gibt es diesen Halt schon?" — ein Gitter aus
 * 0,01°-Zellen (≈ 1,1 km), sodass `DEDUP_RADIUS_M` höchstens die 3×3-Nachbarschaft
 * einer Zelle berührt. Gemeinsam für den GTFS-Abgleich und die Aufräumer.
 */
export class NearbyIndex {
  private grid = new Map<string, { label: string; cat: string; family: string; lat: number; lng: number }[]>();

  add(label: string, subtype: string | null, type: string, lat: number, lng: number): void {
    const k = `${Math.floor(lat * 100)},${Math.floor(lng * 100)}`;
    const entry = { label, cat: dedupCategory(subtype, type), family: dedupFamily(subtype, type), lat, lng };
    const list = this.grid.get(k);
    if (list) list.push(entry);
    else this.grid.set(k, [entry]);
  }

  /**
   * Gibt es den Halt schon? Passender Name UND — gleiche Kategorie im Umkreis
   * von `DEDUP_RADIUS_M`, oder gleiche Familie im Umkreis von
   * `CROSS_CATEGORY_RADIUS_M`.
   */
  hasDuplicate(label: string, subtype: string | null, type: string, lat: number, lng: number): boolean {
    const cat = dedupCategory(subtype, type);
    const family = dedupFamily(subtype, type);
    const cy = Math.floor(lat * 100);
    const cx = Math.floor(lng * 100);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const n of this.grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const radius =
            n.cat === cat ? DEDUP_RADIUS_M : n.family === family ? CROSS_CATEGORY_RADIUS_M : -1;
          if (radius < 0) continue;
          const meters = haversineMeters(lat, lng, n.lat, n.lng);
          if (meters > radius) continue;
          /**
           * Zwei Bahnhöfe auf 150 m sind derselbe — egal, wie sie geschrieben
           * werden: „Haiger-Allendorf Bahnhof" (Feed) ist unser „Allendorf
           * (Dillkreis)", „Eislingen (F)" unser „Eislingen (Fils)". Bei Bus und
           * Tram gilt das NICHT: Dort stehen verschiedene Haltestellen oft
           * keine 150 m auseinander.
           */
          if (family === "RAIL" && n.family === "RAIL" && meters <= CROSS_CATEGORY_RADIUS_M) return true;
          if (sameStopName(n.label, label, { veryClose: meters <= CROSS_CATEGORY_RADIUS_M })) return true;
        }
      }
    }
    return false;
  }
}
