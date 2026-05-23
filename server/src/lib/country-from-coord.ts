/**
 * Point-in-Polygon-Lookup: ermittelt das Land zu gegebenen lat/lng-Koordinaten.
 * Verwendet vereinfachte Polygone (15–20 Punkte pro Land) für unsere 8 Länder
 * mit dem Schwerpunkt auf akkurater Border-Resolution im westeuropäischen
 * NL/DE/BE/LU-Dreieck (wo Bounding-Boxes wegen gebogenen Grenzen versagen).
 *
 * Genauigkeit: ~5-15 km in Grenzregionen. Ausreichend um Düsseldorf von
 * Maastricht zu unterscheiden, aber nicht um Vaals (DE/NL/BE-Eck) exakt
 * zu klassifizieren — solche Mini-Enklaven werden bewusst nicht modelliert.
 *
 * Rückgabe: Country-Name wie er in der `locations.country`-Spalte erscheint,
 * oder null wenn der Punkt außerhalb aller modellierten Länder liegt.
 */

type Polygon = Array<[number, number]>; // [lng, lat]

/** Ray-Casting-Algorithmus: schneidet eine waagerechte Linie vom Punkt nach
 *  rechts mit jedem Polygon-Edge — ungerade Anzahl von Schnitten = drinnen. */
