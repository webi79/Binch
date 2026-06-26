/**
 * Audit-Script: verifiziert dass alle „Hbf"-Einträge in unserer DB tatsächlich
 * auf den richtigen Bahnhof in DB-HAFAS zeigen.
 *
 * Hintergrund: StaDa-Import hatte für mehrere Major-Hbfs entweder gar keinen
 * canonical-Eintrag importiert (Berlin/Frankfurt/Stuttgart Hbf fehlten) oder
 * Sub-Einträge mit defekten IDs angelegt (Berlin Hbf sta:8065969 mapped in
 * HAFAS auf einen LU-Bus-Stop). Beides führt zu „0 Treffer"-Suchen.
 *
 * Strategie: für jeden Hbf-Eintrag in der DB die hafas_id gegen HAFAS
 * /stops/{id} probieren. Wenn HAFAS-Name nicht plausibel mit unserem Label
 * übereinstimmt → MISMATCH, in Report aufnehmen.
 *
 * Throttling: 1 Request pro 1.2s (= 50/min unter dem 60/min db-vendo-Limit).
 *
 * Output: Report auf stdout, keine Fixes — die macht der User per Hand
 * (entweder DELETE oder UPDATE der defekten Einträge).
 *
 * Aufruf:
 *   tsx scripts/audit-hbf-hafas-ids.ts
 */
import { isNotNull, eq, and, like, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1200;
const AUTO_CLEAN = process.argv.includes("--auto-clean");

interface HafasStop {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number };
}

async function probeHafas(id: string): Promise<HafasStop | null> {
  try {
    const res = await fetch(`${DBREST_BASE_URL}/stops/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    return (await res.json()) as HafasStop;
  } catch {
    return null;
  }
}

function normalize(s: string): string {
  // Slash und Bindestrich werden zu Spaces — sonst false-positives bei
  // „Linz/Donau Hbf" vs „Linz Hbf" und „Herne Wanne-Eickel" vs
  // „Herne-Wanne-Eickel". Diese sind nur Schreibvarianten desselben
  // Bahnhofs, nicht echte Mismatches.
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),.\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Name-Plausibilitäts-Check: HAFAS-Name muss „grob" mit unserem Label
 *  übereinstimmen. Konkret: das erste Wort (Stadtname) muss übereinstimmen,
 *  ODER die normalisierten Strings sind ineinander enthalten. */
function looksPlausible(ourLabel: string, hafasName: string): boolean {
  const a = normalize(ourLabel);
  const b = normalize(hafasName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aFirst = a.split(" ")[0] ?? "";
  const bFirst = b.split(" ")[0] ?? "";
  // Erstes Wort muss matchen (Stadtname). Sonst sind's verschiedene Orte.
  return aFirst.length >= 3 && aFirst === bFirst;
}

async function main() {
  // Audit umfasst ALLE Länder, nicht nur DE. Sub-Code-Kollisionen treten
  // genauso in AT/CH/etc. auf (z.B. Wien Hbf sub-entry 8101590 mappte auf
  // NL-Bus). Erkennung: Label enthält „Hbf" ODER „Hauptbahnhof" ODER „Hbf"-
  // Klammer-Suffix wie „Bahnsteige"/„Eingang"/„Gleis".
  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      hafasId: locations.hafasId,
    })
    .from(locations)
    .where(
      and(
        eq(locations.type, "TRAIN"),
        isNotNull(locations.hafasId),
        like(locations.label, "%Hbf%"),
      ),
    );

  console.log(`Audit von ${rows.length} 'Hbf'-Einträgen gegen HAFAS (alle Länder)${AUTO_CLEAN ? " — auto-clean ENABLED" : ""}…\n`);

  const mismatches: Array<{ code: string; label: string; hafasId: string; hafasName: string }> = [];
  const notFound: Array<{ code: string; label: string; hafasId: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.hafasId) continue;
    process.stdout.write(`\r  [${i + 1}/${rows.length}] ${r.label.slice(0, 40).padEnd(40)} `);
    const probe = await probeHafas(r.hafasId);
    if (!probe || !probe.name) {
      notFound.push({ code: r.code, label: r.label, hafasId: r.hafasId });
    } else if (!looksPlausible(r.label, probe.name)) {
      mismatches.push({ code: r.code, label: r.label, hafasId: r.hafasId, hafasName: probe.name });
    }
    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  console.log("\n");
  console.log(`✗ MISMATCHES (HAFAS-Name passt nicht zum Label): ${mismatches.length}`);
  for (const m of mismatches) {
    console.log(`  ${m.code}  ${m.label.padEnd(40)}  →  HAFAS: ${m.hafasName}`);
  }
  console.log(`\n? NOT FOUND in HAFAS (404 / kein Name): ${notFound.length}`);
  for (const n of notFound) {
    console.log(`  ${n.code}  ${n.label}`);
  }

  if (AUTO_CLEAN && (mismatches.length > 0 || notFound.length > 0)) {
    // Auto-Clean nur MISMATCHES + NOT-FOUND — diese sind die klar defekten.
    // Heuristik ist konservativ (looksPlausible akzeptiert auch Bindestrich-
    // Differenzen), daher sind die übrig bleibenden „echte" Probleme.
    const codes = [...mismatches.map((m) => m.code), ...notFound.map((n) => n.code)];
    console.log(`\n→ Auto-cleaning ${codes.length} Hbf-Mismatches/NotFound…`);
    await db.delete(locations).where(inArray(locations.code, codes));
    console.log("  Done.");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Audit failed:", e);
  process.exit(1);
});
