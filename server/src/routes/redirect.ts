import type { FastifyInstance } from "fastify";
import { consumeRedirectToken } from "../services/tokenService.js";
import { resolveBookingUrl } from "../providers/flight/flightBookingDispatch.js";
import { localizeBookingUrl, isAppLocale } from "../util/bookingLocale.js";
import { ipLimiter } from "../util/rateLimit.js";

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
  // Per-IP-Limit. /redirect ist NICHT single-use (Token bleibt für seine TTL
  // gültig, damit ein Nutzer denselben „Buchen"-Link auch zweimal öffnen kann),
  // UND es löst bei Flügen die bezahlte SerpAPI-2nd-stage-Auflösung aus. Ohne
  // Limit könnte ein Angreifer mit EINEM gültigen Token (= eine Suche) den
  // Endpoint beliebig oft replayen und pro Aufruf einen SerpAPI-Call verbrennen.
  // 30/min ist weit über echtem Tippen auf Buchungslinks, kappt aber den Replay.
  const preHandler = ipLimiter("redirect", [{ limit: 30, windowMs: 60 * 1000 }]);
  app.get<{ Params: { token: string }; Querystring: { lang?: string } }>("/redirect/:token", { preHandler }, async (req, reply) => {
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

    // Züge: KEIN vbid-Direktlink mehr. Der bahn.de-„Reise teilen"-vbid
    // (bahn.de/buchung/start?vbid) ist doppelt unzuverlässig: die Generierung
    // schlägt oft fehl UND die Buchungsseite überlebt kein kaltes Browser-
    // Öffnen (braucht Login/App-Session → springt sofort zurück). Stattdessen
    // immer der deepLink = vorausgefüllte bahn.de-Suche der exakten Strecke +
    // Datum/Uhrzeit (öffnet zuverlässig, gewählte Verbindung steht oben).
    // resolveBahnBookingUrl/Recon bleiben im Code für einen späteren, robusteren
    // Weg (z.B. DB-Navigator-App-Deeplink).

    if (!isHttpUrl(consumed.deepLink)) {
      req.log.warn({ deepLink: consumed.deepLink }, "redirect blocked: non-http deep link");
      return reply.code(404).send({ error: "Invalid redirect target" });
    }

    // Sprache des KLICKENDEN Users (`?lang=de`) — nicht die dessen, der die Suche
    // zufällig als Erster ausgelöst und damit den Cache-Eintrag erzeugt hat.
    //
    // Deshalb steht das hier und nicht im Provider: Der Deeplink wird beim Suchen
    // gebaut und MIT dem Ergebnis gecacht, die Sprache steckt aber nicht im
    // Cache-Key. Sie hineinzunehmen würde den Cache je Sprache vervierfachen —
    // auch für Flüge, wo das Anbieter-Kontingent knapp ist. Beim Redirect kostet
    // es nichts und wirkt auch auf längst gecachte Treffer.
    const lang = (req.query as { lang?: string } | undefined)?.lang;
    const target = isAppLocale(lang)
      ? localizeBookingUrl(consumed.deepLink, lang)
      : consumed.deepLink;

    return reply.redirect(target, 302);
  });
}
