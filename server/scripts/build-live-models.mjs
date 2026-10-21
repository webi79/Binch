/**
 * DIE 3D-MODELLE DER LIVE-ANSICHT als Netze für die eigene Karten-Ebene
 * (`modules/live-models`, C++/OpenGL in der Karte).
 *
 * Dieselben Körper wie bisher (Bahnwagen je Zugart mit Nase oder Übergängen,
 * Reisebus, Flugzeug), aber als echte Netze: Die Karte zeichnet sie selbst,
 * fest in der Welt nach Fahrtrichtung ausgerichtet — beim Zoomen, Drehen und
 * Neigen stimmen sie wie Häuser, statt als vorgerenderte Ansicht zur Kamera
 * zu schauen (das ließ das Flugzeug von seiner Linie rutschen und drehte die
 * Wagen mit dem Blick).
 *
 * Je Ecke: Lage (m, x rechts, y vorn, z oben, Ursprung Mitte am Boden),
 * Normale, Material. FARBEN stehen nicht im Netz — Fenster, Stege, Türen,
 * Zierstreifen, Frontscheibe malt der Shader aus der Lage auf dem Körper
 * (`live_models.cpp`), gestochen scharf auf jeder Stufe. Die Maße dafür
 * schreibt das Skript nach `lib/live/liveModelSpecs.ts`.
 *
 * Aufruf (aus server/): node scripts/build-live-models.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Mesh, RAD, naca, US, superRing } from "./lib/sprite3d.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "modules/live-models/android/src/main/assets/livemodels");

/** Material-Nummern — dieselben wie im Shader (`live_models.cpp`). */
const MAT = {
  body: 0, front: 1, rearcap: 2, bellows: 3, bogie: 4, roofbox: 5,
  tyre: 6, hub: 7, rear: 8,
  wing: 9, engine: 10, intake: 11, exhaust: 12, tailcap: 13, fin: 14,
};

const STYLE_W = 1.7;
const STYLE_H = 1.3;
const RAIL = {
  "rail-ice": { L: 25, W: 2.95, H: 3.9, nose: "sleek", noseLen: 7.5, doors: [-0.31, 0.31], stripe: "#FFD60A", window: 2.35 },
  "rail-regional": { L: 26, W: 2.9, H: 4.1, nose: "round", noseLen: 2.6, doors: [-0.27, 0.27], stripe: "#FFD60A", window: 2.2 },
  "rail-subway": { L: 18, W: 2.65, H: 3.55, nose: "flat", noseLen: 1.0, doors: [-0.31, 0, 0.31], stripe: "#4C7BF0", window: 2.0 },
  "rail-tram": { L: 10, W: 2.4, H: 3.4, nose: "round", noseLen: 1.5, doors: [0.05], stripe: "#3A3F47", window: 1.8, lowFloor: true },
};
const NOSE = { sleek: 0, round: 1, flat: 2 };

/** Querschnitt eines Bahnwagens an der Stelle y — dieselbe Rechnung steht im Shader. */
function railSection(s, part, y) {
  const a0 = (s.W * STYLE_W) / 2;
  const H = s.H * STYLE_H;
  const zBot = (s.lowFloor ? 0.3 : 0.55) * STYLE_H;
  const span = H - zBot;
  const half = s.L / 2;
  const bodyEnd = part === "head" ? half - s.noseLen : half - 0.4;
  let a = a0;
  let top = H;
  let bot = zBot;
  if (part === "head" && y > bodyEnd) {
    const t = Math.min(1, (y - bodyEnd) / s.noseLen);
    if (s.nose === "sleek") {
      a = a0 * (1 - 0.78 * t ** 1.8);
      top = H - (H - (zBot + 0.42 * span)) * t ** 1.25;
      bot = zBot + 0.1 * span * t ** 2.2;
    } else if (s.nose === "round") {
      a = a0 * (1 - 0.22 * t ** 2.4);
      top = H - 0.2 * span * t ** 2.2;
      bot = zBot + 0.03 * span * t;
    } else {
      a = a0 * (1 - 0.07 * t * t);
      top = H - 0.07 * span * t * t;
      bot = zBot + 0.02 * span * t;
    }
  }
  return { a, top, bot };
}

