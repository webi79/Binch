/**
 * STEIGE einer Station als eigene Halte (Oktober 2026).
 *
 * Bis dahin las der Monatsabgleich je Station nur EINE Zeile: „Dortmund Hörde
 * Bf" mit fünf Bus-Steigen und zwei U-Bahn-Gleisen war ein einziger Bus-Marker
 * mit einer gemeinsamen Tafel, die U-Bahn fiel unter die 30-%-Schwelle der
 * Verkehrsarten ganz weg. Die Vollprüfung (~/binch-backups/stops-audit-
 * 2026-10-22) fand das in ganz Deutschland: 160 000 Bus-Steige ohne eigenen
 * Marker, 318 Stationen ohne „U"/Tram.
 *
 * Jetzt bekommt jeder Steig einer Station mit mindestens zwei Steigen eine
 * eigene Zeile: `parent_code` = Code der Station, `platform` = Steig aus dem
 * Fahrplan, Verkehrsarten aus den Fahrten genau dieses Steigs. Die Karte zeigt
 * die Station über ihre Steige (routes/surroundings.ts), die Suche weiter nur
 * die Station (services/locationService.ts), die Tafel eines Bus-Steigs nur
 * seine Abfahrten (routes/stops.ts).
 *
 * Zuordnung im Abgleich — nie über die Fahrplan-Nummer allein, gtfs.de
 * nummeriert jede Veröffentlichung neu:
 *   1. ein Steig, den die Station schon hat (≤ `STAND_MATCH_M`, gleiche Art);
 *   2. eine vorhandene Zeile genau dort (OSM-Mast, alte Zeile, Halt eines
 *      Verbund-Feeds; gleicher Name, gleiche Art, ≤ `LINK_M`) — sie wird zum
 *      Steig, statt daneben eine Doppelung anzulegen. Nie ein Bahnhof mit
 *      Bahn-Nummer (StaDa: die Suche braucht ihn mit seiner EVA-Nummer), nie
 *      eine von Hand angelegte Zeile (Quelle leer) und nie eine Station;
 *   3. sonst eine neue Zeile.
 * Gelöscht wird nichts: Ein Steig, den der Feed nicht mehr kennt, bleibt
 * stehen und wird nur gezählt.
 */
import { GENERIC_STOP_NAMES, haversineMeters } from "./locationDedup.js";
import { dominantSubtype, kindsForStop, subtypeToKind, subtypeToType, type Kind, type Subtype } from "./gtfsModes.js";
import { cleanPlatform } from "../../src/util/platform.js";

/**
 * Steige DERSELBEN Station so nah beieinander sind EIN Steig: DELFI führt
 * manche Bucht doppelt (Hörde Bf 1:01/1:11, 2–3 m). Derselbe Wert wie der
 * Umkreis der Steig-Tafel (STAND_RADIUS_M in services/motisStops.ts) — die
 * Tafel zeigt beide ohnehin zusammen.
 */
export const STAND_MERGE_M = 5;
/** So weit darf ein vorhandener Steig der Station von seiner neuen Lage abweichen. */
const STAND_MATCH_M = 5;
/**
 * So nah muss eine vorhandene Zeile (OSM-Mast, alte Zeile, Verbund-Halt) am
 * Steig stehen, um ihn zu stellen — mit passendem Namen (`sameMastName`:
 * „Landshut, Sparkassenarena" = „…Sparkassen-Arena", „Köln IKEA Godorf" =
 * „Köln Godorf Ikea Godorf"; „Gengenbach Löwenplatz" ≠ „Gengenbach
 * Bahnhofstraße"). Die Simulation der Karte (Okt. 2026) fand bis 15 m rund
 * 4 400 solcher Doppelungen neben neuen Steigen.
 */
const LINK_M = 15;
/** Bis hierhin derselbe Mast, wie auch immer ihn die Quelle nennt. */
const LINK_ANY_NAME_M = 6;

/** Wörter eines Haltnamens, ohne Akzente; „…str." = „…straße". */
function nameWords(v: string): string[] {
  return v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => w.replace(/str$/, "strasse"));
}

/**
 * Derselbe Mast unter zwei Namen? Gleich bis auf Leerzeichen („Sparkassenarena"
 * = „Sparkassen-Arena"), dieselben Wörter in anderer Reihenfolge
 * („Zionsfriedhof (Berlin)" = „Berlin, Zionsfriedhof") oder alle Wörter des
 * einen im anderen — mindestens zwei („Köln Schaffrathsgasse" ⊂ „Köln
 * Bocklemünd Schaffrathsgasse") oder ein Wort, das mehr ist als ein
 * Allerweltsname („Reginbaldstraße" ⊂ „Munich Reginbaldstraße", nicht
 * „Kirche"). Strenger als der Abgleich der Tafel
 * (`sameStopByName`): Dort reicht ein gemeinsames Wort wie „Westerw", und
 * „Asbach (Westerw) Anton-Limbach-Straße" wäre „Asbach (Westerw) Vorteil Center".
 */
