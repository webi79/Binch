import type { FastifyInstance } from "fastify";
import { consumeRedirectToken } from "../services/tokenService.js";
import { resolveFlightBookingUrl } from "../providers/flight/googleFlightsBooking.js";

export async function redirectRoutes(app: FastifyInstance) {
  app.get<{ Params: { token: string } }>("/redirect/:token", async (req, reply) => {
    const consumed = await consumeRedirectToken(req.params.token);
    if (!consumed) return reply.code(404).send({ error: "Token expired or unknown" });

    // For flights with a SerpAPI/google-flights2 booking_token: resolve the
    // direct airline/OTA purchase URL via the provider's 2nd-stage API and
    // forward there. Falls back to the original search-page deeplink if the
    // 2nd call doesn't surface a usable URL (API down, no partner option,
    // unsupported provider in the response, etc.).
    if (
      consumed.bookingToken &&
      consumed.bookingContext?.mode === "FLIGHT"
    ) {
      const direct = await resolveFlightBookingUrl(consumed.bookingToken, consumed.bookingContext);
      if (direct) return reply.redirect(direct, 302);
    }

    return reply.redirect(consumed.deepLink, 302);
  });
}