function railCar(s, part) {
  const m = new Mesh();
  const a0 = (s.W * STYLE_W) / 2;
  const H = s.H * STYLE_H;
  const zBot = (s.lowFloor ? 0.3 : 0.55) * STYLE_H;
  const span = H - zBot;
  const half = s.L / 2;
  const head = part === "head";
  const bodyEnd = head ? half - s.noseLen : half - 0.4;
  const ys = [-half];
  for (let i = 1; i <= 8; i++) ys.push(-half + ((bodyEnd + half) * i) / 8);
  if (head) for (let i = 1; i <= 20; i++) ys.push(bodyEnd + s.noseLen * (1 - (1 - i / 20) ** 1.35));
  else ys.push(half);
  m.loft(ys.map((y) => {
    const q = railSection(s, part, y);
    return superRing(y, q.a, q.bot, q.top, 4, 44);
  }), "body", { capStart: "rearcap", capEnd: head ? "front" : "rearcap" });
  // Schmale dunkle Fuge an gekuppelten Enden, 0,25 m darüber hinaus.
  const joint = (y0, y1) =>
    m.loft([y0, y1].map((y) => superRing(y, 0.94 * a0, zBot + 0.04 * span, H - 0.05 * span, 4, 36)), "bellows", { capStart: "bellows", capEnd: "bellows" });
  joint(-half - 0.25, -half + 0.02);
  if (!head) joint(half - 0.02, half + 0.25);
  const bogieYs = head ? [-half + 3.4, bodyEnd - (s.nose === "sleek" ? 0.6 : 1.8)] : [-half + 3.4, half - 3.4];
  for (const yb of bogieYs) {
    m.loft([yb - 1.5, yb - 1.3, yb + 1.3, yb + 1.5].map((y, i) => superRing(y, (i === 0 || i === 3 ? 0.36 : 0.4) * a0, 0.04, zBot + 0.06, 8, 20)), "bogie", { capStart: "bogie", capEnd: "bogie" });
  }
  const r0 = head ? -half * 0.55 : -half * 0.3;
  const r1 = head ? -half * 0.05 : half * 0.3;
  m.loft(
    [r0, r0 + 0.3, r1 - 0.3, r1].map((y, i) => superRing(y, (i === 0 || i === 3 ? 0.36 : 0.42) * a0, H - 0.05, H + (i === 0 || i === 3 ? 0.16 : 0.3) * STYLE_H, 5, 24)),
    "roofbox",
    { capStart: "roofbox", capEnd: "roofbox" },
  );
  return {
    mesh: m,
    params: {
      a0, H, zBot, half, bodyEnd, noseLen: s.noseLen, nose: NOSE[s.nose], window: s.window,
      doors: s.doors.map((d) => d * s.L - (head ? s.noseLen * 0.25 : 0)), stripe: s.stripe, head: head ? 1 : 0,
    },
  };
}

function bus() {
  const m = new Mesh();
  const L = 12.5;
  const a0 = (2.55 * 1.55) / 2;
  const H = 3.5 * 1.25;
  const zBot = 0.42 * 1.25;
  const span = H - zBot;
  const half = L / 2;
  const section = (y) => {
    let a = a0;
    let top = H;
    let bot = zBot;
    if (y > half - 0.9) {
      const t = (y - (half - 0.9)) / 0.9;
      a *= 1 - 0.05 * t - 0.06 * t ** 4;
      top -= 0.05 * span * t + 0.08 * span * t ** 4;
      bot += 0.04 * span * t ** 4;
    }
    if (y < -half + 0.5) {
      const t = (-half + 0.5 - y) / 0.5;
      a *= 1 - 0.07 * t * t;
      top -= 0.05 * span * t * t;
      bot += 0.04 * span * t * t;
    }
    return { a, top, bot };
  };
  const ys = [-half, -half + 0.12, -half + 0.3, -half + 0.5];
  for (let i = 1; i <= 8; i++) ys.push(-half + 0.5 + ((L - 1.4) * i) / 8);
  for (let i = 1; i <= 10; i++) ys.push(half - 0.9 + 0.9 * (1 - (1 - i / 10) ** 1.5));
  m.loft(ys.map((y) => {
    const q = section(y);
    return superRing(y, q.a, q.bot, q.top, 5, 44);
  }), "body", { capStart: "rear", capEnd: "front" });
  m.loft([-3.2, -2.9, 0.9, 1.2].map((y, i) => superRing(y, (i === 0 || i === 3 ? 0.36 : 0.42) * a0, H - 0.04, H + (i === 0 || i === 3 ? 0.18 : 0.34), 6, 24)), "roofbox", { capStart: "roofbox", capEnd: "roofbox" });
  for (const cy of [half - 2.7, -half + 3.1]) {
    for (const side of [1, -1]) m.wheel(side * (a0 - 0.12), cy, 0.62, 0.62, 0.36, "tyre", "hub");
  }
  return { mesh: m, params: { a0, H, zBot, half, length: L } };
}

