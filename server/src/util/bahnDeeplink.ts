/**
 * Baut einen bahn.de-Deeplink auf eine VORAUSGEFÜLLTE Verbindungssuche
 * (von/nach/Datum-Zeit). bahn.de erlaubt Dritten keinen Deeplink der einen
 * konkreten Zug mit Preis direkt bucht — nur die vorausgefüllte Suche, in der
 * der User dann bucht. Genau das braucht der "Tarif beim Anbieter"-CTA für
 * MOTIS-Ergebnisse (die price=0 sind, weil GTFS keine Preise hat).
 *
 * Format (Hash-Fragment, aus der bahn.de-Reiseauskunft reverse-engineered):
 *   #sts=true&so={Name}&zo={Name}&kl=2
 *    &soid=A=1@O={Name}@X={lon*1e6}@Y={lat*1e6}@U=81@B=1@
 *    &zoid=…&sot=ST&zot=ST&hd={Lokalzeit-ISO}&hza=D
 * Koordinaten (statt EVA) disambiguieren die Station zuverlässig.
 */

interface Endpoint {
  name: string;
  lat?: number;
  lng?: number;
}

/** `A=1@O=…@X=…@Y=…@U=81@B=1@` — X/Y sind Mikrograd (Grad × 1e6). */
function stationObject(e: Endpoint): string {
  const parts = [`A=1`, `O=${e.name}`];
  if (Number.isFinite(e.lat) && Number.isFinite(e.lng)) {
    parts.push(`X=${Math.round((e.lng as number) * 1e6)}`, `Y=${Math.round((e.lat as number) * 1e6)}`);
  }
  parts.push(`U=81`, `B=1`, ``);
  return parts.join("@");
}

/** UTC-ISO → lokale Wall-Clock in `tz` als "YYYY-MM-DDTHH:mm:ss" (bahn.de will
 *  Lokalzeit ohne Offset). 'sv-SE' liefert praktischerweise ISO-nahes Format. */
function toLocalIso(utcIso: string, tz?: string): string {
  try {
    const s = new Date(utcIso).toLocaleString("sv-SE", { timeZone: tz || "Europe/Berlin" });
    return s.replace(" ", "T");
  } catch {
    return utcIso.slice(0, 19);
  }
}

export function buildBahnDeeplink(params: {
  origin: Endpoint;
  destination: Endpoint;
  departTime: string; // UTC-ISO
  originTz?: string;
  secondClass?: boolean;
}): string {
  const { origin, destination, departTime, originTz, secondClass = true } = params;
  const hd = toLocalIso(departTime, originTz);
  const q = new URLSearchParams({
    sts: "true",
    so: origin.name,
    zo: destination.name,
    kl: secondClass ? "2" : "1",
    soid: stationObject(origin),
    zoid: stationObject(destination),
    sot: "ST",
    zot: "ST",
    hd,
    hza: "D",
  });
  return `https://www.bahn.de/buchung/fahrplan/suche#${q.toString()}`;
}
