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
 * Originalschreibweise gewinnt immer, wenn sie selbst Treffer hat.
 */

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
  ["kopenhagen", "copenhagen", "københavn", "copenhague"],
  ["göteborg", "gothenburg", "gotemburgo", "goteborg"],
  ["lissabon", "lisbon", "lisboa", "lisbonne"],
  ["porto", "oporto"],
  ["sevilla", "seville", "séville"],
  ["saragossa", "zaragoza", "saragosse"],
  ["córdoba", "cordoba", "cordoue"],
  ["granada", "grenade"],
  ["málaga", "malaga"],
  ["teneriffa", "tenerife", "ténérife"],
  ["nizza", "nice", "niza", "nizza"],
  ["marseille", "marsella", "marsiglia"],
  ["straßburg", "strasbourg", "estrasburgo", "strasburgo", "strassburg"],
  ["lyon", "lione"],
  ["london", "londres", "londra"],
  ["edinburgh", "édimbourg", "edimburgo"],
  ["dublin", "dublín"],
  ["athen", "athens", "athína", "athènes", "atenas"],
  ["saloniki", "thessaloniki", "thessalonique", "salónica"],
  ["moskau", "moscow", "moscou", "moscú"],
  ["kiew", "kyiv", "kiev"],
  ["odessa", "odesa"],
  ["lemberg", "lviv"],
  ["bukarest", "bucharest", "bucarest", "bucurești", "bucuresti"],
  ["belgrad", "belgrade", "beograd", "belgrado"],
  ["zagreb", "zagabria"],
  ["ljubljana", "lubiana", "laibach"],
  ["bratislava", "pressburg"],
  ["istanbul", "estambul"],
  ["luxemburg", "luxembourg", "luxemburgo", "lussemburgo"],
  ["helsinki", "helsingfors"],
  ["vilnius", "wilna"],
  // Richtungs-Suffixe — Flughafen-Labels sind englisch („Tenerife South"),
  // User/Bo sagen „Teneriffa Süd". Greift nur im 0-Treffer-Fallback.
  ["süd", "south", "sud", "sur", "sued"],
  ["nord", "north", "norte"],
  ["ost", "east", "este", "est"],
  ["west", "ouest", "oeste", "ovest"],
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Liefert Query-Varianten mit ersetzten Exonymen (lowercase — ILIKE ist eh
 * case-insensitiv). „Wien" → ["vienna", "vienne", "viena"]; „Flughafen Wien"
 * → ["flughafen vienna", …]. Query ohne bekannten Städtenamen → [].
 */
export function exonymQueryVariants(query: string): string[] {
  const q = query.toLowerCase().trim();
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
      const re = new RegExp(`(^|[^\\p{L}])${escapeRegex(name)}($|[^\\p{L}])`, "iu");
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
  let combo: string | null = null;
  if (matched.length >= 2) {
    // Kombi: alle erkannten Gruppen zugleich durch ihr erstes Geschwister
    // ersetzen (Konvention: erstes Nicht-Original = englische/kanonische Form).
    let c = q;
    for (const m of matched) {
      const alt = m.siblings[0];
      if (alt) c = c.replace(m.re, `$1${alt}$2`);
    }
    if (c !== q) combo = c;
  }
  // Kombi ZUERST probieren — bei Mehrfach-Treffern („teneriffa süd") ist sie
  // der wahrscheinlichste Match, die Einzel-Varianten sind dann meist tot.
  variants.delete(combo ?? "");
  return [...(combo ? [combo] : []), ...variants].slice(0, 10);
}
