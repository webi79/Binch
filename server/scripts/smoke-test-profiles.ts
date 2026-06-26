/**
 * Smoke-Test: prüft ob rejseplanen + sncb HAFAS-Endpoints überhaupt antworten.
 *
 * Beide HAFAS-APIs sind community-reverse-engineered — bei API-Änderungen oder
 * Server-Downtime möchten wir das wissen BEVOR wir den Resolve loslassen.
 */
import { createClient } from "hafas-client";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
import { profile as sncbProfile } from "hafas-client/p/sncb/index.js";

async function test(name: string, profile: any, query: string) {
  const client = createClient(profile, "binch-smoke-test/0.1");
  try {
    const res = await client.locations(query, { results: 3 });
    console.log(`\n=== ${name}: query="${query}" ===`);
    console.log(`Got ${res.length} results`);
    for (const r of res.slice(0, 3)) {
      console.log(`  id=${r.id} name=${r.name}`);
    }
    return res.length > 0;
  } catch (e) {
    console.log(`\n=== ${name}: query="${query}" ===`);
    console.log(`FAILED: ${(e as Error).message}`);
    return false;
  }
}

async function main() {
  const dkOk = await test("rejseplanen (DK)", rejseplanenProfile, "København H");
  const beOk = await test("sncb (BE)", sncbProfile, "Brussel Centraal");
  console.log("\n=== SUMMARY ===");
  console.log(`DK rejseplanen: ${dkOk ? "OK" : "BROKEN"}`);
  console.log(`BE sncb:        ${beOk ? "OK" : "BROKEN"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Smoke test failed:", e);
  process.exit(1);
});
