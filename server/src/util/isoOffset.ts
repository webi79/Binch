/**
 * UTC-Offset aus einem ISO-Zeitstempel ziehen — "2026-07-15T13:50:00+02:00" → "+02:00".
 *
 * Wozu: Der Client rendert Zeiten mit `formatInTimeZone(utc, zone)`, und
 * date-fns-tz akzeptiert dafür sowohl IANA-Namen ("Europe/London") als auch
 * reine Offsets ("+02:00"). MOTIS liefert uns IANA-Zonen pro Halt; db-vendo und
 * FlixBus liefern keine Zonen, aber ihre Zeitstempel tragen den Offset — der
 * reicht, um den Halt in SEINER Ortszeit anzuzeigen.
 *
 * Ohne das rendert der Client jede Leg-Ankunft in der Zone des REISEZIELS: Bei
 * Dortmund → London stünde die Ankunft in Brüssel in London-Zeit, also eine
 * Stunde zu früh.
 *
 * Grenze der Offset-Variante: Sie beschreibt den Zeitpunkt, nicht die Region —
 * für die Anzeige einer konkreten Abfahrt ist das exakt richtig, für „was wäre
 * die Ortszeit im Winter" nicht. Wir zeigen nur konkrete Abfahrten.
 */
export function isoOffset(value?: string | null): string | undefined {
  if (!value) return undefined;
  const s = value.trim();
  if (/Z$/i.test(s)) return "+00:00";
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (!m) return undefined;
  return `${m[1]}${m[2]}:${m[3]}`;
}
