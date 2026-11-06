/**
 * Anzeigenamen der Haltestellen — der OFFIZIELLE Name, nicht mehr und nicht
 * weniger (Okt. 2026).
 *
 * `locations.label` trägt den Namen der Quelle, und der enthält oft Teile, die
 * für uns wichtig sind (zwei Straßenseiten, zwei Masten, ein Busbahnhof mit
 * zwölf Steigen auseinanderhalten), für den Nutzer aber nur Rauschen:
 *
 *   „Oldham, Rochdale Road / Oldham College (Stop RA)"   — Ort, Straße, Halt-Buchstabe
 *   „Bernburg Alter Markt, Richtung Flutbrücke"          — Fahrtrichtung
 *   „Metro Politechnika 02"                              — Mastnummer
 *
 * Fährt man von dort los, zeigt die Zeitleiste „Oldham College" — der Name aus
 * dem Fahrplan. Zwei Namen für denselben Halt verwirren. Darum steht neben
 * `label` jetzt `display_name` (der offizielle Name, NULL = `label` ist es
 * schon) und `display_detail` (der Zusatz, NUR wenn ein gleichnamiger Halt
 * daneben steht — sonst gibt es nichts zu unterscheiden).
 *
 * `label` selbst bleibt, wie es ist: Mit ihm gleichen Tafel, Bahn-Ortssuche,
 * Dubletten-Prüfung und Kartengruppierung ab, und die Suche findet weiter über
 * beide Namen („Rochdale Road" trifft den Halt nach wie vor).
 *
 * Woher der offizielle Name kommt:
 *   • Großbritannien: Fahrplan-Zwilling aus BODS (`gtfs_stops`, NaPTAN-Name) —
 *     derselbe Name, den die Zeitleiste zeigt. Sonst die Quelle, bereinigt.
 *   • Niederlande: Fahrplan-Zwilling aus OVapi („Enschede, Lindestraat" — so
 *     heißt der Halt dort amtlich, mit Ort).
 *   • Tschechien NICHT über den Zwilling: Der PID-Fahrplan kürzt ab
 *     („Český Brod,nem."), OSM führt denselben Namen ausgeschrieben.
 *   • Belgien/Frankreich: Die Feeds dort enthalten nur Bahnhöfe, und die
 *     bleiben, wie sie sind.
 *   • Überall sonst: die Quelle, ohne eindeutige Zusätze (Fahrtrichtung,
 *     Steig, Mast, Bedarfshalt). Ortsvorsätze bleiben außerhalb
 *     Großbritanniens — „Praha, Florenc", „Utrecht, Centraal Station",
 *     „Zürich, Paradeplatz" heißen amtlich so.
 *   • Überall: ein Ortsvorsatz, den der Name danach WIEDERHOLT, fällt weg
 *     (`stripDoubledCity`: „Frankfurt am Main Frankfurt (Main) Börneplatz" →
 *     „Frankfurt (Main) Börneplatz"). Den Vorsatz setzte ein früheres Skript
 *     vor Namen, die ihren Ort schon trugen — 19 250 Halte, 15 800 in DE.
 *   • StaDa (Bahnhöfe) wird nie angefasst.
 *
 * Gemeinsam für `fix-stop-names.ts` (Bestand) und die Importe
 * (`import-osm-stops.ts`, `import-gb-missing-stops.ts`, `import-gtfs.ts`).
 */
import type pg from "pg";
import { dedupCategory } from "./locationDedup.js";
import {
  GB_GENERIC,
  gbGenericOrIndicator,
  splitGbName,
  splitGenericName,
  timetableStopName,
  type SplitName,
} from "../../src/util/stopDisplayName.js";

// Die reinen Namensregeln stehen in src/util/stopDisplayName.ts (der Server
// braucht sie für die britische Zeitleiste) — hier weitergereicht.
export { GB_GENERIC, splitGbName, splitGenericName, type SplitName };

export const GB = "United Kingdom";
export const NL = "Netherlands";

// ---------------------------------------------------------------------------
// Vergleich und Fahrplan-Zwilling
// ---------------------------------------------------------------------------
const ABBR: Record<string, string> = {
  street: "st", st: "st", saint: "st",
  road: "rd", rd: "rd",
  avenue: "av", ave: "av", av: "av",
  lane: "ln", ln: "ln",
  drive: "dr", dr: "dr",
  crescent: "cr", cres: "cr", cr: "cr",
  close: "cl", cl: "cl",
  terrace: "ter", terr: "ter", ter: "ter",
  square: "sq", sq: "sq",
  place: "pl", pl: "pl",
  gardens: "gdns", gdns: "gdns",
  court: "ct", ct: "ct",
  church: "ch", ch: "ch",
  station: "stn", stn: "stn",
  hospital: "hosp", hosp: "hosp",
  school: "sch", sch: "sch",
  junction: "jct", jct: "jct", jn: "jct",
  corner: "cnr", cnr: "cnr",
  and: "and",
};

