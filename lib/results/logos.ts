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

const DB_LOGO_URLS = [
  "https://upload.wikimedia.org/wikipedia/commons/thumb/2/24/Deutsche_Bahn_AG-Logo.svg/200px-Deutsche_Bahn_AG-Logo.svg.png",
  "https://logo.clearbit.com/bahn.de",
  "https://www.google.com/s2/favicons?domain=bahn.de&sz=128",
];

const FLIXBUS_LOGO_URLS = [
  "https://logo.clearbit.com/flixbus.com",
  "https://www.google.com/s2/favicons?domain=flixbus.com&sz=128",
];

function clearbit(domain: string): string {
  return `https://logo.clearbit.com/${domain}`;
}

export function airlineCode(flightNumber?: string): string | null {
  if (!flightNumber) return null;
  const m = flightNumber.trim().match(/^([A-Z0-9]{2,3})/i);
  return m ? m[1].toUpperCase() : null;
}

export function logoUrls(result: SearchResult, carrier: string): string[] {
  if (result.providerLogo) return [result.providerLogo];
  if (result.mode === "TRAIN") return DB_LOGO_URLS;
  if (result.mode === "BUS") return FLIXBUS_LOGO_URLS;
  if (result.mode === "FLIGHT") {
    const urls: string[] = [];
    const code = airlineCode(result.flightNumber);
    if (code) urls.push(`https://pics.avs.io/200/200/${code}.png`);
    const key = carrier.toLowerCase().trim();
    if (key && CARRIER_DOMAINS[key]) urls.push(clearbit(CARRIER_DOMAINS[key]));
    const slug = key
      .replace(/\s+(airlines|airline|airways|gmbh|ag|sa|nv|inc|ltd|co)\.?$/g, "")
      .replace(/[^a-z0-9]/g, "");
    if (slug.length >= 3) urls.push(clearbit(`${slug}.com`));
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
