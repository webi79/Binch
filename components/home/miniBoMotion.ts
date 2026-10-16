/**
 * Der kleine Bo der Landingscreen-Leiste — Figur und Bewegung als Daten.
 *
 * Diese Datei ist reine Rechnung, bewusst OHNE React Native: Dieselben
 * Funktionen laufen in `MiniBo` als Worklets auf dem UI-Strang und unter Node
 * in einem Vorschau-Skript, das einzelne Posen als Standbilder rastert. Was hier
 * steht, ist also genau das, was am Gerät zu sehen ist.
 *
 * Alle Worklets darin rechnen nur mit Zahlen und rufen nur einander auf. Eine
 * gewöhnliche Funktion im Worklet bringt die App auf dem UI-Strang zum Absturz
 * („Object is not a function"), und die Typprüfung merkt davon nichts.
 */

// ─── Figur ──────────────────────────────────────────────────────────────────

/**
 * Bos Körper — dieselben Pfaddaten wie in `components/assistant/Bo.tsx`:
 * Kuppe mit Radius 72 um (100, 120), vier Zipfel am Saum. Kein Nachzeichnen,
 * damit es erkennbar dieselbe Figur bleibt, nur kleiner.
 */
export const BO_BODY_PATH =
  "M28 120 A72 72 0 0 1 172 120 L172 197 Q154 221 136 197 Q118 221 100 197 Q82 221 64 197 Q46 221 28 197 Z";

/** Bildausschnitt in Bos Einheiten: Körper (x 28–172, y 48–209) plus etwas Rand. */
export const VIEW_BOX = "24 44 152 170";
const VB_Y = 44;
const VB_H = 170;

/**
 * Die Zeichenfläche jeder Ebene in dp.
 *
 * 18 breit wie die Lupe, die sie ersetzt — und in ganzen dp, damit alle Ebenen
 * auf denselben Pixeln landen. Der Körper misst darin knapp 17 × 19 dp.
 */
export const CANVAS_W = 18;
export const CANVAS_H = 20;
/** dp je Bo-Einheit (`meet`: die engere Achse bestimmt). */
const U = Math.min(CANVAS_W / 152, CANVAS_H / VB_H);
const CENTER_Y = VB_Y + VB_H / 2;

/** Halbmesser des Kopfes auf Augenhöhe und des Körpers darunter — beide 72. */
const RADIUS = 72 * U;
/** Augen-Mitten bei x 76 und 124, also 24 Einheiten neben der Achse. */
const EYE_OFFSET = 24 * U;
/** Winkel der Augen auf dem runden Kopf: sin φ = 24 / 72. */
const EYE_ANGLE = (Math.asin(24 / 72) * 180) / Math.PI;
/** Augenlinie (y 120) relativ zur Flächenmitte — um sie herum wird geblinzelt. */
const EYE_DY = (120 - CENTER_Y) * U;
/** Unterkante der Zipfel (y ≈ 209) — der „Boden", auf dem Bo staucht. */
const GROUND_DY = (209 - CENTER_Y) * U;
/** Mitte des Freude-Gesichts (Bögen bis Mundunterkante) — dort „ploppt" es auf. */
const JOY_DY = (137 - CENTER_Y) * U;

/**
 * Farben, je nachdem, worauf Bo steht.
 *
 * Auf dunkler Fläche ist er der Bo aus `Bo.tsx`: weißer Körper mit demselben
 * Verlauf, Gesicht in Tinte. Auf heller Fläche kehrt sich das um — dunkler
 * Körper, helles Gesicht, die Glanzpunkte als halbdurchsichtige Tinte (wie in
 * der früheren statischen Vorlage `BoMark`).
 */
export interface MiniBoTone {
  bodyTop: string;
  bodyBottom: string;
  face: string;
  glint: string;
  glintOpacity: number;
}

export const TONE_ON_DARK: MiniBoTone = {
  bodyTop: "#FFFFFF",
  bodyBottom: "#E9ECEC",
  face: "#0D0D0D",
  glint: "#F4F4F5",
  glintOpacity: 1,
};

export const TONE_ON_LIGHT: MiniBoTone = {
  bodyTop: "#3A3A3F",
  bodyBottom: "#161618",
  face: "#F4F4F5",
  glint: "#0D0D0D",
  glintOpacity: 0.55,
};

/**
 * Ist diese Fläche dunkel? Relative Leuchtdichte nach WCAG, Schwelle in der
 * Mitte. Versteht `#rgb`, `#rrggbb`, `#rrggbbaa` und `rgb()/rgba()`; alles
 * andere (Farbnamen, Plattformfarben) gilt als dunkel — das ist heute jede
 * Fläche der App.
 */
export function isDarkSurface(color: unknown): boolean {
  if (typeof color !== "string") return true;
  let r: number;
  let g: number;
  let b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim());
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6);
    r = parseInt(full.slice(0, 2), 16);
    g = parseInt(full.slice(2, 4), 16);
    b = parseInt(full.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color.trim());
    if (!rgb) return true;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.4;
}

// ─── Momente ────────────────────────────────────────────────────────────────

/** Kanäle einer Pose. Ruhe: alles 0, nur Maßstäbe und Deckkraft 1. */
const X = 0; // dp, seitlich
const Y = 1; // dp, nach oben negativ
const ROT = 2; // Grad, Neigung in der Bildebene
const S = 3; // Maßstab: näher an der Kamera > 1, weiter weg < 1
const SX = 4; // Stauchen/Strecken quer …
const SY = 5; // … und hoch — mit Boden-Anker
const TURN = 6; // Grad: Drehung um die Hochachse (Gesicht wandert)
const JOY = 7; // 0 normales Gesicht, 1 Freude-Gesicht
const PHASE = 8; // Grad: Fortschritt auf einer geschlossenen Bahn, siehe `Path`
const ALPHA = 9; // Deckkraft der ganzen Figur — nur fürs Verstecken
const CLOSE = 10; // Augen: 0 offen … 1 zu (verträumt, müde, angestrengt)
const YAWN = 11; // 0 … 1 Gähn-Mund
// Der große Bo beim Herausschauen (`bigFrame`). Blick, Augen, Freude und Gähnen
// teilt er mit dem kleinen — sichtbar ist immer nur einer von beiden.
const BIG_ON = 12; // 1 = er ist draußen und sichtbar
const BX = 13; // dp entlang der Kante, ab seiner Stelle
const BY = 14; // dp: Mitte relativ zur Kante (oben negativ) — ab BIG_HIDDEN_Y ganz verdeckt
const BS = 15; // Maßstab: 1 = volle Größe, in der er scharf gezeichnet ist
const BROT = 16; // Grad: Kopf schief
const BRX = 17; // Grad um die Querachse: negativ = oben zum Betrachter hin
const BSX = 18; // Stauchen/Strecken quer …
const BSY = 19; // … und hoch
const BLUSH = 20; // 0 … 1 Erröten (Wangen im Akzent) — nur von vorn sichtbar
/** Unterhalb der Kante, ganz verdeckt — und der Maßstab, mit dem er dort startet. */
const BIG_HIDDEN_Y = 26;
const BIG_REST_S = 0.85;
const REST = [0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, BIG_HIDDEN_Y, BIG_REST_S, 0, 0, 1, 1, 0];
const CHANNEL_KEYS = [
  "x", "y", "rot", "s", "sx", "sy", "turn", "joy", "phase", "alpha", "close", "yawn",
  "bigOn", "bx", "by", "bs", "brot", "brx", "bsx", "bsy", "blush",
] as const;

/** Kurven je Abschnitt (gilt für den Weg ZU einem Schlüsselbild). */
const LIN = 0;
const SINE = 1; // sanft an, sanft aus
const OUT = 2; // schnell los, weich ankommen (quadratisch)
const IN = 3; // weich los, hart ankommen — Fallen
const IN3 = 4; // kubisch — Davonschießen

