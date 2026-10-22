import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { locationReplacements } from "../db/schema.js";

/**
 * Entfernte Haltestellen → ihr Ersatz am selben Ort (Tabelle
 * `location_replacements`, angelegt von scripts/apply-stop-replacements.ts).
 *
 * Gespeicherte Stationen, der Suchverlauf und Tafel-Aufrufe tragen alte
 * Kennungen noch eine Weile mit sich; statt „gibt es nicht" landen sie beim
 * Ersatz. Ketten (alt → neuer → neuester) werden bis zum Ende verfolgt.
 *
 * @returns je gefundener alter Kennung die heutige; fehlende bleiben weg.
 */
export async function resolveReplacements(codes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let pending = [...new Set(codes)];
  /** alte Kennung → aktueller Stand der Kette */
  const head = new Map(pending.map((c) => [c, c]));
  for (let hop = 0; hop < 5 && pending.length > 0; hop++) {
    let rows: Array<{ oldCode: string; newCode: string }>;
    try {
      rows = await db
        .select({ oldCode: locationReplacements.oldCode, newCode: locationReplacements.newCode })
        .from(locationReplacements)
        .where(inArray(locationReplacements.oldCode, pending));
    } catch (err) {
      // Nur eine Umleitung — fehlt sie (Tabelle noch nicht angelegt), läuft
      // alles wie ohne sie weiter, statt Suche oder Tafel scheitern zu lassen.
      console.warn(`[replacements] Nachschlagen fehlgeschlagen: ${(err as Error).message}`);
      break;
    }
    if (rows.length === 0) break;
    const step = new Map(rows.map((r) => [r.oldCode, r.newCode]));
    const next: string[] = [];
    for (const [origin, current] of head) {
      const to = step.get(current);
      if (!to) continue;
      head.set(origin, to);
      out.set(origin, to);
      next.push(to);
    }
    pending = [...new Set(next)];
  }
  return out;
}

export async function resolveReplacement(code: string): Promise<string | null> {
  return (await resolveReplacements([code])).get(code) ?? null;
}