function sameMastName(a: string, b: string): boolean {
  const wa = nameWords(a);
  const wb = nameWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  if (wa.join("") === wb.join("")) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  if (![...small].every((w) => big.has(w))) return false;
  if (small.size === big.size || small.size >= 2) return true;
  const [only] = [...small];
  return only!.length >= 5 && !GENERIC_STOP_NAMES.has(only!);
}

/**
 * Teilen zwei Namen ein MARKANTES Wort (ab vier Buchstaben, kein
 * Allerweltsname)? Für Masten auf wenigen Metern, die jede Quelle anders
 * schreibt: „Mníšek p.Brdy,ÚVR" / „Mníšek pod Brdy, ÚVR", „Jabłonna Pałac" /
 * „Pałac", „Al. Jana Pawła II" / „Aleja Jana Pawła II". Für sich kein Beweis —
 * nur zusammen mit der Lage verwenden.
 */
export function sharesDistinctWord(a: string, b: string): boolean {
  const distinct = (v: string) => new Set(nameWords(v).filter((w) => w.length >= 4 && !GENERIC_STOP_NAMES.has(w)));
  const wa = distinct(a);
  for (const w of distinct(b)) if (wa.has(w)) return true;
  return false;
}

/** Ein Kind einer Elternstation aus stops.txt (location_type 0 mit parent_station). */
export interface FeedChild {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** `platform_code` aus stops.txt, roh („03", „-", „A"). */
  platformCode: string;
}

/** Ein physischer Steig: ein oder mehrere Kinder am selben Punkt. */
export interface FeedStand {
  ids: string[];
  lat: number;
  lng: number;
  platform: string | null;
  counts: Map<Subtype, number>;
}

/** Bahn / Stadtbahn (U-Bahn + Tram) / Bus / Fähre — wie die Karte (routes/surroundings.ts, `familyOf`). */
export type StandFamily = "rail" | "metro" | "bus" | "ferry";

export function familyOfSubtype(subtype: string | null, type: string): StandFamily {
  switch (subtype) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "rail";
    case "SUBWAY":
    case "TRAM":
      return "metro";
    case "FERRY":
      return "ferry";
    case "BUS":
    case "COACH":
      return "bus";
    default:
      return type === "TRAIN" ? "rail" : "bus";
  }
}

/**
 * Die physischen Steige einer Station: nur Kinder MIT Fahrten, bis
 * `STAND_MERGE_M` zusammengefasst (Fahrten addiert, Steig-Bezeichnung des
 * ersten mit einer). Nur die Lage zählt — die Kinder heißen im Feed oft
 * verkürzt anders als ihre Station („AMEOS Klinikum2", „ABG, Geraer Str/Gym 01").
 */
/**
 * Steig-Bezeichnung für die Spalte `platform` (16 Zeichen). Österreichs Verbund-Feeds führen im
 * Feld auch Beschreibungen — „Mast1 (Millstätter Straße)", „Erdberger Lände 26A",
 * „L200 Ri. Alberschwende" —, die `cleanPlatform` wegen ihrer Ziffer durchlässt; die erste lange
 * brach den Import ab, die kurzen stünden als „Steig Mast1" in der App. Ein ausgeschriebenes Wort
 * (4 Buchstaben am Stück) ist keine Steig-Bezeichnung: „A", „K1", „11a", „2 (U5)" bleiben.
 */
function standPlatform(raw: string | null | undefined): string | null {
  const p = cleanPlatform(raw);
  if (!p || p.length > 16 || /\p{L}{4,}/u.test(p)) return null;
  return p;
}

export function physicalStands(children: FeedChild[], counts: Map<string, Map<Subtype, number>>): FeedStand[] {
  const out: FeedStand[] = [];
  for (const c of children) {
    const own = counts.get(c.id);
    if (!own || own.size === 0) continue;
    const platform = standPlatform(c.platformCode);
    const same = out.find((s) => haversineMeters(s.lat, s.lng, c.lat, c.lng) <= STAND_MERGE_M);
    if (same) {
      same.ids.push(c.id);
      for (const [sub, n] of own) same.counts.set(sub, (same.counts.get(sub) ?? 0) + n);
      if (!same.platform && platform) same.platform = platform;
      continue;
    }
    out.push({ ids: [c.id], lat: c.lat, lng: c.lng, platform, counts: new Map(own) });
  }
  return out;
}