export function normForCompare(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['’´`]/g, "")
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => ABBR[t] ?? t)
    .join(" ");
}

/**
 * Bezeichnen beide Namen erkennbar dasselbe? Einer steckt WORTWEISE im anderen
 * („Lindestraat" in „Enschede, Lindestraat"), oder beide sind ohne
 * Leerzeichen gleich („Newton Wood Lane" / „Newtonwood Lane"). Nicht als
 * Teilstring mitten im Wort — sonst passte „Kerk" auf „Dorp, Kerkstraat".
 */
export function namesCompatible(a: string, b: string): boolean {
  const x = normForCompare(a);
  const y = normForCompare(b);
  if (!x || !y) return false;
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return true;
  return x.replace(/ /g, "") === y.replace(/ /g, "");
}

export interface TwinStop {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
}

/** Raster über die Fahrplan-Halte — der nächste Zwilling ohne Datenbank-Runde je Halt. */
export class TwinIndex {
  private static readonly CELL = 0.001; // ~110 m Breite
  private readonly grid = new Map<string, TwinStop[]>();
  constructor(stops: TwinStop[]) {
    for (const s of stops) {
      const k = TwinIndex.key(s.lat, s.lon);
      const arr = this.grid.get(k);
      if (arr) arr.push(s);
      else this.grid.set(k, [s]);
    }
  }
  private static key(lat: number, lon: number): string {
    return `${Math.floor(lat / TwinIndex.CELL)}|${Math.floor(lon / TwinIndex.CELL)}`;
  }
  /** Alle Halte im Umkreis, nächster zuerst. */
  near(lat: number, lon: number, radiusM: number): Array<{ stop: TwinStop; d: number }> {
    const cy = Math.floor(lat / TwinIndex.CELL);
    const cx = Math.floor(lon / TwinIndex.CELL);
    const cos = Math.cos((lat * Math.PI) / 180);
    const rings = Math.ceil(radiusM / (111_320 * TwinIndex.CELL * Math.max(cos, 0.2))) + 1;
    const out: Array<{ stop: TwinStop; d: number }> = [];
    for (let dy = -rings; dy <= rings; dy++) {
      for (let dx = -rings; dx <= rings; dx++) {
        for (const s of this.grid.get(`${cy + dy}|${cx + dx}`) ?? []) {
          const d = 111_320 * Math.hypot(s.lat - lat, (s.lon - lon) * cos);
          if (d <= radiusM) out.push({ stop: s, d });
        }
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }
}

/** Bis hierhin gilt der nächste Fahrplan-Halt auch mit anderem Namen als derselbe Halt (gleicher NaPTAN-/CHB-Punkt). */
export const TWIN_SAME_POINT_M = 5;
/** Bis hierhin, wenn der Name erkennbar derselbe ist. */
export const TWIN_SAME_NAME_M = 40;

/**
 * Den Fahrplan-Zwilling wählen: der nächste mit erkennbar demselben Namen
 * (≤ 40 m), sonst der nächste überhaupt, wenn er praktisch auf demselben Punkt
 * steht (≤ 5 m). Am Fahrplan geprüft: Bis 5 m ist ein abweichender Name fast
 * immer derselbe Halt, nur anders benannt (OSM-Konvention „Straße/Straße",
 * umbenannter Halt) — dahinter oft schon der Nachbarhalt.
 */
export function pickTwin(index: TwinIndex, lat: number, lon: number, label: string): { stop: TwinStop; d: number; same: boolean } | null {
  const cands = index.near(lat, lon, TWIN_SAME_NAME_M);
  for (const c of cands) if (namesCompatible(label, c.stop.name)) return { ...c, same: true };
  const first = cands[0];
  return first && first.d <= TWIN_SAME_POINT_M ? { ...first, same: false } : null;
}

// ---------------------------------------------------------------------------
// Ein Halt → Anzeigename
// ---------------------------------------------------------------------------
export interface StopRow {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: string;
  subtype: string | null;
  source: string | null;
  lat: number | null;
  lon: number | null;
  displayName: string | null;
  displayDetail: string | null;
  /** Name im aktuellen Fahrplan (Abgleich) — Grundlage statt `label`, wo vorhanden. */
  sourceName: string | null;
  /** Station eines Steigs — der Steig trägt ihren Namen. */
  parentCode: string | null;
}

/**
 * fahrplan = Name aus dem aktuellen Fahrplan statt aus `label` („Hbf Nord" →
 * „Hauptbahnhof Nord"); steig = Name der Station (übernommene Masten wie MVG
 * „Hbf Süd" unter „Hauptbahnhof Süd"); wien = Wiener Halt im Stil der Wiener
 * Linien (`viennaName`).
 */
export type NameRule = "gbtwin" | "gbclean" | "nltwin" | "clean" | "fahrplan" | "steig" | "wien";

export interface NameDecision {
  /** Der offizielle Name — gleich `label`, wenn nichts zu ändern ist. */
  name: string;
  /** Die abgetrennten Teile des QUELL-Namens (Straße, Seite, Steig …). */
  parts: string[];
  rule: NameRule | null;
  twin?: { stopId: string; name: string; d: number; same: boolean };
}

const RAIL_SUBTYPES = new Set(["LONG_DISTANCE", "REGIONAL", "SUBURBAN"]);

/**
 * Anzeigename eines Halts. `twins` = Fahrplan-Halte seines Landes (nur GB/NL),
 * schon nach Verkehrsart vorgefiltert (siehe `loadTwins`).
 */
export function decideName(row: StopRow, twins: TwinIndex | null): NameDecision {
  const vienna = viennaName(row);
  if (vienna) {
    const d = decideNameInner({ ...row, label: vienna }, twins);
    return { ...d, rule: d.name === row.label ? null : "wien" };
  }
  const fromLabel = withoutCityPrefix(decideNameInner(row, twins), row);
  const ws = (v: string) => v.replace(/\s+/g, " ").trim();
  if (!row.sourceName || ws(row.sourceName) === ws(row.label)) return fromLabel;
  const fromFeed = withoutCityPrefix(decideNameInner({ ...row, label: row.sourceName }, twins), row);
  return feedNameAdds(fromLabel.name, fromFeed.name) ? { ...fromFeed, rule: "fahrplan" } : fromLabel;
}

/**
 * Wien (Okt. 2026, Wunsch des Nutzers): Bus, Tram und U-Bahn heißen wie bei den Wiener Linien —
 * „Hauptbahnhof", „Rennweg". Das alte Präfix-Skript hatte 1 878 Wiener Halten einen Bezirksteil
 * aus der früheren, länderblinden Gemeinde-Regel vorangestellt („Matzleinsdorf Hbf", „Landstraße
 * Rennweg"); der österreichweite Fahrplan setzt „Wien" davor. Beides fällt weg, der Name kommt aus
 * dem Fahrplan (Kennung at:49:… = Wien). Mit dem Bezirksteil verschwand auch der Grund, warum der
 * Abgleich die OSM-Dubletten daneben nicht erkannte („Kolschitzkygasse").
 *
 * Bahnhöfe behalten den ÖBB-Namen: Ohne Ort hieße „Wien Mitte" nur „Mitte" — darum bleibt
 * auch „Wien Mitte-Landstraße". Gilt für Masten (`at:49:…`) wie Stationen (`Pat:49:…`, seit
 * dem österreichweiten Fahrplan); Steige folgen ihrer Station (Regel „steig").
 */
function viennaName(row: StopRow): string | null {
  // „n" davor: belegte Kennung, neu vergeben (`freeCode` im Import, add-missing-poles.ts).
  if (!/^gtfs:at:[nP]?at:49:/.test(row.code) || !row.sourceName || RAIL_SUBTYPES.has(row.subtype ?? "")) return null;
  const name = row.sourceName.replace(/^Wien[\s,]+/, "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && !/^Mitte\b/.test(name) ? name : null;
}

function withoutCityPrefix(d: NameDecision, row: StopRow): NameDecision {
  const noExonym = stripExonymCity(d.name, row.city, row.country);
  const name = stripDoubledCity(noExonym ?? d.name, row.city) ?? noExonym;
  return name ? { ...d, name, rule: d.rule ?? "clean" } : d;
}

/** Abkürzungen, die der Fahrplan ausschreibt („Hbf Nord" → „Hauptbahnhof Nord"). */
const ABBREVIATIONS: Record<string, string> = { hbf: "hauptbahnhof", bf: "bahnhof", bhf: "bahnhof" };

function nameTokens(v: string): string[] {
  return v
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Taugt der Fahrplan-Name als Anzeigename? Nur, wenn er nichts verliert und
 * etwas hinzufügt. Die alten Labels tragen oft den Ort vorn (Präfix-Skript:
 * „Hof Joensuustr."; Wien regelt seit 27.10. `viennaName`); der Fahrplan nennt
 * dort nur die Straße — 110 000 Halte hätten ihren Ort verloren. Übernommen
 * wird also nur, wenn jedes bisherige Wort im Fahrplan-Namen steht (auch
 * ausgeschrieben: „Str." → „Straße", „Hbf" → „Hauptbahnhof") UND er ein neues
 * Wort bringt. Reine Komma-, Akzent- oder Doppel-Unterschiede („Gąssy" →
 * „Gassy", „Hausach Schulen,Hausach") ändern nichts.
 */
export function feedNameAdds(current: string, feed: string): boolean {
  const cur = nameTokens(current);
  const fed = nameTokens(feed);
  const covered = (w: string) =>
    fed.includes(w) ||
    (ABBREVIATIONS[w] !== undefined && fed.includes(ABBREVIATIONS[w]!)) ||
    fed.some((f) => f.length > w.length && f.startsWith(w));
  return cur.every(covered) && fed.some((f) => !cur.includes(f));
}

/**
 * Englische Namen großer Städte, die das alte Präfix-Skript (GeoNames-Name im
 * Stadtfeld) vor die Halte setzte: „Munich München Hbf", „Munich Hbf Nord",
 * „Nuremberg Nürnberg-Mögeldorf", „Vienna Plankengasse" — 5 300 Halte. In
 * IHREM Land ist der englische Name nie Teil eines amtlichen Haltnamens; im
 * Ausland bleibt er („Hanover Place", „Florence Ave" in England).
 */
const EXONYM_CITIES: Record<string, { country: string; local: string[] }> = {
  munich: { country: "Germany", local: ["münchen"] },
  nuremberg: { country: "Germany", local: ["nürnberg"] },
  cologne: { country: "Germany", local: ["köln"] },
  hanover: { country: "Germany", local: ["hannover"] },
  brunswick: { country: "Germany", local: ["braunschweig"] },
  vienna: { country: "Austria", local: ["wien"] },
  prague: { country: "Czech Republic", local: ["praha"] },
  warsaw: { country: "Poland", local: ["warszawa"] },
  krakow: { country: "Poland", local: ["kraków"] },
  brussels: { country: "Belgium", local: ["bruxelles", "brussel"] },
  antwerp: { country: "Belgium", local: ["antwerpen"] },
  ghent: { country: "Belgium", local: ["gent"] },
  bruges: { country: "Belgium", local: ["brugge"] },
  "the hague": { country: "Netherlands", local: ["den haag"] },
  lisbon: { country: "Portugal", local: ["lisboa"] },
  rome: { country: "Italy", local: ["roma"] },
  milan: { country: "Italy", local: ["milano"] },
  naples: { country: "Italy", local: ["napoli"] },
  turin: { country: "Italy", local: ["torino"] },
  florence: { country: "Italy", local: ["firenze"] },
  venice: { country: "Italy", local: ["venezia"] },
  genoa: { country: "Italy", local: ["genova"] },
  geneva: { country: "Switzerland", local: ["genève"] },
  zurich: { country: "Switzerland", local: ["zürich"] },
  copenhagen: { country: "Denmark", local: ["københavn"] },
  seville: { country: "Spain", local: ["sevilla"] },
};

/**
 * „Munich München Hbf" → „München Hbf", „Munich Hbf Nord" → „Hbf Nord": der
 * englische Stadtname vorn fällt weg, wenn der Halt in diesem Land liegt und
 * seine Gemeinde diese Stadt ist (englisch oder in Landessprache im Stadtfeld).
 */
export function stripExonymCity(
  name: string,
  city: string | null | undefined,
  country: string | null | undefined,
): string | null {
  if (!name || !city || !country) return null;
  const lower = name.toLowerCase();
  const cityLower = city.toLowerCase();
  for (const [exo, info] of Object.entries(EXONYM_CITIES)) {
    if (info.country !== country) continue;
    if (cityLower !== exo && !info.local.includes(cityLower)) continue;
    if (!lower.startsWith(`${exo} `) && !lower.startsWith(`${exo},`)) continue;
    const rest = name.slice(exo.length).replace(/^[\s,]+/, "").trim();
    if (rest.length >= 3 && /^[\p{L}\p{N}]/u.test(rest)) return rest;
  }
  return null;
}

/**
 * Wörter, mit denen viele Ortsnamen beginnen — für sie zählt das ERSTE PAAR
 * („Bad Soden", „Saint-Genis"): Sonst wäre „Church Common Church" ein
 * doppelter Ort und bliebe als „Church" stehen.
 */
const GENERIC_FIRST_WORDS = new Set(
  `bad les la le l saint sainte st ste san santa santo sankt sint market church new old upper lower great little
   east west north south nieder ober unter alt neu gross klein hohen den de het el il lo los las das der die
   mont port pont villa vila`.split(/\s+/),
);

const foldForPrefix = (v: string) =>
  v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ß/g, "ss");
const prefixWords = (v: string) => foldForPrefix(v).split(/[\s\-/(),.]+/).filter(Boolean);

/**
 * „<Gemeinde> <Name>" → „<Name>", wenn der Name selbst mit derselben Gemeinde
 * beginnt: „Frankfurt am Main Frankfurt (Main) Börneplatz", „Brandenburg an
 * der Havel Brandenburg, Christinenstr.", „Skingen, Skingen". Ein früheres
 * Skript (prefix-city-to-label) setzte die Gemeinde vor jeden Namen, auch vor
 * die, die ihren Ort schon trugen.
 *
 * Nur, wenn der Vorsatz GENAU die Gemeinde des Halts ist (`city`) und der Rest
 * mit deren erstem Wort beginnt (bei Allerweltswörtern wie „Bad", „Saint" mit
 * den ersten beiden). Sonst nichts: „Via Galvani - Via Copernico" ist eine
 * Kreuzung, „Tower Hill / Tower Gateway Station" auch.
 */
export function stripDoubledCity(name: string, city: string | null | undefined): string | null {
  if (!name || !city) return null;
  const fc = foldForPrefix(city);
  if (!foldForPrefix(name).startsWith(fc)) return null;
  // Schnittstelle im ORIGINAL — „ß" faltet zu zwei Zeichen, also schrittweise suchen.
  let cut = -1;
  for (let i = 1; i <= name.length; i++) {
    if (foldForPrefix(name.slice(0, i)) === fc) {
      cut = i;
      break;
    }
  }
  if (cut < 0 || !/^[\s,]/.test(name.slice(cut))) return null;
  const rest = name.slice(cut).replace(/^[\s,]+/, "").trim();
  if (rest.length < 3 || !/^[\p{L}\p{N}]/u.test(rest)) return null;
  const cw = prefixWords(city);
  if (cw.length === 0) return null;
  const key = GENERIC_FIRST_WORDS.has(cw[0]!) && cw.length >= 2 ? cw.slice(0, 2) : cw.slice(0, 1);
  if (key[0]!.length < 3) return null;
  const rw = prefixWords(rest);
  return key.every((w, i) => rw[i] === w) ? rest : null;
}

function decideNameInner(row: StopRow, twins: TwinIndex | null): NameDecision {
  const keep: NameDecision = { name: row.label, parts: [], rule: null };
  if (row.source === "stada" || (row.type !== "BUS" && row.type !== "TRAIN")) return keep;

  if (row.country === GB) {
    if (row.type === "TRAIN") {
      // Bahnhöfe und Tram-Halte aus OSM heißen schon richtig; nur die aus dem
      // Fahrplan angelegten tragen den Netz-Zusatz.
      if (row.source !== "gtfs") return keep;
      const s = splitGbName(row.label, { train: true });
      return s.name !== row.label ? { name: s.name, parts: s.parts, rule: "gbclean" } : keep;
    }
    const fromOsm = row.source === "osm";
    const own = splitGbName(row.label, { city: row.city, fromOsm });
    if (fromOsm && twins && row.lat != null && row.lon != null) {
      const t = pickTwin(twins, row.lat, row.lon, own.name);
      if (t) {
        const twinName = splitGbName(t.stop.name, { city: row.city }).name;
        // Ein nichtssagender Fahrplan-Name („Bus Station", „Stance A") ersetzt
        // keinen mit Ort.
        const name = gbGenericOrIndicator(twinName) ? own.name : twinName;
        return {
          name,
          parts: own.parts,
          rule: name === own.name ? "gbclean" : "gbtwin",
          twin: { stopId: t.stop.stopId, name: t.stop.name, d: Math.round(t.d), same: t.same },
        };
      }
    }
    return { name: own.name, parts: own.parts, rule: own.name !== row.label ? "gbclean" : null };
  }

  if (row.country === NL && row.source === "osm" && twins && row.lat != null && row.lon != null && !RAIL_SUBTYPES.has(row.subtype ?? "")) {
    const own = splitGenericName(row.label, row.country);
    const t = pickTwin(twins, row.lat, row.lon, own.name);
    if (t) {
      const twinName = splitGenericName(t.stop.name, row.country).name;
      return {
        name: twinName,
        parts: own.parts,
        rule: "nltwin",
        twin: { stopId: t.stop.stopId, name: t.stop.name, d: Math.round(t.d), same: t.same },
      };
    }
  }

  const own = splitGenericName(row.label, row.country);
  return { name: own.name, parts: own.parts, rule: own.name !== row.label ? "clean" : null };
}

// ---------------------------------------------------------------------------
// Zusatz bei gleichnamigen Nachbarn
// ---------------------------------------------------------------------------
/** In diesem Umkreis braucht ein gleichnamiger Halt derselben Art einen Zusatz. */
export const DETAIL_RADIUS_M = 400;

/**
 * Zusatz für Halte, deren Anzeigename ein Nachbar derselben Art (Bahn, U-Bahn,
 * Tram, Bus, Fähre) im Umkreis von 400 m ebenfalls trägt — die drei „Oldham
 * College" an zwei Straßen. Der Zusatz kommt aus den abgetrennten Teilen des
 * Quellnamens („Rochdale Road · Stop RA"). Ohne Kollision: kein Zusatz — der
 * Name allein ist dann eindeutig genug.
 */
export function computeDetails(
  rows: Array<{ code: string; type: string; subtype: string | null; lat: number | null; lon: number | null; name: string; parts: string[] }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.lat == null || r.lon == null || r.parts.length === 0) continue;
    const key = `${dedupCategory(r.subtype, r.type)}|${normForCompare(r.name)}`;
    const arr = byKey.get(key);
    if (arr) arr.push(r);
    else byKey.set(key, [r]);
  }
  // Auch Halte OHNE Teile zählen als Nachbar — sie stehen nur nicht im Ergebnis.
  const allByKey = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${dedupCategory(r.subtype, r.type)}|${normForCompare(r.name)}`;
    if (!byKey.has(key)) continue;
    const arr = allByKey.get(key);
    if (arr) arr.push(r);
    else allByKey.set(key, [r]);
  }
  for (const [key, withParts] of byKey) {
    const all = allByKey.get(key) ?? withParts;
    if (all.length < 2) continue;
    for (const r of withParts) {
      const cos = Math.cos((r.lat! * Math.PI) / 180);
      const clash = all.some(
        (o) => o.code !== r.code && 111_320 * Math.hypot(o.lat! - r.lat!, (o.lon! - r.lon!) * cos) <= DETAIL_RADIUS_M,
      );
      if (clash) out.set(r.code, r.parts.join(" · "));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Laden und für ein ganzes Land berechnen
// ---------------------------------------------------------------------------
export async function loadCountryRows(pool: pg.Pool | pg.PoolClient, country: string): Promise<StopRow[]> {
  const r = await pool.query<StopRow>(
    `SELECT code, label, city, country, type, subtype, source,
            latitude::float8 AS lat, longitude::float8 AS lon,
            display_name AS "displayName", display_detail AS "displayDetail",
            source_name AS "sourceName", parent_code AS "parentCode"
     FROM locations WHERE country = $1 AND type IN ('BUS', 'TRAIN')`,
    [country],
  );
  return r.rows;
}

/**
 * Fahrplan-Halte, die als Zwilling in Frage kommen — gleiche Verkehrsart:
 *   • GB: nur Bus-/Reisebus-Halte. NaPTAN kennt Bahn, Luftfahrt, Fähre und
 *     Tram/Metro an der Kennung (910/920/930/940…); die bleiben draußen.
 *   • NL: nur Halte im CHB-Schema „Ort, Halt" (Bus, Tram, Metro). Bahnsteige
 *     heißen dort ohne Komma („Utrecht Centraal").
 */
export async function loadTwins(pool: pg.Pool | pg.PoolClient, country: string): Promise<TwinIndex | null> {
  const feed = country === GB ? "gb-gtfs" : country === NL ? "nl-ovapi" : null;
  if (!feed) return null;
  const r = await pool.query<{ stopId: string; name: string; lat: number; lon: number }>(
    `SELECT stop_id AS "stopId", name, latitude::float8 AS lat, longitude::float8 AS lon
     FROM gtfs_stops
     WHERE feed_id = $1 AND coalesce(location_type, 0) = 0 AND name IS NOT NULL AND latitude IS NOT NULL
       AND abs(latitude) > 1`,
    [feed],
  );
  const stops = r.rows.filter((s) =>
    country === GB ? !/^9[1-4]0/.test(s.stopId) && s.name.trim() !== "" : /, /.test(s.name),
  );
  return stops.length > 0 ? new TwinIndex(stops) : null;
}

export interface CountryNames {
  rows: StopRow[];
  decisions: Map<string, NameDecision>;
  details: Map<string, string>;
}

/**
 * Anzeigenamen und Zusätze für alle Halte eines Landes. `sourceNames` ersetzt
 * `source_name` im Speicher — für den Probelauf, bevor die Spalte gefüllt ist.
 */
export async function computeCountryNames(
  pool: pg.Pool | pg.PoolClient,
  country: string,
  opts: { sourceNames?: Map<string, string> } = {},
): Promise<CountryNames> {
  const rows = await loadCountryRows(pool, country);
  if (opts.sourceNames) {
    for (const row of rows) row.sourceName = opts.sourceNames.get(row.code) ?? row.sourceName;
  }
  const twins = country === GB || country === NL ? await loadTwins(pool, country) : null;
  const decisions = new Map<string, NameDecision>();
  for (const row of rows) decisions.set(row.code, decideName(row, twins));
  /**
   * Ein Steig aus einem Fahrplan trägt den Namen seiner Station: Übernommene
   * Zeilen behalten sonst ihren alten Quellnamen — „Hbf Süd" (MVG) neben
   * „Hauptbahnhof Süd" waren die zwei Bahnsteige DERSELBEN Tram-Haltestelle.
   * Seine eigenen Zusätze („Mast 2", „Richtung Eschborn") behält er — sie
   * unterscheiden ihn von den anderen Steigen.
   *
   * OSM-Masten behalten ihren Namen: Er ist meist der örtlich richtige
   * („Lakeside Bus Station", nicht „Chafford Hundred Bus Station").
   */
  for (const row of rows) {
    if (!row.code.startsWith("gtfs:")) continue;
    const station = row.parentCode ? decisions.get(row.parentCode) : undefined;
    const own = decisions.get(row.code)!;
    if (station && station.name !== own.name) decisions.set(row.code, { name: station.name, parts: own.parts, rule: "steig" });
  }
  const named = rows.map((r) => {
    const d = decisions.get(r.code)!;
    return { code: r.code, type: r.type, subtype: r.subtype, lat: r.lat, lon: r.lon, name: d.name, parts: d.parts };
  });
  const details = computeDetails(named);
  if (country === GB) await addGbDirectionDetails(pool, named, details);
  return { rows, decisions, details };
}

/** Kopfschilder, die kein Ziel nennen — dann zählt der letzte Halt (wie die Tafel). */
const GENERIC_DESTINATIONS = new Set(["terminus", "terminal", "bus station", "station", "city centre", "town centre", "centre"]);

/**
 * Großbritannien: Gleichnamige Halte ohne abtrennbaren Zusatz — fast immer die
 * beiden Fahrtrichtungen derselben Straße, oft keine 5 m auseinander
 * („Broad Reach" zweimal). Die Bereinigung lässt sie stehen, weil an beiden
 * eigene Fahrten halten (scripts/fix-stop-data.ts, `servedFeedStops`); in der
 * Suche standen sie als zwei gleichlautende Einträge. Zusatz aus dem Fahrplan:
 * wohin die meisten Fahrten von dort fahren („→ Truro"). Der Pfeil statt
 * „Richtung": Der Zusatz steht in der Datenbank und gilt für jede Sprache der
 * App. Haben beide Seiten dasselbe Ziel, sagt der Zusatz nichts — dann keiner.
 * Das Ziel kommt nur aus dem Kopfschild der Fahrt (Fahrten ohne zählen nicht):
 * Den Endhalt jeder Fahrt nachzuschlagen kostete bei zigtausend Halten Minuten.
 */
async function addGbDirectionDetails(
  pool: pg.Pool | pg.PoolClient,
  rows: Array<{ code: string; type: string; subtype: string | null; lat: number | null; lon: number | null; name: string; parts: string[] }>,
  details: Map<string, string>,
): Promise<void> {
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${dedupCategory(r.subtype, r.type)}|${normForCompare(r.name)}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  const near = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    111_320 * Math.hypot(b.lat! - a.lat!, (b.lon! - a.lon!) * Math.cos((a.lat! * Math.PI) / 180)) <= DETAIL_RADIUS_M;
  // Je Halt: seine gleichnamigen Nachbarn derselben Art im Umkreis.
  const neighboursOf = new Map<string, typeof rows>();
  for (const all of groups.values()) {
    if (all.length < 2) continue;
    for (const r of all) {
      if (details.has(r.code) || !r.code.startsWith("gtfs:gb:")) continue;
      const nb = all.filter((o) => o.code !== r.code && near(r, o));
      if (nb.length > 0) neighboursOf.set(r.code, nb);
    }
  }
  const clashing = rows.filter((r) => neighboursOf.has(r.code));
  console.log(`[stopNames] GB: ${clashing.length} gleichnamige Nachbarn ohne Zusatz — Ziel aus dem Fahrplan`);
  if (clashing.length === 0) return;
  const res = await pool.query<{ code: string; dest: string }>(
    `WITH c(code, sid) AS (SELECT * FROM unnest($1::text[], $2::text[])),
     d AS (
       SELECT c.code,
              CASE WHEN lower(trim(t.headsign)) = ANY($3::text[]) THEN NULL ELSE nullif(trim(t.headsign), '') END AS dest,
              count(*) AS n
         FROM c
         JOIN gtfs_stop_times st ON st.feed_id = 'gb-gtfs' AND st.stop_id = c.sid
         JOIN gtfs_trips t ON t.feed_id = st.feed_id AND t.trip_id = st.trip_id
        WHERE EXISTS (SELECT 1 FROM gtfs_stop_times nx
                       WHERE nx.feed_id = st.feed_id AND nx.trip_id = st.trip_id AND nx.stop_sequence > st.stop_sequence)
        GROUP BY 1, 2
     )
     SELECT DISTINCT ON (code) code, dest FROM d WHERE dest IS NOT NULL ORDER BY code, n DESC`,
    [clashing.map((r) => r.code), clashing.map((r) => r.code.slice("gtfs:gb:".length)), [...GENERIC_DESTINATIONS]],
  );
  const dest = new Map(res.rows.map((r) => [r.code, timetableStopName(GB, r.dest)]));
  // Nur, wo der Zusatz die Nachbarn wirklich unterscheidet.
  for (const r of clashing) {
    const d = dest.get(r.code);
    if (!d) continue;
    if (neighboursOf.get(r.code)!.some((o) => dest.get(o.code) === d)) continue;
    details.set(r.code, `→ ${d}`);
  }
}

/**
 * Wert für `display_name`: NULL, wenn der offizielle Name das Label selbst ist
 * — auch dann, wenn sich beide nur im Leerraum unterscheiden (ein doppeltes
 * oder geschütztes Leerzeichen ist kein anderer Name).
 */
export function displayNameValue(row: { label: string }, d: NameDecision): string | null {
  const ws = (v: string) => v.replace(/\s+/g, " ").trim();
  return d.name && ws(d.name) !== ws(row.label) ? d.name : null;
}

/**
 * Anzeigenamen eines Landes in die Tabelle schreiben — für die Importe, die
 * danach ohnehin den ganzen Bestand des Landes kennen. Schreibt nur
 * Abweichungen, in einer Transaktion. Gibt die Zahl der geänderten Zeilen zurück.
 */
export async function applyCountryNames(pool: pg.Pool, country: string): Promise<number> {
  const { rows, decisions, details } = await computeCountryNames(pool, country);
  const changes: Array<{ code: string; name: string | null; detail: string | null }> = [];
  for (const row of rows) {
    const d = decisions.get(row.code)!;
    const name = displayNameValue(row, d);
    const detail = details.get(row.code) ?? null;
    if (name !== row.displayName || detail !== row.displayDetail) changes.push({ code: row.code, name, detail });
  }
  if (changes.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < changes.length; i += 5000) {
      await client.query(
        `UPDATE locations l SET display_name = x.name, display_detail = x.detail
         FROM jsonb_to_recordset($1::jsonb) AS x(code text, name text, detail text)
         WHERE l.code = x.code`,
        [JSON.stringify(changes.slice(i, i + 5000))],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return changes.length;
}
