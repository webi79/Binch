/**
 * Voll-Audit aller sta:-Einträge mit hafas_id gegen HAFAS.
 *
 * Strategie:
 *   - 1 Request/s Throttle (60/min, unter dem db-vendo-Limit von 60)
 *   - Bei Mismatch: hafas_id auf NULL (Entry bleibt, Label bleibt im
 *     Autocomplete, aber dbVendo versucht nicht mehr es zu routen)
 *   - Progress wird alle 100 Stops in /tmp/audit-progress.json gespeichert,
 *     sodass ein Abbruch beim nächsten Start wieder aufgesetzt werden kann
 *
 * Laufzeit: ~12-14h bei 42k Einträgen. Im Hintergrund laufen lassen.
 *
 * Aufruf:
 *   tsx scripts/audit-full-stada.ts > /tmp/full-audit.log 2>&1 &
 */
import { isNotNull, like, and, sql, inArray } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DBREST_BASE_URL = process.env.DBREST_BASE_URL ?? "http://localhost:3001";
const THROTTLE_MS = 1100; // 1.1s/req → ~55/min, sicher unter 60/min-Limit
const PROGRESS_FILE = "/tmp/audit-progress.json";
const CHECKPOINT_EVERY = 100;

/** Nur Länder die wir tatsächlich via dbVendo routen. Für non-HAFAS-Länder
 *  (UK/ES/IT/FR/SE/CZ/HU/PT/etc.) ist die hafas_id funktional irrelevant —
 *  Audit wäre Zeitverschwendung. CH absichtlich ausgenommen weil wir dort
 *  primär multiHafas (zvv/bls/tpg) nutzen, nicht dbVendo. */
const HAFAS_COUNTRIES = [
  "Germany", "Austria", "Luxembourg", "Denmark", "Poland", "Netherlands", "Belgium",
];

interface HafasStop { id?: string; name?: string }

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

// LU/NL-Bus-Pattern + POI-Patterns die wir definitiv als Mismatch werten.
const JUNK_PATTERNS = [
  "bertrange", "strassen", "zwolle", "nunspeet", "merovingiens",
  "vondelkade", "bloksteeg", "hortensiastraat", "anne beffort",
  "raalte", "fischamend", "gooise meren", "doetinchem", "súdwest-fryslân",
  "sudwest-fryslan", "oude ijsselstreek", "montferland", "mons",
  // POI-Suffix-Hints (HAFAS zeigt Kategorie in Klammern)
  "(hotel)", "(gastronomie)", "(öffentliche)", "(öffentl", "(kultur",
  "(sport)", "kindergarten", "gemeindeverwaltung", "grundschule",
  "volksschule", "krankenhaus",
];

function isJunkMismatch(hafasName: string): boolean {
  const n = normalize(hafasName);
  if (JUNK_PATTERNS.some((p) => n.includes(p))) return true;
  // "AA <city>"-Pattern für NL postal codes (z.B. "8014 AA Zwolle, ...")
  if (/^\d{4}\s+aa\s+/.test(n)) return true;
  return false;
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

interface Progress {
  lastIndex: number;
  totalChecked: number;
  totalMismatches: number;
  mismatchCodes: string[];
}

function loadProgress(): Progress {
  if (!existsSync(PROGRESS_FILE)) {
    return { lastIndex: -1, totalChecked: 0, totalMismatches: 0, mismatchCodes: [] };
  }
  return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
}

function saveProgress(p: Progress): void {
  writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

async function flushNullouts(codes: string[]): Promise<void> {
  if (codes.length === 0) return;
  await db
    .update(locations)
    .set({ hafasId: null })
    .where(inArray(locations.code, codes));
}

async function main() {
  const rows = await db
    .select({ code: locations.code, label: locations.label, hafasId: locations.hafasId })
    .from(locations)
    .where(and(
      like(locations.code, "sta:%"),
      isNotNull(locations.hafasId),
      inArray(locations.country, HAFAS_COUNTRIES),
    ))
    .orderBy(locations.code); // deterministische Reihenfolge für Resume

  const progress = loadProgress();
  const startFrom = progress.lastIndex + 1;
  console.log(`Voll-Audit: ${rows.length} Einträge, starte ab Index ${startFrom}`);
  console.log(`Bisher: ${progress.totalChecked} geprüft, ${progress.totalMismatches} Mismatches genullt`);

  let pendingNullouts: string[] = [];
  let checkedSinceStart = 0;
  const startTime = Date.now();

  for (let i = startFrom; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.hafasId) continue;
    const probe = await probeHafas(r.hafasId);
    checkedSinceStart++;

    if (probe?.name && (isJunkMismatch(probe.name) || !looksPlausible(r.label, probe.name))) {
      pendingNullouts.push(r.code);
      progress.mismatchCodes.push(r.code);
      progress.totalMismatches++;
      console.log(`  ✗ ${r.code}  ${r.label}  →  HAFAS: ${probe.name}`);
    }

    progress.totalChecked++;
    progress.lastIndex = i;

    if ((i - startFrom + 1) % CHECKPOINT_EVERY === 0) {
      await flushNullouts(pendingNullouts);
      pendingNullouts = [];
      saveProgress(progress);
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = checkedSinceStart / elapsed;
      const remaining = rows.length - i - 1;
      const eta = remaining / rate;
      console.log(
        `[${i + 1}/${rows.length}] ${rate.toFixed(2)}/s, ETA ${(eta / 3600).toFixed(1)}h, ${progress.totalMismatches} Mismatches`,
      );
    }

    if (i < rows.length - 1) await new Promise((rs) => setTimeout(rs, THROTTLE_MS));
  }

  // Final flush
  await flushNullouts(pendingNullouts);
  saveProgress(progress);

  console.log("\n=== DONE ===");
  console.log(`Total checked: ${progress.totalChecked}`);
  console.log(`Total mismatches NULLed: ${progress.totalMismatches}`);

  process.exit(0);
}

main().catch((e) => { console.error("Audit failed:", e); process.exit(1); });
