/**
 * TÜRSTEHER FÜR ESRI — wer bekommt Esri-Kacheln, und wer nicht mehr.
 *
 * Esri kostet ab 2 Mio. Kacheln im Abrechnungszeitraum Geld, und jede Kachel
 * geht über unseren Schlüssel. Deshalb reicht der Server sie durch
 * (routes/imagery.ts), statt den Schlüssel in die App zu legen — nur so lässt
 * sich überhaupt begrenzen: Ein ausgelesener Schlüssel wäre an uns vorbei
 * beliebig nutzbar.
 *
 * WAS EINEN MENSCHEN VON EINEM SKRIPT UNTERSCHEIDET — gemessen, nicht geraten.
 * Eine echte Sitzung mit dieser App (04.10.2026, 17 Minuten quer durch die Welt,
 * 3 522 hochaufgelöste Kacheln) kam in der Spitze auf 96 Kacheln in EINER
 * Sekunde, 211 in drei und 432 in zehn Sekunden: MapLibre lädt beim schnellen
 * Zoomen und Wischen ganze Bildschirme auf einmal. Am Tempo allein ist ein
 * Skript also nicht zu erkennen — ein gemächliches wäre langsamer als ein
 * Mensch. Deshalb Merkmale, die ein Mensch mit der App NICHT erzeugt:
 *
 *   1. Tempo JENSEITS jedes Geräts: mehr als 400 in 1 s oder 1 500 in 10 s.
 *      Gemessen ist ein Telefon (96/s); ein Tablet zeigt rund dreimal so viele
 *      Kacheln je Bildschirm und kommt beim schnellen Zoomen auf ~300/s. Die
 *      Schwelle liegt darüber — sie fängt nur Massen-Abrufer.
 *   2. ABTASTEN in Reihen: MapLibre fordert die Kacheln eines Ausschnitts von
 *      der Mitte nach außen an; mehr als drei, vier Kacheln am Stück in EINER
 *      Richtung einer Reihe (x, x+1, x+2, …) oder Spalte kommen dabei kaum
 *      vor. AUSNAHME, aus der Review: ein schräg gehaltenes Tablet, das langsam
 *      vorwärts geschoben wird, legt die ferne Reihe Kachel für Kachel frei —
 *      bis etwa 17 in Folge. Ab 32 ist es ein Programm, das eine Fläche abfährt.
 *
 * Wer als Skript auffällt, ist 24 Stunden gesperrt — nur DIESE Kennung, nie die
 * ganze IP: Hinter einer IP sitzen oft viele (Mobilfunk-Sammel-IPs, Hotels,
 * Büros), und einer allein soll die anderen nicht aussperren können.
 *
 * Für JEDEN gilt außerdem der Tagesdeckel — 500 Kacheln je Gerät, dazu eine
 * großzügige Grenze je IP (gegen das Wechseln der Kennung). Er ist der
 * Rückhalt, falls ein Skript alle Merkmale umgeht: Mehr als 500 am Tag bekommt
 * auch das nicht. Und über allem steht das Tagesbudget in routes/imagery.ts
 * (Rest des Zeitraums ÷ verbleibende Tage), damit selbst viele IPs zusammen
 * höchstens einen Tagesanteil verbrauchen können.
 *
 * Der Zustand liegt im Speicher (ein Server). Ein Neustart setzt die
 * Tageszähler zurück — vertretbar, Zeitraum- und Tagesbudget liegen in der
 * Datenbank.
 */

export interface GuardLimits {
  dailyPerClient: number;
  dailyPerIp: number;
  clientsPerIpPerDay: number;
  burst1s: number;
  burst10s: number;
  monotoneRun: number;
  blockMs: number;
}

export const DEFAULT_LIMITS: GuardLimits = {
  dailyPerClient: 500,
  dailyPerIp: 8_000,
  clientsPerIpPerDay: 200,
  burst1s: 400,
  burst10s: 1_500,
  monotoneRun: 32,
  blockMs: 24 * 60 * 60_000,
};

export type Deny = "blocked" | "daily" | "ip-daily" | "ip-clients" | "busy" | "script-speed" | "script-scan";

interface ClientState {
  day: string;
  served: number;
  blockedUntil: number;
  /** Zeitpunkte der Anfragen der letzten 10 s (aufsteigend). */
  recent: number[];
  last: { z: number; x: number; y: number } | null;
  /** Länge und Richtung (+1/−1) der laufenden Folge in einer Reihe bzw. Spalte. */
  runX: number;
  dirX: number;
  runY: number;
  dirY: number;
}

interface IpState {
  day: string;
  served: number;
  clients: Set<string>;
}

/**
 * HARTE Obergrenzen der Tabellen. Neue Einträge gibt es nur für Anfragen, die
 * auch durchgelassen werden — eine abgewiesene Kennung legt nichts an. Ist die
 * Tabelle trotzdem voll und lässt sich nichts aufräumen, werden NEUE Kennungen
 * abgewiesen („busy"); bekannte laufen weiter.
 */
