/**
 * Build-Script: die Dauer-Blasen an den Routen des Stadt-Blatts.
 *
 * Output: ../../assets/marker-icons/route-pill-{lime,mint,dark}-{2..9}.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-route-pills.mjs`
 *
 * Warum fertige Bilder in festen Breiten: Die Blase trägt eine Dauer („3h 12m")
 * und muss zu deren Länge passen. MapLibre könnte ein Bild auf den Text dehnen
 * (`icon-text-fit`), aber ohne Dehnzonen — und die kennt die Bild-Komponente der
 * Bibliothek nicht — würden die runden Enden mitgedehnt und oval. Eine Blase
 * als React-Ansicht (MarkerView) würde dagegen bei jedem Kartenbild neu gesetzt,
 * genau die Arbeit, die beim Wischen gemessen und entfernt wurde. Also je
 * Zeichenzahl ein eigenes Bild; die Karte wählt es über die Länge des Textes.
 *
 * Dreifach aufgelöst (`SCALE`), die Karte zeigt es mit `icon-size` 1/3 — so
 * bleibt die Kante auch auf dichten Displays scharf.
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
/** Höhe in Punkten — eine Zeile Text (13) mit Luft. */
const H = 26;
/**
 * Breite je Zeichenzahl: rund 7,6 Punkte pro Zeichen in „Noto Sans" 13 (die
 * Schrift der Karte) plus 11 Punkte Rand je Seite.
 */
const widthFor = (chars) => Math.round(chars * 7.6 + 22);

/** Flächen: Akzent (dieselben Werte wie `solid` in lib/theme/accent.ts) und dunkel. */
const TONES = {
  lime: { fill: "#7FEA4D", stroke: null },
  mint: { fill: "#3FE0A8", stroke: null },
  // Wie die Knöpfe auf der Karte: fast schwarz, feiner heller Rand.
  dark: { fill: "#171719", stroke: "#3A3A3C" },
};

for (const [tone, { fill, stroke }] of Object.entries(TONES)) {
  for (let chars = 2; chars <= 9; chars++) {
    const w = widthFor(chars) * SCALE;
    const h = H * SCALE;
    const sw = stroke ? 1.5 * SCALE : 0;
    const r = h / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <rect x="${sw / 2}" y="${sw / 2}" width="${w - sw}" height="${h - sw}" rx="${r - sw / 2}" ry="${r - sw / 2}"
        fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="${sw}"` : ""}/>
</svg>`;
    const file = resolve(OUT_DIR, `route-pill-${tone}-${chars}.png`);
    await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(file);
    console.log("geschrieben:", file);
  }
}
