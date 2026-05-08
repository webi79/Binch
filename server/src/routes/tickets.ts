import type { FastifyInstance } from "fastify";
import { renderPdf } from "../services/pdfRender.js";
import { parseTicketText } from "../services/ticketParser.js";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB

export async function ticketsRoutes(app: FastifyInstance) {
  app.post("/api/tickets/parse", async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded" });
    }

    const buffer = await file.toBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return reply.code(413).send({ error: "File too large" });
    }
    if (file.mimetype !== "application/pdf") {
      return reply.code(415).send({ error: "Only PDF is supported" });
    }

    try {
      const rendered = await renderPdf(buffer);
      const fields = parseTicketText(rendered.text);
      return {
        fields,
        pageImage: rendered.pageImageBase64,
        pageWidth: rendered.pageWidth,
        pageHeight: rendered.pageHeight,
        pageCount: rendered.pageCount,
        originalName: file.filename,
      };
    } catch (err) {
      app.log.error({ err }, "Failed to parse ticket PDF");
      return reply.code(500).send({ error: "Failed to parse PDF" });
    }
  });
}
