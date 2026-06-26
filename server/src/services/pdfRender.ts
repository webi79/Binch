/**
 * Loads a PDF from a Buffer, returns the raw text of ALL pages and a PNG
 * rendering of page 1. The PNG is the visual "screenshot" the mobile
 * client embeds 1:1 in its ticket card — this preserves the original
 * QR/barcode without re-encoding it.
 *
 * Single-page rendering: hält das resultierende PNG handlebar (~500KB)
 * und vermeidet Edge-Cases mit Multi-Page-Compositing. Text-Extraction
 * läuft trotzdem über ALLE Seiten damit der Parser z.B. Buchungsnummern
 * findet die auf Seite 2 stehen.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);

// Worker-Pfad für pdfjs's Fake-Worker (in-process).
const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
  pathToFileURL(workerPath).href;

// Standard-Fonts (Helvetica, Times, Courier-Replikate von Foxit) + CMaps
// (für Unicode-Mapping inkl. Umlaute, polnische Zeichen, CJK). Ohne diese
// Pfade rendert pdfjs in Node Text mit den Standard-PDF-Fonts NICHT — Body-
// Text bleibt leer/unsichtbar.
const pdfJsBase = path.dirname(require.resolve("pdfjs-dist/package.json"));
const STANDARD_FONT_DATA_URL =
  pathToFileURL(path.join(pdfJsBase, "standard_fonts") + path.sep).href;
const CMAP_URL = pathToFileURL(path.join(pdfJsBase, "cmaps") + path.sep).href;

export interface RenderedPdf {
  text: string;
  pageCount: number;
  pageImageBase64: string; // "data:image/png;base64,..."
  pageWidth: number;
  pageHeight: number;
}

export async function renderPdf(buffer: Buffer, scale = 2.0): Promise<RenderedPdf> {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    // Font-Config für Node-Rendering:
    //  - `disableFontFace: true` → path-based Glyph-Rendering aufs Canvas
    //    (FontFace-Browser-API existiert in Node nicht).
    //  - `useSystemFonts: true` → fallback auf Linux/macOS-System-Fonts
    //    (DejaVu, Liberation, etc.) für Fonts die WEDER eingebettet sind
    //    NOCH in den Standard-14. DB-Tickets z.B. referenzieren Custom-
    //    Fonts wie "DB Office" — mit useSystemFonts:false rendert pdfjs
    //    die einfach nicht. Mit true substituiert es mit einem System-Font
    //    und der Body-Text wird sichtbar (auch wenn Schriftart-Style
    //    leicht abweicht).
    //  - `standardFontDataUrl` für die 14 Standard-PDF-Fonts (Helvetica
    //    etc.) aus pdfjs-dist's mitgelieferten .pfb-Files.
    //  - `cMapUrl` + `cMapPacked: true` für Unicode-Glyphen-Mapping
    //    (Umlaute, polnische Zeichen, CJK).
    disableFontFace: true,
    useSystemFonts: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
  });
  const doc = await loadingTask.promise;

  // Text aus ALLEN Seiten extrahieren — der Parser braucht den vollen Text
  // damit er Felder die auf späteren Seiten stehen (z.B. Buchungsnummer auf
  // Seite 2) finden kann.
  let allText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((it) => ("str" in it ? (it as { str: string }).str : ""))
      .join(" ");
    allText += pageText + "\n";
  }

  // Nur Seite 1 als Image — das ist die Bordkarte/der Ticket-Frontteil mit
  // QR/Barcode. T&Cs auf Seite 2+ sind für die App-UX irrelevant.
  const page1 = await doc.getPage(1);
  const viewport = page1.getViewport({ scale });
  const w = Math.ceil(viewport.width);
  const h = Math.ceil(viewport.height);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // Weißer Hintergrund — manche PDFs haben transparente Bereiche, die
  // sonst durchscheinen würden zum Default-Canvas-Schwarz.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, w, h);

  await page1.render({
    canvasContext: ctx as unknown,
    viewport,
    canvas: canvas as unknown,
  } as Parameters<typeof page1.render>[0]).promise;

  const png = canvas.toBuffer("image/png");

  await doc.destroy();

  return {
    text: allText,
    pageCount: doc.numPages,
    pageImageBase64: `data:image/png;base64,${png.toString("base64")}`,
    pageWidth: w,
    pageHeight: h,
  };
}