/**
 * Die Einflug-Kurve des Login-Bildschirms (`BinchAuthScreen`, SuccessOverlay):
 * `Easing.bezier(0.22, 0.85, 0.3, 1.05)` über den ganzen Flug, die Werte
 * dazwischen linear über die Schlüsselbilder 0 / 0,58 / 0,78 / 1. Der kleine
 * Bo fliegt exakt auf derselben Kurve herein, nur auf seinem Maßstab.
 */
const FLY_X1 = 0.22;
const FLY_Y1 = 0.85;
const FLY_X2 = 0.3;
const FLY_Y2 = 1.05;

/**
 * Wie groß ein Moment wirkt. Bestimmt nur die Pause danach (`MiniBo`) — welcher
 * Moment kommt, ist für alle gleich wahrscheinlich.
 */
export const SMALL = 0;
export const MEDIUM = 1;
export const BIG = 2;
/** Herausschauen über die Leiste — mit Platzprüfung vor dem Start. */
export const PEEK_OUT = 3;

/**
 * Was die zufällige Richtung spiegeln darf. Waagerecht nur bei Momenten auf
 * der Stelle: Rechts beginnt nach wenigen dp der Text, jeder Weg dorthin endet
 * an der rechten Sperre. Bahnen spiegeln senkrecht (oben- oder untenherum).
 */
const MIRROR_NONE = 0;
const MIRROR_X = 1;
const MIRROR_Y = 2;

/**
 * Eine geschlossene Bahn durch Bos Platz, durchlaufen über `PHASE` von 0 bis
 * 360°: Versatz = (ax·sin a + bx·(1 − cos a), ay·sin a + by·(1 − cos a)) in dp.
 * Bei 0° und 360° ist er exakt null — die Bahn beginnt und endet auf Bos Platz.
 * Dazu, je Grad der Bahn: Tiefe (oben weiter weg = kleiner), Blick in
 * Flugrichtung und — für den Looping — Drehung mit der Bahn.
 */
interface Path {
  ax: number;
  bx: number;
  ay: number;
  by: number;
  /** Maßstab-Ausschlag: 1 + depth·sin a (mit der senkrechten Spiegelung). */
  depth: number;
  /** Blick: turn·sin a, in Grad. */
  turn: number;
  /** Drehung mit der Bahn: spin·a, in Grad (−1 = einmal kopfvoran herum). */
  spin: number;
}
const NO_PATH: Path = { ax: 0, bx: 0, ay: 0, by: 0, depth: 0, turn: 0, spin: 0 };

interface Moment {
  /** Gesamtdauer in ms (bei Tempo 1) — das letzte Schlüsselbild. */
  total: number;
  /** Zeitfenster [w0, w1], das über die Login-Kurve läuft; 0/0 = keins. */
  w0: number;
  w1: number;
  size: number;
  mirror: number;
  path: Path;
  /** Je Kanal flach: [t, Wert, Kurve, t, Wert, Kurve, …]; leer = Ruhe. */
  tracks: number[][];
}

type Keys = Partial<Record<(typeof CHANNEL_KEYS)[number], number[]>>;

interface Options {
  size: number;
  mirror?: number;
  warp?: [number, number];
  path?: Partial<Path>;
}

function moment(total: number, keys: Keys, opts: Options): Moment {
  return {
    total,
    w0: opts.warp ? opts.warp[0] : 0,
    w1: opts.warp ? opts.warp[1] : 0,
    size: opts.size,
    mirror: opts.mirror ?? MIRROR_X,
    path: { ...NO_PATH, ...opts.path },
    tracks: CHANNEL_KEYS.map((k) => keys[k] ?? []),
  };
}

/**
 * Freudensprung: ducken, abspringen (gestreckt, ein Hauch näher an der
 * Kamera), oben kurz hängen, fallen, beim Aufsetzen stauchen, einmal
 * nachfedern. Das Freude-Gesicht kommt mit dem Absprung.
 */
const HOP = moment(1450, {
  y: [0, 0, LIN, 110, 0.6, SINE, 300, -5.6, OUT, 400, -6, SINE, 540, 0, IN, 640, 0, LIN, 770, -1.6, OUT, 880, 0, IN],
  sy: [0, 1, LIN, 110, 0.84, SINE, 230, 1.12, OUT, 400, 1, SINE, 520, 1.06, IN, 590, 0.86, OUT, 720, 1.04, SINE, 830, 0.97, SINE, 960, 1, SINE],
  sx: [0, 1, LIN, 110, 1.1, SINE, 230, 0.92, OUT, 400, 1, SINE, 520, 0.96, IN, 590, 1.1, OUT, 720, 0.98, SINE, 830, 1.02, SINE, 960, 1, SINE],
  rot: [0, 0, LIN, 300, -3, SINE, 520, 3, SINE, 680, 0, SINE],
  s: [0, 1, LIN, 330, 1.05, SINE, 560, 1, SINE],
  joy: [0, 0, LIN, 150, 0, LIN, 270, 1, OUT, 1150, 1, LIN, 1330, 0, SINE],
}, { size: MEDIUM });

/**
 * Pirouette — die eigentliche 3D-Bewegung: Bo dreht sich im Sprung einmal um
 * die Hochachse. Sein Körper ist rund, an ihm ändert sich dabei nichts; was
 * die Drehung zeigt, ist das Gesicht, das zur Seite wandert, dort schmal wird,
 * hinter dem Kopf verschwindet (kurz sieht man seinen Rücken) und von der
 * anderen Seite zurückkommt. Davor ein kurzer Blick in die Gegenrichtung als
 * Ausholen.
 */
const SPIN = moment(1650, {
  turn: [0, 0, LIN, 160, -22, SINE, 840, 360, SINE],
  y: [0, 0, LIN, 160, 0.5, SINE, 360, -5, OUT, 600, -5.4, SINE, 800, 0, IN, 930, -1.3, OUT, 1040, 0, IN],
  sy: [0, 1, LIN, 160, 0.88, SINE, 300, 1.1, OUT, 600, 1, SINE, 760, 1.05, IN, 840, 0.87, OUT, 960, 1.03, SINE, 1080, 1, SINE],
  sx: [0, 1, LIN, 160, 1.07, SINE, 300, 0.93, OUT, 600, 1, SINE, 760, 0.97, IN, 840, 1.09, OUT, 960, 0.99, SINE, 1080, 1, SINE],
  rot: [0, 0, LIN, 160, -6, SINE, 450, 5, SINE, 800, -3, SINE, 1000, 0, SINE],
  s: [0, 1, LIN, 450, 1.04, SINE, 800, 1, SINE],
  joy: [0, 0, LIN, 870, 0, LIN, 990, 1, OUT, 1420, 1, LIN, 1600, 0, SINE],
}, { size: MEDIUM });

/**
 * Hereinfliegen wie nach dem Login: ducken, nach hinten oben davonschießen
 * (klein, also weit weg), dann auf der Login-Kurve zurück — mit Überschwingen
 * in Größe, Lage und Neigung. Danach Freude und ein kleiner Nachhüpfer.
 */
