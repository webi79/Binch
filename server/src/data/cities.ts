/**
 * Wichtige Städte für TRAIN- und BUS-Routen in Europa + ausgewählte
 * weltweite Hubs. Werden vom Seeder mit type="ALL" eingefügt — die
 * Suche zeigt sie damit für Bahn, Bus und (durchsuchbar) Flug-Modus.
 *
 * Code-Schema: 3-Letter ISO-Country + Slug (z.B. "DE-BERLIN").
 * Erweiterbar — neue Einträge einfach am Ende der Region anhängen.
 */
export interface CitySeed {
  code: string;
  name: string;
  city: string;
  country: string;
}

export const CITIES: CitySeed[] = [
  // === Germany ===
  { code: "DE-BER", name: "Berlin", city: "Berlin", country: "Germany" },
  { code: "DE-MUC", name: "München", city: "München", country: "Germany" },
  { code: "DE-HAM", name: "Hamburg", city: "Hamburg", country: "Germany" },
  { code: "DE-FRA", name: "Frankfurt am Main", city: "Frankfurt", country: "Germany" },
  { code: "DE-CGN", name: "Köln", city: "Köln", country: "Germany" },
  { code: "DE-DUS", name: "Düsseldorf", city: "Düsseldorf", country: "Germany" },
  { code: "DE-STR", name: "Stuttgart", city: "Stuttgart", country: "Germany" },
  { code: "DE-LEJ", name: "Leipzig", city: "Leipzig", country: "Germany" },
  { code: "DE-DTM", name: "Dortmund", city: "Dortmund", country: "Germany" },
  { code: "DE-ESN", name: "Essen", city: "Essen", country: "Germany" },
  { code: "DE-DRS", name: "Dresden", city: "Dresden", country: "Germany" },
  { code: "DE-HAN", name: "Hannover", city: "Hannover", country: "Germany" },
  { code: "DE-NUE", name: "Nürnberg", city: "Nürnberg", country: "Germany" },
  { code: "DE-BRE", name: "Bremen", city: "Bremen", country: "Germany" },
  { code: "DE-BOC", name: "Bochum", city: "Bochum", country: "Germany" },
  { code: "DE-WUP", name: "Wuppertal", city: "Wuppertal", country: "Germany" },
  { code: "DE-BIE", name: "Bielefeld", city: "Bielefeld", country: "Germany" },
  { code: "DE-MAN", name: "Mannheim", city: "Mannheim", country: "Germany" },
  { code: "DE-KAR", name: "Karlsruhe", city: "Karlsruhe", country: "Germany" },
  { code: "DE-AUG", name: "Augsburg", city: "Augsburg", country: "Germany" },
  { code: "DE-FRE", name: "Freiburg", city: "Freiburg", country: "Germany" },
  { code: "DE-MUE", name: "Münster", city: "Münster", country: "Germany" },
  { code: "DE-AAC", name: "Aachen", city: "Aachen", country: "Germany" },
  { code: "DE-BNN", name: "Bonn", city: "Bonn", country: "Germany" },
  { code: "DE-MZ", name: "Mainz", city: "Mainz", country: "Germany" },
  { code: "DE-HEI", name: "Heidelberg", city: "Heidelberg", country: "Germany" },
  { code: "DE-WUE", name: "Würzburg", city: "Würzburg", country: "Germany" },
  { code: "DE-KAS", name: "Kassel", city: "Kassel", country: "Germany" },
  { code: "DE-KIE", name: "Kiel", city: "Kiel", country: "Germany" },
  { code: "DE-MAG", name: "Magdeburg", city: "Magdeburg", country: "Germany" },
  { code: "DE-ROS", name: "Rostock", city: "Rostock", country: "Germany" },
  { code: "DE-ULM", name: "Ulm", city: "Ulm", country: "Germany" },
  { code: "DE-ERF", name: "Erfurt", city: "Erfurt", country: "Germany" },

  // === Austria ===
  { code: "AT-VIE", name: "Wien", city: "Wien", country: "Austria" },
  { code: "AT-SZG", name: "Salzburg", city: "Salzburg", country: "Austria" },
  { code: "AT-INN", name: "Innsbruck", city: "Innsbruck", country: "Austria" },
  { code: "AT-GRZ", name: "Graz", city: "Graz", country: "Austria" },
  { code: "AT-LNZ", name: "Linz", city: "Linz", country: "Austria" },
  { code: "AT-KLU", name: "Klagenfurt", city: "Klagenfurt", country: "Austria" },

  // === Switzerland ===
  { code: "CH-ZRH", name: "Zürich", city: "Zürich", country: "Switzerland" },
  { code: "CH-BSL", name: "Basel", city: "Basel", country: "Switzerland" },
  { code: "CH-GVA", name: "Genf", city: "Genf", country: "Switzerland" },
  { code: "CH-BRN", name: "Bern", city: "Bern", country: "Switzerland" },
  { code: "CH-LAU", name: "Lausanne", city: "Lausanne", country: "Switzerland" },
  { code: "CH-LUC", name: "Luzern", city: "Luzern", country: "Switzerland" },

  // === France ===
  { code: "FR-PAR", name: "Paris", city: "Paris", country: "France" },
  { code: "FR-LYS", name: "Lyon", city: "Lyon", country: "France" },
  { code: "FR-MRS", name: "Marseille", city: "Marseille", country: "France" },
  { code: "FR-TLS", name: "Toulouse", city: "Toulouse", country: "France" },
  { code: "FR-NCE", name: "Nice", city: "Nice", country: "France" },
  { code: "FR-NTE", name: "Nantes", city: "Nantes", country: "France" },
  { code: "FR-BOD", name: "Bordeaux", city: "Bordeaux", country: "France" },
  { code: "FR-LIL", name: "Lille", city: "Lille", country: "France" },
  { code: "FR-RNS", name: "Rennes", city: "Rennes", country: "France" },
  { code: "FR-SBR", name: "Straßburg", city: "Strasbourg", country: "France" },
  { code: "FR-MPL", name: "Montpellier", city: "Montpellier", country: "France" },
  { code: "FR-RUH", name: "Reims", city: "Reims", country: "France" },

  // === United Kingdom ===
  { code: "GB-LON", name: "London", city: "London", country: "United Kingdom" },
  { code: "GB-MAN", name: "Manchester", city: "Manchester", country: "United Kingdom" },
  { code: "GB-BHX", name: "Birmingham", city: "Birmingham", country: "United Kingdom" },
  { code: "GB-LIV", name: "Liverpool", city: "Liverpool", country: "United Kingdom" },
  { code: "GB-LDS", name: "Leeds", city: "Leeds", country: "United Kingdom" },
  { code: "GB-EDI", name: "Edinburgh", city: "Edinburgh", country: "United Kingdom" },
  { code: "GB-GLA", name: "Glasgow", city: "Glasgow", country: "United Kingdom" },
  { code: "GB-BRS", name: "Bristol", city: "Bristol", country: "United Kingdom" },
  { code: "GB-NCL", name: "Newcastle", city: "Newcastle", country: "United Kingdom" },
  { code: "GB-CAM", name: "Cambridge", city: "Cambridge", country: "United Kingdom" },
  { code: "GB-OXF", name: "Oxford", city: "Oxford", country: "United Kingdom" },
  { code: "GB-NOT", name: "Nottingham", city: "Nottingham", country: "United Kingdom" },

  // === Italy ===
  { code: "IT-ROM", name: "Rom", city: "Roma", country: "Italy" },
  { code: "IT-MIL", name: "Mailand", city: "Milano", country: "Italy" },
  { code: "IT-NAP", name: "Neapel", city: "Napoli", country: "Italy" },
  { code: "IT-TUR", name: "Turin", city: "Torino", country: "Italy" },
  { code: "IT-FLR", name: "Florenz", city: "Firenze", country: "Italy" },
  { code: "IT-VEN", name: "Venedig", city: "Venezia", country: "Italy" },
  { code: "IT-BLQ", name: "Bologna", city: "Bologna", country: "Italy" },
  { code: "IT-VRN", name: "Verona", city: "Verona", country: "Italy" },
  { code: "IT-GOA", name: "Genua", city: "Genova", country: "Italy" },
  { code: "IT-PIS", name: "Pisa", city: "Pisa", country: "Italy" },
  { code: "IT-PMO", name: "Palermo", city: "Palermo", country: "Italy" },
  { code: "IT-BAR", name: "Bari", city: "Bari", country: "Italy" },

  // === Spain ===
  { code: "ES-MAD", name: "Madrid", city: "Madrid", country: "Spain" },
  { code: "ES-BCN", name: "Barcelona", city: "Barcelona", country: "Spain" },
  { code: "ES-VLC", name: "Valencia", city: "Valencia", country: "Spain" },
  { code: "ES-SVQ", name: "Sevilla", city: "Sevilla", country: "Spain" },
  { code: "ES-BIO", name: "Bilbao", city: "Bilbao", country: "Spain" },
  { code: "ES-AGP", name: "Málaga", city: "Málaga", country: "Spain" },
  { code: "ES-SCQ", name: "Santiago de Compostela", city: "Santiago de Compostela", country: "Spain" },
  { code: "ES-ZAZ", name: "Zaragoza", city: "Zaragoza", country: "Spain" },
  { code: "ES-GRX", name: "Granada", city: "Granada", country: "Spain" },

  // === Netherlands / Belgium / Luxembourg ===
  { code: "NL-AMS", name: "Amsterdam", city: "Amsterdam", country: "Netherlands" },
  { code: "NL-RTM", name: "Rotterdam", city: "Rotterdam", country: "Netherlands" },
  { code: "NL-HAG", name: "Den Haag", city: "Den Haag", country: "Netherlands" },
  { code: "NL-UTC", name: "Utrecht", city: "Utrecht", country: "Netherlands" },
  { code: "NL-EIN", name: "Eindhoven", city: "Eindhoven", country: "Netherlands" },
  { code: "BE-BRU", name: "Brüssel", city: "Bruxelles", country: "Belgium" },
  { code: "BE-ANR", name: "Antwerpen", city: "Antwerpen", country: "Belgium" },
  { code: "BE-LGG", name: "Lüttich", city: "Liège", country: "Belgium" },
  { code: "BE-GNT", name: "Gent", city: "Gent", country: "Belgium" },
  { code: "LU-LUX", name: "Luxemburg", city: "Luxembourg", country: "Luxembourg" },

  // === Czech Republic / Poland / Hungary ===
  { code: "CZ-PRG", name: "Prag", city: "Praha", country: "Czech Republic" },
  { code: "CZ-BRQ", name: "Brünn", city: "Brno", country: "Czech Republic" },
  { code: "PL-WAW", name: "Warschau", city: "Warszawa", country: "Poland" },
  { code: "PL-KRK", name: "Krakau", city: "Kraków", country: "Poland" },
  { code: "PL-WRO", name: "Breslau", city: "Wrocław", country: "Poland" },
  { code: "PL-POZ", name: "Posen", city: "Poznań", country: "Poland" },
  { code: "PL-GDN", name: "Danzig", city: "Gdańsk", country: "Poland" },
  { code: "HU-BUD", name: "Budapest", city: "Budapest", country: "Hungary" },
  { code: "SK-BTS", name: "Bratislava", city: "Bratislava", country: "Slovakia" },

  // === Nordics ===
  { code: "DK-CPH", name: "Kopenhagen", city: "København", country: "Denmark" },
  { code: "SE-STO", name: "Stockholm", city: "Stockholm", country: "Sweden" },
  { code: "SE-GOT", name: "Göteborg", city: "Göteborg", country: "Sweden" },
  { code: "SE-MMA", name: "Malmö", city: "Malmö", country: "Sweden" },
  { code: "NO-OSL", name: "Oslo", city: "Oslo", country: "Norway" },
  { code: "NO-BGO", name: "Bergen", city: "Bergen", country: "Norway" },
  { code: "FI-HEL", name: "Helsinki", city: "Helsinki", country: "Finland" },

  // === Southeast Europe ===
  { code: "GR-ATH", name: "Athen", city: "Athens", country: "Greece" },
  { code: "GR-SKG", name: "Thessaloniki", city: "Thessaloniki", country: "Greece" },
  { code: "TR-IST", name: "Istanbul", city: "Istanbul", country: "Turkey" },
  { code: "RO-OTP", name: "Bukarest", city: "București", country: "Romania" },
  { code: "BG-SOF", name: "Sofia", city: "Sofia", country: "Bulgaria" },
  { code: "HR-ZAG", name: "Zagreb", city: "Zagreb", country: "Croatia" },
  { code: "HR-SPU", name: "Split", city: "Split", country: "Croatia" },
  { code: "SI-LJU", name: "Ljubljana", city: "Ljubljana", country: "Slovenia" },
  { code: "RS-BEG", name: "Belgrad", city: "Beograd", country: "Serbia" },

  // === Iberia + Portugal ===
  { code: "PT-LIS", name: "Lissabon", city: "Lisboa", country: "Portugal" },
  { code: "PT-OPO", name: "Porto", city: "Porto", country: "Portugal" },
  { code: "PT-FAO", name: "Faro", city: "Faro", country: "Portugal" },

  // === Ireland ===
  { code: "IE-DUB", name: "Dublin", city: "Dublin", country: "Ireland" },
  { code: "IE-CRK", name: "Cork", city: "Cork", country: "Ireland" },
];

