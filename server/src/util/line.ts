/**
 * Liniennamen aus db-vendo/HAFAS normalisieren.
 *
 * Für viele Regionalzüge liefert DB im Feld `name` NICHT die Linie („RE 12"),
 * sondern die nackte ZUGNUMMER — `{ name: "10025", fahrtNr: "10025",
 * productName: "RE" }`. In der Abfahrtstafel stand dann eine kontextlose „10025",
 * wo der Reisende „RE" erwartet (22 von 144 Abfahrten an Köln Hbf).
 *
 * Die Gattung ist in `productName` da, also setzen wir sie davor: „RE 10025".
 * Das ist DBs eigene Schreibweise für Züge ohne Linienbezeichnung — und bleibt
 * ehrlich: wir erfinden keine Liniennummer, die die Quelle nicht hergibt.
 *
 * Fernverkehr ist nicht betroffen („ICE 915" steht schon so in `name`).
 */
export function lineLabel(line?: {
  name?: string | null;
  productName?: string | null;
  fahrtNr?: string | null;
}): string | undefined {
  const name = line?.name?.trim();
  const product = line?.productName?.trim();

  if (!name) return product || undefined;
  // Rein numerisch = Zugnummer ohne Gattung → Gattung davorsetzen.
  if (/^\d+$/.test(name) && product) return `${product} ${name}`;
  return name;
}
