/**
 * Build-Script: parst die OurAirports-CSV und generiert
 * ../../lib/surroundings/airportCoords.ts mit allen large+medium kommerziellen
 * Flughäfen weltweit (~3000+ Einträge).
 *
 * Datenquelle: OurAirports (https://ourairports.com) — Public Domain.
 * CSV: https://davidmegginson.github.io/ourairports-data/airports.csv
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-airports.mjs`
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CSV_PATH = "/tmp/airports.csv";
// ZWEI Ausgaben aus EINER gefilterten Menge.
//
// Vorher speiste dieses Skript nur die Kartenpins; die Liste, nach der man im
// Suchfeld überhaupt suchen kann, war eine getrennte, handgepflegte Datei mit
// 391 Einträgen. Ergebnis: Auf der Karte lagen Flughäfen, die die Suche nicht
// kannte. Beides kommt jetzt aus derselben Zeile CSV, damit die zwei Bestände
// nicht wieder auseinanderlaufen können.
const OUT_PINS = resolve(__dirname, "../../lib/surroundings/airportCoords.ts");
const OUT_SEED = resolve(__dirname, "../src/data/airports.ts");

// Minimal CSV-Parser für die OurAirports-Datei. Felder werden in double-quotes
// eingeschlossen, kann Kommas in Feldern enthalten.
function parseCSV(text) {
  const lines = text.split("\n");
  const headers = parseRow(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseRow(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = fields[j] ?? "";
    rows.push(row);
  }
  return rows;
}

function parseRow(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * ISO 3166-1 Alpha-2 → englischer Ländername, vollständig.
 *
 * Hier stand eine handgepflegte Tabelle mit rund 90 Ländern und `?? iso` als
 * Ausweg. Der Ausweg war der Normalfall: Im ausgelieferten Kartenbestand
 * standen 142 Länder als roher Code — „PF" statt „French Polynesia". Node
 * bringt die Namen über die ICU-Daten selbst mit.
 */