function pointInPolygon(lng: number, lat: number, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Polygone — clockwise. Vereinfacht auf ~15-20 Vertices pro Land. */
const COUNTRY_POLYGONS: Record<string, Polygon> = {
  Germany: [
    [8.40, 55.05], // Sylt N
    [10.0, 54.80], // SH Ostsee
    [12.5, 54.40], // Mecklenburg coast
    [14.20, 54.10], // PL coast border
    [14.55, 52.34], // Frankfurt(Oder)
    [14.99, 51.15], // Görlitz
    [14.81, 50.78], // CZ NE corner
    [12.40, 50.07], // Cheb
    [13.43, 48.57], // Passau
    [13.05, 47.80], // AT border SE
    [10.20, 47.30], // AT/CH triangle
    [8.80, 47.65], // Bodensee
    [7.59, 47.59], // Basel
    [7.50, 49.00], // FR Rhein
    [6.40, 49.50], // LU/BE border
    [6.00, 50.80], // Aachen
    [6.20, 51.50], // Niederrhein
    [7.05, 52.20], // Twente DE-Seite
    [7.15, 53.30], // Niedersachsen coast
    [8.70, 53.87], // Cuxhaven
    [8.40, 55.05], // back
  ],

  Netherlands: [
    [5.40, 53.50], // Frisia N
    [6.40, 53.40], // Groningen NE
    [7.05, 52.50], // Twente
    [6.40, 51.85], // Achterhoek/Gelderland border
    [6.20, 51.40], // Limburg N
    [5.95, 50.80], // Vaals (S point)
    [5.70, 50.90], // Maastricht
    [4.85, 51.40], // Antwerpen-NL border
    [3.50, 51.40], // Zeeuws-Vlaanderen
    [3.36, 51.50], // Westkapelle
    [4.10, 52.00], // Den Haag coast
    [4.90, 52.70], // Amsterdam coast
    [5.40, 53.50], // back
  ],

  Belgium: [
    [2.55, 51.10], // De Panne (W coast)
    [3.40, 51.40], // Zeebrugge area
    [4.85, 51.40], // Antwerpen
    [5.85, 51.00], // Hasselt-Maaseik
    [5.95, 50.80], // Vaals
    [6.40, 50.32], // Eupen
    [6.30, 49.80], // Belgisch-LU border
    [5.78, 49.55], // LU triangle
    [4.85, 49.80], // FR border (Sedan)
    [3.65, 50.50], // Tournai
    [2.55, 50.70], // Comines (FR border)
    [2.55, 51.10], // back
  ],

  France: [
    // Stark vereinfachtes Continental France (ohne Bretagne-Detail, ohne Korsika)
    [2.50, 51.00], // Dunkirk
    [3.50, 50.50], // BE border (Lille)
    [4.85, 49.80], // BE/LU border (Sedan)
    [6.20, 49.50], // LU border S
    [7.00, 49.20], // DE Saar border
    [7.85, 49.00], // DE Rhein border
    [7.50, 47.50], // CH/Basel border
    [6.80, 46.30], // CH border (Geneva)
    [7.00, 45.00], // IT border (Mont Blanc)
    [7.50, 43.80], // IT/Monaco
    [4.50, 43.40], // Marseille coast
    [3.00, 42.40], // Pyrenees coast E
    [-1.50, 43.30], // Pyrenees W (San Sebastián border)
    [-1.80, 46.50], // Atlantic west
    [-4.50, 48.20], // Brest
    [-1.50, 49.20], // Cherbourg
    [1.50, 50.90], // Calais area
    [2.50, 51.00], // back
  ],

  Switzerland: [
    [6.05, 47.50], // FR Jura NW
    [7.00, 47.50], // FR Jura NE
    [8.60, 47.80], // DE border (Bodensee)
    [9.50, 47.65], // AT St. Margrethen
    [10.45, 46.85], // AT Grisons
    [10.10, 46.50], // IT Stelvio
    [8.85, 46.00], // IT Ticino S
    [8.60, 45.85], // Lugano
    [7.00, 45.85], // IT Aosta
    [6.80, 46.40], // FR Geneva
    [6.05, 47.50], // back
  ],

  Austria: [
    [9.55, 47.55], // CH/Vorarlberg
    [10.45, 47.55], // DE Tirol N
    [12.50, 47.70], // DE Salzburg N
    [13.05, 47.80], // DE Innviertel
    [13.65, 48.55], // DE Passau
    [16.95, 48.85], // CZ Lower Austria
    [17.16, 48.40], // SK Bratislava
    [16.75, 47.65], // HU Burgenland S
    [16.30, 46.70], // SI border
    [13.70, 46.50], // IT Tirol S
    [12.20, 46.85], // IT Carnic Alps
    [10.45, 46.85], // CH Grisons
    [9.55, 47.55], // back
  ],

  "Czech Republic": [
    [12.10, 50.10], // DE Selb
    [12.40, 50.30], // DE Cheb N
    [13.00, 50.60], // DE Erzgebirge
    [14.95, 51.05], // DE/PL NE corner
    [16.20, 50.65], // PL N
    [16.95, 50.20], // PL/CZ pulse
    [18.85, 49.50], // PL/SK Ostrava
    [18.50, 49.10], // SK W
    [17.00, 48.60], // SK Břeclav
    [15.00, 48.65], // AT Wien-Süd
    [13.65, 48.65], // AT Passau
    [12.50, 49.50], // DE Furth im Wald
    [12.10, 50.10], // back
  ],

  Poland: [
    [14.15, 54.00], // DE Stettin (Szczecin)
    [16.50, 54.50], // Pommern N
    [19.50, 54.85], // Gdańsk
    [22.50, 54.40], // Kaliningrad border
    [23.50, 53.95], // BY border N
    [24.15, 52.30], // BY mid
    [23.85, 51.10], // UA border
    [22.85, 49.45], // UA SE corner
    [20.10, 49.18], // SK Tatry
    [19.20, 49.40], // SK W
    [18.50, 49.50], // SK CZ corner
    [17.00, 50.20], // CZ Opole
    [14.85, 50.85], // CZ Lausitz
    [14.95, 51.05], // DE Görlitz
    [14.65, 53.55], // DE Vorpommern
    [14.15, 54.00], // back
  ],
};

const COUNTRY_LIST = Object.entries(COUNTRY_POLYGONS);

/**
 * Findet das Land zu (lat, lng). Iteriert über alle Polygone — Performance
 * ist gut genug für ~250k Stops in einem Bulk-Lauf (ms pro Lookup).
 *
 * Gibt den Country-Namen zurück (passend zu `locations.country`-Werten),
 * oder null wenn der Punkt außerhalb aller modellierten Länder liegt.
 */
export function countryFromCoord(lat: number, lng: number): string | null {
  for (const [country, polygon] of COUNTRY_LIST) {
    if (pointInPolygon(lng, lat, polygon)) return country;
  }
  return null;
}
