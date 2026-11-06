/**
 * DIE VORSCHAU-BILDER DES KARTENTYP-BLATTES (`MapStylePreview.tsx`).
 *
 * Fünf Bilder EINES echten Ortes, deckungsgleich: Dunkel und Hell (je flach
 * und als 3D-Ebene mit den Häusern) und Satellit. Das Blatt blendet zwischen
 * ihnen über — weil alle denselben Ausschnitt in derselben Projektion zeigen,
 * wechselt dabei nur der Stil, nicht der Ort.
 *
 * Quellen:
 *  - Dunkel/Hell: die Vektorkacheln der App-Karte (OpenFreeMap, Schema
 *    OpenMapTiles, Daten © OpenStreetMap-Mitwirkende, ODbL), gezeichnet in den
 *    Farben aus `components/surroundings/mapStyle.ts` — die liest das Skript
 *    dort aus, damit die Vorschau beim nächsten Lauf jede Paletten-Änderung
 *    mitnimmt. Häuser in 3D aus `render_height` der Kacheln.
 *  - Satellit: Digitales Orthophoto NRW (Geobasis NRW), Lizenz „Datenlizenz
 *    Deutschland – Zero" (dl-de/zero-2-0): „Jede Nutzung ist ohne
 *    Einschränkungen oder Bedingungen zulässig." Darum darf der Ausschnitt in
 *    die App. Andere Luftbilder der App (Esri) dürften das NICHT.
 *
 * Die 3D-Ebene ist eine Schrägansicht von vorn (Dach nach oben rechts
 * versetzt), mit verdeckten Wänden weggelassen und von hinten nach vorn
 * gezeichnet — durchsichtig außerhalb der Häuser, sie liegt in der App über dem
 * flachen Bild.
 *
 * Aufruf (aus server/):
 *   node scripts/build-map-previews.mjs                → schreibt assets/map-previews/
 *   node scripts/build-map-previews.mjs --probe DIR lat,lon[,spanM] …
 *                                                       → Probebilder zum Aussuchen
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT_DIR = path.join(ROOT, "assets/map-previews");

/**
 * Der Ort: Köln, Rheinauhafen am Schokoladenmuseum (ausgesucht 06.11.2026 aus
 * zehn Proben in NRW). Auf einem Bild: Altstadt-Blöcke, die Uferstraße,
 * Grünstreifen, Hafenbecken mit Drehbrücke und das runde Museum — Häuser für
 * 3D, Wasser und Grün für die Farben, und ein Sommer-Luftbild (andere Kreise
 * sind im Winter beflogen, kahle Bäume). Der Punkt in der Mitte steht auf der
 * Uferstraße. `spanM` = Breite in Mercator-Metern (≈ Zoom 15,7 auf einer
 * 353-dp-Karte). Muss in EINER z14-Kachel liegen (siehe unten).
 */
const PLACE = { lat: 50.9322, lon: 6.9628, spanM: 520 };

/** Bildgröße — Seitenverhältnis der Vorschau-Karte (360 : 176). */
const W = 1000;
const H = Math.round((W * 176) / 360);

/** Px je dp der Karte bei 353 dp Breite — für Linienbreiten aus dem Stil. */
const PX_PER_DP = W / 353;

/** Schrägansicht: Dachversatz je Meter Höhe (px), Höhe gedeckelt. */
const LIFT_Y = 1.5;
const LIFT_X = 0.4 * LIFT_Y;
const MAX_H = 40;

// ── Paletten aus der App ─────────────────────────────────────────────────────

