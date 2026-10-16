/**
 * Die Hauptflughäfen großer Städte mit MEHREREN Flughäfen — für die
 * Reihenfolge der Ortssuche im Flug-Modus (siehe `hubRank` in
 * services/locationService.ts).
 *
 * OurAirports kennt nur Größenklassen, keine Passagierzahlen, und führt in
 * diesen Städten fast jeden Flughafen als „groß". Die Suche entschied dann
 * über Namensähnlichkeit und Namenslänge: Auf „London" stand Heathrow an
 * dritter Stelle, auf „Paris" Charles de Gaulle hinter Le Bourget (einem
 * Geschäftsflieger-Platz), auf „Moskau" Scheremetjewo ganz hinten.
 *
 * ERSTE Reihe: der größte Flughafen der Stadt. ZWEITE: die übrigen mit
 * nennenswertem Linienverkehr. Alles andere, was auf den Namen passt, folgt
 * danach in der bisherigen Reihenfolge. Die Liste greift nur zwischen gleich
 * guten Treffern — wer „Orly" tippt, bekommt Orly, nicht CDG.
 *
 * Stand: Passagierzahlen 2024/25. Neue Einträge nur für Städte, in denen die
 * Suche sonst sichtbar falsch sortiert.
 */
export const PRIMARY_AIRPORTS: readonly string[] = [
  "LHR", "CDG", "JFK", "SVO", "ORD", "HND", "KIX", "ICN", "PEK", "PVG",
  "MXP", "FCO", "IST", "ARN", "OSL", "IAD", "LAX", "SFO", "IAH", "DFW",
  "MIA", "YYZ", "GRU", "GIG", "EZE", "BKK", "TPE", "DXB", "IKA", "BRU",
  "FRA", "DUS", "VCE", "GLA", "BFS", "WAW", "KEF", "MEX",
];

export const SECONDARY_AIRPORTS: readonly string[] = [
  "LGW", "STN", "LTN", "LCY", "ORY", "EWR", "LGA", "DME", "VKO", "MDW",
  "NRT", "ITM", "GMP", "PKX", "SHA", "LIN", "BGY", "CIA", "SAW", "BMA",
  "NYO", "DCA", "BWI", "HOU", "DAL", "CGH", "SDU", "AEP", "DMK", "TSA",
  "DWC", "THR", "CRL", "YTZ", "NLU", "WMI", "BHD", "RKV",
];
