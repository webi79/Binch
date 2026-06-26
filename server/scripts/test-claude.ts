/**
 * Quick connection-test gegen Anthropic API. Sendet einen Mini-Prompt an
 * Haiku 4.5 und überprüft dass der Response anständig zurückkommt.
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/test-claude.ts
 */
import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("FAIL: ANTHROPIC_API_KEY not in env");
  process.exit(1);
}

const client = new Anthropic({ apiKey });

async function main() {
  console.log("Calling Claude Haiku 4.5…");
  const t0 = Date.now();
  try {
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      messages: [
        { role: "user", content: "Sag in EINEM Satz Hallo auf Deutsch und nenn mir die Uhrzeit auf einem fiktiven Train-Departure-Board." },
      ],
    });
    const elapsed = Date.now() - t0;
    console.log(`OK (${elapsed}ms)`);
    console.log("Model:", res.model);
    console.log("Stop reason:", res.stop_reason);
    console.log("Tokens:", `in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
    console.log("Response:");
    for (const block of res.content) {
      if (block.type === "text") console.log("  >", block.text);
    }
    process.exit(0);
  } catch (e: any) {
    console.error("FAIL:", e?.status, e?.error?.error?.message ?? e?.message);
    process.exit(1);
  }
}

main();
