/**
 * Haltestellennamen ohne Zusätze — die REINEN Regeln, ohne Datenbank.
 *
 * Ein Quellname trägt oft mehr als den Namen: Ort davor („Oldham, …"),
 * Straße und Seite („Rochdale Road / opposite …"), Halt-Buchstabe
 * („(Stop RA)"), Fahrtrichtung („, Richtung Calbe", „(N Bound)"), Steig oder
 * Mastnummer („(Quai 3)", „Metro Politechnika 02"). Diese Funktionen trennen
 * das ab und geben die abgetrennten Teile mit — daraus wird der dezente
 * Zusatz, wo zwei gleichnamige Halte nebeneinander stehen.
 *
 * Hier und nicht unter scripts/, weil auch der Server sie braucht: Die
 * Zeitleiste einer britischen Fahrt zeigt die Namen aus dem Fahrplan, und die
 * sollen so heißen wie der Kopf des Halt-Blatts (`timetableStopName`).
 * Die Entscheidung je Halt (Fahrplan-Zwilling, Zusatz bei Nachbarn) steht in
 * scripts/lib/stopNames.ts.
 */

/** Ergebnis einer Bereinigung: der Name und die abgetrennten Teile (für den Zusatz). */
export interface SplitName {
  name: string;
  parts: string[];
}

/**
 * Rohname aufräumen: Leerraum zusammenfassen, Satzzeichen-Reste vorn
 * („- Seilh", „/ Gummerup") und hinten („Pécsely,") weg. Bindestrich und
 * Schrägstrich HINTEN bleiben — „Knetzgau Hauptstr. -17-" und
 * „Podmaleniec /górka/" heißen so.
 */
function tidyRaw(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:/–-]+\s*/, "")
    .replace(/\s*[,;:]+$/, "")
    .trim();
}

/** Rest nach dem Abtrennen eines Zusatzes: Trenner an der Schnittstelle weg. */
function cutEnd(s: string): string {
  return s.replace(/[\s,;:/–-]+$/, "").trim();
}
function cutStart(s: string): string {
  return s.replace(/^[\s,;:/–-]+/, "").trim();
}
function cleanPart(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,;:/–-]+|[\s,;:/–-]+$/g, "").trim();
}

/** Genug übrig, um ein Name zu sein? Mindestens zwei Buchstaben. */
function usable(s: string): boolean {
  return (s.match(/\p{L}/gu) ?? []).length >= 2;
}

/**
 * Gleich viele öffnende wie schließende Klammern? Ein Schnitt mitten in einer
 * Klammer ließ „Cavedine nord Via Capitello (" stehen (aus „… ( dir. Trento)").
 */
