import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { searchRoutes } from "./routes/search.js";
import { locationsRoutes } from "./routes/locations.js";
import { redirectRoutes } from "./routes/redirect.js";
import { ticketsRoutes } from "./routes/tickets.js";
import { authRoutes } from "./routes/auth.js";
import { surroundingsRoutes } from "./routes/surroundings.js";
import { tilesRoutes } from "./routes/tiles.js";
import { stopsRoutes } from "./routes/stops.js";
import { tripsRoutes } from "./routes/trips.js";
import { flightBookingOptionsRoutes } from "./routes/flightBookingOptions.js";
import { chatRoutes } from "./routes/chat.js";
import { tripPlanRoutes } from "./routes/tripPlan.js";
import { walkRoutes } from "./routes/walk.js";
import { alertsRoutes } from "./routes/alerts.js";
import { flushEsriUsage, imageryRoutes } from "./routes/imagery.js";
import { deactivateExpiredAlerts, startAlertExpiry, stopAlertExpiry } from "./services/priceAlerts.js";
import { pool } from "./db/client.js";
import { startStopBoardPreCache, stopStopBoardPreCache } from "./services/stopBoardPreCache.js";
import { startDbVendoQueue, stopDbVendoQueue } from "./services/dbVendoQueue.js";
import { startRetention, stopRetention } from "./services/retention.js";

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
        : undefined,
  },
  // Nur hinter einem Reverse-Proxy true (siehe config.TRUST_PROXY): sonst würde
  // ein Angreifer per gefälschtem X-Forwarded-For seine IP frei wählen und die
  // Per-IP-Rate-Limits umgehen. Direkt exponiert (Default) = Peer-IP zählt.
  // Eine Stufe (Caddy), nicht „allen": Mit `true` nähme Fastify den LINKESTEN
  // X-Forwarded-For-Eintrag, und den kann der Absender selbst setzen, sobald
  // ein anhängender Proxy davor sitzt. Kommt ein CDN oder Lastverteiler vor
  // Caddy, hier 2.
  trustProxy: config.TRUST_PROXY ? 1 : false,
});

// CORS: mit CORS_ORIGINS (Prod) nur die gelisteten Origins, ungesetzt (Dev)
// wird jeder Origin reflektiert. Native App-Clients senden keinen Origin-
// Header — das hier betrifft nur Browser-Clients.
await app.register(cors, {
  origin: config.CORS_ORIGINS
    ? config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : true,
});
await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

app.get("/health", async () => ({ ok: true }));

await app.register(searchRoutes);
await app.register(locationsRoutes);
await app.register(redirectRoutes);
await app.register(ticketsRoutes);
await app.register(authRoutes);
await app.register(surroundingsRoutes);
await app.register(tilesRoutes);
await app.register(stopsRoutes);
await app.register(tripsRoutes);
await app.register(alertsRoutes);
await app.register(flightBookingOptionsRoutes);
await app.register(chatRoutes);
await app.register(tripPlanRoutes);
await app.register(walkRoutes);
await app.register(imageryRoutes);

// db-vendo Background-Queue starten — Worker tickt alle 1.5s und arbeitet
// SWR/History-Refreshes ab. Muss VOR dem Pre-Cache laufen, weil der Pre-Cache
// optional über die Queue gehen könnte (aktuell nutzt er getStopBoard direkt).
startDbVendoQueue();

// Background-Job startet sich selbst — alle 50s refresht er die Top-10 Stops
// damit User-Taps auf populäre Stationen Cache-Hits werden.
startStopBoardPreCache();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  stopStopBoardPreCache();
  stopDbVendoQueue();
  stopAlertExpiry();
  stopRetention();
  // Gezählte Esri-Kacheln nicht verlieren (sonst fehlen bis zu 10 s im Kontingent).
  await flushEsriUsage().catch(() => {});
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`binch-server listening on http://${config.HOST}:${config.PORT}`);
  /**
   * Abgelaufene Alarme stilllegen — beim Start und danach alle sechs Stunden.
   *
   * Ohne diesen Aufruf lief die Funktion NIE: Sie war geschrieben, aber
   * nirgends verdrahtet. Ein Alarm auf eine Reise, die längst stattgefunden
   * hat, bliebe dann für immer aktiv — er würde bei jeder Suche auf dieser
   * Strecke mitgeprüft und könnte melden, dass eine Fahrt billiger geworden
   * ist, die es nicht mehr gibt.
   *
   * Nach dem Zuhören, nicht davor: Der Start soll nicht auf eine
   * Datenbank-Abfrage warten, die niemand eilig braucht.
   */
  void deactivateExpiredAlerts();
  startAlertExpiry();
  // Alte Suchdaten, abgelaufene Tokens und Sitzungen abräumen (services/retention.ts).
  startRetention();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