// --- Flugzeug (A320-Maße), wie in build-plane-sprites.mjs ----------------------
const RF = 1.98;
const NOSE_Y = 11.8;
const TAIL_Y = -8.8;
const Z_TIP = -0.42;
function fuselage(y) {
  if (y > NOSE_Y) {
    const t = Math.min(1, (y - NOSE_Y) / 7.0);
    return {
      a: RF * Math.pow(Math.max(0, 1 - Math.pow(t, 2.6)), 0.55),
      top: Z_TIP + (RF - Z_TIP) * Math.pow(Math.max(0, 1 - t * t), 0.6),
      bot: Z_TIP + (-RF - Z_TIP) * Math.pow(Math.max(0, 1 - Math.pow(t, 3.2)), 0.5),
    };
  }
  if (y < TAIL_Y) {
    const t = Math.min(1, (TAIL_Y - y) / 10.0);
    return { a: RF * (1 - 0.86 * Math.pow(t, 1.15)), top: RF + (1.25 - RF) * Math.pow(t, 1.6), bot: -RF + (0.75 + RF) * Math.pow(t, 1.1) };
  }
  return { a: RF, top: RF, bot: -RF };
}
function plane() {
  const m = new Mesh();
  const ys = [];
  for (let i = 0; i <= 20; i++) ys.push(-18.8 + (10 * i) / 20);
  for (let i = 1; i < 6; i++) ys.push(TAIL_Y + ((NOSE_Y - TAIL_Y) * i) / 6);
  for (let i = 0; i <= 26; i++) ys.push(NOSE_Y + 7.0 * (1 - Math.pow(1 - i / 26, 1.6)) * 0.997);
  const M = 40;
  m.loft(ys.map((y) => {
    const f = fuselage(y);
    const c = (f.top + f.bot) / 2;
    const b = (f.top - f.bot) / 2;
    return Array.from({ length: M }, (_, j) => {
      const phi = (2 * Math.PI * j) / M;
      return [f.a * Math.cos(phi), y, c + b * Math.sin(phi)];
    });
  }), "body", { capStart: "tailcap", capEnd: "body" });
  const wing = ({ x0, x1, le0, le1, c0, c1, z0, dihedral, t0, t1, side, stations = 14 }) => {
    const rings = [];
    for (let k = 0; k <= stations; k++) {
      const s = k / stations;
      const x = x0 + (x1 - x0) * s;
      const le = le0 + (le1 - le0) * s;
      const c = c0 + (c1 - c0) * s;
      const t = t0 + (t1 - t0) * s;
      const z = z0 + (x - x0) * Math.tan(dihedral * RAD);
      const ring = [];
      for (const u of US) ring.push([side * x, le - u * c, z + c * (naca(u, t) + 0.018 * Math.sin(Math.PI * u))]);
      for (const u of [...US].reverse().slice(1, -1)) ring.push([side * x, le - u * c, z + c * (-naca(u, t) + 0.018 * Math.sin(Math.PI * u))]);
      rings.push(ring);
    }
    m.loft(rings, "wing", { capEnd: "wing" });
  };
  for (const side of [1, -1]) {
    wing({ x0: 1.2, x1: 17.9, le0: 4.0, le1: -3.9, c0: 6.6, c1: 1.55, z0: -1.25, dihedral: 5.5, t0: 0.14, t1: 0.1, side });
    wing({ x0: 0.6, x1: 6.3, le0: -13.4, le1: -16.9, c0: 3.9, c1: 1.35, z0: 0.82, dihedral: 6, t0: 0.1, t1: 0.09, side, stations: 8 });
  }
  {
    const rings = [];
    for (let k = 0; k <= 12; k++) {
      const s = k / 12;
      const z = 1.2 + 6.4 * s;
      const le = -10.6 - (z - 1.2) * Math.tan(36 * RAD);
      const c = 7.4 + (2.9 - 7.4) * s;
      const t = 0.11 - 0.02 * s;
      const ring = [];
      for (const u of US) ring.push([c * naca(u, t), le - u * c, z]);
      for (const u of [...US].reverse().slice(1, -1)) ring.push([-c * naca(u, t), le - u * c, z]);
      rings.push(ring);
    }
    m.loft(rings, "fin", { capEnd: "fin" });
  }
  for (const side of [1, -1]) {
    const cx = side * 5.8;
    const cz = -2.0;
    const rings = [];
    for (let k = 0; k <= 16; k++) {
      const s = k / 16;
      const y = 4.6 - 6.0 * s;
      const r = s < 0.12 ? 0.95 * (0.86 + 0.14 * Math.sin((Math.PI / 2) * (s / 0.12))) : 0.95 * (1 - 0.36 * Math.pow((s - 0.12) / 0.88, 1.6));
      rings.push(Array.from({ length: 28 }, (_, j) => {
        const phi = (2 * Math.PI * j) / 28;
        return [cx + r * Math.cos(phi), y, cz + r * Math.sin(phi)];
      }));
    }
    m.loft(rings, "engine", { capStart: "intake", capEnd: "exhaust" });
  }
  return { mesh: m, params: { length: 37.6 } };
}