/**
 * Cruise-Häfen weltweit (Auswahl der wichtigsten Embarkation-/Destination-Ports).
 */
export interface CruisePortSeed {
  code: string;
  name: string;
  city: string;
  country: string;
}

export const CRUISE_PORTS: CruisePortSeed[] = [
  // === Mediterranean ===
  { code: "PORT-CIV", name: "Civitavecchia (Rome)", city: "Civitavecchia", country: "Italy" },
  { code: "PORT-BCN", name: "Barcelona Port", city: "Barcelona", country: "Spain" },
  { code: "PORT-VEN", name: "Venedig Port", city: "Venezia", country: "Italy" },
  { code: "PORT-PIR", name: "Piräus (Athen)", city: "Piraeus", country: "Greece" },
  { code: "PORT-MAR", name: "Marseille Port", city: "Marseille", country: "France" },
  { code: "PORT-NAP", name: "Neapel Port", city: "Napoli", country: "Italy" },
  { code: "PORT-PMI", name: "Palma de Mallorca", city: "Palma", country: "Spain" },
  { code: "PORT-DBV", name: "Dubrovnik", city: "Dubrovnik", country: "Croatia" },
  { code: "PORT-SPU", name: "Split Port", city: "Split", country: "Croatia" },
  { code: "PORT-LIV", name: "Livorno (Florenz)", city: "Livorno", country: "Italy" },
  { code: "PORT-VAL", name: "Valencia Port", city: "Valencia", country: "Spain" },
  { code: "PORT-MLA", name: "Malta", city: "Valletta", country: "Malta" },

  // === Northern Europe ===
  { code: "PORT-CPH", name: "Kopenhagen Port", city: "København", country: "Denmark" },
  { code: "PORT-STO", name: "Stockholm Port", city: "Stockholm", country: "Sweden" },
  { code: "PORT-HEL", name: "Helsinki Port", city: "Helsinki", country: "Finland" },
  { code: "PORT-OSL", name: "Oslo Port", city: "Oslo", country: "Norway" },
  { code: "PORT-BGO", name: "Bergen Port", city: "Bergen", country: "Norway" },
  { code: "PORT-HAM", name: "Hamburg Port", city: "Hamburg", country: "Germany" },
  { code: "PORT-KIE", name: "Kiel Port", city: "Kiel", country: "Germany" },
  { code: "PORT-WAR", name: "Warnemünde", city: "Rostock", country: "Germany" },
  { code: "PORT-AMS", name: "Amsterdam Port", city: "Amsterdam", country: "Netherlands" },
  { code: "PORT-RTM", name: "Rotterdam Port", city: "Rotterdam", country: "Netherlands" },
  { code: "PORT-SOU", name: "Southampton", city: "Southampton", country: "United Kingdom" },
  { code: "PORT-DOV", name: "Dover", city: "Dover", country: "United Kingdom" },
  { code: "PORT-REY", name: "Reykjavík", city: "Reykjavík", country: "Iceland" },

  // === Caribbean / Americas ===
  { code: "PORT-MIA", name: "Miami Port", city: "Miami", country: "United States" },
  { code: "PORT-FLL", name: "Fort Lauderdale", city: "Fort Lauderdale", country: "United States" },
  { code: "PORT-PCN", name: "Port Canaveral", city: "Port Canaveral", country: "United States" },
  { code: "PORT-GAL", name: "Galveston", city: "Galveston", country: "United States" },
  { code: "PORT-NYC", name: "New York Port", city: "New York", country: "United States" },
  { code: "PORT-NAS", name: "Nassau", city: "Nassau", country: "Bahamas" },
  { code: "PORT-COZ", name: "Cozumel", city: "Cozumel", country: "Mexico" },
  { code: "PORT-SJU", name: "San Juan", city: "San Juan", country: "Puerto Rico" },
  { code: "PORT-LAX", name: "Los Angeles Port", city: "Los Angeles", country: "United States" },
  { code: "PORT-SEA", name: "Seattle Port", city: "Seattle", country: "United States" },
  { code: "PORT-VAN", name: "Vancouver Port", city: "Vancouver", country: "Canada" },

  // === Asia / Pacific ===
  { code: "PORT-SIN", name: "Singapore Cruise Centre", city: "Singapore", country: "Singapore" },
  { code: "PORT-HKG", name: "Hong Kong Cruise", city: "Hong Kong", country: "Hong Kong" },
  { code: "PORT-DXB", name: "Dubai Port", city: "Dubai", country: "United Arab Emirates" },
  { code: "PORT-SYD", name: "Sydney Cruise Terminal", city: "Sydney", country: "Australia" },
];
