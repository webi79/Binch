import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Eine zufällige Kennung DIESER Installation — für die Rate-Limits am Server.
 *
 * Gezählt wurde dort bisher nur pro IP-Adresse. Handys im Mobilfunk teilen
 * sich aber oft eine (Carrier-NAT): Viele Nutzer landeten im selben Topf und
 * bremsten sich gegenseitig aus. Mit dieser Kennung zählt der Server pro
 * Installation und hält pro IP nur noch eine deutlich höhere Obergrenze.
 *
 * Kein Merkmal des Geräts, nichts Persönliches: reiner Zufall, beim ersten
 * Start erzeugt und gespeichert. Neu installiert = neue Kennung.
 */
const KEY = "binch.clientId.v1";

function makeId(): string {
  let id = "";
  for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

let loading: Promise<string> | null = null;
/** Sobald geladen: synchron da, ohne jede Wartezeit. */
let known: string | null = null;

export function clientId(): Promise<string> {
  if (!loading) {
    loading = (async () => {
      try {
        const stored = await AsyncStorage.getItem(KEY);
        if (stored && /^[0-9a-f]{32}$/.test(stored)) return stored;
        const fresh = makeId();
        await AsyncStorage.setItem(KEY, fresh);
        return fresh;
      } catch {
        // Speicher nicht lesbar — dann eine für diesen Lauf; der Server zählt
        // ohnehin auch pro IP.
        return makeId();
      }
    })().then((id) => (known = id));
  }
  return loading;
}

/**
 * Der Kopf mit der Kennung — aber nie auf Kosten der Anfrage.
 *
 * Hängt der Speicher beim ersten Start (AsyncStorage kann auf einem
 * beschäftigten Gerät Sekunden brauchen), liefe diese Wartezeit VOR dem
 * Zeitlimit der Anfrage und zählte in keines hinein. Nach höchstens einer
 * Sekunde geht die Anfrage deshalb ohne Kennung raus; der Server zählt sie dann
 * pro IP wie früher.
 */
export async function clientIdHeader(maxWaitMs = 1000): Promise<Record<string, string>> {
  if (known) return { "X-Client-Id": known };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const id = await Promise.race([
    clientId(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), maxWaitMs);
    }),
  ]);
  clearTimeout(timer);
  return id ? { "X-Client-Id": id } : {};
}

// Gleich beim Laden anstoßen, damit die erste Anfrage nicht warten muss.
void clientId();
