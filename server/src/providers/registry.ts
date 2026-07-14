import type { TravelMode } from "../db/schema.js";
import type { SearchProvider } from "./types.js";
import { searchApiFlightsProvider } from "./flight/searchApiFlights.js";
import { googleFlightsProvider } from "./flight/googleFlights.js";
import { skyscannerProvider } from "./flight/skyscanner.js";
import { amadeusProvider } from "./flight/amadeus.js";
import { trainlineProvider } from "./train/trainline.js";
import { dbVendoProvider } from "./train/dbVendo.js";
import { motisProvider, motisBusProvider } from "./train/motis.js";
import { transitScheduleProvider } from "./train/transitSchedule.js";
import { flixbusProvider } from "./bus/flixbus.js";
import { busbudProvider } from "./bus/busbud.js";
import { cruisedirectProvider } from "./cruise/cruisedirect.js";

const REGISTRY: Record<TravelMode, SearchProvider[]> = {
  // SearchAPI.io ist der primäre Flug-Provider (volle Provider-Listen + günstige
  // Tarife, deterministisch). google-flights2 läuft NICHT mehr parallel mit —
  // es ist Fallback (siehe FALLBACK), wird also nur gecallt wenn SearchAPI 0
  // Treffer liefert (z.B. Ausfall) ODER bei Round-Trip (SearchAPI gibt one-way-
  // only zurück, g-f2 liefert Round-Trips kombiniert in einem Call).
  FLIGHT: [searchApiFlightsProvider, skyscannerProvider, amadeusProvider],
  // transitSchedule liefert NUR für Tram/U-Bahn-Origin bzw. GTFS-only-Länder
  // (NL/BE/CZ/GB/…) Schedule-Cards (price=0, "Tarif beim Anbieter"). Für
  // normale Bahnhöfe macht der Provider früh `empty()` und kostet nichts.
  // db-vendo ist die PRIMÄRE Zug-Quelle, MOTIS nur noch Reserve (siehe FALLBACK).
  //
  // Vorher liefen beide parallel und der Dedupe führte sie zusammen. Das kostete
  // Zeit und Konsistenz:
  //   - db-vendo antwortet in 1,2-1,8 s, MOTIS (öffentliches Transitous) in
  //     9-15 s und lief bei langen Strecken regelmäßig in den Provider-Timeout.
  //     Die Suche war also immer so langsam wie MOTIS.
  //   - Zur selben Fahrt lieferten beide unterschiedliche Gleise, Zugnamen und
  //     Preise; SOURCE_TRUST im Dedupe musste das jedes Mal geradebiegen.
  //
  // Die Annahme, MOTIS decke Nischen ab, die DB nicht kennt, hat sich nicht
  // bestätigt. Gemessen liefert db-vendo überall Treffer, wo MOTIS welche hatte:
  //     Zürich HB → Brunau (CH-Nahverkehr)      db-vendo 5
  //     Werl, Petrischule → Bahnhof (Ortsbus)   db-vendo 5
  //     Amsterdam Centraal → Sloterdijk         db-vendo 5
  //     Rom → Mailand                           db-vendo 5
  //     London Waterloo → St Pancras            db-vendo 5
  // Nur wo BEIDE leer sind (Lissabon), hilft auch MOTIS nicht.
  //
  // BEKANNTE SCHWÄCHE: Im Ausland benennt DB die Linien schlecht (London: gar
  // nicht, Amsterdam: "RE 8123" statt der NS-Linie). MOTIS hätte dort die echten
  // Namen. Innerdeutsch — der weit überwiegende Fall — ist db-vendo klar besser
  // (echte Gleise, echte Zugnamen, Preise).
  TRAIN: [dbVendoProvider, trainlineProvider, transitScheduleProvider],

  // dbVendo ist hier wieder DRIN — aber mit Modus-Filter (siehe isBusOnly dort).
  //
  // Historie: Er lieferte ungefiltert ZÜGE in die Bus-Suche („ICE 529, 0
  // Umstiege" bei Dortmund → Frankfurt), also flog er raus. Das war zu grob —
  // damit verschwand auch der LOKALE Busverkehr, den nur er findet:
  // „Werl, Petrischule → Werl, Bahnhof" lieferte 0 Ergebnisse, obwohl der Bus 522
  // dort fährt. MOTIS kann diese Strecke prinzipbedingt nicht (Ziel in Gehweite
  // → ÖPNV wird weggeprunt), FlixBus überspringt GTFS-Stop-IDs.
  //
  // Jetzt filtert er selbst: nur Verbindungen, deren Fahrten ALLE Busse sind.
  //
  // motis-bus ebenfalls in die Reserve: Seine Fernbus-Treffer sind dieselben
  // FlixBus-Fahrten, die der flixbus-Provider aus erster Hand hat (mit Preis und
  // Buchungslink), und den lokalen Bus deckt db-vendo ab.
  BUS: [dbVendoProvider, flixbusProvider, busbudProvider],
  CRUISE: [cruisedirectProvider],
};

// Fallback-Provider: laufen NUR wenn die Primaries (REGISTRY) 0 Treffer liefern.
// Spart Kosten/Quota — der teure Doppel-Call passiert nur im Ausfall-/Round-Trip-
// Fall, nicht bei jeder Suche.
const FALLBACK: Partial<Record<TravelMode, SearchProvider[]>> = {
  FLIGHT: [googleFlightsProvider],
  // MOTIS springt nur ein, wenn DB NICHTS liefert — sei es, weil die Strecke ihr
  // unbekannt ist, oder weil sie uns gerade blockt (Akamai/TLS, siehe
  // docker-compose.yml). Damit bleibt die unblockbare, kontingentfreie Quelle als
  // Sicherheitsnetz erhalten, ohne jede Suche auszubremsen.
  TRAIN: [motisProvider],
  BUS: [motisBusProvider],
};

export function providersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode];
}

export function activeProvidersForMode(mode: TravelMode): SearchProvider[] {
  return REGISTRY[mode].filter((p) => p.isConfigured());
}

export function activeFallbackProvidersForMode(mode: TravelMode): SearchProvider[] {
  return (FALLBACK[mode] ?? []).filter((p) => p.isConfigured());
}