const FLY_IN_START = 370;
const FLY_IN_END = 1270;
const flyAt = (p: number) => FLY_IN_START + (FLY_IN_END - FLY_IN_START) * p;
const FLY = moment(
  2000,
  {
    // Ducken (bis 120), davonschießen (bis 300), am fernsten Punkt kurz
    // innehalten (bis FLY_IN_START) — sonst liest sich der Rückweg nicht als
    // Flug, sondern als Zurückschnappen.
    x: [0, 0, LIN, 120, 0, LIN, 300, 4.5, IN3, FLY_IN_START, 4.8, LIN, flyAt(0.58), -1, LIN, flyAt(0.78), 0.5, LIN, FLY_IN_END, 0, LIN],
    y: [0, 0, LIN, 120, 0.5, SINE, 300, -8, IN3, FLY_IN_START, -8.4, LIN, flyAt(0.58), 1.4, LIN, flyAt(0.78), -0.5, LIN, FLY_IN_END, 0, LIN, 1330, 0, LIN, 1440, -1.2, OUT, 1550, 0, IN],
    s: [0, 1, LIN, 120, 1, LIN, 300, 0.3, IN3, FLY_IN_START, 0.29, LIN, flyAt(0.58), 1.1, LIN, flyAt(0.78), 0.97, LIN, FLY_IN_END, 1, LIN],
    rot: [0, 0, LIN, 120, -5, SINE, 300, 22, IN3, FLY_IN_START, 23, LIN, flyAt(0.58), -7, LIN, flyAt(0.78), 4, LIN, FLY_IN_END, 0, LIN],
    sy: [0, 1, LIN, 120, 0.9, SINE, 220, 1.08, OUT, 300, 1, SINE, 1550, 1, LIN, 1610, 0.95, OUT, 1710, 1, SINE],
    sx: [0, 1, LIN, 120, 1.06, SINE, 220, 0.94, OUT, 300, 1, SINE, 1550, 1, LIN, 1610, 1.04, OUT, 1710, 1, SINE],
    joy: [0, 0, LIN, flyAt(0.45), 0, LIN, flyAt(0.62), 1, OUT, 1760, 1, LIN, 1950, 0, SINE],
  },
  { size: BIG, warp: [FLY_IN_START, FLY_IN_END] },
);

/** Freudenwackeln: abheben, ein Stück näherkommen, hin und her schaukeln. */
const WIGGLE = moment(1400, {
  y: [0, 0, LIN, 150, -2.2, OUT, 900, -2.2, LIN, 1060, 0, SINE],
  s: [0, 1, LIN, 150, 1.06, OUT, 900, 1.06, LIN, 1060, 1, SINE],
  rot: [0, 0, LIN, 150, 9, SINE, 280, -9, SINE, 410, 7.5, SINE, 540, -6, SINE, 670, 4, SINE, 800, -2, SINE, 920, 0, SINE],
  x: [0, 0, LIN, 150, 0.7, SINE, 280, -0.7, SINE, 410, 0.6, SINE, 540, -0.5, SINE, 670, 0.3, SINE, 800, 0, SINE],
  sy: [0, 1, LIN, 150, 1.04, SINE, 280, 0.97, SINE, 410, 1.03, SINE, 540, 0.98, SINE, 670, 1.02, SINE, 800, 1, SINE],
  sx: [0, 1, LIN, 150, 0.97, SINE, 280, 1.03, SINE, 410, 0.98, SINE, 540, 1.02, SINE, 670, 0.99, SINE, 800, 1, SINE],
  joy: [0, 0, LIN, 140, 1, OUT, 1100, 1, LIN, 1300, 0, SINE],
}, { size: SMALL });

/**
 * Umschauen: den Kopf zur Seite drehen (bei Richtung +1 zum Text hin), kurz
 * hinsehen, zurück — und sich dann freuen. Die Antwort auf einen Spruch, in
 * dem Bo selbst vorkommt.
 */
const LOOK = moment(2000, {
  turn: [0, 0, LIN, 300, 36, SINE, 900, 36, LIN, 1150, 0, SINE],
  rot: [0, 0, LIN, 300, 4, SINE, 900, 4, LIN, 1150, 0, SINE],
  x: [0, 0, LIN, 300, 0.8, SINE, 900, 0.8, LIN, 1150, 0, SINE],
  y: [0, 0, LIN, 1150, 0, LIN, 1250, 0.4, SINE, 1400, -3.8, OUT, 1520, -4.1, SINE, 1640, 0, IN, 1740, -0.8, OUT, 1820, 0, IN],
  sy: [0, 1, LIN, 1150, 1, LIN, 1250, 0.88, SINE, 1360, 1.08, OUT, 1520, 1, SINE, 1620, 1.04, IN, 1680, 0.9, OUT, 1790, 1.02, SINE, 1880, 1, SINE],
  sx: [0, 1, LIN, 1150, 1, LIN, 1250, 1.07, SINE, 1360, 0.94, OUT, 1520, 1, SINE, 1620, 0.97, IN, 1680, 1.07, OUT, 1790, 0.99, SINE, 1880, 1, SINE],
  joy: [0, 0, LIN, 1180, 0, LIN, 1330, 1, OUT, 1800, 1, LIN, 1980, 0, SINE],
}, { size: SMALL });

// ─── Fortbewegung in der Pille ──────────────────────────────────────────────
//
// Bos Raum ist die Pille, nicht sein 18-dp-Platz: Die Leiste ist (bei 57 dp
// Höhe) links eine Rundung mit Radius 27 dp, deren Mitte fast genau auf Bos
// Ruheplatz liegt. Nach oben, unten und links ist also Platz — nach rechts
// nicht, dort beginnt nach 10 dp der Text. Alle Wege führen deshalb nach links,
// oben oder unten; Rechtsausschläge fängt die Sperre in `figureFrame` ab.
// Die Wege sind für die übliche Leiste geschrieben und schrumpfen auf kurzen
// Geräten mit (`roomFor`).

/**
 * Schweben: abheben, nach links oben treiben (wohin er fliegt, schaut er),
 * oben zweimal sanft auf und ab, sich kurz freuen, zurückschauen, heimschweben
 * und weich landen.
 */
const FLOAT = moment(2520, {
  x: [0, 0, LIN, 120, 0, LIN, 760, -8, SINE, 1500, -8, LIN, 2150, 0, SINE],
  y: [0, 0, LIN, 120, 0.8, SINE, 760, -10.5, SINE, 1000, -9.5, SINE, 1250, -10.5, SINE, 1500, -10, SINE, 2150, 0, SINE, 2200, 0, LIN, 2330, -0.8, OUT, 2440, 0, IN],
  rot: [0, 0, LIN, 120, 2, SINE, 440, -8, SINE, 760, -2, SINE, 1500, -2, LIN, 1800, 6, SINE, 2150, 0, SINE],
  turn: [0, 0, LIN, 300, -28, SINE, 760, -10, SINE, 1000, 0, SINE, 1500, 22, SINE, 1900, 10, SINE, 2150, 0, SINE],
  s: [0, 1, LIN, 760, 0.94, SINE, 1500, 0.94, LIN, 2150, 1, SINE],
  sy: [0, 1, LIN, 120, 0.9, SINE, 300, 1.08, OUT, 760, 1, SINE, 2150, 1, LIN, 2230, 0.9, OUT, 2380, 1.03, SINE, 2500, 1, SINE],
  sx: [0, 1, LIN, 120, 1.06, SINE, 300, 0.95, OUT, 760, 1, SINE, 2150, 1, LIN, 2230, 1.07, OUT, 2380, 0.99, SINE, 2500, 1, SINE],
  joy: [0, 0, LIN, 880, 0, LIN, 1000, 1, OUT, 1380, 1, LIN, 1500, 0, SINE],
}, { size: MEDIUM, mirror: MIRROR_NONE });

/**
 * Eine Runde: eine flache Schleife links neben seinem Platz, aufrecht und mit
 * Tiefe — hinten (oben) kleiner, vorn (unten) größer, der Blick immer in
 * Flugrichtung. Gespiegelt fliegt er untenherum los.
 */
