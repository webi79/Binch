import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodePolyline, motisFetch } from "../services/motisClient.js";
import { ipLimiter } from "../util/rateLimit.js";
import { BoundedTtlCache } from "../util/boundedCache.js";

/**
 * Der FUSSWEG von hier zu einer Station — entlang der Straßen, nicht quer
 * durch die Häuser.
 *
 * Gebraucht von der Karte: Tippt man eine Haltestelle an, zeigt sie den Weg
 * vom eigenen Standort dorthin, und im Stadt-Blatt den Weg zur Startstation der
 * gewählten Verbindung — gepunktet, wie es Google Maps tut.
 *
 * Gerechnet von MOTIS (OSM-Fußwege, `directModes=WALK`): Das ist dieselbe
 * Quelle wie für die Zugsuche, offen und ohne das DB-Kontingent, das der Suche
 * gehört. Ein Abruf je Ziel, gemerkt für einen Tag.
 */

const querySchema = z.object({
  fromLat: z.coerce.number().min(-90).max(90),
  fromLng: z.coerce.number().min(-180).max(180),
  toLat: z.coerce.number().min(-90).max(90),
  toLng: z.coerce.number().min(-180).max(180),
});

const LIMITS = [{ limit: 30, windowMs: 60 * 1000 }];

/**
 * Weiter als das ist kein Fußweg mehr, den man jemandem aufmalt (rund eine
 * Stunde). Die Luftlinie wird vorab geprüft — so geht für ein fernes Ziel gar
 * keine Anfrage hinaus.
 */
const MAX_AIR_KM = 5;

export interface WalkRoute {
  /** [lng, lat] entlang der Wege — GeoJSON-Reihenfolge. */
  coords: [number, number][];
  durationMinutes: number;
  distanceMeters: number;
}

function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** `null` gemerkt heißt: dorthin gibt es keinen Fußweg — nicht erneut fragen. */
const walkCache = new BoundedTtlCache<WalkRoute | null>(3000, 24 * 60 * 60 * 1000);

async function fetchWalk(q: z.infer<typeof querySchema>): Promise<WalkRoute | null> {
  const url =
    `/v6/plan?fromPlace=${q.fromLat},${q.fromLng}&toPlace=${q.toLat},${q.toLng}` +
    `&directModes=WALK&maxDirectTime=${60 * 75}&numItineraries=1`;
  const res = (await motisFetch(url)) as {
    direct?: Array<{
      duration?: number;
      legs?: Array<{ mode?: string; distance?: number; legGeometry?: { points?: string; precision?: number } }>;
    }>;
  };
  const it = res.direct?.[0];
  if (!it?.legs?.length) return null;
  const coords: [number, number][] = [];
  let distance = 0;
  for (const leg of it.legs) {
    if (leg.legGeometry?.points) {
      coords.push(...decodePolyline(leg.legGeometry.points, leg.legGeometry.precision ?? 6));
    }
    distance += leg.distance ?? 0;
  }
  if (coords.length < 2) return null;
  return {
    coords,
    durationMinutes: Math.max(1, Math.round((it.duration ?? 0) / 60)),
    distanceMeters: Math.round(distance),
  };
}

export async function walkRoutes(app: FastifyInstance) {
  const preHandler = ipLimiter("walk", LIMITS);
  app.get("/api/walk", { preHandler }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "Bad request" });
    const q = parsed.data;
    if (haversineKm(q.fromLat, q.fromLng, q.toLat, q.toLng) > MAX_AIR_KM) return { route: null };
    // Auf ~10 m gerundet: ein paar Schritte weiter ist derselbe Weg.
    const key = [q.fromLat, q.fromLng, q.toLat, q.toLng].map((v) => v.toFixed(4)).join("|");
    const hit = walkCache.get(key);
    if (hit !== undefined) return { route: hit };
    try {
      const route = await fetchWalk(q);
      walkCache.set(key, route);
      return { route };
    } catch {
      // MOTIS gerade nicht erreichbar — nichts merken, beim nächsten Mal neu.
      return { route: null };
    }
  });
}
