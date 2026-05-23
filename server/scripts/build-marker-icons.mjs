/**
 * Build-Script: rendert Lucide-Icons als weiße PNG-Silhouetten für die
 * Surroundings-Marker. MapLibre registriert sie als SDF-Sprite und tönt sie
 * dann per `icon-color` paint-Property in den jeweiligen Marker-Farben.
 *
 * Output: ../../assets/marker-icons/{train,bus,tram,airport,cruise}.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-marker-icons.mjs`
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";
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
 *   - Helle Bgs (Yellow, Lime) → dunkles Icon (#14181A)
 *   - Dunkle Bgs (Purple, Dark, Blue) → weißes Icon (#FFFFFF)
 */
const ICONS = {
  train: {
    color: "#14181A",
    svg: `
      <path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/>
      <path d="m9 15-1-1"/>
      <path d="m15 15 1-1"/>
      <path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/>
      <path d="m8 19-2 3"/>
      <path d="m16 19 2 3"/>
    `,
  },
  bus: {
    color: "#FFFFFF",
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

function svgFor(content, color) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">
  ${content}
</svg>`;
}

async function renderOne(name, def) {
  const svg = svgFor(def.svg, def.color);
  const img = await loadImage(Buffer.from(svg, "utf-8"));
  const canvas = createCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
  const png = await canvas.encode("png");
  const outPath = resolve(OUT_DIR, `${name}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ ${name}.png (${def.color}, ${png.length} bytes)`);
}

console.log(`Rendering ${Object.keys(ICONS).length} marker icons → ${OUT_DIR}`);
for (const [name, def] of Object.entries(ICONS)) {
  await renderOne(name, def);
}

/**
 * Multi-Mode-Pille: ein weiß-gefüllter, dunkel-umrandeter abgerundeter
 * Rechteck-Sprite. Wird als BG für Stops genutzt die mehrere Modi haben
 * (z.B. „Dortmund Barop Parkhaus" = U-Bahn + Bus): die einzelnen Mode-Kreise
 * mit ihren jeweiligen Farben sitzen INNERHALB dieser Pille.
 *
 * Wir rendern bewusst auf größeren Pixel-Coords als die Single-Icons (Retina-
 * Quality), MapLibre skaliert sie über icon-size dann ohne Aliasing.
 */
async function renderPill(name, slotCount) {
  // Pro Slot brauchen wir ~28px (= 14px BG-Radius × 2 = Circle-Durchmesser).
  // Plus 4px horizontales Padding für die Pillen-Form drumrum.
  const SLOT_PX = 28;
  const PAD_X = 6;
  const PAD_Y = 4;
  const w = SLOT_PX * slotCount + 2 * PAD_X;
  const h = SLOT_PX + 2 * PAD_Y;
  const radius = h / 2;

  // Retina-Faktor: nativ doppelte Pixel rendern, MapLibre stellt mit icon-size
  // 0.5 die endgültige Größe ein.
  const SCALE = 2;
  const canvas = createCanvas(w * SCALE, h * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  // Pillen-Pfad
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(w - radius, 0);
  ctx.arcTo(w, 0, w, radius, radius);
  ctx.lineTo(w, h - radius);
  ctx.arcTo(w, h, w - radius, h, radius);
  ctx.lineTo(radius, h);
  ctx.arcTo(0, h, 0, h - radius, radius);
  ctx.lineTo(0, radius);
  ctx.arcTo(0, 0, radius, 0, radius);
  ctx.closePath();

  // Weiße Füllung
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();

  // Dunkler Outline (matched die Single-Marker-Stroke)
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#14181A";
  ctx.stroke();

  const png = await canvas.encode("png");
  const outPath = resolve(OUT_DIR, `${name}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ ${name}.png (${w}×${h}px @${SCALE}x, ${png.length} bytes)`);
}

await renderPill("pill-2", 2);
await renderPill("pill-3", 3);

/**
 * Badge-Sprites: kleine gefüllte Kreise in den Mode-Farben. Werden in der
 * Multi-Mode-Pille als „farbige Slots hinter dem Icon" gerendert (ein Badge
 * pro Slot, positioniert via icon-offset). Wir können keine Circle-Layer mit
 * data-driven Translate nutzen — `circle-translate` ist data-constant in
 * MapLibre. Symbol-Layer mit `icon-offset` ist data-driven.
 *
 * Wichtig: GLEICHE pixel-Größe wie der Pille-Slot-Bereich (28px @1x = 56px @2x).
 * MapLibre stellt die Badges mit icon-size 0.5 dann passend dar.
 */
const BADGE_COLORS = {
  train: "#FFD60A", // TRAIN_YELLOW
  subway: "#1F3A8A", // SUBWAY_BLUE
  bus: "#9D5FE0", // BUS_PURPLE
  tram: "#2A2A2C", // DARK
  ferry: "#6B95B5", // CRUISE_BLUE
};

async function renderBadge(name, color) {
  const SIZE = 28;
  const SCALE = 2;
  const canvas = createCanvas(SIZE * SCALE, SIZE * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);

  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  const png = await canvas.encode("png");
  writeFileSync(resolve(OUT_DIR, `${name}.png`), png);
  console.log(`✓ ${name}.png (${SIZE}×${SIZE}px @${SCALE}x, ${png.length} bytes)`);
}

for (const [kind, color] of Object.entries(BADGE_COLORS)) {
  await renderBadge(`badge-${kind}`, color);
}

console.log("done.");
