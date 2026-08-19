import { SearchResult } from "@/types/search";

const CARRIER_DOMAINS: Record<string, string> = {
  "deutsche bahn": "bahn.de",
  "db": "bahn.de",
  "flixbus": "flixbus.com",
  "flixtrain": "flixtrain.com",
  "öbb": "oebb.at",
  "obb": "oebb.at",
  "sbb": "sbb.ch",
  "lufthansa": "lufthansa.com",
  "austrian": "austrian.com",
  "swiss": "swiss.com",
  "eurowings": "eurowings.com",
  "british airways": "britishairways.com",
  "klm": "klm.com",
  "air france": "airfrance.com",
  "iberia": "iberia.com",
  "vueling": "vueling.com",
  "ryanair": "ryanair.com",
  "easyjet": "easyjet.com",
  "wizz air": "wizzair.com",
  "tap": "flytap.com",
  "tap portugal": "flytap.com",
  "turkish airlines": "turkishairlines.com",
  "emirates": "emirates.com",
  "qatar airways": "qatarairways.com",
  "etihad": "etihad.com",
  "delta": "delta.com",
  "united": "united.com",
  "american airlines": "aa.com",
  "ana": "ana.co.jp",
  "jal": "jal.com",
  "singapore airlines": "singaporeair.com",
  "cathay pacific": "cathaypacific.com",
};

// Logo-URLs gehen über wsrv.nl als Image-Proxy: Wikimedia blockt direkte
// Hotlinks auf ihre Thumbnail-URLs (HTTP 400 ohne Referer-Header), und
// React-Native Image rendert keine SVGs nativ. wsrv.nl löst beides — es
// fetcht die Quelle mit korrekten Headern und liefert eine PNG-Konversion
// in der gewünschten Größe. Stabiler Free-Service, dafür entworfen.
// Clearbit Logo-API ist 2024 abgeschaltet worden → fliegt raus.
// Reihenfolge im Flug-Zweig: avs.io (echtes Logo) → DuckDuckGo → Google-Favicon.
const DB_LOGO_URLS = [
  "https://wsrv.nl/?url=upload.wikimedia.org%2Fwikipedia%2Fcommons%2Fd%2Fd5%2FDeutsche_Bahn_AG-Logo.svg&output=png&w=200",
  "https://icons.duckduckgo.com/ip3/bahn.de.ico",
  "https://www.google.com/s2/favicons?domain=bahn.de&sz=128",
];

const FLIXBUS_LOGO_URLS = [
  "https://wsrv.nl/?url=upload.wikimedia.org%2Fwikipedia%2Fcommons%2F7%2F79%2FFlixBus_Logo.png&output=png&w=200",
  "https://icons.duckduckgo.com/ip3/flixbus.com.ico",
  "https://www.google.com/s2/favicons?domain=flixbus.com&sz=128",
];

export function airlineCode(flightNumber?: string): string | null {
  if (!flightNumber) return null;
  const m = flightNumber.trim().match(/^([A-Z0-9]{2,3})/i);
  return m ? m[1].toUpperCase() : null;
}

export function logoUrls(result: SearchResult, carrier: string): string[] {
  // TRAIN/BUS: feste Brand-Logo-Liste hat Vorrang vor `providerLogo`. Der
  // db-vendo-Provider setzt z.B. eine kleine Bahn-Favicon als providerLogo —
  // die wäre auf der Card kaum sichtbar. DB_LOGO_URLS zieht stattdessen das
  // hochauflösende Wikipedia-DB-Logo als ersten Kandidaten, gefolgt von
  // Clearbit + Google-Favicons als Fallback wenn die erste URL down ist.
  if (result.mode === "TRAIN") return DB_LOGO_URLS;
  if (result.mode === "BUS") return FLIXBUS_LOGO_URLS;
  if (result.providerLogo) return [result.providerLogo];
  if (result.mode === "FLIGHT") {
    const urls: string[] = [];
    const code = airlineCode(result.flightNumber);
    if (code) urls.push(`https://pics.avs.io/200/200/${code}.png`);
    const key = carrier.toLowerCase().trim();
    // Clearbit ist raus — die API ist 2024 abgeschaltet, der Kommentar oben sagt
    // das seit damals, im Flug-Zweig standen die Kandidaten aber noch drin. Jede
    // dieser Adressen war ein garantierter Fehlschlag: Bild laden, `onError`,
    // Zustand hochzählen, Karte neu rendern — bis zu zwei überflüssige Runden pro
    // Flugkarte, bevor sie beim Favicon landete.
    if (key && CARRIER_DOMAINS[key]) {
      urls.push(`https://icons.duckduckgo.com/ip3/${CARRIER_DOMAINS[key]}.ico`);
    }
    // Der geratene Slug ist RAUS. Solange dahinter Clearbit stand, war er ein
    // garantierter Fehlschlag und damit harmlos. Über einen funktionierenden
    // Dienst liefert er dagegen, was auf `<slug>.com` steht — bei Carriern
    // außerhalb der gepflegten Zuordnung also möglicherweise das Logo einer
    // wildfremden Firma. Lieber kein Logo als ein falsches.
    if (key && CARRIER_DOMAINS[key]) {
      urls.push(`https://www.google.com/s2/favicons?domain=${CARRIER_DOMAINS[key]}&sz=128`);
    }
    return urls;
  }
  return [];
}

const PROVIDER_INTERNAL_NAMES = /^(db[-_ ]?vendo|db[-_ ]?rest|hafas|google[-_ ]?flights|flixbus2?)$/i;
const PROVIDER_DISPLAY_OVERRIDES: Record<string, string> = {
  "db-vendo": "Deutsche Bahn",
  "dbvendo": "Deutsche Bahn",
  "db-rest": "Deutsche Bahn",
  "dbrest": "Deutsche Bahn",
};

export function displayProvider(result: SearchResult): string {
  const carrier = result.operatedBy?.trim();
  if (carrier && !PROVIDER_INTERNAL_NAMES.test(carrier)) return carrier;
  const provider = (result.provider ?? "").trim();
  const override = PROVIDER_DISPLAY_OVERRIDES[provider.toLowerCase()];
  if (override) return override;
  if (PROVIDER_INTERNAL_NAMES.test(provider)) {
    if (result.mode === "TRAIN") return "Deutsche Bahn";
    if (result.mode === "BUS") return "FlixBus";
  }
  return provider || carrier || "";
}

export function displayCode(code: string): string {
  if (!code) return "";
  if (code.includes(":")) return "";
  if (code.length > 6) return "";
  return code;
}