const ORBIT = moment(2450, {
  phase: [0, 0, LIN, 150, 0, LIN, 1900, 360, SINE],
  y: [0, 0, LIN, 150, 0.6, SINE, 330, 0, SINE],
  rot: [0, 0, LIN, 150, 3, SINE, 650, -6, SINE, 1050, 0, SINE, 1450, 6, SINE, 1900, 0, SINE],
  sy: [0, 1, LIN, 150, 0.9, SINE, 330, 1.06, OUT, 600, 1, SINE, 1900, 1, LIN, 1990, 0.9, OUT, 2120, 1.03, SINE, 2240, 1, SINE],
  sx: [0, 1, LIN, 150, 1.06, SINE, 330, 0.95, OUT, 600, 1, SINE, 1900, 1, LIN, 1990, 1.07, OUT, 2120, 0.99, SINE, 2240, 1, SINE],
  joy: [0, 0, LIN, 1950, 0, LIN, 2060, 1, OUT, 2300, 1, LIN, 2440, 0, SINE],
}, { size: BIG, mirror: MIRROR_Y, path: { bx: -6.4, ay: -5, depth: -0.1, turn: -35 } });

/**
 * Huschen und Spähen: an den linken Rand flitzen (gestreckt vor Tempo), gegen
 * die Rundung stauchen, sich dann hinauslehnen und auf Zehenspitzen nach
 * rechts spähen, einmal blinzeln, zurückhuschen — „hehe".
 */
const PEEK = moment(2350, {
  x: [0, 0, LIN, 90, 0.6, SINE, 330, -13.5, LIN, 600, -13.5, LIN, 900, -12, SINE, 1300, -12, LIN, 1450, -13.5, SINE, 1950, 0, SINE],
  y: [0, 0, LIN, 90, 0.5, SINE, 330, 0, SINE, 600, 0, LIN, 900, -1.6, SINE, 1300, -1.6, LIN, 1450, 0, SINE, 1700, -1.2, SINE, 1950, 0, SINE, 2030, 0, LIN, 2130, -0.6, OUT, 2230, 0, IN],
  rot: [0, 0, LIN, 90, 4, SINE, 250, -10, SINE, 330, -4, SINE, 420, 2, SINE, 600, 0, SINE, 900, 12, SINE, 1300, 12, LIN, 1450, 0, SINE, 1600, 6, SINE, 1950, 0, SINE],
  turn: [0, 0, LIN, 200, -30, SINE, 420, -30, LIN, 600, 10, SINE, 900, 40, SINE, 1300, 40, LIN, 1450, 0, SINE, 1650, 15, SINE, 1950, 0, SINE],
  sx: [0, 1, LIN, 90, 0.95, SINE, 220, 1.12, OUT, 330, 1.1, LIN, 400, 0.88, OUT, 520, 1.03, SINE, 600, 1, SINE, 1950, 1, LIN, 2030, 1.06, OUT, 2150, 0.99, SINE, 2250, 1, SINE],
  sy: [0, 1, LIN, 90, 0.92, SINE, 220, 0.9, OUT, 330, 0.92, LIN, 400, 1.08, OUT, 520, 0.98, SINE, 600, 1, SINE, 900, 1.05, SINE, 1300, 1.05, LIN, 1450, 1, SINE, 1950, 1, LIN, 2030, 0.92, OUT, 2150, 1.02, SINE, 2250, 1, SINE],
  close: [0, 0, LIN, 1050, 0, LIN, 1110, 1, IN, 1220, 0, OUT],
  joy: [0, 0, LIN, 1980, 0, LIN, 2080, 1, OUT, 2220, 1, LIN, 2350, 0, SINE],
}, { size: MEDIUM, mirror: MIRROR_NONE });

/**
 * Kuckuck: wegducken und klein werden, bis er weg ist — kurz nichts — und an
 * anderer Stelle mit Überschwingen wieder auftauchen, sich freuen und nach
 * Hause hüpfen. Der Ortswechsel passiert, während er unsichtbar ist.
 */
const HIDE = moment(2000, {
  x: [0, 0, LIN, 380, 0, LIN, 900, -5, LIN, 1350, -5, LIN, 1700, 0, SINE],
  y: [0, 0, LIN, 120, 1, SINE, 380, 5, IN, 900, -6, LIN, 1080, -6.6, OUT, 1200, -5.6, SINE, 1350, -6, SINE, 1520, -7.5, SINE, 1700, 0, IN],
  s: [0, 1, LIN, 120, 1, LIN, 380, 0.18, IN, 900, 0.18, LIN, 1080, 1.15, OUT, 1200, 0.96, SINE, 1300, 1, SINE],
  alpha: [0, 1, LIN, 260, 1, LIN, 380, 0, LIN, 900, 0, LIN, 960, 1, LIN],
  rot: [0, 0, LIN, 120, -4, SINE, 380, -12, IN, 900, 8, LIN, 1150, -6, OUT, 1300, 0, SINE],
  sy: [0, 1, LIN, 120, 0.86, SINE, 380, 1, SINE, 1700, 1, LIN, 1780, 0.9, OUT, 1900, 1.02, SINE, 2000, 1, SINE],
  sx: [0, 1, LIN, 120, 1.08, SINE, 380, 1, SINE, 1700, 1, LIN, 1780, 1.07, OUT, 1900, 0.99, SINE, 2000, 1, SINE],
  joy: [0, 0, LIN, 960, 0, LIN, 1060, 1, OUT, 1650, 1, LIN, 1850, 0, SINE],
}, { size: BIG, mirror: MIRROR_NONE });

/**
 * Looping: kopfvoran einmal im Kreis — hoch, links herum, kopfüber nach unten,
 * unten zurück. Nur linksherum: Der Kreis liegt links neben seinem Platz, nach
 * rechts ist kein Raum.
 */
const LOOP = moment(2250, {
  phase: [0, 0, LIN, 160, 0, LIN, 1700, 360, SINE],
  y: [0, 0, LIN, 160, 0.6, SINE, 330, 0, SINE],
  sy: [0, 1, LIN, 160, 0.88, SINE, 330, 1.08, OUT, 560, 1, SINE, 1700, 1, LIN, 1790, 0.9, OUT, 1920, 1.03, SINE, 2040, 1, SINE],
  sx: [0, 1, LIN, 160, 1.07, SINE, 330, 0.94, OUT, 560, 1, SINE, 1700, 1, LIN, 1790, 1.07, OUT, 1920, 0.99, SINE, 2040, 1, SINE],
  joy: [0, 0, LIN, 1750, 0, LIN, 1860, 1, OUT, 2100, 1, LIN, 2240, 0, SINE],
}, { size: BIG, mirror: MIRROR_NONE, path: { bx: -6, ay: -6, spin: -1 } });

/**
 * Zum Mikrofon linsen: Kopf nach rechts, auf die Zehenspitzen, angestrengt
 * hinüberschauen (Augen leicht zusammengekniffen) — „aha!", wieder nach vorn
 * und ein Freudenhüpfer. Immer nach rechts, dort ist das Mikrofon.
 */
const MIC = moment(1700, {
  turn: [0, 0, LIN, 260, 38, SINE, 880, 38, LIN, 1020, 0, SINE],
  rot: [0, 0, LIN, 260, 7, SINE, 600, 7, LIN, 750, 9, SINE, 880, 7, SINE, 1020, 0, SINE],
  x: [0, 0, LIN, 260, 1, SINE, 880, 1, LIN, 1020, 0, SINE],
  y: [0, 0, LIN, 260, -1.8, SINE, 600, -1.8, LIN, 750, -2.6, SINE, 880, -2.2, SINE, 1020, -1, SINE, 1150, -3.4, OUT, 1270, 0, IN],
  sy: [0, 1, LIN, 260, 1.06, SINE, 600, 1.06, LIN, 750, 1.09, SINE, 880, 1.05, SINE, 1020, 1, SINE, 1150, 1.06, OUT, 1270, 1.02, IN, 1330, 0.9, OUT, 1450, 1.02, SINE, 1560, 1, SINE],
  sx: [0, 1, LIN, 260, 0.96, SINE, 600, 0.96, LIN, 750, 0.94, SINE, 880, 0.97, SINE, 1020, 1, SINE, 1150, 0.96, OUT, 1270, 0.99, IN, 1330, 1.08, OUT, 1450, 0.99, SINE, 1560, 1, SINE],
  close: [0, 0, LIN, 600, 0, LIN, 750, 0.35, SINE, 880, 0, SINE],
  joy: [0, 0, LIN, 1020, 0, LIN, 1120, 1, OUT, 1500, 1, LIN, 1680, 0, SINE],
}, { size: SMALL, mirror: MIRROR_NONE });

