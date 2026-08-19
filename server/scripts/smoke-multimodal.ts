/**
 * Rauchtest für den multimodalen Planer.
 *
 * Ruft `planMultimodal` DIREKT auf, ohne Anthropic dazwischen — dieser Test
 * prüft die Routen-Auswahl, nicht Bos Formulierung. Läuft bewusst seriell mit
 * Pause zwischen den Fällen: Jeder Fall löst echte Anbieter-Anfragen aus, und
 * db-vendo verträgt rund 60 pro Minute und IP.
 */
import { planMultimodal, resolvePlanEndpoint } from "../src/services/multimodalPlanner.js";

async function endpoint(q: string) {
  const ep = await resolvePlanEndpoint(q);
  if (!ep) throw new Error(`nicht auflösbar: ${q}`);
  return ep;
}

function hhmm(iso: string) {
  return new Date(iso).toISOString().slice(5, 16).replace("T", " ");
}

const date = process.argv[2] ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const cases: [string, string][] = [
  ["Werl", "Mallorca"],
  ["Dortmund", "Köln"],
  ["Werl", "Toledo"],
];

for (const [from, to] of cases) {
  console.log(`\n=== ${from} → ${to}  (${date}) ===`);
  const t0 = Date.now();
  try {
    const o = await endpoint(from);
    const d = await endpoint(to);
    console.log(`  aufgelöst: ${o.label} [${o.type}] → ${d.label} [${d.type}]`);
    const plan = await planMultimodal({
      origin: o,
      destination: d,
      departDate: date,
      passengers: 1,
      currency: "EUR",
    });
    if (plan.status !== "ok") {
      console.log(`  KEIN PLAN: ${plan.reason}`);
      plan.notes.forEach((n) => console.log(`    · ${n}`));
    } else {
      for (const l of plan.legs) {
        console.log(
          `  ${l.role.padEnd(6)} ${l.mode.padEnd(6)} ${hhmm(l.result.departTime)}→${hhmm(l.result.arriveTime)}  ` +
            `${(l.result.originLabel ?? l.result.origin).slice(0, 26).padEnd(26)} → ` +
            `${(l.result.destLabel ?? l.result.destination).slice(0, 26).padEnd(26)} ` +
            `${l.result.price > 0 ? l.result.price.toFixed(2) + " EUR" : "kein Preis"}`,
        );
      }
      const h = Math.floor(plan.totalDurationMinutes / 60);
      console.log(`  GESAMT ${h}h ${plan.totalDurationMinutes % 60}min · ` +
        `${plan.totalPrice != null ? plan.totalPrice.toFixed(2) + " EUR" : "Summe offen (" + plan.unpricedLegs.length + " Bein/e ohne Preis)"}`);
      plan.notes.forEach((n) => console.log(`    Hinweis: ${n}`));
    }
  } catch (e) {
    console.log(`  FEHLER: ${(e as Error).message}`);
  }
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await new Promise((r) => setTimeout(r, 3000));
}
process.exit(0);
