/**
 * Country → HAFAS-Profile Routing.
 *
 * Wir nutzen ZWEI verschiedene HAFAS-Backends:
 *   1. db-vendo-client (separater Docker-Container, HTTP-API) — nur für DE
 *      weil das Profil "dbnav" Live-Daten + Buchungs-Token liefert die unsere
 *      Such-Pipeline schon nutzt.
 *   2. hafas-client npm (in-process, mehrere Profile) — für AT/PL/LU/DK.
 *
 * Diese Datei entscheidet pro Stop, welcher Pfad zu nehmen ist. Der eigentliche
 * Aufruf passiert in stopInfoService (für Abfahrten/Ankünfte) bzw. trips.ts
 * (für Trip-Details).
 */

/** Profile-Keys die wir hier unterscheiden. "db" ist semantisch ein eigener
 *  Pfad (db-vendo-client) und KEIN Profile-Name aus hafas-client/p/.
 *  Österreich wird PRO BUNDESLAND auf den jeweiligen Verbund geroutet, weil
 *  oebb nur Wien-Daten (über VOR-Integration) hat — Salzburg/Tirol/etc.
 *  brauchen ihre eigenen Verbund-Profile um Bus/Tram zu sehen. */
export type HafasProfileKey =
  | "db"
  | "oebb"
  | "pkp"
  | "cfl"
  | "rejseplanen"
  // Österreich-Verbünde
  | "vor" // Wien / Niederösterreich / Burgenland
  | "vvt" // Tirol (Innsbruck etc.)
  | "svv" // Salzburger Verkehrsverbund
  | "ooevv" // Oberösterreich (Linz etc.)
  | "stv" // Steiermark (Graz etc.)
  | "vkg" // Kärnten (Klagenfurt etc.)
  | "vvv" // Vorarlberg (Bregenz etc.)
  // Schweiz-Regional-Profile (kein nationales SBB-HAFAS verfügbar)
  | "bls" // Bern / Mittelland
  | "zvv" // Zürich
  | "tpg"; // Genf

/** Profile die via hafas-client npm bedient werden (nicht db-vendo-client). */
export type MultiHafasProfileKey = Exclude<HafasProfileKey, "db">;

const COUNTRY_TO_PROFILE: Record<string, HafasProfileKey> = {
  Germany: "db",
  Austria: "oebb",
  Poland: "pkp",
  Luxembourg: "cfl",
  Denmark: "rejseplanen",
  // Belgium: SNCB-HAFAS-API ist defekt ("Invalid client version") — wir nutzen
  // stattdessen das DB-Profil via db-vendo. DB-HAFAS kennt die meisten BE-
  // Stationen (UIC-Prefix 88) durch IC/ICE/Thalys-Integration. Stops die DB
  // nicht kennt liefern leere Boards (Walk-+-Train-Hybrid übernimmt dann).
  Belgium: "db",
  // Schweiz: kein national-Profile, default Bern/Mittelland. Andere Regionen
  // (Zürich/Genf) werden per Coord-Bbox überschrieben.
  Switzerland: "bls",
};

/** GTFS-Präfixe sind eindeutig (vom Importer gesetzt). */
const GTFS_PREFIX_TO_PROFILE: Array<[RegExp, HafasProfileKey]> = [
  [/^gtfs:de:/i, "db"],
  [/^gtfs:at:/i, "oebb"],
  [/^gtfs:pl:/i, "pkp"],
  [/^gtfs:lu:/i, "cfl"],
  [/^gtfs:dk:/i, "rejseplanen"],
  [/^gtfs:be:/i, "db"],
];

/** UIC-Country-Code-Prefix (erste 2 Ziffern einer 7-stelligen EVA-Nummer) →
 *  Profile. Quelle: UIC merkblatt, z.B. 80=DE, 81=AT, 85=CH, 86=DK, 88=BE.
 *  Stations die wir aus StaDa-/DB-Importen mit `sta:` oder roher 7-Ziffer-ID
 *  haben, sind nur durch die UIC-Country zuverlässig zuzuordnen — `sta:` ist
 *  KEIN reiner DE-Marker (auch wenn die Abkürzung das suggeriert). */
const UIC_PREFIX_TO_PROFILE: Record<string, HafasProfileKey> = {
  "80": "db", // Germany
  "81": "oebb", // Austria
  "82": "cfl", // Luxembourg
  "51": "pkp", // Poland
  "86": "rejseplanen", // Denmark
  "88": "db", // Belgium — via DB-HAFAS (sncb-Profile defekt, siehe Kommentar oben)
  // 83 (IT), 84 (NL), 85 (CH), 87 (FR) — kein hafas-client-Profile
  // verfügbar/funktionierend. Stops dort liefern `null` → empty StopBoard.
};

/** Country-Name (text in DB) → Profile. Fallback wenn weder GTFS-Präfix noch
 *  UIC-Code aus der ID herausgelesen werden kann. */
const COUNTRY_NAME_TO_PROFILE: Record<string, HafasProfileKey> = COUNTRY_TO_PROFILE;

/** Extrahiert die UIC-Country aus einem `sta:`-Code oder einer rohen
 *  7-stelligen Nummer. Liefert null wenn das nicht erkennbar ist. */
function uicCountryFromCode(code: string): string | null {
  const m = code.match(/^(?:sta:|dbrest:)?(\d{2})\d{5,7}$/i);
  return m && m[1] ? m[1] : null;
}