/**
 * Netz als Binärdatei: „BLM1", Eckenzahl, Indexzahl (je uint32), dann je Ecke
 * 7 float32 (Lage, Normale, Material), dann uint16-Indizes. Gleiche Ecken
 * (selber Punkt, selbe Normale, selbes Material) werden zusammengelegt.
 */
function encode(mesh) {
  const ids = new WeakMap();
  let next = 0;
  const id = (o) => {
    if (!ids.has(o)) ids.set(o, next++);
    return ids.get(o);
  };
  const index = new Map();
  const verts = [];
  const idx = [];
  for (const [P, N, mat] of mesh.tris) {
    for (let k = 0; k < 3; k++) {
      const key = `${id(P[k])}|${id(N[k])}|${mat}`;
      let i = index.get(key);
      if (i === undefined) {
        i = verts.length / 7;
        index.set(key, i);
        verts.push(P[k][0], P[k][1], P[k][2], N[k][0], N[k][1], N[k][2], MAT[mat]);
      }
      idx.push(i);
    }
  }
  const nv = verts.length / 7;
  if (nv > 65535) throw new Error(`zu viele Ecken: ${nv}`);
  const buf = Buffer.alloc(12 + verts.length * 4 + idx.length * 2);
  buf.write("BLM1", 0, "ascii");
  buf.writeUInt32LE(nv, 4);
  buf.writeUInt32LE(idx.length, 8);
  let o = 12;
  for (const v of verts) {
    buf.writeFloatLE(v, o);
    o += 4;
  }
  for (const i of idx) {
    buf.writeUInt16LE(i, o);
    o += 2;
  }
  return { buf, nv, ni: idx.length };
}

mkdirSync(OUT_DIR, { recursive: true });
const specs = {};
const write = (name, model) => {
  const { buf, nv, ni } = encode(model.mesh);
  writeFileSync(path.join(OUT_DIR, `${name}.bin`), buf);
  console.log(`✓ ${name}: ${nv} Ecken, ${ni / 3} Dreiecke, ${(buf.length / 1024).toFixed(0)} KB`);
};
for (const [name, s] of Object.entries(RAIL)) {
  const head = railCar(s, "head");
  const mid = railCar(s, "mid");
  write(`${name}-head`, head);
  write(`${name}-mid`, mid);
  specs[name] = { length: s.L, head: head.params, mid: mid.params };
}
{
  const b = bus();
  write("bus", b);
  specs.bus = { length: b.params.length, head: b.params };
}
write("plane", plane());
specs.plane = { length: 37.6 };

writeFileSync(
  path.join(ROOT, "lib/live/liveModelSpecs.ts"),
  `/**\n * Maße der 3D-Modelle der Live-Ansicht — ERZEUGT von\n * \`server/scripts/build-live-models.mjs\`, nicht von Hand ändern. Gehen an die\n * Karten-Ebene (\`modules/live-models\`): Länge für die Wagenkette, der Rest für\n * die Farben, die der Shader auf den Körper malt.\n */\nexport const LIVE_MODEL_SPECS = ${JSON.stringify(specs, null, 2)} as const;\n\nexport type LiveModelSet = keyof typeof LIVE_MODEL_SPECS;\n`,
);
console.log("✓ lib/live/liveModelSpecs.ts");