function readPalette(name) {
  const src = readFileSync(path.join(ROOT, "components/surroundings/mapStyle.ts"), "utf8");
  const start = src.indexOf(`export const ${name}: MapPalette = {`);
  if (start < 0) throw new Error(`${name} nicht gefunden`);
  const end = src.indexOf("\n};", start);
  const out = {};
  for (const m of src.slice(start, end).matchAll(/^\s+(\w+): "(#[0-9A-Fa-f]{6})"/gm)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

// ── Vektorkacheln (Mapbox Vector Tile, ohne Fremdpaket) ──────────────────────

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    b = buf[pos.i++];
    result += (b & 0x7f) * 2 ** shift;
    shift += 7;
  } while (b & 0x80);
  return result;
}
function eachField(buf, start, end, fn) {
  const pos = { i: start };
  while (pos.i < end) {
    const key = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) fn(field, readVarint(buf, pos));
    else if (wire === 2) {
      const len = readVarint(buf, pos);
      fn(field, [pos.i, pos.i + len]);
      pos.i += len;
    } else if (wire === 5) {
      fn(field, buf.readFloatLE(pos.i));
      pos.i += 4;
    } else if (wire === 1) {
      fn(field, buf.readDoubleLE(pos.i));
      pos.i += 8;
    } else throw new Error(`Drahttyp ${wire}`);
  }
}
const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);
function packed(buf, [s, e]) {
  const out = [];
  const pos = { i: s };
  while (pos.i < e) out.push(readVarint(buf, pos));
  return out;
}
function rings(g) {
  const out = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < g.length) {
    const cmd = g[i] & 7;
    const cnt = Math.floor(g[i] / 8);
    i++;
    if (cmd === 1 || cmd === 2) {
      for (let k = 0; k < cnt; k++) {
        x += zigzag(g[i++]);
        y += zigzag(g[i++]);
        if (cmd === 1) {
          cur = [[x, y]];
          out.push(cur);
        } else cur.push([x, y]);
      }
    }
  }
  return out;
}
function decodeTile(buf) {
  const layers = {};
  eachField(buf, 0, buf.length, (f, v) => {
    if (f !== 3) return;
    const L = { name: "", keys: [], values: [], raw: [], extent: 4096 };
    eachField(buf, v[0], v[1], (lf, lv) => {
      if (lf === 1) L.name = buf.toString("utf8", lv[0], lv[1]);
      else if (lf === 2) L.raw.push(lv);
      else if (lf === 3) L.keys.push(buf.toString("utf8", lv[0], lv[1]));
      else if (lf === 4) {
        let val = null;
        eachField(buf, lv[0], lv[1], (vf, vv) => {
          if (vf === 1) val = buf.toString("utf8", vv[0], vv[1]);
          else if (vf === 6) val = zigzag(vv);
          else if (vf === 7) val = !!vv;
          else val = vv;
        });
        L.values.push(val);
      } else if (lf === 5) L.extent = lv;
    });
    L.features = L.raw.map((range) => {
      let tags = [];
      let type = 0;
      let geom = [];
      eachField(buf, range[0], range[1], (ff, fv) => {
        if (ff === 2) tags = packed(buf, fv);
        else if (ff === 3) type = fv;
        else if (ff === 4) geom = packed(buf, fv);
      });
      const props = {};
      for (let i = 0; i < tags.length; i += 2) props[L.keys[tags[i]]] = L.values[tags[i + 1]];
      return { type, props, rings: rings(geom) };
    });
    layers[L.name] = L;
  });
  return layers;
}

// ── Projektion ───────────────────────────────────────────────────────────────

const EARTH = 40075016.686;
function crop(place) {
  const nx = (place.lon + 180) / 360;
  const lat = (place.lat * Math.PI) / 180;
  const ny = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
  const w = place.spanM / EARTH;
  const h = (w * H) / W;
  return { x0: nx - w / 2, y0: ny - h / 2, x1: nx + w / 2, y1: ny + h / 2 };
}

