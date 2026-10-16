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
  id?: string | null;
  name?: string | null;
  productName?: string | null;
  fahrtNr?: string | null;
}): string | undefined {
  const name = line?.name?.trim();
  const product = line?.productName?.trim();

  // Rein numerisch = Zugnummer ohne Linie. Zuerst die LINIE aus der Kennung.
  if (name && /^\d+$/.test(name)) {
    const fromId = lineFromId(line?.id, line?.fahrtNr ?? name);
    if (fromId) return fromId;
  }
  if (!name) return product || undefined;
  // Keine Linie in der Kennung → Gattung davorsetzen, wie bisher.
  if (/^\d+$/.test(name) && product) return `${product} ${name}`;
  return name;
}

/**
 * Die Linie aus DBs Kennung — „rb59-90339" ist die RB 59, „re7-17424" die RE 7.
 *
 * Bei Zügen privater Betreiber steht in `productName` NICHT die Gattung,
 * sondern das Kürzel des Betreibers: „ERB" (eurobahn), „NX" (National
 * Express). Aus Zugnummer und Betreiber wurde so „ERB 90339" — gemeldet als
 * „weirde Beschriftung, das wäre die RB59". Die Kennung trägt die Linie aber
 * mit (DB bildet sie aus „RB 59 (90339)"), und das ist dieselbe Bezeichnung,
 * die bahn.de und die Anzeiger am Gleis zeigen.
 *
 * Nur wenn die Kennung wirklich auf DIESE Zugnummer endet — sonst ist es eine
 * andere Bauart der Kennung, und dann lieber die bisherige Beschriftung als
 * eine geratene. Nichts wird erfunden.
 */
function lineFromId(id?: string | null, trainNr?: string | null): string | undefined {
  if (!id || !trainNr) return undefined;
  const m = /^([a-z]{1,4})(\d{1,4}[a-z]?)-(\d+)$/i.exec(id.trim());
  if (!m || m[3] !== trainNr.trim()) return undefined;
  return `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}`;
}
