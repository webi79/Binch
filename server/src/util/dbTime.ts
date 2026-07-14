import { fromZonedTime } from "date-fns-tz";
import tzLookup from "tz-lookup";

/**
 * DB-Zeitstempel richtig in UTC umrechnen — inklusive Fahrten über Zeitzonengrenzen.
 *
 * DIE FALLE: DBs API hängt an JEDEN Halt den Offset des STARTORTS, auch an
 * Halte in einer anderen Zeitzone. Für Köln → London liefert sie:
 *
 *     Bruxelles-Midi  ab  2026-07-15T12:56:00+02:00
 *     London St Panc. an  2026-07-15T13:57:00+02:00
 *
 * Gelesen als +02:00 wäre der Eurostar Brüssel→London in EINER Stunde durch. Er
 * braucht zwei. Die 13:57 sind also LONDONER Ortszeit, und der Offset ist
 * schlicht falsch.
 *
 * Wer den Offset naiv glaubt (`new Date(str)`), bekommt einen um Stunden
 * verschobenen UTC-Zeitpunkt — und damit eine falsche Ankunftszeit UND eine um
 * dieselbe Spanne zu kurze Reisedauer. Innerdeutsch fällt das nie auf, weil dort
 * Offset und Ortszeit zusammenfallen.
 *
 * DIE LÖSUNG: Offset wegwerfen, die Uhrzeit als ORTSZEIT des jeweiligen Halts
 * lesen und in dessen ECHTER Zone nach UTC rechnen. Die Zone kommt aus den
 * Koordinaten, die DB pro Halt mitliefert (`tz-lookup`, offline, kein API-Call).
 */

interface StopLike {
  location?: { latitude?: number; longitude?: number };
}

/** Zeitzone eines DB-Halts aus seinen Koordinaten. `undefined`, wenn DB keine
 *  mitliefert — dann bleibt nur, dem Offset zu glauben (innerdeutsch korrekt). */
export function dbStopTz(stop?: StopLike | null): string | undefined {
  const lat = stop?.location?.latitude;
  const lon = stop?.location?.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return undefined;
  try {
    return tzLookup(lat, lon);
  } catch {
    return undefined;
  }
}

/**
 * DB-Zeitstempel + Zone des Halts → ISO-UTC.
 *
 * Ohne Zone fallen wir auf die naive Interpretation zurück (Offset glauben) —
 * das ist das alte Verhalten und innerhalb einer Zeitzone korrekt.
 */
export function dbTimeToUtc(value: string | undefined, tz: string | undefined): string | null {
  if (!value) return null;
  if (!tz) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Offset abschneiden — er lügt (siehe oben). Übrig bleibt die Ortszeit.
  const local = value.trim().replace(/(Z|[+-]\d{2}:?\d{2})$/, "");
  try {
    const d = fromZonedTime(local, tz);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
}
