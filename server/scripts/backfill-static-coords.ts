/**
 * Backfill: Koordinaten für FLIGHT- und CRUISE-Locations.
 *
 * Der Seed legt Airports/Häfen OHNE Koordinaten an (data/airports.ts führt
 * keine) — sämtliche Server-Pfade, die Koordinaten als Anker brauchen
 * (Stop-Board-Auflösung, Profil-Wahl, Trip-Slice-Matching), liefen für diese
 * 500+ Einträge ins Leere. Der Client kaschierte das nur mit seinen eigenen
 * statischen Pin-Listen — genau die zapfen wir hier als Quelle an
 * (AIRPORT_PINS aus OurAirports, CRUISE_PORT_PINS kuratiert).
 *
 * Idempotent; läuft als Teil von `npm run db:seed`.
 * Einzeln: `npx tsx --env-file=.env scripts/backfill-static-coords.ts`
 */
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { AIRPORT_PINS } from "../../lib/surroundings/airportCoords.js";
import { CRUISE_PORT_PINS } from "../../lib/surroundings/cruisePortCoords.js";

/** Kuratierte Nachzügler, die in keiner Pin-Liste stehen (Hafen-/Airport-
 *  Koordinaten auf Hafenbecken-Genauigkeit — für Karten-Marker ausreichend). */
const CURATED_COORDS: Record<string, { latitude: number; longitude: number }> = {
  KBP: { latitude: 50.345, longitude: 30.895 },
  PNH: { latitude: 11.547, longitude: 104.844 },
  REP: { latitude: 13.411, longitude: 103.813 },
  "PORT-FLM": { latitude: 60.863, longitude: 7.113 },
  "PORT-EDI": { latitude: 55.98, longitude: -3.17 },
  "PORT-SKG": { latitude: 40.632, longitude: 22.935 },
  "PORT-TLN": { latitude: 43.119, longitude: 5.93 },
  "PORT-MAH": { latitude: 39.888, longitude: 4.265 },
  "PORT-IBZ": { latitude: 38.911, longitude: 1.44 },
  "PORT-STA": { latitude: 58.974, longitude: 5.73 },
  "PORT-AKR": { latitude: 65.688, longitude: -18.093 },
  "PORT-DUB": { latitude: 53.349, longitude: -6.212 },
  "PORT-FPO": { latitude: 26.52, longitude: -78.775 },
  "PORT-COS": { latitude: 18.719, longitude: -87.709 },
  "PORT-VIC": { latitude: 48.415, longitude: -123.389 },
  "PORT-NWO": { latitude: 29.937, longitude: -90.063 },
  "PORT-MTL": { latitude: 45.5, longitude: -73.55 },
  "PORT-QBC": { latitude: 46.815, longitude: -71.202 },
  "PORT-FDF": { latitude: 14.601, longitude: -61.071 },
  "PORT-AUA": { latitude: 12.518, longitude: -70.036 },
  "PORT-RTB": { latitude: 16.313, longitude: -86.537 },
  "PORT-CTG": { latitude: 10.402, longitude: -75.512 },
  "PORT-VAP": { latitude: -33.036, longitude: -71.62 },
  "PORT-AUH": { latitude: 24.517, longitude: 54.375 },
  "PORT-DOH": { latitude: 25.293, longitude: 51.545 },
  "PORT-MCT": { latitude: 23.625, longitude: 58.567 },
  "PORT-BKK": { latitude: 13.083, longitude: 100.883 },
  "PORT-BLI": { latitude: -8.745, longitude: 115.212 },
  "PORT-MFM": { latitude: 22.157, longitude: 113.577 },
  "PORT-MBA": { latitude: -4.07, longitude: 39.65 },
  "PORT-PSI": { latitude: 31.262, longitude: 32.306 },
};

async function main() {
  const airports = await db
    .select({ code: locations.code })
    .from(locations)
    .where(and(eq(locations.type, "FLIGHT"), isNull(locations.latitude)));
  const pinByIata = new Map(AIRPORT_PINS.map((p) => [p.iata, p.coord]));
  let airportHits = 0;
  for (const a of airports) {
    const coord = pinByIata.get(a.code) ?? CURATED_COORDS[a.code];
    if (!coord) continue;
    await db
      .update(locations)
      .set({ latitude: coord.latitude.toFixed(6), longitude: coord.longitude.toFixed(6) })
      .where(eq(locations.code, a.code));
    airportHits++;
  }
  console.log(`[backfill-coords] airports: ${airportHits}/${airports.length} mit Koordinaten versorgt`);

  const ports = await db
    .select({ code: locations.code })
    .from(locations)
    .where(and(eq(locations.type, "CRUISE"), isNull(locations.latitude)));
  const pinByCode = new Map(CRUISE_PORT_PINS.map((p) => [p.code, p.coord]));
  let portHits = 0;
  for (const p of ports) {
    const coord = pinByCode.get(p.code) ?? CURATED_COORDS[p.code];
    if (!coord) continue;
    await db
      .update(locations)
      .set({ latitude: coord.latitude.toFixed(6), longitude: coord.longitude.toFixed(6) })
      .where(eq(locations.code, p.code));
    portHits++;
  }
  console.log(`[backfill-coords] cruise ports: ${portHits}/${ports.length} mit Koordinaten versorgt`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