async function fetchVectorFeatures(box) {
  const tj = await (await fetch("https://tiles.openfreemap.org/planet")).json();
  const tmpl = tj.tiles[0];
  const z = 14;
  const n = 2 ** z;
  const tx0 = Math.floor(box.x0 * n);
  const tx1 = Math.floor(box.x1 * n);
  const ty0 = Math.floor(box.y0 * n);
  const ty1 = Math.floor(box.y1 * n);
  if (tx0 !== tx1 || ty0 !== ty1) {
    // Über eine Kachelgrenze hinweg kämen Häuser zerschnitten an — ihre
    // Schnittkanten würden in 3D zu falschen Wänden.
    throw new Error("Ausschnitt liegt über einer Kachelgrenze — Mitte leicht verschieben.");
  }
  const url = tmpl.replace("{z}", z).replace("{x}", tx0).replace("{y}", ty0);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kachel ${url}: ${res.status}`);
  const layers = decodeTile(Buffer.from(await res.arrayBuffer()));
  // Kachelkoordinaten → Bildpunkte.
  const toPx = (L) => ([x, y]) => [
    (((tx0 + x / L.extent) / n - box.x0) / (box.x1 - box.x0)) * W,
    (((ty0 + y / L.extent) / n - box.y0) / (box.y1 - box.y0)) * H,
  ];
  const out = {};
  for (const [name, L] of Object.entries(layers)) {
    const p = toPx(L);
    out[name] = L.features.map((f) => ({ ...f, rings: f.rings.map((r) => r.map(p)) }));
  }
  return out;
}

async function fetchOrthophoto(box) {
  const mx = (nx) => nx * EARTH - EARTH / 2;
  const my = (ny) => EARTH / 2 - ny * EARTH;
  const bbox = [mx(box.x0), my(box.y1), mx(box.x1), my(box.y0)].map((v) => v.toFixed(2)).join(",");
  const url =
    "https://www.wms.nrw.de/geobasis/wms_nw_dop?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
    `&LAYERS=nw_dop_rgb&STYLES=&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${W * 2}&HEIGHT=${H * 2}&FORMAT=image/jpeg`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) throw new Error(`Luftbild: ${res.status} ${type}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Zeichnen ─────────────────────────────────────────────────────────────────

const f1 = (v) => v.toFixed(1);
const ringPath = (r, close = true) =>
  `M${r.map(([x, y]) => `${f1(x)} ${f1(y)}`).join("L")}${close ? "Z" : ""}`;
const areaOf = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const polyPath = (f) => f.rings.map((r) => ringPath(r)).join("");
const fillLayer = (feats, color, filter = () => true) =>
  feats
    .filter((f) => f.type === 3 && filter(f.props))
    .map((f) => `<path fill-rule="evenodd" fill="${color}" d="${polyPath(f)}"/>`)
    .join("");
const lineLayer = (feats, color, widthDp, filter, extra = "") =>
  feats
    .filter((f) => f.type === 2 && filter(f.props))
    .map(
      (f) =>
        `<path fill="none" stroke="${color}" stroke-width="${f1(widthDp * PX_PER_DP)}" stroke-linecap="round" stroke-linejoin="round" ${extra} d="${f.rings.map((r) => ringPath(r, false)).join("")}"/>`,
    )
    .join("");

/** Straßen-Stufen wie im Stil (`mapStyle.ts`), Breiten bei Zoom 16 (dp). */
const ROADS = [
  { test: (c) => c === "minor" || c === "service", fill: 5.2, casing: 7, key: "roadMinor", cas: "roadMinorCasing" },
  { test: (c) => c === "secondary" || c === "tertiary", fill: 7, casing: 8.8, key: "roadSecondary", cas: "roadSecondaryCasing" },
  { test: (c) => c === "primary", fill: 8.5, casing: 10.5, key: "roadPrimary", cas: "roadPrimaryCasing" },
  { test: (c) => c === "trunk" || c === "motorway", fill: 10, casing: 12.5, key: "roadTrunk", cas: "roadTrunkCasing" },
];

function baseSvg(feats, p) {
  const T = feats.transportation ?? [];
  const surface = (pr) => pr.brunnel !== "tunnel";
  let g = `<rect width="${W}" height="${H}" fill="${p.bg}"/>`;
  g += fillLayer(feats.landuse ?? [], p.residential, (pr) =>
    ["residential", "suburb", "neighbourhood", "commercial", "retail"].includes(pr.class),
  );
  g += fillLayer(feats.landcover ?? [], p.wood, (pr) => pr.class === "wood");
  g += fillLayer(feats.landcover ?? [], p.grass ?? p.park, (pr) => pr.class === "grass" || pr.class === "wetland");
  g += fillLayer(feats.park ?? [], p.park);
  g += fillLayer(feats.water ?? [], p.water, (pr) => pr.brunnel !== "tunnel");
  g += lineLayer(feats.waterway ?? [], p.waterway ?? p.water, 2.5, (pr) => pr.brunnel !== "tunnel");
  const outline = p.buildingOutline ? ` stroke="${p.buildingOutline}" stroke-width="1"` : "";
  g += (feats.building ?? [])
    .filter((f) => f.type === 3)
    .map((f) => `<path fill-rule="evenodd" fill="${p.building}"${outline} d="${polyPath(f)}"/>`)
    .join("");
  g += lineLayer(T, p.path ?? mix(p.roadMinor, p.bg, 0.4), 2, (pr) => (pr.class === "path" || pr.class === "track") && surface(pr) && pr.subclass !== "pedestrian");
  g += lineLayer(T, p.rail, 1.6, (pr) => (pr.class === "rail" || pr.class === "transit") && surface(pr));
  if (p.roadMinorCasing) {
    for (const r of ROADS) g += lineLayer(T, p[r.cas], r.casing, (pr) => surface(pr) && r.test(pr.class));
  }
  for (const r of ROADS) g += lineLayer(T, p[r.key], r.fill, (pr) => surface(pr) && r.test(pr.class));
  return g;
}

/** Die Häuser als Körper — verdeckte Wände weg, hinten zuerst. */
function extrusionSvg(feats, s) {
  const vx = LIFT_X;
  const vy = -LIFT_Y;
  const depth = (x, y) => vx * x + vy * y; // größer = weiter hinten
  const items = [];
  for (const f of feats.building ?? []) {
    if (f.type !== 3 || f.props.hide_3d) continue;
    const h = Math.min(MAX_H, Number(f.props.render_height ?? 10));
    const h0 = Math.min(h, Number(f.props.render_min_height ?? 0));
    if (h <= h0) continue;
    const sign = Math.sign(areaOf(f.rings[0])) || 1;
    const walls = [];
    for (const r of f.rings) {
      for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i];
        const [x2, y2] = r[(i + 1) % r.length];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 0.01) continue;
        // Nach außen zeigende Normale (Bildpunkte, y nach unten).
        const nx = (sign * dy) / len;
        const ny = (sign * -dx) / len;
        if (nx * vx + ny * vy >= 0) continue; // vom Betrachter weg
        const t = Math.max(0, Math.min(1, 0.5 - 0.5 * nx - 0.2 * ny));
        const a0 = [x1 + vx * h0, y1 + vy * h0];
        const b0 = [x2 + vx * h0, y2 + vy * h0];
        const a1 = [x1 + vx * h, y1 + vy * h];
        const b1 = [x2 + vx * h, y2 + vy * h];
        walls.push({
          d: depth((x1 + x2) / 2, (y1 + y2) / 2),
          svg: `<path fill="${mix(s.wallDark, s.wallLight, t)}" d="${ringPath([a0, b0, b1, a1])}"/>`,
        });
      }
    }
    walls.sort((a, b) => b.d - a.d);
    const roof = f.rings.map((r) => ringPath(r.map(([x, y]) => [x + vx * h, y + vy * h]))).join("");
    let cx = 0;
    let cy = 0;
    for (const [x, y] of f.rings[0]) {
      cx += x;
      cy += y;
    }
    cx /= f.rings[0].length;
    cy /= f.rings[0].length;
    items.push({
      d: depth(cx, cy),
      svg: walls.map((w) => w.svg).join("") + `<path fill-rule="evenodd" fill="${s.roof}" stroke="${s.roofEdge}" stroke-width="0.8" d="${roof}"/>`,
    });
  }
  items.sort((a, b) => b.d - a.d);
  return items.map((i) => i.svg).join("");
}

