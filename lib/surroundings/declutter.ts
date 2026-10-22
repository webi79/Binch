/**
 * KÄSTEN RÜCKEN AUSEINANDER, statt aufeinander zu liegen.
 *
 * Tram- und Bushalt an derselben Kreuzung, die Bushalte beider Straßenseiten,
 * der Bahnhof und der Busbahnhof davor: Ihre Kästen lagen übereinander, und
 * Hineinzoomen änderte daran nichts — sie stehen oft nur Meter auseinander.
 * Jetzt rücken überlappende Kästen gerade so weit zur Seite, dass sie ab
 * `DECLUTTER_ZOOM` frei stehen, und zwar dorthin, wo am wenigsten zu rücken ist.
 *
 * Gerechnet EINMAL je Datensatz, auf `DECLUTTER_ZOOM`, als Versatz in Punkten
 * dieser Stufe. Die Karte bekommt ihn als `icon-offset` — und MapLibre nimmt
 * den mit `icon-size` mal: Der Versatz wächst beim Zoomen genau mit dem Kasten.
 * Zwei Kästen am selben Punkt stehen so auf jeder Stufe nebeneinander, und wer
 * weiter auseinander steht, entfernt sich beim Hineinzoomen ohnehin. Nichts
 * springt. Ein eigener Versatz je Zoomstufe ginge nicht flüssig: MapLibre
 * wertet `icon-offset` nur einmal je GANZER Stufe aus (beim Aufbau der
 * Kacheln, `symbol_layout.cpp`) — die Kästen hüpften dann beim Zoomen.
 *
 * Weiter draußen dürfen sie sich überlappen; in einer Großstadt ist dort kein
 * Platz. Und nie weiter als `MAX_SHIFT`: Lieber bleibt in einem dichten Knäuel
 * eine Überlappung, die beim Hineinzoomen vergeht, als dass ein Kasten fern
 * seines Halts steht.
 */

/** Ab dieser Zoomstufe stehen die Kästen frei. */
export const DECLUTTER_ZOOM = 15;
/** Luft zwischen zwei Kästen (Punkte auf `DECLUTTER_ZOOM`) — auch für den größeren gewählten Kasten. */
const GAP = 4;
/** Weiter rückt kein Kasten (Punkte auf `DECLUTTER_ZOOM`, gut ein Kasten). */
const MAX_SHIFT = 40;
/** Durchgänge der Entzerrung — kleine Gruppen sind nach zwei, drei fertig. */
const ROUNDS = 32;

export interface DeclutterItem {
  id: string;
  longitude: number;
  latitude: number;
  /** Breite und Höhe des Kastens auf `DECLUTTER_ZOOM`, in Punkten. */
  width: number;
  height: number;
  /**
   * Wie leicht er ausweicht (> 0): Ein Bushalt rückt eher als der Bahnhof
   * daneben — der wichtigere Halt bleibt näher an seinem Platz.
   */
  mobility: number;
}

/**
 * Versatz je Kasten in Punkten auf `DECLUTTER_ZOOM` (x nach rechts, y nach
 * unten) — nur für Kästen, die rücken.
 *
 * Paarweise auseinanderschieben, Durchgang für Durchgang: Überlappen zwei,
 * gehen sie entlang der Achse mit der kleineren Überdeckung auseinander — so
 * stehen sie hinterher in Reihe oder übereinander, nicht schräg versetzt — und
 * immer VONEINANDER WEG, in der Richtung, in der sie ohnehin liegen. Daran
 * hängt, dass beim Hineinzoomen keine neue Überlappung entsteht: Der echte
 * Abstand wächst dann in genau die Richtung, in die sie schon gerückt sind.
 * Reihenfolge nach Kennung, damit dieselben Halte immer gleich stehen.
 */
