/**
 * Auf welcher LANDMASSE liegt ein Punkt — für die Frage „kann zwischen zwei
 * Orten überhaupt ein Zug oder Bus fahren?".
 *
 * Gebraucht vom Stadt-Blatt auf der Karte (routes/tripPlan.ts): Tippt man eine
 * Stadt an, wird für Zug, Bus und Flug vorab geprüft, ob die Suche Sinn hat.
 * Europa → Australien ist mit dem Zug nicht zu machen; das soll gar nicht erst
 * gesucht und schon gar nicht als verfügbar angezeigt werden.
 *
 * Die Einteilung ist bewusst GROB und auf der sicheren Seite: Sie verbietet nur,
 * was sicher unmöglich ist (anderer Kontinent, Insel ohne Landverbindung). Ob
 * zwischen zwei Orten derselben Landmasse wirklich etwas fährt, entscheiden die
 * Anbieter — kommt nichts, zeigt das Blatt „keine Verbindung", und zwar ohne
 * erfundene Treffer.
 *
 * Regeln:
 *  • Das Land kommt vom Aufrufer (nächster Flughafen, siehe dort) und bestimmt
 *    den Kontinent. Kontinente sind je eine Region.
 *  • Inselstaaten und Überseegebiete sind je eine EIGENE Region — alles, was hier
 *    nicht ausdrücklich als Festland steht, gilt als Insel.
 *  • Inseln INNERHALB von Festlandstaaten (Mallorca, Kanaren, Sardinien, Irland
 *    samt Nordirland …) stehen als Rechtecke in `ISLANDS` und gehen vor.
 *  • Großbritannien gehört zum europäischen Netz (Kanaltunnel), Sizilien auch
 *    (Eisenbahnfähre in Messina, Intercity bis Palermo).
 *  • Unbekannt heißt NICHT verboten: Lässt sich eine Seite nicht zuordnen, wird
 *    gesucht (`sameLandmass` gibt dann `true`).
 */

export type RegionId = string;

/** Festland je Kontinent — Namen exakt wie in `data/airports.ts` (OurAirports/CLDR). */
const MAINLAND: Record<string, RegionId> = {};
function mainland(region: RegionId, countries: string[]): void {
  for (const c of countries) MAINLAND[c] = region;
}

mainland("EU", [
  "Albania", "Andorra", "Austria", "Belarus", "Belgium", "Bosnia & Herzegovina",
  "Bulgaria", "Croatia", "Czechia", "Czech Republic", "Denmark", "Estonia",
  "Finland", "France", "Germany", "Gibraltar", "Greece", "Hungary", "Italy",
  "Kosovo", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Moldova",
  "Monaco", "Montenegro", "Netherlands", "North Macedonia", "Norway", "Poland",
  "Portugal", "Romania", "Russia", "San Marino", "Serbia", "Slovakia",
  "Slovenia", "Spain", "Sweden", "Switzerland", "Türkiye", "Turkey", "Ukraine",
  "United Kingdom", "Vatican City",
]);
mainland("AS", [
  "Afghanistan", "Armenia", "Azerbaijan", "Bahrain", "Bangladesh", "Bhutan",
  "Cambodia", "China", "Georgia", "Hong Kong SAR China", "India", "Iran", "Iraq",
  "Israel", "Jordan", "Kazakhstan", "Kuwait", "Kyrgyzstan", "Laos", "Lebanon",
  "Macao SAR China", "Malaysia", "Mongolia", "Myanmar (Burma)", "Nepal",
  "North Korea", "Oman", "Pakistan", "Palestinian Territories", "Qatar",
  "Saudi Arabia", "Singapore", "South Korea", "Syria", "Tajikistan", "Thailand",
  "Turkmenistan", "United Arab Emirates", "Uzbekistan", "Vietnam", "Yemen",
]);
mainland("AF", [
  "Algeria", "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi", "Cameroon",
  "Central African Republic", "Chad", "Congo - Brazzaville", "Congo - Kinshasa",
  "Côte d’Ivoire", "Djibouti", "Egypt", "Equatorial Guinea", "Eritrea",
  "Eswatini", "Ethiopia", "Gabon", "Gambia", "Ghana", "Guinea", "Guinea-Bissau",
  "Kenya", "Lesotho", "Liberia", "Libya", "Malawi", "Mali", "Mauritania",
  "Morocco", "Mozambique", "Namibia", "Niger", "Nigeria", "Rwanda", "Senegal",
  "Sierra Leone", "Somalia", "South Africa", "South Sudan", "Sudan", "Tanzania",
  "Togo", "Tunisia", "Uganda", "Western Sahara", "Zambia", "Zimbabwe",
]);
mainland("NA", [
  "Belize", "Canada", "Costa Rica", "El Salvador", "Guatemala", "Honduras",
  "Mexico", "Nicaragua", "Panama", "United States",
]);
mainland("SA", [
  "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Ecuador",
  "French Guiana", "Guyana", "Paraguay", "Peru", "Suriname", "Uruguay",
  "Venezuela",
]);
// Australiens Festland; Tasmanien steht unten als Insel.
mainland("AU", ["Australia"]);

