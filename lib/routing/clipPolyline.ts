/**
 * Zuschnitt einer Fahrt-Polyline auf das gefahrene Teilstück — reine
 * Geometrie ohne React/MapLibre, damit sie sich ohne App prüfen lässt.
 * Benutzt von RouteLayer.tsx (`routeLineCollection`). Koordinaten [lng, lat],
 * Abstände in Grad (planar — für „welcher Punkt liegt näher" genügt das).
 */

export function segLen(a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}
export function pathLen(coords: [number, number][]): number {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += segLen(coords[i - 1]!, coords[i]!);
  return len;
}

/** Index des Polyline-Punkts, der `p` am nächsten liegt. */
function nearestIdx(coords: [number, number][], p: [number, number]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = segLen(coords[i]!, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** „Bei diesem Halt" auf der Polyline: höchstens so viel weiter weg als der nächste Punkt (Grad, ~60–90 m). */
const NEAR_SLACK = 0.0008;

/**
 * Wo die Polyline am Halt `p` vorbeikommt — je Vorbeifahrt der nächste Punkt.
 * Eine Ringlinie kommt an ihrem Start-/Endhalt ZWEIMAL vorbei (Anfang und
 * Ende der Linie), ein Hin-und-zurück an jedem Halt der Strecke.
 */
function passesAt(coords: [number, number][], p: [number, number]): number[] {
  const d = coords.map((c) => segLen(c, p));
  // Schleife statt Math.min(...d): Ein ICE München→Hamburg hat zehntausende
  // Punkte, so viele Argumente verträgt ein Funktionsaufruf nicht sicher.
  let nearest = Infinity;
  for (const x of d) if (x < nearest) nearest = x;
  const limit = nearest + NEAR_SLACK;
  const out: number[] = [];
  let runBest = -1;
  for (let i = 0; i <= d.length; i++) {
    if (i < d.length && d[i]! <= limit) {
      if (runBest < 0 || d[i]! < d[runBest]!) runBest = i;
    } else if (runBest >= 0) {
      out.push(runBest);
      runBest = -1;
    }
  }
  return out;
}

/**
 * Schneidet die volle Trip-Polyline auf das gefahrene Teilstück zwischen
 * `from` und `to` zu. Nötig, weil `/api/trips/polyline` die GESAMTE Fahrt
 * liefert (z.B. den ganzen ICE München→Hamburg, obwohl das Leg nur Köln→Hamburg
 * ist; oder die ganze Ringlinie, obwohl der User nur Petrischule→Justus-Liebig-
 * Platz fährt). Ohne Clip zeichnet die Karte weit über das Segment hinaus / die
 * ganze Runde.
 *
 * IN FAHRTRICHTUNG: Die Polyline läuft vom Start der Fahrt zu ihrem Ende, das
 * Ziel liegt also HINTER dem Einstieg. Vorher nahm der Schnitt einfach den
 * jeweils nächsten Punkt und schnitt min..max — bei einer Ringlinie mit Ende am
 * Startpunkt (Werl Bahnhof → … → Werl Bahnhof) fand er das Ziel oft am ANFANG
 * der Linie und zeichnete die Runde VOR dem Einstieg statt der danach.
 */
export function clipToSegment(
  coords: [number, number][],
  from: [number, number],
  to: [number, number],
): [number, number][] {
  const starts = passesAt(coords, from);
  const ends = passesAt(coords, to);
  // Das kürzeste Stück mit dem Ziel HINTER dem Einstieg — bei einer Strecke,
  // die zweimal am Ziel vorbeikommt, die erste Vorbeifahrt. Eine Runde mit
  // Ein- und Ausstieg am selben Halt ergibt das von selbst: Hinter dem Start
  // kommt die Linie erst am Ende wieder dort vorbei.
  let a = -1;
  let b = -1;
  for (const s of starts) {
    const e = ends.find((x) => x > s);
    if (e != null && (a < 0 || e - s < b - a)) {
      a = s;
      b = e;
    }
  }
  if (a < 0 || b <= a) {
    // Kein Ziel hinter dem Einstieg (Polyline andersherum?) — wie früher.
    const fi = nearestIdx(coords, from);
    const ti = nearestIdx(coords, to);
    a = Math.min(fi, ti);
    b = Math.max(fi, ti);
  }
  if (b - a < 1) return coords; // kein sinnvolles Teilstück → volle Linie
  return coords.slice(a, b + 1);
}
