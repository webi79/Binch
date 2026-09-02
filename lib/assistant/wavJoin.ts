import * as FileSystem from "expo-file-system/legacy";

/**
 * Mehrere WAV-Stücke zu einer Datei zusammenfügen.
 *
 * Nötig, weil eine Sprachnachricht in MEHREREN Stücken entstehen kann: Die
 * Erkennung endet bei längerer Stille von selbst und wird neu gestartet, und
 * wer pausiert und fortsetzt, beginnt ohnehin ein neues Stück. Jedes davon ist
 * eine eigene Datei — ohne Zusammenfügen wäre im Chat nur das letzte zu hören.
 *
 * Alle Stücke kommen aus demselben Aufnehmer und haben deshalb dasselbe Format
 * (16 kHz, mono, 16 Bit). Zusammengefügt wird darum nur der reine Ton: Kopf des
 * ersten Stücks, dahinter alle Tondaten, und die beiden Längenangaben im Kopf
 * neu gesetzt.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = (() => {
  const table = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array((clean.length * 3) >> 2);
  let out = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX[clean.charCodeAt(i)];
    const b = B64_INDEX[clean.charCodeAt(i + 1)];
    const c = B64_INDEX[clean.charCodeAt(i + 2)];
    const d = B64_INDEX[clean.charCodeAt(i + 3)];
    bytes[out++] = (a << 2) | (b >> 4);
    if (i + 2 < clean.length) bytes[out++] = ((b & 15) << 4) | (c >> 2);
    if (i + 3 < clean.length) bytes[out++] = ((c & 3) << 6) | d;
  }
  return bytes.subarray(0, out);
}

function encodeBase64(bytes: Uint8Array): string {
  /**
   * Stückweise in ein Feld, nicht in eine wachsende Zeichenkette.
   *
   * Eine Aufnahme von einer Minute sind rund zwei Megabyte, als Base64 knapp
   * drei. Zeichen für Zeichen angehängt hängt der JS-Strang beim Senden
   * sichtbar.
   */
  const chunks: string[] = [];
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
    if (out.length >= 8192) {
      chunks.push(out);
      out = "";
    }
  }
  chunks.push(out);
  return chunks.join("");
}

/** Anfang und Länge des `data`-Blocks — nicht auf 44 Byte geraten. */
function findDataChunk(bytes: Uint8Array): { start: number; size: number } | null {
  // "RIFF" .... "WAVE" dann Blöcke: 4 Byte Kennung, 4 Byte Länge, Inhalt.
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    // Ohne Vorzeichen: Das oberste Byte würde sonst eine negative Länge ergeben
    // und die Suche rückwärts laufen lassen.
    const size =
      (bytes[pos + 4] |
        (bytes[pos + 5] << 8) |
        (bytes[pos + 6] << 16) |
        (bytes[pos + 7] << 24)) >>>
      0;
    if (id === "data") {
      const start = pos + 8;
      // Manche Schreiber tragen die Länge erst beim Schließen ein; steht dort
      // Unsinn, gilt der Rest der Datei.
      const usable = size > 0 && start + size <= bytes.length ? size : bytes.length - start;
      return { start, size: usable };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

/**
 * Fügt die Stücke zusammen und gibt die neue Datei zurück. Bei einem einzelnen
 * Stück wird nichts angefasst — der häufigste Fall kostet damit nichts.
 */
export async function joinWavFiles(uris: string[], outUri: string): Promise<string> {
  if (uris.length === 0) throw new Error("keine Aufnahme");
  /**
   * Ein einzelnes Stück wird KOPIERT, nicht durchgereicht.
   *
   * Das Modul schreibt in den Zwischenspeicher der App (`cacheDir`), und den
   * räumt Android auf, wann es will. Eine Sprachnachricht im Verlauf zeigte
   * dann auf eine Datei, die es nicht mehr gibt. Sie gehört in denselben
   * dauerhaften Bereich wie die Ticket-PDFs.
   */
  if (uris.length === 1) {
    await FileSystem.copyAsync({ from: uris[0], to: outUri });
    try {
      await FileSystem.deleteAsync(uris[0], { idempotent: true });
    } catch {
      // siehe unten
    }
    return outUri;
  }

  const parts: Uint8Array[] = [];
  let header: Uint8Array | null = null;
  let headerEnd = 0;

  for (const uri of uris) {
    /**
     * Ein defektes Stück darf die anderen nicht mitreißen.
     *
     * Das Lesen stand ungeschützt in der Schleife: Eine Datei, die nicht fertig
     * geschrieben oder vom Zwischenspeicher geräumt wurde, ließ die ganze
     * Zusammenfügung scheitern — und der Notnagel oben griff dann ausgerechnet
     * zum letzten, also zum kaputten Stück.
     */
    let bytes: Uint8Array;
    try {
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      bytes = decodeBase64(b64);
    } catch {
      continue;
    }
    const chunk = findDataChunk(bytes);
    if (!chunk) continue;
    if (header === null) {
      header = bytes.subarray(0, chunk.start);
      headerEnd = chunk.start;
    }
    parts.push(bytes.subarray(chunk.start, chunk.start + chunk.size));
  }
  if (header === null || parts.length === 0) throw new Error("keine Tondaten");

  const dataLength = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(headerEnd + dataLength);
  out.set(header, 0);
  let pos = headerEnd;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  // Die beiden Längen im Kopf: Gesamtgröße ab Byte 8, und die des Ton-Blocks.
  writeUint32(out, 4, out.length - 8);
  writeUint32(out, headerEnd - 4, dataLength);

  await FileSystem.writeAsStringAsync(outUri, encodeBase64(out), {
    encoding: FileSystem.EncodingType.Base64,
  });
  // Die Einzelstücke haben ihren Zweck erfüllt. Sie liegen im Zwischenspeicher
  // der App und blieben sonst als Waisen liegen — eine je Abschnitt, bei jeder
  // Sprachnachricht.
  for (const uri of uris) {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // Nicht der Rede wert: Es ist der Zwischenspeicher.
    }
  }
  return outUri;
}
