/**
 * Kleiner 3D-Renderer für die vorgerenderten Fahrzeuge der Live-Ansicht
 * (Flugzeug, Bahnwagen, Bus): Netz aus Röhren („Loft"), Tiefenpuffer, glatte
 * Normalen, Licht wie MapLibres Standardlicht, Glanz, Überabtastung gegen
 * Treppen, ein Hauch dunkler Rand. Kein Blender nötig, nur sharp.
 *
 * Koordinaten: x rechts, y vorn, z oben, Meter. Der Ursprung landet in der
 * Bildmitte — dort setzt die Karte das Bild an (`icon-anchor: center`).
 */
import sharp from "sharp";

export const RAD = Math.PI / 180;
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** Symmetrisches Profil (NACA 00xx), Dicke t, entlang u = 0 … 1. */
export const naca = (u, t) => 5 * t * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
export const US = Array.from({ length: 14 }, (_, i) => (1 - Math.cos((Math.PI * i) / 13)) / 2);

/** Querschnitt als Superellipse (n = 2 Ellipse, größer = kantiger), M Punkte. */
export function superRing(y, a, zBot, zTop, n, M, cx = 0) {
  const zc = (zBot + zTop) / 2;
  const b = (zTop - zBot) / 2;
  const e = 2 / n;
  return Array.from({ length: M }, (_, j) => {
    const phi = (2 * Math.PI * j) / M;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    return [cx + a * Math.sign(c) * Math.abs(c) ** e, y, zc + b * Math.sign(s) * Math.abs(s) ** e];
  });
}

export class Mesh {
  constructor() {
    /** [[p0,p1,p2], [n0,n1,n2], Material] */
    this.tris = [];
  }

  /**
   * Röhre aus Ringen gleicher Punktzahl — glatte Normalen aus dem Gitter, nach
   * außen gedreht. Deckel als Fächer (`capStart`/`capEnd` = Material).
   */
  loft(rings, mat, { capStart, capEnd, closed = true } = {}) {
    const R = rings.length;
    const M = rings[0].length;
    const center = rings.map((ring) => ring.reduce((s, p) => [s[0] + p[0] / M, s[1] + p[1] / M, s[2] + p[2] / M], [0, 0, 0]));
    const normal = (i, j) => {
      const jp = closed ? (j + 1) % M : Math.min(M - 1, j + 1);
      const jm = closed ? (j - 1 + M) % M : Math.max(0, j - 1);
      const t1 = sub(rings[i][jp], rings[i][jm]);
      const t2 = sub(rings[Math.min(R - 1, i + 1)][j], rings[Math.max(0, i - 1)][j]);
      let nn = norm(cross(t1, t2));
      if (dot(nn, sub(rings[i][j], center[i])) < 0) nn = [-nn[0], -nn[1], -nn[2]];
      return nn;
    };
    const N = rings.map((ring, i) => ring.map((_, j) => normal(i, j)));
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < (closed ? M : M - 1); j++) {
        const j2 = (j + 1) % M;
        const a = rings[i][j], b = rings[i][j2], c = rings[i + 1][j2], d = rings[i + 1][j];
        this.tris.push([[a, b, c], [N[i][j], N[i][j2], N[i + 1][j2]], mat], [[a, c, d], [N[i][j], N[i + 1][j2], N[i + 1][j]], mat]);
      }
    }
    const cap = (i, m, outward) => {
      const c = center[i];
      const nn = norm(outward);
      for (let j = 0; j < M; j++) this.tris.push([[c, rings[i][j], rings[i][(j + 1) % M]], [nn, nn, nn], m]);
    };
    if (capStart) cap(0, capStart, sub(center[0], center[Math.min(1, R - 1)]));
    if (capEnd) cap(R - 1, capEnd, sub(center[R - 1], center[Math.max(0, R - 2)]));
  }

  /** Rad bzw. Zylinder um eine Achse parallel zu x. */
  wheel(cx, cy, cz, r, width, mat, hubMat) {
    const M = 22;
    const ring = (x, rr) => Array.from({ length: M }, (_, j) => {
      const phi = (2 * Math.PI * j) / M;
      return [x, cy + rr * Math.cos(phi), cz + rr * Math.sin(phi)];
    });
    const x0 = cx - width / 2;
    const x1 = cx + width / 2;
    this.loft([ring(x0, r * 0.9), ring(x0 + width * 0.15, r), ring(x1 - width * 0.15, r), ring(x1, r * 0.9)], mat, { capStart: hubMat, capEnd: hubMat });
  }
}

/** Licht in Kamera-Koordinaten (x rechts, y vorn am Boden, z oben). */
export function lighting(pitch) {
  const light = norm([Math.sin(210 * RAD) * Math.sin(30 * RAD), Math.cos(210 * RAD) * Math.sin(30 * RAD), Math.cos(30 * RAD)]);
  const cosT = Math.cos(pitch * RAD);
  const sinT = Math.sin(pitch * RAD);
  const viewer = [0, -sinT, cosT];
  const half = norm([light[0] + viewer[0], light[1] + viewer[1], light[2] + viewer[2]]);
  /** Farbe einer Stelle mit Normale n (Welt) — Himmel, Sonne, Glanz, Kante. */
  const lit = (base, n, { spec = 0.3, gloss = 36 } = {}) => {
    const diff = Math.max(0, dot(n, light));
    const sky = 0.36 + 0.16 * n[2];
    const s = Math.pow(Math.max(0, dot(n, half)), gloss) * spec;
    const rim = 0.05 * Math.pow(1 - Math.max(0, dot(n, viewer)), 3);
    return base.map((ch) => Math.min(1, ch * (sky + 0.6 * diff) + s + rim));
  };
  return { cosT, sinT, viewer, lit };
}

