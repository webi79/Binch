/**
 * Mehrsprachige Städtenamen-Gruppen (Exonyme) für die Location-Suche.
 *
 * Problem: Die Datenquellen sind sprachlich inkonsistent — Airports sind
 * englisch geseedet („Vienna (VIE)", city „Vienna"), StaDa/GTFS lokal
 * („Wien Hbf"). Ein deutscher User, der „Wien" im Flug-Modus tippt (oder Bo,
 * der „Wien" ans search_journey-Tool übergibt), bekam schlicht 0 Treffer —
 * ILIKE kennt keine Sprachen.
 *
 * Jede Gruppe enthält äquivalente Namen (UI-Sprachen de/en/fr/es + lokaler
 * Name). Die Suche probiert bei 0 Treffern Varianten, in denen der erkannte
 * Name durch seine Geschwister ersetzt ist. Bewusst NUR als Fallback — die
 * Originalschreibweise gewinnt immer, wenn sie selbst eindeutig trifft. Bei
 * einem reinen Städtenamen („Genf") reichen dafür keine Zufallstreffer mitten
 * im Wort („Klagenfurt"), siehe `searchWithExonyms` in locationService.ts.
 */

const DIRECTIONS: string[][] = [
  ["süd", "south", "sud", "sur", "sued"],
  ["nord", "north", "norte"],
  ["ost", "east", "este", "est"],
  ["west", "ouest", "oeste", "ovest"],
];
const DIRECTION_GROUPS = new Set(DIRECTIONS);

const GROUPS: string[][] = [
  ["wien", "vienna", "vienne", "viena"],
  ["münchen", "munich", "múnich", "muenchen"],
  ["köln", "cologne", "colonia", "koeln"],
  ["nürnberg", "nuremberg", "núremberg", "nuernberg"],
  ["hannover", "hanover", "hanovre"],
  ["frankfurt", "francfort", "fráncfort"],
  ["hamburg", "hambourg", "hamburgo"],
  ["berlin", "berlín", "berlino"],
  ["aachen", "aix-la-chapelle", "aquisgrán"],
  ["prag", "prague", "praha", "praga"],
  ["warschau", "warsaw", "warszawa", "varsovie", "varsovia"],
  ["krakau", "krakow", "kraków", "cracovie", "cracovia"],
  ["breslau", "wroclaw", "wrocław"],
  ["danzig", "gdansk", "gdańsk"],
  ["stettin", "szczecin"],
  ["posen", "poznan", "poznań"],
  ["rom", "rome", "roma"],
  ["mailand", "milan", "milano", "milán"],
  ["venedig", "venice", "venezia", "venise", "venecia"],
  ["florenz", "florence", "firenze", "florencia"],
  ["neapel", "naples", "napoli", "nápoles"],
  ["turin", "torino", "turín"],
  ["genua", "genoa", "genova", "gênes", "génova"],
  ["bozen", "bolzano"],
  // Nachgetragen für den Vorlauf des Stadt-Blatts (routes/tripPlan.ts): Die
  // Karte beschriftet lokal („København", „Sevilla"), die kuratierten Städte
  // tragen deutsche Namen, Flughäfen englische. Weitere Schreibweisen sind in
  // die bestehenden Gruppen unten eingetragen — JEDE Stadt nur in EINER Gruppe
  // (doppelte Gruppen zählten gegen die Grenze von drei erkannten Namen).
  ["stockholm", "estocolmo", "stoccolma"],
  ["padua", "padova", "padoue"],
  ["bologna", "bologne", "bolonia"],
  ["pisa", "pise"],
  ["genf", "geneva", "genève", "ginebra", "ginevra"],
  ["zürich", "zurich", "zúrich", "zurigo", "zuerich"],
  ["basel", "bâle", "basilea"],
  ["bern", "berne", "berna"],
  ["brüssel", "brussels", "bruxelles", "brussel", "bruselas"],
  ["antwerpen", "antwerp", "anvers", "amberes"],
  ["gent", "ghent", "gand", "gante"],
  ["brügge", "bruges", "brugge", "brujas"],
  ["lüttich", "liege", "liège", "luik", "lieja"],
  ["ostende", "ostend", "oostende"],
  ["den haag", "the hague", "la haye", "la haya"],
  ["kopenhagen", "copenhagen", "københavn", "kobenhavn", "copenhague"],
  ["göteborg", "gothenburg", "gotemburgo", "goteborg"],
  ["lissabon", "lisbon", "lisboa", "lisbonne"],
  ["porto", "oporto"],
  ["sevilla", "seville", "séville"],
  ["saragossa", "zaragoza", "saragosse"],
  ["córdoba", "cordoba", "cordoue"],
  ["granada", "grenade"],
  ["málaga", "malaga"],
  ["teneriffa", "tenerife", "ténérife"],
  ["nizza", "nice", "niza"],
  ["marseille", "marseilles", "marsella", "marsiglia"],
  ["straßburg", "strasbourg", "estrasburgo", "strasburgo", "strassburg"],
  ["lyon", "lione"],
  ["london", "londres", "londra"],
  ["edinburgh", "édimbourg", "edimburgo"],
  ["dublin", "dublín"],
  ["athen", "athens", "athína", "athina", "athènes", "atenas"],
  ["saloniki", "thessaloniki", "thessalonique", "salónica"],
  ["moskau", "moscow", "moskva", "moscou", "moscú"],
  ["kiew", "kyiv", "kiev"],
  ["odessa", "odesa"],
  ["lemberg", "lviv"],
  ["bukarest", "bucharest", "bucarest", "bucurești", "bucuresti"],
  ["belgrad", "belgrade", "beograd", "belgrado"],
  ["zagreb", "zagabria", "agram"],
  ["ljubljana", "lubiana", "liubliana", "laibach"],
  ["bratislava", "pressburg"],
  ["istanbul", "estambul"],
  ["luxemburg", "luxembourg", "luxemburgo", "lussemburgo"],
  ["helsinki", "helsingfors"],
  ["vilnius", "wilna"],
  // Richtungs-Suffixe — Flughafen-Labels sind englisch („Tenerife South"),
  // User/Bo sagen „Teneriffa Süd". Greift nur im 0-Treffer-Fallback.
  ...DIRECTIONS,
];

