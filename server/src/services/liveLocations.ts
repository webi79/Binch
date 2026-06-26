/**
 * Live-Quellen für Locations-Autocomplete. Werden vom locationService
 * aufgerufen, um lokale DB-Treffer mit Tausenden externer Stationen
 * zu ergänzen — ohne dass wir riesige Listen lokal pflegen müssen.
 *
 *   - flixbusLiveLocations  → BUS (FlixBus Autocomplete via RapidAPI)
 *   - dbRestLiveLocations   → TRAIN (db-rest, public, no auth)
 */
import { config } from "../config.js";
import { flixbusAutocomplete, type AutocompleteItem } from "../providers/bus/flixbus.js";
import type { LocationType } from "../db/schema.js";

export interface LiveLocation {
  code: string;
  label: string;
  city: string | null;
  country: string | null;
  type: LocationType;
  /** Wenn die Live-Quelle Koordinaten mitliefert (db-rest immer, FlixBus
   *  selten) → an den Client durchreichen für Map-Fly-To im Surroundings-Tab. */
  latitude?: number;
  longitude?: number;
  /** HAFAS-Station-ID (UIC 7-stellig). Nur gesetzt bei echten UIC-Bahnhöfen,
   *  damit der Dedup im locationService Local-vs-Live-Duplikate erkennt. */
  hafasId?: string;
}

interface DbRestStation {
  id?: string | null;
  name?: string;
  type?: string;
  location?: { latitude?: number; longitude?: number };
  /** Manche db-rest-Versionen geben Koordinaten auch top-level zurück. */
  latitude?: number;
  longitude?: number;
  /** HAFAS Coordinates-Sub-Objekt (alternative Schreibweise). */
  coordinates?: { latitude?: number; longitude?: number };
}

