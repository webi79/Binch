/**
 * Build-Script: rendert Lucide-Icons als weiße PNG-Silhouetten für die
 * Surroundings-Marker. MapLibre registriert sie als SDF-Sprite und tönt sie
 * dann per `icon-color` paint-Property in den jeweiligen Marker-Farben.
 *
 * Output: ../../assets/marker-icons/{train,train-white,bus,tram,airport,cruise}.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-marker-icons.mjs`
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "../../assets/marker-icons");

mkdirSync(OUT_DIR, { recursive: true });

/**
 * Icon-Definitionen — direkt aus den Lucide-Quellen kopiert
 * (node_modules/lucide-react-native/dist/esm/icons/*.mjs).
 * Format: SVG-Fragmente innerhalb von <svg viewBox="0 0 24 24">.
 */
/**
 * Pro Icon: Lucide-Path + Zielfarbe (matched die Marker-Bg-Farbe in MarkerLayer).
 * Zug und Bus wie überall in der App: Lucide `Train` (= tram-front in
 * lucide-react-native) und `Bus`, Lucides Strich 2, dunkel (#14181A) — so
 * stehen sie seit den Commits 51c6038/66566de auch als Einzelbilder hier
 * (`scale` 1,62: das 24er-Raster auf 39 von 48 px). Tram, Flughafen und
 * Fähre in der alten Form (Strich 2,4, volles Raster).
 */
const ICONS = {
  train: {
    color: "#14181A",
    strokeWidth: 2,
    scale: 1.62,
    svg: `
      <rect width="16" height="16" x="4" y="3" rx="2"/>
      <path d="M4 11h16"/>
      <path d="M12 3v8"/>
      <path d="m8 19-2 3"/>
      <path d="m18 22-2-3"/>
      <path d="M8 15h.01"/>
      <path d="M16 15h.01"/>
    `,
  },
  bus: {
    color: "#14181A",
    strokeWidth: 2,
    scale: 1.62,
    svg: `
      <path d="M8 6v6"/>
      <path d="M15 6v6"/>
      <path d="M2 12h19.6"/>
      <path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/>
      <path d="M9 18h5"/>
      <circle cx="7" cy="18" r="2"/>
      <circle cx="16" cy="18" r="2"/>
    `,
  },
  tram: {
    color: "#FFFFFF",
    svg: `
      <rect width="16" height="16" x="4" y="3" rx="2"/>
      <path d="M4 11h16"/>
      <path d="M12 3v8"/>
      <path d="m8 19-2 3"/>
      <path d="m18 22-2-3"/>
      <path d="M8 15h.01"/>
      <path d="M16 15h.01"/>
    `,
  },
  airport: {
    color: "#14181A",
    svg: `
      <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
    `,
  },
  /**
   * U-Bahn: ein kräftiges „U" statt des Zug-Symbols — so kennzeichnet man
   * U-Bahnen in Deutschland (blaues Schild mit weißem U).
   */
  subway: {
    color: "#FFFFFF",
    strokeWidth: 3.4,
    // Genau mittig: Mit den runden Strich-Enden reicht das „U" von 3,35 bis
    // 20,65 (Mitte 12) und von 4,8 bis 19,2 — so groß wie die übrigen Symbole.
    svg: `<path d="M6.5 5.05v8.4a5.5 5.5 0 0 0 11 0V5.05"/>`,
  },
  cruise: {
    color: "#FFFFFF",
    svg: `
      <path d="M12 10.189V14"/>
      <path d="M12 2v3"/>
      <path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/>
      <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-8.188-3.639a2 2 0 0 0-1.624 0L3 14a11.6 11.6 0 0 0 2.81 7.76"/>
      <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1s1.2 1 2.5 1c2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>
    `,
  },
};

const ICON_SIZE = 48;
const STROKE_WIDTH = 2.4;

function svgFor(content, color, size = ICON_SIZE, strokeWidth = STROKE_WIDTH) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
  ${content}
