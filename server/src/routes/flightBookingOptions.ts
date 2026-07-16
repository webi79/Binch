import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getBookingOptions,
  getBookingUrlByProviderToken,
} from "../providers/flight/flightBookingDispatch.js";
import { ipLimiter } from "../util/rateLimit.js";

/**
 * Zwei Endpoints für die Multi-Provider-Buchung von Flügen:
 *
 *   GET  /api/flights/booking-options   → Liste aller Anbieter zu einem Search-
 *                                         Token. Liefert pro Anbieter: name,
 *                                         price, website, providerToken.
 *
 *   GET  /api/flights/booking-url?token= → Auflösung eines providerToken in
 *                                         den finalen Deeplink. 302-Redirect
 *                                         direkt zum Anbieter (kein JSON).
 *                                         Client nutzt das via Linking.openURL.
 *
 * Beide Endpoints sind günstig zu cachen wäre theoretisch, aber:
 *   - Options haben Search-Token-TTL (~10min)
 *   - URLs sind oft mit gclid-Tracking → eindeutig pro User → kein Cache.
 * Daher kein Server-Cache hier, der Client cached die Options-Antwort im
 * React-Query-Layer (staleTime 5min).
 */

const optionsQuerySchema = z.object({
  token: z.string().min(1),
  origin: z.string().min(2).max(8),
  destination: z.string().min(2).max(8),
  departDate: z.string().min(8),
  returnDate: z.string().optional(),
  passengers: z.coerce.number().int().min(1).max(9).default(1),
  currency: z.string().min(3).max(4).default("EUR"),
  /** App-Sprache für die Sprach-Lokalisierung der Anbieter-Deeplinks. */
  lang: z.enum(["de", "en", "fr", "es"]).optional(),
  /** Card-/Suchpreis dieses Flugs — Detail snappt den günstigsten geschätzten
   *  Anbieter darauf (Card == Detail-Günstigster). */
  searchPrice: z.coerce.number().positive().optional(),
});

const urlQuerySchema = z.object({
  token: z.string().min(1),
});

export async function flightBookingOptionsRoutes(app: FastifyInstance) {
  // Booking-Optionen/-URL: SerpAPI-2nd-stage — pay-per-call, deshalb gedeckelt.
  const preHandler = ipLimiter("flight-booking", [{ limit: 40, windowMs: 60 * 1000 }]);
  app.get("/api/flights/booking-options", { preHandler }, async (req, reply) => {
    const parsed = optionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request", details: parsed.error.flatten() });
    }
    const q = parsed.data;
    try {
      const options = await getBookingOptions(q.token, {
        mode: "FLIGHT",
        origin: q.origin,
        destination: q.destination,
        departDate: q.departDate,
        returnDate: q.returnDate,
        passengers: q.passengers,
        currency: q.currency.toUpperCase(),
        lang: q.lang,
        searchPrice: q.searchPrice,
      });
      return { options };
    } catch (err) {
      req.log.warn({ err }, "flight booking-options upstream failed");
      return { options: [] };
    }
  });

  // 302-Redirect-Endpoint: der Client öffnet diese URL per Linking.openURL,
  // wir resolven den Provider-Token einmal und leiten direkt weiter. Vorteil
  // ggü. einer JSON-Response + zweiter clientseitiger openURL-Roundtrip:
  // weniger Latenz beim Tap, Anbieter-URL gar nicht erst im JS sichtbar.
  app.get("/api/flights/booking-url", { preHandler }, async (req, reply) => {
    const parsed = urlQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad request" });
    }
    try {
      const url = await getBookingUrlByProviderToken(parsed.data.token);
      if (!url) {
        return reply
          .code(404)
          .send({ error: "Could not resolve booking URL — token may be expired" });
      }
      return reply.redirect(url, 302);
    } catch (err) {
      req.log.warn({ err }, "booking-url resolve failed");
      return reply.code(502).send({ error: "Upstream failed" });
    }
  });
}
