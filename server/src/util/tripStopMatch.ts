/**
 * Welcher Halt einer Fahrt ist mit einem NAMEN gemeint?
 *
 * Gebraucht vom Fahrt-Detail (routes/trips.ts): Die Abfahrtstafel nennt eine
 * Richtung („Werl, Bf."), der Nutzer steht an einer Haltestelle mit eigenem
 * Namen — beides muss auf einen Halt der Fahrt zeigen, deren Namen aus einer
 * anderen Quelle stammen (MOTIS, HAFAS, Länder-Fahrplan).
 *
 * DER FEHLER, DEN DAS HIER BEHEBT: Gezählt wurden übereinstimmende Wörter, und
 * bei einem Wort reichte eines. „Werl, Bf." zerfiel zu {werl} — „Bf" ist zu
 * kurz und fiel weg —, und der ERSTE Halt mit „Werl" im Namen gewann: „Werl,
 * Rostocker Weg", eine Minute nach dem Einstieg. Die Fahrt endete dort, die
 * Karte zeichnete eine Minute Bus, und der Kopf nannte den Halt „Werl, Bf.".
 * Die Linie 522 fährt in Wahrheit noch sechs Halte weiter. Jede Stadtbus-
 * Richtung der Form „<Ort>, <Halt>" konnte so am ersten Halt der Stadt enden.
 *
 * Darum jetzt zwei Bedingungen:
 *   1. ALLE Kernwörter des Namens stehen im Halt — nicht bloß eines.
 *   2. Genau EIN Halt der Fahrt erfüllt das. Trägt jeder zweite Halt den
 *      Ortsnamen, meint „Werl" keinen davon. Mehrdeutig heißt: kein Treffer —
 *      dann zeigt das Detail die ganze Fahrt bis zum echten Endhalt, statt
 *      mitten in der Stadt abzubrechen.
 * Allgemeine Wörter (Bahnhof, Straße, Platz …) zählen nur zum Auseinander-
 * halten mehrerer Kandidaten, nie allein.
 */

/**
 * Schreibweisen einer Sache auf EINE. Städte: englisch in unseren GTFS-Namen,
 * deutsch in HAFAS/MOTIS („Munich Chiemgaustraße" ↔ „München, Chiemgaustraße").
 * „Hauptbahnhof" → „hbf": „Berlin Hbf" und „Berlin Hauptbahnhof" sind derselbe
 * Halt — und „Hbf" unterscheidet (Berlin Hbf ≠ Berlin Mahlsdorf), anders als
 * ein bloßer „Bahnhof". „Bf"/„Bhf" sind Kurzformen von Bahnhof und galten
 * vorher gar nicht („bf" zu kurz) oder als eigenes Wort („bhf").
 */
const ALIASES: Record<string, string> = {
  munich: "münchen",
  cologne: "köln",
  vienna: "wien",
  nuremberg: "nürnberg",
  geneva: "genf",
  zurich: "zürich",
  prague: "prag",
  warsaw: "warschau",
  hauptbahnhof: "hbf",
  bf: "bahnhof",
  bhf: "bahnhof",
  bahnhst: "bahnhof",
  str: "straße",
  strasse: "straße",
};

/**
 * Allgemeine Wörter — zu unscharf, um allein einen Halt zu bestimmen
 * („Gandenitzer Weg, Berlin" ≠ „Tegeler Weg"; „Estación de Autobuses de
 * Sevilla" ≠ „… de Granada"). Akzent-Varianten doppelt, der Tokenizer lässt
 * Diakritika stehen.
 */
const GENERIC = new Set([
  "bahnhof", "bahnsteig", "bahnsteige",
  "station", "stop", "stops", "haltestelle", "halt",
  "gleis", "platform", "platt",
  // DB-/regional-Qualifier („Hamm Westf", „Bad Münster a Stein")
  "westf", "westfalen", "westfälisch",
  "weg", "wege",
  "straße",
  "brücke", "brucke",
  "platz",
  "allee",
  "gasse",
  "ring",
  "ufer",
  "estación", "estacion", "estació", "estacio", "estação", "estacao",
  "autobuses", "autobús", "autobus", "autocares",
  "gare", "routière", "routiere",
  "stazione", "autostazione", "fermata",
  "paragem", "rodoviária", "rodoviaria",
  "dworzec", "przystanek", "nádraží", "nadrazi", "zastávka", "zastavka",
  "calle", "avenida", "avda", "carrer", "avinguda",
  "rue", "avenue", "boulevard",
  "praça", "praca", "plaça", "placa",
]);

export interface StopNameTokens {
  /** Wörter, die einen Halt bestimmen („werl", „hallenser", „hbf"). */
  core: Set<string>;
  /** Allgemeine Wörter („bahnhof", „straße") — nur zum Auseinanderhalten. */
  generic: Set<string>;
}