/**
 * Gähnen und Strecken: langsam lang machen, Augen zu, Mund weit auf, kurz
 * halten — dann zusammensacken, die Müdigkeit abschütteln, Augen wieder auf.
 */
const YAWN_M = moment(1900, {
  sy: [0, 1, LIN, 550, 1.14, SINE, 850, 1.12, SINE, 1150, 1.15, SINE, 1400, 0.93, SINE, 1750, 0.98, SINE, 1900, 1, SINE],
  sx: [0, 1, LIN, 550, 0.92, SINE, 850, 0.93, SINE, 1150, 0.91, SINE, 1400, 1.05, SINE, 1750, 1.01, SINE, 1900, 1, SINE],
  y: [0, 0, LIN, 550, -1.2, SINE, 1150, -1.2, LIN, 1400, 0.3, SINE, 1900, 0, SINE],
  rot: [0, 0, LIN, 550, -3, SINE, 850, -1.5, SINE, 1150, -3, SINE, 1400, 0, SINE, 1520, 5, SINE, 1640, -4, SINE, 1760, 2, SINE, 1880, 0, SINE],
  close: [0, 0, LIN, 200, 0, LIN, 450, 1, SINE, 1500, 1, LIN, 1650, 0, SINE],
  yawn: [0, 0, LIN, 250, 0, LIN, 550, 1, SINE, 1150, 1, LIN, 1350, 0, SINE],
}, { size: SMALL });

/**
 * Verträumt treiben: mit halb geschlossenen Augen nach links oben steigen und
 * wieder sinken, dabei hin und her pendeln wie ein Blatt — langsam, leise.
 */
const DRIFT = moment(3330, {
  x: [0, 0, LIN, 500, -2.5, SINE, 1000, -6.5, SINE, 1500, -3.5, SINE, 2000, -7, SINE, 2500, -3, SINE, 3000, 0, SINE],
  y: [0, 0, LIN, 1500, -8, SINE, 3000, 0, SINE],
  rot: [0, 0, LIN, 500, 3, SINE, 1000, 6, SINE, 1500, -5, SINE, 2000, 6, SINE, 2500, -4, SINE, 3000, 0, SINE],
  s: [0, 1, LIN, 1500, 0.94, SINE, 3000, 1, SINE],
  close: [0, 0, LIN, 250, 0, LIN, 600, 0.55, SINE, 2600, 0.55, LIN, 2950, 0, SINE],
  sy: [0, 1, LIN, 3000, 1, LIN, 3090, 0.95, OUT, 3220, 1.01, SINE, 3330, 1, SINE],
  sx: [0, 1, LIN, 3000, 1, LIN, 3090, 1.04, OUT, 3220, 0.995, SINE, 3330, 1, SINE],
}, { size: BIG, mirror: MIRROR_NONE });

// ─── Herausschauen ──────────────────────────────────────────────────────────
//
// Bo taucht an seinem Platz in die Leiste ein — und sein Kopf kommt weiter
// rechts über ihrer Oberkante wieder heraus, als steckte der Körper noch in der
// Leiste. Dort ist er ein ZWEITER, großer Bo: doppelt so groß gezeichnet
// (`BIG_K`), damit er in voller Größe scharf ist, in einem stillstehenden
// Ausschnitt, dessen Unterkante auf der Pillen-Oberkante liegt. Was unter der
// Kante ist, schneidet der Ausschnitt ab.
//
// Die Stelle liegt über dem geraden Teil der Kante und über der leeren Mitte
// der Kopfzeile — links steht dort das Logo, rechts die Glocke, dazwischen ist
// nichts zum Antippen.

/** Eintauchen am Platz (bis 330 ms) und Wiederauftauchen ab `back`. */
function dive(back: number, pop = 1.1): Keys {
  return {
    y: [0, 0, LIN, 110, 0.8, SINE, 330, 4, IN, back, 4, LIN, back + 150, -1.5, OUT, back + 280, 0, SINE],
    s: [0, 1, LIN, 110, 1, LIN, 330, 0.2, IN, back, 0.2, LIN, back + 150, pop, OUT, back + 280, 0.97, SINE, back + 400, 1, SINE],
    alpha: [0, 1, LIN, 220, 1, LIN, 330, 0, LIN, back, 0, LIN, back + 60, 1, LIN],
    sy: [0, 1, LIN, 110, 0.86, SINE, 330, 1.12, IN, back - 10, 1, LIN, back + 150, 1, LIN, back + 230, 0.94, OUT, back + 360, 1, SINE],
    sx: [0, 1, LIN, 110, 1.08, SINE, 330, 0.92, IN, back - 10, 1, LIN, back + 150, 1, LIN, back + 230, 1.05, OUT, back + 360, 1, SINE],
  };
}

/** Periskop: langsam nur Kuppe und Augen hoch, sich nach links und rechts umsehen, blinzeln, wieder hinab. */
const PERISCOPE = moment(3350, {
  ...dive(2950),
  bigOn: [0, 0, LIN, 440, 0, LIN, 450, 1, LIN, 2850, 1, LIN, 2860, 0, LIN],
  by: [0, BIG_HIDDEN_Y, LIN, 450, BIG_HIDDEN_Y, LIN, 1150, -1, SINE, 2450, -1, LIN, 2850, BIG_HIDDEN_Y, SINE],
  bs: [0, BIG_REST_S, LIN, 450, BIG_REST_S, LIN, 1150, 0.95, SINE, 2450, 0.95, LIN, 2850, BIG_REST_S, SINE],
  turn: [0, 0, LIN, 1200, 0, LIN, 1500, -40, SINE, 1700, -40, LIN, 2100, 38, SINE, 2300, 38, LIN, 2450, 0, SINE],
  brot: [0, 0, LIN, 1200, 0, LIN, 1500, -4, SINE, 2100, 4, SINE, 2450, 0, SINE],
  close: [0, 0, LIN, 1750, 0, LIN, 1810, 1, IN, 1920, 0, OUT],
}, { size: PEEK_OUT, mirror: MIRROR_NONE });

/**
 * Neugierig: erst schauen nur die Augen über die Kante, ein Blick zur Seite,
 * ein Blinzeln — dann ploppt der ganze Kopf heraus, lehnt sich zum Betrachter,
 * legt sich schief und freut sich.
 */