</svg>`;
}

async function renderOne(name, def) {
  // `scale`: Pixel je Rastereinheit (24er-Raster), mittig — ohne: volles Bild.
  const size = def.scale ? 24 * def.scale : ICON_SIZE;
  const svg = svgFor(def.svg, def.color, size, def.strokeWidth ?? STROKE_WIDTH);
  const img = await loadImage(Buffer.from(svg, "utf-8"));
  const canvas = createCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, (ICON_SIZE - size) / 2, (ICON_SIZE - size) / 2, size, size);
  const png = await canvas.encode("png");
  const outPath = resolve(OUT_DIR, `${name}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ ${name}.png (${def.color}, ${png.length} bytes)`);
}

/**
 * train.png und bus.png sind gepflegt (Commits 51c6038/66566de) und weichen
 * vom Raster hier leicht ab — nicht überschreiben; ihre Definitionen oben
 * liefern nur die Symbole in den Kästen.
 */
const CURATED = new Set(["train", "bus"]);
console.log(`Rendering marker icons → ${OUT_DIR}`);
for (const [name, def] of Object.entries(ICONS)) {
  if (CURATED.has(name)) continue;
  await renderOne(name, def);
}

/** Dasselbe Bild in anderer Farbe — Form und Kantenglättung bleiben gleich. */
async function recolor(from, to, color) {
  const img = await loadImage(readFileSync(resolve(OUT_DIR, `${from}.png`)));
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, img.width, img.height);
  writeFileSync(resolve(OUT_DIR, `${to}.png`), await canvas.encode("png"));
  console.log(`✓ ${to}.png (${from}.png in ${color})`);
}
// Zug und Bus weiß — auf den farbigen Live-Punkten (LiveVehicleLayer), wie die
// Symbole in den Kästen.
await recolor("train", "train-white", "#FFFFFF");
await recolor("bus", "bus-white", "#FFFFFF");

/**
 * KÄSTEN STATT KREISE — Haltestellen als abgerundete Quadrate mit dickem
 * weißem Rand und eingebackenem Symbol (wie Schilder an der Haltestelle).
 *
 *   box-<art>.png   ein Halt mit EINER Verkehrsart: 30 dp bei Zoom 14,
 *                   in vierfacher Auflösung (120 px) — MapLibre skaliert über
 *                   icon-size nur herunter, bleibt also scharf.
 *   pill-2/3.png    weißer Rahmen um einen Halt mit mehreren Verkehrsarten,
 *   badge-<art>.png darin je Art ein farbiger Kasten mit Symbol (ebenfalls
 *                   vierfach, icon-size 0.25 bei Zoom 14 — Maße unten).
 *
 * Der Rand ist weiß und dicker als der alte dunkle Strich (3 statt 2 dp); ein
 * hauchdünner dunkler Saum außen hält ihn auch auf der hellen Karte sichtbar.
 */
/**
 * Die Farben der Verkehrsmittel der ganzen App — `TRANSIT_COLOR` in
 * lib/theme/transitColors.ts; hier von Hand gleich halten (Zug = `regional`).
 * Der Zug im satteren Bernstein statt des früheren hellen Gelbs (#FFD60A):
 * Das Symbol im Kasten ist weiß wie bei allen anderen Arten, und Weiß auf dem
 * hellen Gelb war kaum zu lesen (Kontrast 1,3 : 1). Aus demselben Grund der
 * Flughafen im dunklen Ton des Akzents (`dark` in lib/theme/accent.ts).
 */
const MODE_FILL = {
  train: "#E8A800",
  subway: "#1F3A8A",
  bus: "#9D5FE0",
  tram: "#2A2A2C",
  ferry: "#6B95B5",
  cruise: "#6B95B5",
  "airport-lime": "#5DBE34",
  "airport-mint": "#1FA877",
};
const MODE_GLYPH = {
  train: "train",
  subway: "subway",
  bus: "bus",
  tram: "tram",
  ferry: "cruise",
  cruise: "cruise",
  "airport-lime": "airport",
  "airport-mint": "airport",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * Symbol mittig einzeichnen — `scale`: Vergrößerung der Zeichenfläche (in
 * voller Auflösung rastern). In den Kästen alle mit Lucides Strich 2 wie in
 * der App; nur das „U" kräftiger, es ist ein Buchstabe.
 */
async function drawGlyph(ctx, kind, cx, cy, size, scale = 1) {
  const glyph = MODE_GLYPH[kind];
  const def = ICONS[glyph];
  const px = Math.round(size * scale);
  const stroke = glyph === "subway" ? def.strokeWidth : 2;
  // In den Kästen alle weiß.
  const img = await loadImage(Buffer.from(svgFor(def.svg, "#FFFFFF", px, stroke), "utf-8"));
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
}

/** Einzel-Halt: 30 dp (120 px), Rand 3 dp, Ecken 24 % — siehe MarkerLayer. */
async function renderBox(kind) {
  const S = 120;
  const HAIR = 2;
  const BORDER = 12;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const outer = S - 2 * HAIR;
  const r = outer * 0.24;
  roundRect(ctx, 0, 0, S, S, r + HAIR);
  ctx.fillStyle = "rgba(20, 24, 26, 0.45)";
  ctx.fill();
  roundRect(ctx, HAIR, HAIR, outer, outer, r);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  const inner = outer - 2 * BORDER;
  roundRect(ctx, HAIR + BORDER, HAIR + BORDER, inner, inner, Math.max(2, r - BORDER));
  ctx.fillStyle = MODE_FILL[kind];
  ctx.fill();
  await drawGlyph(ctx, kind, S / 2, S / 2, inner * 0.72);
  writeFileSync(resolve(OUT_DIR, `box-${kind}.png`), await canvas.encode("png"));
  console.log(`✓ box-${kind}.png`);
}

/**
 * Mehrere Verkehrsarten an EINEM Halt (gemeinsame Tafel, z. B. U-Bahn + Bus):
 * ein weißer Rahmen, darin die farbigen Kästen nebeneinander. Maße in dp bei
 * Zoom 14 (icon-size 0.25, Bilder vierfach aufgelöst): Kasten 24, Abstand 3,
 * Rand 3 — eine Reihe ist so hoch wie ein Einzel-Kasten (30). Die Mitten der
 * Kästen liegen bei ±13,5 dp (2) bzw. 0/±27 dp (3) — `MM_OFFSET_*` in
 * MarkerLayer (×4, weil icon-offset mit icon-size 0.25 multipliziert wird).
 */
const SLOT = 24;
const GAP = 3;
const RIM = 3;
async function renderPill(name, slots) {
  const SCALE = 4;
  const HAIR = 1;
  const w = RIM * 2 + SLOT * slots + GAP * (slots - 1) + HAIR * 2;
  const h = RIM * 2 + SLOT + HAIR * 2;
  const canvas = createCanvas(w * SCALE, h * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  const r = (SLOT + 2 * RIM) * 0.24;
  roundRect(ctx, 0, 0, w, h, r + HAIR);
  ctx.fillStyle = "rgba(20, 24, 26, 0.45)";
  ctx.fill();
  roundRect(ctx, HAIR, HAIR, w - 2 * HAIR, h - 2 * HAIR, r);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  writeFileSync(resolve(OUT_DIR, `${name}.png`), await canvas.encode("png"));
  console.log(`✓ ${name}.png (${w}×${h} dp @${SCALE}x)`);
}

async function renderBadge(kind) {
  const SCALE = 4;
  const canvas = createCanvas(SLOT * SCALE, SLOT * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  roundRect(ctx, 0, 0, SLOT, SLOT, SLOT * 0.2);
  ctx.fillStyle = MODE_FILL[kind];
  ctx.fill();
  await drawGlyph(ctx, kind, SLOT / 2, SLOT / 2, SLOT * 0.72, SCALE);
  writeFileSync(resolve(OUT_DIR, `badge-${kind}.png`), await canvas.encode("png"));
  console.log(`✓ badge-${kind}.png`);
}

for (const kind of Object.keys(MODE_FILL)) await renderBox(kind);
await renderPill("pill-2", 2);
await renderPill("pill-3", 3);
for (const kind of ["train", "subway", "bus", "tram", "ferry"]) await renderBadge(kind);

console.log("done.");