/**
 * Inseln INNERHALB von Festlandstaaten: [West, Süd, Ost, Nord], Grad.
 * Großzügig gezogen, aber so, dass kein Festland hineinragt.
 */
type Box = [number, number, number, number];
const ISLANDS: Array<{ id: RegionId; box: Box; except?: Box }> = [
  // Irland UND Nordirland — eine Insel, ohne Bahnverbindung nach Großbritannien.
  // Die Südspitze von Kintyre (Campbeltown, Schottland) ragt ins Rechteck und
  // ist ausgenommen.
  { id: "IE-ISLAND", box: [-10.8, 51.3, -5.42, 55.4], except: [-5.95, 55.27, -5.2, 55.45] },
  { id: "BALEARES", box: [1.1, 38.6, 4.4, 40.15] },
  { id: "CANARIAS", box: [-18.3, 27.5, -13.2, 29.5] },
  { id: "MADEIRA", box: [-17.4, 32.5, -16.1, 33.2] },
  { id: "ACORES", box: [-31.4, 36.8, -24.8, 39.8] },
  { id: "SARDEGNA", box: [8.0, 38.8, 9.9, 41.35] },
  { id: "CORSE", box: [8.5, 41.3, 9.6, 43.05] },
  { id: "KRITI", box: [23.4, 34.75, 26.4, 35.75] },
  { id: "GOTLAND", box: [17.9, 56.85, 19.4, 58.0] },
  { id: "BORNHOLM", box: [14.6, 54.95, 15.25, 55.35] },
  // Borneo — Sabah/Sarawak gehören zu Malaysia, das Festland liegt auf der Halbinsel.
  { id: "BORNEO", box: [108.5, -4.3, 119.3, 7.4] },
  { id: "TASMANIA", box: [143.5, -43.8, 148.6, -39.4] },
  { id: "HAWAII", box: [-160.8, 18.7, -154.6, 22.5] },
  // Alaska — Straße nach Kanada ja, aber kein Personenzug und kein Linienbus.
  { id: "ALASKA", box: [-180, 51, -141, 72] },
];

/**
 * Region eines Punktes.
 *
 * @param country Land wie in `data/airports.ts`; `null`, wenn unbekannt.
 * @returns `null`, wenn sich nichts sagen lässt — dann wird nicht verboten.
 */
export function landRegion(lat: number, lng: number, country: string | null): RegionId | null {
  const inside = (b: Box) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
  for (const isl of ISLANDS) {
    if (inside(isl.box) && !(isl.except && inside(isl.except))) return isl.id;
  }
  if (!country) return null;
  const region = MAINLAND[country];
  if (region === "EU" && country === "Russia" && lng > 60) return "AS";
  if (region) return region;
  // Alles andere ist Insel oder Überseegebiet: eine Region für sich.
  return `ISLAND:${country}`;
}

/**
 * Hängen zwei Orte auf dem LANDWEG zusammen?
 *
 * `ferryOk` für den Bus: Fernbusse fahren mit der Fähre zwischen Irland und
 * Großbritannien (Dublin–London), Züge nicht.
 */
export function sameLandmass(
  a: RegionId | null,
  b: RegionId | null,
  ferryOk = false,
): boolean {
  if (a === null || b === null) return true;
  if (a === b) return true;
  if (ferryOk) {
    const norm = (r: RegionId) => (r === "IE-ISLAND" ? "EU" : r);
    return norm(a) === norm(b);
  }
  return false;
}
