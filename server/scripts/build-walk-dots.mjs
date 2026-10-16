/**
 * Build-Script: die Punkte eines Fußwegs auf der Karte.
 *
 * Output: ../../assets/marker-icons/walk-dot-{lime,mint}-{white,black}.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-walk-dots.mjs`
 *
 * Warum Bilder und keine gestrichelte Linie: Eine Linie aus Strichen der Länge
 * null mit runden Enden zeichnet MapLibre bei zoomabhängiger Breite nicht als
 * Kreise, sondern als verzogene Striche — und eine Umrandung JE PUNKT kann eine
 * Linie ohnehin nicht haben. Als Symbol entlang der Linie
 * (`symbol-placement: line`) ist jeder Punkt ein echter Kreis mit Rand, im
 * festen Bildschirmabstand wie bei Google Maps.
 *
 * Der Rand kontrastiert zur Karte: weiß auf der dunklen Karte und dem Luftbild,
 * schwarz auf der hellen.
 *
 * Dreifach aufgelöst (`SCALE`), die Karte zeigt es verkleinert — so bleibt der
 * Rand auch auf dichten Displays scharf.
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "../../assets/marker-icons");
mkdirSync(OUT_DIR, { recursive: true });

const SCALE = 3;
/** Durchmesser in Punkten, Rand eingeschlossen. */
const D = 14;
/** Randbreite in Punkten. */
const STROKE = 2.5;

/** Füllung: dieselben Werte wie `solid` in lib/theme/accent.ts. */
const FILLS = { lime: "#7FEA4D", mint: "#3FE0A8" };
const OUTLINES = { white: "#FFFFFF", black: "#0D0D0D" };

for (const [fillId, fill] of Object.entries(FILLS)) {
  for (const [lineId, line] of Object.entries(OUTLINES)) {
    const size = D * SCALE;
    const sw = STROKE * SCALE;
    const r = size / 2 - sw / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${fill}" stroke="${line}" stroke-width="${sw}"/>
</svg>`;
    const file = resolve(OUT_DIR, `walk-dot-${fillId}-${lineId}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
    console.log("geschrieben:", file);
  }
}
