/**
 * Build-Script: die Symbole der Live-Ansicht.
 *
 * Output: ../../assets/marker-icons/live-arrow.png, live-plane.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-live-icons.mjs`
 *
 *  - `live-arrow`: Fahrtrichtung neben dem Fahrzeug-Punkt (2D, herausgezoomt).
 *    Weiß mit dunkler Kante — derselbe Rand wie an den Haltestellen-Markern
 *    (#14181A), damit er auf dunkler, heller und Luftbild-Karte steht.
 *  - `live-plane`: das Flugzeug von oben für die Übersicht. Weiß, dunkle Kante,
 *    NASE NACH OBEN: Die Karte dreht es um `icon-rotate` = Kurs (Grad ab
 *    Norden), und das stimmt nur, wenn es bei 0 nach Norden zeigt.
 *
 * Doppelte Auflösung, die Karte zeigt es mit `icon-size` 0.5.
 */
import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "../../assets/marker-icons");
mkdirSync(OUT_DIR, { recursive: true });

const SCALE = 2;
const EDGE = "#14181A";
const FILL = "#FFFFFF";

async function render(name, size, draw) {
  const canvas = createCanvas(size * SCALE, size * SCALE);
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  draw(ctx, size);
  const png = await canvas.encode("png");
  writeFileSync(resolve(OUT_DIR, `${name}.png`), png);
  console.log(`✓ ${name}.png (${size}×${size} @${SCALE}x, ${png.length} bytes)`);
}

/** Pfeilspitze, nach oben, mit eingezogenem Fuß (wie ein Navigationspfeil). */
await render("live-arrow", 20, (ctx, s) => {
  ctx.beginPath();
  ctx.moveTo(s / 2, 2);
  ctx.lineTo(s - 3, s - 3);
  ctx.lineTo(s / 2, s - 7);
  ctx.lineTo(3, s - 3);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = EDGE;
  ctx.stroke();
  ctx.fillStyle = FILL;
  ctx.fill();
});

/**
 * Flugzeug von oben — dieselbe Gestalt wie der 3D-Körper (`lib/live/shapes.ts`:
 * Rumpf, gepfeilte Flügel, Höhenleitwerk), auf 40 Bildpunkte gebracht.
 */
await render("live-plane", 40, (ctx, s) => {
  const k = s / 44; // 44 m Bild für ~38 m Flugzeug, Rand für die Kante
  const cx = s / 2;
  const cy = s / 2;
  // [x nach rechts, y nach vorn] in Metern → Bild (y nach unten).
  const P = (x, y) => [cx + x * k, cy - y * k];
  const half = [
    [0, 19.5], [1.7, 16.5], [2.1, 12], [2, 4.5], [17.5, -5.2], [17.5, -7.8], [2, -3.6],
    [1.9, -12.5], [1.4, -14.2], [6.8, -18.2], [6.8, -19.8], [0.6, -18.6], [0, -19.6],
  ];
  const ring = [...half, ...half.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  ctx.beginPath();
  ring.forEach(([x, y], i) => {
    const [px, py] = P(x, y);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = EDGE;
  ctx.stroke();
  ctx.fillStyle = FILL;
  ctx.fill();
});
