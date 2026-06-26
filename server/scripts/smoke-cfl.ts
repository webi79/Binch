import { createClient } from "hafas-client";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";
async function main() {
  const c = createClient(cflProfile, "binch-smoke/0.1");
  try {
    const r = await c.locations("Luxembourg", { results: 3 });
    console.log(`CFL: ${r.length} results`);
    for (const x of r) console.log(`  id=${(x as any).id} name=${(x as any).name}`);
  } catch (e) { console.log("CFL FAILED:", (e as Error).message); }
  process.exit(0);
}
main();
