/**
 * Import-Script: Bahn-Stationen mit UIC-Codes (= HAFAS-IDs) und Coords aus
 * dem trainline-eu/stations Open-Data-Dataset (https://github.com/trainline-eu/stations).
 *
 * Quelle: Public-Domain-CSV mit ~30k europäischen Bahn-Stationen, inkl. UIC-IDs,
 * Namen, Lat/Lng und Land. Wir filtern auf "is_suggestable=t" + gültige UIC + Coords.
 *
 * Ergebnis in `locations` (type=TRAIN, source="stada", hafas_id=<UIC>).
 * Vorteil: einmal importiert → Autocomplete UND Trip-Search-ID-Auflösung
 * passieren komplett ohne db-rest-Live-Calls.
 *
 * Datei wird unter /tmp/trainline-stations.csv erwartet. Download:
 *   curl -L -o /tmp/trainline-stations.csv \
 *     https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv
 *
 * Ausführung aus dem server/-Verzeichnis:
 *   npm run import:stada
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { locations } from "../src/db/schema.js";

const CSV_PATH = process.env.STADA_CSV_PATH ?? "/tmp/trainline-stations.csv";
const CHUNK = 200;

interface StadaRow {
  code: string;
  label: string;
  city: string;
  country: string | null;
  type: "TRAIN";
  latitude: string;
  longitude: string;
  hafasId: string;
  /** trainline-eu liefert nur „grobe" Bahnstationen, keine S-/U-Bahn-Stops →
   *  alles als REGIONAL kategorisieren (umfasst Fern, Regional, IC etc.).
   *  Im Frontend rendert das als train-Marker. */
  subtype: "REGIONAL";
  /** StaDa-Stationen sind ausschließlich Bahn — ein-Element-Array. Bei
   *  Multi-Mode-Hubs ergänzen GTFS-Imports die weiteren Kinds in der DB. */
  kinds: ["train"];
  source: "stada";
}

/** Minimal-Parser für trainline-eu CSV. Trennzeichen ist Semikolon, Werte können
 *  in Quotes stehen, manche Zeilen enthalten Quotes selbst (escaped via "). */
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split("\n");
  const headers = parseRow(lines[0]);
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = parseRow(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = fields[j] ?? "";
    }
    out.push(row);
  }
  return out;
}