const CURIOUS = moment(3150, {
  ...dive(2750),
  bigOn: [0, 0, LIN, 440, 0, LIN, 450, 1, LIN, 2600, 1, LIN, 2610, 0, LIN],
  by: [0, BIG_HIDDEN_Y, LIN, 450, BIG_HIDDEN_Y, LIN, 950, 3, SINE, 1350, 3, LIN, 1550, -5, OUT, 2150, -5, LIN, 2600, BIG_HIDDEN_Y, SINE],
  bs: [0, BIG_REST_S, LIN, 450, BIG_REST_S, LIN, 950, 0.9, SINE, 1350, 0.9, LIN, 1550, 1, OUT, 2150, 1, LIN, 2600, BIG_REST_S, SINE],
  bsy: [0, 1, LIN, 1350, 1, LIN, 1450, 1.08, OUT, 1600, 0.97, SINE, 1700, 1, SINE],
  bsx: [0, 1, LIN, 1350, 1, LIN, 1450, 0.94, OUT, 1600, 1.02, SINE, 1700, 1, SINE],
  brx: [0, 0, LIN, 1350, 0, LIN, 1550, -14, OUT, 2150, -14, LIN, 2450, 0, SINE],
  brot: [0, 0, LIN, 1600, 0, LIN, 1800, 14, SINE, 2100, 14, LIN, 2300, 0, SINE],
  turn: [0, 0, LIN, 1000, 0, LIN, 1150, -22, SINE, 1300, 0, SINE],
  close: [0, 0, LIN, 1180, 0, LIN, 1240, 1, IN, 1340, 0, OUT],
  joy: [0, 0, LIN, 1820, 0, LIN, 1920, 1, OUT, 2150, 1, LIN, 2280, 0, SINE],
}, { size: PEEK_OUT, mirror: MIRROR_NONE });

/**
 * Buh!: blitzschnell herausploppen — gestreckt, dann gestaucht, mit
 * Überschwingen, dem Betrachter entgegen und mit Freude-Gesicht —, kurz
 * wackeln, und genauso schnell wieder weg.
 */
const BOO = moment(2300, {
  ...dive(1880),
  bigOn: [0, 0, LIN, 370, 0, LIN, 380, 1, LIN, 1830, 1, LIN, 1840, 0, LIN],
  by: [0, BIG_HIDDEN_Y, LIN, 380, BIG_HIDDEN_Y, LIN, 560, -9, OUT, 680, -5, SINE, 760, -6.5, SINE, 1500, -6, LIN, 1830, BIG_HIDDEN_Y, IN3],
  bs: [0, BIG_REST_S, LIN, 380, BIG_REST_S, LIN, 560, 1, OUT, 1500, 1, LIN, 1830, BIG_REST_S, IN3],
  bsy: [0, 1, LIN, 380, 1, LIN, 470, 1.12, OUT, 600, 0.9, SINE, 700, 1.04, SINE, 800, 1, SINE],
  bsx: [0, 1, LIN, 380, 1, LIN, 470, 0.9, OUT, 600, 1.08, SINE, 700, 0.97, SINE, 800, 1, SINE],
  brx: [0, 0, LIN, 380, 0, LIN, 560, -18, OUT, 800, -10, SINE, 1500, -10, LIN, 1700, 0, SINE],
  brot: [0, 0, LIN, 600, 0, LIN, 700, -6, SINE, 820, 5, SINE, 940, -3, SINE, 1060, 0, SINE],
  joy: [0, 0, LIN, 400, 0, LIN, 480, 1, OUT, 1450, 1, LIN, 1560, 0, SINE],
}, { size: PEEK_OUT, mirror: MIRROR_NONE });

/**
 * Schüchtern: vorsichtig herausschauen, zur Seite blickend — dann merkt er, dass
 * man ihn ansieht: Er schreckt hoch, errötet, blinzelt doppelt, zittert und ist
 * blitzschnell weg. An seinem Platz taucht er wieder auf, noch rot, mit gesenkten Lidern,
 * und druckst ein wenig herum.
 */
const SHY = moment(2950, {
  ...dive(2000, 1.04),
  bigOn: [0, 0, LIN, 440, 0, LIN, 450, 1, LIN, 1830, 1, LIN, 1840, 0, LIN],
  by: [0, BIG_HIDDEN_Y, LIN, 450, BIG_HIDDEN_Y, LIN, 1100, 2, SINE, 1300, 2, LIN, 1400, -8, OUT, 1700, -7.5, LIN, 1830, BIG_HIDDEN_Y, IN3],
  bs: [0, BIG_REST_S, LIN, 450, BIG_REST_S, LIN, 1100, 0.92, SINE, 1300, 0.92, LIN, 1400, 1, OUT, 1700, 1, LIN, 1830, BIG_REST_S, IN3],
  bsy: [0, 1, LIN, 1300, 1, LIN, 1360, 1.08, OUT, 1460, 0.96, SINE, 1540, 1, SINE],
  bsx: [0, 1, LIN, 1300, 1, LIN, 1360, 0.94, OUT, 1460, 1.03, SINE, 1540, 1, SINE],
  brx: [0, 0, LIN, 1300, 0, LIN, 1400, -10, OUT, 1700, -10, LIN, 1830, 0, LIN],
  brot: [0, 0, LIN, 1560, 0, LIN, 1600, -3, SINE, 1640, 3, SINE, 1680, -2, SINE, 1720, 0, SINE],
  turn: [0, 0, LIN, 440, 0, LIN, 450, -25, LIN, 1100, -25, LIN, 1300, 0, SINE],
  blush: [0, 0, LIN, 1380, 0, LIN, 1470, 1, OUT, 2550, 1, LIN, 2850, 0, SINE],
  close: [0, 0, LIN, 1470, 0, LIN, 1510, 1, IN, 1550, 0, OUT, 1590, 1, IN, 1640, 0, OUT, 1990, 0, LIN, 2000, 0.55, LIN, 2550, 0.55, LIN, 2800, 0, SINE],
  rot: [0, 0, LIN, 2150, 0, LIN, 2300, -4, SINE, 2450, 3, SINE, 2600, -2, SINE, 2750, 0, SINE],
}, { size: PEEK_OUT, mirror: MIRROR_NONE });

/**
 * Schläfrig: verschlafen hochkommen, gähnen, die Augen fallen zu, der Kopf
 * sinkt zur Seite — er schreckt hoch, ist wieder wach und taucht ab.
 */
const SLEEPY = moment(3450, {
  ...dive(3050),
  bigOn: [0, 0, LIN, 440, 0, LIN, 450, 1, LIN, 2960, 1, LIN, 2970, 0, LIN],
  by: [0, BIG_HIDDEN_Y, LIN, 450, BIG_HIDDEN_Y, LIN, 1050, -1, SINE, 1300, -10, SINE, 1600, -9.5, SINE, 2250, -1, SINE, 2350, -5, OUT, 2480, -4, SINE, 2950, BIG_HIDDEN_Y, SINE],
  bs: [0, BIG_REST_S, LIN, 450, BIG_REST_S, LIN, 1250, 0.95, SINE, 2250, 0.95, LIN, 2350, 1, OUT, 2950, BIG_REST_S, SINE],
  close: [0, 0, LIN, 440, 0, LIN, 450, 0.5, LIN, 1500, 0.6, SINE, 1700, 1, SINE, 2250, 1, LIN, 2330, 0, OUT],
  yawn: [0, 0, LIN, 1000, 0, LIN, 1300, 1, SINE, 1600, 1, LIN, 1750, 0, SINE],
  brot: [0, 0, LIN, 1700, 0, LIN, 2150, 10, SINE, 2250, 12, SINE, 2330, 0, OUT],
  bsy: [0, 1, LIN, 1000, 1, LIN, 1300, 1.07, SINE, 1600, 1.07, LIN, 1750, 1, SINE, 2300, 1, LIN, 2350, 1.1, OUT, 2470, 1, SINE],
  bsx: [0, 1, LIN, 1000, 1, LIN, 1300, 0.95, SINE, 1600, 0.95, LIN, 1750, 1, SINE, 2300, 1, LIN, 2350, 0.93, OUT, 2470, 1, SINE],
  brx: [0, 0, LIN, 2300, 0, LIN, 2350, -12, OUT, 2600, 0, SINE],
}, { size: PEEK_OUT, mirror: MIRROR_NONE });

