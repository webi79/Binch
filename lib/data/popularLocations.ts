import { Location, TravelMode } from "@/types/search";

/**
 * Statische Top-Vorschläge die im LocationPicker angezeigt werden,
 * bevor der User irgendwas tippt — damit der Picker nie leer wirkt.
 * Pro Mode kuratiert: Flughäfen für FLIGHT, große Städte für TRAIN/BUS,
 * Häfen für CRUISE.
 */
export const POPULAR_LOCATIONS: Record<TravelMode, Location[]> = {
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
  TRAIN: [
    { code: "DE-BER", label: "Berlin", city: "Berlin", country: "Germany", type: "TRAIN" },
    { code: "DE-MUC", label: "München", city: "München", country: "Germany", type: "TRAIN" },
    { code: "DE-HAM", label: "Hamburg", city: "Hamburg", country: "Germany", type: "TRAIN" },
    { code: "DE-FRA", label: "Frankfurt am Main", city: "Frankfurt", country: "Germany", type: "TRAIN" },
    { code: "DE-CGN", label: "Köln", city: "Köln", country: "Germany", type: "TRAIN" },
    { code: "AT-VIE", label: "Wien", city: "Wien", country: "Austria", type: "TRAIN" },
    { code: "CH-ZRH", label: "Zürich", city: "Zürich", country: "Switzerland", type: "TRAIN" },
    { code: "FR-PAR", label: "Paris", city: "Paris", country: "France", type: "TRAIN" },
    { code: "NL-AMS", label: "Amsterdam", city: "Amsterdam", country: "Netherlands", type: "TRAIN" },
    { code: "BE-BRU", label: "Brüssel", city: "Bruxelles", country: "Belgium", type: "TRAIN" },
  ],
  BUS: [
    { code: "DE-BER", label: "Berlin", city: "Berlin", country: "Germany", type: "BUS" },
    { code: "DE-MUC", label: "München", city: "München", country: "Germany", type: "BUS" },
    { code: "DE-FRA", label: "Frankfurt am Main", city: "Frankfurt", country: "Germany", type: "BUS" },
    { code: "DE-HAM", label: "Hamburg", city: "Hamburg", country: "Germany", type: "BUS" },
    { code: "DE-CGN", label: "Köln", city: "Köln", country: "Germany", type: "BUS" },
    { code: "AT-VIE", label: "Wien", city: "Wien", country: "Austria", type: "BUS" },
    { code: "CZ-PRG", label: "Prag", city: "Praha", country: "Czech Republic", type: "BUS" },
    { code: "PL-WAW", label: "Warschau", city: "Warszawa", country: "Poland", type: "BUS" },
    { code: "FR-PAR", label: "Paris", city: "Paris", country: "France", type: "BUS" },
    { code: "NL-AMS", label: "Amsterdam", city: "Amsterdam", country: "Netherlands", type: "BUS" },
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
};
