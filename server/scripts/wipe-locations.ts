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
  const result = await db.delete(locations);
  console.log(`[wipe-locations] removed ${result.rowCount ?? "?"} rows`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[wipe-locations] failed:", err);
  process.exit(1);
});