/**
 * Eine Ansicht: Modell um `yaw` (Grad im Uhrzeigersinn, 0 = Nase zeigt im
 * Bild nach oben) gedreht, aus `pitch` gesehen. `shade(mat, nWelt, pModell,
 * nModell, lit)` liefert die Farbe. Ergebnis: PNG, symmetrisch um den
 * Ursprung zugeschnitten (der Ankerpunkt bleibt die Bildmitte).
 */
export async function renderView(mesh, { pitch, yaw, pxPerM, radius, shade, ss = 4, rim = true }) {
  const { cosT, sinT, viewer, lit } = lighting(pitch);
  const out = Math.ceil(radius * 2 * pxPerM / 2) * 2;
  const N = out * ss;
  const PX = pxPerM * ss;
  const psi = yaw * RAD;
  const f = [Math.sin(psi), Math.cos(psi), 0];
  const r = [Math.cos(psi), -Math.sin(psi), 0];
  const toWorld = (p) => [p[0] * r[0] + p[1] * f[0], p[0] * r[1] + p[1] * f[1], p[2]];
  const rgba = new Float32Array(N * N * 4);
  const depth = new Float32Array(N * N).fill(Infinity);
  for (const [P, Nn, mat] of mesh.tris) {
    const W = P.map(toWorld);
    const S = W.map((w) => [N / 2 + w[0] * PX, N / 2 - (w[1] * cosT + w[2] * sinT) * PX, w[1] * sinT - w[2] * cosT]);
    const minX = Math.max(0, Math.floor(Math.min(S[0][0], S[1][0], S[2][0])));
    const maxX = Math.min(N - 1, Math.ceil(Math.max(S[0][0], S[1][0], S[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(S[0][1], S[1][1], S[2][1])));
    const maxY = Math.min(N - 1, Math.ceil(Math.max(S[0][1], S[1][1], S[2][1])));
    const area = (S[1][0] - S[0][0]) * (S[2][1] - S[0][1]) - (S[2][0] - S[0][0]) * (S[1][1] - S[0][1]);
    if (Math.abs(area) < 1e-9) continue;
    const NW = Nn.map(toWorld);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((S[1][0] - px) * (S[2][1] - py) - (S[2][0] - px) * (S[1][1] - py)) / area;
        const w1 = ((S[2][0] - px) * (S[0][1] - py) - (S[0][0] - px) * (S[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * S[0][2] + w1 * S[1][2] + w2 * S[2][2];
        const idx = y * N + x;
        if (z >= depth[idx]) continue;
        depth[idx] = z;
        let n = norm([0, 1, 2].map((k) => w0 * NW[0][k] + w1 * NW[1][k] + w2 * NW[2][k]));
        let nm = norm([0, 1, 2].map((k) => w0 * Nn[0][k] + w1 * Nn[1][k] + w2 * Nn[2][k]));
        if (dot(n, viewer) < -0.05) {
          n = [-n[0], -n[1], -n[2]];
          nm = [-nm[0], -nm[1], -nm[2]];
        }
        const p = [0, 1, 2].map((k) => w0 * P[0][k] + w1 * P[1][k] + w2 * P[2][k]);
        const c = shade(mat, n, p, nm, lit);
        rgba[idx * 4] = c[0];
        rgba[idx * 4 + 1] = c[1];
        rgba[idx * 4 + 2] = c[2];
        rgba[idx * 4 + 3] = 1;
      }
    }
  }
  const buf = Buffer.alloc(N * N * 4);
  const RIM = 3;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (rgba[i * 4 + 3] > 0) {
        buf[i * 4] = Math.round(rgba[i * 4] * 255);
        buf[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * 255);
        buf[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * 255);
        buf[i * 4 + 3] = 255;
        continue;
      }
      if (!rim) continue;
      let near = false;
      for (let dy = -RIM; dy <= RIM && !near; dy++) {
        for (let dx = -RIM; dx <= RIM && !near; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < N && yy < N && rgba[(yy * N + xx) * 4 + 3] > 0 && dx * dx + dy * dy <= RIM * RIM) near = true;
        }
      }
      if (near) {
        buf[i * 4] = 20;
        buf[i * 4 + 1] = 24;
        buf[i * 4 + 2] = 26;
        buf[i * 4 + 3] = 110;
      }
    }
  }
  const small = await sharp(buf, { raw: { width: N, height: N, channels: 4 } }).resize(out, out, { kernel: "lanczos3" }).raw().toBuffer();
  // Symmetrisch um die Mitte zuschneiden — der Anker bleibt in der Bildmitte.
  let hx = 0;
  let hy = 0;
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      if (small[(y * out + x) * 4 + 3] > 4) {
        hx = Math.max(hx, Math.abs(x + 0.5 - out / 2));
        hy = Math.max(hy, Math.abs(y + 0.5 - out / 2));
      }
    }
  }
  const w = Math.min(out, Math.ceil(hx + 1) * 2);
  const h = Math.min(out, Math.ceil(hy + 1) * 2);
  return sharp(small, { raw: { width: out, height: out, channels: 4 } })
    .extract({ left: (out - w) / 2, top: (out - h) / 2, width: w, height: h })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
