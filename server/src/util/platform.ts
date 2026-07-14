/**
 * Gleisangaben aus den Feeds normalisieren.
 *
 * Die offenen Feeds liefern das Feld nicht einheitlich: meist eine nackte Nummer
 * („5", „11a"), manchmal aber mit PRÄFIX IM WERT („Gl. 1", „Pos. 3") und
 * gelegentlich etwas, das gar keine Gleisangabe ist („SEinw"). Der Client setzt
 * sein eigenes „Gleis" davor — heraus kam dann „Gleis Gl. 1" bzw. „Gleis SEinw".
 *
 * Darum hier zentral: Präfix abschneiden, und alles ohne Ziffer verwerfen (lieber
 * kein Gleis anzeigen als eine sinnlose Angabe). Erhalten bleiben sinnvolle
 * Zusätze wie „2 (U5)".
 *
 * EINE Funktion für alle Verbraucher (Such-Provider, Abfahrtstafeln, Trip-Details,
 * dbweb-Anreicherung) — die Feed-Eigenheiten sind überall dieselben, und ein Fix
 * an nur einer Stelle hat uns heute schon mehrfach eingeholt.
 */
const PLATFORM_PREFIX =
  /^(gleise?|gl\.?|bstg\.?|bahnsteig|pos\.?|track|platform|plat\.?|voie|perron|binario|bin\.?)\s*[.:]?\s*/i;

/**
 * Ab hier ist eine Gleisnummer in Europa nicht mehr plausibel. Der größte
 * deutsche Bahnhof (München Hbf) hat 36 Gleise, Zürich HB zählt bis 44 — 80
 * lässt also reichlich Luft und schlägt nur bei echtem Datenmüll an.
 *
 * Hintergrund: DELFI liefert für Köln Hbf die Gleise 85-91. Der Bahnhof hat 1-11
 * — die Werte sind exakt „real + 80". Nachgewiesen ist es ein Fehler der
 * QUELLDATEN, nicht unserer Verarbeitung oder der von Transitous: die
 * MOTIS-eigene Deutschland-Instanz (germany.motis-project.org, nur DELFI — also
 * genau das, was wir self-hosten würden) liefert dieselben 85-91. Ein
 * self-hosted MOTIS würde daran also nichts ändern.
 *
 * Wir RECHNEN die 80 bewusst NICHT heraus, obwohl das Muster verlockend
 * eindeutig aussieht: wäre die Vermutung falsch, schickten wir den User mit
 * einer plausibel aussehenden, aber falschen Gleisangabe auf den falschen
 * Bahnsteig — er verpasst den Zug. Eine offensichtlich unsinnige Angabe
 * („Gleis 88") ist harmlos, weil man auf die Anzeigetafel schaut; eine
 * plausible falsche ist gefährlich. Also lieber gar keine.
 *
 * Richtige Gleise gibt es hier erst wieder über die dbweb-Anreicherung (bahn.de).
 */
const MAX_PLAUSIBLE_PLATFORM = 80;

export function cleanPlatform(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;

  const stripped = trimmed.replace(PLATFORM_PREFIX, "").trim();
  if (!stripped) return undefined;

  // Ohne jede Ziffer ist es keine Gleisangabe (z.B. „SEinw") → lieber nichts.
  if (!/\d/.test(stripped)) return undefined;

  // Unplausibel hohe Nummer → Quelldaten-Müll, nicht anzeigen (siehe oben).
  const asNumber = Number(stripped);
  if (Number.isFinite(asNumber) && asNumber >= MAX_PLAUSIBLE_PLATFORM) return undefined;

  return stripped;
}