/** Bbox-basierte Bundesland-Erkennung für Österreich. Reihenfolge MATTERS —
 *  kleinere Boxes zuerst, sonst frisst NÖ den Wiener Match.
 *
 *  WIEN ABSICHTLICH NICHT GELISTET: `oebb` deckt Wien über die VOR-
 *  Integration ab UND kennt unsere StaDa-IDs (8103xxx etc.). Würden wir Wien
 *  hier auf "vor" routen, würde `vor` die UIC-IDs nicht erkennen und alle
 *  Wiener Stops würden 0 Departures liefern. Wien bleibt also auf oebb.
 *
 *  Andere Bundesländer: oebb hat dort nur Bahn-Daten. Für Bus/Tram müssen wir
 *  ins Verbund-Profile. ABER: oebb-style UIC-IDs (81xxxxx) sind nicht
 *  zwingend mit den Verbund-Profilen kompatibel — siehe
 *  `isAtRegionalProfile()`, der Caller muss in dem Fall via coord neu
 *  resolven statt unsere gespeicherte hafasId zu nehmen.
 *
 *  [N, W, S, E]. */
const AT_REGION_BBOXES: Array<{ profile: HafasProfileKey; bbox: [number, number, number, number] }> = [
  { profile: "vvv", bbox: [47.60, 9.53, 47.06, 10.30] }, // Vorarlberg
  { profile: "vvt", bbox: [47.74, 10.10, 46.65, 12.95] }, // Tirol
  { profile: "svv", bbox: [48.10, 12.10, 46.95, 13.50] }, // Salzburg
  { profile: "ooevv", bbox: [48.78, 12.74, 47.46, 14.85] }, // Oberösterreich
  { profile: "vkg", bbox: [47.13, 12.65, 46.37, 15.06] }, // Kärnten
  { profile: "stv", bbox: [47.83, 13.55, 46.65, 16.21] }, // Steiermark
];

function atRegionFromCoord(lat: number, lon: number): HafasProfileKey | null {
  for (const { profile, bbox } of AT_REGION_BBOXES) {
    const [n, w, s, e] = bbox;
    if (lat <= n && lat >= s && lon >= w && lon <= e) return profile;
  }
  return null;
}

/** Schweiz-Region-Bboxen. SBB hat kein nationales HAFAS mehr, daher
 *  ein Fleckenteppich aus Regional-Profilen. Nicht-abgedeckte Gebiete
 *  bleiben auf bls (das deckt Bern/Mittelland und kennt teils auch
 *  länderübergreifende Routen). */
const CH_REGION_BBOXES: Array<{ profile: HafasProfileKey; bbox: [number, number, number, number] }> = [
  { profile: "zvv", bbox: [47.70, 8.40, 47.20, 9.00] }, // Zürich
  { profile: "tpg", bbox: [46.40, 5.95, 46.10, 6.50] }, // Genf
];

function chRegionFromCoord(lat: number, lon: number): HafasProfileKey | null {
  for (const { profile, bbox } of CH_REGION_BBOXES) {
    const [n, w, s, e] = bbox;
    if (lat <= n && lat >= s && lon >= w && lon <= e) return profile;
  }
  return null;
}

/** True für AT-Verbund-Profile + CH-Regional-Profile. Caller braucht das um
 *  zu entscheiden ob die gespeicherte hafasId verwendet werden kann oder ob
 *  via coord neu resolved werden muss (Verbund-Profile haben eigene ID-Räume
 *  die nicht mit UIC-EVA matchen). */
export function isAtRegionalProfile(profile: HafasProfileKey): boolean {
  return profile === "vor" || profile === "vvt" || profile === "svv"
    || profile === "ooevv" || profile === "stv" || profile === "vkg"
    || profile === "vvv"
    || profile === "bls" || profile === "zvv" || profile === "tpg";
}

/** Liefert das Profil für einen Stop. Reihenfolge:
 *    1. GTFS-Präfix (eindeutig vom Importer)
 *    2. UIC-Country aus `sta:`-Code oder roher Ziffern-ID
 *    3. Country-Name aus `locations.country` (DB-Spalte)
 *  + Spezialfall AT: pro Bundesland zur Verbund-Profile routen (nur wenn
 *    lat/lon mitkommt). Ohne Coord fällt's auf `oebb` zurück (national).
 *  Returns null wenn das Land nicht unterstützt wird. */
export function profileForStop(args: {
  code: string;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}): HafasProfileKey | null {
  // Generelle Country-Erkennung über Code-Präfix / UIC / DB-Spalte.
  let profile: HafasProfileKey | null = null;
  for (const [re, p] of GTFS_PREFIX_TO_PROFILE) {
    if (re.test(args.code)) {
      profile = p;
      break;
    }
  }
  if (!profile) {
    const uic = uicCountryFromCode(args.code);
    if (uic && UIC_PREFIX_TO_PROFILE[uic]) profile = UIC_PREFIX_TO_PROFILE[uic];
  }
  if (!profile && args.country) {
    profile = COUNTRY_NAME_TO_PROFILE[args.country] ?? null;
  }
  if (!profile) return null;

  // Österreich-Sonderfall: lokale Verbund-Profile pro Bundesland. `oebb` ist
  // ein OK-Fallback fürs Wiener Umfeld (hat VOR-Integration), aber für
  // Salzburg/Tirol/Graz brauchen wir SVV/VVT/STV etc. um Bus/Tram zu sehen.
  if (profile === "oebb" && args.latitude != null && args.longitude != null) {
    const region = atRegionFromCoord(args.latitude, args.longitude);
    if (region) return region;
  }

  // Schweiz-Sonderfall: kein SBB-Hafas, also pro Region (Zürich → zvv,
  // Genf → tpg, Rest → bls/Mittelland).
  if (profile === "bls" && args.latitude != null && args.longitude != null) {
    const region = chRegionFromCoord(args.latitude, args.longitude);
    if (region) return region;
  }

  return profile;
}
