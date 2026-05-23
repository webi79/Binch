import { Location, TravelMode } from "@/types/search";

/**
 * Statische Top-Vorschläge die im LocationPicker angezeigt werden,
 * bevor der User irgendwas tippt — damit der Picker nie leer wirkt.
 * Pro Mode kuratiert: Flughäfen für FLIGHT, große Städte für TRAIN/BUS,
 * Häfen für CRUISE.
 */
export const POPULAR_LOCATIONS: Record<TravelMode | "ALL", Location[]> = {
  FLIGHT: [
    { code: "BER", label: "Berlin Brandenburg (BER)", city: "Berlin", country: "Germany", type: "FLIGHT" },
    { code: "FRA", label: "Frankfurt am Main (FRA)", city: "Frankfurt", country: "Germany", type: "FLIGHT" },
    { code: "MUC", label: "Munich (MUC)", city: "Munich", country: "Germany", type: "FLIGHT" },
    { code: "HAM", label: "Hamburg (HAM)", city: "Hamburg", country: "Germany", type: "FLIGHT" },
    { code: "DUS", label: "Düsseldorf (DUS)", city: "Düsseldorf", country: "Germany", type: "FLIGHT" },
    { code: "LHR", label: "London Heathrow (LHR)", city: "London", country: "United Kingdom", type: "FLIGHT" },
    { code: "CDG", label: "Paris Charles de Gaulle (CDG)", city: "Paris", country: "France", type: "FLIGHT" },
    { code: "AMS", label: "Amsterdam Schiphol (AMS)", city: "Amsterdam", country: "Netherlands", type: "FLIGHT" },
    { code: "BCN", label: "Barcelona (BCN)", city: "Barcelona", country: "Spain", type: "FLIGHT" },
    { code: "FCO", label: "Rome Fiumicino (FCO)", city: "Rome", country: "Italy", type: "FLIGHT" },
  ],
  // Train-Suggestions nutzen das `sta:<UIC>`-Format wie der StaDa-Import,
  // damit Trip-Search die HAFAS-ID direkt verwendet (keine Live-ID-Auflösung).
  // Coords sind hinterlegt für sofortiges Map-Fly-To im Surroundings-Picker.
  TRAIN: [
    { code: "sta:8011160", label: "Berlin Hbf", city: "Berlin", country: "Germany", type: "TRAIN", latitude: 52.5251, longitude: 13.3691 },
    { code: "sta:8000261", label: "München Hbf", city: "München", country: "Germany", type: "TRAIN", latitude: 48.1402, longitude: 11.5611 },
    { code: "sta:8002549", label: "Hamburg Hbf", city: "Hamburg", country: "Germany", type: "TRAIN", latitude: 53.5528, longitude: 10.0067 },
    { code: "sta:8000105", label: "Frankfurt (Main) Hbf", city: "Frankfurt", country: "Germany", type: "TRAIN", latitude: 50.1075, longitude: 8.6629 },
    { code: "sta:8000207", label: "Köln Hbf", city: "Köln", country: "Germany", type: "TRAIN", latitude: 50.9430, longitude: 6.9587 },
    { code: "sta:8101003", label: "Wien Hbf", city: "Wien", country: "Austria", type: "TRAIN", latitude: 48.1854, longitude: 16.3768 },
    { code: "sta:8503000", label: "Zürich HB", city: "Zürich", country: "Switzerland", type: "TRAIN", latitude: 47.3779, longitude: 8.5403 },
    { code: "sta:8727100", label: "Paris Gare du Nord", city: "Paris", country: "France", type: "TRAIN", latitude: 48.8810, longitude: 2.3554 },
    { code: "sta:8400058", label: "Amsterdam Centraal", city: "Amsterdam", country: "Netherlands", type: "TRAIN", latitude: 52.3789, longitude: 4.9003 },
    { code: "sta:8814001", label: "Bruxelles-Midi", city: "Bruxelles", country: "Belgium", type: "TRAIN", latitude: 50.8358, longitude: 4.3360 },
  ],
  // Bus-Stationen haben keine HAFAS-IDs — Codes bleiben wie bisher, Coords
  // direkt eingebaut für Map-Fly-To.
  BUS: [
    { code: "DE-BER-B", label: "Berlin ZOB", city: "Berlin", country: "Germany", type: "BUS", latitude: 52.5067, longitude: 13.2776 },
    { code: "DE-MUC-B", label: "München ZOB", city: "München", country: "Germany", type: "BUS", latitude: 48.1431, longitude: 11.5474 },
    { code: "DE-FRA-B", label: "Frankfurt (am Hbf)", city: "Frankfurt", country: "Germany", type: "BUS", latitude: 50.1067, longitude: 8.6638 },
    { code: "DE-HAM-B", label: "Hamburg ZOB", city: "Hamburg", country: "Germany", type: "BUS", latitude: 53.5528, longitude: 10.0066 },
    { code: "DE-CGN-B", label: "Köln (am Hbf)", city: "Köln", country: "Germany", type: "BUS", latitude: 50.9430, longitude: 6.9587 },
    { code: "AT-VIE-B", label: "Wien Erdberg", city: "Wien", country: "Austria", type: "BUS", latitude: 48.1934, longitude: 16.4146 },
    { code: "CZ-PRG-B", label: "Prag UAN Florenc", city: "Praha", country: "Czech Republic", type: "BUS", latitude: 50.0893, longitude: 14.4404 },
    { code: "PL-WAW-B", label: "Warschau Zachodnia", city: "Warszawa", country: "Poland", type: "BUS", latitude: 52.2196, longitude: 20.9714 },
    { code: "FR-PAR-B", label: "Paris Bercy", city: "Paris", country: "France", type: "BUS", latitude: 48.8390, longitude: 2.3825 },
    { code: "NL-AMS-B", label: "Amsterdam Sloterdijk", city: "Amsterdam", country: "Netherlands", type: "BUS", latitude: 52.3892, longitude: 4.8378 },
  ],
  CRUISE: [
    { code: "PORT-CIV", label: "Civitavecchia (Rome)", city: "Civitavecchia", country: "Italy", type: "CRUISE" },
    { code: "PORT-BCN", label: "Barcelona Port", city: "Barcelona", country: "Spain", type: "CRUISE" },
    { code: "PORT-VEN", label: "Venedig Port", city: "Venezia", country: "Italy", type: "CRUISE" },
    { code: "PORT-HAM", label: "Hamburg Port", city: "Hamburg", country: "Germany", type: "CRUISE" },
    { code: "PORT-CPH", label: "Kopenhagen Port", city: "København", country: "Denmark", type: "CRUISE" },
    { code: "PORT-MIA", label: "Miami Port", city: "Miami", country: "United States", type: "CRUISE" },
    { code: "PORT-SOU", label: "Southampton", city: "Southampton", country: "United Kingdom", type: "CRUISE" },
    { code: "PORT-PIR", label: "Piräus (Athen)", city: "Piraeus", country: "Greece", type: "CRUISE" },
  ],
  // Surroundings-Picker zeigt einen kuratierten Mix aus allen Typen — Top-3 pro
  // Mode, damit die Liste vielfältig wirkt (Flughafen / Bahnhof / Bus / Hafen).
  // Airports/Ports brauchen keine Coords im Eintrag — die holt sich
  // `resolveLocationCoord` aus AIRPORT_PINS / CRUISE_PORT_PINS. Trains/Buses
  // haben sie inline damit das Map-Fly-To direkt funktioniert.
  ALL: [
    { code: "BER", label: "Berlin Brandenburg (BER)", city: "Berlin", country: "Germany", type: "FLIGHT" },
    { code: "FRA", label: "Frankfurt am Main (FRA)", city: "Frankfurt", country: "Germany", type: "FLIGHT" },
    { code: "MUC", label: "Munich (MUC)", city: "Munich", country: "Germany", type: "FLIGHT" },
    { code: "sta:8011160", label: "Berlin Hbf", city: "Berlin", country: "Germany", type: "TRAIN", latitude: 52.5251, longitude: 13.3691 },
    { code: "sta:8000261", label: "München Hbf", city: "München", country: "Germany", type: "TRAIN", latitude: 48.1402, longitude: 11.5611 },
    { code: "sta:8727100", label: "Paris Gare du Nord", city: "Paris", country: "France", type: "TRAIN", latitude: 48.8810, longitude: 2.3554 },
    { code: "DE-BER-B", label: "Berlin ZOB", city: "Berlin", country: "Germany", type: "BUS", latitude: 52.5067, longitude: 13.2776 },
    { code: "DE-MUC-B", label: "München ZOB", city: "München", country: "Germany", type: "BUS", latitude: 48.1431, longitude: 11.5474 },
    { code: "AT-VIE-B", label: "Wien Erdberg", city: "Wien", country: "Austria", type: "BUS", latitude: 48.1934, longitude: 16.4146 },
    { code: "PORT-HAM", label: "Hamburg Port", city: "Hamburg", country: "Germany", type: "CRUISE" },
    { code: "PORT-BCN", label: "Barcelona Port", city: "Barcelona", country: "Spain", type: "CRUISE" },
    { code: "PORT-CIV", label: "Civitavecchia (Rome)", city: "Civitavecchia", country: "Italy", type: "CRUISE" },
  ],
};
