import type { JourneyWarning, LegInfo } from "../providers/types.js";

/**
 * Zeitfolge einer Verbindung prüfen — Soll plus bekannte Verspätung.
 *
 * DB (und MOTIS) routen auf ECHTZEIT. Ist ein Anschlusszug weit genug verspätet,
 * wird er zum Anschluss. Werl → Greven am 09.10., so von int.bahn.de geliefert:
 *
 *     RB 59  Werl 20:16           → Unna   20:28
 *     RE 7   Unna 19:43 (Ist 20:32) → Greven 20:33 (Ist 21:20)
 *
 * Die Verbindung gibt es wirklich — aber nur mit den Ist-Zeiten. Gezeigt wurden
 * die Sollzeiten ohne Verspätung: ein Zug, der 45 Minuten vor der Ankunft des
 * Zubringers abfährt, und „17 min" Reisedauer (20:16 bis 20:33).
 *
 * Darum gilt hier wie in der Anzeige: Ist = Soll + Verspätung. Geprüft werden
 * nur die UMSTIEGE zwischen Fahrzeugen. Innerhalb einer Fahrt vertrauen wir den
 * Daten der Quelle — dort widerspricht sich höchstens deren Echtzeit-Prognose,
 * und eine echte Verbindung zu verwerfen wäre schlimmer als ein schiefer Halt.
 */

/** Spielraum für Minuten-Rundung. Ein Umstieg „in derselben Minute" ist erlaubt. */
const SEQUENCE_TOLERANCE_MS = 60_000;

const MINUTE_MS = 60_000;

export interface TimelineLike {
  departTime: string;
  arriveTime: string;
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
  legs?: LegInfo[] | null;
}

/** Ist-Zeitpunkt in ms: Soll + bekannte Verspätung. NaN, wenn die Zeit unlesbar ist. */
export function effectiveMs(iso: string | undefined, delayMinutes?: number): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return t + (delayMinutes && delayMinutes > 0 ? delayMinutes : 0) * MINUTE_MS;
}

/** Reisedauer in Minuten aus den Ist-Zeiten (mindestens 1, wie überall). */
export function effectiveDurationMinutes(r: TimelineLike): number {
  const dep = effectiveMs(r.departTime, r.departDelayMinutes);
  const arr = effectiveMs(r.arriveTime, r.arriveDelayMinutes);
  return Math.max(1, Math.round((arr - dep) / MINUTE_MS));
}

