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

export function cleanPlatform(raw?: string | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;

  const stripped = trimmed.replace(PLATFORM_PREFIX, "").trim();
  if (!stripped) return undefined;

  // Ohne jede Ziffer ist es keine Gleisangabe (z.B. „SEinw") → lieber nichts.
  if (!/\d/.test(stripped)) return undefined;

  return stripped;
}
