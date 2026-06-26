/**
 * Findet und entfernt Location-Duplikate.
 *
 * Pattern: sta:* (aus StaDa-Import) + gtfs:* (aus GTFS-Import) zeigen auf
 * denselben physischen Stop. Beispiele:
 *   - sta:8003772 "Lübbecke (Westf)" + gtfs:de:201039 "Lübbecke, Bahnhof"
 *   - sta:8505855 "Ronco sopra Ascona Posta" + gtfs:ch:8505855 (gleiche UIC)
 *
 * Criteria für „Duplikat":
 *   - Selbes Land
 *   - Selber Type (TRAIN/BUS/ALL)
 *   - Coords innerhalb ~50m (< 0.0005° Δ pro Achse)
 *
 * Winner-Heuristik:
 *   1. Entry mit hafas_id gewinnt (canonical für Routing)
 *   2. Bei Gleichstand: sta:* gewinnt über gtfs:* (StaDa ist die robustere
 *      Quelle, hat geprüfte UIC-Stations + ist von uns auditiert)
 *   3. Bei Gleichstand: kürzeres Label gewinnt (typisch der prominentere Eintrag)
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/dedupe-locations.ts             # dry-run + stats
 *   tsx --env-file=.env scripts/dedupe-locations.ts --apply    # DELETE
 */
import { sql, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const apply = process.argv.includes("--apply");

interface DupePair {
  winner: string;
  winnerLabel: string;
  loser: string;
  loserLabel: string;
  type: string;
}

async function main() {
  // Pairs holen: alle sta:* + gtfs:* die same-country, same-type, coords <50m
  // auseinander. Cross-Join nur auf sta-vs-gtfs (nicht sta-sta oder gtfs-gtfs)
  // damit wir nicht versehentlich zwei legit-getrennte Stops fusen.
  const pairs = await db.execute(sql`
    SELECT
      a.code AS sta_code,
      a.label AS sta_label,
      a.hafas_id AS sta_hafas,
      b.code AS gtfs_code,
      b.label AS gtfs_label,
      b.hafas_id AS gtfs_hafas,
      a.type AS type
    FROM locations a
    JOIN locations b ON
      a.country = b.country
      AND a.type = b.type
      AND ABS(a.latitude::float - b.latitude::float) < 0.0005
      AND ABS(a.longitude::float - b.longitude::float) < 0.0005
    WHERE a.code LIKE 'sta:%' AND b.code LIKE 'gtfs:%'
  `);
  const rows = (pairs as any).rows as Array<{
    sta_code: string; sta_label: string; sta_hafas: string | null;
    gtfs_code: string; gtfs_label: string; gtfs_hafas: string | null;
    type: string;
  }>;
  console.log(`Gefunden: ${rows.length} sta+gtfs-Pairs`);

  // Winner-Entscheidung pro Pair.
  const decisions: DupePair[] = [];
  // gtfs-loser kann pro Pair-Reihenfolge MEHRMALS auftauchen (1 gtfs ↔ N sta
  // theoretisch). Wir wollen aber jeden Code nur EINMAL löschen.
  const losersToDelete = new Set<string>();

  for (const r of rows) {
    let winner: { code: string; label: string };
    let loser: { code: string; label: string };
    // 1. hafas_id-Heuristik
    if (r.sta_hafas && !r.gtfs_hafas) {
      winner = { code: r.sta_code, label: r.sta_label };
      loser = { code: r.gtfs_code, label: r.gtfs_label };
    } else if (!r.sta_hafas && r.gtfs_hafas) {
      winner = { code: r.gtfs_code, label: r.gtfs_label };
      loser = { code: r.sta_code, label: r.sta_label };
    } else {
      // 2. sta:* gewinnt
      winner = { code: r.sta_code, label: r.sta_label };
      loser = { code: r.gtfs_code, label: r.gtfs_label };
    }
    decisions.push({
      winner: winner.code, winnerLabel: winner.label,
      loser: loser.code, loserLabel: loser.label,
      type: r.type,
    });
    losersToDelete.add(loser.code);
  }

  // Stats
  const byType = new Map<string, number>();
  for (const d of decisions) byType.set(d.type, (byType.get(d.type) ?? 0) + 1);
  console.log(`\nDecisions per type:`);
  for (const [t, c] of byType) console.log(`  ${t}: ${c}`);
  console.log(`Unique losers (= geplante Deletes): ${losersToDelete.size}`);

  // Sample
  console.log(`\nBeispiele:`);
  for (const d of decisions.slice(0, 5)) {
    console.log(`  KEEP ${d.winner} "${d.winnerLabel}"`);
    console.log(`  DEL  ${d.loser}  "${d.loserLabel}"  [${d.type}]`);
  }

  if (!apply) {
    console.log(`\nDry-Run — kein DELETE. Mit --apply würden ${losersToDelete.size} Stops gelöscht.`);
    process.exit(0);
  }

  // Batch-Delete in Chunks (Postgres `IN`-Limit beachten — 1000 ist sicher)
  console.log(`\nLöschen ${losersToDelete.size} Stops…`);
  const codes = Array.from(losersToDelete);
  const CHUNK = 500;
  let deleted = 0;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const slice = codes.slice(i, i + CHUNK);
    const res = await db.delete(locations).where(inArray(locations.code, slice));
    deleted += (res as any).rowCount ?? slice.length;
    if ((i / CHUNK) % 4 === 0) {
      console.log(`  [${Math.min(i + CHUNK, codes.length)}/${codes.length}] deleted=${deleted}`);
    }
  }
  console.log(`\nDone: ${deleted} Stops gelöscht.`);
  process.exit(0);
}

main().catch((e) => { console.error("Dedupe failed:", e); process.exit(1); });
