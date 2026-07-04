import type { FastifyInstance } from "fastify";
import { consumeRedirectToken } from "../services/tokenService.js";
import { resolveBookingUrl } from "../providers/flight/flightBookingDispatch.js";

/** Defense-in-Depth: wir leiten ausschließlich auf http(s)-URLs weiter.
 *  Die Links kommen zwar server-seitig von Providern (kein direkter User-
 *  Input), aber ein kompromittiertes/verändertes Provider-Response-Format
 *  darf trotzdem nie in einem javascript:/intent:/file:-Redirect enden. */
function isHttpUrl(value: string): boolean {
  try {
    const proto = new URL(value).protocol;
    return proto === "https:" || proto === "http:";
  } catch {
    return false;
  }
}

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
      const direct = await resolveBookingUrl(consumed.bookingToken, consumed.bookingContext);
      if (direct && isHttpUrl(direct)) return reply.redirect(direct, 302);
    }

    if (!isHttpUrl(consumed.deepLink)) {
      req.log.warn({ deepLink: consumed.deepLink }, "redirect blocked: non-http deep link");
      return reply.code(404).send({ error: "Invalid redirect target" });
    }
    return reply.redirect(consumed.deepLink, 302);
  });
}
