/**
 * AUFRÄUMEN — Suchdaten haben eine Frist.
 *
 * Bis Oktober 2026 löschte nichts `search_requests`, `search_results`,
 * `provider_responses`, `redirect_tokens` oder `sessions`. Eine Live-Suche
 * kostet rund 140 KB (Ergebnisse, Rohantwort, Tokens), und JEDER Cache-Treffer
 * legt für alle Treffer neue Tokens an — bei 1 000 Suchen am Tag wären das
 * etwa 50 GB im Jahr, fast alles Daten, die niemand mehr liest.
 *
 * Die Fristen, und warum gerade diese:
 *
 *   Weiterleitungs-Tokens   7 Tage nach Ablauf. Ein abgelaufenes Token leitet
 *                           ohnehin nicht mehr weiter (`consumeRedirectToken`).
 *
 *   Suchen (samt Ergebnissen,  30 Tage — aber NIE, solange noch ein gültiges
 *   Anbieter-Antworten)        Token an einem ihrer Ergebnisse hängt. Ein
 *                           Cache-Treffer stellt für ALTE Ergebnisse neue
 *                           Tokens aus (30 Tage gültig); die Löschung
 *                           kaskadiert auf die Tokens und nähme einem Nutzer
 *                           sonst einen Buchungslink, der noch gilt.
 *
 *   Rohantworten der        7 Tage. Sie werden nur geschrieben, nie gelesen —
 *   Anbieter                eine Woche reicht, um einen Anbieter-Fehler
 *                           nachzuvollziehen.
 *
 *   Sitzungen               7 Tage nach Ablauf (abgelaufen gelten sie schon
 *                           nicht mehr).
 *
 * Gelöscht wird in Häppchen: Eine einzige große Löschung hielte Sperren und
 * schriebe auf einen Schlag viel WAL — die Suche liefe in der Zeit zäh.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH = 500;
/** Obergrenze je Durchgang und Tabelle — der Rest folgt beim nächsten. */
const MAX_BATCHES = 200;

/** Löscht/ändert in Häppchen, bis nichts mehr übrig ist (oder `MAX_BATCHES`). */
async function inBatches(label: string, run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run();
    total += n;
    if (n < BATCH) break;
  }
  if (total > 0) console.log(`[retention] ${label}: ${total}`);
  return total;
}

function affected(res: unknown): number {
  return (res as { rowCount?: number | null }).rowCount ?? 0;
}

export async function runRetention(): Promise<void> {
  try {
    await inBatches("abgelaufene Tokens gelöscht", async () =>
      affected(
        await db.execute(sql`
          DELETE FROM redirect_tokens WHERE ctid IN (
            SELECT ctid FROM redirect_tokens
            WHERE expires_at < now() - interval '7 days'
            LIMIT ${BATCH}
          )`),
      ),
    );

    await inBatches("alte Suchen gelöscht", async () =>
      affected(
        await db.execute(sql`
          DELETE FROM search_requests WHERE id IN (
            SELECT r.id FROM search_requests r
            WHERE r.created_at < now() - interval '30 days'
              AND NOT EXISTS (
                SELECT 1 FROM search_results s
                JOIN redirect_tokens t ON t.result_id = s.id
                WHERE s.request_id = r.id AND t.expires_at > now()
              )
            LIMIT ${BATCH}
          )`),
      ),
    );

    await inBatches("Rohantworten geleert", async () =>
      affected(
        await db.execute(sql`
          UPDATE provider_responses SET raw_response = NULL WHERE id IN (
            SELECT id FROM provider_responses
            WHERE raw_response IS NOT NULL AND fetched_at < now() - interval '7 days'
            LIMIT ${BATCH}
          )`),
      ),
    );

    await inBatches("abgelaufene Sitzungen gelöscht", async () =>
      affected(
        await db.execute(sql`
          DELETE FROM sessions WHERE token IN (
            SELECT token FROM sessions WHERE expires_at < now() - interval '7 days' LIMIT ${BATCH}
          )`),
      ),
    );
  } catch (err) {
    // Nächster Durchgang in sechs Stunden — ein Fehler hier darf nichts anderes stören.
    console.warn("[retention] Aufräumen fehlgeschlagen:", err instanceof Error ? err.message : err);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startRetention(): void {
  if (timer) return;
  const tick = () => {
    if (running) return;
    running = true;
    void runRetention().finally(() => {
      running = false;
    });
  };
  // Nicht direkt beim Start (der soll schnell sein), sondern nach zehn Minuten.
  setTimeout(tick, 10 * 60 * 1000).unref?.();
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
}

export function stopRetention(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