/**
 * Ist die Eingabe GENAU ein bekannter Städtename („Wien", „den haag") — ohne
 * weitere Wörter? Richtungs-Suffixe („süd", „ost") zählen nicht als Stadt.
 */
export function isExonymCityName(query: string): boolean {
  const q = fold(query.trim().replace(/\s+/g, " "));
  return GROUPS.some((g) => !DIRECTION_GROUPS.has(g) && g.some((n) => fold(n) === q));
}

/**
 * Kleinbuchstaben ohne Akzente — „München" = „munchen", „Genève" = „geneve".
 * Erkannt wird ein Name in dieser Form: Wer auf der Tastatur keine Umlaute
 * hat, tippt „Munchen", und die Gruppe kannte nur „münchen".
 */
function fold(v: string): string {
  return v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/ß/g, "ss");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Liefert Query-Varianten mit ersetzten Exonymen (lowercase — ILIKE ist eh
 * case-insensitiv). „Wien" → ["vienna", "vienne", "viena"]; „Flughafen Wien"
 * → ["flughafen vienna", …]. Query ohne bekannten Städtenamen → [].
 */
export function exonymQueryVariants(query: string): string[] {
  const q = fold(query.trim());
  if (!q) return [];
  const variants = new Set<string>();
  // Erkannte Gruppen sammeln (Name + Regex), um neben Einzel-Ersetzungen auch
  // die KOMBI-Variante zu bauen: „teneriffa süd" braucht BEIDE Ersetzungen
  // gleichzeitig („tenerife south") — Einzel-Varianten („tenerife süd",
  // „teneriffa south") matchen das englische Label nicht.
  const matched: Array<{ re: RegExp; siblings: string[] }> = [];
  for (const group of GROUPS) {
    for (const name of group) {
      // Wort-Grenzen unicode-fest: \b versagt bei Umlauten/Akzenten.
      const re = new RegExp(`(^|[^\\p{L}])${escapeRegex(fold(name))}($|[^\\p{L}])`, "iu");
      if (!re.test(q)) continue;
      matched.push({ re, siblings: group.filter((g) => g !== name) });
      for (const alt of group) {
        if (alt === name) continue;
        const replaced = q.replace(re, `$1${alt}$2`);
        if (replaced !== q) variants.add(replaced);
      }
      break; // pro Gruppe reicht der erste erkannte Name
    }
    if (matched.length >= 3) break;
  }
  const combos: string[] = [];
  const addCombo = (alts: Array<string | undefined>) => {
    let c = q;
    matched.forEach((m, i) => {
      const alt = alts[i];
      if (alt) c = c.replace(m.re, `$1${alt}$2`);
    });
    if (c !== q && !combos.includes(c)) combos.push(c);
  };
  if (matched.length >= 2) {
    // Kombi: alle erkannten Gruppen zugleich durch ihr erstes Geschwister
    // ersetzen (Konvention: erstes Nicht-Original = englische/kanonische Form).
    addCombo(matched.map((m) => m.siblings[0]));
    /**
     * Bei ZWEI Gruppen zusätzlich die übrigen Schreibweisen der zweiten zur
     * ersten der ersten — und umgekehrt. Die Labels sind nicht einheitlich
     * englisch: Teneriffa Süd heißt bei OurAirports „Tenerife Sur", nicht
     * „Tenerife South"; mit nur der ersten Schreibweise fand „Teneriffa Süd"
     * gar nichts.
     */
    if (matched.length === 2) {
      const [a, b] = matched as [(typeof matched)[number], (typeof matched)[number]];
      for (const alt of b.siblings.slice(1)) addCombo([a.siblings[0], alt]);
      for (const alt of a.siblings.slice(1)) addCombo([alt, b.siblings[0]]);
    }
  }
  // Kombis ZUERST probieren — bei Mehrfach-Treffern („teneriffa süd") sind sie
  // der wahrscheinlichste Match, die Einzel-Varianten sind dann meist tot.
  for (const c of combos) variants.delete(c);
  return [...combos, ...variants].slice(0, 10);
}
