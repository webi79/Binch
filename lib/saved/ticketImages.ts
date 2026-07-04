/**
 * Ticket-Bilder als Dateien statt Base64-im-Store.
 *
 * Hintergrund: `Ticket.pageImage`/`codeImage` kamen als data-URLs (~0,2–2 MB
 * pro Ticket) direkt in den persistierten Zustand-Store. zustand/persist
 * stringifiziert bei JEDEM set() den kompletten Partialize-State — mit
 * Base64-Tickets sind das Multi-MB-JSON.stringify-Blöcke auf dem JS-Thread
 * pro Interaktion (Picker öffnen, Toggle, …). Dazu Androids AsyncStorage-
 * CursorWindow-Limit (~2 MB pro Eintrag): ab einer Handvoll Tickets kann die
 * Hydration beim Kaltstart komplett fehlschlagen.
 *
 * Lösung: Bilder liegen als PNG-Dateien im Document-Directory (wie pdfUri
 * es schon macht), der Store hält nur noch file://-URIs. `<Image>` rendert
 * file:// genauso wie data: — an den Render-Stellen ändert sich nichts.
 */
import * as FileSystem from "expo-file-system/legacy";
import type { Ticket } from "@/types/saved";
import { useSearchStore } from "@/stores/searchStore";

const DIR = `${FileSystem.documentDirectory ?? ""}ticket-images/`;

async function ensureDir(): Promise<void> {
  try {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  } catch {
    /* existiert schon */
  }
}

/** Schreibt eine data-URL als PNG-Datei und gibt die file://-URI zurück.
 *  Ist der Wert schon eine Datei-URI (oder leer), wird er durchgereicht. */
export async function persistImageToFile(
  baseName: string,
  image: string | undefined | null,
): Promise<string | undefined> {
  if (!image) return undefined;
  if (!image.startsWith("data:")) return image; // schon migriert / file://
  const comma = image.indexOf(",");
  if (comma < 0) return undefined;
  const base64 = image.slice(comma + 1);
  await ensureDir();
  const uri = `${DIR}${baseName}.png`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

/** Persistiert beide Ticket-Bilder. baseName sollte pro Ticket eindeutig sein.
 *
 *  Wirft NIE: schlägt das Schreiben fehl (Web-Build ohne documentDirectory,
 *  voller Speicher, …), bleibt die data-URL erhalten — der alte Zustand ist
 *  funktional, nur langsamer. Ticket-Hinzufügen darf daran nicht scheitern. */
export async function persistTicketImages(
  baseName: string,
  pageImage: string,
  codeImage?: string,
): Promise<{ pageImage: string; codeImage?: string }> {
  const [page, code] = await Promise.all([
    persistImageToFile(`${baseName}-page`, pageImage).catch(() => undefined),
    persistImageToFile(`${baseName}-code`, codeImage).catch(() => undefined),
  ]);
  return { pageImage: page ?? pageImage, codeImage: code ?? codeImage };
}

/** Best-effort-Cleanup beim Löschen eines Tickets: Bild-Dateien + Original-
 *  PDF entfernen, damit das Document-Directory nicht zumüllt. */
export function deleteTicketFiles(ticket: Ticket): void {
  for (const uri of [ticket.pageImage, ticket.codeImage, ticket.pdfUri]) {
    if (uri && uri.startsWith("file://")) {
      void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }
}

/**
 * Einmalige Migration: bestehende Tickets mit Base64-Bildern auf Dateien
 * umziehen. Läuft beim App-Start (nach der Store-Hydration); Tickets werden
 * SEQUENZIELL migriert, um keine Speicherspitze durch mehrere MB-Strings
 * gleichzeitig zu erzeugen. Idempotent — bereits migrierte Tickets (file://)
 * werden übersprungen.
 */
export async function migrateTicketImagesToFiles(): Promise<void> {
  const { tickets, patchTicket } = useSearchStore.getState();
  for (const t of tickets) {
    const needsPage = t.pageImage?.startsWith("data:");
    const needsCode = t.codeImage?.startsWith("data:") ?? false;
    if (!needsPage && !needsCode) continue;
    try {
      const migrated = await persistTicketImages(t.id, t.pageImage, t.codeImage);
      patchTicket(t.id, migrated);
    } catch {
      // Nächster Versuch beim nächsten App-Start — data-URL bleibt gültig.
    }
  }
}
