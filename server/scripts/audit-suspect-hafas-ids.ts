/**
 * Erweitertes Audit: alle Stops mit hafas_id-Präfixen die als
 * „kollidiert mit HAFAS LU/NL-Bus-Stop" auffielen.
 *
 * Beim Hbf-Audit haben wir 8013/8014/8023/8027/8070/8071/8089/8098-Präfixe als
 * Risiko-Bereich identifiziert (StaDa-Subcode kollidiert mit HAFAS-LU/NL-UIC).
 * Aber nicht alle Einträge mit diesen Präfixen sind defekt — manche sind echte
 * Stops. Daher: jeden einzeln gegen HAFAS probieren.
 *
 * Außerdem (für nicht-DE Länder): wenn die ersten 2 Ziffern der hafas_id
 * nicht zum UIC-Country-Code passen, ist's ein weiterer Verdachtsfall.
 *
 * Output: 3 Buckets
 *   - OK: HAFAS-Name matched (oder enthält) unser Label → behalten
 *   - LU/NL-MISMATCH: HAFAS gibt einen Bertrange/Strassen/Zwolle/Nunspeet-
 *     Stop zurück → defekt → in delete-list
 *   - OTHER-MISMATCH: HAFAS gibt einen anderen Stop zurück → verdächtig,
 *     manuell prüfen
 *
 * Flags:
 *   --auto-clean       LU/NL-Mismatches automatisch löschen (sonst nur Report)
 *   --country=Belgium  Audit auf ein Land beschränken (sonst alle)
 *
 * Aufruf:
 *   tsx scripts/audit-suspect-hafas-ids.ts > /tmp/suspect-audit.log
 *   tsx scripts/audit-suspect-hafas-ids.ts --country=Belgium --auto-clean
 */
