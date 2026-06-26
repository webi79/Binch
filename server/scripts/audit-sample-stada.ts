/**
 * Sample-Audit: 200 zufällige sta:-Einträge gegen HAFAS prüfen.
 *
 * Use-Case: nach den gezielten Audits (Hbf, Suspect-Präfixe, UIC-Mismatch)
 * wollen wir grob wissen ob noch versteckte Sub-Code-Kollisionen in der DB
 * lauern. Sample-Größe 200 → mit 95% Konfidenz ±7% Fehler-Spannweite, gut
 * genug für eine "ist die DB sauber?"-Aussage.
 *
 * Ausgabe: Prozent-Mismatch + Liste der Mismatches. KEIN auto-clean — bei
 * <1% Mismatch ist alles ok, sonst manuell entscheiden oder vollen Audit
 * fahren.
 */
import { isNotNull, like, and, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const SAMPLE_SIZE = 200;
const THROTTLE_MS = 1200;

interface HafasStop { id?: string; name?: string }

// Wir merken uns für jeden mismatch auch den HAFAS-Namen damit wir sehen
// können was tatsächlich falsch ist (Cosmetic-Diff vs echte Fehl-Mappung).
interface MismatchRow { code: string; label: string | null; country: string | null; hafasName: string }

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
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),.\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LU_NL_FRAGMENTS = [
  "bertrange", "strassen", "zwolle", "nunspeet", "merovingiens", "vondelkade",
  "bloksteeg", "hortensiastraat", "anne beffort", "emile mayrisch", "molijnlaan",
  "raalte", "fischamend", "gooise meren",
];

function isLuNlMismatch(hafasName: string): boolean {
  const n = normalize(hafasName);
  return LU_NL_FRAGMENTS.some((f) => n.includes(f));
}

function looksPlausible(ourLabel: string, hafasName: string): boolean {
  const a = normalize(ourLabel);
  const b = normalize(hafasName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const aTokens = new Set(a.split(" ").filter((t) => t.length >= 4));
  const bTokens = b.split(" ").filter((t) => t.length >= 4);
  return bTokens.some((t) => aTokens.has(t));
}

async function main() {
  const rows = await db
    .select({ code: locations.code, label: locations.label, country: locations.country, hafasId: locations.hafasId })
    .from(locations)
    .where(and(like(locations.code, "sta:%"), isNotNull(locations.hafasId)))
    .orderBy(sql`RANDOM()`)
    .limit(SAMPLE_SIZE);

  console.log(`Sample-Audit: ${rows.length} zufällige sta:-Einträge…\n`);

  const luNl: MismatchRow[] = [];
  const other: MismatchRow[] = [];
  let ok = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.hafasId) continue;
    process.stdout.write(`\r  [${i + 1}/${rows.length}] ${(r.label ?? "").slice(0, 50).padEnd(50)} `);
    const probe = await probeHafas(r.hafasId);
    if (probe?.name) {
      const entry: MismatchRow = { code: r.code, label: r.label, country: r.country, hafasName: probe.name };
      if (isLuNlMismatch(probe.name)) luNl.push(entry);
      else if (!looksPlausible(r.label, probe.name)) other.push(entry);
      else ok++;
    }
    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  console.log("\n");
  console.log(`✓ OK: ${ok}/${rows.length} (${((ok / rows.length) * 100).toFixed(1)}%)`);
  console.log(`✗ LU/NL-Mismatch: ${luNl.length}/${rows.length} (${((luNl.length / rows.length) * 100).toFixed(1)}%)`);
  console.log(`? Other-Mismatch: ${other.length}/${rows.length} (${((other.length / rows.length) * 100).toFixed(1)}%)`);

  if (luNl.length > 0) {
    console.log("\n=== LU/NL-Mismatches ===");
    for (const r of luNl) console.log(`  ${r.code}  ${r.label}  →  HAFAS: ${r.hafasName}  (${r.country})`);
  }
  if (other.length > 0) {
    console.log("\n=== Other-Mismatches ===");
    for (const r of other) console.log(`  ${r.code}  ${(r.label ?? "").padEnd(40)}  →  HAFAS: ${r.hafasName}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("Audit failed:", e); process.exit(1); });
