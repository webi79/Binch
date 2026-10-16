/**
 * Reparatur nach dem ersten Haltestellen-Abgleich (29.09.2026, 23:47–23:55 UTC).
 *
 * WAS SCHIEFLIEF: gtfs.de vergibt die Kennungen seiner Haltestellen bei jeder
 * Veröffentlichung NEU. Der Abgleich hielt eine gleiche Kennung für denselben
 * Halt und schrieb Lage, Unterart und Verkehrsarten des NEUEN Inhabers dieser
 * Kennung in die alte Zeile — Label und Stadt blieben. So stand „Berlin,
 * Siriusstr." plötzlich in Sankt Augustin. Außerdem kamen Halte als „neu"
 * herein, die es unter alter Kennung längst gab (Dubletten).
 *
 *   1. Verschobene alte gtfs.de-Zeilen: Name der Zeile ≠ Name, den der Feed
 *      unter dieser Kennung führt. Der richtige Halt wird im Feed über den
 *      Namen gesucht (auch ohne vorangestellte Stadt), bei mehreren über die
 *      Nähe zur gespeicherten Stadt; von ihm kommen Lage, Unterart und
 *      Verkehrsarten. Ohne eindeutigen Treffer: Lage „unbekannt" (NULL) statt
 *      falsch.
 *   2. Neu eingefügte Dubletten (angelegt im Abgleich): liegt eine neue Zeile
 *      höchstens `DUP_RADIUS_M` neben einer alten gleicher Kategorie mit
 *      passendem Namen — oder trägt sie bei StaDa dieselbe Bahn-Kennung —,
 *      wird die NEUE gelöscht. Die alte bleibt: Auf sie zeigen gespeicherte
 *      Orte und Suchen.
 *
 * Probelauf:  GTFS_DE_DUMP=<dump.jsonl> npx tsx --env-file=.env scripts/repair-stop-refresh.ts
 *             (den Dump schreibt `GTFS_DUMP=… scripts/import-gtfs.ts` aus demselben Feed)
 * Anwenden:   … --apply   (Sicherung aller Änderungen nach REPAIR_OUT)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { and, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { cities, locations } from "../src/db/schema.js";
import { dedupCategory, haversineMeters, normalizeName } from "./lib/locationDedup.js";

const APPLY = process.argv.includes("--apply");
const DUMP = process.env.GTFS_DE_DUMP!;
const OUT = process.env.REPAIR_OUT ?? ".";
/** Beginn des Abgleichs (mit Luft) — was danach angelegt wurde, ist „neu". */
const CUTOFF = new Date("2026-09-29T23:00:00Z");
/** gtfs.de-Kennungen: rein numerisch (die VBB/MVG/VRS-Feeds tragen ein Kürzel). */
const DE_CODE = /^gtfs:de:\d+$/;
const CITY_MAX_M = 25_000;
const DUP_RADIUS_M = 150;