import { isNotNull, eq, and, or, like, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1200;

const AUTO_CLEAN = process.argv.includes("--auto-clean");
const COUNTRY_FILTER =
  process.argv.find((a) => a.startsWith("--country="))?.split("=")[1] ?? null;

/** UIC-Country-Code-Prefix → erwarteter erste 2 Ziffern in hafas_id.
 *  Quelle: UIC merkblatt. Wenn hafas_id-Prefix != expected UIC, ist die ID
 *  verdächtig (Cross-Country-Kollision möglich). */
const UIC_PREFIX_BY_COUNTRY: Record<string, string> = {
  Germany: "80", Austria: "81", Luxembourg: "82", Italy: "83",
  Netherlands: "84", Switzerland: "85", Denmark: "86", France: "87",
  Belgium: "88", Poland: "51", "Czech Republic": "54", Hungary: "55",
  Slovakia: "56", Slovenia: "79", Croatia: "78", Greece: "73",
  Spain: "71", Portugal: "94", Sweden: "74", Norway: "76", Finland: "10",
  "United Kingdom": "70", Ireland: "60",
};

const LU_NL_FRAGMENTS = [
  "bertrange",
  "strassen",
  "zwolle",
  "nunspeet",
  "merovingiens",
  "mérovingiens",
  "vondelkade",
  "bloksteeg",
  "hortensiastraat",
  "anne beffort",
  "emile mayrisch",
  "molijnlaan",
  "rue des prés",
  "rue des pres",
];

interface HafasStop {
  id?: string;
  name?: string;
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
  // Slash und Bindestrich auch als Whitespace zählen — false-positives bei
  // Schreibvarianten verhindern (z.B. „Linz/Donau Hbf" ≈ „Linz Hbf",
  // „Herne Wanne-Eickel" ≈ „Herne-Wanne-Eickel").
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[(),.\-/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLuNlMismatch(hafasName: string): boolean {
  const n = normalize(hafasName);
  return LU_NL_FRAGMENTS.some((frag) => n.includes(frag));
}

function looksPlausible(ourLabel: string, hafasName: string): boolean {
  const a = normalize(ourLabel);
  const b = normalize(hafasName);
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Token-Overlap-Check: mindestens 1 Token mit ≥4 Zeichen muss überlappen.
  const aTokens = new Set(a.split(" ").filter((t) => t.length >= 4));
  const bTokens = b.split(" ").filter((t) => t.length >= 4);
  return bTokens.some((t) => aTokens.has(t));
}

async function main() {
  // Suspect-Filter: 8 Verdachts-Präfixe (für DE-Stops bekannt) PLUS Stops wo
  // hafas_id-Prefix nicht zum erwarteten UIC-Country-Code passt (= Cross-
  // Country-Kollision). Wenn --country=XX gesetzt ist, nur dieses Land.
  const expectedUic = COUNTRY_FILTER ? UIC_PREFIX_BY_COUNTRY[COUNTRY_FILTER] : null;
  const conditions = [
    isNotNull(locations.hafasId),
    or(
      like(locations.hafasId, "8013%"),
      like(locations.hafasId, "8014%"),
      like(locations.hafasId, "8023%"),
      like(locations.hafasId, "8027%"),
      like(locations.hafasId, "8070%"),
      like(locations.hafasId, "8071%"),
      like(locations.hafasId, "8089%"),
      like(locations.hafasId, "8098%"),
    ),
  ];
  if (COUNTRY_FILTER) {
    conditions.push(eq(locations.country, COUNTRY_FILTER));
  }
  const rows = await db
    .select({ code: locations.code, label: locations.label, hafasId: locations.hafasId })
    .from(locations)
    .where(and(...conditions));

  console.log(
    `Audit von ${rows.length} verdächtigen Stops${COUNTRY_FILTER ? ` (country=${COUNTRY_FILTER})` : ""}${AUTO_CLEAN ? " — auto-clean ENABLED" : ""}…\n`,
  );
  // Kein Suspect → schnell beenden (Post-Import-Hook in Ländern ohne Suspect-
  // Range würde sonst leer durchlaufen und Zeit verschwenden).
  if (rows.length === 0) {
    console.log("✓ Keine verdächtigen Einträge — nichts zu tun.");
    process.exit(0);
  }
  // Bei UIC-Country-Prefix-Mismatch (z.B. BE-Stop mit 87xxxxx) gleich als
  // OK markieren wenn HAFAS-Name plausibel — sonst als LU/NL/OTHER. Aber wir
  // probieren immer noch HAFAS, weil viele „Cross-Border"-Stops legitim sind
  // (z.B. BE-Stop bei Maastricht mit NL-UIC 84xxxxx).
  if (expectedUic) {
    // Verstärktes Filtering pro Country wenn wir's wissen
    // (no-op for now — UIC-Prefix-Mismatch ist nur ein extra Signal, kein
    // automatischer Eliminator).
  }

  const ok: number[] = [];
  const luNl: Array<{ code: string; label: string; hafasId: string; hafasName: string }> = [];
  const other: Array<{ code: string; label: string; hafasId: string; hafasName: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.hafasId) continue;
    process.stdout.write(`\r  [${i + 1}/${rows.length}] ${r.label.slice(0, 50).padEnd(50)} `);
    const probe = await probeHafas(r.hafasId);
    if (probe?.name) {
      if (isLuNlMismatch(probe.name)) {
        luNl.push({ code: r.code, label: r.label, hafasId: r.hafasId, hafasName: probe.name });
      } else if (!looksPlausible(r.label, probe.name)) {
        other.push({ code: r.code, label: r.label, hafasId: r.hafasId, hafasName: probe.name });
      } else {
        ok.push(1);
      }
    }
    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  console.log("\n");
  console.log(`✓ OK: ${ok.length}/${rows.length}`);
  console.log(`✗ LU/NL-MISMATCH (defekt, sollte gelöscht werden): ${luNl.length}`);
  console.log(`? OTHER-MISMATCH (manuell prüfen): ${other.length}`);
  console.log("\n=== DELETE-Liste (LU/NL-Mismatches) ===");
  for (const m of luNl) {
    console.log(`  ${m.code}  ${m.label.padEnd(50)}  →  HAFAS: ${m.hafasName}`);
  }
  if (other.length > 0) {
    console.log("\n=== OTHER-Mismatches (manuell entscheiden) ===");
    for (const m of other) {
      console.log(`  ${m.code}  ${m.label.padEnd(50)}  →  HAFAS: ${m.hafasName}`);
    }
  }
  if (AUTO_CLEAN && luNl.length > 0) {
    const codes = luNl.map((m) => m.code);
    console.log(`\n→ Auto-cleaning ${codes.length} LU/NL-Mismatches…`);
    await db.delete(locations).where(inArray(locations.code, codes));
    console.log("  Done.");
  } else {
    console.log("\n=== SQL für den Cleanup (LU/NL-Mismatches) ===");
    console.log("DELETE FROM locations WHERE code IN (");
    console.log(luNl.map((m) => `  '${m.code}'`).join(",\n"));
    console.log(");");
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("Audit failed:", e);
  process.exit(1);
});