/**
 * Verkehrsarten einer Station = die ihrer Steige, jeder für sich bewertet.
 * Über die Station gezählt fiel eine seltenere Art unter die Schwelle von
 * `kindsForStop` (Hörde Bf: U-Bahn neben vielen Bussen → nur „bus").
 * Reihenfolge: nach Fahrten an der ganzen Station, häufigste zuerst.
 */
export function stationKinds(stands: FeedStand[], stationCounts: Map<Subtype, number>): Kind[] {
  const union = new Set<Kind>();
  for (const s of stands) for (const k of kindsForStop(s.counts)) union.add(k);
  if (union.size === 0) return kindsForStop(stationCounts);
  const weight = new Map<Kind, number>();
  for (const [sub, n] of stationCounts) {
    const k = subtypeToKind(sub);
    weight.set(k, (weight.get(k) ?? 0) + n);
  }
  return [...union].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0));
}

/** Eine Zeile der Tabelle, wie der Abgleich sie zum Zuordnen braucht. */
export interface KnownStop {
  code: string;
  label: string;
  type: string;
  subtype: string | null;
  lat: number;
  lng: number;
  source: string | null;
  parentCode: string | null;
  hafasId: string | null;
  /** Anzeigename (`display_name`) — OSM-Masten tragen im Label oft Zusätze („Pośrednia 01"). */
  displayName?: string | null;
}

/** Die Station, zu der Steige angelegt werden (schon zugeordnet oder neu). */
export interface StandStation {
  code: string;
  label: string;
  country: string;
  city: string | null;
  stands: FeedStand[];
}

export interface PlannedStand {
  code: string;
  /** new = neue Zeile; update = Steig der Station; link = vorhandene Zeile wird Steig. */
  action: "new" | "update" | "link";
  label: string;
  country: string;
  city: string | null;
  type: "TRAIN" | "BUS";
  subtype: Subtype;
  kinds: Kind[];
  latitude: string;
  longitude: string;
  platform: string | null;
  parentCode: string;
  feedIds: string[];
}

/** Räumliches Verzeichnis (0,01°-Zellen) für die Suche nach Zeilen am Steig. */
class StopGrid {
  private cells = new Map<string, KnownStop[]>();
  private key(lat: number, lng: number) {
    return `${Math.floor(lat * 100)},${Math.floor(lng * 100)}`;
  }
  add(s: KnownStop) {
    const k = this.key(s.lat, s.lng);
    const list = this.cells.get(k);
    if (list) list.push(s);
    else this.cells.set(k, [s]);
  }
  near(lat: number, lng: number): KnownStop[] {
    const cy = Math.floor(lat * 100);
    const cx = Math.floor(lng * 100);
    const out: KnownStop[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) out.push(...(this.cells.get(`${cy + dy},${cx + dx}`) ?? []));
    }
    return out;
  }
}

/**
 * Plant die Steig-Zeilen aller Stationen eines Feeds.
 *
 * Übernommen werden nur OSM-Masten und Zeilen von Fahrplänen DESSELBEN Landes
 * (`linkPrefix`, „gtfs:de:" samt Verbünden): Eine Zeile des britischen
 * Fernbus-Feeds in Duisburg hat ihre eigene Tafel aus dem britischen Fahrplan.
 *
 * @param stations   Stationen mit ≥ 2 physischen Steigen samt ihrem Code in der Tabelle.
 * @param known      Zeilen der Tabelle in der Gegend (Länder des Feeds).
 * @param newCode    Code für einen neuen Steig (Feed-Kennung des Kinds → freier Code).
 * @param stationCodes Codes ALLER Stationen dieses Laufs — die werden nie Steig.
 */
