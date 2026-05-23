/**
 * In-process HAFAS-Client für nicht-DE Profile (AT/PL/LU/DK).
 *
 * Warum nicht db-vendo-client wie für DE? db-vendo-client läuft als separater
 * Docker-Container und unterstützt NUR DB-Profile (dbnav, db). Für andere
 * Länder gibt's keine fertigen REST-Container — wir würden pro Profil eine
 * eigene hafas-rest-api-Wrapper-Instanz selber bauen müssen. Stattdessen:
 * hafas-client npm direkt im Server-Prozess, ein Client pro Profil, gecacht.
 *
 * API-Form der Antworten (Alternative/Trip) ist die GLEICHE wie bei dbrest
 * (gleicher underlying library), daher können wir den existierenden normalize()-
 * Pfad in stopInfoService wiederverwenden.
 */

import { createClient, type HafasClient, type Alternative, type Trip } from "hafas-client";
// hafas-client exportiert die Profile als `{profile}` aus jedem p/<name>/index.js.
import { profile as oebbProfile } from "hafas-client/p/oebb/index.js";
import { profile as pkpProfile } from "hafas-client/p/pkp/index.js";
import { profile as cflProfile } from "hafas-client/p/cfl/index.js";
import { profile as rejseplanenProfile } from "hafas-client/p/rejseplanen/index.js";
// Österreichische Verbund-Profile (pro Bundesland).
import { profile as vorProfile } from "hafas-client/p/vor/index.js";
import { profile as vvtProfile } from "hafas-client/p/vvt/index.js";
import { profile as svvProfile } from "hafas-client/p/svv/index.js";
import { profile as ooevvProfile } from "hafas-client/p/ooevv/index.js";
import { profile as stvProfile } from "hafas-client/p/stv/index.js";
import { profile as vkgProfile } from "hafas-client/p/vkg/index.js";
import { profile as vvvProfile } from "hafas-client/p/vvv/index.js";
// Schweiz-Regional-Profile (kein nationales SBB-HAFAS verfügbar — SBB hat
// 2022 auf GraphQL umgestellt). Wir nehmen was hafas-client uns gibt:
// BLS (Bern/Mittelland), ZVV (Zürich), TPG (Genf).
import { profile as blsProfile } from "hafas-client/p/bls/index.js";
import { profile as zvvProfile } from "hafas-client/p/zvv/index.js";
import { profile as tpgProfile } from "hafas-client/p/tpg/index.js";

import type { MultiHafasProfileKey } from "./countryProfile.js";

const USER_AGENT = "binch-mobile/0.1";

const PROFILES = {
  oebb: oebbProfile,
  pkp: pkpProfile,
  cfl: cflProfile,
  rejseplanen: rejseplanenProfile,
  vor: vorProfile,
  vvt: vvtProfile,
  svv: svvProfile,
  ooevv: ooevvProfile,
  stv: stvProfile,
  vkg: vkgProfile,
  vvv: vvvProfile,
  bls: blsProfile,
  zvv: zvvProfile,
  tpg: tpgProfile,
} as const;

// Eine Client-Instanz pro Profil, persistent über die Server-Lifetime. Die
// Profile selber sind reine Datenobjekte; der Client kapselt nur die fetch-
// Logik + Throttling. Wiederverwendung spart minimal Memory + bisschen Setup.
const clients = new Map<MultiHafasProfileKey, HafasClient>();

function getClient(profile: MultiHafasProfileKey): HafasClient {
  let c = clients.get(profile);
  if (!c) {
    c = createClient(PROFILES[profile], USER_AGENT);
    clients.set(profile, c);
  }
  return c;
}

/** Abfahrten an einem Stop. `stationId` ist die HAFAS-ID die das Profile
 *  versteht (z.B. ÖBB-Stationsnummer für oebb). Wenn der Aufrufer eine andere
 *  ID-Form hat, vorher per `resolveStation` auflösen. */
export async function fetchDepartures(
  profile: MultiHafasProfileKey,
  stationId: string,
  opts: { duration?: number; results?: number } = {},
): Promise<Alternative[]> {
  const client = getClient(profile);
  // Manche Profile (z.B. oebb) lehnen `stopovers`/`remarks` als
  // "opt.X is not supported"-Error ab — die akzeptierten Options unterscheiden
  // sich pro Profil. Wir geben nur die Minimal-Felder (duration, results) mit,
  // alles andere bleibt Default.
  try {
    const res = await client.departures(stationId, {
      duration: opts.duration ?? 120,
      results: opts.results ?? 20,
    });
    return [...res.departures];
  } catch (e) {
    console.error(`[multiHafas] departures(${profile}, ${stationId}) FAILED:`, e instanceof Error ? e.message : e);
    throw e;
  }
}

export async function fetchArrivals(
  profile: MultiHafasProfileKey,
  stationId: string,
  opts: { duration?: number; results?: number } = {},
): Promise<Alternative[]> {
  const client = getClient(profile);
  try {
    const res = await client.arrivals(stationId, {
      duration: opts.duration ?? 120,
      results: opts.results ?? 20,
    });
    return [...res.arrivals];
  } catch (e) {
    console.error(`[multiHafas] arrivals(${profile}, ${stationId}) FAILED:`, e instanceof Error ? e.message : e);
    throw e;
  }
}

/** Trip-Detail für einen bekannten Trip (z.B. von einer Departure). Liefert
 *  ALLE Stopovers + Linie + Produkt. Genau das was wir für die LegTimeline
 *  brauchen. */
export async function fetchTrip(
  profile: MultiHafasProfileKey,
  tripId: string,
): Promise<Trip | null> {
  const client = getClient(profile);
  if (!client.trip) return null;
  try {
    // stopovers ist hier essenziell (sonst kein LegTimeline). Falls ein Profil
    // das ablehnt, fängt der catch → return null → Caller zeigt Fallback.
    const res = await client.trip(tripId, { stopovers: true, polyline: false });
    return res.trip;
  } catch (e) {
    console.error(`[multiHafas] trip(${profile}, ${tripId.slice(0, 30)}…) FAILED:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** Findet eine Station per Name + Coordinate. Gleicher Use-Case wie
 *  `resolveHafasByCoord` für DB, nur eben pro Profile. Wird gebraucht wenn ein
 *  GTFS-Stop-Code keine direkte HAFAS-ID hat — wir matchen über
 *  Geo+Name (Toleranz ~100m). */
export async function resolveStationByCoord(
  profile: MultiHafasProfileKey,
  lat: number,
  lon: number,
  name: string,
): Promise<string | null> {
  const client = getClient(profile);
  try {
    if (!client.nearby) return null;
    const list = await client.nearby(
      { type: "location", latitude: lat, longitude: lon },
      { results: 5, distance: 300, stops: true, poi: false },
    );
    // Bevorzuge Treffer mit Namens-Match (case-insensitive substring), sonst
    // den nächstgelegenen Stop.
    const lcName = name.toLowerCase();
    const byName = list.find((s) => "name" in s && s.name?.toLowerCase().includes(lcName));
    const pick = byName ?? list[0];
    return pick && "id" in pick ? pick.id ?? null : null;
  } catch {
    return null;
  }
}
