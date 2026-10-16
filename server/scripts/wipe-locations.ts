/**
 * Löscht ALLE Einträge aus der `locations`-Tabelle. Wird vor einem
 * vollständigen Re-Import genutzt (`reimport:all`), damit veraltete
 * Subtype-Klassifizierungen aus früheren Import-Versionen weg sind.
 *
 * Achtung: zerstörerisch. Locations sind die einzige Tabelle die hier
 * gewipet wird — searches/results/sessions/etc. bleiben unberührt.
 */
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

async function main() {
  /**
   * NUR mit ausdrücklicher Bestätigung (`WIPE_LOCATIONS_CONFIRM=ja`).
   *
   * Stand Sept. 2026 baut `reimport:all` die Tabelle NICHT wieder auf, wie sie
   * ist: Die OSM-Haltestellen (`import-osm-stops.ts`, rund drei Viertel aller
   * Zeilen) fehlen in der Kette, ebenso die Handkorrekturen der HAFAS-IDs
   * (`resolve-null-hafas-ids*`) und das Nachtragen fehlender Bahnhöfe. Die
   * Kette läuft außerdem ohne Transaktion über ein Dutzend externer Downloads —
   * ein toter Link, und die Tabelle bleibt halb leer. Gespeicherte Orte der
   * Nutzer (`osm:`-/`gtfs:`-Kennungen) wären danach verwaist.
   */
  if (process.env.WIPE_LOCATIONS_CONFIRM !== "ja") {
    console.error(
      "[wipe-locations] abgebrochen: löscht ALLE Orte, und reimport:all baut sie nicht vollständig wieder auf " +
        "(OSM-Haltestellen, HAFAS-Korrekturen fehlen). Nur mit WIPE_LOCATIONS_CONFIRM=ja.",
    );
    process.exit(1);
  }
  const result = await db.delete(locations);
  console.log(`[wipe-locations] removed ${result.rowCount ?? "?"} rows`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[wipe-locations] failed:", err);
  process.exit(1);
});