/** Reihenfolge = Kennung. Wie oft welcher drankommt, steht in `MiniBo`. */
export const MOMENTS: Moment[] = [
  HOP, SPIN, FLY, WIGGLE, LOOK, FLOAT, ORBIT, PEEK, HIDE, LOOP, MIC, YAWN_M, DRIFT,
  PERISCOPE, CURIOUS, BOO, SHY, SLEEPY,
];
export const M_HOP = 0;
export const M_SPIN = 1;
export const M_FLY = 2;
export const M_WIGGLE = 3;
export const M_LOOK = 4;
export const M_FLOAT = 5;
export const M_ORBIT = 6;
export const M_PEEK = 7;
export const M_HIDE = 8;
export const M_LOOP = 9;
export const M_MIC = 10;
export const M_YAWN = 11;
export const M_DRIFT = 12;
export const M_PERISCOPE = 13;
export const M_CURIOUS = 14;
export const M_BOO = 15;
export const M_SHY = 16;
export const M_SLEEPY = 17;
/** Dauer und Größe jedes Moments — für den Zeitgeber auf dem JS-Strang. */
export const MOMENT_TOTALS = MOMENTS.map((m) => m.total);
export const MOMENT_SIZES = MOMENTS.map((m) => m.size);

// ─── Raum ───────────────────────────────────────────────────────────────────

/** Bos Platz in der Zeile: so breit wie die Lupe, die er ersetzt. */
export const SLOT = 18;
/** Abstand, den Bos rechte Kante nie unterschreitet — zum Platzhalter-Text. */
export const TEXT_CLEARANCE = 8.5;

/**
 * Der große Bo: dieselben Ebenen, doppelt so groß gezeichnet. In voller Größe
 * (`BS` = 1) liegt jedes Bitmap 1:1 auf den Pixeln und ist scharf; kleiner
 * (beim Auf- und Abtauchen) wird es nur verkleinert, nie vergrößert.
 */
export const BIG_K = 2;
export const BIG_W = CANVAS_W * BIG_K;
export const BIG_H = CANVAS_H * BIG_K;
/**
 * Der Ausschnitt in Bos Platz-Koordinaten (dp ab der linken oberen Ecke seines
 * Platzes): steht still, seine Unterkante liegt auf der Pillen-Oberkante.
 * Links beginnt er hinter der Rundung der Pille und hinter dem Logo der
 * Kopfzeile, rechts endet er lange vor der Glocke.
 */
export const CLIP_LEFT = 50;
export const CLIP_W = 110;
export const CLIP_H = 44;
/** Wo er herausschaut (Mitte, dp ab der linken Kante seines Platzes) — je Mal zufällig. */
export const SPOT_MIN = 78;
export const SPOT_MAX = 128;
/** So weit ragt er höchstens über die Leiste — vor dem Start wird geprüft, ob das frei ist. */
export const BIG_HEADROOM = 36;
/** Abstand der Kamera für die Neigung zum Betrachter (dp). */
export const BIG_PERSPECTIVE = 160;

/**
 * Wie viel der Wege in die Pille passt — aus ihrer gemessenen Höhe. Die Wege
 * sind für die übliche Leiste (57 dp) geschrieben; auf kurzen Geräten
 * (`UI_SCALE` 0,8 → 45 dp) schrumpft die Leiste, Bo aber nicht, also
 * schrumpfen seine Wege: 1 bei 57 dp, 0,64 bei 45 dp.
 */
export function roomFor(barHeight: number): number {
  const r = (barHeight / 2 - 1.5 - 10.5) / 16.5;
  return r < 0.35 ? 0.35 : r > 1 ? 1 : r;
}

/** Bis wohin Bos rechte Kante darf, gemessen von seiner Mitte. */
export function rightLimitFor(textGap: number): number {
  return SLOT / 2 + textGap - TEXT_CLEARANCE;
}

/**
 * Bos Umriss in dp um die Flächenmitte — alle Punkte, die je seine rechte
 * Kante bilden können: die Kuppe alle 7,5°, die Seiten, und die vier Bögen
 * des Saums, die sich zwischen den Zipfeln nach außen wölben (kopfüber, im
 * Looping, ist genau der Saum vorn).
 */
const OUTLINE: number[] = [];
for (let i = 0; i <= 24; i++) {
  const th = (Math.PI * i) / 24;
  OUTLINE.push(72 * Math.cos(th) * U, (120 - 72 * Math.sin(th) - CENTER_Y) * U);
}
for (const [x0, x1] of [[172, 136], [136, 100], [100, 64], [64, 28]]) {
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const xm = (x0 + x1) / 2;
    const ux = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * xm + t * t * x1;
    const uy = (1 - t) * (1 - t) * 197 + 2 * (1 - t) * t * 221 + t * t * 197;
    OUTLINE.push((ux - 100) * U, (uy - CENTER_Y) * U);
  }
}
/** Die Punkte liegen auf dem Umriss; dazwischen kann er ein paar Hundertstel weiter reichen. */
const REACH_SLACK = 0.05;

/** Mitte des Gähn-Munds (y 158) relativ zur Flächenmitte — dort reißt er auf. */
const YAWN_DY = (158 - CENTER_Y) * U;

// ─── Rechnung (Worklets) ────────────────────────────────────────────────────

function ease(code: number, u: number): number {
  "worklet";
  if (code === SINE) return 0.5 - 0.5 * Math.cos(Math.PI * u);
  if (code === OUT) return 1 - (1 - u) * (1 - u);
  if (code === IN) return u * u;
  if (code === IN3) return u * u * u;
  return u;
}

/** Kubische Bézier-Kurve wie in CSS: zu x den y-Wert (Newton, sechs Schritte). */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  "worklet";
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 6; i++) {
    const it = 1 - t;
    const fx = 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t - x;
    if (Math.abs(fx) < 1e-5) break;
    const dx = 3 * it * it * x1 + 6 * it * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    t -= fx / dx;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }
  const it = 1 - t;
  return 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t;
}

/** Ein Kanal eines Moments zur Zeit t (ms). */
function sample(m: number, ch: number, t: number): number {
  "worklet";
  const mo = MOMENTS[m];
  const k = mo.tracks[ch];
  const n = k.length;
  if (n === 0) return REST[ch];
  let tt = t;
  if (mo.w1 > mo.w0 && t > mo.w0 && t < mo.w1) {
    const span = mo.w1 - mo.w0;
    tt = mo.w0 + span * bezier(FLY_X1, FLY_Y1, FLY_X2, FLY_Y2, (t - mo.w0) / span);
  }
  if (tt <= k[0]) return k[1];
  for (let i = 3; i < n; i += 3) {
    if (tt < k[i]) {
      const t0 = k[i - 3];
      const v0 = k[i - 2];
      return v0 + (k[i + 1] - v0) * ease(k[i + 2], (tt - t0) / (k[i] - t0));
    }
  }
  return k[n - 2];
}

/** Wie weit reicht die gedrehte, gestauchte Figur nach rechts (dp ab Mitte)? */
function reachRight(r: number, sx: number, sy: number): number {
  "worklet";
  const c = Math.cos(r);
  const s = Math.sin(r);
  let m = -1e9;
  for (let i = 0; i < OUTLINE.length; i += 2) {
    const v = OUTLINE[i] * sx * c - OUTLINE[i + 1] * sy * s;
    if (v > m) m = v;
  }
  return m;
}

/*
 * Die Ebenen lesen einen laufenden Moment über fünf Zahlen: `clock` (ms; < 0
 * heißt Ruhe), welcher Moment, Richtung (±1), Ausschlag und `calm`. `calm`
 * (1 → 0) blendet einen Moment, der beim Pausieren noch lief, in die Ruhepose
 * aus, statt ihn springen zu lassen. Dazu die Pille: `room` (Anteil der Wege,
 * die hineinpassen) und `maxRight` (rechte Grenze, siehe `rightLimitFor`).
 *
 * In Ruhe kommen exakt 0 und 1 heraus, keine Rundungsreste: Jede Ebene ist ein
 * fertiges Bild, und schon ein Bruchteil eines Pixels Versatz ließe die GPU es
 * weichzeichnen.
 *
 * Und kein Maßstab wird je genau 0: Eine singuläre Matrix zerlegt React Native
 * auf Android gar nicht erst (`MatrixMathHelper.decomposeMatrix` bricht ab), die
 * Ansicht stünde dann mit lauter Nullen da.
 */

