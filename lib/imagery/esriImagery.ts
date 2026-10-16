import { OfflineManager } from "@maplibre/maplibre-react-native";
import { create } from "zustand";
import { API_BASE_URL, fetchEsriImagery, type EsriImagery } from "@/lib/api/client";

/**
 * ESRI WORLD IMAGERY in den Lücken — die Freigabe vom Server.
 *
 * Die Kacheln kommen über unseren Server (`/api/tiles/esri/…`), nicht direkt
 * von Esri: Nur so bleibt der Schlüssel dort, und nur so wirken Tagesdeckel,
 * Sperren und Monatsdeckel — siehe server/src/routes/imagery.ts und
 * server/src/services/esriGuard.ts. Gezählt wird dort, exakt; die App muss
 * nichts melden.
 *
 * Die Freigabe enthält einen Schein für heute. Sie wird beim Wechsel in die
 * Satellitenansicht und danach alle 10 Minuten neu geholt — so endet Esri
 * auch auf dem Gerät bald, wenn der Tagesdeckel erreicht oder eine Sperre
 * gesetzt ist (abgelehnte Kacheln sind ohnehin leer, darunter scheint die
 * Rückfallebene).
 */

const CONFIG_TTL_MS = 10 * 60_000;
/** Nach einem Fehlschlag (offline, Kennung noch nicht geladen) früher erneut fragen. */
const RETRY_MS = 30_000;

export interface EsriLayerConfig {
  /** Kennzeichen des Tages-Scheins — die Karte baut die Quelle neu, wenn es wechselt. */
  ticket: string;
  tiles: string[];
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

interface EsriState {
  /** `null` = aus (kein Schlüssel, Deckel erreicht, gesperrt oder noch nicht geladen). */
  layer: EsriLayerConfig | null;
  fetchedAt: number;
  loading: boolean;
}

export const useEsriImagery = create<EsriState>(() => ({ layer: null, fetchedAt: 0, loading: false }));

function toLayer(c: EsriImagery): EsriLayerConfig | null {
  if (!c.enabled || !c.tilePath) return null;
  const ticket = /[?&]t=([^&]+)/.exec(c.tilePath)?.[1] ?? "x";
  return {
    ticket: ticket.slice(0, 8),
    tiles: [`${API_BASE_URL}${c.tilePath}`],
    minzoom: c.minzoom ?? 13,
    maxzoom: c.maxzoom ?? 19,
    attribution: c.attribution ?? "Powered by Esri",
  };
}

let purged = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** In RETRY_MS erneut fragen — ohne die 10 Minuten abzuwarten. */
function retrySoon(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void refreshEsriImagery(true);
  }, RETRY_MS);
}

/**
 * Freigabe holen — höchstens alle 10 Minuten.
 *
 * Nur eine ENDGÜLTIGE Antwort gilt 10 Minuten. Ist die App offline, oder ging
 * die Frage noch ohne Installations-Kennung hinaus (der Speicher war beim
 * Kaltstart langsam, siehe lib/api/clientId.ts), kommt die nächste Frage nach
 * 30 Sekunden — sonst bliebe Esri nach einem Tunnel zehn Minuten aus.
 */
export async function refreshEsriImagery(force = false): Promise<void> {
  const st = useEsriImagery.getState();
  if (st.loading) return;
  if (!force && st.fetchedAt > 0 && Date.now() - st.fetchedAt < CONFIG_TTL_MS) return;
  useEsriImagery.setState({ loading: true });
  try {
    const c = await fetchEsriImagery();
    if (c.reason === "terminated" && !purged) {
      // Esri-Vertrag beendet: Der Rahmenvertrag verlangt, zwischengespeicherte
      // Daten auf dem Gerät zu löschen. Einmal je App-Start genügt.
      purged = true;
      void OfflineManager.clearAmbientCache().catch(() => {});
    }
    const next = toLayer(c);
    // Gleiche Adresse → derselbe Gegenstand, sonst baute die Karte die Quelle neu.
    const prev = useEsriImagery.getState().layer;
    const layer = prev && next && prev.tiles[0] === next.tiles[0] ? prev : next;
    if (c.reason === "no-client") {
      useEsriImagery.setState({ loading: false });
      retrySoon();
      return;
    }
    useEsriImagery.setState({ layer, fetchedAt: Date.now(), loading: false });
  } catch {
    useEsriImagery.setState({ loading: false });
    retrySoon();
  }
}