export function declutter(items: readonly DeclutterItem[]): Map<string, [number, number]> {
  const n = items.length;
  const out = new Map<string, [number, number]>();
  if (n < 2) return out;

  const order = items
    .map((_, i) => i)
    .sort((a, b) => (items[a]!.id < items[b]!.id ? -1 : items[a]!.id > items[b]!.id ? 1 : 0));
  const rank = new Int32Array(n);
  order.forEach((i, r) => (rank[i] = r));

  // Web-Mercator in Punkten auf DECLUTTER_ZOOM (512er-Kacheln wie MapLibre).
  const world = 512 * 2 ** DECLUTTER_ZOOM;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let maxDim = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i]!;
    x[i] = ((it.longitude + 180) / 360) * world;
    const rad = (it.latitude * Math.PI) / 180;
    y[i] = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
    maxDim = Math.max(maxDim, it.width, it.height);
  }

  // Wer kann wen überhaupt erreichen? Einmal über ein Gitter, danach nur
  // noch diese Paare — auch die, die sich erst durch das Rücken treffen.
  const reach = maxDim + GAP + 2 * MAX_SHIFT;
  const grid = new Map<string, number[]>();
  for (const i of order) {
    const key = `${Math.floor(x[i]! / reach)}:${Math.floor(y[i]! / reach)}`;
    const cell = grid.get(key);
    if (cell) cell.push(i);
    else grid.set(key, [i]);
  }
  const pairs: [number, number][] = [];
  for (const i of order) {
    const cx = Math.floor(x[i]! / reach);
    const cy = Math.floor(y[i]! / reach);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const j of grid.get(`${gx}:${gy}`) ?? []) {
          if (rank[j]! <= rank[i]!) continue;
          const a = items[i]!;
          const b = items[j]!;
          if (Math.abs(x[j]! - x[i]!) >= (a.width + b.width) / 2 + GAP + 2 * MAX_SHIFT) continue;
          if (Math.abs(y[j]! - y[i]!) >= (a.height + b.height) / 2 + GAP + 2 * MAX_SHIFT) continue;
          pairs.push([i, j]);
        }
      }
    }
  }
  if (pairs.length === 0) return out;
  pairs.sort((p, q) => rank[p[0]]! - rank[q[0]]! || rank[p[1]]! - rank[q[1]]!);
  /**
   * Die ECHTE Lage zueinander je Paar — in diese Richtung wird immer
   * geschoben, und nur ein Abstand in diese Richtung zählt als frei.
   *
   * Das ist die Bedingung dafür, dass beim Hineinzoomen nichts neu
   * überlappt: Der echte Abstand wächst dann in dieselbe Richtung. Zählte
   * jeder Abstand, konnten Dritte einen Kasten an seinem Nachbarn VORBEI
   * schieben — auf Stufe 15 frei, beim Hineinzoomen liefen die beiden wieder
   * ineinander (London, Hyde Park Corner auf Stufe 18). Am selben Punkt: der
   * zweite rechts bzw. unter dem ersten.
   */
  const sx = pairs.map(([i, j]) => Math.sign(x[j]! - x[i]!) || 1);
  const sy = pairs.map(([i, j]) => Math.sign(y[j]! - y[i]!) || 1);

  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const clamp = (i: number) => {
    const len = Math.hypot(dx[i]!, dy[i]!);
    if (len <= MAX_SHIFT) return;
    dx[i] = (dx[i]! * MAX_SHIFT) / len;
    dy[i] = (dy[i]! * MAX_SHIFT) / len;
  };
  for (let round = 0; round < ROUNDS; round++) {
    let moved = false;
    for (let p = 0; p < pairs.length; p++) {
      const [i, j] = pairs[p]!;
      const a = items[i]!;
      const b = items[j]!;
      const sepX = sx[p]! * (x[j]! + dx[j]! - (x[i]! + dx[i]!));
      const sepY = sy[p]! * (y[j]! + dy[j]! - (y[i]! + dy[i]!));
      const penX = (a.width + b.width) / 2 + GAP - sepX;
      const penY = (a.height + b.height) / 2 + GAP - sepY;
      if (penX <= 0.05 || penY <= 0.05) continue;
      moved = true;
      const shareI = a.mobility / (a.mobility + b.mobility);
      const shareJ = 1 - shareI;
      if (penX <= penY) {
        dx[i] = dx[i]! - sx[p]! * penX * shareI;
        dx[j] = dx[j]! + sx[p]! * penX * shareJ;
      } else {
        dy[i] = dy[i]! - sy[p]! * penY * shareI;
        dy[j] = dy[j]! + sy[p]! * penY * shareJ;
      }
      clamp(i);
      clamp(j);
    }
    if (!moved) break;
  }

  for (let i = 0; i < n; i++) {
    if (Math.abs(dx[i]!) < 0.25 && Math.abs(dy[i]!) < 0.25) continue;
    out.set(items[i]!.id, [dx[i]!, dy[i]!]);
  }
  return out;
}