/**
 * Ganze Figur: Weg (Schlüsselbilder plus Bahn), Neigung, Maßstab — Stauchen
 * auf dem Boden verankert — und Deckkraft.
 *
 * Die rechte Sperre zuletzt: Ragt die Figur (gedreht, gestaucht, vergrößert)
 * über `maxRight`, rückt sie um genau den Überstand nach links. Auf der
 * üblichen Leiste greift sie kaum; auf kurzen Geräten, wo zwischen Bo und Text
 * nur 8 dp liegen, hält sie jeden Moment auf Abstand.
 */
export function figureFrame(
  clock: number,
  m: number,
  dir: number,
  amp: number,
  calm: number,
  room: number,
  maxRight: number,
) {
  "worklet";
  if (clock < 0) return { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, alpha: 1 };
  const mo = MOMENTS[m];
  const xs = mo.mirror === MIRROR_X ? dir : 1;
  const ys = mo.mirror === MIRROR_Y ? dir : 1;
  let x = sample(m, X, clock);
  let y = sample(m, Y, clock);
  let rot = sample(m, ROT, clock) * xs * amp * calm;
  let depth = 1;
  const a = sample(m, PHASE, clock) * calm;
  if (a !== 0) {
    const p = mo.path;
    const r = (a * Math.PI) / 180;
    const sa = Math.sin(r);
    const ca = 1 - Math.cos(r);
    x += p.ax * sa + p.bx * ca;
    y += p.ay * sa + p.by * ca;
    depth = 1 + p.depth * sa * ys;
    rot += p.spin * a * ys;
  }
  const move = amp * room * calm;
  x *= xs * move;
  y *= ys * move;
  const s = (1 + (sample(m, S, clock) - 1) * calm) * depth;
  const sx = 1 + (sample(m, SX, clock) - 1) * calm;
  const sy = 1 + (sample(m, SY, clock) - 1) * calm;
  // Gestaucht bleibt die Unterkante, wo sie war — entlang der geneigten Achse.
  const lift = (1 - sy) * GROUND_DY * s;
  const rr = (rot * Math.PI) / 180;
  let tx = x - lift * Math.sin(rr);
  const ty = y + lift * Math.cos(rr);
  const over = tx + reachRight(rr, s * sx, s * sy) + REACH_SLACK - maxRight;
  if (over > 0) tx -= over;
  return {
    tx,
    ty,
    rot,
    sx: s * sx,
    sy: s * sy,
    alpha: 1 + (sample(m, ALPHA, clock) - 1) * calm,
  };
}

/** Blick (Grad um die Hochachse), Freude, Augen zu, Gähnen — je 0 in Ruhe. */
export function faceFrame(clock: number, m: number, dir: number, calm: number) {
  "worklet";
  if (clock < 0) return { turn: 0, joy: 0, close: 0, yawn: 0, blush: 0 };
  const mo = MOMENTS[m];
  let turn = sample(m, TURN, clock) * (mo.mirror === MIRROR_X ? dir : 1) * calm;
  if (mo.path.turn !== 0) {
    const a = sample(m, PHASE, clock) * calm;
    turn += mo.path.turn * Math.sin((a * Math.PI) / 180);
  }
  return {
    turn,
    joy: sample(m, JOY, clock) * calm,
    close: sample(m, CLOSE, clock) * calm,
    yawn: sample(m, YAWN, clock) * calm,
    blush: sample(m, BLUSH, clock) * calm,
  };
}

/**
 * Ein Gesichtsteil auf dem runden Kopf: `side` −1 linkes Auge, +1 rechtes,
 * 0 der Mund. Dreht sich der Kopf um `turn` Grad, landet das Teil bei
 * R·sin(turn + φ) und wird um cos(turn + φ) schmaler — das nähere Auge also
 * weniger als das, das schon um die Kante wandert. Nahe am Rand blendet es aus,
 * auf der Rückseite ist es weg. `close` (0–1) schließt die Augen um ihre eigene
 * Linie, nicht um die Mitte der Fläche.
 */
export function featureFrame(side: number, turn: number, close: number) {
  "worklet";
  const sy = side === 0 ? 1 : 1 - 0.88 * close;
  const ty = side === 0 ? 0 : (1 - sy) * EYE_DY;
  if (turn === 0) return { tx: 0, ty, sx: 1, sy, opacity: 1 };
  const phi = (side * EYE_ANGLE * Math.PI) / 180;
  const ang = phi + (turn * Math.PI) / 180;
  const c = Math.cos(ang);
  const kx = Math.max(0.01, c / Math.cos(phi));
  // Voll sichtbar bis ~57° vom Betrachter weg, weg ab ~76° — so bleibt jedes
  // Teil innerhalb von Bos Umriss, auch schmal am Rand.
  const v = (c - 0.25) / 0.3;
  return {
    tx: RADIUS * Math.sin(ang) - kx * side * EYE_OFFSET,
    ty,
    sx: kx,
    sy,
    opacity: v <= 0 ? 0 : v >= 1 ? 1 : v,
  };
}

/** Das Freude-Gesicht: ab halber Freude sichtbar, ploppt dann aus der Mitte auf. */
export function joyFrame(joy: number) {
  "worklet";
  if (joy < 0.5) return { opacity: 0, ty: 0, sy: 1 };
  const p = joy >= 1 ? 1 : (joy - 0.5) * 2;
  const sy = 0.55 + 0.45 * p;
  return { opacity: 1, ty: (1 - sy) * JOY_DY, sy };
}

/** Der Gähn-Mund: reißt um seine Mitte auf; ersetzt dabei das Lächeln. */
export function yawnFrame(yawn: number) {
  "worklet";
  if (yawn <= 0.05) return { opacity: 0, ty: 0, sy: 1 };
  const sy = 0.25 + 0.75 * (yawn >= 1 ? 1 : yawn);
  return { opacity: 1, ty: (1 - sy) * YAWN_DY, sy };
}

/**
 * Der große Bo beim Herausschauen: Lage entlang der Kante, Höhe über ihr,
 * Neigung zum Betrachter, Kopf schief, Maßstab.
 *
 * Skaliert wird um die Schnittlinie an der Kante, nicht um seine Mitte: Er soll
 * aus der Leiste heraus wachsen, nicht über ihr aufgehen. Deshalb steht seine
 * Mitte bei `BY · Maßstab` über der Kante.
 */
export function bigFrame(clock: number, m: number, calm: number) {
  "worklet";
  if (clock < 0 || sample(m, BIG_ON, clock) < 0.5) {
    return { on: 0, x: 0, y: 0, rx: 0, rot: 0, sx: 1, sy: 1 };
  }
  const s = BIG_REST_S + (sample(m, BS, clock) - BIG_REST_S) * calm;
  const sx = s * (1 + (sample(m, BSX, clock) - 1) * calm);
  const sy = s * (1 + (sample(m, BSY, clock) - 1) * calm);
  const by = BIG_HIDDEN_Y + (sample(m, BY, clock) - BIG_HIDDEN_Y) * calm;
  return {
    on: 1,
    x: sample(m, BX, clock) * calm,
    y: by * sy,
    rx: sample(m, BRX, clock) * calm,
    rot: sample(m, BROT, clock) * calm,
    sx,
    sy,
  };
}
