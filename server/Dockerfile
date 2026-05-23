# Production-Image für den Binch-Backend-Server.
# Multi-Stage Build: kleines Final-Image (nur prod-deps + compiled JS),
# während das Build-Stage Dev-Deps + TypeScript braucht.

# ─── Stage 1: prod-deps installieren ─────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ─── Stage 2: TypeScript bauen ───────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# ─── Stage 3: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Tools für den GTFS-Refresh-Sidecar: curl/unzip (Feed-Download/Extract),
# bash (refresh-all-feeds.sh nutzt bash-Syntax), postgresql-client (psql für
# VACUUM ANALYZE), tini (clean Signal-Handling im Container).
RUN apk add --no-cache curl unzip bash postgresql-client tini
# Prod-Deps only — Dev-Deps wie tsx, drizzle-kit, eslint kommen nicht mit
COPY --from=deps /app/node_modules ./node_modules
# tsx GLOBAL installieren (in /usr/local) damit das vorinstallierte
# node_modules unangetastet bleibt. Ohne -g würde npm install das lokale
# node_modules teils umbauen und fastify u.a. rauswerfen → Server crashed
# beim Start. tsx wird nur vom Refresh-Sidecar gebraucht, nicht vom Server.
RUN npm install -g tsx@4
COPY --from=build /app/dist ./dist
COPY drizzle.config.ts ./
COPY package.json ./
# Source + Scripts für tsx-Aufrufe vom Refresh-Job. src wird hier nochmal mit
# reingenommen weil tsx die TS-Files direkt liest (nicht aus dist).
COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# Default-CMD = Server. gtfs-refresh-Service in docker-compose überschreibt
# CMD mit der Loop.
CMD ["node", "dist/index.js"]
