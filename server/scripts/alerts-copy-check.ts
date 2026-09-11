/**
 * Prüft die LÄNGEN der Meldungstexte — 30 Zeichen Titel, 40 Rumpf.
 *
 * Beides sind die Grenzen, ab denen Android abschneidet, und abgeschnitten wird
 * immer das Ende — also der Preis, wegen dem die Meldung überhaupt kommt. Ein
 * Text, der die Grenze reißt, ist deshalb kein Schönheitsfehler.
 *
 *   npx tsx --env-file=.env scripts/alerts-copy-check.ts
 *
 * Es wird nichts verschickt und nichts gelesen — nur die Textbausteine
 * gerechnet, mit den längsten Ortsnamen, die im Projekt vorkommen. Die
 * `.env` braucht es allein, weil der Import die Konfiguration mitzieht.
 */
import { buildAlertTexts } from "../src/services/priceAlerts.js";

const TITLE_MAX = 30;
const BODY_MAX = 40;

const CASES: { from: string; to: string; what: string }[] = [
  { from: "Wien Erdberg", to: "Frankfurt (am Hbf)", what: "der echte Fall des Nutzers" },
  { from: "Köln Hbf", to: "Bielefeld Hbf", what: "kurz" },
  { from: "Frankfurt (Main) Hbf", to: "Zürich HB", what: "Klammer-Zusatz" },
  { from: "Berlin Brandenburg (BER)", to: "Teneriffa Süd (TFS)", what: "Flughäfen mit Kürzel" },
  { from: "Werl, Markt", to: "Neuenkirchen bei Bramsche, Kirche", what: "Haltestellen mit Komma" },
  { from: "München Flughafen Terminal 2", to: "Berlin Hauptbahnhof (tief)", what: "Extremfall" },
];

const NAMES: (string | null)[] = [null, "Valentin", "Maximiliane"];
const LOCALES = ["de", "en", "fr", "es"] as const;
/**
 * Zwei Währungen, weil sie unterschiedlich lang schreiben: „€" ist ein Zeichen,
 * „JPY" sind drei — und Yen-Beträge haben zusätzlich mehr Stellen. Die längere
 * von beiden bestimmt, wie viel Platz den Ortsnamen bleibt.
 */
const MONEY: { price: number; currency: string }[] = [
  { price: 1234, currency: "EUR" },
  { price: 189000, currency: "JPY" },
];

let worstTitle = 0;
let worstBody = 0;
let fails = 0;

for (const c of CASES) {
  for (const locale of LOCALES) {
    for (const name of NAMES) {
      for (const dropped of [true, false]) {
        for (const m of MONEY) {
          const t = buildAlertTexts({
            locale,
            dropped,
            price: m.price,
            basePrice: Math.round(m.price / 0.89),
            currency: m.currency,
            originLabel: c.from,
            destLabel: c.to,
            firstName: name,
          });
          worstTitle = Math.max(worstTitle, t.title.length);
          worstBody = Math.max(worstBody, t.body.length);
          if (t.title.length > TITLE_MAX || t.body.length > BODY_MAX) {
            fails += 1;
            console.log(
              `ZU LANG [${locale}/${dropped ? "fällt" : "steigt"}/${name ?? "ohne Name"}/${m.currency}] ` +
                `Titel ${t.title.length}: „${t.title}" | Rumpf ${t.body.length}: „${t.body}"`,
            );
          }
        }
      }
    }
  }
}

// Ein paar Beispiele zum Ansehen, unabhängig vom Ergebnis.
for (const locale of ["de", "en"] as const) {
  console.log(`\nBeispiele (${locale}):`);
  for (const c of CASES) {
    const t = buildAlertTexts({
      locale,
      dropped: true,
      price: 31,
      basePrice: 35,
      currency: "EUR",
      originLabel: c.from,
      destLabel: c.to,
      firstName: "Valentin",
    });
    console.log(`  ${c.what}`);
    console.log(`    Titel (${String(t.title.length).padStart(2)}): ${t.title}`);
    console.log(`    Rumpf (${String(t.body.length).padStart(2)}): ${t.body}`);
  }
}

// Und der Gegenfall: gestiegener Preis, ohne Anmeldung — kein Name, kein 🎉.
const rise = buildAlertTexts({
  locale: "de",
  dropped: false,
  price: 78,
  basePrice: 61,
  currency: "EUR",
  originLabel: "Wien Erdberg",
  destLabel: "Frankfurt (am Hbf)",
  firstName: null,
});
console.log(`\nGestiegen, ohne Anmeldung:`);
console.log(`    Titel (${String(rise.title.length).padStart(2)}): ${rise.title}`);
console.log(`    Rumpf (${String(rise.body.length).padStart(2)}): ${rise.body}`);

console.log(
  `\nLängster Titel ${worstTitle}/${TITLE_MAX}, längster Rumpf ${worstBody}/${BODY_MAX} — ` +
    (fails === 0 ? "alle innerhalb der Grenzen." : `${fails} Überschreitungen.`),
);
process.exit(fails === 0 ? 0 : 1);
