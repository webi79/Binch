/**
 * Verkehrsarten eines GTFS-Halts — aus import-gtfs.ts herausgelöst, damit der
 * Import der Stationen und der ihrer Steige (gtfsStands.ts) dieselben Regeln
 * benutzen: Linienart (`route_type`) → Unterart (Subtype) → Kategorie (Kind)
 * und Hauptart (TRAIN/BUS).
 */

export type Subtype =
  | "LONG_DISTANCE"
  | "REGIONAL"
  | "SUBURBAN"
  | "SUBWAY"
  | "TRAM"
  | "BUS"
  | "COACH"
  | "FERRY";

/** Frontend-Kategorie zu der ein Subtype gehört — wird im `kinds` Array
 *  gespeichert und steuert welche Icons im Multi-Mode-Marker erscheinen.
 *  Mehrere Subtypes können zur selben Kategorie gehören (RAIL bündelt
 *  Long-Distance + Regional + Suburban). */
export type Kind = "train" | "subway" | "tram" | "bus" | "ferry";

export function subtypeToKind(s: Subtype): Kind {
  switch (s) {
    case "LONG_DISTANCE":
    case "REGIONAL":
    case "SUBURBAN":
      return "train";
    case "SUBWAY": return "subway";
    case "TRAM": return "tram";
    case "BUS":
    case "COACH":
      return "bus";
    case "FERRY": return "ferry";
  }
}

/** Liefert alle Kinds die am Stop signifikant verkehren. Sortiert nach
 *  Häufigkeit absteigend. Frontend rendert die als nebeneinander-Icons in
 *  einer Pille.
 *
 *  Beispiel „Dortmund Barop Parkhaus": SUBWAY 80%, BUS 20% → ["subway","bus"].
 *  Beispiel reine Bushaltestelle: BUS 100% → ["bus"].
 *
 *  Schwellen für Nebenarten:
 *   - BAHN („train") nur deutlich: ≥ 30 % Anteil UND ≥ 100 Fahrten. Sonst
 *     setzten Schienenersatzverkehr und falsch markierte Linien aus gtfs.de
 *     „free" die Bahn an Bushaltestellen (Hamm Münsterische Schiff.-AG: 20–29 %
 *     als Bahn markierte Busfahrten).
 *   - alle anderen (Bus, Tram, U-Bahn, Fähre) schon als Minderheit: ≥ 10 % und
 *     ≥ 50 Fahrten, oder ≥ 300 Fahrten. Mit der Bahn-Schwelle fielen sie weg —
 *     Zürich, Museum Rietberg (Tram 7: 3 931, Bus 161/165: 674 Fahrten = 15 %)
 *     stand nur als Tram da, und die Tafel blendete die Busse aus, weil sie
 *     nur Arten zeigt, die der Halt führt (routes/stops.ts, filterToStopKinds).
 *   - Bus an einem Tramhalt bzw. Tram an einem Bushalt (geteilter Mast) schon
 *     ab 10 Fahrten. Mit der Schwelle davor fehlten die Busse an über tausend
 *     geteilten Masten auf der Tafel (Krefeld Buddestraße: Tram, 32 Busfahrten;
 *     Magdeburg AMO/Steubenallee: 18). Nicht an Bahnhöfen — deren Tafel bekäme
 *     sonst die Busse des Vorplatzes (Köln Hbf ↔ Breslauer Platz). */
export function kindsForStop(types: Map<Subtype, number>): Kind[] {
  const total = Array.from(types.values()).reduce((s, n) => s + n, 0);
  if (total === 0) return ["bus"];

  // Pro Frontend-Kind die Frequenz aufsummieren (RAIL bündelt mehrere Subtypes).
  const kindCounts = new Map<Kind, number>();
  for (const [t, c] of types) {
    const k = subtypeToKind(t);
    kindCounts.set(k, (kindCounts.get(k) ?? 0) + c);
  }

  // Sortieren absteigend nach Frequenz. Mindestens den Top-Kind nehmen.
  const sorted = Array.from(kindCounts.entries()).sort((a, b) => b[1] - a[1]);
  const out: Kind[] = [sorted[0]![0]];
  /** Bus- oder Tramhalt, kein Bahnhof — siehe die dritte Schwelle oben. */
  const surface = out[0] === "bus" || out[0] === "tram";
  for (let i = 1; i < sorted.length; i++) {
    const [k, c] = sorted[i]!;
    const share = c / total;
    const significant =
      k === "train"
        ? share >= 0.3 && c >= 100
        : surface && (k === "bus" || k === "tram")
          ? c >= 10
          : (share >= 0.1 && c >= 50) || c >= 300;
    if (significant) out.push(k);
  }
  return out;
}

/** Wenn an einem Stop mehrere Subtypes auftreten, wählen wir den
 *  „prominentesten" (Fern > Regional > S-Bahn > U-Bahn > Tram > Bus > …).
 *  So zeigt z.B. „Berlin Hbf" mit U-Bahn-Eingang trotzdem als TRAIN. */
const SUBTYPE_PRIORITY: Record<Subtype, number> = {
  LONG_DISTANCE: 100,
  REGIONAL: 90,
  SUBURBAN: 80,
  SUBWAY: 70,
  TRAM: 60,
  COACH: 50,
  FERRY: 40,
  BUS: 30,
};

/** Wählt aus den Subtypes eines Stops den dominanten — gewichtet nach
 *  Frequenz, nicht reiner Priorität. Subtypes mit <20% Anteil werden
 *  ignoriert. So gewinnt an einem Bus-Hub mit 100 Bus-Routen + 1 S-Bahn-Route
 *  nicht mehr S-Bahn → BUS bleibt korrekt klassifiziert. */
export function dominantSubtype(types: Map<Subtype, number>): Subtype {
  const total = Array.from(types.values()).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "BUS";

  // Subtypes mit signifikantem Anteil sammeln (≥30%). Falls keiner so hoch
  // kommt → den absolut häufigsten nehmen. Hohe Schwelle weil sonst
  // Schienenersatzverkehr (~20% rail-Anteil) Buspendel-Stops als TRAIN
  // klassifiziert (User-Bug: Hamm Münsterische Schiff.-AG).
  const significant = new Set<Subtype>();
  for (const [t, c] of types) {
    if (c / total >= 0.3) significant.add(t);
  }

  if (significant.size === 0) {
    let best: Subtype = "BUS";
    let bestCount = -1;
    for (const [t, c] of types) {
      if (c > bestCount) {
        best = t;
        bestCount = c;
      }
    }
    return best;
  }

  // Aus den signifikanten Subtypes: höchste Priorität gewinnt.
  let best: Subtype = "BUS";
  let bestPrio = -1;
  for (const t of significant) {
    const p = SUBTYPE_PRIORITY[t];
    if (p > bestPrio) {
      best = t;
      bestPrio = p;
    }
  }
  return best;
}

/** Hauptkategorie für die DB — TRAIN umfasst alles auf Schienen ohne U-Bahn/Tram. */
export function subtypeToType(s: Subtype): "TRAIN" | "BUS" {
  if (s === "LONG_DISTANCE" || s === "REGIONAL" || s === "SUBURBAN") return "TRAIN";
  return "BUS"; // SUBWAY/TRAM/BUS/COACH/FERRY fallen optisch in BUS-Kategorie,
  // werden aber im Marker über `subtype` weiter unterschieden (im surroundings-Endpoint).
}
