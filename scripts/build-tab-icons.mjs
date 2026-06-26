/**
 * Build-Script: konvertiert die 4 Tab-Icons aus lucide-static (SVG) zu
 * Multi-DPI PNGs, in dem Style den wir auch im Rest der App nutzen
 * (Stroke-Outline, gleiche Form, gleicher Strich).
 *
 * Output:
 *   assets/tabs/{name}.png      24x24  (1x)
 *   assets/tabs/{name}@2x.png   48x48  (2x)
 *   assets/tabs/{name}@3x.png   72x72  (3x)
 *
 * React Native pickt @2x/@3x automatisch je nach Display-Dichte.
 *
 * Icon-Up-Shift: SHIFT_UP_PX schiebt das Icon visuell um N Pixel nach oben
 * in der Tab-Bar. Realisiert durch RESIZE auf kleinere Größe (24-2*shift)
 * + EXTEND mit transparentem Padding unten. So bleibt das PNG square 24x24
 * (native Bottom-Tab-Bars wollen das), aber das Icon-Asset selbst sitzt im
 * oberen Teil des Canvases. ViewBox-Shift haben wir verworfen weil lucide
 * den viewBox vollständig nutzt → Icon-Top wurde geclippt.
 */
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const LUCIDE = (name) => resolve(ROOT, `node_modules/lucide-static/icons/${name}.svg`);
const OUT = (name) => resolve(ROOT, `assets/tabs/${name}.png`);

const ICONS = [
  { lucide: "house", out: "home" },
  { lucide: "tag", out: "tag" },
  { lucide: "calendar", out: "calendar" },
  { lucide: "user", out: "user" },
];

/** Wieviel Pixel das Icon visuell nach oben gerückt sein soll im 24x24-PNG.
 *  0 = Icon füllt das Canvas voll (24x24), zentriert. Up-Shift wird in
 *  diesem Modus stattdessen auf Library-Seite via labeled-Mode realisiert
 *  (siehe app/(tabs)/_layout.tsx). */
const SHIFT_UP_PX = 0;

function svgWithBlackStroke(svg) {
  return svg
    .replace(/stroke="currentColor"/g, 'stroke="#000000"')
    .replace(/stroke-width="2"/g, 'stroke-width="2.2"');
}

async function convertOne(lucideName, outName) {
  const svgPath = LUCIDE(lucideName);
  const rawSvg = readFileSync(svgPath, "utf8");
  const tinted = svgWithBlackStroke(rawSvg);

  for (const [suffix, canvas] of [["", 24], ["@2x", 48], ["@3x", 72]]) {
    // Scale: 1x=24, 2x=48, 3x=72. SHIFT skaliert mit (24→3, 48→6, 72→9).
    const shift = (SHIFT_UP_PX * canvas) / 24;
    const iconSize = canvas - 2 * shift;
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

    const outPath = OUT(`${outName}${suffix}`);
    await sharp(Buffer.from(tinted))
      // Icon kleiner rendern als das Canvas, damit Platz für oben & seitlich.
      .resize(iconSize, iconSize, { fit: "contain", background: transparent })
      // Auf volle Canvas-Größe erweitern: top=0 (Icon klebt oben),
      // bottom=2*shift (= leere Fläche unten → Icon erscheint höher),
      // left/right=shift (horizontal centered).
      .extend({
        top: 0,
        bottom: 2 * shift,
        left: shift,
        right: shift,
        background: transparent,
      })
      .png()
      .toFile(outPath);
    console.log(`  → ${outPath} (${canvas}x${canvas}, icon ${iconSize}x${iconSize} at top)`);
  }
}

async function main() {
  console.log("Building tab icons from lucide-static…");
  for (const { lucide, out } of ICONS) {
    console.log(`Icon: ${out} (from lucide "${lucide}")`);
    await convertOne(lucide, out);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
