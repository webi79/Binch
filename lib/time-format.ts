// Zonen-bewusste Zeit-Formatter via date-fns-tz.
//
// Warum nicht Intl.DateTimeFormat: Hermes (React Native's JS-Engine) ignoriert
// in vielen Versionen das `timeZone`-Argument und fällt auf die Geräte-TZ
// zurück. Das führt zu Anzeigen wie "12:26" statt "10:26" wenn das Datum
// effektiv doppelt nach Lokalzeit konvertiert wird.
// `formatInTimeZone` aus date-fns-tz nutzt einen eingebauten IANA-Timezone-
// Lookup und liefert konsistent den richtigen Wert.

import { formatInTimeZone } from "date-fns-tz";

/** Verschiebt eine ISO-UTC-Zeit um `minutes` und gibt wieder ISO-UTC zurück.
 *  Für die Ist-Zeit-Anzeige bei Verspätung (Soll-Zeit + delayMinutes). */
export function shiftIsoByMinutes(isoUtc: string, minutes: number): string {
  return new Date(new Date(isoUtc).getTime() + minutes * 60_000).toISOString();
}

export function formatTimeInZone(
  isoUtc: string,
  tz: string | undefined,
  _locale = "en-GB",
): string {
  if (tz) return formatInTimeZone(new Date(isoUtc), tz, "HH:mm");
  return new Date(isoUtc).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function formatDateInZone(
  isoUtc: string,
  tz: string | undefined,
  _locale = "en-GB",
): string {
  if (tz) return formatInTimeZone(new Date(isoUtc), tz, "EEE, dd MMM");
  return new Date(isoUtc).toLocaleDateString([], {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

// Tag-Offset von arriveIso relativ zu departIso, jeweils in eigener Zone.
// 0 = gleicher Tag, 1 = +1d, -1 = -1d (selten).
export function dayOffset(
  departIso: string,
  arriveIso: string,
  departTz: string | undefined,
  arriveTz: string | undefined,
): number {
  const depDay = dayKey(departIso, departTz);
  const arrDay = dayKey(arriveIso, arriveTz);
  const msPerDay = 86_400_000;
  return Math.round((arrDay - depDay) / msPerDay);
}

function dayKey(iso: string, tz: string | undefined): number {
  const d = new Date(iso);
  if (tz) {
    const ymd = formatInTimeZone(d, tz, "yyyy-MM-dd");
    return Date.parse(`${ymd}T00:00:00Z`);
  }
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}