function parseRow(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

/** Land-Code (DE, FR, ...) → vollständiger Name. Nur die häufigsten — alle anderen
 *  bleiben als Code stehen, das ist akzeptabel für den seltenen Fall. */
const COUNTRY_NAMES: Record<string, string> = {
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  PT: "Portugal",
  NL: "Netherlands",
  BE: "Belgium",
  LU: "Luxembourg",
  AT: "Austria",
  CH: "Switzerland",
  GB: "United Kingdom",
  IE: "Ireland",
  DK: "Denmark",
  SE: "Sweden",
  NO: "Norway",
  FI: "Finland",
  PL: "Poland",
  CZ: "Czech Republic",
  SK: "Slovakia",
  HU: "Hungary",
  SI: "Slovenia",
  HR: "Croatia",
  RO: "Romania",
  BG: "Bulgaria",
  GR: "Greece",
};

/** UIC-Länderpräfix der Bahn-Nummern (wie in audit-suspect-hafas-ids.ts). */
const UIC_PREFIX_BY_COUNTRY: Record<string, string> = {
  Germany: "80", Austria: "81", Luxembourg: "82", Italy: "83",
  Netherlands: "84", Switzerland: "85", Denmark: "86", France: "87",
  Belgium: "88", Poland: "51", "Czech Republic": "54", Hungary: "55",
  Slovakia: "56", Slovenia: "79", Croatia: "78", Greece: "73",
  Spain: "71", Portugal: "94", Sweden: "74", Norway: "76", Finland: "10",
  "United Kingdom": "70", Ireland: "60", Romania: "53", Bulgaria: "52",
};

/** Präfixe, deren Nummern mit HAFAS-Halten in LU/NL kollidieren (audit-suspect-hafas-ids.ts + Befund 30.09.2026). */
const RISK_PREFIXES = ["8013", "8014", "8023", "8027", "8070", "8071", "8072", "8079", "8082", "8089", "8098"];

/**
 * Beim Auffrischen keine neuen Unterposten — Bushalte, Bahnsteige, Ausgänge,
 * U-Bahn und Fähren neben dem Bahnhof. Jedes Muster aus dem Abgleich vom
 * 29.09.2026, der sie ungeprüft als Bahnhöfe einbrachte: „Nürnberg ZOB" stand
 * danach in der Ortssuche VOR „Nürnberg Hbf", „München Hbf Arnulfstraße"
 * galt als Münchens Hauptbahnhof.
 */
const REFRESH_SUB_ENTRY = [
  /\bZOB\b/i,
  /\bBusbahnhof\b/i,
  /\bBusb(f|hf)\b/i,
  /\bBussteig/i,
  /\(S-Bahn\)/i,
  /\bU-Bahn\b/i,
  /\(S\)\s*$/, // „Berlin Alexanderplatz (S)" — zweite Kennung desselben Bahnhofs
  /\bGleis\s*\d/i,
  /\b(Süd|Nord|Ost|West)ausgang\b/i,
  /\bFähr/i,
  /\bFlugplatz\b/i,
  /\bHbf\.?\s+\S*(stra(ss|ß)e|str\.|platz|allee)\b/i, // „Frankfurt (M) Hbf Stuttgarter Straße"
];

/**
 * Anbieter, die nur Busse fahren. Ist bei einer Station NUR so einer
 * freigeschaltet, ist sie eine Bushaltestelle — die 25 Halte der Hautes-Alpes
 * („Vars – Office de Tourisme") mit `smt` als einzigem Anbieter kamen sonst als
 * Bahnhöfe herein.
 */
const BUS_ONLY_CARRIERS = new Set(["smt", "flixbus", "busbud", "distribusion"]);

async function main() {
  console.log(`[stada] reading ${CSV_PATH}…`);
  const text = readFileSync(CSV_PATH, "utf-8");
  const rows = parseCSV(text);
  console.log(`[stada] parsed ${rows.length} raw rows`);

  // Für DE/AT/CH liefert trainline-eu eine eigene `db_id`/`obb_id`/`cff_id` —
  // das sind die echten HAFAS-Station-IDs der jeweiligen Bahn (genau die, die
  // db-rest u.a. brauchen). Die `uic` daneben ist nur die europäische
  // Train-Number-Kennung und KOLLIDIERT oft mit HAFAS-IDs anderer Stationen:
  // z.B. hat „Werl" uic=8010378, aber 8010378 ist gleichzeitig die db_id von
  // „Wilhelmshorst". Wenn wir einfach UIC als hafasId nutzen, fragen wir bei
  // db-rest die falsche Station ab → Suchergebnisse für Wilhelmshorst statt
  // Werl. Deshalb für diese Länder IMMER die Carrier-ID bevorzugen, UIC nur
  // als Fallback nutzen. Für andere Länder bleibt UIC die korrekte Quelle.
  const CARRIER_BY_COUNTRY: Record<string, { id: string; enabled: string }> = {
    DE: { id: "db_id", enabled: "db_is_enabled" },
    AT: { id: "obb_id", enabled: "obb_is_enabled" },
    CH: { id: "cff_id", enabled: "cff_is_enabled" },
  };

  const out: StadaRow[] = [];
  const seenCode = new Set<string>();
  /** Stationen, bei denen nur Bus-Anbieter freigeschaltet sind (siehe `BUS_ONLY_CARRIERS`). */
  const coachOnly = new Set<string>();
  let fromUic = 0;
  let fromCarrier = 0;
  // Substrings die auf eine "Sub-Bahnhof"-Variante hinweisen (Bahnsteig,
  // Eingang, Tief-Niveau, Autoreisezug-Anlage). Diese Einträge bringen
  // KEINEN Mehrwert für die User-Suche (der canonical Hbf reicht), tragen
  // aber das Risiko von Sub-Code-Kollisionen mit HAFAS-IDs anderer Länder
  // (z.B. „Matzleinsdorf Wien Hbf (Bahnsteige 1-2)" → ID 8101590 → mapped
  // auf NL-Bus-Stop in HAFAS). Daher: nicht importieren.
  const SUB_ENTRY_PATTERNS = [
    /\(Bahnsteige?\b/i,
    /\(Eingang\b/i,
    /\(Tief\)?/i,
    /\(tief\)/,
    /\(Gleis\b/i,
    /\(Autoreisezug/i,
    /\(Washingtonplatz\)/i,
    /\(Europaplatz\)/i,
    /\(Kaiserstraße\)/i,
    /\(Kirchenallee\)/i,
    /\(Nelson-Mandela/i,
    /\bGl\.?\s*\d+/i, // "Gl. 27" / "Gl 27" / "Gleis 5-10"
  ];

  for (const r of rows) {
    // Filter: nur suggestable-Stationen + Coords.
    if (r["is_suggestable"] !== "t") continue;
    const lat = parseFloat(r["latitude"] ?? "");
    const lng = parseFloat(r["longitude"] ?? "");
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = r["name"]?.trim();
    if (!name) continue;
    // Sub-Bahnhof-Einträge skippen.
    if (SUB_ENTRY_PATTERNS.some((re) => re.test(name))) continue;

    const countryCode = r["country"]?.trim() ?? "";
    const uic = r["uic"]?.trim();
    const carrier = CARRIER_BY_COUNTRY[countryCode];
    let carrierId: string | null = null;
    if (carrier) {
      const cId = r[carrier.id]?.trim();
      const cEnabled = r[carrier.enabled];
      if (cId && /^\d{7,8}$/.test(cId) && cEnabled === "t") carrierId = cId;
    }

    let rawHafas: string | null = null;
    if (carrierId) {
      rawHafas = carrierId;
      fromCarrier++;
    } else if (uic && /^\d{7,8}$/.test(uic)) {
      rawHafas = uic;
      fromUic++;
    }
    if (!rawHafas) continue;

    // HAFAS-IDs für Deutschland sind 7-stellig (z.B. 8011160 für Berlin Hbf).
    // 8-stellige Werte sind SNCF mit Prüfziffer am Ende → letzte streichen.
    const hafasId = rawHafas.length === 8 ? rawHafas.slice(0, 7) : rawHafas;
    const code = `sta:${hafasId}`;
    if (seenCode.has(code)) continue;
    seenCode.add(code);
    const carriers = Object.keys(r)
      .filter((k) => k.endsWith("_is_enabled") && r[k] === "t")
      .map((k) => k.slice(0, -"_is_enabled".length));
    if (carriers.length > 0 && carriers.every((c) => BUS_ONLY_CARRIERS.has(c))) coachOnly.add(code);

    out.push({
      code,
      label: name,
      city: name,
      country: COUNTRY_NAMES[countryCode] ?? (countryCode || null),
      type: "TRAIN",
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      hafasId,
      subtype: "REGIONAL",
      kinds: ["train"],
      source: "stada",
    });
  }

  console.log(
    `[stada] filtered to ${out.length} stations (${fromUic} via UIC, ${fromCarrier} via Carrier-ID)`,
  );

  /**
   * `STADA_MODE=refresh` — der monatliche Abgleich (scripts/refresh-stops.sh):
   * neue Bahnhöfe einfügen (ohne Stadt, die setzt `enrich-stops-city.ts`),
   * bei vorhandenen nur die Lage auffrischen. Label, Stadt und Bahn-ID bleiben
   * — sie sind teils korrigiert (fix-stop-cities.ts, HAFAS-Zuordnungen). Die
   * Prüfungen danach (fragen bei der Bahn nach, löschen Zeilen) laufen nicht.
   */
  const refresh = process.env.STADA_MODE === "refresh";
  /**
   * Beim Auffrischen dieselben Regeln wie im GTFS-Import (siehe dort):
   *
   * 1. Eine VORHANDENE Kennung nur, wenn Name und Lage (≤ 2 km) passen. Hat die
   *    Zeile keine Lage mehr, reicht der Name — `sta:`-Kennungen sind die
   *    Bahn-Nummern und wandern nicht.
   *
   * 2. Eine NEUE Kennung nur, wenn … (jede Bedingung aus einem echten Schaden,
   *    Abgleich vom 30.09.2026: 121 Zeilen, 118 davon Dubletten)
   *    - ihre Bahn-Kennung noch nirgends steht (sonst kämen Bahnhöfe zurück,
   *      die Aufräumen und Prüfungen gelöscht hatten);
   *    - es keinen Bahnhof passenden Namens im Umkreis von `DEDUP_RADIUS_M`
   *      gibt, egal unter welcher Kennung („Kufstein Bahnhof" 13 m neben
   *      „Kufstein", „Lille-Europe" neben dem OSM-Eintrag);
   *    - sie kein Unterposten ist: ZOB und Busbahnhof sind Bushalte, keine
   *      Bahnhöfe; „(S-Bahn)" ist ein Bahnsteig des Hauptbahnhofs daneben
   *      (vollständige Liste: `REFRESH_SUB_ENTRY`);
   *    - bei ihr nicht nur Bus-Anbieter freigeschaltet sind (`BUS_ONLY_CARRIERS`);
   *    - ihre Nummer zum Land passt (UIC-Präfix) — sonst ist sie keine Nummer,
   *      mit der DB etwas anfangen kann (ÖBB-intern „12…");
   *    - sie nicht in den Präfixen liegt, die mit HAFAS-Halten in LU/NL
   *      kollidieren (siehe audit-suspect-hafas-ids.ts). Die Prüfungen, die das
   *      beim vollen Import auflösen, fragen bei der Bahn nach und laufen hier
   *      bewusst nicht — also lieber auslassen.
   */
  let toWrite = out;
  if (refresh) {
    const { DEDUP_RADIUS_M, haversineMeters, sameStopName } = await import("./lib/locationDedup.js");
    const knownRows = await db
      .select({ code: locations.code, label: locations.label, lat: locations.latitude, lng: locations.longitude })
      .from(locations)
      .where(sql`${locations.code} LIKE 'sta:%'`);
    const known = new Map(knownRows.map((r) => [r.code, r]));
    const hafasRows = await db
      .select({ hafasId: locations.hafasId })
      .from(locations)
      .where(sql`${locations.hafasId} IS NOT NULL`);
    const knownHafas = new Set(hafasRows.map((r) => r.hafasId!));

    // Alle Bahnhöfe (mit Lage) der betroffenen Länder, in 0,01°-Zellen.
    const countries = [...new Set(out.map((r) => r.country).filter((c): c is string => !!c))];
    const stations = await db
      .select({ label: locations.label, lat: locations.latitude, lng: locations.longitude })
      .from(locations)
      .where(
        sql`${locations.type} = 'TRAIN' AND ${locations.latitude} IS NOT NULL AND ${locations.country} IN (${sql.join(
          countries.map((c) => sql`${c}`),
          sql`, `,
        )})`,
      );
    type Near = { label: string; lat: number; lng: number };
    const grid = new Map<string, Near[]>();
    const remember = (n: Near) => {
      const k = `${Math.floor(n.lat * 100)},${Math.floor(n.lng * 100)}`;
      const list = grid.get(k);
      if (list) list.push(n);
      else grid.set(k, [n]);
    };
    for (const st of stations) remember({ label: st.label, lat: Number(st.lat), lng: Number(st.lng) });
    // 500 m sind höchstens eine Zelle (≈ 1,1 km) — die 3×3-Nachbarschaft reicht.
    const hasNamesake = (label: string, lat: number, lng: number) => {
      const cy = Math.floor(lat * 100);
      const cx = Math.floor(lng * 100);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const n of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
            if (haversineMeters(lat, lng, n.lat, n.lng) > DEDUP_RADIUS_M) continue;
            if (sameStopName(n.label, label)) return true;
          }
        }
      }
      return false;
    };

    const skipped = { foreign: 0, known: 0, sub: 0, coach: 0, uic: 0, risk: 0, dup: 0 };
    toWrite = out.filter((r) => {
      const lat = Number(r.latitude);
      const lng = Number(r.longitude);
      const k = known.get(r.code);
      if (k) {
        const same =
          sameStopName(k.label, r.label) &&
          (k.lat == null ||
            k.lng == null ||
            haversineMeters(lat, lng, Number(k.lat), Number(k.lng)) <= 2_000);
        if (!same) skipped.foreign++;
        return same;
      }
      if (knownHafas.has(r.hafasId)) {
        skipped.known++;
        return false;
      }
      if (REFRESH_SUB_ENTRY.some((re) => re.test(r.label))) {
        skipped.sub++;
        return false;
      }
      if (coachOnly.has(r.code)) {
        skipped.coach++;
        return false;
      }
      const uic = r.country ? UIC_PREFIX_BY_COUNTRY[r.country] : undefined;
      if (!uic || !r.hafasId.startsWith(uic)) {
        skipped.uic++;
        return false;
      }
      if (RISK_PREFIXES.some((pre) => r.hafasId.startsWith(pre))) {
        skipped.risk++;
        return false;
      }
      if (hasNamesake(r.label, lat, lng)) {
        skipped.dup++;
        return false;
      }
      // Auch gegen die übrigen Neuen („Thayngen" und „Thayngen Bahnhof").
      remember({ label: r.label, lat, lng });
      return true;
    });
    console.log(
      `[stada] Auffrischen: ${skipped.foreign} Kennungen passen nicht mehr (unberührt), ` +
        `neu übersprungen: ${skipped.known} Nummer schon vergeben, ${skipped.sub} Unterposten, ` +
        `${skipped.coach} nur Busanbieter, ` +
        `${skipped.uic} Nummer passt nicht zum Land, ${skipped.risk} Risiko-Präfix, ` +
        `${skipped.dup} gibt es schon (Name + Lage)`,
    );
    if (process.env.STADA_DRY_RUN) {
      const fresh = toWrite.filter((r) => !known.has(r.code));
      for (const r of fresh) console.log(`[stada]   neu: ${r.code} ${r.label} (${r.country})`);
      console.log(`[stada] Trockenlauf: ${toWrite.length} würden geschrieben (${fresh.length} neu) — nichts geändert.`);
      process.exit(0);
    }
  }
  let inserted = 0;
  for (let i = 0; i < toWrite.length; i += CHUNK) {
    const batch = refresh
      ? toWrite.slice(i, i + CHUNK).map((r) => ({ ...r, city: null }))
      : toWrite.slice(i, i + CHUNK);
    const written = await db
      .insert(locations)
      .values(batch)
      .onConflictDoUpdate({
        target: locations.code,
        set: refresh
          ? {
              latitude: sql`excluded.latitude`,
              longitude: sql`excluded.longitude`,
            }
          : {
              label: sql`excluded.label`,
              city: sql`excluded.city`,
              country: sql`excluded.country`,
              type: sql`excluded.type`,
              latitude: sql`excluded.latitude`,
              longitude: sql`excluded.longitude`,
              hafasId: sql`excluded.hafas_id`,
              subtype: sql`excluded.subtype`,
              kinds: sql`excluded.kinds`,
              source: sql`excluded.source`,
            },
      })
      // `xmax = 0` heißt: die Zeile ist neu (eingefügt, nicht aktualisiert).
      .returning({ isNew: sql<boolean>`(xmax = 0)` });
    inserted += written.filter((r) => r.isNew).length;
    console.log(`[stada]   ${Math.min(i + CHUNK, toWrite.length)} / ${toWrite.length}`);
  }

  console.log(`[stada] done — ${inserted} neu, ${toWrite.length - inserted} aufgefrischt.`);
  if (refresh) process.exit(0);

  // Post-Import-Audit: StaDa importiert hauptsächlich DE/AT/CH-Bahnhöfe und
  // verwendet UIC bzw. carrier-spezifische IDs. Letztere können trotzdem auf
  // HAFAS-LU/NL-Bus-Stops mappen (Berlin Hbf 8065969 mapped auf Bertrange in
  // LU). Wir prüfen daher Hbfs (label-basiert, ~3 Min) UND alle Verdachts-
  // Präfixe (~13 Min) gegen HAFAS und löschen klare Kollisionen automatisch.
  console.log("[stada] running post-import audits…");
  const { spawnSync } = await import("node:child_process");
  const scriptDir = new URL("./", import.meta.url).pathname;
  const hbfAudit = spawnSync(
    "npx",
    ["tsx", `${scriptDir}audit-hbf-hafas-ids.ts`, "--auto-clean"],
    { stdio: "inherit" },
  );
  if (hbfAudit.status !== 0) {
    console.warn(`[stada] post-import hbf-audit failed (status=${hbfAudit.status})`);
  }
  const suspectAudit = spawnSync(
    "npx",
    ["tsx", `${scriptDir}audit-suspect-hafas-ids.ts`, "--auto-clean"],
    { stdio: "inherit" },
  );
  if (suspectAudit.status !== 0) {
    console.warn(`[stada] post-import suspect-audit failed (status=${suspectAudit.status})`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[stada] failed:", err);
  process.exit(1);
});
