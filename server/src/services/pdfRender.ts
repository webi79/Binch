/**
 * Loads a PDF from a Buffer, returns the raw text of all pages and a
 * PNG rendering of page 1. The PNG is the visual "screenshot" the
 * mobile client embeds 1:1 in its ticket card — this is what preserves
 * the original QR/barcode without re-encoding it.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createCanvas } from "@napi-rs/canvas";
// pdfjs-dist v5 ships an ESM build aimed at Node + browser.
// In Node we point GlobalWorkerOptions.workerSrc at the bundled worker file
// so pdfjs can spin up its fake-worker in-process without trying to fetch.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
  pathToFileURL(workerPath).href;

export interface RenderedPdf {
  text: string;
  pageCount: number;
  pageImageBase64: string; // "data:image/png;base64,..."
  pageWidth: number;
  pageHeight: number;
}

export async function renderPdf(buffer: Buffer, scale = 1.5): Promise<RenderedPdf> {
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  // Concatenate text from every page
  let allText = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((it) => ("str" in it ? (it as { str: string }).str : ""))
      .join(" ");
    allText += pageText + "\n";
  }

  // Render page 1 to canvas
  const page1 = await doc.getPage(1);
  const viewport = page1.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

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
    pageWidth: Math.ceil(viewport.width),
    pageHeight: Math.ceil(viewport.height),
  };
}
