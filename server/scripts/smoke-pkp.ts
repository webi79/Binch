import { createClient } from "hafas-client";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
async function main() {
  const c = createClient(pkpProfile, "binch-smoke/0.1");
  try {
    const r = await c.locations("Warszawa Centralna", { results: 3 });
    console.log(`PKP: ${r.length} results`);
    for (const x of r) console.log(`  id=${(x as any).id} name=${(x as any).name}`);
  } catch (e) { console.log("PKP FAILED:", (e as Error).message); }
  process.exit(0);
}
main();
