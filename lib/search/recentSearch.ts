/**
 * Der Verlauf („Zuletzt gesucht") — was eine Karte ANZEIGT und womit sie die
 * Suche erneut startet.
 *
 * Bis 28.10.2026 merkte sich der Verlauf weder Klasse noch Uhrzeit, und die
 * Karte schrieb die Klasse fest hin („Economy" bzw. „2. Klasse"). Wer in der
 * 1. Klasse um 14:30 gesucht hatte, sah dort etwas anderes — und ein Tipp
 * darauf suchte tatsächlich in der 2. Klasse ab Tagesbeginn. Jetzt geht beides
 * mit, und eine vergangene Reise wird auf heute verschoben statt einen Tag zu
 * suchen, an dem kein Zug mehr fährt.
 */
import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from "date-fns";
import type { RecentSearch } from "@/stores/searchStore";
import type { TravelMode } from "@/types/search";

/** Die Klassen je Verkehrsmittel, die erste ist die Vorgabe (wie im Such-Formular). */
export function classOptionsFor(mode: TravelMode): string[] {
  switch (mode) {
    case "FLIGHT":
      return ["search.class.economy", "search.class.business", "search.class.first"];
    case "TRAIN":
      return ["search.class.second", "search.class.first", "search.class.sparpreis"];
    case "BUS":
      return ["search.seat.standard", "search.seat.comfort", "search.seat.premium"];
    case "CRUISE":
      return ["search.cabin.inside", "search.cabin.outside", "search.cabin.balcony", "search.cabin.suite"];
  }
}

/** Die gesuchte Klasse — oder die Vorgabe, wenn der Eintrag noch aus der Zeit ohne Klasse stammt. */
export function recentClassKey(search: RecentSearch): string {
  return search.travelClass || classOptionsFor(search.mode)[0]!;
}

/**
 * Hatte die Suche eine gewählte Uhrzeit? Mitternacht zählt nicht — so steht
 * der Datumswähler, wenn niemand eine Zeit eingestellt hat.
 */
export function recentDepartTime(search: RecentSearch): Date | null {
  if (!search.departTime) return null;
  const d = new Date(search.departTime);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() === 0 && d.getMinutes() === 0 ? null : d;
}

/**
 * Die Parameter für den erneuten Start.
 *
 * Liegt der Reisetag in der Vergangenheit, wird HEUTE gesucht und eine
 * Rückreise um dieselbe Zahl Tage mitgeschoben (die Reisedauer bleibt). Eine
 * Uhrzeit geht nur mit, wenn sie noch kommt — sonst suchte die Liste ab einem
 * Zeitpunkt, der schon vorbei ist.
 */
export function recentRelaunchParams(search: RecentSearch, now: Date = new Date()): Record<string, string> {
  const today = startOfDay(now);
  let depart = parseDay(search.departDate) ?? today;
  let back = search.returnDate ? parseDay(search.returnDate) : null;
  const shift = differenceInCalendarDays(today, depart);
  if (shift > 0) {
    depart = today;
    if (back) back = addDays(back, shift);
  }
  const time = recentDepartTime(search);
  const keepTime = shift <= 0 && time && time.getTime() > now.getTime();
  return {
    mode: search.mode,
    origin: search.origin.code,
    destination: search.destination.code,
    originLabel: search.origin.label,
    destLabel: search.destination.label,
    departDate: format(depart, "yyyy-MM-dd"),
    ...(keepTime ? { departTime: time.toISOString() } : {}),
    ...(back ? { returnDate: format(back, "yyyy-MM-dd") } : {}),
    ...(search.tripType ? { tripType: search.tripType } : {}),
    passengers: String(search.passengers),
    currency: search.currency,
    ...(search.travelClass ? { travelClass: search.travelClass } : {}),
  };
}

function parseDay(value: string): Date | null {
  try {
    const d = parseISO(value);
    return Number.isNaN(d.getTime()) ? null : startOfDay(d);
  } catch {
    return null;
  }
}