const svgDoc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
const render = (body) => sharp(Buffer.from(svgDoc(body))).png().toBuffer();

async function buildPlace(place) {
  const box = crop(place);
  const [feats, photo] = await Promise.all([fetchVectorFeatures(box), fetchOrthophoto(box)]);
  const dark = readPalette("DARK_PALETTE");
  const light = readPalette("LIGHT_PALETTE");
  const darkShades = {
    roof: mix(dark.building, "#FFFFFF", 0.16),
    roofEdge: mix(dark.building, "#FFFFFF", 0.24),
    wallDark: mix(dark.building, "#000000", 0.3),
    wallLight: mix(dark.building, "#FFFFFF", 0.07),
  };
  const lightShades = {
    roof: mix(light.building, "#FFFFFF", 0.65),
    roofEdge: mix(light.building, "#000000", 0.08),
    wallDark: mix(light.building, "#000000", 0.2),
    wallLight: mix(light.building, "#000000", 0.05),
  };
  return {
    dark: await render(baseSvg(feats, dark)),
    dark3d: await render(extrusionSvg(feats, darkShades)),
    light: await render(baseSvg(feats, light)),
    light3d: await render(extrusionSvg(feats, lightShades)),
    // Auf Bildgröße, eine Spur satter — Luftbilder wirken verkleinert flau.
    satellite: await sharp(photo).resize(W, H).modulate({ saturation: 1.12 }).sharpen({ sigma: 0.6 }).png().toBuffer(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--probe") {
    const dir = args[1];
    mkdirSync(dir, { recursive: true });
    for (const spec of args.slice(2)) {
      const [lat, lon, spanM] = spec.split(",").map(Number);
      const out = await buildPlace({ lat, lon, spanM: spanM || PLACE.spanM });
      for (const [k, buf] of Object.entries(out)) writeFileSync(path.join(dir, `${spec}_${k}.png`), buf);
      console.log("probe", spec);
    }
    return;
  }
  const out = await buildPlace(PLACE);
  mkdirSync(OUT_DIR, { recursive: true });
  // Die gezeichneten Stile verlustfrei (flache Flächen, scharfe Kanten — verlustbehaftet
  // franste jede Kante aus), das Luftbild verlustbehaftet.
  const webp = (buf, photo) =>
    sharp(buf).webp(photo ? { quality: 80, effort: 6 } : { lossless: true, effort: 6 }).toBuffer();
  for (const [k, buf] of Object.entries(out)) {
    const file = path.join(OUT_DIR, `${k === "dark3d" ? "dark-3d" : k === "light3d" ? "light-3d" : k}.webp`);
    const data = await webp(buf, k === "satellite");
    writeFileSync(file, data);
    console.log(path.relative(ROOT, file), `${Math.round(data.length / 1024)} KB`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