const MAX_CLIENTS = 200_000;
const MAX_IPS = 100_000;

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Die Adresse, nach der gezählt wird: IPv4 wie sie ist (auch in der Form
 * „::ffff:1.2.3.4"), IPv6 als /64 — ein Anschluss bekommt mindestens ein /64,
 * sonst wäre jede seiner Adressen ein neuer „Anschluss".
 */
export function ipKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!ip.includes(":")) return ip;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${full.slice(0, 4).map((p) => p.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

type Gate = { c: ClientState | undefined; s: IpState | undefined; ip: string; day: string; t: number };

export class EsriGuard {
  private clients = new Map<string, ClientState>();
  private ips = new Map<string, IpState>();
  /** Für Protokoll und Übersicht: wie viele Kennungen seit dem Start als Skript aufgefallen sind. */
  blockedTotal = 0;

  constructor(
    private readonly limits: GuardLimits = DEFAULT_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Abgelaufene Tage und Sperren aufräumen. */
  private prune(): void {
    const t = this.now();
    const day = utcDay(t);
    for (const [k, c] of this.clients) if (c.day !== day && c.blockedUntil < t) this.clients.delete(k);
    for (const [k, s] of this.ips) if (s.day !== day) this.ips.delete(k);
  }

  /**
   * Gemeinsame Prüfung für Schein-Ausgabe und Kachel — OHNE etwas anzulegen.
   * Gibt die Ablehnung zurück oder die (ggf. danach anzulegenden) Zustände.
   */
  private gate(clientId: string, addr: string): Deny | Gate {
    const t = this.now();
    const day = utcDay(t);
    const ip = ipKey(addr);
    const c = this.clients.get(clientId);
    if (c) {
      if (c.blockedUntil > t) return "blocked";
      if (c.day !== day) {
        c.day = day;
        c.served = 0;
      }
      if (c.served >= this.limits.dailyPerClient) return "daily";
    }
    const s = this.ips.get(ip);
    if (s) {
      if (s.day !== day) {
        s.day = day;
        s.served = 0;
        s.clients.clear();
      }
      if (s.served >= this.limits.dailyPerIp) return "ip-daily";
      if (!s.clients.has(clientId) && s.clients.size >= this.limits.clientsPerIpPerDay) return "ip-clients";
    }
    if (!c && this.clients.size >= MAX_CLIENTS) {
      this.prune();
      if (this.clients.size >= MAX_CLIENTS) return "busy";
    }
    if (!s && this.ips.size >= MAX_IPS) {
      this.prune();
      if (this.ips.size >= MAX_IPS) return "busy";
    }
    return { c, s, ip, day, t };
  }

  /** Zustände anlegen — erst NACH bestandener Prüfung. */
  private materialize(clientId: string, g: Gate): { c: ClientState; s: IpState } {
    let c = g.c;
    if (!c) {
      c = { day: g.day, served: 0, blockedUntil: 0, recent: [], last: null, runX: 0, dirX: 0, runY: 0, dirY: 0 };
      this.clients.set(clientId, c);
    }
    let s = g.s;
    if (!s) {
      s = { day: g.day, served: 0, clients: new Set() };
      this.ips.set(g.ip, s);
    }
    s.clients.add(clientId);
    return { c, s };
  }

  /** Darf dieses Gerät einen Schein bekommen? (Ausgabe in `/api/imagery/esri`.) */
  admit(clientId: string, addr: string): Deny | null {
    const g = this.gate(clientId, addr);
    if (typeof g === "string") return g;
    this.materialize(clientId, g);
    return null;
  }

  /** Vor jedem Abruf bei Esri: darf diese Kachel geholt werden? Reserviert sie gleich. */
  check(clientId: string, addr: string, z: number, x: number, y: number): Deny | null {
    const g = this.gate(clientId, addr);
    if (typeof g === "string") return g;
    const { c, s } = this.materialize(clientId, g);
    const t = g.t;

    // 1. Tempo jenseits dessen, was die App selbst erzeugt.
    while (c.recent.length > 0 && t - c.recent[0]! > 10_000) c.recent.shift();
    c.recent.push(t);
    let inOne = 0;
    for (let i = c.recent.length - 1; i >= 0 && t - c.recent[i]! <= 1_000; i--) inOne++;
    if (inOne > this.limits.burst1s || c.recent.length > this.limits.burst10s) {
      c.blockedUntil = t + this.limits.blockMs;
      this.blockedTotal++;
      return "script-speed";
    }

    // 2. Abtasten in Reihen oder Spalten — nur eine DURCHGEHENDE Richtung zählt
    //    (x, x+1, x+2, …). Ein Hin und Her zwischen Nachbarn (5, 6, 5, 6) ist
    //    keine Abtastung und kommt beim Kartenladen durchaus vor.
    const l = c.last;
    const dx = l && l.z === z && l.y === y ? x - l.x : 0;
    const dy = l && l.z === z && l.x === x ? y - l.y : 0;
    if (Math.abs(dx) === 1) {
      c.runX = dx === c.dirX ? c.runX + 1 : 1;
      c.dirX = dx;
    } else {
      c.runX = 0;
      c.dirX = 0;
    }
    if (Math.abs(dy) === 1) {
      c.runY = dy === c.dirY ? c.runY + 1 : 1;
      c.dirY = dy;
    } else {
      c.runY = 0;
      c.dirY = 0;
    }
    c.last = { z, x, y };
    if (c.runX >= this.limits.monotoneRun || c.runY >= this.limits.monotoneRun) {
      c.blockedUntil = t + this.limits.blockMs;
      this.blockedTotal++;
      return "script-scan";
    }

    // Gleich RESERVIEREN, nicht erst nach der Antwort: Sonst kämen zwanzig
    // gleichzeitige Anfragen bei Stand 499 alle noch durch.
    c.served++;
    s.served++;
    return null;
  }

  /** Esri hat keine Kachel geliefert (Fehler, 404) — die Reservierung zurückgeben. */
  release(clientId: string, addr: string): void {
    const c = this.clients.get(clientId);
    const s = this.ips.get(ipKey(addr));
    if (c && c.served > 0) c.served--;
    if (s && s.served > 0) s.served--;
  }

  /** Wie viele Kacheln hat dieses Gerät heute noch? */
  remaining(clientId: string): number {
    const c = this.clients.get(clientId);
    if (!c || c.day !== utcDay(this.now())) return this.limits.dailyPerClient;
    return Math.max(0, this.limits.dailyPerClient - c.served);
  }
}