/**
 * Zerlegt einen Haltnamen. Bindestriche, Schrägstriche, Klammern, Punkte und
 * Kommas trennen („Hamm-Westtünnen" → hamm, westtünnen — sonst fand „Hamm
 * Westtünnen Bahnhof" den Halt nicht). Wörter bis zwei Zeichen fallen weg
 * (S, U, am, an) — außer sie sind ein bekanntes Kürzel („Bf") oder tragen eine
 * Ziffer: „Rivium 1e straat" und „Rivium 4e straat" sind zwei Halte, „Nymburk
 * st. 3" ist nicht „Nymburk hl.n.".
 */
export function stopNameTokens(name: string): StopNameTokens {
  const core = new Set<string>();
  const generic = new Set<string>();
  const cleaned = name.toLowerCase().replace(/[,()./\-]/g, " ").replace(/\s+/g, " ").trim();
  for (const raw of cleaned.split(" ")) {
    const w = ALIASES[raw] ?? raw;
    if (GENERIC.has(w)) generic.add(w);
    else if (w.length > 2 || /\d/.test(w)) core.add(w);
  }
  return { core, generic };
}

const containsAll = (have: Set<string>, want: Set<string>): boolean => {
  for (const w of want) if (!have.has(w)) return false;
  return true;
};

/** Derselbe Halt unter leicht anderer Schreibweise ergibt denselben Schlüssel. */
const stopKey = (t: StopNameTokens): string =>
  `${[...t.core].sort().join(" ")}|${[...t.generic].sort().join(" ")}`;

/**
 * Alle Vorkommen (aufsteigend) des Halts in `names`, den `label` EINDEUTIG
 * meint — leer, wenn keiner oder mehrere verschiedene passen.
 *
 * Eindeutig über die GANZE Fahrt: Eine Ringlinie hält zweimal am selben Halt
 * (gleicher Name → gleicher Schlüssel, zählt einmal); zwei verschiedene Halte,
 * die beide passen, sind dagegen mehrdeutig.
 */
export function matchStopIndices(
  names: ReadonlyArray<string | null | undefined>,
  label: string,
): number[] {
  const want = stopNameTokens(label);
  // Ohne Kernwort nur mit allgemeinen Wörtern („Bahnhof" als Ziel eines
  // Stadtbusses) — dann muss eben genau ein Halt die tragen.
  if (want.core.size === 0 && want.generic.size === 0) return [];

  const keys: Array<string | null> = names.map(() => null);
  const covering = new Map<string, StopNameTokens>();
  names.forEach((name, i) => {
    if (!name) return;
    const t = stopNameTokens(name);
    if (!containsAll(t.core, want.core)) return;
    if (want.core.size === 0 && !containsAll(t.generic, want.generic)) return;
    const key = stopKey(t);
    keys[i] = key;
    covering.set(key, t);
  });

  let chosen: string | null = null;
  if (covering.size === 1) {
    chosen = covering.keys().next().value ?? null;
  } else if (covering.size > 1 && want.generic.size > 0) {
    // Mehrere Halte tragen die Kernwörter (meist: nur den Ortsnamen). Trägt
    // genau einer davon AUCH die allgemeinen Wörter des Namens — „Werl,
    // Bahnhof" unter lauter „Werl, …" —, ist er gemeint.
    const withGeneric = [...covering].filter(([, t]) => containsAll(t.generic, want.generic));
    if (withGeneric.length === 1) chosen = withGeneric[0]![0];
  }
  if (chosen == null) return [];
  const out: number[] = [];
  keys.forEach((k, i) => {
    if (k === chosen) out.push(i);
  });
  return out;
}

const normWords = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['’´`]/g, "")
    .replace(/&/g, " and ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Meinen zwei Haltnamen erkennbar DENSELBEN Halt? Gleich bis auf Schreibweise
 * („Newton Wood Lane" / „Newtonwood Lane"), einer steckt wortweise im anderen
 * („Lindestraat" in „Enschede, Lindestraat"), oder sie teilen ein Wort, das
 * mehr ist als der Ort davor („Heerlen, Heerlerbaan Bautscherweg" ↔ „Heerlen,
 * Bautscherweg"). Nur der Ort gemeinsam reicht nicht: „Vaals, Flats" ist nicht
 * „Vaals, Tentstraat 81".
 *
 * Gebraucht von der Tafel (routes/stops.ts, Hinweis „Zeiten von …") und der
 * Vollprüfung aller Tafeln (scripts/audit-boards.ts) — dieselbe Regel.
 */
export function sameStopByName(a: string, b: string): boolean {
  const x = normWords(a).join(" ");
  const y = normWords(b).join(" ");
  if (!x || !y) return false;
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return true;
  if (x.replace(/ /g, "") === y.replace(/ /g, "")) return true;
  const ta = [...stopNameTokens(a).core];
  const tb = [...stopNameTokens(b).core];
  const lead = new Set([ta[0], tb[0]]);
  return ta.some((w) => !lead.has(w) && tb.includes(w));
}
