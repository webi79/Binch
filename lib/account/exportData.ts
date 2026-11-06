/**
 * „Meine Daten herunterladen" — alles in EINER Datei.
 *
 * Der Server liefert, was er zu diesem Konto speichert (Profil, Chats, Bos
 * Gedächtnis, Geräte, Preisalarme; siehe server/src/routes/account.ts). Was
 * nur auf dem Gerät liegt — gespeicherte Reisen, Tickets, Stationen,
 * Suchverlauf, Einstellungen —, hängt diese Stelle als `device` an. Erst
 * beides zusammen ist die Auskunft, die der Nutzer erwartet.
 *
 * Bilder und Dokumente der Tickets bleiben draußen: Das sind Dateien auf dem
 * Gerät (oder große eingebettete Bilder), keine Angaben, und sie machten die
 * Datei unlesbar groß. Die Angaben zum Ticket selbst sind drin.
 *
 * Weitergegeben wird über das Teilen-Menü des Systems — der Nutzer wählt, wo
 * die Datei hin soll (Dateien, Drive, Mail). Die Kopie im Zwischenspeicher der
 * App wird danach gelöscht, sie enthält persönliche Daten.
 */
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { authExportData } from "@/lib/api/client";
import { useSearchStore } from "@/stores/searchStore";

export async function exportMyData(token: string, dialogTitle: string): Promise<void> {
  const server = await authExportData(token);
  const st = useSearchStore.getState();
  const file = {
    ...server,
    device: {
      settings: {
        locale: st.locale,
        currency: st.currency,
        theme: st.theme,
        accent: st.accent,
        hapticsEnabled: st.hapticsEnabled,
        notificationsEnabled: st.notificationsEnabled,
        priceAlertsEnabled: st.priceAlertsEnabled,
        savedToastPosition: st.savedToastPosition,
      },
      savedTrips: st.savedTrips,
      tickets: st.tickets.map(({ pageImage: _page, codeImage: _code, pdfUri: _pdf, ...rest }) => rest),
      savedStations: st.savedStations,
      recentSearches: st.recentSearches,
      recentSpots: st.recentSpots,
      priceAlerts: st.priceAlerts,
      lastKnownCoord: st.lastKnownCoord,
    },
  };

  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing unavailable");
  const day = new Date().toISOString().slice(0, 10);
  const uri = `${FileSystem.cacheDirectory}binch-daten-${day}.json`;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(file, null, 2));
  try {
    await Sharing.shareAsync(uri, { mimeType: "application/json", dialogTitle, UTI: "public.json" });
  } finally {
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}
