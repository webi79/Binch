// IATA airport code → IANA timezone identifier.
// Covers the ~250 busiest airports worldwide. Returns null for unknown codes,
// callers should fall back to UTC formatting with a clear label.

const AIRPORT_TZ: Record<string, string> = {
  // Europe
  LHR: "Europe/London", LGW: "Europe/London", STN: "Europe/London", LTN: "Europe/London", LCY: "Europe/London",
  MAN: "Europe/London", BHX: "Europe/London", EDI: "Europe/London", GLA: "Europe/London", BRS: "Europe/London",
  NCL: "Europe/London", LPL: "Europe/London", BFS: "Europe/London", DUB: "Europe/Dublin", ORK: "Europe/Dublin",
  CDG: "Europe/Paris", ORY: "Europe/Paris", BVA: "Europe/Paris", NCE: "Europe/Paris", LYS: "Europe/Paris",
  MRS: "Europe/Paris", TLS: "Europe/Paris", BOD: "Europe/Paris", NTE: "Europe/Paris",
  AMS: "Europe/Amsterdam", EIN: "Europe/Amsterdam", RTM: "Europe/Amsterdam",
  BRU: "Europe/Brussels", CRL: "Europe/Brussels", ANR: "Europe/Brussels",
  LUX: "Europe/Luxembourg",
  FRA: "Europe/Berlin", MUC: "Europe/Berlin", BER: "Europe/Berlin", DUS: "Europe/Berlin", HAM: "Europe/Berlin",
  CGN: "Europe/Berlin", STR: "Europe/Berlin", NUE: "Europe/Berlin", HAJ: "Europe/Berlin", LEJ: "Europe/Berlin",
  DTM: "Europe/Berlin", BRE: "Europe/Berlin", FMO: "Europe/Berlin", FKB: "Europe/Berlin",
  VIE: "Europe/Vienna", SZG: "Europe/Vienna", INN: "Europe/Vienna", GRZ: "Europe/Vienna",
  ZRH: "Europe/Zurich", GVA: "Europe/Zurich", BSL: "Europe/Zurich", BRN: "Europe/Zurich",
  MXP: "Europe/Rome", LIN: "Europe/Rome", FCO: "Europe/Rome", CIA: "Europe/Rome", BGY: "Europe/Rome",
  NAP: "Europe/Rome", VCE: "Europe/Rome", BLQ: "Europe/Rome", CTA: "Europe/Rome", PMO: "Europe/Rome",
  TRN: "Europe/Rome", PSA: "Europe/Rome", VRN: "Europe/Rome",
  MAD: "Europe/Madrid", BCN: "Europe/Madrid", AGP: "Europe/Madrid", PMI: "Europe/Madrid", VLC: "Europe/Madrid",
  SVQ: "Europe/Madrid", BIO: "Europe/Madrid", ALC: "Europe/Madrid", LPA: "Atlantic/Canary", TFS: "Atlantic/Canary",
  TFN: "Atlantic/Canary", ACE: "Atlantic/Canary", FUE: "Atlantic/Canary", IBZ: "Europe/Madrid",
  LIS: "Europe/Lisbon", OPO: "Europe/Lisbon", FAO: "Europe/Lisbon", PDL: "Atlantic/Azores", FNC: "Atlantic/Madeira",
  CPH: "Europe/Copenhagen", BLL: "Europe/Copenhagen", AAL: "Europe/Copenhagen",
  ARN: "Europe/Stockholm", GOT: "Europe/Stockholm", BMA: "Europe/Stockholm", NYO: "Europe/Stockholm",
  OSL: "Europe/Oslo", BGO: "Europe/Oslo", TRD: "Europe/Oslo", SVG: "Europe/Oslo", TOS: "Europe/Oslo",
  HEL: "Europe/Helsinki", TMP: "Europe/Helsinki", OUL: "Europe/Helsinki",
  KEF: "Atlantic/Reykjavik", RKV: "Atlantic/Reykjavik",
  WAW: "Europe/Warsaw", KRK: "Europe/Warsaw", GDN: "Europe/Warsaw", WRO: "Europe/Warsaw", KTW: "Europe/Warsaw",
  POZ: "Europe/Warsaw",
  PRG: "Europe/Prague", BRQ: "Europe/Prague", OSR: "Europe/Prague",
  BUD: "Europe/Budapest", DEB: "Europe/Budapest",
  OTP: "Europe/Bucharest", CLJ: "Europe/Bucharest", TSR: "Europe/Bucharest",
  SOF: "Europe/Sofia", VAR: "Europe/Sofia", BOJ: "Europe/Sofia",
  ATH: "Europe/Athens", SKG: "Europe/Athens", HER: "Europe/Athens", RHO: "Europe/Athens", CFU: "Europe/Athens",
  IST: "Europe/Istanbul", SAW: "Europe/Istanbul", AYT: "Europe/Istanbul", ESB: "Europe/Istanbul", ADB: "Europe/Istanbul",
  BJV: "Europe/Istanbul", DLM: "Europe/Istanbul",
  SVO: "Europe/Moscow", DME: "Europe/Moscow", VKO: "Europe/Moscow", LED: "Europe/Moscow",
  KBP: "Europe/Kiev", IEV: "Europe/Kiev", LWO: "Europe/Kiev",
  MSQ: "Europe/Minsk", RIX: "Europe/Riga", TLL: "Europe/Tallinn", VNO: "Europe/Vilnius",
  ZAG: "Europe/Zagreb", SPU: "Europe/Zagreb", DBV: "Europe/Zagreb",
  LJU: "Europe/Ljubljana", BEG: "Europe/Belgrade", SKP: "Europe/Skopje", TIA: "Europe/Tirane",
  SJJ: "Europe/Sarajevo", TGD: "Europe/Podgorica", TIV: "Europe/Podgorica",

  // North America - USA
  ATL: "America/New_York", JFK: "America/New_York", LGA: "America/New_York", EWR: "America/New_York",
  BOS: "America/New_York", PHL: "America/New_York", DCA: "America/New_York", IAD: "America/New_York",
  BWI: "America/New_York", CLT: "America/New_York", MIA: "America/New_York", FLL: "America/New_York",
  MCO: "America/New_York", TPA: "America/New_York", JAX: "America/New_York", RDU: "America/New_York",
  BNA: "America/Chicago", DTW: "America/New_York", CLE: "America/New_York", PIT: "America/New_York",
  CMH: "America/New_York", IND: "America/New_York", CVG: "America/New_York", MSY: "America/Chicago",
  ORD: "America/Chicago", MDW: "America/Chicago", MSP: "America/Chicago", MCI: "America/Chicago",
  STL: "America/Chicago", MEM: "America/Chicago", DFW: "America/Chicago", DAL: "America/Chicago",
  IAH: "America/Chicago", HOU: "America/Chicago", AUS: "America/Chicago", SAT: "America/Chicago",
  OKC: "America/Chicago", TUL: "America/Chicago", DEN: "America/Denver", SLC: "America/Denver",
  ABQ: "America/Denver", PHX: "America/Phoenix", TUS: "America/Phoenix", LAS: "America/Los_Angeles",
  LAX: "America/Los_Angeles", SFO: "America/Los_Angeles", SJC: "America/Los_Angeles", OAK: "America/Los_Angeles",
  SAN: "America/Los_Angeles", SMF: "America/Los_Angeles", BUR: "America/Los_Angeles", ONT: "America/Los_Angeles",
  SNA: "America/Los_Angeles", LGB: "America/Los_Angeles", PDX: "America/Los_Angeles", SEA: "America/Los_Angeles",
  ANC: "America/Anchorage", HNL: "Pacific/Honolulu", OGG: "Pacific/Honolulu", KOA: "Pacific/Honolulu",

  // North America - Canada
  YYZ: "America/Toronto", YTZ: "America/Toronto", YOW: "America/Toronto", YUL: "America/Toronto",
  YQB: "America/Toronto", YHZ: "America/Halifax", YYT: "America/St_Johns",
  YWG: "America/Winnipeg", YYC: "America/Edmonton", YEG: "America/Edmonton",
  YVR: "America/Vancouver", YXE: "America/Regina", YQR: "America/Regina",

  // Mexico & Central America
  MEX: "America/Mexico_City", CUN: "America/Cancun", GDL: "America/Mexico_City", MTY: "America/Monterrey",
  PVR: "America/Mexico_City", SJD: "America/Mazatlan", TIJ: "America/Tijuana",
  PTY: "America/Panama", SJO: "America/Costa_Rica", LIR: "America/Costa_Rica",
  GUA: "America/Guatemala", SAL: "America/El_Salvador", TGU: "America/Tegucigalpa",
  MGA: "America/Managua", HAV: "America/Havana", SDQ: "America/Santo_Domingo",
  SJU: "America/Puerto_Rico", NAS: "America/Nassau",

  // South America
  GRU: "America/Sao_Paulo", CGH: "America/Sao_Paulo", GIG: "America/Sao_Paulo", SDU: "America/Sao_Paulo",
  BSB: "America/Sao_Paulo", CNF: "America/Sao_Paulo", SSA: "America/Bahia", REC: "America/Recife",
  FOR: "America/Fortaleza", POA: "America/Sao_Paulo", CWB: "America/Sao_Paulo", MAO: "America/Manaus",
  EZE: "America/Argentina/Buenos_Aires", AEP: "America/Argentina/Buenos_Aires",
  SCL: "America/Santiago", LIM: "America/Lima", BOG: "America/Bogota", MDE: "America/Bogota", CTG: "America/Bogota",
  UIO: "America/Guayaquil", GYE: "America/Guayaquil", CCS: "America/Caracas", MVD: "America/Montevideo",
  ASU: "America/Asuncion", LPB: "America/La_Paz",

  // Middle East
  DXB: "Asia/Dubai", DWC: "Asia/Dubai", AUH: "Asia/Dubai", SHJ: "Asia/Dubai",
  DOH: "Asia/Qatar", BAH: "Asia/Bahrain", KWI: "Asia/Kuwait", MCT: "Asia/Muscat", RUH: "Asia/Riyadh",
  JED: "Asia/Riyadh", DMM: "Asia/Riyadh", MED: "Asia/Riyadh",
  TLV: "Asia/Jerusalem", AMM: "Asia/Amman", BEY: "Asia/Beirut", DAM: "Asia/Damascus",
  BGW: "Asia/Baghdad", IKA: "Asia/Tehran", THR: "Asia/Tehran", EVN: "Asia/Yerevan", GYD: "Asia/Baku",
  TBS: "Asia/Tbilisi",

  // Africa
  CAI: "Africa/Cairo", HRG: "Africa/Cairo", SSH: "Africa/Cairo", LXR: "Africa/Cairo",
  JNB: "Africa/Johannesburg", CPT: "Africa/Johannesburg", DUR: "Africa/Johannesburg",
  NBO: "Africa/Nairobi", MBA: "Africa/Nairobi", DAR: "Africa/Dar_es_Salaam", KGL: "Africa/Kigali",
  ADD: "Africa/Addis_Ababa", LOS: "Africa/Lagos", ABV: "Africa/Lagos", ACC: "Africa/Accra",
  DKR: "Africa/Dakar", CMN: "Africa/Casablanca", RAK: "Africa/Casablanca", AGA: "Africa/Casablanca",
  TUN: "Africa/Tunis", ALG: "Africa/Algiers", TRP: "Africa/Tripoli",

  // Asia - East
  HND: "Asia/Tokyo", NRT: "Asia/Tokyo", KIX: "Asia/Tokyo", ITM: "Asia/Tokyo", NGO: "Asia/Tokyo",
  FUK: "Asia/Tokyo", CTS: "Asia/Tokyo", OKA: "Asia/Tokyo",
  ICN: "Asia/Seoul", GMP: "Asia/Seoul", PUS: "Asia/Seoul", CJU: "Asia/Seoul",
  PEK: "Asia/Shanghai", PKX: "Asia/Shanghai", PVG: "Asia/Shanghai", SHA: "Asia/Shanghai",
  CAN: "Asia/Shanghai", SZX: "Asia/Shanghai", CTU: "Asia/Shanghai", CKG: "Asia/Shanghai", XIY: "Asia/Shanghai",
  KMG: "Asia/Shanghai", HGH: "Asia/Shanghai", NKG: "Asia/Shanghai", WUH: "Asia/Shanghai", CSX: "Asia/Shanghai",
  TPE: "Asia/Taipei", TSA: "Asia/Taipei", KHH: "Asia/Taipei",
  HKG: "Asia/Hong_Kong", MFM: "Asia/Macau",
  ULN: "Asia/Ulaanbaatar",

  // Asia - Southeast
  SIN: "Asia/Singapore", KUL: "Asia/Kuala_Lumpur", PEN: "Asia/Kuala_Lumpur", BKI: "Asia/Kuala_Lumpur",
  BKK: "Asia/Bangkok", DMK: "Asia/Bangkok", HKT: "Asia/Bangkok", CNX: "Asia/Bangkok", USM: "Asia/Bangkok",
  CGK: "Asia/Jakarta", DPS: "Asia/Makassar", SUB: "Asia/Jakarta", KNO: "Asia/Jakarta",
  MNL: "Asia/Manila", CEB: "Asia/Manila", DVO: "Asia/Manila",
  SGN: "Asia/Ho_Chi_Minh", HAN: "Asia/Ho_Chi_Minh", DAD: "Asia/Ho_Chi_Minh", CXR: "Asia/Ho_Chi_Minh",
  PNH: "Asia/Phnom_Penh", REP: "Asia/Phnom_Penh", VTE: "Asia/Vientiane",
  RGN: "Asia/Yangon", MDL: "Asia/Yangon",

  // Asia - South
  DEL: "Asia/Kolkata", BOM: "Asia/Kolkata", BLR: "Asia/Kolkata", MAA: "Asia/Kolkata", CCU: "Asia/Kolkata",
  HYD: "Asia/Kolkata", COK: "Asia/Kolkata", AMD: "Asia/Kolkata", GOI: "Asia/Kolkata", PNQ: "Asia/Kolkata",
  KTM: "Asia/Kathmandu", CMB: "Asia/Colombo", MLE: "Indian/Maldives", DAC: "Asia/Dhaka",
  ISB: "Asia/Karachi", KHI: "Asia/Karachi", LHE: "Asia/Karachi", PEW: "Asia/Karachi",
  KBL: "Asia/Kabul", TAS: "Asia/Tashkent", ALA: "Asia/Almaty", TSE: "Asia/Almaty",

  // Oceania
  SYD: "Australia/Sydney", MEL: "Australia/Melbourne", BNE: "Australia/Brisbane", PER: "Australia/Perth",
  ADL: "Australia/Adelaide", CBR: "Australia/Sydney", OOL: "Australia/Brisbane", CNS: "Australia/Brisbane",
  HBA: "Australia/Hobart", DRW: "Australia/Darwin",
  AKL: "Pacific/Auckland", WLG: "Pacific/Auckland", CHC: "Pacific/Auckland", ZQN: "Pacific/Auckland",
  NAN: "Pacific/Fiji", PPT: "Pacific/Tahiti", NOU: "Pacific/Noumea", APW: "Pacific/Apia",
};

export function getAirportTimezone(iata: string | undefined | null): string | null {
  if (!iata) return null;
  return AIRPORT_TZ[iata.toUpperCase()] ?? null;
}