export function planStands(args: {
  stations: StandStation[];
  known: KnownStop[];
  stationCodes: Set<string>;
  linkPrefix: string;
  newCode: (childId: string) => string;
}): { stands: PlannedStand[]; stale: number; covered: number } {
  const { stations, known, stationCodes, linkPrefix, newCode } = args;
  const standsOf = new Map<string, KnownStop[]>();
  /**
   * Alle Steige, die es schon gibt — auch die ANDERER Stationen und Feeds. An
   * ihrer Stelle entsteht kein zweiter: gtfs.de und die Verbund-Feeds (VBB,
   * MVG, VRS) beschreiben in Berlin, München und Köln dieselben Masten; wer
   * zuerst kommt, stellt den Steig.
   */
  const anyStand = new StopGrid();
  for (const k of known) {
    if (!k.parentCode) continue;
    const list = standsOf.get(k.parentCode);
    if (list) list.push(k);
    else standsOf.set(k.parentCode, [k]);
    anyStand.add(k);
  }
  const linkable = new StopGrid();
  for (const k of known) {
    if (k.parentCode || k.hafasId || !k.source || k.source === "stada") continue;
    if (k.source !== "osm" && !k.code.startsWith(linkPrefix)) continue;
    if (stationCodes.has(k.code) || standsOf.has(k.code)) continue;
    linkable.add(k);
  }

  const out: PlannedStand[] = [];
  let stale = 0;
  /** Steige ohne vorhandenen Steig der Station — für sie wird eine Zeile übernommen oder neu angelegt. */
  const open: Array<{ st: StandStation; s: FeedStand; base: Omit<PlannedStand, "code" | "action">; family: StandFamily }> = [];
  for (const st of stations) {
    const existing = standsOf.get(st.code) ?? [];
    const used = new Set<string>();
    for (const s of st.stands) {
      const subtype = dominantSubtype(s.counts);
      const type = subtypeToType(subtype);
      const family = familyOfSubtype(subtype, type);
      const base = {
        label: st.label,
        country: st.country,
        city: st.city,
        type,
        subtype,
        kinds: kindsForStop(s.counts),
        latitude: s.lat.toFixed(6),
        longitude: s.lng.toFixed(6),
        platform: s.platform,
        parentCode: st.code,
        feedIds: s.ids,
      };
      // 1. Ein Steig, den die Station schon hat.
      let hit: KnownStop | null = null;
      let best = Infinity;
      for (const k of existing) {
        if (used.has(k.code) || familyOfSubtype(k.subtype, k.type) !== family) continue;
        const d = haversineMeters(s.lat, s.lng, k.lat, k.lng);
        if (d <= STAND_MATCH_M && d < best) {
          hit = k;
          best = d;
        }
      }
      if (hit) {
        used.add(hit.code);
        out.push({ ...base, code: hit.code, action: "update" });
        continue;
      }
      open.push({ st, s, base, family });
    }
    stale += existing.filter((k) => !used.has(k.code)).length;
  }

  /**
   * 2. Vorhandene Zeilen genau dort — jede an den NÄCHSTEN Steig (alle Paare
   *    nach Abstand), nicht an den, der zuerst geprüft wird: Ein Verbund-Halt
   *    zwischen zwei Straßenseiten gehört zu der, an der er steht.
   */
  const pairs: Array<{ i: number; k: KnownStop; d: number }> = [];
  open.forEach(({ st, s, family }, i) => {
    for (const k of linkable.near(s.lat, s.lng)) {
      if (familyOfSubtype(k.subtype, k.type) !== family) continue;
      const d = haversineMeters(s.lat, s.lng, k.lat, k.lng);
      if (d > LINK_M) continue;
      if (d > LINK_ANY_NAME_M) {
        // Jede Quelle schreibt anders („Paris Nation" / „Nation - Trône"): passender Name
        // oder ein gemeinsames markantes Wort.
        const names = k.displayName ? [k.label, k.displayName] : [k.label];
        if (!names.some((n) => sameMastName(n, st.label) || sharesDistinctWord(n, st.label))) continue;
      }
      pairs.push({ i, k, d });
    }
  });
  pairs.sort((a, b) => a.d - b.d);
  const linked = new Map<number, string>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (linked.has(p.i) || taken.has(p.k.code)) continue;
    linked.set(p.i, p.k.code);
    taken.add(p.k.code);
    /**
     * Die übernommene Zeile ist ab jetzt ein Steig — auch für die Sperre
     * unten. Sonst bekam ein zweiter Haltebereich an derselben Stelle (NL:
     * „Nieuwe Gouw" und „Nieuwe Gouw Zuid", je eigene Kennungen) neue Steige
     * genau auf die eben übernommenen OSM-Masten.
     */
    const { st, s } = open[p.i]!;
    anyStand.add({ ...p.k, lat: s.lat, lng: s.lng, parentCode: st.code });
  }
  let covered = 0;
  open.forEach(({ st, s, base, family }, i) => {
    const code = linked.get(i);
    if (code) {
      out.push({ ...base, code, action: "link" });
      return;
    }
    // 3. Neu — außer an dieser Stelle steht schon ein Steig derselben Art (anderer Feed, Doppel im Feed).
    const there = anyStand
      .near(s.lat, s.lng)
      .some(
        (k) =>
          k.parentCode !== st.code &&
          familyOfSubtype(k.subtype, k.type) === family &&
          haversineMeters(s.lat, s.lng, k.lat, k.lng) <= STAND_MERGE_M,
      );
    if (there) {
      covered++;
      return;
    }
    const planned: PlannedStand = { ...base, code: newCode(s.ids[0]!), action: "new" };
    out.push(planned);
    anyStand.add({
      code: planned.code,
      label: planned.label,
      type: planned.type,
      subtype: planned.subtype,
      lat: s.lat,
      lng: s.lng,
      source: "gtfs",
      parentCode: st.code,
      hafasId: null,
    });
  });
  return { stands: out, stale, covered };
}
