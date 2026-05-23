/**
 * Background-Pre-Cache für die heißesten Stop-Boards.
 *
 * Läuft alle 50s und refresht die Top-N am häufigsten angefragten Stops (laut
 * `accessLog` in `stopInfoService`), bevor der HOT_TTL abläuft. Damit landet
 * jeder User-Tap auf einem populären Stop garantiert im Cache → keine
 * db-vendo-Calls aus dem User-Pfad für die Top-N.
 *
 * Budget-bewusst:
 *   - Limit ist max 10 Stops/Tick (10 Calls alle 50s = ~12 Calls/min)
 *   - Wenn aktueller Outbound-Druck >35/min ist → Tick wird übersprungen,
 *     damit User-Requests Vorrang haben (Pre-Cache ist „nice to have")
 *
 * Keine Top-Liste hardcoded — wir lernen aus echten Zugriffsdaten. In der
 * ersten Stunde nach Server-Start ist die Liste leer und Pre-Cache tut nichts.
 * Sobald Traffic da ist, kristallisiert sich die Hot-Set heraus.
 */
import {
  getStopBoard,
  getHottestKeys,
  currentOutboundBudgetUsed,
} from "./stopInfoService.js";

const TICK_INTERVAL_MS = 50_000;
const TOP_N = 10;
const SKIP_IF_BUDGET_OVER = 35; // out of 50/min — leave 15 for user traffic

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  if (currentOutboundBudgetUsed() > SKIP_IF_BUDGET_OVER) {
    // Outbound-Pfad eng — Pre-Cache cedes Priority.
    return;
  }
  const hot = getHottestKeys(TOP_N);
  // Sequentiell statt parallel — vermeidet Burst der unser eigenes Throttle
  // triggern würde. 10 Stops × 200ms Latenz = ~2s pro Tick, weit innerhalb 50s.
  for (const { hafasId, board } of hot) {
    try {
      // Pre-Cache läuft NUR für die DE-Hotset (hottest keys sind alle DE-IDs).
      // Profile-Argument explizit "db" um den Typ glatt zu machen.
      await getStopBoard(hafasId, board, "db", { internal: true });
    } catch {
      // Einzelner Stop-Fehler darf den Tick nicht stoppen.
    }
  }
}

export function startStopBoardPreCache(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
  // unref() damit der Job das Node-Process nicht am Shutdown hindert.
  timer.unref();
}

export function stopStopBoardPreCache(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