function hhmmBerlin(ms: number): string {
  return new Date(ms).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

/**
 * Warum die Zeitfolge unmöglich ist — oder `null`, wenn sie trägt.
 *
 * Der Text landet nur im Protokoll (damit ein verworfener Treffer auffällt),
 * nie beim Nutzer.
 */
export function timelineProblem(r: TimelineLike): string | null {
  const dep = effectiveMs(r.departTime, r.departDelayMinutes);
  const arr = effectiveMs(r.arriveTime, r.arriveDelayMinutes);
  if (!Number.isFinite(dep) || !Number.isFinite(arr)) return "Abfahrt/Ankunft unlesbar";
  if (arr < dep - SEQUENCE_TOLERANCE_MS) {
    return `Ankunft ${hhmmBerlin(arr)} vor Abfahrt ${hhmmBerlin(dep)}`;
  }

  // Nur Fahrzeuge: Fußwege haben je nach Quelle Echtzeit- statt Sollzeiten
  // (MOTIS rechnet sie ab der Ist-Ankunft) und würden sonst Fehlalarme auslösen.
  let prev: LegInfo | undefined;
  for (const leg of r.legs ?? []) {
    if (leg.walking) continue;
    const legDep = effectiveMs(leg.departTime, leg.departDelayMinutes);
    if (prev && Number.isFinite(legDep)) {
      const prevArr = effectiveMs(prev.arriveTime, prev.arriveDelayMinutes);
      if (Number.isFinite(prevArr) && legDep < prevArr - SEQUENCE_TOLERANCE_MS) {
        return (
          `${leg.line ?? "Anschluss"} fährt ${hhmmBerlin(legDep)} in ${leg.originLabel ?? "?"} ab, ` +
          `${prev.line ?? "Zubringer"} kommt erst ${hhmmBerlin(prevArr)} an`
        );
      }
    }
    prev = leg;
  }
  return null;
}

/**
 * Verspätungen der Gesamtreise aus den Teilstrecken — so, wie die Provider sie
 * selbst setzen: Abfahrt = erstes Fahrzeug (beginnt die Reise mit einem Fußweg,
 * geht man trotzdem pünktlich los), Ankunft = letztes Fahrzeug.
 *
 * Gebraucht im Cache: Dort sind nur die Teilstrecken gespeichert (JSON), die
 * Verspätung der Gesamtreise hat keine Spalte.
 */
export function journeyDelaysFromLegs(legs: LegInfo[] | null | undefined): {
  departDelayMinutes?: number;
  arriveDelayMinutes?: number;
} {
  const list = legs ?? [];
  const first = list[0];
  const lastTransit = [...list].reverse().find((l) => !l.walking);
  return {
    departDelayMinutes: first && !first.walking ? first.departDelayMinutes : undefined,
    arriveDelayMinutes: lastTransit?.arriveDelayMinutes,
  };
}

/** Trägt irgendeine Teilstrecke eine Verspätung? */
export function hasRealtime(legs: LegInfo[] | null | undefined): boolean {
  return (legs ?? []).some(
    (l) => (l.departDelayMinutes ?? 0) > 0 || (l.arriveDelayMinutes ?? 0) > 0,
  );
}

/**
 * Warnung der Gesamtreise aus den Teilstrecken: Ausfall schlägt gefährdeten
 * Anschluss. EINE Ableitung für Provider und Cache — dort steht die Warnung nur
 * im `legs`-JSON, eine eigene Spalte hat sie nicht.
 */
export function journeyWarningFromLegs(legs: LegInfo[] | null | undefined): JourneyWarning | undefined {
  const list = legs ?? [];
  if (list.some((l) => l.warning === "cancelled")) return "cancelled";
  if (list.some((l) => l.warning === "connectionAtRisk")) return "connectionAtRisk";
  return undefined;
}

/** Rang fürs Sortieren und den Dedupe: funktionierend < gefährdet < fällt aus. */
export function warningRank(r: { warning?: JourneyWarning }): number {
  return r.warning === "cancelled" ? 2 : r.warning === "connectionAtRisk" ? 1 : 0;
}

/**
 * DB meldet „Anschluss nicht erreichbar" nur für die ganze Reise. Welcher
 * Umstieg gemeint ist, sagen die Ist-Zeiten: der mit der knappsten Übergangszeit.
 * Nachgemessen an allen gespeicherten Rohantworten (25 solcher Reisen): 22-mal
 * ist sie negativ (der Anschluss ist schlicht weg), 3-mal 2-4 min (DBs
 * Mindestumstiegszeit nicht erreicht) — eindeutig in jedem Fall.
 *
 * Markiert wird die Teilstrecke NACH dem Umstieg (`warning` = Umstieg in sie
 * hinein). Fällt sie ohnehin aus, bleibt es bei „cancelled".
 */
export function markAtRiskTransfer(legs: LegInfo[]): void {
  let prev: LegInfo | undefined;
  let worst: { leg: LegInfo; gapMs: number } | undefined;
  for (const leg of legs) {
    if (leg.walking) continue;
    if (prev) {
      const gapMs =
        effectiveMs(leg.departTime, leg.departDelayMinutes) - effectiveMs(prev.arriveTime, prev.arriveDelayMinutes);
      if (Number.isFinite(gapMs) && (!worst || gapMs < worst.gapMs)) worst = { leg, gapMs };
    }
    prev = leg;
  }
  // Ohne Umstieg (kommt in den Daten nicht vor) trägt die erste Fahrt die Warnung.
  const target = worst?.leg ?? legs.find((l) => !l.walking);
  if (target && !target.warning) target.warning = "connectionAtRisk";
}
