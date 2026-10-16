/**
 * Build-Script: rendert den Blickrichtungs-Kegel am Standortpunkt.
 *
 * Output: ../../assets/marker-icons/heading-cone-{lime,mint}-{schmal,mittel,breit}.png
 *
 * Ausführen aus dem server/-Verzeichnis: `node scripts/build-heading-cone.mjs`
 *
 * Warum gerechnet und nicht gezeichnet: Der Kegel ist ein Verlauf in zwei
 * Richtungen zugleich — nach außen blasser, zu den Flanken hin weich. Das ist
 * eine Formel je Bildpunkt, und so bleibt jede Stufe exakt reproduzierbar.
 *
 * Aufbau des Bildes: quadratisch, die SPITZE liegt genau in der Mitte, der
 * Kegel öffnet sich nach oben. MapLibre dreht ein Symbol um seinen Anker, und
 * der ist die Bildmitte (`icon-anchor: center`) — gedreht wird also um die
 * Spitze, und die sitzt unter dem Standortpunkt.
 *
 * Drei Breiten, weil der Kegel wie bei Google die Unsicherheit des Kompasses
 * zeigt: schmal, wenn er sicher ist, breit, wenn nicht. Es wird zwischen fertigen
 * Bildern umgeschaltet statt skaliert — eine Symbolgröße lässt sich nur als
 * Ganzes ändern, nicht in der Breite allein.
 */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OUT_DIR = resolve(__dirname, "../../assets/marker-icons");
mkdirSync(OUT_DIR, { recursive: true });

/** Kantenlänge in Bildpunkten. Die Karte zeigt es verkleinert — siehe `CONE_RADIUS_PX` in MapMarkers.tsx. */
const SIZE = 300;
const RADIUS = SIZE / 2;

/** Die Akzentfarben — dieselben Werte wie `solid` in `lib/theme/accent.ts`. */
const ACCENTS = {
  lime: [0x7f, 0xea, 0x4d],
  mint: [0x3f, 0xe0, 0xa8],
};

/**
 * Öffnungswinkel (voll, in Grad) je Genauigkeitsstufe.
 *
 * Zuerst standen hier 50 / 75 / 110 — zu spitz. Bei gut kalibriertem Kompass,
 * also im Normalfall, sieht man die schmalste Stufe, und 50 Grad lasen sich
 * eher als Zeiger denn als Blickfeld. Googles Kegel geht deutlich weiter auf.
 */
const WIDTHS = {
  schmal: 80,
  mittel: 100,
  breit: 130,
};

/**
 * Deckung im inneren Teil. Bis `PLATEAU` bleibt sie fast gleich, danach läuft
 * sie gegen null aus — so steht der Kegel auch über grünem Luftbild, wo ein
 * früh abfallender Verlauf in der Vegetation verschwand (ausprobiert mit einer
 * Potenzkurve: am Bildschirm nur ein Hauch).
 */
const PEAK_ALPHA = 0.7;
const PLATEAU = 0.3;
/** Wie weich die Flanken auslaufen, in Grad. */
const EDGE_SOFTNESS = 14;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

for (const [accentId, [r, g, b]] of Object.entries(ACCENTS)) {
  for (const [widthId, fullAngle] of Object.entries(WIDTHS)) {
    const half = fullAngle / 2;
    const data = Buffer.alloc(SIZE * SIZE * 4);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        // Bildpunktmitte, Spitze im Ursprung, y nach OBEN positiv.
        const dx = px + 0.5 - RADIUS;
        const dy = RADIUS - (py + 0.5);
        const dist = Math.hypot(dx, dy) / RADIUS;
        let alpha = 0;
        if (dist < 1) {
          const angle = Math.abs((Math.atan2(dx, dy) * 180) / Math.PI);
          const flank = 1 - smoothstep(half - EDGE_SOFTNESS / 2, half + EDGE_SOFTNESS / 2, angle);
          const falloff = 1 - smoothstep(PLATEAU, 1, dist);
          alpha = PEAK_ALPHA * flank * falloff;
        }
        const i = (py * SIZE + px) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = Math.round(alpha * 255);
      }
    }
    const file = resolve(OUT_DIR, `heading-cone-${accentId}-${widthId}.png`);
    await sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(file);
    console.log("geschrieben:", file);
  }
}
