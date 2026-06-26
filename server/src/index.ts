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
import { stopsRoutes } from "./routes/stops.js";
import { tripsRoutes } from "./routes/trips.js";
import { flightBookingOptionsRoutes } from "./routes/flightBookingOptions.js";
import { chatRoutes } from "./routes/chat.js";
import { pool } from "./db/client.js";
import { startStopBoardPreCache, stopStopBoardPreCache } from "./services/stopBoardPreCache.js";
import { startDbVendoQueue, stopDbVendoQueue } from "./services/dbVendoQueue.js";

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
        : undefined,
  },
});

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 12 * 1024 * 1024 } });

app.get("/health", async () => ({ ok: true }));

await app.register(searchRoutes);
await app.register(locationsRoutes);
await app.register(redirectRoutes);
await app.register(ticketsRoutes);
await app.register(authRoutes);
await app.register(surroundingsRoutes);
await app.register(stopsRoutes);
await app.register(tripsRoutes);
await app.register(flightBookingOptionsRoutes);
await app.register(chatRoutes);

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
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`binch-server listening on http://${config.HOST}:${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