function balanced(s: string): boolean {
  return (s.match(/\(/g) ?? []).length === (s.match(/\)/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Großbritannien
// ---------------------------------------------------------------------------
const BEARING = "(?:north|south|east|west|n|s|e|w|ne|nw|se|sw|north[- ]?east|north[- ]?west|south[- ]?east|south[- ]?west)";
const SIDE_WORD = "(?:opp|opposite|o\\/s|outside|adj|adjacent|nr|near)";
/** Vorn am Namen ohne „near": „Near Sawrey" ist ein Dorf in Cumbria. */
const SIDE_WORD_LEAD = "(?:opp|opposite|o\\/s|outside|adj|adjacent)";

/** Zusätze in Klammern am Ende — NaPTAN-„Indicator", Postbezirk, Halt-Buchstabe. */
const GB_PAREN_TAIL: RegExp[] = [
  /\s*\(((?:stop|stand|stance|bay|platform)\s*[a-z0-9]{1,4})\)$/i, // (Stop RA), (Stand 5)
  new RegExp(`\\s*\\((${BEARING}[ -]?bound)\\)$`, "i"), // (NW-bound), (West Bound)
  new RegExp(`\\s*\\((${BEARING})\\)$`, "i"), // (NE)
  new RegExp(`\\s*\\((${SIDE_WORD}|by|before|after|at|cnr|corner)\\.?\\)$`, "i"), // (o/s)
  /\s*\(([A-Z]{1,2}\d[A-Z\d]?)\)$/, // (EN3) — Postbezirk, mit dem TfL gleichnamige Halte trennt
  /\s*\(([A-Z]{1,2}|[A-Z]\d{1,2}|\d{1,2})\)$/, // (A), (RA), (E1), (3) — Halt-Buchstabe / Steig
];

/** Dieselben Zusätze ohne Klammern am Ende („High Street Stand E", „…-N/B"). */
const GB_PLAIN_TAIL: RegExp[] = [
  /[\s-]+((?:stop|stand|stance|bay)\s+[a-z0-9]{1,3})$/i,
  // „Merthyr Bus Station 8" — Steig eines Busbahnhofs ohne „Stand" (Fahrplan)
  /(?<=\b(?:bus station|bus stn|coach station|interchange|bus park|terminus))\s+(\d{1,2}[a-z]?|[a-z]\d?)$/i,
  new RegExp(`[\\s-]+(${BEARING}[ -]?bound)$`, "i"),
  /[\s-]+((?:[nsew]|ne|nw|se|sw)\/b)$/i,
  /,?\s+((?:opp|o\/s|adj|nr)\.?)$/i,
];

const GB_LEAD = new RegExp(`^(${SIDE_WORD_LEAD}|${BEARING}[ -]?bound)\\.?\\s+(?=\\S)`, "i");
/** Im Wahrzeichen-Teil („/ near Lower Hillgate") ist auch „near" nur die Lage. */
const GB_LANDMARK_LEAD = new RegExp(`^(${SIDE_WORD}|${BEARING}[ -]?bound)\\.?\\s+(?=\\S)`, "i");

/** Netz-Zusatz an Tram-/Metro-Halten im Fahrplan („Simonside (Tyne and Wear Metro Station)"). */
const GB_NETWORK_TAIL = /\s*\(([^()]*(?:metro|metrolink|tramway|trams?|underground|dlr|subway)[^()]*)\)$/i;

/**
 * Nichtssagend ohne Ort — „Bus Station" gibt es in jeder Stadt. Solche Namen
 * behalten den Ort davor (wie `import-gb-missing-stops.ts` sie anlegt).
 */
export const GB_GENERIC =
  /^(bus station|bus stn|coach station|rail station|railway station|station|interchange|bus interchange|stand|stop|bay|terminus|village hall|church|post office|school|the green|village|bus bay|bus stop|bus shelter|shelter|lay-?by|lay by|alighting (?:stand|stop|point))$/i;

/** Nur eine Fahrtrichtung („S-bound", „Eastbound") — so heißen manche NaPTAN-Halte. */
const GB_BEARING_ONLY = new RegExp(`^${BEARING}[ -]?bound$`, "i");

/**
 * Nichtssagend, auch mit Klammer-Zusatz dahinter („Bus Station (Ken)"). Ebenso
 * kein Name: eine bloße Straßennummer („A701", „M53" — unter zwei Buchstaben),
 * eine bloße Fahrtrichtung („S-bound") und ein Bruchstück mit offener Klammer
 * („)Bear Way" aus dem NaPTAN-Namen „(Desbro') )Bear Way"). Als Fahrplan-Zwilling
 * hatten solche Namen „Brimstage Road/M53" zu „M53" und „Fleet Services" zu
 * „Eastbound" gemacht.
 */
export function gbGenericOrIndicator(name: string): boolean {
  const base = name.replace(/\s*\([^()]*\)$/, "");
  return (
    GB_GENERIC.test(base) ||
    GB_INDICATOR_ONLY.test(base) ||
    GB_BEARING_ONLY.test(base) ||
    !usable(base) ||
    !balanced(base)
  );
}

/** Nur ein Zusatz, kein Name („Stance A" heißt ein Fahrplan-Halt in Stirling). */
export const GB_INDICATOR_ONLY = /^(?:stop|stand|stance|bay|platform)\s*[a-z0-9]{0,4}$/i;

const BEARING_FULL: Record<string, string> = {
  n: "northbound", north: "northbound",
  s: "southbound", south: "southbound",
  e: "eastbound", east: "eastbound",
  w: "westbound", west: "westbound",
};
const BEARING_SHORT: Record<string, string> = {
  ne: "NE", northeast: "NE", nw: "NW", northwest: "NW",
  se: "SE", southeast: "SE", sw: "SW", southwest: "SW",
};

/** Fahrtrichtung einheitlich: „N/B", „N bound", „(N)" → „northbound"; „NE" → „NE-bound". */
function gbBearing(raw: string): string | null {
  const m = /^(north[- ]?east|north[- ]?west|south[- ]?east|south[- ]?west|north|south|east|west|ne|nw|se|sw|n|s|e|w)(?:[ -]?bound|\/b)?$/i.exec(raw.trim());
  if (!m) return null;
  const d = m[1]!.toLowerCase().replace(/[- ]/g, "");
  const short = BEARING_SHORT[d];
  return short ? `${short}-bound` : (BEARING_FULL[d] ?? null);
}

/**
 * Indikator-Kürzel, wie sie im Zusatz stehen sollen. Eine Fahrtrichtung nur,
 * wenn die Quelle sie AUSDRÜCKLICH so nennt („N/B", „N bound") — ein blankes
 * „(E)" kann in London genauso gut Halt E sein.
 */
function gbPart(raw: string): string {
  const p = cleanPart(raw);
  if (/bound$|\/b$|^(north|south|east|west)$/i.test(p)) {
    const bearing = gbBearing(p);
    if (bearing) return bearing;
  }
  const low = p.toLowerCase().replace(/\.$/, "");
  const map: Record<string, string> = {
    opp: "opposite",
    opposite: "opposite",
    "o/s": "outside",
    outside: "outside",
    adj: "adjacent",
    adjacent: "adjacent",
    nr: "near",
    near: "near",
    cnr: "corner",
    corner: "corner",
  };
  return map[low] ?? p;
}

/**
 * Britischen Namen bereinigen.
 *
 * `fromOsm`: Nur OSM-Namen tragen die Greater-Manchester-Form
 * „Ort, Straße / Wahrzeichen (Stop XY)" — dort ist das Wahrzeichen der
 * NaPTAN-Name (am Fahrplan geprüft: „Oldham College", „Lower Hillgate",
 * „Oakenclough Childrens Centre"). Ohne Ortsvorsatz („New Rd / High St",
 * West Midlands) ist das NICHT so — dort heißt der Halt im Fahrplan oft ganz
 * anders, und die Quelle bleibt.
 */
export function splitGbName(raw: string, opts: { city?: string | null; fromOsm?: boolean; train?: boolean } = {}): SplitName {
  let name = tidyRaw(raw);
  const parts: string[] = [];
  // „(Corby) George Street Stop E" — Ort in Klammern vorn.
  const leadParen = /^\(([^()]+)\)\s+(.+)$/.exec(name);
  if (leadParen) name = cutStart(leadParen[2]!);

  if (opts.train) {
    const net = GB_NETWORK_TAIL.exec(name);
    if (net && usable(name.slice(0, net.index))) name = cutEnd(name.slice(0, net.index));
    return { name, parts };
  }

  for (let changed = true; changed; ) {
    changed = false;
    for (const re of [...GB_PAREN_TAIL, ...GB_PLAIN_TAIL]) {
      const m = re.exec(name);
      if (!m || !usable(name.slice(0, m.index))) continue;
      // Steig ohne Wort davor („Merthyr Bus Station 8") → „Stand 8"
      const bare = re.source.startsWith("(?<=");
      parts.unshift(bare ? `Stand ${m[1]!.toUpperCase()}` : gbPart(m[1]!));
      name = cutEnd(name.slice(0, m.index));
      changed = true;
    }
  }
  const lead = GB_LEAD.exec(name);
  if (lead && usable(name.slice(lead[0].length))) {
    parts.unshift(gbPart(lead[1]!));
    name = cutStart(name.slice(lead[0].length));
  }

  // „Oldham, Rochdale Road / Oldham College"
  const tfgm = opts.fromOsm ? /^([^,/()]+),\s*([^,/()]+?)\s*\/\s*(.+)$/.exec(name) : null;
  if (tfgm) {
    const locality = cleanPart(tfgm[1]!);
    const street = cleanPart(tfgm[2]!);
    let landmark = cleanPart(tfgm[3]!);
    const side = GB_LANDMARK_LEAD.exec(landmark);
    const sidePart = side && usable(landmark.slice(side[0].length)) ? gbPart(side[1]!) : null;
    if (sidePart) landmark = cutStart(landmark.slice(side![0].length));
    if (usable(landmark)) {
      parts.unshift(...[street, sidePart].filter((p): p is string => !!p));
      name = GB_GENERIC.test(landmark) ? `${locality} ${landmark}` : landmark;
      return { name, parts };
    }
  }

  // „Ashton-on-Ribble opp Swansea Street" (Lancashire, Schottland): Ort bzw.
  // Straße, Seite, dann der NaPTAN-Name — am Fahrplan geprüft („Swansea
  // Street", „Tarbert Crescent", „Burrow Road"). Ohne „near"/„by": Die kommen
  // in Ortsnamen vor.
  const mid = opts.fromOsm
    ? /^([^,/()]+?)\s+(opp|opposite|o\/s|outside|adj|adjacent)\.?\s+([^,/()]+)$/i.exec(name)
    : null;
  if (mid && usable(mid[1]!) && usable(mid[3]!)) {
    const before = cleanPart(mid[1]!);
    const landmark = cleanPart(mid[3]!);
    parts.unshift(before, gbPart(mid[2]!));
    name = GB_GENERIC.test(landmark) ? `${before} ${landmark}` : landmark;
    return { name, parts };
  }

  // „Calbourne, Sun Inn" — der Ort davor, wenn er die Stadt des Halts ist.
  const city = opts.city?.trim();
  if (city && name.toLowerCase().startsWith(`${city.toLowerCase()}, `)) {
    const rest = cutStart(name.slice(city.length + 2));
    if (usable(rest) && !GB_GENERIC.test(rest)) {
      name = rest;
      // „Redford, opp Bus Shelter" — erst nach dem Ort kommt die Seite zum Vorschein.
      const lead2 = GB_LEAD.exec(name);
      if (lead2 && usable(name.slice(lead2[0].length))) {
        parts.unshift(gbPart(lead2[1]!));
        name = cutStart(name.slice(lead2[0].length));
      }
    }
  }
  // „Bus Station (Stand 7)" in Morecambe: Ohne den Steig bliebe nur „Bus
  // Station" — dann mit Ort, wie `import-gb-missing-stops.ts` solche Namen anlegt.
  if (city && parts.length > 0 && GB_GENERIC.test(name)) name = `${city} ${name}`;
  return { name, parts };
}

// ---------------------------------------------------------------------------
// Alle anderen Länder
// ---------------------------------------------------------------------------
const DIR_WORD =
  "(?:richtung|ri\\.|dir\\.?|direcci[oó]n?|direction|sentido|retning|riktning|richting|směr|smer|kierunek|kier\\.|irány|verso|vers)";

/**
 * Eindeutige Zusätze am Ende eines Namens. Bewusst eng: Nur, was sicher kein
 * Teil des Namens ist. NICHT dabei: Klammern mit Ortsnamen („(Berlin)" im
 * VBB, „(Esbjerg)" in Dänemark, „(Rho)" in Italien) — die trennen dort
 * amtlich gleichnamige Halte und gehören zum Namen.
 */
const GENERIC_TAIL: Array<{ re: RegExp; countries?: string[]; keepPart?: boolean; part?: (p: string) => string }> = [
  // „…, Richtung Calbe" (DE-Fahrplan), „… (Richtung Leuk)", „… (dir. Figueres)"
  { re: /,\s*(Richtung\s+.+)$/i },
  // … auch mit Leerzeichen in der Klammer („Lasino piazza ( dir. sud)")
  { re: new RegExp(`\\s*\\(\\s*(${DIR_WORD}\\s+[^()]+?)\\s*\\)$`, "i") },
  // „… - Direcció Olot", „… - kierunek Albigowa 02", „… - DIR NORD"
  { re: new RegExp(`\\s+[-–]\\s+(${DIR_WORD}\\s+.+)$`, "i") },
  // „Nekoř, u mostu směr Pastviny", „… dir. centro"
  { re: /\s+((?:směr|dir\.)\s+.+)$/i, countries: ["Czech Republic", "Italy"] },
  // Steige und Bahnsteige
  {
    re: /\s*\(((?:steig|bstg\.?|bussteig|gleis|quai|perron|peron|plataforma|and[eé]n|bahnsteig|stanowisko|stan\.|nástupiště|nást\.)\s*[^()]{1,16})\)$/i,
  },
  { re: /\s*\(([A-Z]\d{1,2})\)$/, countries: ["Austria"] }, // „(B1)" — Bussteig
  // Fahrtrichtung in Reggio Calabria („(s/n)", „(n/s)")
  { re: /\s*\(((?:s\/n|n\/s|e\/o|o\/e))\)$/i, countries: ["Italy"] },
  // Mast-/Haltnummer: „Metro Politechnika 02", „Winów-Szkolna (510)"
  { re: /\s+(0[1-9])$/, countries: ["Poland"] },
  { re: /\s*\((\d{1,4})\)$/, countries: ["Poland", "Czech Republic", "Italy", "Spain"] },
  // Niederlande (OVapi): Bahnsteig-Buchstabe und Gleis an Bus-/Tramhalten
  // („Houten, Station Houten (D)", „Den Haag, De Uithof (spoor 2)")
  { re: /\s*\(([A-Z]|spoor\s+\d{1,2})\)$/, countries: ["Netherlands"] },
  { re: /\s*\((uitstaphalte)\)$/i, countries: ["Netherlands"], keepPart: false },
  // Bedarfshalt — kein Unterscheidungsmerkmal, nur weg aus dem Namen
  { re: /\s+(NŻ|nż)$/, countries: ["Poland"], keepPart: false },
  {
    re: /\s*\((nż|na żądanie|z|na znamení|na zn\.)\)$/i,
    countries: ["Poland", "Czech Republic", "Slovakia"],
    keepPart: false,
  },
  // Dasselbe in ECKIGEN Klammern (OSM, nachgezählt Okt. 2026): Bedarfshalt
  // „Strzyżowice Graniczna [nż]" (738 in Polen), Endhalt „Wyścigowa
  // [końcowy]", leere Klammer „[]" (37 in den Niederlanden) — weg aus dem Namen.
  {
    re: /\s*\[(nż|na żądanie|z|na znamení|na zn\.)\]$/i,
    countries: ["Poland", "Czech Republic", "Slovakia"],
    keepPart: false,
  },
  {
    re: /\s*\[(końcowy|terminus|endstelle)\]$/i,
    countries: ["Poland", "France", "Germany", "Austria", "Switzerland"],
    keepPart: false,
  },
  { re: /\s*\[\s*\]$/, keepPart: false },
  // Deutscher Fahrplan: Datenstand-Vermerk („12 Apostel (Oschersleben)
  // [INSA-Version 20250312]") — kein Teil des Namens.
  { re: /\s*\[\s*(INSA-Version[^\]]*)\]$/i, countries: ["Germany"], keepPart: false },
  // … und Hinweise in eckigen Klammern (VBB: „Berlin ZOB [Fernbus]", „Berlin,
  // Haeckelstr. [Ausstieg]", „… [Tram]") — unterscheiden gleichnamige Halte.
  { re: /\s*\[\s*([^[\]]{1,40}?)\s*\]$/, countries: ["Germany"] },
  // RMV (Hessen): Richtung hinter einem Strich, „N" = nach, „V" = von („Bad
  // Hersfeld Ziegelei | NNiederaula"); „| Nxxx" ist ein Platzhalter.
  { re: /\s*\|\s*(N\s*xxx)$/i, countries: ["Germany"], keepPart: false },
  {
    re: /\s*\|\s*([NV]\s*[A-ZÄÖÜ][^|]*)$/,
    countries: ["Germany"],
    part: (p) => `${p[0] === "N" ? "Richtung" : "von"} ${p.slice(1).trim()}`,
  },
  { re: /\s*\|\s*([^|]+)$/, countries: ["Germany"] },
  // … Steige in eckigen Klammern trennen dagegen gleichnamige Halte:
  // „Szent Gellért utca [A]", „Mecseknádasd, Ófalui elágazás [6]" (Ungarn),
  // „Stacja Mława [stan. 2]" (Polen)
  { re: /\s*\[\s*([éÉ]?\d{1,2}|[A-Za-z])\s*\]$/, countries: ["Hungary", "Netherlands", "Italy"] },
  { re: /\s*\[((?:stan\.|st\.|stanowisko)\s*\d{1,2})\]$/i, countries: ["Poland"] },
  // Mast, Steig und Gleis OHNE Klammer am Ende — so führt sie der deutsche
  // Fahrplan: „Wolfsburg Parkplatz Nordwest, Mast 1", „Haselünne Eltern, Dorf
  // Mast2", „Wernigerode Drei Annen Hohne Gleis 2", „Bahnhof, Steig J".
  {
    re: /[,\s]+((?:mast|bussteig|steig|bstg\.?|gleis)\s*(?:\d{1,2}[a-z]?|[A-Z]))$/i,
    countries: ["Germany", "Austria", "Switzerland"],
  },
  // Fahrtrichtung ohne Komma („Lübstorf Richtung Alt Meteln") und als Pfeil
  // („Gräben, Lindenstr. ->W", „Danzmeesterweg->Südheide").
  { re: /\s+(Richtung\s+.+)$/, countries: ["Germany", "Austria", "Switzerland"] },
  {
    re: /\s*(?:->|→)\s*(\S.*)$/,
    countries: ["Germany", "Austria", "Switzerland"],
    part: (p) => `Richtung ${p}`,
  },
  // OVapi-Halte an Bahnhöfen nennen die Richtung klein am Ende („[Purmerend
  // Overwhere] OV halte, Dr. J.M. Den Uyllaan richting Purmerend").
  { re: /\s+(richting\s+[^,()]+)$/, countries: ["Netherlands"] },
  // Ein Strich am Ende ist kein Name („FV Tappino -").
  { re: /\s+([-–])$/, keepPart: false },
];

export function splitGenericName(raw: string, country: string | null): SplitName {
  let name = tidyRaw(raw);
  // OVapi schreibt an rund 760 Bahnhofs-Halten den Ort in eckige Klammern
  // VOR den Namen („[Groningen] busstation", „[Wehl] voorzijde"). Amtlich
  // heißen Halte dort „Ort, Halt" — dieselbe Form wie alle anderen.
  if (country === "Netherlands") name = name.replace(/^\[\s*([^\]]+?)\s*\]\s*(?=\S)/, "$1, ");
  const parts: string[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const rule of GENERIC_TAIL) {
      if (rule.countries && !(country && rule.countries.includes(country))) continue;
      const m = rule.re.exec(name);
      if (!m || !usable(name.slice(0, m.index))) continue;
      // Nie mitten in eine Klammer schneiden: „… (civico 4, dir. Udine)" blieb
      // sonst als „… (civico 4" stehen — dann lieber der Quellname.
      if (balanced(name) && !balanced(name.slice(0, m.index))) continue;
      if (rule.keepPart !== false) parts.unshift(rule.part ? rule.part(cleanPart(m[1]!)) : cleanPart(m[1]!));
      name = cutEnd(name.slice(0, m.index));
      changed = true;
    }
  }
  return { name, parts };
}

/**
 * Name eines Halts in einer Fahrplan-ZEITLEISTE (GTFS), so wie ihn der Kopf des
 * Halt-Blatts zeigt — dieselben Regeln wie für `display_name`. In
 * Großbritannien trägt der Fahrplan (BODS/NaPTAN) Netz-Zusätze („Oldham King
 * Street (Manchester Metrolink)"), Postbezirke („Green Street (EN3)"),
 * Richtungen („(N Bound)") und Steignummern („Merthyr Bus Station 8"); in den
 * Niederlanden Bahnsteig-Buchstaben („Houten, Station Houten (D)"), in
 * Tschechien Steige und Bedarfshalt-Kürzel. Der Name selbst bleibt der des
 * Fahrplans.
 */
export function timetableStopName(country: string | null | undefined, name: string): string {
  if (!name) return name;
  if (country !== "United Kingdom") return splitGenericName(name, country ?? null).name || name;
  const net = GB_NETWORK_TAIL.exec(name);
  const base = net && usable(name.slice(0, net.index)) ? cutEnd(name.slice(0, net.index)) : name;
  const cleaned = splitGbName(base).name;
  return gbGenericOrIndicator(cleaned) ? base : cleaned;
}