function fold(v: string): string {
  return v
    .replace(/\[[^\]]*\]/g, " ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Derselbe Halt dem Namen nach — auch mit vorangestellter Stadt. */
function sameName(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(` ${y}`) || y.endsWith(` ${x}`) || normalizeName(a) === normalizeName(b);
}

interface FeedStop {
  code: string;
  name: string;
  lat: number;
  lng: number;
  type: string;
  subtype: string | null;
  kinds: string[] | null;
}

async function main() {
  const t0 = Date.now();
  const feed: FeedStop[] = readFileSync(DUMP, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FeedStop);
  const byCode = new Map(feed.map((f) => [f.code, f]));
  const byName = new Map<string, FeedStop[]>();
  for (const f of feed) {
    const k = fold(f.name);
    const list = byName.get(k);
    if (list) list.push(f);
    else byName.set(k, [f]);
  }
  console.log(`[repair] ${feed.length} Halte im Feed`);

  // Orte je Name (Deutschland) — um bei gleichnamigen Halten die Stadt zu treffen.
  const placeRows = await db
    .select({ name: cities.name, lat: cities.latitude, lng: cities.longitude })
    .from(cities)
    .where(inArray(cities.country, ["Germany"]));
  const placesByName = new Map<string, Array<[number, number]>>();
  for (const p of placeRows) {
    const k = fold(p.name);
    const list = placesByName.get(k);
    const pt: [number, number] = [Number(p.lat), Number(p.lng)];
    if (list) list.push(pt);
    else placesByName.set(k, [pt]);
  }

  const rows = await db
    .select({
      code: locations.code,
      label: locations.label,
      city: locations.city,
      type: locations.type,
      subtype: locations.subtype,
      kinds: locations.kinds,
      hafasId: locations.hafasId,
      lat: locations.latitude,
      lng: locations.longitude,
      createdAt: locations.createdAt,
    })
    .from(locations)
    .where(and(isNotNull(locations.latitude), inArray(locations.type, ["TRAIN", "BUS"])));
  console.log(`[repair] ${rows.length} Halte in der Datenbank`);

  // --- 1. Verschobene alte gtfs.de-Zeilen ----------------------------------
  type Fix = {
    code: string;
    label: string;
    city: string | null;
    old: { lat: number; lng: number; subtype: string | null; kinds: string[] | null };
    now: { lat: number; lng: number; subtype: string | null; kinds: string[] | null } | null;
    via: string;
  };
  const fixes: Fix[] = [];
  let checked = 0;
  let sameStop = 0;
  for (const r of rows) {
    if (!DE_CODE.test(r.code) || r.createdAt >= CUTOFF) continue;
    const f = byCode.get(r.code);
    if (!f) continue; // Kennung nicht im Feed → der Abgleich hat die Zeile nicht angefasst
    checked++;
    if (sameName(r.label, f.name)) {
      sameStop++;
      continue;
    }
    // Den richtigen Halt über den Namen suchen.
    const label = fold(r.label);
    const city = r.city ? fold(r.city) : "";
    const keys = new Set([label]);
    if (city && label.startsWith(`${city} `)) keys.add(label.slice(city.length + 1));
    let cands = [...keys].flatMap((k) => byName.get(k) ?? []);
    // Längerer Vorsatz als die gespeicherte Stadt („Burg bei Magdeburg
    // Hohenwarthe, Siedlung" mit Stadt „Magdeburg"): führende Wörter weglassen.
    // Die Nähe zur Stadt (unten) sichert gegen gleichnamige Halte woanders ab.
    const words = label.split(" ");
    for (let n = 1; cands.length === 0 && n <= 4 && n < words.length; n++) {
      cands = byName.get(words.slice(n).join(" ")) ?? [];
    }
    const sameType = cands.filter((c) => c.type === r.type);
    if (sameType.length > 0) cands = sameType;
    let pick: FeedStop | null = null;
    let via = "kein Treffer";
    if (cands.length > 0) {
      const places = city ? (placesByName.get(city) ?? []) : [];
      if (places.length > 0) {
        let best = Infinity;
        for (const c of cands) {
          for (const [plat, plng] of places) {
            const d = haversineMeters(c.lat, c.lng, plat, plng);
            if (d < best) {
              best = d;
              pick = c;
            }
          }
        }
        if (best > CITY_MAX_M) {
          pick = null;
          via = "Treffer zu weit von der Stadt";
        } else via = cands.length === 1 ? "Name" : "Name + Stadt";
      } else {
        // Keine Stadt zum Abgleich: nur, wenn alle Treffer derselbe Ort sind.
        const spread = cands.every((c) => haversineMeters(c.lat, c.lng, cands[0]!.lat, cands[0]!.lng) < 500);
        if (spread) {
          pick = cands[0]!;
          via = "Name (eindeutig)";
        } else via = "mehrdeutig";
      }
    }
    fixes.push({
      code: r.code,
      label: r.label,
      city: r.city,
      old: { lat: Number(r.lat), lng: Number(r.lng), subtype: r.subtype, kinds: r.kinds },
      now: pick ? { lat: pick.lat, lng: pick.lng, subtype: pick.subtype, kinds: pick.kinds } : null,
      via,
    });
    // Für Schritt 2 mit der reparierten Lage weiterrechnen.
    if (pick) {
      r.lat = pick.lat.toFixed(6);
      r.lng = pick.lng.toFixed(6);
      r.subtype = pick.subtype;
    } else {
      r.lat = null;
      r.lng = null;
    }
  }
  console.log(
    `[repair] gtfs.de: ${checked} alte Zeilen im Feed, ${sameStop} derselbe Halt, ${fixes.length} verschoben — ` +
      `${fixes.filter((x) => x.now).length} zurückgeholt, ${fixes.filter((x) => !x.now).length} ohne eindeutigen Treffer`,
  );

  // --- 2. Neu eingefügte Dubletten -------------------------------------------
  const cell = (lat: number, lng: number) => `${Math.floor(lat * 100)},${Math.floor(lng * 100)}`;
  const grid = new Map<string, typeof rows>();
  const oldHafas = new Set<string>();
  for (const r of rows) {
    if (r.createdAt >= CUTOFF || r.lat == null || r.lng == null) continue;
    if (r.hafasId) oldHafas.add(r.hafasId);
    const k = cell(Number(r.lat), Number(r.lng));
    const list = grid.get(k);
    if (list) list.push(r);
    else grid.set(k, [r]);
  }
  const fresh = rows.filter((r) => r.createdAt >= CUTOFF);
  type Dup = { code: string; label: string; twin: string; twinLabel: string; dist: number | null };
  const dups: Dup[] = [];
  for (const n of fresh) {
    if (n.hafasId && n.code.startsWith("sta:") && oldHafas.has(n.hafasId)) {
      dups.push({ code: n.code, label: n.label, twin: `hafas ${n.hafasId}`, twinLabel: "", dist: null });
      continue;
    }
    const lat = Number(n.lat);
    const lng = Number(n.lng);
    const cy = Math.floor(lat * 100);
    const cx = Math.floor(lng * 100);
    const cat = dedupCategory(n.subtype, n.type);
    let twin: (typeof rows)[number] | null = null;
    let twinDist = Infinity;
    for (let dy = -1; dy <= 1 && !twin; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const o of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (dedupCategory(o.subtype, o.type) !== cat) continue;
          const d = haversineMeters(lat, lng, Number(o.lat), Number(o.lng));
          if (d <= DUP_RADIUS_M && d < twinDist && sameName(o.label, n.label)) {
            twin = o;
            twinDist = d;
          }
        }
      }
    }
    if (twin) dups.push({ code: n.code, label: n.label, twin: twin.code, twinLabel: twin.label, dist: Math.round(twinDist) });
  }
  console.log(`[repair] ${fresh.length} neu angelegte Halte, davon ${dups.length} Dubletten einer alten Zeile`);

  const pick = <T,>(arr: T[], n: number) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  const report = {
    fixes: fixes.length,
    restored: fixes.filter((x) => x.now).length,
    unresolved: fixes.filter((x) => !x.now).length,
    unresolvedBy: fixes.filter((x) => !x.now).reduce<Record<string, number>>((m, x) => ((m[x.via] = (m[x.via] ?? 0) + 1), m), {}),
    fresh: fresh.length,
    duplicates: dups.length,
    sampleFixes: pick(fixes, 40),
    sampleDups: pick(dups, 40),
  };
  writeFileSync(`${OUT}/repair-stop-refresh.report.json`, JSON.stringify(report, null, 1));
  console.log(`[repair] Bericht: ${OUT}/repair-stop-refresh.report.json (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  if (!APPLY) process.exit(0);

  // --- Anwenden -------------------------------------------------------------
  const stamp = Date.now();
  writeFileSync(`${OUT}/repair-stop-refresh.fixes-${stamp}.json`, JSON.stringify(fixes));
  const dupCodes = new Set(dups.map((d) => d.code));
  // In Blöcken: Postgres nimmt höchstens 65 535 Parameter pro Abfrage.
  const doomed: unknown[] = [];
  const allDup = [...dupCodes];
  for (let i = 0; i < allDup.length; i += 5000) {
    doomed.push(...(await db.select().from(locations).where(inArray(locations.code, allDup.slice(i, i + 5000)))));
  }
  writeFileSync(`${OUT}/repair-stop-refresh.deleted-${stamp}.json`, JSON.stringify(doomed));
  console.log(`[repair] Sicherung: ${OUT}/repair-stop-refresh.{fixes,deleted}-${stamp}.json`);

  const CHUNK = 1000;
  for (let i = 0; i < fixes.length; i += CHUNK) {
    const batch = fixes.slice(i, i + CHUNK);
    const codes = batch.map((b) => sql`${b.code}`);
    const latCase = batch.map((b) => sql`WHEN ${b.code} THEN ${b.now ? b.now.lat.toFixed(6) : null}::numeric`);
    const lngCase = batch.map((b) => sql`WHEN ${b.code} THEN ${b.now ? b.now.lng.toFixed(6) : null}::numeric`);
    const subCase = batch.map((b) => sql`WHEN ${b.code} THEN ${b.now ? b.now.subtype : b.old.subtype}`);
    // `kinds` ist ein Text-Array (text[]).
    const kindsCase = batch.map((b) => {
      const k = (b.now ? b.now.kinds : b.old.kinds) ?? null;
      return k ? sql`WHEN ${b.code} THEN ARRAY[${sql.join(k.map((x) => sql`${x}`), sql`, `)}]::text[]` : sql`WHEN ${b.code} THEN NULL::text[]`;
    });
    await db.execute(sql`
      UPDATE locations SET
        latitude = CASE code ${sql.join(latCase, sql` `)} END,
        longitude = CASE code ${sql.join(lngCase, sql` `)} END,
        subtype = CASE code ${sql.join(subCase, sql` `)} END,
        kinds = CASE code ${sql.join(kindsCase, sql` `)} END
      WHERE code IN (${sql.join(codes, sql`, `)})
    `);
  }
  const dupList = [...dupCodes];
  for (let i = 0; i < dupList.length; i += CHUNK) {
    await db.delete(locations).where(
      and(inArray(locations.code, dupList.slice(i, i + CHUNK)), gte(locations.createdAt, CUTOFF)),
    );
  }
  console.log(`[repair] angewendet: ${fixes.length} Zeilen zurückgesetzt, ${dupList.length} Dubletten gelöscht`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