/** Heuristik: aus dem Stations-Namen das Land ableiten (HAFAS-/db-rest-Treffer haben kein country-Feld). */
function inferCountryFromStationName(name: string): string | null {
  const n = name.toLowerCase();
  // NL
  if (/(amsterdam|rotterdam|utrecht|den haag|hague|eindhoven|groningen|nijmegen|tilburg|leiden|delft|haarlem|breda|arnhem|maastricht)/.test(n)) return "Netherlands";
  // BE
  if (/(bruxelles|brussels|brüssel|antwerpen|anvers|gent|liège|luik|charleroi|namur|leuven|brugge|oostende|mons)/.test(n)) return "Belgium";
  if (/luxembourg|luxemburg/.test(n)) return "Luxembourg";
  // FR
  if (/^paris|gare du nord|gare de lyon|gare de l'est|montparnasse|austerlitz|saint-lazare|lyon part|marseille|nice|toulouse|bordeaux|strasbourg|straßburg|lille|nantes|rennes|reims|metz|nancy|grenoble|annecy|tours|dijon|orléans|avignon|montpellier|cannes|biarritz/.test(n)) return "France";
  // CH
  if (/(zürich|zurich|basel|bern|berne|genève|geneva|genf|lausanne|luzern|lucerne|winterthur|lugano|chur|sankt gallen|st\.? gallen)/.test(n)) return "Switzerland";
  // AT
  if (/(wien|vienna|salzburg|innsbruck|graz|linz|klagenfurt|villach|bregenz|dornbirn|sankt pölten|st\.? pölten)/.test(n)) return "Austria";
  // CZ / PL / HU / SK
  if (/(praha|prag|brno|brünn|ostrava|plzeň|pilsen|liberec|olomouc|české budějovice)/.test(n)) return "Czech Republic";
  if (/(warszawa|warsaw|warschau|kraków|krakau|wrocław|breslau|poznań|posen|gdańsk|danzig|łódź|szczecin|stettin|katowice|kattowitz)/.test(n)) return "Poland";
  if (/(budapest|debrecen|szeged|miskolc|pécs|győr)/.test(n)) return "Hungary";
  if (/(bratislava|košice|kaschau|žilina)/.test(n)) return "Slovakia";
  // IT
  if (/(roma|rom|milano|mailand|napoli|neapel|torino|turin|firenze|florenz|venezia|venedig|bologna|verona|genova|genua|trieste|triest|bolzano|bozen|trento|trient)/.test(n)) return "Italy";
  // ES / PT
  if (/(madrid|barcelona|valencia|sevilla|seville|bilbao|málaga|zaragoza|granada|alicante|valladolid|santiago|san sebastián|córdoba)/.test(n)) return "Spain";
  if (/(lisboa|lissabon|porto|coimbra|braga|faro|aveiro|évora)/.test(n)) return "Portugal";
  // DK / SE / NO / FI
  if (/(københavn|kopenhagen|copenhagen|aarhus|odense|aalborg|esbjerg|roskilde)/.test(n)) return "Denmark";
  if (/(stockholm|göteborg|gothenburg|malmö|uppsala|helsingborg|jönköping)/.test(n)) return "Sweden";
  if (/(oslo|bergen|trondheim|stavanger|tromsø|kristiansand)/.test(n)) return "Norway";
  if (/(helsinki|helsingfors|espoo|tampere|turku|oulu)/.test(n)) return "Finland";
  return null;
}

export async function flixbusLiveLocations(
  query: string,
  signal?: AbortSignal,
): Promise<LiveLocation[]> {
  const items = await flixbusAutocomplete(query, signal);
  const out: LiveLocation[] = [];
  const seenCity = new Set<string>();

  for (const item of items) {
    const cityName = item.city?.name ?? item.name;
    const cityId = item.city?.id ?? item.id;
    if (!cityId || !cityName) continue;

    // City-Eintrag (einmal pro City)
    if (!seenCity.has(cityId)) {
      seenCity.add(cityId);
      out.push({
        code: `flix:${cityId}`,
        label: cityName,
        city: cityName,
        country: item.country?.name ?? null,
        type: "BUS",
      });
    }

    // Optional: spezifische Station, wenn sie nicht selbst eine City ist
    if (item.id && item.id !== cityId && item.name && item.name !== cityName) {
      out.push({
        code: `flix:${item.id}`,
        label: `${item.name} (${cityName})`,
        city: cityName,
        country: item.country?.name ?? null,
        type: "BUS",
      });
    }
  }

  return out.slice(0, 25);
}

export async function dbRestLiveLocations(
  query: string,
  signal?: AbortSignal,
): Promise<LiveLocation[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];

  // /locations (HAFAS POI-Suche, inkl. internationale Bahnhöfe) statt /stations
  // (DB-Stationsdaten, nur deutsche Bahnhöfe). Damit findet die App auch
  // Amsterdam Centraal, Paris Gare du Nord, Wien Hbf, Brussel-Zuid usw.
  const url = new URL(`${config.DBREST_BASE_URL}/locations`);
  url.searchParams.set("query", trimmed);
  url.searchParams.set("results", "25");
  url.searchParams.set("stops", "true");
  url.searchParams.set("addresses", "false");
  url.searchParams.set("poi", "false");

  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as DbRestStation[] | Record<string, DbRestStation> | null;
  if (!data) return [];

  const list = Array.isArray(data) ? data : Object.values(data);

  // Soundex-Fallback bei HAFAS: bei „Hoefkade" (NL-Tram) liefert /locations
  // ähnlich-klingende DE-Bahnhöfe wie „Höfingen", „Höfen(Enz) Bf" zurück. Die
  // wollen wir nicht in die Autocomplete kippen — also nur Treffer behalten,
  // deren Name normalisiert mit dem Query-Prefix anfängt. Prefix-Länge =
  // min(4, query.length) damit kurze Eingaben („Köl") noch matchen.
  const wantPrefix = normalizeForMatch(trimmed).slice(0, Math.min(4, trimmed.length));

  const out: LiveLocation[] = [];
  const seenName = new Set<string>();
  for (const s of list) {
    // /locations liefert auch Adressen/POIs ohne `id` zurück — die sind für
    // Journey-Suchen unbrauchbar und müssen rausgefiltert werden. HAFAS markiert
    // Bahnhöfe als type=station oder type=stop (z.B. Paris Est).
    if (!s?.id || !s?.name || (s.type !== "station" && s.type !== "stop")) continue;
    if (wantPrefix && !normalizeForMatch(s.name).startsWith(wantPrefix)) continue;
    // HAFAS mischt echte Bahnhöfe (7-stellige UIC-IDs, z.B. 8000584=Willich-Anrath)
    // mit lokalen Bus-/Tramhalten (kürzere IDs wie 821676=„Anrath Bahnhof"). Wir
    // behalten beide, markieren aber nur die UIC-Bahnhöfe als TRAIN, damit die
    // UI für Halte ein Bus-Icon rendern kann.
    const isUicStation = /^\d{7}$/.test(s.id);
    // Name-basierte Dedup für Fälle wie zwei IDs mit identischem Anzeigenamen.
    const nameKey = s.name.toLowerCase();
    if (seenName.has(nameKey)) continue;
    seenName.add(nameKey);
    // Koordinaten aus allen drei möglichen Pfaden lesen — wir wissen nicht
    // welche db-rest-Version läuft.
    const lat = s.location?.latitude ?? s.coordinates?.latitude ?? s.latitude;
    const lng = s.location?.longitude ?? s.coordinates?.longitude ?? s.longitude;
    out.push({
      code: `dbrest:${s.id}`,
      label: s.name,
      city: s.name,
      country: inferCountryFromStationName(s.name),
      type: isUicStation ? "TRAIN" : "BUS",
      latitude: typeof lat === "number" ? lat : undefined,
      longitude: typeof lng === "number" ? lng : undefined,
      // HAFAS-ID nur bei 7-stelligen UIC-IDs setzen — kleinere IDs sind
      // lokale Stop-IDs (Bus/Tram), die collidieren manchmal über Verkehrs-
      // verbünde hinweg und sind kein zuverlässiger Dedup-Key.
      hafasId: isUicStation ? s.id : undefined,
    });
  }
  return out.slice(0, 25);
}

/** Lowercase + Diakritika-Entfernung für robusten Name-Vergleich.
 *  „Köln Hbf" → „koln hbf", „Höfingen" → „hofingen", „Hoefkade" → „hoefkade". */
function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export type { AutocompleteItem };
