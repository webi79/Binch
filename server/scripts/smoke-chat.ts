/**
 * Schickt zwei Test-Turns gegen /api/chat/stream (lokaler dev-Server muss
 * laufen) und loggt die Events. Verifiziert dass:
 *   - SSE-Frame-Parsing funktioniert
 *   - 1. Turn = cache_creation > 0
 *   - 2. Turn = cache_read > 0  → Caching wirkt
 *
 * Aufruf:
 *   npm run dev   (in einem Terminal)
 *   tsx --env-file=.env scripts/smoke-chat.ts   (in einem zweiten)
 */
import { config } from "../src/config.js";

const PORT = Number(process.env.SMOKE_PORT ?? config.PORT);
const BASE = `http://localhost:${PORT}`;

interface UsageRec {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

async function runTurn(history: { role: "user" | "assistant"; content: string }[]): Promise<{
  text: string;
  usage: UsageRec | null;
}> {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      history,
      locale: "de",
      currency: "EUR",
      today: new Date().toISOString().slice(0, 10),
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  if (!res.body) throw new Error("No body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let usage: UsageRec | null = null;
  const moods: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let end: number;
    while ((end = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const dataLines = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart());
      if (dataLines.length === 0) continue;
      const ev = JSON.parse(dataLines.join("\n"));
      switch (ev.type) {
        case "mood":
          moods.push(ev.mood);
          break;
        case "text":
          text += ev.delta;
          process.stdout.write(ev.delta);
          break;
        case "tool_use":
          process.stdout.write(`\n  [tool: ${ev.name}]\n`);
          break;
        case "search_result":
          process.stdout.write(`\n  [result: ${ev.result?.originLabel ?? "?"} → ${ev.result?.destLabel ?? "?"}, ${ev.result?.price} ${ev.result?.currency}]\n`);
          break;
        case "usage":
          usage = ev;
          break;
        case "error":
          process.stdout.write(`\n  [ERROR: ${ev.message}]\n`);
          break;
        case "done":
          break;
      }
    }
  }

  console.log(`\n  moods: ${moods.join(" → ")}`);
  return { text, usage };
}

async function main() {
  console.log("=== Turn 1 (cache write) ===");
  const t0 = Date.now();
  const turn1 = await runTurn([{ role: "user", content: "Hallo Bo, wer bist du?" }]);
  console.log(`\n  duration: ${Date.now() - t0}ms`);
  console.log(`  usage: ${JSON.stringify(turn1.usage)}`);

  console.log("\n=== Turn 2 (cache read) ===");
  const t1 = Date.now();
  const turn2 = await runTurn([
    { role: "user", content: "Hallo Bo, wer bist du?" },
    { role: "assistant", content: turn1.text },
    { role: "user", content: "Was kannst du alles?" },
  ]);
  console.log(`\n  duration: ${Date.now() - t1}ms`);
  console.log(`  usage: ${JSON.stringify(turn2.usage)}`);

  console.log("\n=== Caching-Check ===");
  if (!turn1.usage || !turn2.usage) {
    console.log("  ❌ usage data missing");
    return;
  }
  if (turn1.usage.cacheWrite > 0) {
    console.log(`  ✅ Turn 1 wrote ${turn1.usage.cacheWrite} tokens to cache`);
  } else {
    console.log(`  ❌ Turn 1 wrote 0 tokens (System+Tools < 4096?)`);
  }
  if (turn2.usage.cacheRead > 0) {
    console.log(`  ✅ Turn 2 read ${turn2.usage.cacheRead} tokens from cache`);
  } else {
    console.log(`  ❌ Turn 2 read 0 cached tokens — Caching wirkt nicht`);
  }
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
