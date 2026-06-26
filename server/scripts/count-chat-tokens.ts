/**
 * Misst die echte Token-Zahl des Chat-System-Prompts + Tools via Anthropic
 * countTokens-API. Wir brauchen >= 4096 Tokens damit Prompt-Caching auf
 * Haiku 4.5 wirkt (sonst silent no-op).
 *
 * Aufruf:
 *   tsx --env-file=.env scripts/count-chat-tokens.ts
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../src/config.js";

if (!config.ANTHROPIC_API_KEY) {
  console.error("FAIL: ANTHROPIC_API_KEY not set");
  process.exit(1);
}

// Re-implementiere die Inputs hier (statt aus chatAgent.ts zu importieren —
// das würde countTokens als Side-Effect auslösen). Quelle für SYSTEM_PROMPT
// + TOOLS muss synchron mit chatAgent.ts gehalten werden.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const src = readFileSync(resolve(__dirname, "../src/services/chatAgent.ts"), "utf8");
const sysMatch = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!sysMatch) {
  console.error("FAIL: SYSTEM_PROMPT not found in chatAgent.ts");
  process.exit(1);
}
const SYSTEM_PROMPT = sysMatch[1]
  // Template-Literal interpoliert \`**fett**\` etc. — die Escape-Sequenz wieder
  // entfernen damit der echte String gemessen wird.
  .replace(/\\`/g, "`");

// Tools werden ungefähr nachgebaut — bei Bedarf aus chatAgent.ts kopieren.
const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "get_today",
    description: "Returns today's date as ISO yyyy-MM-dd.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_location",
    description:
      "Search train stations, airports, bus stops and cruise ports by name. Returns up to 8 matches.",
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string" },
        mode: { type: "string", enum: ["FLIGHT", "TRAIN", "BUS", "CRUISE", "ALL"] },
      },
      required: ["q", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "search_journey",
    description:
      "Search concrete trips between two locations. Only call after find_location returned valid codes.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        originLabel: { type: "string" },
        destLabel: { type: "string" },
        mode: { type: "string", enum: ["FLIGHT", "TRAIN", "BUS", "CRUISE"] },
        departDate: { type: "string" },
        passengers: { type: "integer", minimum: 1, maximum: 9 },
      },
      required: ["origin", "destination", "originLabel", "destLabel", "mode", "departDate"],
      additionalProperties: false,
    },
  },
];

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const res = await client.messages.countTokens({
  model: "claude-haiku-4-5",
  system: SYSTEM_PROMPT,
  tools: TOOLS,
  messages: [{ role: "user", content: "warmup" }],
});

console.log("System + Tools + 'warmup'-User-Msg:");
console.log("  input_tokens:", res.input_tokens);
console.log();

const HAIKU_MIN = 4096;
if (res.input_tokens >= HAIKU_MIN) {
  console.log(`✅ ≥ ${HAIKU_MIN} → Prompt-Caching wirkt auf Haiku 4.5`);
} else {
  const diff = HAIKU_MIN - res.input_tokens;
  console.log(
    `⚠️  Nur ${res.input_tokens} < ${HAIKU_MIN} → Caching wird SILENT NO-OP auf Haiku 4.5`,
  );
  console.log(`   Fehlende ~${diff} Tokens. Verlängere den SYSTEM_PROMPT um ~${Math.ceil(diff * 3.5)} Zeichen.`);
}
