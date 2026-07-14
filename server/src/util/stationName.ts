/**
 * Stationsnamen vergleichbar machen — EINE Stelle für alle Provider.
 *
 * Jeder Anbieter hat eine eigene Autocomplete/Geocoding-API, und alle haben
 * denselben Fallstrick: Sie liefern nach Relevanz sortierte Treffer, und wenn man
 * blind `results[0]` nimmt, landet man bei einem Ort, den der User nie gemeint
 * hat. Zweimal in derselben Woche passiert:
 *
 *   - MOTIS-Geocoder: „Roma Rom" → erster STOP ist „RE DI ROMA" (U-Bahn Linie A)
 *   - FlixBus-Autocomplete: „Berlin ZOB" → erster Treffer war MANNHEIM ZOB;
 *     die Suche Berlin→München lieferte daraufhin 8 Verbindungen ab Mannheim,
 *     ausgewiesen als die Route des Users.
 *
 * Das ist die gefährlichste Fehlerklasse, die wir haben: Es sieht nicht kaputt
 * aus, es ist einfach falsch. Darum die Regel — ein Treffer zählt nur, wenn sein
 * Name zum gesuchten passt. Lieber kein Ergebnis von einem Provider als ein
 * Ergebnis aus der falschen Stadt.
 */

/** Bahnhofs-Abkürzungen, die dasselbe meinen (als ganzes WORT ersetzen — sonst
 *  würde „Bahnhofstrasse" verstümmelt). */
const STATION_ABBR: Record<string, string> = {
  hbf: "hauptbahnhof",
  hb: "hauptbahnhof",
  bhf: "bahnhof",
  bf: "bahnhof",
};

/**
 * Kleinbuchstaben, Diakritika weg, Abkürzungen aufgelöst, Satzzeichen raus.
 * Die Feeds schreiben denselben Bahnhof mal „Breclav", mal „Břeclav".
 */
export function normStationName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((tok) => STATION_ABBR[tok] ?? tok)
    .join("");
}

/**
 * Passt der Name eines Treffers zum gesuchten Ort?
 *
 * Substring in BEIDE Richtungen: Der Treffer darf präzisieren („Werl" →
 * „Werl Bahnhof", „Zürich Brunau" → „Zürich, Brunau/Mutschellenstr."), aber
 * nicht etwas anderes sein („Berlin ZOB" ↛ „Mannheim ZOB").
 */
export function stationNameCompatible(query: string, candidate?: string | null): boolean {
  if (!candidate) return false;
  const q = normStationName(query);
  const c = normStationName(candidate);
  if (!q || !c) return false;
  return c.includes(q) || q.includes(c);
}

/**
 * Wie {@link stationNameCompatible}, aber toleranter: Es reicht, wenn der
 * ORTSNAME übereinstimmt — für Anbieter, die eigene Stationsbezeichnungen führen
 * („Berlin ZOB" vs. FlixBus' „Berlin central bus station"). Verlangt einen
 * gemeinsamen Wort-Token mit mindestens 4 Zeichen; „Berlin" ↔ „Mannheim" haben
 * keinen, „Berlin ZOB" ↔ „Berlin central bus station" haben „berlin".
 *
 * Kurze Tokens („zob", „bus", „hbf") zählen bewusst NICHT — sonst würde
 * „Berlin ZOB" auf „Mannheim ZOB" matchen, also genau der Fehler, den wir fangen.
 */
const GENERIC_TOKENS = new Set([
  "bahnhof",
  "hauptbahnhof",
  "bus",
  "busbahnhof",
  "central",
  "station",
  "zentral",
  "zentrum",
  "city",
  "airport",
  "flughafen",
  "nord",
  "sued",
  "ost",
  "west",
]);

function placeTokens(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/ß/g, "ss")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t)),
  );
}

export function sameCity(query: string, candidate?: string | null): boolean {
  if (!candidate) return false;
  const a = placeTokens(query);
  const b = placeTokens(candidate);
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (b.has(t)) return true;
  return false;
}
