// Zonen-bewusste Zeit-Formatter via date-fns-tz.
//
// Warum nicht Intl.DateTimeFormat: Hermes (React Native's JS-Engine) ignoriert
// in vielen Versionen das `timeZone`-Argument und fällt auf die Geräte-TZ
// zurück. Das führt zu Anzeigen wie "12:26" statt "10:26" wenn das Datum
// effektiv doppelt nach Lokalzeit konvertiert wird.
// `formatInTimeZone` aus date-fns-tz nutzt einen eingebauten IANA-Timezone-
// Lookup und liefert konsistent den richtigen Wert.

import { formatInTimeZone } from "date-fns-tz";

/**
 * Gedächtnis für bereits formatierte Zeitpunkte.
 *
 * `formatInTimeZone` ist der teuerste Aufruf in einer Ergebniskarte: Es schlägt
 * die Zone nach, rechnet den Versatz aus und läuft dann durch das Muster. Jede
 * Karte macht das vier- bis sechsmal (Abfahrt, Ankunft, beide Daten, dazu die
 * Ist-Zeiten bei Verspätung).
 *
 * Beim Auffüllen der Liste kommen die Karten in Stapeln — und genau dort lagen
 * in der Bild-Messung die langen JS-Bilder nach der Bewegung. Das Entscheidende:
 * Die Ergebnisse sind zwischen den Karten größtenteils IDENTISCH. Alle Treffer
 * einer Suche starten am selben Tag in derselben Zone, „Do, 14 Aug" wurde also
 * für jede der 74 Karten neu ausgerechnet statt einmal.
 *
 * Ein Zeitpunkt in einer Zone hat außerdem immer dieselbe Darstellung — der
 * Zwischenspeicher kann deshalb nicht veralten. Er gilt nur für den Programm-
 * lauf und ist gedeckelt, damit er bei vielen Suchen hintereinander nicht
 * unbegrenzt wächst.
 */
const memo = new Map<string, string>();
const MEMO_MAX = 600;

function cached(key: string, compute: () => string): string {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  // Beim Überlaufen komplett leeren statt einzeln zu verdrängen: Eine echte
  // Verdrängungsreihenfolge kostet pro Zugriff mehr, als sie hier einspart —
  // die Treffer kommen ohnehin stapelweise aus derselben Suche.
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, value);
  return value;
}

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
  // Die Sprache steht im Schlüssel, obwohl sie im Rumpf (noch) niemand
  // benutzt — wer sie später verdrahtet, bekommt sonst stillschweigend die
  // Ausgabe der zuletzt gefragten Sprache zurück.
  return cached(`t|${isoUtc}|${tz ?? ""}|${_locale}`, () => {
    if (tz) return formatInTimeZone(new Date(isoUtc), tz, "HH:mm");
    return new Date(isoUtc).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  });
}

export function formatDateInZone(
  isoUtc: string,
  tz: string | undefined,
  _locale = "en-GB",
): string {
  return cached(`d|${isoUtc}|${tz ?? ""}|${_locale}`, () => {
    if (tz) return formatInTimeZone(new Date(isoUtc), tz, "EEE, dd MMM");
    return new Date(isoUtc).toLocaleDateString([], {
      weekday: "short",
      day: "2-digit",
      month: "short",
    });
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
  // Ebenfalls gemerkt: `dayOffset` läuft zweimal pro Karte und landet für die
  // Abfahrt bei allen Treffern derselben Suche auf demselben Wert.
  const ymdCached = cached(`y|${iso}|${tz ?? ""}`, () => {
    const d = new Date(iso);
    if (tz) return formatInTimeZone(d, tz, "yyyy-MM-dd");
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  return Date.parse(`${ymdCached}T00:00:00Z`);
}