const DISPLAY = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * OurAirports `municipality` auf einen brauchbaren Stadtnamen bringen.
 *
 * Das Feld ist nicht einheitlich. Es kommt vor als „London", als „London,
 * Essex", als „Ingliston, Edinburgh" und als „Paris (Roissy-en-France,
 * Val-d'Oise)". Roh übernommen kostete das doppelt: Die Suche sortiert unter
 * anderem nach exakter Übereinstimmung mit dem Stadtnamen, und „London, Essex"
 * trifft „london" eben nicht — London Stansted fiel dadurch hinter Flughäfen
 * zurück, deren Feld sauber „London" lautete, bis hin zum kanadischen London.
 *
 * Zuerst fliegt der Klammerzusatz raus, sonst zerschneidet der Komma-Schritt
 * ihn mittendrin („Paris (Roissy-en-France").
 *
 * Beim Komma wird NICHT blind der erste Teil genommen — die Reihenfolge ist
 * uneinheitlich: „London, Essex" ist Stadt-dann-Region, „Ingliston, Edinburgh"
 * ist Ortsteil-dann-Stadt. Entschieden wird deshalb am Namen des Flughafens
 * selbst: Taucht einer der Teile dort auf, ist das die gemeinte Stadt
 * („Edinburgh Airport" → Edinburgh, „London Stansted Airport" → London). Sonst
 * bleibt es beim ersten Teil.
 */
function cityName(municipality, airportName) {
  const cleaned = municipality.replace(/\s*\([^)]*\)/g, "").trim();
  if (!cleaned) return airportName;
  if (!cleaned.includes(",")) return cleaned;
  const parts = cleaned
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const lowerName = airportName.toLowerCase();
  const named = parts.find((x) => lowerName.includes(x.toLowerCase()));
  return named ?? parts[0];
}

/**
 * Das angehängte „Airport" aus dem Namen nehmen.
 *
 * OurAirports führt die amtlichen Langnamen. Die alte, handgepflegte Liste war
 * gekürzt („Frankfurt am Main", „Rome Fiumicino"), und genau diese Labels
 * stehen in der Auswahlliste, in der Verlaufskarte und in den Ergebnissen.
 * Ungekürzt stünde dort „Rome–Fiumicino Leonardo da Vinci International
 * Airport (FCO)" — in einer einzeiligen Karte also drei abgeschnittene Wörter.
 *
 * Das Wort trägt neben dem IATA-Code in Klammern ohnehin nichts bei: In dieser
 * Liste ist alles ein Flughafen. Nur am ENDE wird geschnitten, damit ein
 * „Airport City"-Bahnhofsname o.ä. unberührt bleibt, und nur, wenn danach noch
 * etwas Sinnvolles übrig ist.
 */
function shortName(name) {
  const cut = name.replace(/\s+(International\s+)?Airport$/i, "").trim();
  return cut.length >= 3 ? cut : name;
}

function countryName(iso) {
  if (!iso) return "";
  try {
    return DISPLAY.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

const csv = readFileSync(CSV_PATH, "utf-8");
const rows = parseCSV(csv);

const airports = rows
  .filter(
    (r) =>
      // `scheduled_service === "yes"` IST die Definition von „hier findet
      // ziviler Linienverkehr statt" — genau das soll suchbar sein. Die
      // zusätzliche Einschränkung auf large+medium stand dem im Weg: Sie warf
      // 895 Flughäfen weg, die planmäßig angeflogen werden, darunter fast den
      // gesamten Regionalverkehr in Alaska, Kanada, Grönland, Norwegen und auf
      // den Inselgruppen — Wasserflugzeug-Basen und Hubschrauber-Landeplätze
      // sind dort reguläre Linienziele und stehen bei den großen Reiseportalen
      // ebenfalls in der Liste.
      r.scheduled_service === "yes" &&
      r.iata_code.length === 3 &&
      // Hubschrauber-Landeplätze und Wasserflugzeug-Basen bleiben draußen.
      //
      // Nicht aus Prinzip, sondern weil kein Fluganbieter sie kennt: Eine Suche
      // darauf läuft garantiert ins Leere. Dafür standen sie ganz vorn — auf
      // „New York" lag „New York Skyports Inc Seaplane Base (NYS)" vor JFK und
      // LaGuardia, weil sein NAME beide Suchwörter enthält und deren Namen
      // nicht. Das sind 125 Einträge, die nur echte Flughäfen verdrängen.
      r.type !== "heliport" &&
      r.type !== "seaplane_base",
  )
  .map((r) => ({
    iata: r.iata_code,
    name: shortName(r.name),
    city: cityName(r.municipality || r.name, r.name),
    country: countryName(r.iso_country),
    // Größenklasse, und die ist kein Beiwerk: Die Suche sortierte unter
    // Flughäfen zuletzt nach „kürzeres Label gewinnt". Bei 391 kuratierten
    // Einträgen fiel das nicht auf, bei 4163 schon — „London City Airport"
    // stand damit vor „London Heathrow Airport", weil sein Name kürzer ist.
    // `locationService` rankt daher LARGE vor MEDIUM vor SMALL.
    size:
      r.type === "large_airport"
        ? "LARGE"
        : r.type === "medium_airport"
          ? "MEDIUM"
          : r.type === "small_airport"
            ? "SMALL"
            : "OTHER",
    latitude: parseFloat(r.latitude_deg),
    longitude: parseFloat(r.longitude_deg),
  }))
  .filter(
    (a) =>
      Number.isFinite(a.latitude) &&
      Number.isFinite(a.longitude) &&
      a.latitude >= -90 &&
      a.latitude <= 90 &&
      a.longitude >= -180 &&
      a.longitude <= 180,
  )
  .sort((a, b) => a.iata.localeCompare(b.iata));

console.log(`Parsed ${airports.length} airports.`);

// Output TS file
const tsHeader = `/**
 * Auto-generated by server/scripts/build-airports.mjs
 * Quelle: OurAirports (https://ourairports.com) — Public Domain
 *
 * Enthält ${airports.length} große + mittlere kommerzielle Flughäfen weltweit
 * mit IATA-Code, Lat/Lng und Land. Re-Run via:
 *   cd server && node scripts/build-airports.mjs
 */
import type { Coord } from "./mockData";

export interface AirportPin {
  iata: string;
  name: string;
  city: string;
  country: string;
  coord: Coord;
}

export const AIRPORT_PINS: AirportPin[] = [
`;

const tsBody = airports
  .map(
    (a) =>
      `  { iata: ${JSON.stringify(a.iata)}, name: ${JSON.stringify(a.name)}, city: ${JSON.stringify(a.city)}, country: ${JSON.stringify(a.country)}, coord: { latitude: ${a.latitude.toFixed(4)}, longitude: ${a.longitude.toFixed(4)} } },`,
  )
  .join("\n");

const tsFooter = "\n];\n";

writeFileSync(OUT_PINS, tsHeader + tsBody + tsFooter, "utf-8");
console.log(`✓ Wrote ${OUT_PINS}`);
console.log(`  File size: ${(Buffer.byteLength(tsHeader + tsBody + tsFooter) / 1024).toFixed(1)} KB`);

// === Zweite Ausgabe: die Saatliste für die Suche ===
//
// Ohne Koordinaten, weil `db:seed` nur code/label/city/country schreibt. Sonst
// dieselben Zeilen, aus derselben gefilterten Menge — das ist der ganze Punkt.
const seedHeader = `/**
 * AUTOMATISCH ERZEUGT von server/scripts/build-airports.mjs — nicht von Hand ändern.
 * Quelle: OurAirports (https://ourairports.com) — Public Domain
 *
 * Alle ${airports.length} Flughäfen weltweit mit IATA-Code und planmäßigem
 * Linienverkehr (\`scheduled_service = yes\`). Wird von \`npm run db:seed\` in die
 * \`locations\`-Tabelle geschrieben (type=FLIGHT).
 *
 * Hier stand früher eine handgepflegte Liste mit 391 Einträgen — die Karte
 * kannte dadurch Flughäfen, nach denen sich nicht suchen ließ. Beide Bestände
 * kommen jetzt aus demselben Lauf. Neu erzeugen:
 *   cd server && node scripts/build-airports.mjs
 */
export interface AirportSeed {
  iata: string;
  name: string;
  city: string;
  country: string;
  /** Größenklasse aus OurAirports — steuert die Trefferreihenfolge der Suche. */
  size: "LARGE" | "MEDIUM" | "SMALL" | "OTHER";
  latitude: number;
  longitude: number;
}

export const AIRPORTS: AirportSeed[] = [
`;

const seedBody = airports
  .map(
    (a) =>
      `  { iata: ${JSON.stringify(a.iata)}, name: ${JSON.stringify(a.name)}, city: ${JSON.stringify(a.city)}, country: ${JSON.stringify(a.country)}, size: ${JSON.stringify(a.size)}, latitude: ${a.latitude.toFixed(4)}, longitude: ${a.longitude.toFixed(4)} },`,
  )
  .join("\n");

writeFileSync(OUT_SEED, seedHeader + seedBody + tsFooter, "utf-8");
console.log(`✓ Wrote ${OUT_SEED}`);
console.log(`  File size: ${(Buffer.byteLength(seedHeader + seedBody + tsFooter) / 1024).toFixed(1)} KB`);
