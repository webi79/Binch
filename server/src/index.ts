import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { searchRoutes } from "./routes/search.js";
import { locationsRoutes } from "./routes/locations.js";
import { redirectRoutes } from "./routes/redirect.js";
import { ticketsRoutes } from "./routes/tickets.js";
import { authRoutes } from "./routes/auth.js";
import { pool } from "./db/client.js";

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

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
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
